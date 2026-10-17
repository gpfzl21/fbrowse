import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('packed npm app installs globally and runs without Python, Bash, tmux or flock', { timeout: 90_000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-package-'));
  const prefix = path.join(temporary, 'prefix');
  const home = path.join(temporary, 'home');
  const project = path.join(temporary, 'empty project 한글');
  const external = path.join(temporary, 'selected external');
  const minimalPath = path.join(temporary, 'only-node');
  await Promise.all([home, project, external, minimalPath].map(directory => fs.mkdir(directory)));
  await fs.symlink(process.execPath, path.join(minimalPath, 'node'));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(temporary, 'config'),
    XDG_STATE_HOME: path.join(temporary, 'state'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
    PATH: minimalPath };
  const installed = path.join(prefix, 'bin', 'fbrowse');
  const run = (...args) => exec(installed, args, { env, cwd: project, timeout: 20_000 });
  let started = false;
  try {
    const packResult = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', temporary],
      { cwd: source, timeout: 30_000 })).stdout);
    const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
    const files = packed.files.map(file => file.path);
    assert.ok(files.includes('bin/fbrowse.mjs'));
    assert.ok(files.includes('public/index.html'));
    assert.ok(files.includes('lib/server.mjs'));
    assert.ok(files.includes('lib/diagnostics-runner.mjs'));
    assert.ok(files.includes('lib/diagnostics-parsers.mjs'));
    assert.ok(files.every(file => !/\.(?:py|sh)$/.test(file)), 'legacy runtimes must not ship');
    assert.ok(files.every(file => !/(?:^|\/)(?:\.aws|\.agents|\.codex|test|dist)(?:\/|$)/.test(file)));
    const archive = path.join(temporary, packed.filename);
    // npm dependencies were fetched by npm install; use that cache for an offline clean install.
    const npmCache = process.env.npm_config_cache || path.join(os.homedir(), '.npm');
    const collisionPrefix = path.join(temporary, 'collision-prefix');
    const collision = path.join(collisionPrefix, 'bin', 'fbrowse');
    await fs.mkdir(path.dirname(collision), { recursive: true });
    await fs.writeFile(collision, 'unrelated command');
    await assert.rejects(exec('npm', ['install', '--global', '--prefix', collisionPrefix, '--offline',
      '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCache, archive],
    { cwd: temporary, timeout: 30_000 }), 'npm must refuse to overwrite an unrelated fbrowse command');
    assert.equal(await fs.readFile(collision, 'utf8'), 'unrelated command');
    await exec('npm', ['install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts',
      '--no-audit', '--no-fund', '--cache', npmCache, archive], { cwd: temporary, timeout: 30_000 });
    assert.match((await run('--version')).stdout, /0\.15\.1/);
    await run('roots', 'add', 'external', external, '--name', '참고 자료');
    await run('--no-pdfjs');
    started = true;
    const url = (await run('url')).stdout.trim();
    const response = await fetch(new URL('api/info', url));
    assert.equal(response.status, 200);
    const info = await response.json();
    assert.equal(info.backend, 'node');
    assert.equal(info.root, await fs.realpath(project));
    assert.equal(info.roots.find(root => root.id === 'external').name, '참고 자료');
    const git = await (await fetch(new URL('api/git/status?root=project', url))).json();
    assert.equal(git.available, false, 'Git remains optional in a Node-only runtime');
    assert.equal(git.reason, 'git_unavailable');
    for (const route of ['context', 'branches', 'history']) {
      const metadata = await (await fetch(new URL('api/git/' + route + '?root=project', url))).json();
      assert.equal(metadata.available, false, 'Git actions metadata stays optional: ' + route);
      assert.equal(metadata.reason, 'git_unavailable');
    }
    assert.equal((await fetch(new URL('_math_assets/katex.min.js', url))).status, 200);
    assert.equal((await fetch(new URL('_math_assets/fonts/KaTeX_Main-Regular.woff2', url))).status, 200);
    assert.equal((await fetch(new URL('_app_assets/markdown-math.js', url))).status, 200);
    // Bundled parsers must also work after a clean packed install with only Node.
    for (const [name, text] of [['pack.js', 'const x = ;'], ['pack.ts', 'const x: = 1;'],
      ['pack.json', '{"x": }'], ['pack.yaml', 'key: 1\nkey: 2\n']]) {
      await fs.writeFile(path.join(project, name), '');
      const editor = await (await fetch(new URL('api/editor?' + new URLSearchParams({root:'project',path:name}), url))).json();
      const diagnostic = await fetch(new URL('api/diagnostics', url), { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Fbrowse-Token': info.config_token, Origin: new URL(url).origin },
        body: JSON.stringify({root:'project',path:name,text,expected_version:editor.version,request_id:'pack-parser'}) });
      assert.equal(diagnostic.status, 200);
      const result = await diagnostic.json(); assert.equal(result.status, 'ok', result.message);
      assert.ok(result.diagnostics.some(item => item.severity === 'error'), name);
      assert.equal(await fs.readFile(path.join(project, name), 'utf8'), '');
      await fs.rm(path.join(project, name));
    }
    assert.deepEqual(await fs.readdir(project), [], 'no app/config files in caller project');
    assert.deepEqual(await fs.readdir(external), [], 'selected root contents stay intact');
    await run('stop');
    started = false;
    const unrelated = path.join(prefix, 'bin', 'unrelated');
    await fs.writeFile(unrelated, 'keep me');
    await exec('npm', ['uninstall', '--global', '--prefix', prefix, '@wlalsrne/fbrowse', '--ignore-scripts',
      '--no-audit', '--no-fund'], { cwd: temporary, timeout: 30_000 });
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep me');
    await assert.rejects(fs.access(installed));
    assert.deepEqual(await fs.readdir(project), []);
  } finally {
    if (started) await run('stop').catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
