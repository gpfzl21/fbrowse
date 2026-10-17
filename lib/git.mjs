import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { inside, visible } from './files.mjs';

const STATUS_LIMIT = 2 * 1024 * 1024;
const DIFF_LIMIT = 1024 * 1024;
const TEXT_LIMIT = 128 * 1024;
const ENTRY_LIMIT = 10000;
const TTL = 2000;

// Ignore all inherited Git overrides, including injected config, alternate object
// stores, replacement objects, tracing, index files and executable helpers.
function environment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C' };
}

function run(cwd, args, deadline, limit = STATUS_LIMIT, accepted = [0], overrides = []) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(Object.assign(new Error(), { reason: 'timeout' }));
    const child = spawn('git', ['--no-optional-locks', '--literal-pathspecs',
      '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.untrackedCache=false', '-c', 'core.preloadIndex=false',
      '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=',
      '-c', 'protocol.allow=never', '-c', 'submodule.recurse=false', ...overrides, ...args],
    { cwd, env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const blocks = [];
    let size = 0, stderrSize = 0, truncated = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, remaining);
    child.stdout.on('data', block => {
      const room = limit - size;
      if (room > 0) { blocks.push(block.subarray(0, room)); size += Math.min(room, block.length); }
      if (block.length > room) { truncated = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', block => {
      stderrSize += block.length;
      if (stderrSize > 65536) child.kill('SIGKILL');
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(Object.assign(new Error(), { reason: error.code === 'ENOENT' ? 'git_unavailable' : 'error' }));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(Object.assign(new Error(), { reason: 'timeout' }));
      const result = { output: Buffer.concat(blocks), truncated, code };
      if (!truncated && !accepted.includes(code)) return reject(Object.assign(new Error(), { reason: 'error', exitCode: code }));
      resolve(result);
    });
  });
}

const messages = { not_repository: 'This folder is not a Git repository.',
  git_unavailable: 'Git is not installed or is unavailable.', timeout: 'Git response timed out.',
  error: 'Git information is temporarily unavailable.' };
function unavailable(reason = 'error') {
  return { available: false, reason, message: messages[reason] || messages.error,
    branch: null, detached: false, entries: [], truncated: false };
}
function validPath(relative) {
  return typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') &&
    !relative.includes('\0') && !path.isAbsolute(relative) &&
    relative.split('/').every(part => part && part !== '.' && part !== '..') && visible(relative, true);
}
async function checkRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || await fs.realpath(root) !== root ||
      !(await fs.lstat(root)).isDirectory()) throw new Error('Invalid root');
}
async function repository(root, deadline) {
  await checkRoot(root);
  let result;
  try { result = await run(root, ['rev-parse', '--show-toplevel'], deadline); }
  catch (error) {
    if (error.exitCode === 128) error.reason = 'not_repository';
    throw error;
  }
  const top = result.output.toString('utf8').replace(/\n$/, '');
  if (result.truncated || !path.isAbsolute(top) || !inside(top, root)) throw new Error('Invalid repository');
  return top;
}

async function disabledFilters(root, deadline) {
  // Porcelain status may hash modified files through clean/process filters. Read
  // names only, then override each driver's entire configuration for this call.
  const result = await run(root, ['config', '--null', '--name-only', '--get-regexp',
    '^filter\\..*\\.(clean|smudge|process|required)$'], deadline, 65536, [0, 1]);
  if (result.truncated) throw new Error('Too many filter definitions');
  const prefixes = new Set(result.output.toString('utf8').split('\0').filter(Boolean)
    .map(key => key.replace(/\.(clean|smudge|process|required)$/i, '')));
  return [...prefixes].flatMap(prefix => ['clean', 'smudge', 'process', 'required']
    .flatMap(key => ['-c', `${prefix}.${key}=${key === 'required' ? 'false' : ''}`]));
}

function relativeEntry(top, root, name) {
  if (!name || path.isAbsolute(name) || name.includes('\0')) return null;
  const target = path.resolve(top, name);
  if (!inside(root, target)) return null;
  const relative = path.relative(root, target).split(path.sep).join('/');
  return validPath(relative) ? relative : null;
}
function parseStatus(output, top, root) {
  // Never parse the final partial record after an output-limit kill.
  const records = output.subarray(0, output.lastIndexOf(0) + 1).toString('utf8').split('\0');
  records.pop();
  let branch = null, detached = false, truncated = false;
  const entries = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith('## ')) {
      const name = record.slice(3);
      detached = name.startsWith('HEAD (');
      branch = detached ? null : name.replace(/^(?:No commits yet on |Initial commit on )/, '').split('...')[0];
      continue;
    }
    if (record.length < 4 || record[2] !== ' ') continue;
    const index = record[0], worktree = record[1];
    const renamed = index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C';
    const original = renamed ? records[++i] : undefined;
    if (renamed && original === undefined) break;
    const relative = relativeEntry(top, root, record.slice(3));
    if (!relative || index === '!') continue;
    if (entries.length >= ENTRY_LIMIT) { truncated = true; break; }
    const conflict = index === 'U' || worktree === 'U' || ['AA', 'DD'].includes(index + worktree);
    const untracked = index === '?' && worktree === '?';
    const status = conflict ? '!' : untracked ? 'U' :
      ['D', 'R', 'C', 'M', 'A', 'T'].find(char => index === char || worktree === char) || 'M';
    const entry = { path: relative, index, worktree, status, untracked, conflict };
    const originalPath = renamed && relativeEntry(top, root, original);
    if (originalPath) entry.original_path = originalPath;
    entries.push(entry);
  }
  return { available: true, reason: null, message: null, branch, detached, entries, truncated };
}

async function readStatus(root, deadline, top) {
  top ||= await repository(root, deadline);
  const filters = await disabledFilters(root, deadline);
  const result = await run(root, ['status', '--porcelain=v1', '-z', '--branch',
    '--untracked-files=all', '--ignore-submodules=all', '--', '.'], deadline, STATUS_LIMIT, [0], filters);
  await checkRoot(root);
  const value = parseStatus(result.output, top, root);
  value.truncated ||= result.truncated;
  if (filters.length) value.message = 'Git filters are disabled for safety. Filtered files may differ from normal Git status and are compared using raw content.';
  return value;
}

// Walk anchored directory descriptors without following any parent symlink. A
// final symlink is read with readlink, including broken/outside-root links.
async function workingContent(root, relative, limit) {
  await checkRoot(root);
  const handles = [];
  const verify = async (handle, expected) => {
    if (await fs.realpath(`/proc/self/fd/${handle.fd}`) !== expected) throw new Error('Path changed');
  };
  try {
    let expected = root;
    let directory = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(directory);
    await verify(directory, expected);
    const parts = relative.split('/');
    for (const component of parts.slice(0, -1)) {
      expected = path.join(expected, component);
      try { directory = await fs.open(`/proc/self/fd/${directory.fd}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error.code === 'ELOOP' || error.code === 'ENOTDIR') error.linkParent = true;
        throw error;
      }
      handles.push(directory);
      await verify(directory, expected);
    }
    const leaf = `/proc/self/fd/${directory.fd}/${parts.at(-1)}`;
    let info;
    try { info = await fs.lstat(leaf); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let data, truncated = false;
    if (info.isSymbolicLink()) data = Buffer.from(await fs.readlink(leaf));
    else {
      if (!info.isFile()) throw new Error('Not a regular file');
      const file = await fs.open(leaf, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      handles.push(file);
      if (!(await file.stat()).isFile()) throw new Error('Not a regular file');
      await verify(file, path.join(root, relative));
      const buffer = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      data = buffer.subarray(0, Math.min(size, limit));
      truncated = size > limit;
      await verify(file, path.join(root, relative));
    }
    // Discard captured data if any anchored ancestor moved while it was read.
    for (let i = 0; i < parts.length; i++) await verify(handles[i], path.join(root, ...parts.slice(0, i)));
    await checkRoot(root);
    return { data, truncated, mode: info.isSymbolicLink() ? '120000' : (info.mode & 0o111) ? '100755' : '100644' };
  } finally { await Promise.all(handles.map(handle => handle.close())); }
}
async function indexEntries(top, name, deadline) {
  const result = await run(top, ['ls-files', '--stage', '--full-name', '-z', '--', name], deadline);
  if (result.truncated) throw new Error('Index response too large');
  return result.output.toString('utf8').split('\0').flatMap(record => {
    const match = /^(\d+) ([0-9a-f]+) ([0-3])\t([\s\S]*)$/.exec(record);
    return match && match[4] === name ? [{ mode: match[1], oid: match[2], stage: Number(match[3]) }] : [];
  });
}
async function headEntry(top, name, deadline) {
  const result = await run(top, ['ls-tree', '-z', 'HEAD', '--', name], deadline, STATUS_LIMIT, [0, 128]);
  if (result.truncated) throw new Error('Tree response too large');
  for (const record of result.output.toString('utf8').split('\0')) {
    const match = /^(\d+) blob ([0-9a-f]+)\t([\s\S]*)$/.exec(record);
    if (match && match[3] === name) return { mode: match[1], oid: match[2] };
  }
  return null;
}
async function blob(top, entry, deadline) {
  if (!entry) return null;
  if (!['100644', '100755', '120000'].includes(entry.mode)) throw new Error('Unsupported Git entry');
  const result = await run(top, ['cat-file', 'blob', entry.oid], deadline, DIFF_LIMIT);
  return { data: result.output, truncated: result.truncated, mode: entry.mode };
}
function binary(data, truncated = false) {
  if (data.includes(0)) return true;
  try { new TextDecoder('utf-8', { fatal: true }).decode(data, { stream: truncated }); return false; } catch { return true; }
}

export function createGitService() {
  const cache = new Map();
  async function status(root, { refresh = false } = {}) {
    const existing = cache.get(root);
    if (existing?.pending || (!refresh && existing && Date.now() - existing.time < TTL)) return existing.promise;
    const item = { pending: true, time: 0 };
    item.promise = (async () => {
      try { return await readStatus(root, Date.now() + 5000); }
      catch (error) { return unavailable(error.reason); }
      finally { item.pending = false; item.time = Date.now(); }
    })();
    cache.set(root, item);
    if (cache.size > 128) {
      for (const [key, value] of cache) {
        if (key !== root && !value.pending) cache.delete(key);
        if (cache.size <= 128) break;
      }
    }
    return item.promise;
  }

  async function diff(root, relative, { staged = false } = {}) {
    const base = { path: relative, staged: Boolean(staged), kind: 'unavailable', text: '', truncated: false, message: null };
    if (!validPath(relative)) return { ...base, message: 'The path is outside the root or is excluded.' };
    let temporary;
    try {
      const deadline = Date.now() + 5000;
      const top = await repository(root, deadline);
      const name = path.relative(top, path.join(root, relative)).split(path.sep).join('/');
      const indexed = await indexEntries(top, name, deadline);
      const index = indexed.find(entry => entry.stage === 0);
      if (staged && indexed.length && !index) return { ...base, message: 'Resolve file conflicts before viewing staged changes.' };
      // Verify every parent even for staged/deleted paths, without following the leaf.
      const current = await workingContent(root, relative, index || staged ? DIFF_LIMIT : TEXT_LIMIT);
      if (!staged && indexed.length === 0) {
        const head = await headEntry(top, name, deadline);
        if (!head && current) {
          const others = await run(top, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', name], deadline);
          if (others.truncated || !others.output.toString('utf8').split('\0').includes(name)) {
            return { ...base, message: 'Git ignores this file or the path is untracked.' };
          }
          if (binary(current.data, current.truncated)) return { ...base, kind: 'binary', message: 'Binary files cannot be previewed as text.' };
          return { ...base, kind: 'text', text: new TextDecoder().decode(current.data, { stream: current.truncated }), truncated: current.truncated,
            message: current.truncated ? 'File preview was truncated due to the size limit.' : null };
        }
      }
      let oldEntry, newEntry, original;
      if (staged) {
        oldEntry = await headEntry(top, name, deadline);
        if (!oldEntry && index) {
          const value = await readStatus(root, deadline, top);
          original = value.entries.find(entry => entry.path === relative && entry.index === 'R')?.original_path;
          if (original) oldEntry = await headEntry(top, path.relative(top, path.join(root, original)), deadline);
        }
        newEntry = index;
      } else oldEntry = index || indexed.find(entry => entry.stage === 2);
      const oldContent = await blob(top, oldEntry, deadline);
      const newContent = staged ? await blob(top, newEntry, deadline) : current;
      if (!oldContent && !newContent) return { ...base, kind: 'empty', message: 'This file has no changes.' };
      if ([oldContent, newContent].some(content => content && binary(content.data, content.truncated))) {
        return { ...base, kind: 'binary', message: 'Text changes cannot be displayed for binary files.' };
      }
      // Never present a diff of partial inputs as if it described the whole file.
      if (oldContent?.truncated || newContent?.truncated) return { ...base, kind: 'diff', truncated: true,
        message: 'The file is too large to display all changes.' };
      let metadata = '';
      if (original) metadata += `rename from ${JSON.stringify(original)}\nrename to ${JSON.stringify(relative)}\n`;
      if (!oldContent) metadata += `new file mode ${newContent.mode}\n`;
      else if (!newContent) metadata += `deleted file mode ${oldContent.mode}\n`;
      else if (oldContent.mode !== newContent.mode) metadata += `old mode ${oldContent.mode}\nnew mode ${newContent.mode}\n`;
      if ((oldContent?.data || Buffer.alloc(0)).equals(newContent?.data || Buffer.alloc(0)) && !metadata) {
        return { ...base, kind: 'empty', message: 'This file has no changes.' };
      }
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-git-'));
      await fs.writeFile(path.join(temporary, 'old'), oldContent?.data || Buffer.alloc(0), { mode: 0o600 });
      await fs.writeFile(path.join(temporary, 'new'), newContent?.data || Buffer.alloc(0), { mode: 0o600 });
      const result = await run(temporary, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color',
        '--no-renames', '--', 'old', 'new'], deadline, DIFF_LIMIT, [0, 1]);
      let body = result.output.toString('utf8');
      const hunk = body.indexOf('@@');
      body = hunk < 0 ? '' : body.slice(hunk);
      const label = value => JSON.stringify(value);
      const header = `diff --git ${label('a/' + relative)} ${label('b/' + relative)}\n${metadata}`;
      const labels = body ? `--- ${oldContent ? label('a/' + (original || relative)) : '/dev/null'}\n+++ ${newContent ? label('b/' + relative) : '/dev/null'}\n` : '';
      const text = Buffer.from(header + labels + body);
      return { ...base, kind: 'diff', text: new TextDecoder().decode(text.subarray(0, DIFF_LIMIT), { stream: text.length > DIFF_LIMIT }),
        truncated: result.truncated || text.length > DIFF_LIMIT,
        message: result.truncated || text.length > DIFF_LIMIT ? 'Changes were truncated due to the size limit.' : null };
    } catch (error) { return { ...base, message: messages[error.reason] || (error.linkParent ?
      'Git changes through symbolic link folders are unsupported. Preview the file or select its original path. The Git status of a link belongs to the link itself.' :
      'File changes are unavailable or the path is outside the allowed root.') }; }
    finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {}); }
  }
  return { status, diff };
}
