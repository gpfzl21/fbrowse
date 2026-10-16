import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function projectKey(project) {
  return createHash('sha256').update(realpathSync(project)).digest('hex').slice(0, 16);
}

export function projectConfig(project) {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'fbrowse', 'projects', `${projectKey(project)}.json`);
}

function validateId(id) {
  if (typeof id !== 'string' || id === 'project' || !/^[A-Za-z0-9_-]{1,48}$/.test(id))
    throw new Error('Root ID: 1–48 ASCII letters/digits/_/-, excluding project');
}

export async function readConfig(project) {
  let data;
  try { data = JSON.parse(await fs.readFile(projectConfig(project), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (data?.version !== 1 || data.project !== realpathSync(project) ||
      !data.roots || typeof data.roots !== 'object' || Array.isArray(data.roots))
    throw new Error('Invalid project root configuration');
  for (const [id, record] of Object.entries(data.roots)) {
    validateId(id);
    if (!record || typeof record.name !== 'string' || !record.name.trim()) throw new Error('Invalid root name');
    if (typeof record.path !== 'string' || !path.isAbsolute(record.path) || record.path.includes('\0'))
      throw new Error('Root paths must be absolute');
  }
  return data.roots;
}

export async function atomicJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function locked(target, callback) {
  // mkdir is atomic across CLI/server processes; owner PID permits recovery after a crash.
  const lock = `${target}.node-lock`;
  const reclaim = `${lock}.reclaim`;
  const identity = { pid: process.pid, token: randomUUID() };
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await fs.mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Only one reclaimer may inspect/remove a dead owner's lock. Re-read the
      // owner under this guard: another process may already have acquired it.
      let recovering = false;
      try { await fs.mkdir(reclaim, { mode: 0o700 }); recovering = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (recovering) try {
        try {
          const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner'), 'utf8'));
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); }
            catch (error) { if (error.code === 'ESRCH') await fs.rm(lock, { recursive: true, force: true }); }
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // A process can die between mkdir and writing its owner. rmdir cannot
          // delete a newly acquired lock once its owner record exists.
          try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 10_000) await fs.rmdir(lock); }
          catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
        }
      } finally { await fs.rmdir(reclaim); }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for root configuration lock');
      await delay(15 + Math.random() * 25);
    }
  }
  try {
    await atomicJson(path.join(lock, 'owner'), identity);
    return await callback();
  } finally {
    try {
      const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner'), 'utf8'));
      if (owner.token === identity.token) await fs.rm(lock, { recursive: true, force: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function canonicalAllowMissing(directory) {
  try { return await fs.realpath(directory); }
  catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(directory) === directory) throw error;
    return path.join(await canonicalAllowMissing(path.dirname(directory)), path.basename(directory));
  }
}

export async function changeRoot(project, operation, id = null, name = null, directory = null) {
  const target = projectConfig(project);
  return locked(target, async () => {
    const selected = await readConfig(project);
    if (operation === 'add') {
      id ||= randomUUID().replaceAll('-', '').slice(0, 16);
      validateId(id);
      if (Object.hasOwn(selected, id)) throw new Error('Root ID already exists');
    } else if (operation === 'edit' || operation === 'remove') {
      validateId(id);
      if (!Object.hasOwn(selected, id)) throw new Error('Unknown root ID');
    } else throw new Error('Unknown root operation');
    if (operation === 'remove') delete selected[id];
    else {
      if (typeof name !== 'string' || !name.trim() || [...name].length > 120)
        throw new Error('Root name is required (max 120 characters)');
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0'))
        throw new Error('서버의 절대 디렉터리 경로를 입력하세요.');
      directory = await canonicalAllowMissing(path.resolve(directory));
      if (!(operation === 'edit' && directory === selected[id].path)) {
        let valid = false;
        try { valid = (await fs.stat(directory)).isDirectory(); } catch {}
        if (!valid) throw new Error('서버에 존재하는 디렉터리만 연결할 수 있습니다.');
      }
      Object.defineProperty(selected, id, { value: { name: name.trim(), path: directory }, enumerable: true, configurable: true, writable: true });
    }
    await atomicJson(target, { version: 1, project: realpathSync(project), roots: selected });
    return id;
  });
}
