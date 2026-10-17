// Independent real HTTP checks; every mutation belongs to an isolated temporary root.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startServer } from '../lib/server.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
test('filesystem actions independent HTTP acceptance', { timeout: 120_000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-independent-fs-'));
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = path.join(base, key);
  const root = path.join(base, 'project'), other = path.join(base, 'other'), outside = path.join(base, 'outside');
  let app;
  try {
    await Promise.all([root, other, outside].map(p => fs.mkdir(p)));
    await fs.writeFile(path.join(outside, 'canary'), 'OUTSIDE CANARY');
    await fs.writeFile(path.join(root, 'same.txt'), 'project');
    await fs.writeFile(path.join(other, 'same.txt'), 'other');
    app = await startServer({ root, pdfjs: false });
    const request = async (route, data, extra = {}) => {
      const response = await fetch(new URL(route, app.url), { method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Fbrowse-Token': app.info.config_token, Origin: new URL(app.url).origin, ...extra },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json() };
    };
    const info = async (file, id = 'project') => {
      const result = await request('/api/fs-info?' + new URLSearchParams({ root: id, path: file }));
      assert.equal(result.status, 200, JSON.stringify(result)); return result.body;
    };
    const editor = async file => { const result = await request('/api/editor?' + new URLSearchParams({ root: 'project', path: file })); assert.equal(result.status, 200); return result.body; };
    const act = data => request('/api/fs', { root: 'project', ...data });
    const bind = async (action, file, extra = {}) => act({ action, path: file, expected_version: (await info(file)).version, ...extra });
    assert.equal((await request('/api/roots', { operation: 'add', id: 'other', name: 'Other', path: other })).status, 200);

    await t.test('strict mutation auth, explicit confirmation and path boundaries leave originals intact', async () => {
      const version = (await info('same.txt')).version;
      assert.equal(typeof version, 'string');
      const valid = { action: 'delete', root: 'project', path: 'same.txt', expected_version: version, confirmed: true };
      for (const headers of [{ 'X-Fbrowse-Token': '' }, { 'X-Fbrowse-Token': 'wrong' }, { Origin: 'https://evil.invalid' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }])
        assert.equal((await request('/api/fs', valid, headers)).status, 403);
      for (const bad of [undefined, false, 'true', 1]) {
        const data = { ...valid }; if (bad === undefined) delete data.confirmed; else data.confirmed = bad;
        assert.equal((await request('/api/fs', data)).status, 400);
      }
      for (const data of [{ ...valid, extra: true }, { ...valid, root: '' }, { ...valid, expected_version: null }, { ...valid, action: 'unknown' }, { action: 'mkdir', root: 'project', parent: '', name: '../escape' }])
        assert.equal((await request('/api/fs', data)).status, 400, JSON.stringify(data));
      for (const target of ['', '../outside/canary', '/tmp', '.git/config', '.secret'])
        assert((await request('/api/fs-info?' + new URLSearchParams({ root: 'project', path: target }))).status >= 400, target);
      assert.equal((await request('/api/fs-info?root=unknown&path=same.txt')).status, 403);
      assert.equal(await fs.readFile(path.join(root, 'same.txt'), 'utf8'), 'project');
      assert.equal(await fs.readFile(path.join(outside, 'canary'), 'utf8'), 'OUTSIDE CANARY');
    });
    await t.test('nested mkdir and create target actual parent and refuse overwrites', async () => {
      const name = '폴더 "quotes"';
      assert.equal((await act({ action: 'mkdir', parent: '', name })).status, 201);
      assert.equal((await act({ action: 'mkdir', parent: name, name: 'child' })).status, 201);
      assert.equal((await request('/api/create', { root: 'project', parent: name + '/child', name: 'literal 한글.txt' })).status, 201);
      assert.equal((await act({ action: 'mkdir', parent: '', name })).status, 409);
      assert.equal((await info(name)).kind, 'directory');
      assert.equal((await fs.stat(path.join(root, name, 'child/literal 한글.txt'))).size, 0);
      for (const name of ['.secret', 'node_modules', '.git']) assert.equal((await act({ action: 'mkdir', parent: '', name })).status, 403);
    });
    await t.test('directory fs-info is shallow and idle server does not enumerate roots', async () => {
      await fs.mkdir(path.join(root, 'shallow')); await fs.mkdir(path.join(root, 'shallow/deep'));
      const calls = [], originals = Object.fromEntries(['readdir', 'opendir'].map(key => [key, fsPromises[key]]));
      for (const key of Object.keys(originals)) fsPromises[key] = async (...args) => { calls.push([key, String(args[0])]); return originals[key](...args); };
      syncBuiltinESMExports();
      try { assert.equal((await info('shallow')).kind, 'directory'); await new Promise(resolve => setTimeout(resolve, 80)); assert.deepEqual(calls, [], 'fs-info and idle must not recursively list files'); }
      finally { Object.assign(fsPromises, originals); syncBuiltinESMExports(); }
    });
    await t.test('bounded 12 MiB binary duplicate uses disk bytes, collision names and original bytes', async () => {
      const bytes = Buffer.alloc(12 * 1024 * 1024 + 17); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
      await fs.writeFile(path.join(root, 'binary.data.bin'), bytes);
      const version = (await info('binary.data.bin')).version;
      const copies = await Promise.all([0, 1, 2].map(() => act({ action: 'duplicate', path: 'binary.data.bin', expected_version: version })));
      assert(copies.every(r => r.status === 201), JSON.stringify(copies));
      const names = copies.map(r => r.body.path); assert.equal(new Set(names).size, 3);
      for (const name of names) { assert(name.endsWith('.bin')); assert.equal(path.dirname(name), '.'); assert.equal(digest(await fs.readFile(path.join(root, name))), digest(bytes)); }
      assert.equal(digest(await fs.readFile(path.join(root, 'binary.data.bin'))), digest(bytes));
    });
    await t.test('directory and symlink copies preserve disk entries without following outside targets', async () => {
      await fs.mkdir(path.join(root, 'tree')); await fs.mkdir(path.join(root, 'tree/sub'));
      await fs.writeFile(path.join(root, 'tree/sub/file'), 'nested bytes'); await fs.writeFile(path.join(root, 'tree/.hidden'), 'hidden bytes');
      await fs.symlink(outside, path.join(root, 'tree/outside-link'));
      const copy = await bind('duplicate', 'tree'); assert.equal(copy.status, 201, JSON.stringify(copy));
      assert.equal(await fs.readFile(path.join(root, copy.body.path, 'sub/file'), 'utf8'), 'nested bytes');
      assert.equal(await fs.readFile(path.join(root, copy.body.path, '.hidden'), 'utf8'), 'hidden bytes');
      assert((await fs.lstat(path.join(root, copy.body.path, 'outside-link'))).isSymbolicLink());
      assert.equal(await fs.readlink(path.join(root, copy.body.path, 'outside-link')), outside);
      await fs.symlink(path.join(outside, 'canary'), path.join(root, 'link'));
      assert.equal((await info('link')).kind, 'symlink');
      const linkCopy = await bind('duplicate', 'link'); assert.equal(linkCopy.status, 201, JSON.stringify(linkCopy));
      assert((await fs.lstat(path.join(root, linkCopy.body.path))).isSymbolicLink());
      assert.equal(await fs.readlink(path.join(root, linkCopy.body.path)), path.join(outside, 'canary'));
      assert.equal((await bind('delete', 'link', { confirmed: true })).status, 200);
      assert.equal(await fs.readFile(path.join(outside, 'canary'), 'utf8'), 'OUTSIDE CANARY');
    });
    await t.test('file/folder rename bridges editor versions and saves only new path', async () => {
      await fs.mkdir(path.join(root, 'drafts')); await fs.writeFile(path.join(root, 'drafts/note.md'), '# disk\n');
      const before = await editor('drafts/note.md');
      const moved = await bind('rename', 'drafts', { name: 'renamed', editors: [{ path: 'drafts/note.md', version: before.version }] });
      assert.equal(moved.status, 200, JSON.stringify(moved));
      const binding = moved.body.editors.find(e => e.old_path === 'drafts/note.md');
      assert.equal(binding.path, 'renamed/note.md'); assert.equal(binding.old_version, before.version); assert.equal(typeof binding.version, 'string');
      const save = await request('/api/save', { root: 'project', path: binding.path, text: '# unsaved draft\n', expected_version: binding.version });
      assert.equal(save.status, 200, JSON.stringify(save));
      assert.equal(await fs.readFile(path.join(root, 'renamed/note.md'), 'utf8'), '# unsaved draft\n');
      await assert.rejects(fs.stat(path.join(root, 'drafts')), { code: 'ENOENT' });
      await fs.writeFile(path.join(root, 'occupied'), 'occupied');
      assert.equal((await bind('rename', 'same.txt', { name: 'occupied' })).status, 409);
      assert.equal(await fs.readFile(path.join(root, 'occupied'), 'utf8'), 'occupied');
      assert.equal(await fs.readFile(path.join(other, 'same.txt'), 'utf8'), 'other');
    });
    await t.test('external changes before and after rename never elevate a stale editor baseline', async () => {
      await fs.writeFile(path.join(root, 'stale.txt'), 'baseline'); const baseline = await editor('stale.txt');
      await fs.writeFile(path.join(root, 'stale.txt'), 'external before');
      const stale = await bind('rename', 'stale.txt', { name: 'should-not-exist.txt', editors: [{ path: 'stale.txt', version: baseline.version }] });
      assert.equal(stale.status, 409, JSON.stringify(stale)); await assert.rejects(fs.stat(path.join(root, 'should-not-exist.txt')), { code: 'ENOENT' });
      const fresh = await editor('stale.txt');
      const rename = await bind('rename', 'stale.txt', { name: 'fresh.txt', editors: [{ path: 'stale.txt', version: fresh.version }] });
      assert.equal(rename.status, 200); await fs.writeFile(path.join(root, 'fresh.txt'), 'external after');
      assert.equal((await request('/api/save', { root: 'project', path: 'fresh.txt', text: 'stale draft', expected_version: rename.body.editors[0].version })).status, 409);
      assert.equal(await fs.readFile(path.join(root, 'fresh.txt'), 'utf8'), 'external after');
      const old = await info('same.txt'); await fs.rename(path.join(root, 'same.txt'), path.join(root, 'old-inode')); await fs.writeFile(path.join(root, 'same.txt'), 'project');
      assert.equal((await act({ action: 'delete', path: 'same.txt', expected_version: old.version, confirmed: true })).status, 409);
    });
    await t.test('confirmed permanent folder deletion includes contents and preserves other roots', async () => {
      const deleted = await bind('delete', 'tree', { confirmed: true }); assert.equal(deleted.status, 200, JSON.stringify(deleted)); assert.equal(deleted.body.deleted, true);
      await assert.rejects(fs.stat(path.join(root, 'tree')), { code: 'ENOENT' });
      assert.equal(await fs.readFile(path.join(outside, 'canary'), 'utf8'), 'OUTSIDE CANARY');
      assert.equal(await fs.readFile(path.join(other, 'same.txt'), 'utf8'), 'other');
    });
  } finally {
    await app?.close();
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    await fs.rm(base, { recursive: true, force: true });
  }
});
