import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { failure } from './files.mjs';

export function digest(value) { return createHash('sha256').update(value).digest('hex'); }

// XDG itself may be a user-managed symlink. Our own directories must be private,
// owned directories, so other users cannot substitute lock or preference files.
export async function editorDirectory(kind) {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  let directory = await fs.realpath(base);
  for (const part of ['fbrowse', 'editor', kind]) {
    directory = path.join(directory, part);
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022))
      throw failure('Editor state directory must be owned and not writable by other users', 403);
  }
  return directory;
}

async function owner(lock) {
  const file = await fs.open(path.join(lock, 'owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.size > 1024) throw failure('Unsafe editor lock', 403);
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

function dead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

// The canonical file path (rather than project/root IDs) shares the lock across
// independent project servers pointing at the same external root.
export async function withEditorLock(identity, callback) {
  const lock = path.join(await editorDirectory('locks'), digest(identity));
  const reclaim = lock + '.reclaim';
  const token = randomUUID(), deadline = Date.now() + 30_000;
  for (;;) {
    try { await fs.mkdir(lock, { mode: 0o700 }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let info;
    try { info = await fs.lstat(lock); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw failure('Unsafe editor lock', 403);
    let recovering = false;
    try { await fs.mkdir(reclaim, { mode: 0o700 }); recovering = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (recovering) try {
      try {
        const record = await owner(lock);
        if (dead(record.pid)) await fs.rm(lock, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // rmdir only removes an empty, abandoned mkdir-before-owner lock;
        // it cannot remove a lock whose new owner has installed its record.
        try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 10_000) await fs.rmdir(lock); }
        catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
      }
    } finally { await fs.rmdir(reclaim); }
    if (Date.now() >= deadline) throw failure('Another save is still in progress; retry after reloading', 409);
    await delay(15 + Math.random() * 20);
  }
  try {
    await fs.writeFile(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
    return await callback();
  } finally {
    try { if ((await owner(lock)).token === token) await fs.rm(lock, { recursive: true, force: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Root-wide serialization covers cooperating servers, including exclusive file
// creation racing a rename's no-overwrite check. File saves retain their own
// finer-grained locks; relocation acquires those as well.
export function withFilesystemLock(boundary, callback) {
  return withEditorLock(`filesystem-actions\0${boundary}`, callback);
}

// Every multi-root operation takes the same canonical order, including when
// two root IDs resolve to the same directory. Never reacquire our own lock.
export function withFilesystemLocks(boundaries, callback) {
  const ordered = [...new Set(boundaries)].sort();
  const acquire = index => index === ordered.length ? callback() :
    withFilesystemLock(ordered[index], () => acquire(index + 1));
  return acquire(0);
}
