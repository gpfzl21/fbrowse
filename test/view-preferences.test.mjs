import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { changeRoot } from '../lib/storage.mjs';
import { readEditor, setEditorView } from '../lib/editor.mjs';
import { editorDirectory } from '../lib/editor-locks.mjs';

test('unlimited persistent view preferences use only isolated XDG metadata', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-views-'));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(base, 'config');
  const project = path.join(base, 'project'), other = path.join(base, 'other'), external = path.join(base, 'external');
  for (const directory of [project, other, external]) await fs.mkdir(directory);
  let app;
  const get = async (name, root = 'project') => {
    const response = await fetch(app.url + 'api/editor?' + new URLSearchParams({ root, path: name }));
    assert.equal(response.status, 200); return response.json();
  };
  const set = async (name, tab, root = 'project') => {
    const response = await fetch(app.url + 'api/view-state', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fbrowse-Token': app.info.config_token },
      body: JSON.stringify({ root, path: name, tab }) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { root_id: root, path: name, tab });
  };
  try {
    await t.test('hundreds of choices survive restart and never contain text or undo data', async () => {
      app = await startServer({ root: project, pdfjs: false });
      await fs.writeFile(path.join(project, 'same.md'), 'DOCUMENT_SECRET_DO_NOT_PERSIST');
      await fs.writeFile(path.join(external, 'same.md'), 'EXTERNAL_SECRET_DO_NOT_PERSIST');
      await changeRoot(project, 'add', 'ext', 'same name', external);
      assert.equal((await get('same.md')).tab, 'preview');
      await set('same.md', 'source');
      await set('same.md', 'preview', 'ext');
      for (let i = 0; i < 256; i++) {
        const name = `file-${i}.md`;
        await fs.writeFile(path.join(project, name), `SECRET_CONTENT_${i}`);
        await set(name, i % 2 ? 'preview' : 'source');
      }
      assert.equal((await get('same.md')).tab, 'source');
      await app.close(); app = await startServer({ root: project, pdfjs: false });
      assert.equal((await get('same.md')).tab, 'source');
      assert.equal((await get('same.md', 'ext')).tab, 'preview');
      for (const i of [0, 1, 127, 254, 255]) assert.equal((await get(`file-${i}.md`)).tab, i % 2 ? 'preview' : 'source');
      const views = await editorDirectory('views'), names = await fs.readdir(views);
      assert.equal(names.length, 258);
      for (const name of names) {
        const target = path.join(views, name), raw = await fs.readFile(target, 'utf8'), value = JSON.parse(raw);
        assert.deepEqual(Object.keys(value).sort(), ['version', 'project', 'root_id', 'root', 'path', 'tab'].sort());
        assert.doesNotMatch(raw, /SECRET|undo|history|draft/);
        assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
      }
      assert.equal((await fs.readdir(project)).some(name => name.startsWith('.fbrowse')), false);
    });

    await t.test('root ID, canonical boundary and project isolate identical file names', async () => {
      await changeRoot(project, 'add', 'alias', 'same name', external);
      await set('same.md', 'source', 'ext');
      assert.equal((await get('same.md', 'ext')).tab, 'source');
      assert.equal((await get('same.md', 'alias')).tab, 'preview');
      await set('same.md', 'source', 'alias');
      const elsewhere = path.join(base, 'elsewhere'); await fs.mkdir(elsewhere); await fs.writeFile(path.join(elsewhere, 'same.md'), 'elsewhere');
      await changeRoot(project, 'edit', 'alias', 'same name', elsewhere);
      assert.equal((await get('same.md', 'alias')).tab, 'preview');
      const differentProject = await readEditor(external, 'same.md', false, other, 'ext');
      assert.equal(differentProject.tab, 'preview');
      await setEditorView(external, 'same.md', 'preview', false, other, 'ext');
      assert.equal((await get('same.md', 'ext')).tab, 'source');
      // Save replaces the file inode; its view preference must still follow it.
      const original = await get('same.md', 'ext');
      const response = await fetch(app.url + 'api/save', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Fbrowse-Token': app.info.config_token },
      body: JSON.stringify({ root: 'ext', path: 'same.md', text: 'changed', expected_version: original.version }) });
      assert.equal(response.status, 200);
      assert.equal((await get('same.md', 'ext')).tab, 'source');
    });

    await t.test('opening a selected file never enumerates the project or external roots', async () => {
      const originalRead = fsPromises.readdir, originalOpen = fsPromises.opendir;
      const forbidden = value => [project, external].some(root => String(value) === root || String(value).startsWith(root + path.sep));
      fsPromises.readdir = async (directory, ...args) => {
        assert.equal(forbidden(directory), false, 'editor unexpectedly scanned a root');
        return originalRead(directory, ...args);
      };
      fsPromises.opendir = async (directory, ...args) => {
        assert.equal(forbidden(directory), false, 'editor unexpectedly scanned a root');
        return originalOpen(directory, ...args);
      };
      syncBuiltinESMExports();
      try {
        assert.equal((await get('same.md', 'ext')).tab, 'source');
        await set('same.md', 'preview', 'ext');
      } finally {
        fsPromises.readdir = originalRead; fsPromises.opendir = originalOpen; syncBuiltinESMExports();
      }
    });
  } finally {
    await app?.close();
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    await fs.rm(base, { recursive: true, force: true });
  }
});
