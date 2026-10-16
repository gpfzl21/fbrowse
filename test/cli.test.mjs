import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/fbrowse.mjs', import.meta.url));
const key = root => createHash('sha256').update(root).digest('hex').slice(0, 16);

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'fbrowse-cli-'));
  const env = { ...process.env, HOME: join(base, 'home'), XDG_CONFIG_HOME: join(base, 'config'),
    XDG_STATE_HOME: join(base, 'state'), XDG_CACHE_HOME: join(base, 'cache'), XDG_DATA_HOME: join(base, 'data'),
    PATH: join(base, 'no-external-programs'), ORCA_CLI_COMMAND: join(base, 'must-not-run'), FBROWSE_NO_OPEN: '0' };
  await mkdir(env.HOME);
  const projects = [];
  async function project(name) {
    const root = join(base, name);
    await mkdir(root);
    projects.push(root);
    return root;
  }
  const cwd = await project('empty project');
  async function run(args = [], options = {}) {
    try {
      const result = await execute(process.execPath, [launcher, ...args], { env, cwd, timeout: 22000, ...options });
      return { ...result, code: 0 };
    } catch (error) {
      if (!options.allowFailure) throw new Error(`CLI ${JSON.stringify(args)} failed: ${error.stderr || error.message}`, { cause: error });
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
  }
  const statePath = root => join(env.XDG_STATE_HOME || join(env.HOME, '.local/state'), 'fbrowse', key(root), 'server.json');
  const metadata = async root => JSON.parse(await readFile(statePath(root), 'utf8'));
  t.after(async () => {
    const results = await Promise.all(projects.map(root => run(['stop', root], { allowFailure: true })));
    const failed = results.filter(result => result.code !== 0);
    await rm(base, { recursive: true, force: true });
    assert.equal(failed.length, 0, failed.map(result => result.stderr).join('\n'));
  });
  return { base, env, cwd, project, run, statePath, metadata };
}

const info = async url => {
  const response = await fetch(`${url}api/info`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  return response.json();
};

test('help/version and validation work without external programs or browser features', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(['version'])).stdout.trim(), '0.2.1');
  assert.equal((await f.run(['--version'])).stdout.trim(), '0.2.1');
  assert.match((await f.run(['help'])).stdout, /브라우저 자동 열기는 비활성화/);
  assert.match((await f.run(['--help'])).stdout, /roots/);
  for (const args of [['--open'], ['list', 'extra'], ['roots', 'add'], ['url', '--port', '0'], ['version', 'extra']]) {
    assert.notEqual((await f.run(args, { allowFailure: true })).code, 0);
  }
  assert.deepEqual(await readdir(f.cwd), []);
});

test('default start is detached, concurrent starts reuse canonical identity, and logs are readable', async t => {
  const f = await fixture(t);
  const alias = join(f.base, 'symlink alias');
  await symlink(f.cwd, alias);
  const starts = await Promise.all([
    f.run(['--no-pdfjs']), f.run(['start', alias, '--no-pdfjs']), f.run([f.cwd, '--no-pdfjs', '--no-open']),
  ]);
  const urls = starts.map(result => result.stdout.trim());
  assert.equal(new Set(urls).size, 1);
  const data = await info(urls[0]);
  assert.equal(data.root, f.cwd);
  assert.equal(data.backend, 'node');
  assert.equal(data.pdfjs, false);
  const state = await f.metadata(f.cwd);
  assert.equal(state.instance_id, data.instance_id);
  assert.equal(state.pid, data.pid);
  assert.equal((await stat(f.statePath(f.cwd))).mode & 0o777, 0o600);
  assert.equal((await f.run(['url', alias])).stdout.trim(), urls[0]);
  assert.match((await f.run(['logs'])).stdout, /fbrowse http:\/\/127\.0\.0\.1:/);
  assert.match((await f.run(['list'])).stdout, new RegExp(String(data.port)));
  assert.deepEqual(await readdir(f.cwd), []);
});

test('projects stay isolated and restart retains the verified port and PDF setting', async t => {
  const f = await fixture(t);
  const second = await f.project('second project');
  const firstURL = (await f.run(['start', '--no-pdfjs'])).stdout.trim();
  const secondURL = (await f.run(['start', second, '--no-pdfjs'])).stdout.trim();
  assert.notEqual(firstURL, secondURL);
  const old = await info(firstURL);
  assert.equal((await f.run(['restart'])).stdout.trim(), firstURL);
  const current = await info(firstURL);
  assert.notEqual(current.instance_id, old.instance_id);
  assert.equal(current.pdfjs, false);
  await f.run(['stop']);
  await assert.rejects(fetch(`${firstURL}api/info`, { signal: AbortSignal.timeout(1500) }));
  assert.equal((await info(secondURL)).root, second);
  assert.notEqual((await f.run(['url'], { allowFailure: true })).code, 0);
  const listing = (await f.run(['list'])).stdout;
  assert.ok(!listing.includes(firstURL));
  assert.ok(listing.includes(secondURL));
});

test('shutdown authenticates both token and instance, while ignoring a forged PID', async t => {
  const f = await fixture(t);
  const url = (await f.run(['--no-pdfjs'])).stdout.trim();
  const data = await info(url);
  for (const [token, instance] of [['wrong', data.instance_id], [data.config_token, 'wrong']]) {
    const response = await fetch(`${url}api/shutdown`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fbrowse-Token': token }, body: JSON.stringify({ instance_id: instance }) });
    assert.equal(response.status, 403);
    assert.equal((await info(url)).instance_id, data.instance_id);
  }
  const state = await f.metadata(f.cwd);
  state.pid = process.pid;
  await writeFile(f.statePath(f.cwd), JSON.stringify(state));
  await f.run(['stop']);
  await assert.rejects(fetch(`${url}api/info`, { signal: AbortSignal.timeout(1500) }));
});

test('a mismatched instance is never reused, shut down, overwritten, or listed', async t => {
  const f = await fixture(t);
  const url = (await f.run(['--no-pdfjs'])).stdout.trim();
  const original = await readFile(f.statePath(f.cwd), 'utf8');
  const forged = JSON.parse(original);
  forged.instance_id = 'unrelated-instance';
  await writeFile(f.statePath(f.cwd), JSON.stringify(forged));
  try {
    for (const command of ['start', 'url', 'stop', 'restart']) {
      const result = await f.run([command, '--no-pdfjs'], { allowFailure: true });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /서버 신원이 일치하지 않습니다/);
    }
    assert.ok(!(await f.run(['list'])).stdout.includes(url));
    assert.equal((await info(url)).instance_id, JSON.parse(original).instance_id);
    assert.equal((await f.metadata(f.cwd)).instance_id, forged.instance_id);
  } finally { await writeFile(f.statePath(f.cwd), original); }
});

test('an unrelated HTTP listener never receives a shutdown request from forged state', async t => {
  const f = await fixture(t);
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ service: 'unrelated', backend: 'node', root: f.cwd, instance_id: 'fake', config_token: 'secret' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const record = { service: 'project-file-browser', backend: 'node', root: f.cwd, instance_id: 'fake', pid: process.pid, port: server.address().port };
  await mkdir(join(f.env.XDG_STATE_HOME, 'fbrowse', key(f.cwd)), { recursive: true });
  await writeFile(f.statePath(f.cwd), JSON.stringify(record));
  try {
    assert.notEqual((await f.run(['stop'], { allowFailure: true })).code, 0);
    assert.deepEqual(requests, ['/api/info']);
  } finally {
    await rm(f.statePath(f.cwd));
    await new Promise(resolve => server.close(resolve));
  }
});

test('roots use the existing external config and support concurrent edits and disconnected rename', async t => {
  const f = await fixture(t);
  const papers = await f.project('논문 자료');
  await f.run(['roots', 'add', 'papers', papers, '--name', '논문 모음']);
  const url = (await f.run(['--no-pdfjs'])).stdout.trim();
  assert.ok((await info(url)).roots.some(root => root.id === 'papers' && root.name === '논문 모음'));
  await Promise.all(['a', 'b', 'c'].map(id => f.run(['roots', 'add', id, f.cwd])));
  const configPath = join(f.env.XDG_CONFIG_HOME, 'fbrowse/projects', `${key(f.cwd)}.json`);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.version, 1);
  assert.equal(config.project, f.cwd);
  assert.deepEqual(Object.keys(config.roots).sort(), ['a', 'b', 'c', 'papers']);
  await f.run(['stop', papers]);
  await rm(papers, { recursive: true });
  await f.run(['roots', 'edit', 'papers', '--name', '보관 논문']);
  const listing = (await f.run(['roots'])).stdout;
  assert.match(listing, /보관 논문/);
  assert.match(listing, /연결 안 됨/);
  assert.ok((await info(url)).roots.some(root => root.id === 'papers' && root.connected === false));
  await f.run(['roots', 'remove', 'papers']);
  assert.ok(!(await info(url)).roots.some(root => root.id === 'papers'));
  for (const args of [['add', 'project', f.cwd], ['add', 'a', f.cwd], ['remove', 'unknown']]) {
    assert.notEqual((await f.run(['roots', ...args], { allowFailure: true })).code, 0);
  }
  assert.deepEqual(await readdir(f.cwd), []);
  // Deleted project paths are deliberately excluded from teardown canonicalization.
  await mkdir(papers);
});

test('shell metacharacters are literal and legacy state stays untouched', async t => {
  const f = await fixture(t);
  const root = await f.project("한글 ' space $(touch PWNED) `touch BAD` ;");
  const legacy = join(f.env.XDG_STATE_HOME, 'project-file-browser', key(root));
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'server.json'), 'legacy bytes');
  const url = (await f.run([root, '--no-pdfjs'])).stdout.trim();
  assert.equal((await info(url)).root, root);
  assert.equal(await readFile(join(legacy, 'server.json'), 'utf8'), 'legacy bytes');
  assert.deepEqual(await readdir(root), []);
});

test('HOME fallback layout and recovery from a dead launcher lock', async t => {
  const f = await fixture(t);
  delete f.env.XDG_STATE_HOME;
  delete f.env.XDG_CONFIG_HOME;
  const directory = join(f.env.HOME, '.local/state/fbrowse', key(f.cwd));
  await mkdir(join(directory, 'lifecycle.lock'), { recursive: true });
  await writeFile(join(directory, 'lifecycle.lock/owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  const url = (await f.run(['--no-pdfjs'])).stdout.trim();
  assert.equal((await info(url)).root, f.cwd);
  assert.equal((await f.metadata(f.cwd)).url, url);
  await f.run(['roots', 'add', 'same', f.cwd]);
  const config = JSON.parse(await readFile(join(f.env.HOME, '.config/fbrowse/projects', `${key(f.cwd)}.json`), 'utf8'));
  assert.equal(config.project, f.cwd);
});

test('internal daemon handles SIGTERM and SIGINT by closing its owned server', async t => {
  const f = await fixture(t);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const root = await f.project(`signal ${signal}`);
    const stateFile = f.statePath(root);
    await mkdir(join(f.env.XDG_STATE_HOME, 'fbrowse', key(root)), { recursive: true });
    const child = spawn(process.execPath, [launcher, '__serve', '--root', root, '--port', '0', '--state-file', stateFile, '--no-pdfjs'],
      { env: f.env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, receivedSignal) => resolve({ code, signal: receivedSignal }));
    });
    let metadata;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { metadata = await f.metadata(root); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.equal(child.exitCode, null, output);
      await delay(25);
    }
    assert.ok(metadata, output || 'Daemon did not become ready.');
    assert.equal((await info(metadata.url)).pid, child.pid);
    // Only signal the child this test created; no state-file PID is trusted.
    child.kill(signal);
    const result = await Promise.race([exited, delay(3000).then(() => { throw new Error('Daemon did not close after signal.'); })]);
    assert.deepEqual(result, { code: 0, signal: null }, output);
    await assert.rejects(fetch(`${metadata.url}api/info`, { signal: AbortSignal.timeout(1500) }));
  }
});
