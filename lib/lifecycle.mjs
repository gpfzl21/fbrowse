import { mkdir, readFile, writeFile, rename, rm, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { projectKey } from './storage.mjs';

const service = 'project-file-browser';
const launcher = fileURLToPath(new URL('../bin/fbrowse.mjs', import.meta.url));
export const stateBase = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'fbrowse');
export const stateDirectory = root => join(stateBase(), projectKey(root));

async function readJSON(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// A directory lock serializes lifecycle changes. Its nested reaper lock ensures
// that only one contender may recover a lock whose owning process has exited.
export async function withProjectLock(root, operation) {
  const directory = stateDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'lifecycle.lock');
  const owner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + 75000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let reaping = false;
    let old;
    try {
      old = await stat(lock);
      await mkdir(join(lock, 'reaper'));
      reaping = true;
      const previous = await readJSON(join(lock, 'owner.json'));
      if ((previous && !processExists(previous.pid)) || (!previous && Date.now() - old.birthtimeMs > 120000)) {
        // The live owner may have released and another launcher acquired the
        // path while we read its old owner file. Never rename a replacement.
        const current = await stat(lock);
        if (current.ino !== old.ino || current.dev !== old.dev) continue;
        const abandoned = `${lock}.abandoned.${randomUUID()}`;
        await rename(lock, abandoned);
        reaping = false;
        await rm(abandoned, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error;
    } finally {
      if (reaping) {
        try {
          const current = await stat(lock);
          if (current.ino === old.ino && current.dev === old.dev) await rm(join(lock, 'reaper'), { recursive: true, force: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    if (Date.now() >= deadline) throw new Error('Another launcher is working on this project. Try again shortly.');
    await delay(50);
  }
  try {
    await atomicJSON(join(lock, 'owner.json'), owner);
    return await operation(directory);
  } finally {
    const current = await readJSON(join(lock, 'owner.json'));
    if (!current || current.token === owner.token) await rm(lock, { recursive: true, force: true });
  }
}

// Use node:http directly so proxy environment variables cannot redirect local
// identity checks or shutdown credentials. Never follow redirects.
function request(port, path, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {};
    if (token) headers['X-Fbrowse-Token'] = token;
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, agent: false, signal: AbortSignal.timeout(1500) }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) response.destroy(new Error('Server response exceeded the size limit.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Server returned HTTP ${response.statusCode}.`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Server returned invalid JSON.')); }
      });
    });
    req.setTimeout(1200, () => req.destroy(new Error('Server identity check timed out.')));
    req.on('error', reject);
    req.end(payload);
  });
}

export async function inspectState(root, directory = stateDirectory(root)) {
  const record = await readJSON(join(directory, 'server.json'));
  if (!record) return { status: 'missing' };
  if (record.root !== root || record.service !== service || record.backend !== 'node' ||
      !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
      typeof record.instance_id !== 'string' || !record.instance_id) {
    throw new Error('Invalid server state file. Cannot connect to or stop an unverified server.');
  }
  let info;
  try { info = await request(record.port, '/api/info'); }
  catch (error) {
    if (error.code === 'ECONNREFUSED') return { status: 'stale', record };
    throw new Error(`Could not verify the recorded server identity: ${error.message}`);
  }
  if (info.root !== root || info.service !== service || info.backend !== 'node' ||
      info.instance_id !== record.instance_id) {
    throw new Error('Server identity does not match. The recorded server and state file were preserved.');
  }
  return { status: 'running', record, info, url: `http://127.0.0.1:${record.port}/` };
}

async function waitForStart(root, directory, child, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await inspectState(root, directory);
    if (current.status === 'running') {
      await rm(join(directory, 'starting.json'), { force: true });
      return current;
    }
    const pending = await readJSON(join(directory, 'starting.json'));
    if ((child && (child.exitCode !== null || child.signalCode !== null)) || !pending || !processExists(pending.pid)) {
      await rm(join(directory, 'starting.json'), { force: true });
      throw new Error(`Server failed to start. Check the log: ${join(directory, 'server.log')}`);
    }
    await delay(100);
  }
  throw new Error(`Server is still starting. Check the log before retrying: ${join(directory, 'server.log')}`);
}

export async function startDaemon(root, directory, options = {}) {
  const current = await inspectState(root, directory);
  if (current.status === 'running') return current;
  const pending = await readJSON(join(directory, 'starting.json'));
  if (pending && processExists(pending.pid)) return waitForStart(root, directory);
  await rm(join(directory, 'server.json'), { force: true });
  await rm(join(directory, 'starting.json'), { force: true });
  const log = await open(join(directory, 'server.log'), 'a', 0o600);
  let child;
  try {
    const args = [launcher, '__serve', '--root', root, '--port', String(options.port || 0), '--state-file', join(directory, 'server.json')];
    if (options.pdfjs === false) args.push('--no-pdfjs');
    if (options.showHidden) args.push('--show-hidden');
    child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    await atomicJSON(join(directory, 'starting.json'), { root, pid: child.pid, started: Date.now() });
  } finally { await log.close(); }
  return waitForStart(root, directory, child);
}

export async function stopDaemon(root, directory) {
  const current = await inspectState(root, directory);
  if (current.status === 'missing' || current.status === 'stale') {
    const pending = await readJSON(join(directory, 'starting.json'));
    if (pending && processExists(pending.pid)) throw new Error('Server is still starting. Wait until it is ready before stopping it.');
    await rm(join(directory, 'server.json'), { force: true });
    await rm(join(directory, 'starting.json'), { force: true });
    return current;
  }
  if (typeof current.info.config_token !== 'string' || !current.info.config_token) {
    throw new Error('The verified server did not provide a shutdown authentication token.');
  }
  await request(current.record.port, '/api/shutdown', {
    method: 'POST', token: current.info.config_token, body: { instance_id: current.info.instance_id },
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const info = await request(current.record.port, '/api/info');
      if (info.instance_id !== current.info.instance_id || info.root !== root) {
        throw new Error('The port was reused before shutdown could be confirmed. The state file was preserved.');
      }
    } catch (error) {
      // A listener can reset a connection while closing. Require a subsequent
      // connection refusal before considering the authenticated shutdown done.
      if (error.code === 'ECONNREFUSED') {
        const record = await readJSON(join(directory, 'server.json'));
        if (record?.instance_id === current.record.instance_id) await rm(join(directory, 'server.json'), { force: true });
        return current;
      }
      if (error.code !== 'ECONNRESET') throw error;
    }
    await delay(75);
  }
  throw new Error('Authenticated shutdown did not complete. The state file was preserved.');
}

export async function readLog(directory, lines = 60) {
  const file = await open(join(directory, 'server.log'), 'r');
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
    await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.toString('utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } finally { await file.close(); }
}
