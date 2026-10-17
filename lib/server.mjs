import http from 'node:http';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { readConfig, changeRoot, atomicJson } from './storage.mjs';
import { preparePdfjs, textAsset, MATH_ASSETS } from './assets.mjs';
import { resolvePath, openFile, listedEntry, entryOrder, textPreview, visible, TYPES, mimeType, failure } from './files.mjs';
import { readEditor, saveEditor, setEditorView, MAX_EDITOR_BYTES } from './editor.mjs';
import { createFile } from './create-file.mjs';
import { filesystemAction, filesystemInfo } from './filesystem-actions.mjs';
import { createDiagnosticsService, MAX_DIAGNOSTIC_BYTES } from './diagnostics.mjs';

const PUBLIC = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const SERVICE = 'project-file-browser';
const VERSION = '0.10.3';

function tokenMatches(actual, expected) {
  return typeof actual === 'string' && Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function respond(response, status, body, type, head = false, extra = {}) {
  if (response.destroyed || response.headersSent) return;
  body = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  response.end(head ? undefined : body);
}

function json(response, value, head = false, status = 200) {
  respond(response, status, JSON.stringify(value), 'application/json; charset=utf-8', head);
}

async function requestJson(request, maximum = 16384, sizeStatus = 400) {
  const length = Number(request.headers['content-length']);
  if (!Number.isInteger(length) || length <= 0) throw failure('Invalid request size', 400);
  if (length > maximum) throw failure('Request exceeds size limit', sizeStatus);
  const blocks = [];
  let size = 0;
  for await (const block of request) {
    size += block.length;
    if (size > maximum) throw failure('Request exceeds size limit', sizeStatus);
    blocks.push(block);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(blocks).toString('utf8')); }
  catch { throw failure('Invalid configuration request', 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('Invalid configuration request', 400);
  return data;
}

async function streamFile(request, response, boundary, relative, showHidden, document = false) {
  const { file, info, target } = await openFile(boundary, relative, showHidden);
  try {
    const size = info.size;
    let start = 0, end = size - 1, status = 200;
    const requested = request.headers.range;
    if (requested) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(requested.trim());
      let valid = Boolean(match && (match[1] || match[2]) && size > 0);
      if (valid) {
        // BigInt keeps absurd client offsets exact without overflowing JavaScript numbers.
        const total = BigInt(size), first = match[1] ? BigInt(match[1]) : null,
          last = match[2] ? BigInt(match[2]) : null;
        const a = first ?? (total > last ? total - last : 0n);
        const b = first === null || last === null || last >= total ? total - 1n : last;
        valid = a <= b && a < total;
        if (valid) { start = Number(a); end = Number(b); status = 206; }
      }
      if (!valid) {
        respond(response, 416, '', 'text/plain', request.method === 'HEAD', { 'Content-Range': `bytes */${size}` });
        return;
      }
    }
    let mime = mimeType(target);
    if (mime.startsWith('text/')) mime += '; charset=utf-8';
    const headers = { 'Content-Type': mime, 'Content-Length': Math.max(0, end - start + 1),
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Last-Modified': info.mtime.toUTCString() };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    if (document && ['text/html', 'application/xhtml+xml', 'image/svg+xml'].includes(mime.split(';')[0]))
      headers['Content-Security-Policy'] = "script-src 'none'; object-src 'none'; frame-src 'none'";
    response.writeHead(status, headers);
    if (request.method === 'HEAD' || size === 0) response.end();
    else await pipeline(file.createReadStream({ start, end, autoClose: false, highWaterMark: 256 * 1024 }), response);
  } finally { await file.close(); }
}

async function browseFolders(project, requested, showHidden) {
  let directory = project;
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== 'string' || !requested || requested.includes('\0')) throw new Error('서버의 폴더 경로를 입력하세요.');
    if (requested === '~' || requested.startsWith('~/')) requested = path.join(os.homedir(), requested.slice(2));
    if (!path.isAbsolute(requested)) throw new Error('서버의 절대 경로를 입력하세요.');
    directory = await fs.realpath(requested);
  }
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('폴더를 선택하세요.');
  const counts = { directory: 0, file: 0 }, entries = [];
  let sorted = false;
  const listing = await fs.opendir(directory);
  for await (const child of listing) {
    if (!showHidden && child.name.startsWith('.')) continue;
    try {
      const childPath = path.join(directory, child.name), stat = await fs.stat(childPath);
      let record;
      if (stat.isDirectory()) {
        const target = await fs.realpath(childPath);
        let readable = true;
        try { await fs.access(target, constants.R_OK | constants.X_OK); } catch { readable = false; }
        record = { name: child.name, kind: 'directory', path: target, readable, symlink: child.isSymbolicLink() };
      } else if (stat.isFile()) record = { name: child.name, kind: 'file' };
      else continue;
      counts[record.kind]++;
      // Keep only the smallest 2000 records, bounding memory for huge directories.
      if (entries.length < 2000) entries.push(record);
      else {
        if (!sorted) { entries.sort(entryOrder); sorted = true; }
        if (entryOrder(record, entries[1999]) < 0) {
          entries[1999] = record;
          entries.sort(entryOrder);
        }
      }
    } catch {}
  }
  entries.sort(entryOrder);
  const places = [];
  for (const [name, location] of [['프로젝트', project], ['홈', os.homedir()], ['/mnt', '/mnt'], ['/media', '/media'], ['파일시스템 /', '/']]) {
    try { if ((await fs.stat(location)).isDirectory()) places.push({ name, path: location }); } catch {}
  }
  return { path: directory, parent: path.dirname(directory), name: path.basename(directory) || '/', entries, counts,
    truncated: counts.directory + counts.file > entries.length, places };
}

export async function startServer({ root, host = '127.0.0.1', port = 0, showHidden = false, pdfjs = true, stateFile = null } = {}) {
  root = await fs.realpath(root || process.cwd());
  if (!(await fs.stat(root)).isDirectory()) throw new Error('--root must be an existing directory');
  let pdfjsRoot = null;
  if (pdfjs) {
    try { pdfjsRoot = await preparePdfjs(); }
    catch (error) { console.error(`PDF.js unavailable: ${error.message}. Falling back to native PDF viewer.`); }
  }
  const instanceId = randomUUID().replaceAll('-', ''), configToken = randomUUID().replaceAll('-', '');
  const diagnostics = createDiagnosticsService();
  async function records() {
    return { project: { name: path.basename(root), path: root }, ...await readConfig(root) };
  }
  async function rootInfo() {
    const result = [];
    for (const [id, record] of Object.entries(await records())) {
      let connected = false;
      try {
        connected = (await fs.stat(record.path)).isDirectory() && await fs.realpath(record.path) === record.path;
        await fs.access(record.path, constants.R_OK | constants.X_OK);
      } catch { connected = false; }
      result.push({ id, ...record, connected });
    }
    return result;
  }
  async function rootPath(id) {
    const roots = await records();
    if (!Object.hasOwn(roots, id)) throw failure('Unknown root');
    return roots[id].path;
  }
  let index = null, indexing = null, indexRevision = 0;
  let gitService;
  const git = () => gitService ??= import('./git.mjs').then(({ createGitService }) => createGitService());
  let gitActions;
  const actions = () => gitActions ??= import('./git-actions.mjs').then(({ createGitActions }) => createGitActions({ showHidden }));
  async function search(query, kind, refresh, rootId) {
    let roots = await records();
    if (rootId !== null && !Object.hasOwn(roots, rootId)) throw failure('Unknown root');
    if (rootId !== null) roots = { [rootId]: roots[rootId] };
    const signature = JSON.stringify([roots, indexRevision]);
    if (refresh || !index || index.signature !== signature || Date.now() - index.time > 5000) {
      if (!indexing) indexing = (async () => {
        const entries = [];
        let skipped = 0;
        for (const [id, record] of Object.entries(roots)) {
          const boundary = record.path;
          try { await resolvePath(boundary, '', showHidden); }
          catch { skipped++; continue; }
          const pending = [''];
          while (pending.length) {
            const relative = pending.pop();
            let children;
            try {
              const directory = await resolvePath(boundary, relative, showHidden);
              children = await fs.readdir(directory, { withFileTypes: true });
            } catch { skipped++; continue; }
            children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
            const directories = [];
            for (const child of children) {
              const childRelative = path.posix.join(relative, child.name);
              if (!visible(childRelative, showHidden)) continue;
              if (child.isDirectory()) directories.push(childRelative);
              else {
                try {
                  const value = await listedEntry(boundary, childRelative, id, showHidden);
                  if (value.kind === 'file') entries.push(value);
                } catch {}
              }
            }
            pending.push(...directories.reverse());
          }
        }
        index = { entries, skipped, signature, time: Date.now() };
      })().finally(() => { indexing = null; });
      await indexing;
      // A concurrent configuration change must not reuse an index for a different root set.
      if (!index || index.signature !== signature) return search(query, kind, true, rootId);
    }
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = index.entries.filter(value => (rootId === null || value.root_id === rootId) &&
      terms.every(term => value.path.toLowerCase().includes(term)) &&
      (!Object.hasOwn(TYPES, kind) || TYPES[kind].has(path.extname(value.name).toLowerCase())));
    return { entries: matches.slice(0, 500), total: matches.length, skipped: index.skipped };
  }
  let info, closePromise;
  const server = http.createServer(async (request, response) => {
    const head = request.method === 'HEAD';
    try {
      // Parse the raw path before URL normalization can erase encoded traversal segments.
      const question = request.url.indexOf('?');
      const rawPath = question < 0 ? request.url : request.url.slice(0, question);
      const pathname = decodeURIComponent(rawPath);
      const query = new URLSearchParams(question < 0 ? '' : request.url.slice(question + 1));
      const relative = query.get('path') || '', rootId = query.get('root') || 'project';
      if (request.method === 'POST') {
        const gitAction = /^\/api\/git\/(stage|unstage|commit|push)$/.exec(pathname)?.[1];
        const editorAction = ['/api/save', '/api/view-state'].includes(pathname);
        const createAction = pathname === '/api/create';
        const filesystem = pathname === '/api/fs';
        const diagnosticAction = pathname === '/api/diagnostics';
        if (!gitAction && !editorAction && !createAction && !filesystem && !diagnosticAction && !['/api/roots', '/api/folders', '/api/shutdown'].includes(pathname)) {
          json(response, { error: 'Unknown endpoint' }, false, 404); return;
        }
        if (!tokenMatches(request.headers['x-fbrowse-token'], configToken)) {
          json(response, { error: 'Invalid configuration token' }, false, 403); return;
        }
        try {
          const origin = request.headers.origin;
          if ((gitAction || editorAction || createAction || filesystem || diagnosticAction) && (request.headers['sec-fetch-site'] === 'cross-site' ||
              (origin !== undefined && origin !== new URL('http://' + request.headers.host).origin)))
            throw failure('Use the same fbrowse origin for this action', 403);
          if (diagnosticAction) {
            const authority = new URL('http://' + request.headers.host), address = server.address();
            const hostname = value => value.includes(':') && !value.startsWith('[') ? `[${value.toLowerCase()}]` : value.toLowerCase();
            const hostnames = new Set([hostname(host), hostname(address.address)]);
            if (['0.0.0.0', '::'].includes(address.address) && request.socket.localAddress)
              hostnames.add(hostname(request.socket.localAddress));
            if ([address.address, request.socket.localAddress].some(value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value))) {
              hostnames.add('localhost'); hostnames.add('127.0.0.1'); hostnames.add('[::1]');
            }
            if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash ||
                !hostnames.has(authority.hostname.toLowerCase()) || Number(authority.port || 80) !== address.port)
              throw failure('Use the listening fbrowse Host for this action', 403);
          }
          // JSON may escape each input byte as six characters. The decoded
          // editor text and its original-encoding output are each capped at 8 MiB.
          const data = await requestJson(request, pathname === '/api/save' ? MAX_EDITOR_BYTES * 6 + 65536 :
            diagnosticAction ? MAX_DIAGNOSTIC_BYTES * 6 + 65536 :
            gitAction || filesystem ? 128 * 1024 : 16384, editorAction || diagnosticAction ? 413 : 400);
          if (diagnosticAction) {
            if (typeof data.root !== 'string' || !data.root) throw failure('An explicit root is required', 400);
            const controller = new AbortController();
            const abort = () => { if (!response.writableEnded) controller.abort(); };
            request.on('aborted', abort);
            response.on('close', abort);
            try {
              const result = await diagnostics.check(() => rootPath(data.root).catch(() => {
                throw failure('Root mapping changed; reload before checking', 409);
              }), data, { showHidden, project: root, signal: controller.signal });
              json(response, result);
            } finally {
              request.off('aborted', abort);
              response.off('close', abort);
            }
          } else if (filesystem) {
            if (typeof data.root !== 'string' || !data.root) throw failure('An explicit root is required', 400);
            const boundary = await rootPath(data.root);
            let sourceBoundary;
            if (data.action === 'copy') {
              if (typeof data.source_root !== 'string' || !data.source_root) throw failure('An explicit source_root is required', 400);
              sourceBoundary = await rootPath(data.source_root);
            }
            try {
              const result = await filesystemAction(() => rootPath(data.root).catch(() => {
                throw failure('Root mapping changed; refresh before trying again', 409);
              }), data, showHidden, boundary, root, { sourceBoundary,
                getSourceBoundary: () => rootPath(data.source_root).catch(() => {
                  throw failure('Source root mapping changed; refresh before trying again', 409);
                }) });
              json(response, result, false, ['mkdir', 'duplicate', 'copy'].includes(data.action) ? 201 : 200);
            } finally {
              // A recursive delete can fail after partially removing contents.
              // Invalidate even on error so search/Git cannot hide that outcome.
              indexRevision++;
              index = null;
              gitService = null;
            }
          } else if (createAction) {
            if (Object.keys(data).some(key => !['root', 'parent', 'name'].includes(key)) ||
                typeof data.root !== 'string' || !data.root || typeof data.parent !== 'string' || typeof data.name !== 'string')
              throw failure('Explicit root, parent and filename are required; unsupported options are not allowed', 400);
            // An unknown initial ID is out of scope; a mapping disappearing
            // after selection is a conflict, never an implicit project root.
            const boundary = await rootPath(data.root);
            const result = await createFile(() => rootPath(data.root).catch(() => {
              throw failure('Root mapping changed; refresh before creating', 409);
            }), data.parent, data.name, data.root, showHidden, boundary);
            indexRevision++;
            index = null;
            // Discard even an in-flight status snapshot so the next read sees
            // this creation. Git action services themselves do not cache status.
            gitService = null;
            json(response, result, false, 201);
          } else if (editorAction) {
            const allowed = pathname === '/api/save' ? ['root', 'path', 'text', 'expected_version'] : ['root', 'path', 'tab'];
            if (Object.keys(data).some(key => !allowed.includes(key)) ||
                typeof data.root !== 'string' || !data.root || typeof data.path !== 'string' || !data.path)
              throw failure('Explicit root and file path are required; unsupported options are not allowed', 400);
            const result = pathname === '/api/save' ?
              await saveEditor(() => rootPath(data.root).catch(() => { throw failure('Root mapping changed; reload before saving', 409); }),
                data.path, data.text, data.expected_version, showHidden) :
              await setEditorView(await rootPath(data.root), data.path, data.tab, showHidden, root, data.root);
            if (pathname === '/api/save') index = null;
            json(response, { root_id: data.root, ...result });
          } else if (gitAction) {
            if (typeof data.root !== 'string' || !data.root) throw failure('Git 작업의 루트 ID가 필요합니다.', 400);
            const allowed = ['root', 'expectedHead', 'expectedBranch', ...(gitAction === 'push' ?
              ['remote', 'branch', 'confirmed', 'setUpstream', 'expectedPushToken'] : ['expectedIndex', ...(gitAction === 'commit' ? ['message'] : ['paths'])])];
            if (Object.keys(data).some(key => !allowed.includes(key))) throw failure('지원하지 않는 Git 작업 옵션입니다.', 400);
            const boundary = await rootPath(data.root);
            await resolvePath(boundary, '', showHidden);
            if (Array.isArray(data.paths) && data.paths.some(value => typeof value !== 'string' || !value ||
                path.isAbsolute(value) || value.includes('\\') || value.includes('\0') ||
                value.split('/').includes('..') || !visible(value, showHidden))) throw failure('등록한 루트의 표시된 파일만 선택하세요.', 403);
            const result = await (await actions())[gitAction](boundary, data);
            index = null;
            await (await git()).status(boundary, { refresh: true });
            json(response, { ...result, root_id: data.root });
          } else if (pathname === '/api/shutdown') {
            if (data.instance_id !== instanceId) throw failure('Invalid instance identity', 403);
            json(response, { status: 'stopping' });
            setImmediate(() => { close().catch(error => console.error(error.message)); });
          } else if (pathname === '/api/folders') json(response, await browseFolders(root, data.path, data.show_hidden === true));
          else {
            await changeRoot(root, data.operation, data.id, data.name, data.path);
            index = null;
            json(response, { roots: await rootInfo() });
          }
        } catch (error) { json(response, { error: error.message }, false, error.status || 400); }
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        respond(response, 405, '', 'text/plain', head, { Allow: 'GET, HEAD, POST' }); return;
      }
      if (pathname === '/') {
        respond(response, 200, await fs.readFile(path.join(PUBLIC, 'index.html')), 'text/html; charset=utf-8', head);
      } else if (pathname === '/api/info') json(response, { ...info, roots: await rootInfo() }, head);
      else if (pathname === '/api/fs-info') {
        if ([...query.keys()].some(key => !['root', 'path'].includes(key)) || query.getAll('root').length !== 1 ||
            query.getAll('path').length !== 1 || !query.get('root'))
          throw failure('Explicit root and path are required; unsupported options are not allowed', 400);
        const boundary = await rootPath(query.get('root'));
        json(response, await filesystemInfo(() => rootPath(query.get('root')).catch(() => {
          throw failure('Root mapping changed; refresh before trying again', 409);
        }), query.get('path'), query.get('root'), showHidden, boundary), head);
      }
      else if (['/api/git/context', '/api/git/branches', '/api/git/history'].includes(pathname)) {
        const boundary = await rootPath(rootId);
        await resolvePath(boundary, '', showHidden);
        const service = await actions(), kind = pathname.slice('/api/git/'.length);
        let paging;
        if (kind !== 'context') {
          const offset = query.get('offset') ?? '0', limit = query.get('limit') ?? (kind === 'history' ? '30' : '50');
          if (!/^\d+$/.test(offset) || !/^\d+$/.test(limit) || Number(offset) > 10000 || Number(limit) < 1 || Number(limit) > 100)
            throw failure('Git 목록 범위가 올바르지 않습니다.', 400);
          paging = { offset: Number(offset), limit: Number(limit) };
        }
        json(response, { ...await service[kind](boundary, paging), root_id: rootId }, head);
      }
      else if (pathname === '/api/git/status' || pathname === '/api/git/diff') {
        const boundary = await rootPath(rootId);
        await resolvePath(boundary, '', showHidden);
        const service = await git();
        if (pathname.endsWith('/status')) {
          const status = await service.status(boundary, { refresh: query.get('refresh') === '1' });
          const entries = status.entries.filter(value => visible(value.path, showHidden)).map(value => {
            if (value.original_path && !visible(value.original_path, showHidden)) {
              const { original_path, ...record } = value;
              return record;
            }
            return value;
          });
          json(response, { ...status, entries, root_id: rootId }, head);
        } else {
          if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0') ||
              relative.split('/').includes('..') || !visible(relative, showHidden)) throw failure('Path is excluded');
          json(response, { ...await service.diff(boundary, relative, { staged: query.get('staged') === '1' }), root_id: rootId }, head);
        }
      }
      else if (pathname === '/api/search') {
        json(response, await search(query.get('q') || '', query.get('type') || 'all', query.get('refresh') === '1', query.get('root') || null), head);
      } else if (pathname === '/api/list') {
        const boundary = await rootPath(rootId), directory = await resolvePath(boundary, relative, showHidden);
        if (!(await fs.stat(directory)).isDirectory()) throw failure('폴더가 아닙니다', 400);
        const entries = [];
        for (const name of await fs.readdir(directory)) {
          const child = path.posix.join(relative, name);
          try { entries.push(await listedEntry(boundary, child, rootId, showHidden)); } catch {}
        }
        json(response, { entries: entries.sort(entryOrder) }, head);
      } else if (pathname === '/api/entry') {
        const boundary = await rootPath(rootId);
        json(response, { entry: await listedEntry(boundary, relative, rootId, showHidden) }, head);
      } else if (pathname === '/api/text') {
        json(response, await textPreview(await rootPath(rootId), relative, showHidden), head);
      } else if (pathname === '/api/editor') {
        json(response, { root_id: rootId, ...await readEditor(await rootPath(rootId), relative, showHidden, root, rootId) }, head);
      } else if (pathname.startsWith('/api/')) json(response, { error: '알 수 없는 요청입니다' }, head, 404);
      else if (pathname === '/_preview') {
        const { file } = await openFile(await rootPath(rootId), relative, showHidden);
        await file.close();
        respond(response, 200, await fs.readFile(path.join(PUBLIC, 'text.html')), 'text/html; charset=utf-8', head);
      } else if (pathname === '/_app_assets/markdown-math.js') {
        await streamFile(request, response, PUBLIC, 'markdown-math.js', true);
      } else if (pathname.startsWith('/_math_assets/')) {
        const name = pathname.slice('/_math_assets/'.length);
        if (!/^(?:katex\.min\.(?:js|css)|fonts\/KaTeX_[A-Za-z0-9_-]+\.(?:woff2?|ttf))$/.test(name))
          throw Object.assign(new Error('Unknown math asset'), { code: 'ENOENT' });
        await streamFile(request, response, MATH_ASSETS, name, true);
      } else if (pathname.startsWith('/_text_assets/')) {
        const asset = await textAsset(pathname.slice('/_text_assets/'.length));
        await streamFile(request, response, path.dirname(asset), path.basename(asset), true);
      } else if (pathname.startsWith('/_pdfjs/')) {
        if (!pdfjsRoot) throw Object.assign(new Error('PDF viewer unavailable'), { code: 'ENOENT' });
        await streamFile(request, response, pdfjsRoot, pathname.slice('/_pdfjs/'.length), true);
      } else {
        let fileRelative = pathname.startsWith('/files/') ? pathname.slice('/files/'.length) : pathname.replace(/^\/+/, '');
        let source = 'project';
        if (pathname.startsWith('/roots/')) {
          const match = /^\/roots\/([A-Za-z0-9_-]+)\/files\/(.*)$/.exec(pathname);
          if (!match) throw failure('Invalid root file URL');
          [, source, fileRelative] = match;
        }
        const boundary = await rootPath(source);
        const target = await resolvePath(boundary, fileRelative, showHidden);
        if ((await fs.stat(target)).isDirectory()) {
          let hasIndex = false;
          try { hasIndex = (await fs.stat(path.join(target, 'index.html'))).isFile(); } catch {}
          if (hasIndex) {
            fileRelative = path.posix.join(fileRelative, 'index.html');
            await resolvePath(boundary, fileRelative, showHidden);
            if (!rawPath.endsWith('/')) {
              respond(response, 302, '', 'text/plain', head, { Location: rawPath + '/' }); return;
            }
          } else {
            respond(response, 302, '', 'text/plain', head, { Location: `/?root=${encodeURIComponent(source)}&path=${encodeURIComponent(fileRelative)}` }); return;
          }
        }
        await streamFile(request, response, boundary, fileRelative, showHidden, true);
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error.status || ({ ENOENT: 404, EACCES: 403, EPERM: 403, ELOOP: 403, ENOTDIR: 400 }[error.code]) ||
        (error instanceof URIError || error instanceof TypeError || error instanceof SyntaxError ? 400 : 500);
      const message = status === 404 ? '파일이 없습니다. 목록을 새로고침하세요.' : status === 403 ?
        '등록한 루트 안의 읽을 수 있는 파일만 열 수 있습니다.' : error.message;
      json(response, { error: message }, head, status);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 30_000;
  async function close() {
    closePromise ||= Promise.all([diagnostics.close(), new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeIdleConnections();
    })]);
    return closePromise;
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}/`;
    info = { service: SERVICE, backend: 'node', version: VERSION, root, name: path.basename(root), pid: process.pid,
      port: address.port, instance_id: instanceId, config_token: configToken, pdfjs: Boolean(pdfjsRoot), roots: [] };
    info.roots = await rootInfo();
    if (stateFile) await atomicJson(stateFile, { root, url, pid: process.pid, port: address.port,
      instance_id: instanceId, service: SERVICE, backend: 'node' });
    return { server, info, url, close };
  } catch (error) { await close(); throw error; }
}
