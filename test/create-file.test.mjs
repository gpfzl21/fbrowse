import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../lib/server.mjs';
import { createFile } from '../lib/create-file.mjs';
import { changeRoot } from '../lib/storage.mjs';

const run = promisify(execFile);

async function fixture(callback, showHidden = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-create-'));
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = path.join(base, key);
  const root = path.join(base, 'project'), external = path.join(base, 'external');
  await fs.mkdir(root); await fs.mkdir(external);
  const app = await startServer({ root, showHidden, pdfjs: false });
  const request = async (route, body, headers = {}) => {
    const response = await fetch(new URL(route, app.url), { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fbrowse-Token': app.info.config_token, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  const create = (name, parent = '', id = 'project', headers) => request('/api/create', { root: id, parent, name }, headers);
  try { await callback({ base, root, external, app, request, create }); }
  finally {
    await app.close();
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    await fs.rm(base, { recursive: true, force: true });
  }
}

// This patches only Node's in-process fs seam. Operations and HTTP requests
// remain real; hooks deterministically switch paths immediately around open.
async function aroundCreation(hook, callback) {
  const original = fsPromises.open;
  let intercepted = false;
  fsPromises.open = async (target, flags, ...rest) => {
    if (!intercepted && typeof flags === 'number' && (flags & constants.O_CREAT) && String(target).startsWith('/proc/self/fd/')) {
      intercepted = true;
      return hook(() => original(target, flags, ...rest), target);
    }
    return original(target, flags, ...rest);
  };
  syncBuiltinESMExports();
  try { await callback(); assert.equal(intercepted, true); }
  finally { fsPromises.open = original; syncBuiltinESMExports(); }
}

test('safe empty file creation through HTTP and descriptor-anchored filesystem operations', { timeout: 120_000 }, async t => {
  await t.test('literal filenames, empty bytes, umask, normal entry/list/search and editor/save remain compatible', () => fixture(async ({ root, app, request, create }) => {
    await fs.mkdir(path.join(root, '문서 폴더'));
    assert.equal((await request('/api/search?q=created')).value.total, 0);
    for (const name of ['created.md', '한글 😀 spaces "quotes" $() `backticks`.txt', '-leading.dotted.name']) {
      const result = await create(name, '문서 폴더');
      assert.equal(result.status, 201, JSON.stringify(result));
      assert.deepEqual(Object.keys(result.value).sort(), ['entry', 'path', 'root_id']);
      const relative = '문서 폴더/' + name;
      assert.equal(result.value.path, relative); assert.equal(result.value.root_id, 'project');
      assert.deepEqual(await fs.readFile(path.join(root, relative)), Buffer.alloc(0));
      const info = await fs.stat(path.join(root, relative));
      assert.equal(info.mode & 0o777, 0o666 & ~process.umask());
      const entry = (await request('/api/entry?' + new URLSearchParams({ root: 'project', path: relative }))).value.entry;
      assert.deepEqual(result.value.entry, entry);
      assert.equal(entry.kind, 'file'); assert.equal(entry.symlink, false); assert.equal(entry.size, 0);
      assert.equal(entry.available, true); assert.equal(entry.root_id, 'project');
    }
    assert.equal(app.info.version, '0.15.0');
    const listed = (await request('/api/list?' + new URLSearchParams({ path: '문서 폴더' }))).value.entries;
    assert.equal(listed.length, 3);
    const found = (await request('/api/search?q=created')).value;
    assert.equal(found.total, 1); assert.equal(found.entries[0].path, '문서 폴더/created.md');
    const editor = await request('/api/editor?' + new URLSearchParams({ root: 'project', path: found.entries[0].path }));
    assert.equal(editor.status, 200); assert.equal(editor.value.text, ''); assert.equal(editor.value.encoding, 'UTF-8');
    const saved = await request('/api/save', { root: 'project', path: editor.value.path, text: '한글\n\t\n', expected_version: editor.value.version });
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.equal(await fs.readFile(path.join(root, editor.value.path), 'utf8'), '한글\n\t\n');
    await assert.rejects(fs.stat(path.join(root, 'backticks')), { code: 'ENOENT' });
  }));

  await t.test('token, Origin, cross-site, bounded JSON, strict fields/types and explicit root selection', () => fixture(async ({ root, app, request, create }) => {
    const valid = { root: 'project', parent: '', name: 'new.txt' };
    for (const headers of [{ 'X-Fbrowse-Token': '' }, { 'X-Fbrowse-Token': 'wrong' }, { Origin: 'https://evil.example' },
      { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await create('new.txt', '', 'project', headers)).status, 403);
    for (const data of [{}, [], null, { parent: '', name: 'x' }, { ...valid, root: '' }, { ...valid, root: 3 },
      { root: 'project', name: 'x' }, { ...valid, parent: null }, { ...valid, name: 3 }, { ...valid, text: '' },
      { ...valid, path: 'elsewhere' }, { ...valid, recursive: true }])
      assert.equal((await request('/api/create', data)).status, 400, JSON.stringify(data));
    const oversized = await request('/api/create', { ...valid, name: 'a'.repeat(17000) });
    assert.equal(oversized.status, 400);
    const raw = (body, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request(new URL('/api/create', app.url), { method: 'POST', headers: {
        'X-Fbrowse-Token': app.info.config_token, ...headers } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      req.on('error', reject); req.end(body);
    });
    assert.equal(await raw('{bad', { 'Content-Length': '4' }), 400);
    assert.equal(await raw(JSON.stringify(valid), { 'Transfer-Encoding': 'chunked' }), 400);
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT']) {
      const response = await fetch(new URL('/api/create', app.url), { method });
      assert.equal(response.status, ['GET', 'HEAD'].includes(method) ? 404 : 405);
      await response.arrayBuffer();
    }
    assert.deepEqual(await fs.readdir(root), []);
    assert.equal((await create('new.txt', '', 'project', { Origin: new URL(app.url).origin })).status, 201);
  }));

  await t.test('parallel duplicates have exactly one winner and existing objects never change', () => fixture(async ({ root, external, create }) => {
    const responses = await Promise.all(Array.from({ length: 16 }, () => create('parallel.txt')));
    assert.equal(responses.filter(value => value.status === 201).length, 1);
    assert.equal(responses.filter(value => value.status === 409).length, 15);
    await fs.writeFile(path.join(root, 'file'), 'KEEP', { mode: 0o640 });
    await fs.mkdir(path.join(root, 'directory'));
    await fs.writeFile(path.join(external, 'canary'), 'OUTSIDE CANARY');
    await fs.symlink(path.join(external, 'canary'), path.join(root, 'symlink'));
    await fs.symlink('absent', path.join(root, 'dangling'));
    await fs.link(path.join(root, 'file'), path.join(root, 'hardlink'));
    await run('mkfifo', [path.join(root, 'fifo')]);
    const names = ['file', 'directory', 'symlink', 'dangling', 'hardlink', 'fifo'];
    const before = await Promise.all(names.map(name => fs.lstat(path.join(root, name), { bigint: true })));
    for (const name of names) assert.equal((await create(name)).status, 409, name);
    for (const [i, name] of names.entries()) {
      const after = await fs.lstat(path.join(root, name), { bigint: true });
      for (const field of ['ino', 'dev', 'mode', 'size', 'nlink', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[i][field], name + ':' + field);
    }
    assert.equal(await fs.readFile(path.join(root, 'file'), 'utf8'), 'KEEP');
    assert.equal(await fs.readFile(path.join(external, 'canary'), 'utf8'), 'OUTSIDE CANARY');
    assert.equal(await fs.readlink(path.join(root, 'dangling')), 'absent');
  }));

  await t.test('traversal, hidden/excluded paths, unknown/disconnected roots, symlink and FIFO parents fail promptly', () => fixture(async ({ root, external, base, create }) => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', '\ud800']) assert.equal((await create(name)).status, 400, name);
    for (const name of ['.hidden', '.git', 'node_modules', '__pycache__']) assert.equal((await create(name)).status, 403, name);
    for (const parent of ['../external', '/tmp', '.hidden', '.git', 'node_modules', 'a/../../external'])
      assert.equal((await create('new', parent)).status, 403, parent);
    for (const parent of ['folder/', './folder', 'a//b', 'a\\b', 'a\0b']) assert.equal((await create('new', parent)).status, 400, parent);
    await fs.mkdir(path.join(root, 'folder'));
    await fs.mkdir(path.join(root, '.hidden'));
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.symlink('folder', path.join(root, 'inside-link'));
    await fs.symlink(external, path.join(root, 'outside-link'));
    await fs.symlink('loop', path.join(root, 'loop'));
    await run('mkfifo', [path.join(root, 'fifo')]);
    for (const parent of ['inside-link', 'outside-link', 'loop', 'fifo']) assert.equal((await create('new', parent)).status, 403, parent);
    assert.equal((await create('new', 'missing')).status, 409);
    assert.equal((await create('new', '', 'unknown')).status, 403);
    await changeRoot(root, 'add', 'ext', 'external', external);
    await fs.rename(external, path.join(base, 'disconnected'));
    assert.equal((await create('new', '', 'ext')).status, 409);
    assert.deepEqual(await fs.readdir(path.join(base, 'disconnected')), []);
    await fs.mkdir(path.join(root, 'readonly'), { mode: 0o555 });
    if (process.getuid() !== 0) assert.equal((await create('new', 'readonly')).status, 403);
  }));

  await t.test('showHidden permits dotfiles but still excludes reserved directories', () => fixture(async ({ root, create }) => {
    assert.equal((await create('.literal.name')).status, 201);
    await fs.mkdir(path.join(root, '.hidden'));
    assert.equal((await create('file.txt', '.hidden')).status, 201);
    for (const name of ['.git', '.venv', '.cache', 'venv']) assert.equal((await create(name)).status, 403);
    assert.deepEqual(await fs.readFile(path.join(root, '.literal.name')), Buffer.alloc(0));
  }, true));

  await t.test('registered root is explicit and Git status/search caches see the new entry immediately', () => fixture(async ({ root, external, request, create }) => {
    await run('git', ['init', '-q', external]);
    await changeRoot(root, 'add', 'ext', 'external', external);
    assert.equal((await request('/api/git/status?root=ext')).value.entries.length, 0);
    assert.equal((await request('/api/search?root=ext&q=fresh')).value.total, 0);
    const created = await create('fresh.txt', '', 'ext');
    assert.equal(created.status, 201); assert.equal(created.value.entry.root_id, 'ext');
    assert.deepEqual(await fs.readdir(root), []);
    assert.deepEqual(await fs.readFile(path.join(external, 'fresh.txt')), Buffer.alloc(0));
    const status = (await request('/api/git/status?root=ext')).value;
    assert.equal(status.available, true); assert.ok(status.entries.some(entry => entry.path === 'fresh.txt'));
    assert.equal((await request('/api/search?root=ext&q=fresh')).value.total, 1);
  }));

  for (const timing of ['before', 'after']) await t.test(`parent switched to outside symlink ${timing} exclusive open: canaries survive and artifact is cleaned`, () => fixture(async ({ root, external, create }) => {
    const parent = path.join(root, 'parent'), moved = path.join(root, 'moved');
    await fs.mkdir(parent); await fs.writeFile(path.join(external, 'new'), 'OUTSIDE CANARY');
    await aroundCreation(async open => {
      const file = timing === 'after' ? await open() : null;
      await fs.rename(parent, moved); await fs.symlink(external, parent);
      return file || open();
    }, async () => {
      const result = await create('new', 'parent');
      assert.ok([403, 409].includes(result.status), JSON.stringify(result));
    });
    assert.equal(await fs.readFile(path.join(external, 'new'), 'utf8'), 'OUTSIDE CANARY');
    assert.deepEqual(await fs.readdir(moved), []);
    assert.deepEqual(await fs.readdir(external), ['new']);
  }));

  await t.test('root mapping and root inode switches roll back exact artifacts without touching either outside root', () => fixture(async ({ root, external, base, create }) => {
    const other = path.join(base, 'other'); await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'new'), 'OTHER CANARY');
    await changeRoot(root, 'add', 'ext', 'external', external);
    await aroundCreation(async open => {
      const file = await open();
      await changeRoot(root, 'edit', 'ext', 'other', other);
      return file;
    }, async () => assert.equal((await create('new', '', 'ext')).status, 409));
    assert.deepEqual(await fs.readdir(external), []);
    assert.equal(await fs.readFile(path.join(other, 'new'), 'utf8'), 'OTHER CANARY');
    await changeRoot(root, 'edit', 'ext', 'external', external);
    const moved = path.join(base, 'moved-root');
    await aroundCreation(async open => {
      const file = await open();
      await fs.rename(external, moved); await fs.symlink(other, external);
      return file;
    }, async () => assert.ok([403, 409].includes((await create('new', '', 'ext')).status)));
    assert.deepEqual(await fs.readdir(moved), []);
    assert.equal(await fs.readFile(path.join(other, 'new'), 'utf8'), 'OTHER CANARY');
  }));

  await t.test('rollback preserves concurrently written, replaced and hard-linked files', () => fixture(async ({ root, external, create }) => {
    for (const kind of ['written', 'replaced', 'hardlinked']) {
      const parent = path.join(root, kind), moved = path.join(root, kind + '-moved');
      await fs.mkdir(parent);
      await aroundCreation(async open => {
        const file = await open();
        await fs.rename(parent, moved); await fs.symlink(external, parent);
        const target = path.join(moved, 'new');
        if (kind === 'written') await fs.writeFile(target, 'CONCURRENT WRITER');
        if (kind === 'replaced') { await fs.unlink(target); await fs.writeFile(target, 'REPLACEMENT'); }
        if (kind === 'hardlinked') await fs.link(target, path.join(moved, 'second-link'));
        return file;
      }, async () => assert.ok([403, 409].includes((await create('new', kind)).status)));
      if (kind === 'hardlinked') assert.equal((await fs.stat(path.join(moved, 'new'))).nlink, 2);
      else assert.equal(await fs.readFile(path.join(moved, 'new'), 'utf8'), kind === 'written' ? 'CONCURRENT WRITER' : 'REPLACEMENT');
    }
    assert.deepEqual(await fs.readdir(external), []);
  }));

  await t.test('a mapping removed after creation and a directory replaced with another directory both conflict and clean', () => fixture(async ({ root, external, create }) => {
    await changeRoot(root, 'add', 'ext', 'external', external);
    await aroundCreation(async open => {
      const file = await open(); await changeRoot(root, 'remove', 'ext'); return file;
    }, async () => assert.equal((await create('new', '', 'ext')).status, 409));
    assert.deepEqual(await fs.readdir(external), []);
    await fs.mkdir(path.join(root, 'parent'));
    await aroundCreation(async open => {
      const file = await open();
      await fs.rename(path.join(root, 'parent'), path.join(root, 'moved')); await fs.mkdir(path.join(root, 'parent'));
      return file;
    }, async () => assert.equal((await create('new', 'parent')).status, 409));
    assert.deepEqual(await fs.readdir(path.join(root, 'parent')), []);
    assert.deepEqual(await fs.readdir(path.join(root, 'moved')), []);
  }));

  await t.test('post-create mapping callback conflict preserves a modified inode and releases private locks', () => fixture(async ({ root, base }) => {
    let calls = 0;
    await assert.rejects(createFile(async () => {
      calls++;
      if (calls === 4) { await fs.writeFile(path.join(root, 'new'), 'EXTERNAL EDIT'); return root + '-changed'; }
      return root;
    }, '', 'new', 'project'), { status: 409 });
    assert.equal(await fs.readFile(path.join(root, 'new'), 'utf8'), 'EXTERNAL EDIT');
    assert.deepEqual(await fs.readdir(path.join(base, 'XDG_CONFIG_HOME/fbrowse/editor/locks')), [], 'every operation releases its shared lock');
    for (const key of ['XDG_STATE_HOME', 'XDG_CACHE_HOME'])
      await assert.rejects(fs.stat(path.join(base, key)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(root), ['new'], 'the caller root contains only the preserved user file');
  }));

  await t.test('selection pins the initial mapping and every nested parent is verified', () => fixture(async ({ root, external, create }) => {
    await assert.rejects(createFile(async () => external, '', 'new', 'project', false, root), { status: 409 });
    assert.deepEqual(await fs.readdir(root), []); assert.deepEqual(await fs.readdir(external), []);
    await fs.mkdir(path.join(root, 'ancestor', 'parent'), { recursive: true });
    await fs.writeFile(path.join(external, 'canary'), 'OUTSIDE CANARY');
    await aroundCreation(async open => {
      const file = await open();
      await fs.rename(path.join(root, 'ancestor'), path.join(root, 'moved'));
      await fs.symlink(external, path.join(root, 'ancestor'));
      return file;
    }, async () => assert.ok([403, 409].includes((await create('canary', 'ancestor/parent')).status)));
    assert.deepEqual(await fs.readdir(path.join(root, 'moved', 'parent')), []);
    assert.equal(await fs.readFile(path.join(external, 'canary'), 'utf8'), 'OUTSIDE CANARY');
  }));
});
