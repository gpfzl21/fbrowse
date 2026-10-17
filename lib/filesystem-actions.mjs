import * as fs from 'node:fs/promises';
import { constants, lstatSync, fstatSync, realpathSync, readlinkSync, openSync, closeSync,
  mkdirSync, unlinkSync, rmdirSync, renameSync, opendirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { failure, visible, TYPES, mimeType } from './files.mjs';
import { withFilesystemLock, withFilesystemLocks } from './editor-locks.mjs';
import { relocateEditors } from './editor.mjs';

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const NEW = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_NODES = 50_000, MAX_DEPTH = 128, MAX_EDITORS = 64;
const conflict = () => failure('File, parent directory or root mapping changed; refresh before trying again', 409);
const id = info => `${info.dev}:${info.ino}`;
const stamp = info => [info.dev, info.ino, info.size, info.mode, info.nlink, info.uid, info.gid,
  info.mtimeNs, info.ctimeNs].join(':');
const kind = info => info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null;
const parentOf = relative => relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
const joined = (parent, name) => parent ? `${parent}/${name}` : name;

function relativePath(value, showHidden, empty = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0') || value.includes('\\'))
    throw failure('A valid relative path is required', 400);
  if ((!value && !empty) || path.isAbsolute(value) || value.split('/').includes('..'))
    throw failure('Select an entry inside the registered root; the root itself cannot be changed', 403);
  if (value && value.split('/').some(part => !part || part === '.')) throw failure('Use a relative path without empty or dot components', 400);
  if (!visible(value, showHidden)) throw failure('Path is hidden or excluded', 403);
  return value;
}

function basename(value, showHidden) {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value === '.' || value === '..' || /[/\\\0]/.test(value))
    throw failure('A single valid new basename is required', 400);
  if (!visible(value, showHidden)) throw failure('Path is hidden or excluded', 403);
  return value;
}

function validate(data, showHidden) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.root !== 'string' || !data.root)
    throw failure('An explicit root and action are required', 400);
  const fields = {
    mkdir: ['action', 'root', 'parent', 'name'],
    duplicate: ['action', 'root', 'path', 'expected_version'],
    copy: ['action', 'root', 'parent', 'root_path', 'source_root', 'source_root_path', 'source_path', 'expected_version'],
    rename: ['action', 'root', 'path', 'name', 'expected_version', 'editors'],
    move: ['action', 'root', 'path', 'parent', 'root_path', 'expected_version', 'editors'],
    delete: ['action', 'root', 'path', 'root_path', 'expected_version', 'confirmed'],
  };
  if (!Object.hasOwn(fields, data.action) || Object.keys(data).some(key => !fields[data.action].includes(key)))
    throw failure('Unsupported filesystem action or options', 400);
  if (data.action === 'mkdir') {
    relativePath(data.parent, showHidden, true); basename(data.name, showHidden);
  } else {
    if (data.action === 'copy') {
      if (typeof data.source_root !== 'string' || !data.source_root)
        throw failure('An explicit source_root is required', 400);
      for (const field of ['root_path', 'source_root_path'])
        if (typeof data[field] !== 'string' || !path.isAbsolute(data[field]) || data[field].includes('\0'))
          throw failure('Canonical root_path and source_root_path from registered roots are required', 400);
      relativePath(data.parent, showHidden, true);
      relativePath(data.source_path, showHidden);
    } else relativePath(data.path, showHidden);
    if (typeof data.expected_version !== 'string' || !/^[a-f0-9]{64}$/.test(data.expected_version))
      throw failure('expected_version from fs-info is required', 400);
  }
  if (data.action === 'rename' || data.action === 'move') {
    if (data.action === 'rename') basename(data.name, showHidden);
    else {
      relativePath(data.parent, showHidden, true);
      if (typeof data.root_path !== 'string' || !path.isAbsolute(data.root_path) || data.root_path.includes('\0'))
        throw failure('The selected canonical root_path is required', 400);
    }
    if (data.editors !== undefined && (!Array.isArray(data.editors) || data.editors.length > MAX_EDITORS))
      throw failure('editors must be a bounded list of affected open editor versions', 400);
    const seen = new Set();
    for (const value of data.editors || []) {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).some(key => !['path', 'version'].includes(key)) ||
          typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version))
        throw failure('Each editor needs only its relative path and original version', 400);
      relativePath(value.path, showHidden);
      if (!(value.path === data.path || value.path.startsWith(data.path + '/')) || seen.has(value.path))
        throw failure('Only distinct affected editor paths may be supplied', 400);
      seen.add(value.path);
    }
  }
  if (data.action === 'delete' && data.root_path !== undefined &&
      (typeof data.root_path !== 'string' || !path.isAbsolute(data.root_path) || data.root_path.includes('\0')))
    throw failure('Canonical root_path is required', 400);
  if (data.action === 'delete' && data.confirmed !== true)
    throw failure('Deletion requires explicit confirmation', 400);
}

function mappedError(error) {
  if (error.status) return error;
  if (['ENOENT', 'ESTALE'].includes(error.code)) return conflict();
  if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) return failure('An entry already has that name, or directory contents changed; no overwrite is allowed', 409);
  if (['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS', 'EXDEV'].includes(error.code))
    return failure('Entry, root or parent directory is not safely writable', 403);
  if (['ENAMETOOLONG', 'EINVAL'].includes(error.code)) return failure('Invalid filename or path', 400);
  return failure(`Filesystem operation failed: ${error.message}`, 500);
}

// /proc/self/fd supplies Linux openat-style anchoring with Node's stdlib. Every
// parent is opened O_NOFOLLOW, and both its named inode and canonical mapping
// are checked again before mutations. Detached descriptors never follow an
// attacker's replacement link. Node has no renameat2(RENAME_NOREPLACE): root
// locks serialize cooperating processes, while final synchronous checks reduce
// (but cannot eliminate) races with unrelated external filesystem writers.
async function context(getBoundary, selectedBoundary) {
  const boundary = selectedBoundary ?? await getBoundary();
  const root = await fs.open(boundary, DIRECTORY);
  let rootInfo;
  try { rootInfo = await root.stat({ bigint: true }); }
  catch (error) { await root.close(); throw error; }
  const identities = new Map([['', id(rootInfo)]]);
  const ctx = { boundary, root, rootInfo, identities, getBoundary };
  ctx.verifySync = anchored => {
    if (realpathSync(boundary) !== boundary || id(lstatSync(boundary, { bigint: true })) !== id(rootInfo) ||
        realpathSync(`/proc/self/fd/${root.fd}`) !== boundary || id(fstatSync(root.fd, { bigint: true })) !== id(rootInfo)) throw conflict();
    for (const value of anchored?.parents || []) {
      const target = path.join(boundary, value.relative), info = lstatSync(target, { bigint: true });
      if (!info.isDirectory() || id(info) !== value.identity || id(fstatSync(value.file.fd, { bigint: true })) !== value.identity ||
          realpathSync(`/proc/self/fd/${value.file.fd}`) !== target || realpathSync(target) !== target) throw conflict();
    }
  };
  ctx.verify = async anchored => {
    if (await getBoundary() !== boundary) throw conflict();
    ctx.verifySync(anchored);
  };
  ctx.open = async relative => {
    const parents = [], handles = [];
    let current = root, prefix = '';
    try {
      for (const piece of parentOf(relative).split('/').filter(Boolean)) {
        prefix = joined(prefix, piece);
        current = await fs.open(`/proc/self/fd/${current.fd}/${piece}`, DIRECTORY);
        handles.push(current);
        const identity = id(await current.stat({ bigint: true }));
        if (identities.has(prefix) && identities.get(prefix) !== identity) throw conflict();
        identities.set(prefix, identity);
        parents.push({ relative: prefix, identity, file: current });
      }
      const anchored = { relative, parents, parent: `/proc/self/fd/${current.fd}`,
        target: `/proc/self/fd/${current.fd}/${path.posix.basename(relative)}`,
        async close() { for (const file of handles.reverse()) await file.close(); } };
      await ctx.verify(anchored);
      return anchored;
    } catch (error) { for (const file of handles.reverse()) await file.close(); throw error; }
  };
  try { await ctx.verify(); return ctx; }
  catch (error) { await root.close(); throw error; }
}

async function node(ctx, anchored) {
  const info = await fs.lstat(anchored.target, { bigint: true }), type = kind(info);
  if (!type) throw failure('Only regular files, directories and symlink leaves are supported', 403);
  const link = type === 'symlink' ? await fs.readlink(anchored.target, { encoding: 'buffer' }) : null;
  await ctx.verify(anchored);
  if (stamp(info) !== stamp(lstatSync(anchored.target, { bigint: true }))) throw conflict();
  return { relative: anchored.relative, info, kind: type, link };
}

function version(ctx, value) {
  return createHash('sha256').update(JSON.stringify([ctx.rootId, ctx.boundary, id(ctx.rootInfo), value.relative,
    value.kind, stamp(value.info), value.link])).digest('hex');
}

function checkNodeSync(ctx, anchored, expected, directoryIdentityOnly = false) {
  ctx.verifySync(anchored);
  const current = lstatSync(anchored.target, { bigint: true });
  if (kind(current) !== expected.kind || (directoryIdentityOnly ?
    id(current) !== id(expected.info) || current.mode !== expected.info.mode || current.uid !== expected.info.uid || current.gid !== expected.info.gid :
    stamp(current) !== stamp(expected.info))) throw conflict();
  if (expected.kind === 'symlink' && !readlinkSync(anchored.target, { encoding: 'buffer' }).equals(expected.link)) throw conflict();
}

// Never follow even a final symlink to manufacture response metadata. The next
// ordinary tree refresh can provide its usual link-target availability status.
function entry(value, relative, rootId) {
  const extension = path.extname(relative).toLowerCase(), link = value.kind === 'symlink';
  let category = Object.entries(TYPES).find(([, extensions]) => extensions.has(extension))?.[0] || 'text';
  if (category === 'text' && /^(image|audio|video)\//.test(mimeType(relative))) category = 'media';
  return { name: path.basename(relative), path: relative, root_id: rootId,
    kind: value.kind === 'directory' ? 'directory' : 'file', category,
    size: Number(value.info.size), mtime: Number(value.info.mtimeNs) / 1e9,
    symlink: link, available: !link,
    ...(link ? { link_target: value.link.toString('utf8'), unavailable_reason: 'Symlink target is not followed by filesystem actions' } : {}) };
}

async function resultEntry(ctx, relative, rootId) {
  const anchored = await ctx.open(relative);
  try { return entry(await node(ctx, anchored), relative, rootId); }
  finally { await anchored.close(); }
}

export async function filesystemInfo(getBoundary, relative, rootId, showHidden = false, selectedBoundary = null) {
  relativePath(relative, showHidden);
  let ctx, anchored;
  try {
    ctx = await context(getBoundary, selectedBoundary); ctx.rootId = rootId; anchored = await ctx.open(relative);
    const value = await node(ctx, anchored);
    return { root_id: rootId, path: relative, kind: value.kind, version: version(ctx, value), symlink: value.kind === 'symlink' };
  } catch (error) { throw mappedError(error); }
  finally { try { await anchored?.close(); } finally { await ctx?.root.close(); } }
}

async function inventory(ctx, relative) {
  const records = [], directories = new Set();
  async function walk(current, depth) {
    if (depth > MAX_DEPTH || records.length >= MAX_NODES) throw failure('Directory operation exceeds the bounded traversal limit (50,000 entries or 128 levels)', 413);
    let anchored = await ctx.open(current), directory;
    try {
      const value = await node(ctx, anchored);
      if (value.info.dev !== ctx.rootInfo.dev) throw failure('Directory operations cannot cross filesystem devices', 403);
      records.push(value);
      if (value.kind !== 'directory') return;
      if (directories.has(id(value.info))) throw failure('Directory aliases or cycles cannot be copied', 403);
      directories.add(id(value.info));
      directory = await fs.open(anchored.target, DIRECTORY);
      if (id(await directory.stat({ bigint: true })) !== id(value.info) ||
          await fs.realpath(`/proc/self/fd/${directory.fd}`) !== path.join(ctx.boundary, current)) throw conflict();
      ctx.identities.set(current, id(value.info));
      // Keep one directory fd per level, rather than retaining every ancestor
      // chain in every recursive call (which would use quadratic descriptors).
      await anchored.close(); anchored = null;
      const listing = await fs.opendir(`/proc/self/fd/${directory.fd}`);
      for await (const child of listing) await walk(joined(current, child.name), depth + 1);
      anchored = await ctx.open(current);
      await ctx.verify(anchored);
      checkNodeSync(ctx, anchored, value);
    } finally { try { await directory?.close(); } finally { await anchored?.close(); } }
  }
  await walk(relative, 0);
  return records;
}

async function validateInventory(ctx, records) {
  for (const value of records) {
    const anchored = await ctx.open(value.relative);
    try { await ctx.verify(anchored); checkNodeSync(ctx, anchored, value); }
    finally { await anchored.close(); }
  }
}

function copyName(name, type, attempt) {
  const extension = type === 'directory' ? '' : path.extname(name), stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem} copy${attempt === 1 ? '' : ` ${attempt}`}${extension}`;
}

async function hashFile(file, expectedSize) {
  const hash = createHash('sha256'), block = Buffer.allocUnsafe(256 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await file.read(block, 0, block.length, position);
    if (!bytesRead) {
      if (BigInt(position) !== expectedSize) throw conflict();
      return hash.digest('hex');
    }
    if (BigInt(position + bytesRead) > expectedSize) throw conflict();
    hash.update(block.subarray(0, bytesRead)); position += bytesRead;
  }
}

function directoryNamesMatch(target, expectedInfo, names) {
  const fd = openSync(target, DIRECTORY);
  let listing;
  try {
    if (id(fstatSync(fd, { bigint: true })) !== id(expectedInfo)) return false;
    listing = opendirSync(`/proc/self/fd/${fd}`);
    const remaining = new Set(names);
    for (;;) {
      const child = listing.readSync();
      if (!child) return remaining.size === 0;
      if (!remaining.delete(child.name)) return false;
    }
  } finally { try { listing?.closeSync(); } finally { closeSync(fd); } }
}

// Cleanup is deliberately conservative: verify the entire owned manifest,
// including exact directory children, before removing any artifact. A replaced,
// modified, hard-linked or unexpected node leaves the incomplete copy in place.
// The original destination parent fd remains open even if its path was moved.
function cleanupOwned(parent, owned) {
  const records = [...owned.values()];
  if (!records.length || records.some(value => !value.safe)) return false;
  const children = new Map();
  for (const value of records) {
    const parentRelative = parentOf(value.relative);
    if (!children.has(parentRelative)) children.set(parentRelative, []);
    children.get(parentRelative).push(path.basename(value.relative));
  }
  for (const names of children.values()) names.sort();
  const at = (relative, callback) => {
    const parts = relative.split('/'), name = parts.pop(), handles = [];
    let current = parent;
    try {
      let prefix = '';
      for (const piece of parts) {
        prefix = joined(prefix, piece);
        const fd = openSync(`${current}/${piece}`, DIRECTORY); handles.push(fd);
        const record = owned.get(prefix);
        if (!record || id(fstatSync(fd, { bigint: true })) !== id(record.info)) throw conflict();
        current = `/proc/self/fd/${fd}`;
      }
      return callback(`${current}/${name}`);
    } finally { for (const fd of handles.reverse()) closeSync(fd); }
  };
  try {
    for (const value of records) at(value.relative, target => {
      const info = lstatSync(target, { bigint: true });
      if (stamp(info) !== stamp(value.info) || (value.kind === 'file' && info.nlink !== 1n)) throw conflict();
      if (value.kind === 'symlink' && !readlinkSync(target, { encoding: 'buffer' }).equals(value.link)) throw conflict();
      if (value.kind === 'directory') {
        const expected = children.get(value.relative) || [];
        if (!directoryNamesMatch(target, info, expected)) throw conflict();
      }
    });
    // Matching directory snapshots detect additions/removals; every originally
    // created child is also independently matched above. No recursive rm.
    for (const value of records.reverse()) at(value.relative, target => {
      const info = lstatSync(target, { bigint: true });
      if (stamp(info) !== stamp(value.info)) throw conflict();
      if (value.kind === 'directory') rmdirSync(target); else unlinkSync(target);
      const parentRelative = parentOf(value.relative), parentRecord = owned.get(parentRelative);
      if (parentRecord) at(parentRelative, parentTarget => { parentRecord.info = lstatSync(parentTarget, { bigint: true }); });
    });
    return true;
  } catch { return false; }
}

async function duplicate(ctx, data, source, selected, showHidden, outputCtx = ctx, destinationParent = selected) {
  const records = await inventory(ctx, data.path);
  if (version(ctx, records[0]) !== data.expected_version) throw conflict();
  await validateInventory(ctx, records);
  const copying = data.action === 'copy';
  if (copying && source.kind === 'directory') {
    const ancestors = new Set([id(outputCtx.rootInfo), ...destinationParent.parents.map(value => value.identity)]);
    if (records.some(value => value.kind === 'directory' && ancestors.has(id(value.info))))
      throw failure('A directory cannot be copied into itself or one of its descendants or aliases', 403);
  }
  const parent = copying ? data.parent : parentOf(data.path), owned = new Map();
  let destination, destinationName;
  const track = (relative, target, type, link = null, file = null) => {
    const value = { relative, kind: type, link,
      info: file ? fstatSync(file.fd, { bigint: true }) : lstatSync(target, { bigint: true }), safe: true };
    owned.set(relative, value);
    if (kind(value.info) !== type || (file && (value.info.size !== 0n || value.info.nlink !== 1n)) ||
        (type === 'directory' && !directoryNamesMatch(target, value.info, [])) ||
        (type === 'symlink' && !readlinkSync(target, { encoding: 'buffer' }).equals(link))) {
      value.safe = false;
      throw conflict();
    }
    if (stamp(value.info) !== stamp(lstatSync(target, { bigint: true }))) throw conflict();
    return value;
  };
  const refreshParent = (relative, parentDescriptor) => {
    const parentRelative = parentOf(relative), value = owned.get(parentRelative);
    if (value) {
      const current = fstatSync(Number(path.basename(parentDescriptor)), { bigint: true });
      if (!current.isDirectory() || id(current) !== id(value.info) || current.mode !== value.info.mode ||
          current.uid !== value.info.uid || current.gid !== value.info.gid) throw conflict();
      value.info = current;
    }
  };
  try {
    for (let attempt = copying ? 0 : 1; attempt <= MAX_NODES; attempt++) {
      destinationName = attempt === 0 ? path.basename(data.path) : copyName(path.basename(data.path), source.kind, attempt);
      destination = joined(parent, destinationName);
      await ctx.verify(selected); checkNodeSync(ctx, selected, source);
      await outputCtx.verify(destinationParent);
      // No yield between checking both anchored mappings and an exclusive
      // creation. The client-provided absolute paths are never opened.
      ctx.verifySync(selected);
      const target = `${destinationParent.parent}/${destinationName}`;
      try {
        if (source.kind === 'directory') {
          mkdirSync(target, { mode: 0o700 }); track(destinationName, target, 'directory');
        } else if (source.kind === 'symlink') {
          // symlink is exclusive, unlike rename; target text is copied verbatim.
          symlinkSync(source.link, target); track(destinationName, target, 'symlink', source.link);
        } else {
          const file = await fs.open(target, NEW, 0o600);
          try { track(destinationName, target, 'file', null, file); } finally { await file.close(); }
        }
        break;
      } catch (error) { if (error.code === 'EEXIST') { destination = null; continue; } throw error; }
    }
    if (!destination) throw failure('No available copy name within the bounded naming limit', 409);
    for (const value of records) {
      const suffix = value.relative.slice(data.path.length), relative = destination + suffix,
        ownRelative = destinationName + suffix;
      let input, output, from, to;
      try {
        input = await ctx.open(value.relative); output = await outputCtx.open(relative);
        await ctx.verify(input); checkNodeSync(ctx, input, value);
        await outputCtx.verify(output); ctx.verifySync(input);
        if (suffix) {
          if (value.kind === 'directory') { mkdirSync(output.target, { mode: 0o700 }); track(ownRelative, output.target, 'directory'); }
          else if (value.kind === 'symlink') { symlinkSync(value.link, output.target); track(ownRelative, output.target, 'symlink', value.link); }
          else { to = await fs.open(output.target, NEW, 0o600); track(ownRelative, output.target, 'file', null, to); }
          refreshParent(ownRelative, output.parent);
        }
        const own = owned.get(ownRelative);
        if (value.kind === 'directory') {
          outputCtx.identities.set(relative, id(own.info));
        } else if (value.kind === 'file') {
          from = await fs.open(input.target, READ);
          to ??= await fs.open(output.target, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          if (stamp(await from.stat({ bigint: true })) !== stamp(value.info) ||
              stamp(await to.stat({ bigint: true })) !== stamp(own.info)) throw conflict();
          const hash = createHash('sha256'), block = Buffer.allocUnsafe(256 * 1024);
          let position = 0;
          for (;;) {
            const { bytesRead } = await from.read(block, 0, block.length, position);
            if (!bytesRead) break;
            if (BigInt(position + bytesRead) > value.info.size) throw conflict();
            own.safe = false;
            let written = 0;
            while (written < bytesRead) {
              const result = await to.write(block, written, bytesRead - written, position + written);
              if (!result.bytesWritten) throw failure('Copy made no write progress', 500);
              written += result.bytesWritten;
            }
            hash.update(block.subarray(0, bytesRead)); position += bytesRead;
          }
          const copied = hash.digest('hex');
          await to.chmod(Number(value.info.mode) & 0o777);
          const before = await to.stat({ bigint: true });
          if (await hashFile(to, value.info.size) !== copied || stamp(before) !== stamp(await to.stat({ bigint: true })) ||
              before.nlink !== 1n || id(before) !== id(own.info)) throw conflict();
          own.info = before; own.safe = true;
          await ctx.verify(input); checkNodeSync(ctx, input, value);
          if (BigInt(position) !== value.info.size || stamp(await from.stat({ bigint: true })) !== stamp(value.info)) throw conflict();
        }
        await outputCtx.verify(output);
        if (stamp(lstatSync(output.target, { bigint: true })) !== stamp(own.info)) throw conflict();
      } finally { try { await from?.close(); } finally { try { await to?.close(); } finally { try { await input?.close(); } finally { await output?.close(); } } } }
    }
    await validateInventory(ctx, records);
    // Apply directory permissions after filling children, including read-only
    // source directories. Do not propagate setuid/setgid bits to new copies.
    for (const value of [...records].reverse()) if (value.kind === 'directory') {
      const suffix = value.relative.slice(data.path.length), own = owned.get(destinationName + suffix),
        output = await outputCtx.open(destination + suffix);
      let directory;
      try {
        directory = await fs.open(output.target, DIRECTORY);
        if (stamp(await directory.stat({ bigint: true })) !== stamp(own.info)) throw conflict();
        await directory.chmod(Number(value.info.mode) & 0o777);
        own.info = await directory.stat({ bigint: true });
        await outputCtx.verify(output);
      } finally { try { await directory?.close(); } finally { await output.close(); } }
    }
    await ctx.verify(selected);
    await outputCtx.verify(destinationParent);
    const result = { root_id: data.root, path: destination, entry: await resultEntry(outputCtx, destination, data.root, showHidden) };
    await ctx.verify(selected); checkNodeSync(ctx, selected, source);
    return copying ? { ...result, source_root_id: data.source_root, source_path: data.path } : result;
  } catch (error) {
    const clean = cleanupOwned(destinationParent.parent, owned);
    const mapped = mappedError(error);
    if (!clean && owned.size) mapped.message += `; an incomplete copy may remain at ${destination || joined(parent, destinationName)} because its ownership or contents could not be verified for cleanup`;
    throw mapped;
  }
}

async function remove(ctx, data, selected, source) {
  const records = await inventory(ctx, data.path);
  if (version(ctx, records[0]) !== data.expected_version) throw conflict();
  await validateInventory(ctx, records);
  let removed = 0;
  try {
    for (const value of records.reverse()) {
      const anchored = await ctx.open(value.relative);
      try {
        await ctx.verify(anchored);
        checkNodeSync(ctx, anchored, value, value.kind === 'directory');
        if (value.kind === 'directory') rmdirSync(anchored.target); else unlinkSync(anchored.target);
        removed++;
      } finally { await anchored.close(); }
    }
    await ctx.verify(selected);
    return { root_id: data.root, path: data.path, deleted: true };
  } catch (error) {
    const mapped = mappedError(error);
    if (removed) mapped.partial = true;
    if (removed) mapped.message = `Deletion stopped after removing ${removed} entries; some selected contents may already be permanently deleted. ${mapped.message}`;
    throw mapped;
  }
}

async function copy(getBoundary, boundary, data, showHidden, options) {
  const getSource = options.getSourceBoundary ?? (data.source_root === data.root ? getBoundary : null);
  if (!getSource) throw failure('A registered source root is required', 400);
  let sourceBoundary, destinationInfo;
  try {
    sourceBoundary = options.sourceBoundary ?? await getSource();
    if (data.root_path !== boundary || data.source_root_path !== sourceBoundary) throw conflict();
    destinationInfo = await fs.lstat(boundary, { bigint: true });
    return await withFilesystemLocks([boundary, sourceBoundary], async () => {
      let sourceCtx, destinationCtx, selected, destinationParent;
      try {
        sourceCtx = await context(getSource, sourceBoundary); sourceCtx.rootId = data.source_root;
        destinationCtx = await context(getBoundary, boundary); destinationCtx.rootId = data.root;
        if (id(destinationCtx.rootInfo) !== id(destinationInfo)) throw conflict();
        selected = await sourceCtx.open(data.source_path);
        const source = await node(sourceCtx, selected);
        if (version(sourceCtx, source) !== data.expected_version) throw conflict();
        // A synthetic final component anchors and validates the selected parent
        // itself, including an empty parent denoting the registered root.
        destinationParent = await destinationCtx.open(joined(data.parent, '__copy_parent__'));
        if (source.kind === 'directory') {
          const sourcePath = path.join(sourceBoundary, data.source_path), targetParent = path.join(boundary, data.parent);
          if (targetParent === sourcePath || targetParent.startsWith(sourcePath + path.sep) ||
              [id(destinationCtx.rootInfo), ...destinationParent.parents.map(value => value.identity)].includes(id(source.info)))
            throw failure('A directory cannot be copied into itself or one of its descendants or aliases', 403);
        }
        const parentInfo = fstatSync(Number(path.basename(destinationParent.parent)), { bigint: true });
        if (!(parentInfo.mode & 0o222n)) throw failure('Destination directory is read-only', 403);
        await fs.access(destinationParent.parent, constants.W_OK | constants.X_OK);
        return await duplicate(sourceCtx, { ...data, path: data.source_path }, source, selected, showHidden,
          destinationCtx, destinationParent);
      } finally {
        try { await selected?.close(); } finally {
          try { await destinationParent?.close(); } finally {
            try { await sourceCtx?.root.close(); } finally { await destinationCtx?.root.close(); }
          }
        }
      }
    });
  } catch (error) { throw mappedError(error); }
}

export async function filesystemAction(getBoundary, data, showHidden = false, selectedBoundary = null, project = null, options = {}) {
  validate(data, showHidden);
  const boundary = selectedBoundary ?? await getBoundary();
  if ((data.action === 'move' || data.action === 'delete' && data.root_path !== undefined) && data.root_path !== boundary) throw conflict();
  if (data.action === 'copy') return copy(getBoundary, boundary, data, showHidden, options);
  return withFilesystemLock(boundary, async () => {
    let ctx, selected, destination;
    try {
      ctx = await context(getBoundary, boundary); ctx.rootId = data.root;
      const relative = data.action === 'mkdir' ? joined(data.parent, data.name) : data.path;
      selected = await ctx.open(relative);
      if (data.action === 'mkdir') {
        await ctx.verify(selected);
        mkdirSync(selected.target, { mode: 0o777 });
        const created = trackCreatedDirectory(selected.target);
        try {
          await ctx.verify(selected);
          if (stamp(lstatSync(selected.target, { bigint: true })) !== stamp(created)) throw conflict();
          return { root_id: data.root, path: relative, entry: await resultEntry(ctx, relative, data.root, showHidden) };
        } catch (error) {
          // Only the exact unmodified empty directory is safe to undo.
          let cleaned = false;
          try { if (stamp(lstatSync(selected.target, { bigint: true })) === stamp(created)) { rmdirSync(selected.target); cleaned = true; } } catch {}
          if (!cleaned) error.message += `; creation may have completed at ${relative}, and the entry was retained because safe cleanup could not be verified`;
          throw error;
        }
      }
      const source = await node(ctx, selected);
      if (version(ctx, source) !== data.expected_version) throw conflict();
      if (data.action === 'duplicate') return await duplicate(ctx, data, source, selected, showHidden);
      if (data.action === 'delete') return await remove(ctx, data, selected, source);
      const moving = data.action === 'move';
      const next = moving ? joined(data.parent, path.posix.basename(data.path)) : joined(parentOf(data.path), data.name);
      if (next === data.path) throw failure('Choose a different name', 409);
      if (moving && source.kind === 'directory' && (data.parent === data.path || data.parent.startsWith(data.path + '/')))
        throw failure('A directory cannot be moved into itself or one of its descendants', 403);
      if (moving) destination = await ctx.open(next);
      if (source.kind !== 'directory' && (data.editors || []).some(value => value.path !== data.path))
        throw failure('A file or symlink cannot contain child editors', 400);
      return await relocateEditors(getBoundary, data.path, next, data.editors || [], async () => {
        await ctx.verify(selected); checkNodeSync(ctx, selected, source);
        if (destination) { await ctx.verify(destination); checkNodeSync(ctx, selected, source); }
        const target = destination ? destination.target : `${selected.parent}/${data.name}`;
        try { lstatSync(target); throw failure('An entry already has that name; no overwrite is allowed', 409); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        // No async yield between the final guard and rename. Independent
        // external programs remain outside our advisory application locks.
        renameSync(selected.target, target);
        // Metadata failure after this point must not disguise a committed
        // rename as a rejection. Editor proof runs independently afterwards.
        let renamed = source;
        try { renamed = { ...source, info: lstatSync(target, { bigint: true }) }; } catch {}
        return { root_id: data.root, old_path: data.path, path: next, entry: entry(renamed, next, data.root) };
      }, showHidden, project ?? boundary, data.root);
    } catch (error) { throw mappedError(error); }
    finally { try { await selected?.close(); } finally { try { await destination?.close(); } finally { await ctx?.root.close(); } } }
  });
}

function trackCreatedDirectory(target) { return lstatSync(target, { bigint: true }); }
