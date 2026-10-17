// Independent acceptance through the real HTTP API; all data and XDG state are disposable.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';

test('copy HTTP acceptance: keep both, saved bytes, roots, stale references and boundaries', { timeout: 120_000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-copy-http-'));
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = path.join(base, key);
  const root = path.join(base, 'project'), source = path.join(base, 'source'), destination = path.join(base, 'destination');
  let app;
  try {
    await Promise.all([root, source, destination].map(directory => fs.mkdir(directory)));
    await fs.writeFile(path.join(root, 'same.txt'), 'PROJECT CANARY');
    await fs.writeFile(path.join(source, 'same.txt'), 'SAVED SOURCE');
    await fs.writeFile(path.join(destination, 'same.txt'), 'DESTINATION CANARY');
    app = await startServer({ root, pdfjs: false });
    const request = async (route, data, headers = {}) => {
      const response = await fetch(new URL(route, app.url), { method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Fbrowse-Token': app.info.config_token, Origin: new URL(app.url).origin, ...headers },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json() };
    };
    const register = (id, directory) => request('/api/roots', { operation: 'add', id, name: id, path: directory });
    assert.equal((await register('source', source)).status, 200);
    assert.equal((await register('destination', destination)).status, 200);
    const metadata = async (file, id = 'source') => {
      const result = await request('/api/fs-info?' + new URLSearchParams({ root: id, path: file }));
      assert.equal(result.status, 200, JSON.stringify(result)); return result.body;
    };
    const reference = async (file, id = 'source') => ({ source_root: id, source_root_path: id === 'source' ? source : root, source_path: file, expected_version: (await metadata(file, id)).version });
    const copy = (ref, parent = '', id = 'destination', headers) => request('/api/fs', { action: 'copy', root: id, root_path: id === 'destination' ? destination : id === 'source' ? source : root, parent, ...ref }, headers);
    await t.test('cross-root identical names and concurrent repeats never overwrite; responses bind both roots', async () => {
      const ref = await reference('same.txt');
      const results = await Promise.all([0, 1, 2].map(() => copy(ref)));
      assert(results.every(result => result.status === 201), JSON.stringify(results));
      assert.equal(new Set(results.map(result => result.body.path)).size, 3);
      for (const { body } of results) {
        assert.equal(body.root_id, 'destination'); assert.equal(body.source_root_id, 'source'); assert.equal(body.source_path, 'same.txt');
        assert.equal(body.entry.root_id, 'destination'); assert.equal(body.entry.path, body.path); assert(body.path.endsWith('.txt'));
        assert.equal(await fs.readFile(path.join(destination, body.path), 'utf8'), 'SAVED SOURCE');
      }
      for (const [directory, expected] of [[root, 'PROJECT CANARY'], [source, 'SAVED SOURCE'], [destination, 'DESTINATION CANARY']])
        assert.equal(await fs.readFile(path.join(directory, 'same.txt'), 'utf8'), expected);
    });
    await t.test('basename, selected destination directory and literal adversarial names', async () => {
      await fs.mkdir(path.join(destination, 'selected folder'));
      const name = '한글 "quotes" <& $()` [x].data.txt';
      await fs.writeFile(path.join(source, name), Buffer.from([0, 1, 2, 255]));
      const result = await copy(await reference(name), 'selected folder');
      assert.equal(result.status, 201, JSON.stringify(result)); assert.equal(result.body.path, 'selected folder/' + name);
      assert.deepEqual(await fs.readFile(path.join(destination, result.body.path)), Buffer.from([0, 1, 2, 255]));
      const sameRoot = await copy(await reference(name), '', 'source'); assert.equal(sameRoot.status, 201);
      assert.notEqual(sameRoot.body.path, name); assert(sameRoot.body.path.endsWith('.txt'));
    });
    await t.test('directory copy includes hidden children and links without merging or following targets', async () => {
      await fs.mkdir(path.join(source, 'tree/sub'), { recursive: true });
      await fs.writeFile(path.join(source, 'tree/sub/.hidden'), 'hidden child');
      await fs.symlink(path.join(root, 'same.txt'), path.join(source, 'tree/link'));
      await fs.mkdir(path.join(destination, 'tree')); await fs.writeFile(path.join(destination, 'tree/canary'), 'NO MERGE');
      const result = await copy(await reference('tree')); assert.equal(result.status, 201, JSON.stringify(result)); assert.notEqual(result.body.path, 'tree');
      assert.equal(await fs.readFile(path.join(destination, result.body.path, 'sub/.hidden'), 'utf8'), 'hidden child');
      assert((await fs.lstat(path.join(destination, result.body.path, 'link'))).isSymbolicLink());
      assert.equal(await fs.readFile(path.join(destination, 'tree/canary'), 'utf8'), 'NO MERGE');
      const before = await fs.readdir(source);
      const recursive = await copy(await reference('tree'), 'tree/sub', 'source'); assert(recursive.status >= 400, JSON.stringify(recursive));
      assert.deepEqual(await fs.readdir(source), before);
    });
    await t.test('stale and deleted saved references fail without creating entries', async () => {
      await fs.writeFile(path.join(source, 'stale.txt'), 'baseline'); const stale = await reference('stale.txt');
      await fs.writeFile(path.join(source, 'stale.txt'), 'external change');
      const before = await fs.readdir(destination);
      assert.equal((await copy(stale)).status, 409); await fs.unlink(path.join(source, 'stale.txt'));
      assert((await copy(stale)).status >= 400); assert.deepEqual(await fs.readdir(destination), before);
    });
    await t.test('authentication, traversal, unknown roots and symlink destinations reject without writes', async () => {
      const ref = await reference('same.txt'), before = await fs.readdir(destination);
      for (const headers of [{ 'X-Fbrowse-Token': '' }, { 'X-Fbrowse-Token': 'wrong' }, { Origin: 'https://evil.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }])
        assert.equal((await copy(ref, '', 'destination', headers)).status, 403);
      for (const fields of [{ source_path: '../project/same.txt' }, { source_path: '/tmp' }, { source_root: 'missing' }, { expected_version: '' }, { extra: true }])
        assert((await copy({ ...ref, ...fields })).status >= 400, JSON.stringify(fields));
      for (const parent of ['../project', '/tmp', '.git']) assert((await copy(ref, parent)).status >= 400, parent);
      await fs.symlink(root, path.join(destination, 'outside'));
      assert((await copy(ref, 'outside')).status >= 400);
      assert.deepEqual((await fs.readdir(destination)).filter(name => name !== 'outside'), before);
      assert.equal(await fs.readFile(path.join(root, 'same.txt'), 'utf8'), 'PROJECT CANARY');
    });
    await t.test('captured source and destination mapping guards reject remapped roots', async () => {
      const ref = await reference('same.txt'), before = await fs.readdir(destination);
      assert.equal((await request('/api/roots', { operation: 'edit', id: 'source', name: 'source', path: root })).status, 200);
      assert.equal((await copy(ref)).status, 409);
      assert.equal((await request('/api/roots', { operation: 'edit', id: 'source', name: 'source', path: source })).status, 200);
      assert.equal((await request('/api/roots', { operation: 'edit', id: 'destination', name: 'destination', path: root })).status, 200);
      assert.equal((await copy(ref)).status, 409);
      assert.equal((await request('/api/roots', { operation: 'edit', id: 'destination', name: 'destination', path: destination })).status, 200);
      assert.deepEqual(await fs.readdir(destination), before);
      assert.equal(await fs.readFile(path.join(root, 'same.txt'), 'utf8'), 'PROJECT CANARY');
    });
    await t.test('unmounted source directory and removed mapping cannot redirect an old reference', async () => {
      const ref = await reference('same.txt'); await fs.rename(source, source + '-unmounted');
      assert((await copy(ref)).status >= 400);
      await fs.rename(source + '-unmounted', source);
      assert.equal((await request('/api/roots', { operation: 'remove', id: 'source' })).status, 200);
      const before = await fs.readdir(destination); assert((await copy(ref)).status >= 400);
      assert.deepEqual(await fs.readdir(destination), before);
    });
  } finally {
    await app?.close();
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    await fs.rm(base, { recursive: true, force: true });
  }
});
