// Independent integration tests: real HTTP server and temporary files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../lib/server.mjs';

test('editor HTTP integration preserves disk bytes and durable file identities', { timeout: 120_000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-editor-http-'));
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = path.join(base, key);
  const project = path.join(base, 'project'), external = path.join(base, 'external'), otherProject = path.join(base, 'other-project');
  let app, second;
  const start = root => startServer({ root, port: 0, host: '127.0.0.1', pdfjs: false });
  const url = (route, instance = app) => new URL(route, instance.url);
  const get = async (file, root = 'project', instance = app) => {
    const response = await fetch(url('/api/editor?' + new URLSearchParams({ root, path: file }), instance));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const post = (route, body, extra = {}, instance = app) => fetch(url(route, instance), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fbrowse-Token': instance.info.config_token,
      Origin: new URL(instance.url).origin, ...extra }, body: JSON.stringify(body),
  });
  const preference = async (file, tab, root = 'project', instance = app) => {
    const response = await post('/api/view-state', { root, path: file, tab }, {}, instance);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).tab, tab);
  };
  try {
    await Promise.all([project, external, otherProject].map(directory => fs.mkdir(directory, { recursive: true })));
    const originals = {
      'plain.txt': Buffer.from('hello 한글\n\n\tend\n'),
      'bom.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\r\n한글\r\n')]),
      'utf16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('first\r\n한글\r\n', 'utf16le')]),
      'mixed.txt': Buffer.from('first\r\nsecond\n'),
      'invalid.txt': Buffer.from([0xff, 0x80, 0x61]),
      'readonly.txt': Buffer.from('do not overwrite\n'),
      'large.txt': Buffer.alloc(8 * 1024 * 1024 + 1, 120),
      'notes.md': Buffer.from('# Project\n'),
      'page.html': Buffer.from('<h1>Project</h1>'),
    };
    for (const [name, bytes] of Object.entries(originals)) await fs.writeFile(path.join(project, name), bytes);
    await fs.chmod(path.join(project, 'readonly.txt'), 0o444);
    await fs.symlink('plain.txt', path.join(project, 'link.txt'));
    await fs.link(path.join(project, 'plain.txt'), path.join(project, 'hardlink.txt'));
    await fs.writeFile(path.join(base, 'outside.txt'), 'outside secret');
    await fs.symlink('../outside.txt', path.join(project, 'escape.txt'));
    await fs.writeFile(path.join(external, 'notes.md'), '# External\n');
    await fs.writeFile(path.join(otherProject, 'notes.md'), '# Other project\n');
    app = await start(project);

    await t.test('old text route remains compatible; version is 0.16.0', async () => {
      assert.equal((await (await fetch(url('/api/info'))).json()).version, '0.16.0');
      const response = await fetch(url('/api/text?path=plain.txt'));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).text, originals['plain.txt'].toString());
      assert.equal((await get('notes.md')).tab, 'preview');
      assert.equal((await get('page.html')).html, true);
    });
    await t.test('auth, Origin, traversal, symlink, readonly and stale saves preserve originals', async () => {
      // The hardlink created above also makes plain.txt readonly; use a separate writable file.
      await fs.writeFile(path.join(project, 'writable.txt'), 'baseline\n');
      const current = await get('writable.txt');
      assert.equal(current.editable, true);
      const body = { root: 'project', path: 'writable.txt', text: 'must not save', expected_version: current.version };
      for (const headers of [{ 'X-Fbrowse-Token': '' }, { 'X-Fbrowse-Token': 'wrong' }, { Origin: 'https://example.invalid' }]) {
        assert.equal((await post('/api/save', body, headers)).status, 403);
        assert.equal(await fs.readFile(path.join(project, 'writable.txt'), 'utf8'), 'baseline\n');
        assert.equal((await post('/api/view-state', { root: 'project', path: 'notes.md', tab: 'source' }, headers)).status, 403);
      }
      for (const bad of [{ root: 'unknown', path: 'writable.txt' }, { root: 'project', path: '../outside.txt' }, { root: 'project', path: 'escape.txt' }]) {
        assert.ok((await post('/api/save', { ...body, ...bad })).status >= 400);
      }
      assert.equal(await fs.readFile(path.join(base, 'outside.txt'), 'utf8'), 'outside secret');
      for (const name of ['mixed.txt', 'readonly.txt', 'link.txt', 'hardlink.txt']) {
        const original = await fs.readFile(path.join(project, name));
        const item = await get(name);
        assert.equal(item.editable, false, name);
        assert.ok(item.reason, name + ' needs an explanation');
        const rejected = await post('/api/save', { root: 'project', path: name, text: 'must not save', expected_version: item.version });
        assert.ok(rejected.status >= 400, name);
        assert.deepEqual(await fs.readFile(path.join(project, name)), original, name);
      }
      for (const [name, status] of [['invalid.txt', 415], ['large.txt', 413]]) {
        const response = await fetch(url('/api/editor?' + new URLSearchParams({ root: 'project', path: name })));
        assert.equal(response.status, status, name);
        assert.ok((await response.json()).error, name + ' has a clear refusal reason');
        assert.ok((await post('/api/save', { ...body, path: name })).status >= 400);
        assert.deepEqual(await fs.readFile(path.join(project, name)), originals[name]);
      }
      await fs.writeFile(path.join(project, 'writable.txt'), 'external edit\n');
      assert.equal((await post('/api/save', body)).status, 409);
      assert.equal(await fs.readFile(path.join(project, 'writable.txt'), 'utf8'), 'external edit\n');
    });
    await t.test('UTF-8 BOM and UTF-16 BOM with CRLF survive actual saves', async () => {
      for (const [name, encoding, bom] of [['bom.txt', 'utf8', [0xef, 0xbb, 0xbf]], ['utf16.txt', 'utf16le', [0xff, 0xfe]]]) {
        const item = await get(name);
        assert.equal(item.editable, true, name);
        assert.equal(item.text, 'first\n한글\n');
        const response = await post('/api/save', { root: 'project', path: name, text: 'changed\n한국어\n', expected_version: item.version });
        assert.equal(response.status, 200, await response.clone().text());
        const saved = await response.json();
        assert.equal(saved.saved, true);
        assert.notEqual(saved.version, item.version);
        assert.deepEqual(await fs.readFile(path.join(project, name)), Buffer.concat([Buffer.from(bom), Buffer.from('changed\r\n한국어\r\n', encoding)]));
      }
    });
    await t.test('preferences survive 1,205 later files and server restart without identity collisions', async () => {
      for (const id of ['external', 'alias']) {
        const response = await post('/api/roots', { operation: 'add', id, name: id, path: external });
        assert.equal(response.status, 200, await response.clone().text());
      }
      await preference('notes.md', 'source');
      assert.equal((await get('notes.md', 'external')).tab, 'preview');
      await preference('notes.md', 'source', 'external');
      assert.equal((await get('notes.md', 'alias')).tab, 'preview', 'root IDs isolate the same physical folder');
      // Real files and authenticated requests exercise persistence beyond a typical recent-file cap.
      await fs.mkdir(path.join(project, 'many'));
      for (let i = 0; i < 1205; i++) {
        const name = `many/${i}.md`;
        await fs.writeFile(path.join(project, name), '# fixture\n');
        await preference(name, 'source');
      }
      await app.close(); app = await start(project);
      assert.equal((await get('notes.md')).tab, 'source');
      assert.equal((await get('notes.md', 'external')).tab, 'source');
      assert.equal((await get('notes.md', 'alias')).tab, 'preview');
      assert.equal((await get('many/0.md')).tab, 'source');
      assert.equal((await get('many/1204.md')).tab, 'source');
      second = await start(otherProject);
      assert.equal((await get('notes.md', 'project', second)).tab, 'preview');
      assert.equal((await post('/api/roots', { operation: 'add', id: 'external', name: 'external', path: external }, {}, second)).status, 200);
      assert.equal((await get('notes.md', 'external', second)).tab, 'preview', 'project identity isolates a shared external root');
      assert.deepEqual(await fs.readFile(path.join(project, 'notes.md')), originals['notes.md']);
    });
  } finally {
    await second?.close(); await app?.close();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await fs.rm(base, { recursive: true, force: true });
  }
});
