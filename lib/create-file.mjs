import * as fs from 'node:fs/promises';
import { constants, fstatSync, lstatSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { failure, listedEntry, visible } from './files.mjs';
import { withFilesystemLock } from './editor-locks.mjs';

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const conflict = () => failure('File, parent directory or root mapping changed; refresh before creating', 409);
const identity = info => `${info.dev}:${info.ino}`;
const snapshot = info => [info.dev, info.ino, info.size, info.mode, info.nlink, info.uid, info.gid,
  info.mtimeNs, info.ctimeNs].join(':');

function creationPath(parent, name, showHidden) {
  if (typeof parent !== 'string' || typeof name !== 'string' || !name || !name.isWellFormed() ||
      name === '.' || name === '..' || /[/\\\0]/.test(name))
    throw failure('Parent directory and a single valid filename are required', 400);
  if (!parent.isWellFormed() || parent.includes('\0') || parent.includes('\\'))
    throw failure('Invalid parent directory', 400);
  if (path.isAbsolute(parent) || parent.split('/').includes('..'))
    throw failure('Select a directory inside the registered root', 403);
  if (parent && parent.split('/').some(part => !part || part === '.'))
    throw failure('Parent must be a relative directory path', 400);
  const relative = parent ? `${parent}/${name}` : name;
  if (!visible(relative, showHidden)) throw failure('Path is hidden or excluded', 403);
  return relative;
}

async function verify(handles, boundary, parent, getBoundary) {
  if (await getBoundary() !== boundary) throw conflict();
  const pieces = parent ? parent.split('/') : [];
  let expected = boundary;
  for (let i = 0; i < handles.length; i++) {
    if (i) expected = path.join(expected, pieces[i - 1]);
    const named = await fs.lstat(expected, { bigint: true });
    if (!named.isDirectory() || identity(named) !== identity(await handles[i].stat({ bigint: true })) ||
        await fs.realpath(expected) !== expected || await fs.realpath(`/proc/self/fd/${handles[i].fd}`) !== expected)
      throw conflict();
  }
  if (await getBoundary() !== boundary) throw conflict();
}

// The rollback pathname stays anchored to the opened parent, even after a
// rename. Only our exact, still-empty and unmodified inode may be removed.
// Synchronous checks and unlink avoid yielding to another in-process request
// between the final identity check and removal; external writers remain owners
// of any replacement, hard-linked, or modified artifact.
function rollback(file, target, created) {
  try {
    const opened = fstatSync(file.fd, { bigint: true }), named = lstatSync(target, { bigint: true });
    if (opened.isFile() && named.isFile() && opened.size === 0n && opened.nlink === 1n &&
        snapshot(opened) === snapshot(created) && snapshot(named) === snapshot(created)) unlinkSync(target);
  } catch (error) {
    if (!['ENOENT', 'ESTALE', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;
  }
}

export async function createFile(getBoundary, parent, name, rootId, showHidden = false, selectedBoundary = null) {
  const relative = creationPath(parent, name, showHidden);
  const boundary = selectedBoundary ?? await getBoundary();
  return withFilesystemLock(boundary, () => createLocked(getBoundary, parent, name, rootId, showHidden, boundary, relative));
}

async function createLocked(getBoundary, parent, name, rootId, showHidden, boundary, relative) {
  const handles = [];
  let file, target, created;
  try {
    // O_DIRECTORY and O_NONBLOCK make links, FIFOs and other special parents
    // fail promptly. Every traversal step is relative to the preceding fd.
    handles.push(await fs.open(boundary, directoryFlags));
    for (const piece of parent ? parent.split('/') : [])
      handles.push(await fs.open(`/proc/self/fd/${handles.at(-1).fd}/${piece}`, directoryFlags));
    await verify(handles, boundary, parent, getBoundary);
    target = `/proc/self/fd/${handles.at(-1).fd}/${name}`;
    file = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW |
      constants.O_NONBLOCK, 0o666);
    created = fstatSync(file.fd, { bigint: true });
    if (!created.isFile() || created.size !== 0n || created.nlink !== 1n) throw conflict();
    await verify(handles, boundary, parent, getBoundary);
    const entry = await listedEntry(boundary, relative, rootId, showHidden);
    await verify(handles, boundary, parent, getBoundary);
    if (snapshot(await file.stat({ bigint: true })) !== snapshot(created) ||
        snapshot(await fs.lstat(target, { bigint: true })) !== snapshot(created) ||
        await fs.realpath(`/proc/self/fd/${file.fd}`) !== path.join(boundary, relative)) throw conflict();
    if (await getBoundary() !== boundary) throw conflict();
    return { root_id: rootId, path: relative, entry };
  } catch (error) {
    if (file && created) rollback(file, target, created);
    if (error.code === 'EEXIST') throw failure('A file, directory or link already has that name', 409);
    if (['ENOENT', 'ESTALE'].includes(error.code)) throw conflict();
    if (['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS'].includes(error.code))
      throw failure('Root or parent directory is not safely writable', 403);
    if (['ENAMETOOLONG', 'EINVAL'].includes(error.code)) throw failure('Invalid filename or parent directory', 400);
    throw error;
  } finally {
    try { await file?.close(); }
    finally { for (const handle of handles.reverse()) await handle.close(); }
  }
}
