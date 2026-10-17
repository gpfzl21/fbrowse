import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import fsNative from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { constants } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../lib/server.mjs';
import { changeRoot } from '../lib/storage.mjs';

const run = promisify(execFile);
async function fixture(callback, showHidden = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-fs-http-'));
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
  const info = (relative, id = 'project') => request('/api/fs-info?' + new URLSearchParams({ root: id, path: relative }));
  const action = async (type, relative, extra = {}, id = 'project') => {
    const selected = type === 'mkdir' ? null : await info(relative, id);
    return request('/api/fs', { action: type, root: id, ...(type === 'mkdir' ? { parent: relative } :
      { path: relative, expected_version: selected.value.version }), ...extra });
  };
  try { await callback({ base, root, external, app, request, info, action }); }
  finally {
    await app.close();
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function patch(object, key, wrap, callback) {
  const original = object[key]; object[key] = wrap(original); syncBuiltinESMExports();
  try { await callback(); }
  finally { object[key] = original; syncBuiltinESMExports(); }
}

test('copy HTTP mid-operation mapping and cleanup safety', { timeout: 120_000 }, async t => {
  await t.test('strict copy schema requires both captured root mappings', () => fixture(async ({ root, request, info }) => {
    await fs.writeFile(path.join(root, 'saved.txt'), 'SAVED');
    const valid = { action: 'copy', root: 'project', root_path: root, parent: '', source_root: 'project',
      source_root_path: root, source_path: 'saved.txt', expected_version: (await info('saved.txt')).value.version };
    for (const fields of [{ root_path: undefined }, { source_root_path: undefined }, { source_root: undefined },
      { parent: undefined }, { source_path: undefined }, { root_path: 'relative' }, { source_root_path: 123 },
      { bytes: 'UNSAVED DRAFT' }, { overwrite: true }])
      assert.equal((await request('/api/fs', { ...valid, ...fields })).status, 400, JSON.stringify(fields));
    for (const fields of [{ root_path: root + '-other' }, { source_root_path: root + '-other' }])
      assert.equal((await request('/api/fs', { ...valid, ...fields })).status, 409);
    assert.deepEqual(await fs.readdir(root), ['saved.txt']);
  }));

  for (const side of ['source', 'destination']) await t.test(`${side} root remap after exclusive creation rejects and cleans owned output`, () => fixture(async ({ root, external, base, info, request }) => {
    const replacement = path.join(base, 'replacement'); await fs.mkdir(replacement);
    await fs.writeFile(path.join(root, 'saved.txt'), 'SOURCE');
    await fs.writeFile(path.join(replacement, 'saved.txt'), 'REPLACEMENT CANARY');
    await changeRoot(root, 'add', 'src', 'Source', root);
    await changeRoot(root, 'add', 'dest', 'Destination', external);
    const data = { action: 'copy', root: 'dest', root_path: external, parent: '', source_root: 'src',
      source_root_path: root, source_path: 'saved.txt', expected_version: (await info('saved.txt', 'src')).value.version };
    let intercepted = false;
    await patch(fsPromises, 'open', original => async (target, flags, ...rest) => {
      const file = await original(target, flags, ...rest);
      if (!intercepted && String(target).startsWith('/proc/self/fd/') && typeof flags === 'number' && (flags & constants.O_CREAT)) {
        intercepted = true;
        await changeRoot(root, 'edit', side === 'source' ? 'src' : 'dest', 'Remapped', replacement);
      }
      return file;
    }, async () => assert.equal((await request('/api/fs', data)).status, 409));
    assert.equal(intercepted, true); assert.deepEqual(await fs.readdir(external), []);
    assert.equal(await fs.readFile(path.join(root, 'saved.txt'), 'utf8'), 'SOURCE');
    assert.equal(await fs.readFile(path.join(replacement, 'saved.txt'), 'utf8'), 'REPLACEMENT CANARY');
  }));

  await t.test('detached destination is cleaned through held descriptor; outside symlink target stays untouched', () => fixture(async ({ root, external, base, request, info }) => {
    await fs.writeFile(path.join(root, 'source'), 'SOURCE');
    await changeRoot(root, 'add', 'dest', 'Destination', external);
    await fs.mkdir(path.join(external, 'selected'));
    const outside = path.join(base, 'canaries'), moved = path.join(external, 'moved');
    await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'source'), 'CANARY');
    const data = { action: 'copy', root: 'dest', root_path: external, parent: 'selected', source_root: 'project',
      source_root_path: root, source_path: 'source', expected_version: (await info('source')).value.version };
    let intercepted = false;
    await patch(fsPromises, 'open', original => async (target, flags, ...rest) => {
      const file = await original(target, flags, ...rest);
      if (!intercepted && String(target).startsWith('/proc/self/fd/') && typeof flags === 'number' && (flags & constants.O_CREAT)) {
        intercepted = true;
        await fs.rename(path.join(external, 'selected'), moved);
        await fs.symlink(outside, path.join(external, 'selected'));
      }
      return file;
    }, async () => assert.ok([403, 409].includes((await request('/api/fs', data)).status)));
    assert.equal(intercepted, true); assert.deepEqual(await fs.readdir(moved), []);
    assert.equal(await fs.readFile(path.join(outside, 'source'), 'utf8'), 'CANARY');
    assert.equal(await fs.readFile(path.join(root, 'source'), 'utf8'), 'SOURCE');
  }));

  await t.test('foreign contents in a partially created directory are retained with an honest error', () => fixture(async ({ root, external, request, info }) => {
    await fs.mkdir(path.join(root, 'tree')); await fs.writeFile(path.join(root, 'tree', 'saved'), 'SAVED');
    await changeRoot(root, 'add', 'dest', 'Destination', external);
    const data = { action: 'copy', root: 'dest', root_path: external, parent: '', source_root: 'project',
      source_root_path: root, source_path: 'tree', expected_version: (await info('tree')).value.version };
    let intercepted = false;
    await patch(fsNative, 'mkdirSync', original => (target, ...rest) => {
      const result = original(target, ...rest);
      if (!intercepted && String(target).startsWith('/proc/self/fd/')) {
        intercepted = true; fsNative.writeFileSync(`${target}/foreign`, 'FOREIGN CANARY');
      }
      return result;
    }, async () => {
      const result = await request('/api/fs', data);
      assert.equal(result.status, 409); assert.match(result.value.error, /incomplete copy may remain at tree/);
    });
    assert.equal(await fs.readFile(path.join(external, 'tree', 'foreign'), 'utf8'), 'FOREIGN CANARY');
    assert.equal(await fs.readFile(path.join(root, 'tree', 'saved'), 'utf8'), 'SAVED');
  }));
});

test('filesystem HTTP contract and mutation safety', { timeout: 120_000 }, async t => {
  await t.test('move authenticates, pins the root, rejects unsupported options and returns a relocated entry', () => fixture(async ({root,request,info}) => {
    await fs.mkdir(path.join(root,'destination'));await fs.writeFile(path.join(root,'source.txt'),'SAVED');
    const payload={action:'move',root:'project',root_path:root,path:'source.txt',parent:'destination',expected_version:(await info('source.txt')).value.version};
    assert.equal((await request('/api/fs',payload,{'X-Fbrowse-Token':'wrong'})).status,403);
    for(const extra of [{parent:undefined},{root_path:undefined},{name:'other.txt'},{overwrite:true},{editors:[{path:'elsewhere.txt',version:payload.expected_version}]}])
      assert.equal((await request('/api/fs',{...payload,...extra})).status,400);
    assert.equal((await request('/api/fs',{...payload,root_path:root+'-replaced'})).status,409);
    assert.equal((await request('/api/fs',{...payload,parent:'../outside'})).status,403);
    const result=await request('/api/fs',payload);assert.equal(result.status,200,JSON.stringify(result.value));
    assert.equal(result.value.old_path,'source.txt');assert.equal(result.value.path,'destination/source.txt');assert.equal(result.value.entry.root_id,'project');
    assert.equal((await request('/api/entry?root=project&path=destination%2Fsource.txt')).value.entry.path,result.value.path);
    assert.equal(await fs.readFile(path.join(root,result.value.path),'utf8'),'SAVED');
  }));
  await t.test('explicit-root info, all action responses and old create API remain compatible', () => fixture(async ({ root, request, info, action, app }) => {
    assert.equal(app.info.version, '0.13.0');
    const made = await action('mkdir', '', { name: '文書 folder' });
    assert.equal(made.status, 201); assert.equal(made.value.entry.kind, 'directory');
    const created = await request('/api/create', { root: 'project', parent: made.value.path, name: '새 파일.txt' });
    assert.equal(created.status, 201); assert.equal(created.value.path, '文書 folder/새 파일.txt');
    const selected = await info(created.value.path);
    assert.equal(selected.status, 200);
    assert.deepEqual(Object.keys(selected.value).sort(), ['kind', 'path', 'root_id', 'symlink', 'version']);
    const editor = (await request('/api/editor?' + new URLSearchParams({ root: 'project', path: selected.value.path }))).value;
    assert.equal((await request('/api/save', { root: 'project', path: editor.path, text: '한글\n', expected_version: editor.version })).status, 200);
    const copy = await action('duplicate', editor.path); assert.equal(copy.status, 201);
    const renamed = await action('rename', copy.value.path, { name: 'renamed.txt' });
    assert.equal(renamed.status, 200); assert.equal(renamed.value.old_path, copy.value.path); assert.deepEqual(renamed.value.editors, []);
    const deleted = await action('delete', renamed.value.path, { confirmed: true });
    assert.equal(deleted.status, 200); assert.deepEqual(deleted.value, { root_id: 'project', path: renamed.value.path, deleted: true });
    assert.equal(await fs.readFile(path.join(root, editor.path), 'utf8'), '한글\n');
  }));

  await t.test('token, same-origin/cross-site checks, strict fields, bounded JSON and mandatory delete confirmation', () => fixture(async ({ root, app, request, info }) => {
    await fs.writeFile(path.join(root, 'keep'), 'KEEP');
    const valid = { action: 'delete', root: 'project', path: 'keep', expected_version: (await info('keep')).value.version, confirmed: true };
    for (const headers of [{ 'X-Fbrowse-Token': '' }, { 'X-Fbrowse-Token': 'wrong' }, { Origin: 'https://evil.example' },
      { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await request('/api/fs', valid, headers)).status, 403);
    for (const body of [{ ...valid, confirmed: false }, { ...valid, confirmed: undefined }, { ...valid, confirmed: 'true' },
      { ...valid, root: undefined }, { ...valid, root: '' }, { ...valid, path: undefined }, { ...valid, expected_version: 'wrong' },
      { ...valid, recursive: true }, { ...valid, action: 'trash' }, [], null,
      { action: 'rename', root: 'project', path: 'keep', name: 'renamed', expected_version: valid.expected_version, editors: [{ path: 'unrelated', version: valid.expected_version }] },
      { action: 'mkdir', root: 'project', parent: '', name: 'x', unexpected: true }])
      assert.equal((await request('/api/fs', body)).status, 400, JSON.stringify(body));
    assert.equal((await request('/api/fs', { action: 'mkdir', root: 'project', parent: '', name: 'x'.repeat(132000) })).status, 400);
    for (const query of ['', '?path=keep', '?root=project', '?root=&path=keep', '?root=project&path=keep&extra=1', '?root=project&root=project&path=keep'])
      assert.equal((await request('/api/fs-info' + query)).status, 400, query);
    assert.equal((await request('/api/fs-info?root=project&path=')).status, 403);
    assert.equal((await request('/api/fs-info?root=unknown&path=keep')).status, 403);
    assert.equal(await fs.readFile(path.join(root, 'keep'), 'utf8'), 'KEEP');
    const raw = (body, headers) => new Promise((resolve, reject) => {
      const req = http.request(new URL('/api/fs', app.url), { method: 'POST', headers: { 'X-Fbrowse-Token': app.info.config_token, ...headers } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      }); req.on('error', reject); req.end(body);
    });
    assert.equal(await raw('{bad', { 'Content-Length': '4' }), 400);
    assert.equal(await raw(JSON.stringify(valid), { 'Transfer-Encoding': 'chunked' }), 400);
    assert.equal((await request('/api/fs', valid, { Origin: new URL(app.url).origin })).status, 200);
  }));

  await t.test('registered-root isolation, token/path binding and source/root mapping replacement conflicts', () => fixture(async ({ root, external, request, info, action }) => {
    await fs.writeFile(path.join(root, 'same.txt'), 'PROJECT'); await fs.writeFile(path.join(external, 'same.txt'), 'EXTERNAL');
    await changeRoot(root, 'add', 'ext', 'External', external);
    const projectVersion = (await info('same.txt')).value.version, externalVersion = (await info('same.txt', 'ext')).value.version;
    assert.notEqual(projectVersion, externalVersion);
    assert.equal((await request('/api/fs', { action: 'delete', root: 'ext', path: 'same.txt', expected_version: projectVersion, confirmed: true })).status, 409);
    const copy = await action('duplicate', 'same.txt', {}, 'ext'); assert.equal(copy.status, 201);
    assert.equal(await fs.readFile(path.join(external, copy.value.path), 'utf8'), 'EXTERNAL');
    assert.deepEqual(await fs.readdir(root), ['same.txt']);
    await fs.writeFile(path.join(root, 'same.txt'), 'CHANGED');
    assert.equal((await request('/api/fs', { action: 'rename', root: 'project', path: 'same.txt', name: 'renamed', expected_version: projectVersion })).status, 409);
    let intercepted = false;
    await patch(fsPromises, 'open', original => async (target, flags, ...rest) => {
      const file = await original(target, flags, ...rest);
      if (!intercepted && String(target).startsWith('/proc/self/fd/') && typeof flags === 'number' && (flags & constants.O_CREAT)) {
        intercepted = true; await changeRoot(root, 'remove', 'ext');
      }
      return file;
    }, async () => assert.equal((await action('duplicate', 'same.txt', {}, 'ext')).status, 409));
    assert.equal(intercepted, true);
    assert.deepEqual((await fs.readdir(external)).sort(), ['same copy.txt', 'same.txt']);
    assert.equal(await fs.readFile(path.join(root, 'same.txt'), 'utf8'), 'CHANGED');
  }));

  await t.test('search and Git snapshots invalidate immediately, even following partially failed recursive delete', () => fixture(async ({ root, request, action }) => {
    await run('git', ['init', '-q', root]);
    await fs.mkdir(path.join(root, 'tree')); await fs.writeFile(path.join(root, 'tree', 'a.txt'), 'A'); await fs.writeFile(path.join(root, 'tree', 'b.txt'), 'B');
    assert.equal((await request('/api/search?q=tree')).value.total, 2);
    assert.equal((await request('/api/git/status')).value.entries.length, 2);
    let deleted = 0;
    await patch(fsNative, 'unlinkSync', original => target => {
      if (String(target).startsWith('/proc/self/fd/')) {
        if (deleted++) throw Object.assign(new Error('Injected I/O failure'), { code: 'EIO' });
      }
      return original(target);
    }, async () => {
      const result = await action('delete', 'tree', { confirmed: true });
      assert.equal(result.status, 500); assert.match(result.value.error, /Deletion stopped after removing 1 entries/);
    });
    assert.equal((await request('/api/search?q=tree')).value.total, 1);
    assert.equal((await request('/api/git/status')).value.entries.length, 1);
    const made = await action('mkdir', '', { name: 'fresh' }); assert.equal(made.status, 201);
    await request('/api/create', { root: 'project', parent: 'fresh', name: 'visible.txt' });
    assert.equal((await request('/api/search?q=fresh')).value.total, 1);
    const copy = await action('duplicate', 'fresh/visible.txt'); assert.equal(copy.status, 201);
    assert.equal((await request('/api/search?q=fresh')).value.total, 2);
    assert.ok((await request('/api/git/status')).value.entries.some(value => value.path === copy.value.path));
  }));

  await t.test('cross-server cooperating rename/create collisions have one winner and never overwrite', () => fixture(async ({ root, app, request, info }) => {
    await fs.writeFile(path.join(root, 'source'), 'SOURCE');
    const other = await startServer({ root, pdfjs: false });
    try {
      const version = (await info('source')).value.version;
      const post = async (server, body) => {
        const response = await fetch(new URL('/api/fs', server.url), { method: 'POST', headers: {
          'Content-Type': 'application/json', 'X-Fbrowse-Token': server.info.config_token }, body: JSON.stringify(body) });
        return { status: response.status, value: await response.json() };
      };
      const copies = await Promise.all(Array.from({ length: 16 }, (_, index) => post(index % 2 ? other : app,
        { action: 'duplicate', root: 'project', path: 'source', expected_version: version })));
      assert.equal(copies.filter(value => value.status === 201).length, 16);
      assert.equal(new Set(copies.map(value => value.value.path)).size, 16);
      const collision = await Promise.all([
        post(other, { action: 'rename', root: 'project', path: 'source', name: 'winner', expected_version: version }),
        request('/api/create', { root: 'project', parent: '', name: 'winner' }),
      ]);
      assert.equal(collision.filter(value => [200, 201].includes(value.status)).length, 1);
      assert.equal(collision.filter(value => value.status === 409).length, 1);
      if (collision[0].status === 200) assert.equal(await fs.readFile(path.join(root, 'winner'), 'utf8'), 'SOURCE');
      else {
        assert.equal(await fs.readFile(path.join(root, 'winner'), 'utf8'), '');
        assert.equal(await fs.readFile(path.join(root, 'source'), 'utf8'), 'SOURCE');
      }
    } finally { await other.close(); }
  }));

  await t.test('open-editor rename supplies proven replacement version; stale content rejects and no automatic save occurs', () => fixture(async ({ root, request, action }) => {
    await fs.mkdir(path.join(root, 'old')); await fs.writeFile(path.join(root, 'old', 'file.md'), 'DISK\r\n');
    const old = (await request('/api/editor?root=project&path=old%2Ffile.md')).value;
    const renamed = await action('rename', 'old', { name: 'new', editors: [{ path: old.path, version: old.version }] });
    assert.equal(renamed.status, 200);
    const binding = renamed.value.editors[0]; assert.equal(binding.old_version, old.version); assert.equal(binding.path, 'new/file.md');
    assert.equal(await fs.readFile(path.join(root, binding.path), 'utf8'), 'DISK\r\n');
    assert.equal((await request('/api/save', { root: 'project', path: binding.path, expected_version: old.version, text: 'DRAFT\n' })).status, 409);
    assert.equal((await request('/api/save', { root: 'project', path: binding.path, expected_version: binding.version, text: 'DRAFT\n' })).status, 200);
    assert.equal(await fs.readFile(path.join(root, binding.path), 'utf8'), 'DRAFT\r\n');
    const editor = (await request('/api/editor?root=project&path=new%2Ffile.md')).value;
    await fs.writeFile(path.join(root, binding.path), 'EXTERNAL');
    const rejected = await action('rename', 'new', { name: 'never', editors: [{ path: editor.path, version: editor.version }] });
    assert.equal(rejected.status, 409); assert.equal(await fs.readFile(path.join(root, binding.path), 'utf8'), 'EXTERNAL');
  }));
});
