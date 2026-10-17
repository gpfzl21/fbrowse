import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { watch, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../lib/server.mjs';
import { changeRoot } from '../lib/storage.mjs';
import { MAX_EDITOR_BYTES } from '../lib/editor.mjs';
import { digest, editorDirectory, withEditorLock } from '../lib/editor-locks.mjs';

async function fixture(callback) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-editor-'));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(base, 'config');
  const root = path.join(base, 'project'), external = path.join(base, 'external');
  await fs.mkdir(root); await fs.mkdir(external);
  const app = await startServer({ root, pdfjs: false });
  const apps = [app];
  const call = async (route, data, options = {}) => {
    const headers = { ...(data ? { 'Content-Type': 'application/json', 'X-Fbrowse-Token': app.info.config_token } : {}), ...options.headers };
    const response = await fetch(app.url + route.replace(/^\//, ''), {
      method: data ? 'POST' : 'GET', headers, ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, value: await response.json() };
  };
  const get = (name, id = 'project') => call('/api/editor?' + new URLSearchParams({ root: id, path: name }));
  const save = (name, text, version, id = 'project') => call('/api/save', { root: id, path: name, text, expected_version: version });
  try { await callback({ base, root, external, app, apps, call, get, save }); }
  finally {
    await Promise.all(apps.map(value => value.close()));
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    await fs.rm(base, { recursive: true, force: true });
  }
}

function bomBytes(text, encoding) {
  if (encoding === 'UTF-8') return Buffer.from(text);
  if (encoding === 'UTF-8 BOM') return Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(text)]);
  if (encoding.startsWith('UTF-16')) {
    const body = Buffer.from(text, 'utf16le');
    if (encoding.endsWith('BE')) body.swap16();
    return Buffer.concat([Buffer.from(encoding.endsWith('BE') ? [254, 255] : [255, 254]), body]);
  }
  const points = [...text].map(char => char.codePointAt(0));
  const body = Buffer.alloc(4 + points.length * 4);
  const write = encoding.endsWith('LE') ? body.writeUInt32LE.bind(body) : body.writeUInt32BE.bind(body);
  write(0xfeff, 0); points.forEach((point, i) => write(point, i * 4 + 4));
  return body;
}

test('editor and save API in temporary roots', async t => {
  await t.test('exact fields, language, defaults, Unicode and shell metacharacter paths', () => fixture(async ({ root, app, get, save }) => {
    for (const [name, language, markdown, html, tab] of [
      ['한글 $(`touch HACKED`) #%.py', 'python', false, false, 'source'],
      ['README.md', 'markdown', true, false, 'preview'], ['page.HTM', 'xml', false, true, 'preview'],
      ['Makefile', 'makefile', false, false, 'source'], ['Dockerfile', 'dockerfile', false, false, 'source'],
    ]) {
      await fs.writeFile(path.join(root, name), '한😀\n');
      const { status, value } = await get(name);
      assert.equal(status, 200);
      assert.deepEqual(Object.keys(value).sort(), ['root_id', 'path', 'text', 'language', 'markdown', 'html', 'encoding', 'editable', 'reason', 'version', 'tab'].sort());
      assert.equal(value.root_id, 'project'); assert.equal(value.path, name);
      assert.equal(value.language, language); assert.equal(value.markdown, markdown); assert.equal(value.html, html);
      assert.equal(value.tab, tab); assert.equal(value.editable, true); assert.equal(value.reason, null);
      assert.match(value.version, /^[0-9a-f]{64}$/);
      const result = await save(name, '둘😀\n', value.version);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.deepEqual(Object.keys(result.value).sort(), ['root_id', 'path', 'version', 'saved'].sort());
      assert.equal(result.value.saved, true);
      assert.equal(await fs.readFile(path.join(root, name), 'utf8'), '둘😀\n');
      assert.equal((await get(name)).value.version, result.value.version);
    }
    assert.equal(app.info.version, '0.14.0');
    await assert.rejects(fs.stat(path.join(root, 'HACKED')), { code: 'ENOENT' });
  }));

  await t.test('token, Origin, explicit selection and option validation', () => fixture(async ({ root, app, call, get }) => {
    await fs.writeFile(path.join(root, 'same.txt'), 'original');
    const version = (await get('same.txt')).value.version;
    const valid = { root: 'project', path: 'same.txt', text: 'changed', expected_version: version };
    for (const headers of [
      { 'X-Fbrowse-Token': '' }, { Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' },
    ]) assert.equal((await call('/api/save', valid, { headers })).status, 403);
    assert.equal((await call('/api/save', valid, { headers: { Origin: new URL(app.url).origin } })).status, 200);
    for (const data of [
      { path: 'same.txt', text: '', expected_version: version }, { root: 'project', text: '', expected_version: version },
      { ...valid, root: '' }, { ...valid, path: '' }, { ...valid, create: true }, { ...valid, expected_version: null },
      { ...valid, text: 17 },
    ]) assert.equal((await call('/api/save', data)).status, 400, JSON.stringify(data));
    for (const data of [{ path: 'same.txt', tab: 'source' }, { root: 'project', path: 'same.txt', tab: 'other' },
      { root: 'project', path: 'same.txt', tab: 'source', text: 'draft' }])
      assert.equal((await call('/api/view-state', data)).status, 400);
    assert.equal((await call('/api/view-state', { root: 'project', path: 'same.txt', tab: 'source' },
      { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('/api/view-state', { root: 'project', path: 'same.txt', tab: 'source' },
      { headers: { 'X-Fbrowse-Token': '' } })).status, 403);
  }));

  await t.test('BOM/newline byte roundtrips, mode and unchanged saves preserve inode', () => fixture(async ({ root, get, save }) => {
    for (const encoding of ['UTF-8', 'UTF-8 BOM', 'UTF-16LE', 'UTF-16BE', 'UTF-32LE', 'UTF-32BE']) {
      for (const newline of ['\n', '\r\n', '\r']) {
        const name = encoding + '-' + newline.length + '-' + newline.charCodeAt(0) + '.txt';
        const original = bomBytes('한😀' + newline + '둘' + newline, encoding);
        await fs.writeFile(path.join(root, name), original, { mode: 0o751 });
        const before = await fs.stat(path.join(root, name));
        const editor = (await get(name)).value;
        assert.equal(editor.encoding, encoding); assert.equal(editor.text, '한😀\n둘\n');
        const noop = await save(name, editor.text, editor.version);
        assert.equal(noop.status, 200); assert.equal(noop.value.version, editor.version);
        assert.equal((await fs.stat(path.join(root, name))).ino, before.ino);
        assert.deepEqual(await fs.readFile(path.join(root, name)), original);
        const changed = await save(name, '셋😄\n넷\n', editor.version);
        assert.equal(changed.status, 200, JSON.stringify(changed));
        assert.deepEqual(await fs.readFile(path.join(root, name)), bomBytes('셋😄' + newline + '넷' + newline, encoding));
        assert.equal((await fs.stat(path.join(root, name))).mode & 0o777, 0o751);
      }
    }
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.fbrowse-save-')), false);
  }));

  await t.test('conflicts cover external content edits, replacement, mapping changes and disconnection', () => fixture(async ({ root, external, base, get, save }) => {
    const target = path.join(root, 'same.txt');
    await fs.writeFile(target, 'one');
    let old = (await get('same.txt')).value;
    await fs.writeFile(target, 'two');
    assert.equal((await save('same.txt', 'lost', old.version)).status, 409);
    old = (await get('same.txt')).value;
    await fs.writeFile(path.join(root, 'replacement'), 'two'); await fs.rename(path.join(root, 'replacement'), target);
    assert.equal((await save('same.txt', 'lost', old.version)).status, 409);
    await fs.writeFile(path.join(external, 'same.txt'), 'two');
    const other = path.join(base, 'other'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'same.txt'), 'two');
    await changeRoot(root, 'add', 'ext', 'same name', external);
    const a = (await get('same.txt', 'ext')).value;
    await changeRoot(root, 'edit', 'ext', 'same name', other);
    const b = (await get('same.txt', 'ext')).value;
    assert.notEqual(a.version, b.version);
    assert.equal((await save('same.txt', 'lost', a.version, 'ext')).status, 409);
    await fs.rename(other, path.join(base, 'offline'));
    assert.equal((await save('same.txt', 'lost', b.version, 'ext')).status, 409);
    await fs.rename(root, path.join(base, 'old-project')); await fs.mkdir(root); await fs.writeFile(path.join(root, 'same.txt'), 'two');
    assert.equal((await save('same.txt', 'lost', old.version)).status, 409);
    assert.equal(await fs.readFile(path.join(root, 'same.txt'), 'utf8'), 'two');
  }));

  await t.test('permissions, hardlinks, mixed newlines, links, traversal and exclusions are safe', () => fixture(async ({ root, external, get, save, call }) => {
    await fs.writeFile(path.join(root, 'plain'), 'safe\n');
    await fs.writeFile(path.join(external, 'canary'), 'OUTSIDE CANARY');
    await fs.mkdir(path.join(root, 'folder')); await fs.writeFile(path.join(root, 'folder', 'inside'), 'inside');
    await fs.symlink('plain', path.join(root, 'link'));
    await fs.symlink('folder', path.join(root, 'link-parent'));
    await fs.symlink(external, path.join(root, 'outside'));
    await fs.link(path.join(root, 'plain'), path.join(root, 'hardlink'));
    await fs.writeFile(path.join(root, 'readonly'), 'read only', { mode: 0o444 });
    await fs.writeFile(path.join(root, 'mixed'), 'a\r\nb\nc\r');
    for (const name of ['plain', 'link', 'hardlink', 'link-parent/inside', 'readonly', 'mixed']) {
      const before = await fs.readFile(path.join(root, name));
      const editor = await get(name);
      assert.equal(editor.status, 200, JSON.stringify(editor));
      assert.equal(editor.value.editable, false, name); assert.ok(editor.value.reason);
      assert.equal((await save(name, 'unsafe', editor.value.version)).status, 403, name);
      assert.deepEqual(await fs.readFile(path.join(root, name)), before);
    }
    for (const name of ['../external/canary', '/etc/passwd', 'outside/canary', '.hidden', '.git/config', 'node_modules/file', 'folder\\inside']) {
      assert.equal((await get(name)).status, 403, name);
      const response = await save(name, 'unsafe', 'a'.repeat(64));
      assert.equal(response.status, 403, name);
    }
    assert.equal((await call('/api/save', { root: 'project', path: 'absent', text: 'new', expected_version: 'a'.repeat(64) })).status, 409);
    assert.equal(await fs.readFile(path.join(external, 'canary'), 'utf8'), 'OUTSIDE CANARY');
    assert.equal((await fs.stat(path.join(root, 'readonly'))).mode & 0o777, 0o444);
    await assert.rejects(fs.stat(path.join(root, 'absent')), { code: 'ENOENT' });
  }));

  await t.test('binary, invalid Unicode, raw and encoded limits', () => fixture(async ({ root, get, save, call }) => {
    for (const [name, bytes] of [['binary', [1, 2, 3]], ['nul', [65, 0]], ['invalid', [0xc3, 0x28]],
      ['utf16bad', [255, 254, 65]], ['utf32bad', [255, 254, 0, 0, 1]]]) {
      await fs.writeFile(path.join(root, name), Buffer.from(bytes));
      assert.equal((await get(name)).status, 415, name);
    }
    await fs.writeFile(path.join(root, 'small'), 'hello');
    const small = (await get('small')).value;
    for (const text of ['\ud800', 'bad\0', '\u0003']) assert.equal((await save('small', text, small.version)).status, 415);
    assert.equal((await save('small', 'a'.repeat(MAX_EDITOR_BYTES + 1), small.version)).status, 413);
    await fs.writeFile(path.join(root, 'utf32'), bomBytes('hello', 'UTF-32BE'));
    const utf32 = (await get('utf32')).value;
    assert.equal((await save('utf32', 'a'.repeat(MAX_EDITOR_BYTES / 4), utf32.version)).status, 413);
    await fs.writeFile(path.join(root, 'huge'), 'x'.repeat(MAX_EDITOR_BYTES + 1));
    assert.equal((await get('huge')).status, 413);
    assert.equal((await call('/api/text?path=huge')).value.text.length, MAX_EDITOR_BYTES + 1);
    assert.equal(await fs.readFile(path.join(root, 'small'), 'utf8'), 'hello');
  }));

  await t.test('parent switch to symlink rejects save, preserves outside canary, and cleans temporary file', () => fixture(async ({ root, external, get, save }) => {
    const parent = path.join(root, 'parent'), moved = path.join(root, 'moved');
    await fs.mkdir(parent);
    await fs.writeFile(path.join(parent, 'same.txt'), 'original');
    await fs.writeFile(path.join(external, 'same.txt'), 'OUTSIDE CANARY');
    const editor = (await get('parent/same.txt')).value;
    let switched = false;
    const watcher = watch(parent, (_event, name) => {
      if (!switched && name?.startsWith('.fbrowse-save-')) {
        switched = true; renameSync(parent, moved); symlinkSync(external, parent);
      }
    });
    try {
      const result = await save('parent/same.txt', 'changed', editor.version);
      assert.equal(switched, true);
      assert.ok([403, 409].includes(result.status), JSON.stringify(result));
    } finally { watcher.close(); }
    assert.equal(await fs.readFile(path.join(external, 'same.txt'), 'utf8'), 'OUTSIDE CANARY');
    assert.equal(await fs.readFile(path.join(moved, 'same.txt'), 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(moved), ['same.txt']);
  }));

  await t.test('external edit during staging rejects save and removes temporary files', () => fixture(async ({ root, get, save }) => {
    const target = path.join(root, 'same.txt');
    await fs.writeFile(target, 'original');
    const editor = (await get('same.txt')).value;
    let edited = false;
    const watcher = watch(root, (_event, name) => {
      if (!edited && name?.startsWith('.fbrowse-save-')) { edited = true; writeFileSync(target, 'external edit'); }
    });
    try {
      assert.equal((await save('same.txt', 'editor edit', editor.version)).status, 409);
      assert.equal(edited, true);
    } finally { watcher.close(); }
    assert.equal(await fs.readFile(target, 'utf8'), 'external edit');
    assert.deepEqual(await fs.readdir(root), ['same.txt']);
  }));

  await t.test('an immediate external edit after replacement never becomes the returned save version', () => fixture(async ({ root, get, save }) => {
    const target = path.join(root, 'same.txt');
    await fs.writeFile(target, 'original');
    const editor = (await get('same.txt')).value;
    const rename = fsPromises.rename;
    let edited = false;
    fsPromises.rename = async (source, destination) => {
      await rename(source, destination);
      if (String(source).includes('/.fbrowse-save-')) { edited = true; await fs.writeFile(destination, 'external edit'); }
    };
    syncBuiltinESMExports();
    try {
      const result = await save('same.txt', 'editor edit', editor.version);
      assert.equal(result.status, 409); assert.equal(result.value.version, undefined); assert.equal(edited, true);
    } finally { fsPromises.rename = rename; syncBuiltinESMExports(); }
    assert.equal(await fs.readFile(target, 'utf8'), 'external edit');
    assert.deepEqual(await fs.readdir(root), ['same.txt']);
  }));

  await t.test('two servers and independent processes serialize one canonical external file', () => fixture(async ({ base, root, external, app, apps, get, save }) => {
    await fs.writeFile(path.join(external, 'same.txt'), 'original');
    await changeRoot(root, 'add', 'ext', 'external', external);
    const secondRoot = path.join(base, 'second-project'); await fs.mkdir(secondRoot);
    await changeRoot(secondRoot, 'add', 'ext2', 'external', external);
    const second = await startServer({ root: secondRoot, pdfjs: false }); apps.push(second);
    const old = (await get('same.txt', 'ext')).value;
    const result = await Promise.all([
      save('same.txt', 'first server', old.version, 'ext'),
      fetch(second.url + 'api/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fbrowse-Token': second.info.config_token },
        body: JSON.stringify({ root: 'ext2', path: 'same.txt', text: 'second server', expected_version: old.version }) }).then(async response => ({ status: response.status, value: await response.json() })),
    ]);
    assert.deepEqual(result.map(value => value.status).sort(), [200, 409]);
    const latest = (await get('same.txt', 'ext')).value;
    const script = `import {saveEditor} from ${JSON.stringify(new URL('../lib/editor.mjs', import.meta.url).href)};
      try { await saveEditor(async()=>process.argv[1], 'same.txt', process.argv[3], process.argv[2]); console.log(200); }
      catch(error) { console.log(error.status); if(error.status!==409) { console.error(error); process.exitCode=1; } }`;
    const run = i => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, external, latest.version, 'process ' + i], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', block => { stdout += block; }); child.stderr.on('data', block => { stderr += block; });
      child.on('error', reject); child.on('close', code => code ? reject(new Error(stderr)) : resolve(Number(stdout.trim())));
    });
    const statuses = await Promise.all(Array.from({ length: 6 }, (_, i) => run(i)));
    assert.equal(statuses.filter(value => value === 200).length, 1);
    assert.equal(statuses.filter(value => value === 409).length, 5);
    assert.deepEqual(await fs.readdir(external), ['same.txt']);
  }));

  await t.test('owned locks recover dead owners with concurrent waiters and clean all artifacts', () => fixture(async ({ root }) => {
    const name = path.join(root, 'same.txt');
    const locks = await editorDirectory('locks');
    const lock = path.join(locks, digest(name));
    await fs.mkdir(lock, { mode: 0o700 }); await fs.writeFile(path.join(lock, 'owner'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
    let active = 0, count = 0;
    await Promise.all(Array.from({ length: 12 }, () => withEditorLock(name, async () => {
      active++; assert.equal(active, 1); await new Promise(resolve => setTimeout(resolve, 2)); count++; active--;
    })));
    assert.equal(count, 12); assert.deepEqual(await fs.readdir(locks), []);
  }));
});
