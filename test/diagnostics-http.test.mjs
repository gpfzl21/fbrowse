// Real HTTP, disposable HOME/XDG/roots; optional checkers only ever receive stdin.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
import { startServer } from '../lib/server.mjs';

const requiredReal = process.env.FBROWSE_REQUIRE_REAL_DIAGNOSTICS === '1';
async function snapshot(directory) {
  const result = {};
  async function walk(parent, prefix = '') {
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      const name = prefix + entry.name, target = path.join(parent, entry.name);
      const stat = await fs.lstat(target, { bigint: true });
      if (entry.isDirectory()) await walk(target, name + '/');
      else result[name] = { mtime: String(stat.mtimeNs), size: String(stat.size),
        bytes: entry.isSymbolicLink() ? await fs.readlink(target) : (await fs.readFile(target)).toString('base64') };
    }
  }
  await walk(directory); return result;
}

test('diagnostics HTTP binds stdin text to a visible current file without modifying the project', { timeout: 60_000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-diagnostics-http-'));
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = path.join(base, key);
  const root = path.join(base, 'project'), other = path.join(base, 'other');
  let app;
  try {
    await Promise.all([root, other].map(name => fs.mkdir(name)));
    const files = { 'code.py': 'value = 1\n', 'paper.tex': '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n',
      'notes.txt': 'unchanged\n', 'binary.py': Buffer.from([0, 255, 65]), '.hidden.py': 'hidden = 1\n',
      'oversize.py': Buffer.alloc(8 * 1024 * 1024 + 1, 35), 'canary.txt': 'sibling canary\n',
      // If a checker discovers this config, normal diagnostics will fail.
      'pyproject.toml': '[tool.ruff]\nthis-is-not-a-valid-option = true\n', '.chktexrc': 'invalid checker config canary\n' };
    for (const [file, bytes] of Object.entries(files)) await fs.writeFile(path.join(root, file), bytes);
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'excluded.py'), 'secret = 1\n');
    await fs.mkdir(path.join(root, 'folder.py'));
    await fs.writeFile(path.join(other, 'outside.py'), 'outside canary\n');
    await fs.symlink(path.join(other, 'outside.py'), path.join(root, 'escape.py'));
    await fs.writeFile(path.join(process.env.HOME, '.chktexrc'), 'invalid ambient configuration\n').catch(async error => {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(process.env.HOME, { recursive: true }); await fs.writeFile(path.join(process.env.HOME, '.chktexrc'), 'invalid ambient configuration\n');
    });
    app = await startServer({ root, host: '127.0.0.1', port: 0, pdfjs: false });
    const origin = new URL(app.url).origin;
    const post = (body, headers = {}, route = '/api/diagnostics') => fetch(new URL(route, app.url), { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fbrowse-Token': app.info.config_token, Origin: origin, ...headers }, body: JSON.stringify(body) });
    const editor = async file => {
      const response = await fetch(new URL('/api/editor?' + new URLSearchParams({ root: 'project', path: file }), app.url));
      assert.equal(response.status, 200); return response.json();
    };
    const make = async (file = 'code.py', text = 'value = 1\n') => ({ root: 'project', path: file, text, expected_version: (await editor(file)).version, request_id: 'qa-current-1' });
    const current = await make();
    const before = await snapshot(root), outsideBefore = await snapshot(other);
    await t.test('token, Origin, Host and fetch-site guards precede diagnostics', async () => {
      for (const headers of [{ 'X-Fbrowse-Token': '' }, { 'X-Fbrowse-Token': 'foreign' }, { Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        assert.equal((await post(current, headers)).status, 403);
      }
      const status = await new Promise((resolve, reject) => {
        const req = request(new URL('/api/diagnostics', app.url), { method: 'POST', headers: { Host: 'foreign.invalid',
          'Content-Type': 'application/json', 'X-Fbrowse-Token': app.info.config_token, Origin: origin } }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        }); req.on('error', reject); req.end(JSON.stringify(current));
      }); assert.equal(status, 403);
    });
    await t.test('explicit fields, unknown options, paths, excluded files, binary and nonregular input fail closed', async () => {
      for (const key of ['root', 'path', 'text', 'expected_version', 'request_id']) {
        const body = { ...current }; delete body[key]; assert.ok((await post(body)).status >= 400, 'required field ' + key);
      }
      assert.ok((await post({ ...current, command: 'python' })).status >= 400);
      for (const file of ['../other/outside.py', path.join(other, 'outside.py'), 'escape.py', '.hidden.py', 'node_modules/excluded.py', 'missing.py', 'folder.py', 'binary.py', 'oversize.py']) {
        assert.ok((await post({ ...current, path: file })).status >= 400, 'reject ' + file);
      }
      assert.ok((await post({ ...current, root: 'unknown' })).status >= 400);
      assert.equal((await post({ ...current, expected_version: '0'.repeat(64) })).status, 409);
      assert.ok((await post({ ...current, text: '\0binary' })).status >= 400);
      const unsupported = await post(await make('notes.txt', 'hello\n'));
      assert.equal(unsupported.status, 200); assert.equal((await unsupported.json()).status, 'unsupported');
    });
    await t.test('real Ruff checks unsaved syntax, warnings, clean text and ignores project config', async () => {
      const check = async text => {
        const response = await post(await make('code.py', text)); assert.equal(response.status, 200, await response.clone().text());
        const data = await response.json();
        assert.equal(data.root_id, 'project'); assert.equal(data.path, 'code.py'); assert.equal(data.request_id, 'qa-current-1');
        assert.equal(data.language, 'python'); assert.equal(data.checker, 'ruff'); return data;
      };
      const syntax = await check('def broken(:\n');
      if (syntax.status === 'unavailable' && !requiredReal) { t.diagnostic('Optional Ruff unavailable; required-real QA uses FBROWSE_REQUIRE_REAL_DIAGNOSTICS=1'); return; }
      assert.equal(syntax.status, 'ok', syntax.message); assert.ok(syntax.diagnostics.some(item => item.severity === 'error'));
      const warning = await check('import os\n'); assert.equal(warning.status, 'ok');
      assert.ok(warning.diagnostics.some(item => item.code === 'F401' && item.severity === 'warning'));
      const clean = await check('value = 1\n'); assert.equal(clean.status, 'ok'); assert.deepEqual(clean.diagnostics, []);
      const unicode = '한글 = \"😀\"; missing_name\n', unicodeResult = await check(unicode);
      const missing = unicodeResult.diagnostics.find(item => item.code === 'F821');
      assert.equal(missing.column, [...unicode.slice(0, unicode.indexOf('missing_name'))].length + 1, 'Ruff columns count Unicode scalars');
      // This text must be parsed only; executing it would create the canary.
      await check('from pathlib import Path\nPath(' + JSON.stringify(path.join(root, 'EXECUTED')) + ').write_text("bad")\n');
      assert.equal(await fs.stat(path.join(root, 'EXECUTED')).then(() => true, () => false), false);
    });
    await t.test('real ChkTeX checks unsaved warning/syntax text with includes and ambient/project config disabled', async () => {
      const check = async text => {
        const response = await post(await make('paper.tex', text)); assert.equal(response.status, 200, await response.clone().text());
        const data = await response.json(); assert.equal(data.checker, 'chktex'); assert.equal(data.language, 'latex'); return data;
      };
      const warning = await check('Hello world...\n');
      if (warning.status === 'unavailable' && !requiredReal) { t.diagnostic('Optional ChkTeX unavailable; required-real QA uses FBROWSE_REQUIRE_REAL_DIAGNOSTICS=1'); return; }
      assert.equal(warning.status, 'ok', warning.message); assert.ok(warning.diagnostics.some(item => item.severity === 'warning'));
      const syntax = await check('\\begin{document}\n$x\n\\end{document}\n');
      assert.equal(syntax.status, 'ok'); assert.ok(syntax.diagnostics.length > 0);
      const clean = await check(files['paper.tex']); assert.equal(clean.status, 'ok'); assert.deepEqual(clean.diagnostics, []);
      const unicode = '한글😀\tHello world...\n', unicodeResult = await check(unicode);
      const ellipsis = unicodeResult.diagnostics.find(item => item.code === '11');
      assert.equal(ellipsis.column, [...unicode.slice(0, unicode.indexOf('...'))].length + 1, 'ChkTeX byte/tab columns normalize to Unicode scalars');
      const included = await check('\\input{' + path.join(other, 'outside.py') + '}\n'); assert.equal(included.status, 'ok');
      assert.ok(included.diagnostics.every(item => !item.message.includes('outside canary')));
      await check('\\immediate\\write18{touch ' + path.join(root, 'TEX_EXECUTED') + '}\n');
    });
    assert.deepEqual(await snapshot(root), before, 'bytes, mtimes and directory membership unchanged; no .pyc/.aux/cache/output');
    assert.deepEqual(await snapshot(other), outsideBefore, 'outside root remains unchanged');
    await t.test('disk version mismatch prevents processing another revision', async () => {
      await fs.writeFile(path.join(root, 'code.py'), 'external = 2\n');
      assert.equal((await post(current)).status, 409);
      assert.equal(await fs.readFile(path.join(root, 'code.py'), 'utf8'), 'external = 2\n');
    });
  } finally {
    await app?.close();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await fs.rm(base, { recursive: true, force: true });
  }
});
