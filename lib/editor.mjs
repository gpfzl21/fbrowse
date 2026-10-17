import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { failure, openFile, visible, LANGUAGES, TYPES } from './files.mjs';
import { withEditorLock, withFilesystemLock } from './editor-locks.mjs';
import { readViewPreference, writeViewPreference } from './view-preferences.mjs';

export const MAX_EDITOR_BYTES = 8 * 1024 * 1024;
const conflict = () => failure('File or root changed; reload before saving', 409);
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export function editorPath(relative, showHidden = false) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') ||
      path.isAbsolute(relative) || relative.split('/').includes('..') || !visible(relative, showHidden))
    throw failure('Select a visible file inside the registered root', 403);
  return path.posix.normalize(relative);
}

function identity(info) { return `${info.dev}:${info.ino}`; }
function fileIdentity(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.nlink, info.uid, info.gid].join(':');
}
function fingerprint(boundary, relative, rootInfo, info, bytes) {
  return createHash('sha256').update(JSON.stringify([boundary, relative, identity(rootInfo), fileIdentity(info)]))
    .update('\0').update(bytes).digest('hex');
}

async function boundedRead(file) {
  const blocks = [];
  let size = 0;
  for (;;) {
    const block = Buffer.alloc(Math.min(64 * 1024, MAX_EDITOR_BYTES + 1 - size));
    const { bytesRead } = await file.read(block, 0, block.length, size);
    if (!bytesRead) return Buffer.concat(blocks, size);
    size += bytesRead;
    if (size > MAX_EDITOR_BYTES) throw failure('Editor supports files up to 8 MiB; use the original/text viewer', 413);
    blocks.push(block.subarray(0, bytesRead));
  }
}

function decode(bytes) {
  let text, encoding = 'UTF-8', bom = Buffer.alloc(0);
  try {
    if (bytes.subarray(0, 4).equals(Buffer.from([255, 254, 0, 0])) ||
        bytes.subarray(0, 4).equals(Buffer.from([0, 0, 254, 255]))) {
      const little = bytes[0] === 255;
      encoding = little ? 'UTF-32LE' : 'UTF-32BE'; bom = bytes.subarray(0, 4);
      if ((bytes.length - 4) % 4) throw new Error('Truncated UTF-32');
      const chunks = [];
      for (let offset = 4; offset < bytes.length; offset += 4) {
        const point = little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error('Invalid UTF-32');
        chunks.push(String.fromCodePoint(point));
      }
      text = chunks.join('');
    } else if (bytes.subarray(0, 2).equals(Buffer.from([255, 254])) || bytes.subarray(0, 2).equals(Buffer.from([254, 255]))) {
      encoding = bytes[0] === 255 ? 'UTF-16LE' : 'UTF-16BE'; bom = bytes.subarray(0, 2);
      text = new TextDecoder(encoding.toLowerCase(), { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2));
    } else {
      if (bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) { encoding = 'UTF-8 BOM'; bom = bytes.subarray(0, 3); }
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bom.length));
    }
    if (text.includes('\0') || /[\x01-\x08\x0b\x0e-\x1f]/.test(text)) throw new Error('Binary file');
  } catch { throw failure('Only valid UTF-8 or BOM-marked UTF-16/UTF-32 text can be edited', 415); }
  const endings = new Set(text.match(/\r\n|\r|\n/g) || []);
  return { text: text.replace(/\r\n?/g, '\n'), encoding, bom, newline: endings.values().next().value || '\n', mixed: endings.size > 1 };
}

function encode(text, format) {
  // Reject unpaired surrogates instead of silently replacing them during UTF-8
  // conversion. Editor input is LF-normalized; the original newline is restored.
  if (!text.isWellFormed() || text.includes('\0') || /[\x01-\x08\x0b\x0e-\x1f]/.test(text))
    throw failure('Save requires valid Unicode text without binary controls', 415);
  text = text.replace(/\r\n?/g, '\n').replace(/\n/g, format.newline);
  let body;
  if (format.encoding.startsWith('UTF-32')) {
    let length = 0;
    for (const _ of text) length++;
    if (length * 4 + format.bom.length > MAX_EDITOR_BYTES) throw failure('Encoded save exceeds 8 MiB', 413);
    body = Buffer.alloc(length * 4);
    let offset = 0;
    for (const char of text) {
      if (format.encoding === 'UTF-32LE') body.writeUInt32LE(char.codePointAt(0), offset);
      else body.writeUInt32BE(char.codePointAt(0), offset);
      offset += 4;
    }
  } else {
    const codec = format.encoding.startsWith('UTF-16') ? 'utf16le' : 'utf8';
    if (Buffer.byteLength(text, codec) + format.bom.length > MAX_EDITOR_BYTES) throw failure('Encoded save exceeds 8 MiB', 413);
    body = Buffer.from(text, codec);
    if (format.encoding === 'UTF-16BE') body.swap16();
  }
  return Buffer.concat([format.bom, body]);
}

async function hasSymlink(boundary, relative) {
  let target = boundary;
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    if ((await fs.lstat(target)).isSymbolicLink()) return true;
  }
  return false;
}

function readonly(info, format, symlink) {
  if (symlink) return 'Symlink files and symlink parent directories are read-only';
  if (info.nlink !== 1n) return 'Hard-linked files are read-only';
  if (!(Number(info.mode) & 0o222)) return 'File has no write permission';
  if (format.mixed) return 'Mixed line endings are read-only to avoid changing formatting';
  return null;
}

async function snapshot(boundary, relative, showHidden, anchored = null) {
  const rootInfo = await fs.lstat(boundary, { bigint: true });
  if (!rootInfo.isDirectory() || await fs.realpath(boundary) !== boundary) throw conflict();
  let file;
  if (anchored) file = await fs.open(anchored.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  else ({ file } = await openFile(boundary, relative, showHidden));
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile()) throw failure('Only existing regular files can be edited', 415);
    if (info.size > BigInt(MAX_EDITOR_BYTES)) throw failure('Editor supports files up to 8 MiB; use the original/text viewer', 413);
    const bytes = await boundedRead(file);
    if (fileIdentity(info) !== fileIdentity(await file.stat({ bigint: true })) ||
        identity(rootInfo) !== identity(await fs.lstat(boundary, { bigint: true }))) throw conflict();
    const format = decode(bytes);
    const symlink = anchored ? false : await hasSymlink(boundary, relative);
    let reason = readonly(info, format, symlink);
    if (!reason) {
      try { await fs.access(anchored?.target || path.join(boundary, relative), constants.W_OK); }
      catch { reason = 'File is not writable by the server user'; }
    }
    return { info, rootInfo, bytes, format, reason, version: fingerprint(boundary, relative, rootInfo, info, bytes) };
  } finally { await file.close(); }
}

export async function readEditor(boundary, relative, showHidden = false, project = boundary, rootId = 'project') {
  relative = editorPath(relative, showHidden);
  const value = await snapshot(boundary, relative, showHidden);
  const extension = path.extname(relative).toLowerCase(), name = path.basename(relative).toLowerCase();
  const markdown = TYPES.markdown.has(extension), html = TYPES.html.has(extension);
  return { path: relative, text: value.format.text, language: LANGUAGES[extension] ||
      (['makefile', 'gnumakefile'].includes(name) ? 'makefile' : name === 'dockerfile' ? 'dockerfile' : ''),
    markdown, html, encoding: value.format.encoding, editable: !value.reason, reason: value.reason,
    version: value.version, tab: await readViewPreference(boundary, relative, markdown || html ? 'preview' : 'source', project, rootId) };
}

// Every path component is opened with O_NOFOLLOW through its parent's open
// descriptor. Subsequent writes/rename use that same descriptor, so switching a
// parent to an outside symlink cannot redirect a save into its target.
async function anchor(boundary, relative) {
  const handles = [];
  try {
    handles.push(await fs.open(boundary, directoryFlags));
    const pieces = relative.split('/'), name = pieces.pop();
    for (const piece of pieces) handles.push(await fs.open(`/proc/self/fd/${handles.at(-1).fd}/${piece}`, directoryFlags));
    const parent = `/proc/self/fd/${handles.at(-1).fd}`;
    return { handles, parent, target: `${parent}/${name}`, async close() { for (const file of handles.reverse()) await file.close(); } };
  } catch (error) { for (const file of handles.reverse()) await file.close(); throw error; }
}

async function verifyAnchor(anchored, boundary, relative, getBoundary) {
  if (await getBoundary() !== boundary || await fs.realpath(boundary) !== boundary ||
      identity(await anchored.handles[0].stat({ bigint: true })) !== identity(await fs.lstat(boundary, { bigint: true }))) throw conflict();
  let expected = boundary;
  const parts = relative.split('/').slice(0, -1);
  for (let i = 0; i < anchored.handles.length; i++) {
    if (i) expected = path.join(expected, parts[i - 1]);
    if (await fs.realpath(`/proc/self/fd/${anchored.handles[i].fd}`) !== expected ||
        identity(await anchored.handles[i].stat({ bigint: true })) !== identity(await fs.lstat(expected, { bigint: true }))) throw conflict();
  }
}

export async function saveEditor(getBoundary, relative, text, expectedVersion, showHidden = false) {
  relative = editorPath(relative, showHidden);
  if (typeof text !== 'string' || typeof expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(expectedVersion))
    throw failure('Text and expected_version from the editor are required', 400);
  if (Buffer.byteLength(text) > MAX_EDITOR_BYTES) throw failure('Save exceeds 8 MiB', 413);
  const boundary = await getBoundary();
  return withFilesystemLock(boundary, () => saveLocked(getBoundary, relative, text, expectedVersion, showHidden, boundary));
}

async function saveLocked(getBoundary, relative, text, expectedVersion, showHidden, boundary) {
  return withEditorLock(path.join(boundary, relative), async () => {
    let anchored, temporary;
    try {
      if (await getBoundary() !== boundary) throw conflict();
      if (!(await fs.lstat(boundary)).isDirectory() || await fs.realpath(boundary) !== boundary) throw conflict();
      anchored = await anchor(boundary, relative);
      await verifyAnchor(anchored, boundary, relative, getBoundary);
      const original = await snapshot(boundary, relative, showHidden, anchored);
      if (original.version !== expectedVersion) throw conflict();
      if (original.reason) throw failure(original.reason, 403);
      const bytes = encode(text, original.format);
      if (text.replace(/\r\n?/g, '\n') === original.format.text) {
        await verifyAnchor(anchored, boundary, relative, getBoundary);
        return { path: relative, version: original.version, saved: true };
      }
      temporary = `${anchored.parent}/.fbrowse-save-${process.pid}-${randomUUID()}.tmp`;
      const file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let replacementIdentity;
      try {
        await file.writeFile(bytes);
        const current = await file.stat();
        if (current.uid !== Number(original.info.uid) || current.gid !== Number(original.info.gid))
          await file.chown(Number(original.info.uid), Number(original.info.gid));
        await file.chmod(Number(original.info.mode) & 0o7777);
        await file.sync();
        replacementIdentity = identity(await file.stat({ bigint: true }));
      } finally { await file.close(); }
      const latest = await snapshot(boundary, relative, showHidden, anchored);
      await verifyAnchor(anchored, boundary, relative, getBoundary);
      if (latest.version !== expectedVersion) throw conflict();
      if (latest.reason) throw failure(latest.reason, 403);
      await fs.rename(temporary, anchored.target);
      temporary = null;
      await anchored.handles.at(-1).sync();
      const saved = await snapshot(boundary, relative, showHidden, anchored);
      if (identity(saved.info) !== replacementIdentity || !saved.bytes.equals(bytes)) throw conflict();
      return { path: relative, version: saved.version, saved: true };
    } catch (error) {
      if (['ENOENT', 'ESTALE'].includes(error.code)) throw conflict();
      if (['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw failure('File or directory is not safely writable', 403);
      throw error;
    } finally {
      try { if (temporary) await fs.rm(temporary, { force: true }); }
      finally { await anchored?.close(); }
    }
  });
}

export async function setEditorView(boundary, relative, tab, showHidden = false, project = boundary, rootId = 'project') {
  relative = editorPath(relative, showHidden);
  if (!['source', 'preview'].includes(tab)) throw failure('Tab must be source or preview', 400);
  // Resolve exactly one requested file; never scan roots to build preferences.
  const { file } = await openFile(boundary, relative, showHidden);
  await file.close();
  await writeViewPreference(boundary, relative, tab, project, rootId);
  return { path: relative, tab };
}

// Relocation never saves text or manufactures a baseline from a decoded draft.
// Keep both names locked against cooperating saves and prove the same inode and
// raw bytes survived the rename before issuing a new path-bound editor version.
export async function relocateEditors(getBoundary, oldPath, newPath, editors, mutate,
    showHidden = false, project = null, rootId = 'project') {
  const boundary = await getBoundary();
  const moves = editors.map(value => ({ ...value,
    next: newPath + value.path.slice(oldPath.length) }));
  const locks = [...new Set(moves.flatMap(value => [path.join(boundary, value.path), path.join(boundary, value.next)]))].sort();
  const locked = index => index < locks.length ? withEditorLock(locks[index], () => locked(index + 1)) : run();
  async function inspect(relative) {
    const anchored = await anchor(boundary, relative);
    try {
      await verifyAnchor(anchored, boundary, relative, getBoundary);
      const value = await snapshot(boundary, relative, showHidden, anchored);
      await verifyAnchor(anchored, boundary, relative, getBoundary);
      return value;
    } finally { await anchored.close(); }
  }
  async function run() {
    const before = [];
    for (const value of moves) {
      const original = await inspect(value.path);
      if (original.version !== value.version) throw failure('An open editor changed on disk; reload or copy its draft before renaming', 409);
      before.push({ info: original.info, version: original.version,
        digest: createHash('sha256').update(original.bytes).digest('hex') });
    }
    for (const [index, value] of moves.entries())
      if ((await inspect(value.path)).version !== before[index].version)
        throw failure('An open editor changed on disk; reload or copy its draft before renaming', 409);
    const result = await mutate();
    const bindings = [];
    for (const [index, value] of moves.entries()) {
      const binding = { old_path: value.path, path: value.next, old_version: value.version, version: null };
      try {
        const after = await inspect(value.next), original = before[index];
        const stable = info => [info.dev, info.ino, info.size, info.mtimeNs, info.mode, info.nlink, info.uid, info.gid].join(':');
        if (stable(original.info) !== stable(after.info) ||
            original.digest !== createHash('sha256').update(after.bytes).digest('hex')) throw conflict();
        binding.version = after.version;
      } catch {
        binding.reason = 'Rename completed, but the file changed or its new binding could not be verified; keep your draft, then reload or copy it before saving';
      }
      bindings.push(binding);
    }
    // Preferences are best-effort, project/root-specific, and independent of
    // proof of editor bytes. The client also retains its currently selected tab.
    for (const [old, next] of new Map([[oldPath, newPath], ...moves.map(value => [value.path, value.next])])) {
      try {
        const tab = await readViewPreference(boundary, old, null, project ?? boundary, rootId);
        if (tab) await writeViewPreference(boundary, next, tab, project ?? boundary, rootId);
      } catch { /* A preference failure must not undo or conceal a completed rename. */ }
    }
    return { ...result, editors: bindings };
  }
  return locked(0);
}
