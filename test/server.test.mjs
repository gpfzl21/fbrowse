import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { startServer } from '../lib/server.mjs';
import { projectConfig, projectKey, readConfig, changeRoot } from '../lib/storage.mjs';
import { textAsset, PDFJS_VERSION, PDFJS_SHA256 } from '../lib/assets.mjs';

const execute = promisify(execFile);

function request(app, route, { method = 'GET', headers = {}, data } = {}) {
  if (data !== undefined) {
    method = 'POST';
    data = JSON.stringify(data);
    headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers };
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: app.info.port, path: route, method, headers }, res => {
      const blocks = [];
      res.on('data', block => blocks.push(block));
      res.on('end', () => {
        const body = Buffer.concat(blocks);
        resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function fixture(callback) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-node-server-'));
  const saved = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: path.join(base, 'home'), XDG_CONFIG_HOME: path.join(base, 'config'),
    XDG_CACHE_HOME: path.join(base, 'cache'), XDG_STATE_HOME: path.join(base, 'state') });
  let app;
  try {
    const roots = Object.fromEntries(['project', 'papers', 'results'].map(name => [name, path.join(base, name)]));
    for (const [name, directory] of Object.entries(roots)) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'same.txt'), name);
    }
    const stateFile = path.join(base, 'state', 'server.json');
    app = await startServer({ root: roots.project, pdfjs: false, stateFile });
    const post = (route, data, token = true) => request(app, route, { data,
      headers: token ? { 'X-Fbrowse-Token': app.info.config_token } : {} });
    await callback({ app, base, roots, stateFile, post });
  } finally {
    if (app) await app.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(base, { recursive: true, force: true });
  }
}

test('isolated server and storage integrations', async t => {
  await t.test('public pages, identity, atomic private state and idempotent close', () => fixture(async ({ app, roots, stateFile }) => {
    const info = (await request(app, '/api/info')).json();
    assert.equal(info.service, 'project-file-browser');
    assert.equal(info.backend, 'node');
    assert.equal(info.version, '0.9.1');
    assert.equal(info.pid, process.pid);
    assert.equal(info.root, roots.project);
    assert.equal(info.pdfjs, false);
    assert.equal(info.roots[0].connected, true);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(state.instance_id, info.instance_id);
    assert.equal(state.url, app.url);
    assert.equal(state.service, info.service);
    assert.equal(state.backend, 'node');
    assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
    assert.equal((await request(app, '/')).status, 200);
    assert.equal((await request(app, '/_preview?path=same.txt')).status, 200);
    const head = await request(app, '/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.ok(Number(head.headers['content-length']) > 1000);
    await Promise.all([app.close(), app.close()]);
  }));

  await t.test('multi-root CRUD, same names, source search and disconnected rename', () => fixture(async ({ app, base, roots, post }) => {
    for (const id of ['papers', 'results']) {
      const response = await post('/api/roots', { operation: 'add', id, name: id === 'papers' ? '논문 모음' : '실험 결과', path: roots[id] });
      assert.equal(response.status, 200, response.body.toString());
    }
    for (const id of ['project', 'papers', 'results']) {
      assert.equal((await request(app, `/roots/${id}/files/same.txt`)).body.toString(), id);
      assert.equal((await request(app, `/api/text?root=${id}&path=same.txt`)).json().text, id);
      const value = (await request(app, `/api/entry?root=${id}&path=same.txt`)).json().entry;
      assert.equal(value.root_id, id);
      assert.equal(value.kind, 'file');
    }
    assert.equal((await request(app, '/files/same.txt')).body.toString(), 'project');
    assert.deepEqual(new Set((await request(app, '/api/search?q=same')).json().entries.map(e => e.root_id)), new Set(['project', 'papers', 'results']));
    assert.equal((await request(app, '/api/search?q=same&root=papers')).json().total, 1);
    await fs.rename(roots.papers, path.join(base, 'offline'));
    assert.equal((await request(app, '/api/info')).json().roots.find(root => root.id === 'papers').connected, false);
    assert.equal((await request(app, '/api/list?root=papers')).status, 404);
    assert.equal((await post('/api/roots', { operation: 'edit', id: 'papers', name: '오프라인 논문', path: roots.papers })).status, 200);
    assert.equal((await readConfig(roots.project)).papers.name, '오프라인 논문');
    assert.equal((await post('/api/roots', { operation: 'remove', id: 'papers' })).status, 200);
    assert.equal((await request(app, '/roots/papers/files/same.txt')).status, 403);
    assert.equal(await fs.readFile(path.join(base, 'offline', 'same.txt'), 'utf8'), 'papers');
  }));

  await t.test('mutations validate IDs and require token; chooser provides only metadata', () => fixture(async ({ app, roots, post }) => {
    await fs.mkdir(path.join(roots.papers, '하위 폴더'));
    await fs.mkdir(path.join(roots.papers, '.hidden'));
    const data = { operation: 'add', id: 'papers', name: '논문', path: roots.papers };
    assert.equal((await post('/api/roots', data, false)).status, 403);
    for (const invalid of [{ ...data, id: 'project' }, { ...data, id: '../bad' }, { ...data, name: '' },
      { ...data, path: '../papers' }, { ...data, path: path.join(roots.papers, 'missing') }]) {
      assert.equal((await post('/api/roots', invalid)).status, 400);
    }
    const listing = await post('/api/folders', { path: roots.papers });
    assert.equal(listing.status, 200);
    assert.deepEqual(listing.json().entries.find(e => e.name === 'same.txt'), { name: 'same.txt', kind: 'file' });
    assert.equal(listing.json().entries[0].name, '하위 폴더');
    assert.equal(listing.json().entries.some(e => e.name === '.hidden'), false);
    assert.equal(listing.json().parent, path.dirname(roots.papers));
    assert.equal(listing.json().counts.directory, 1);
    assert.equal(listing.json().truncated, false);
    assert.equal((await post('/api/folders', { path: roots.papers, show_hidden: true })).json().counts.directory, 2);
    assert.equal((await post('/api/folders', { path: roots.papers }, false)).status, 403);
    for (const value of ['../papers', path.join(roots.papers, 'same.txt'), path.join(roots.papers, 'missing')])
      assert.equal((await post('/api/folders', { path: value })).status, 400);
    assert.deepEqual(await readConfig(roots.project), {});
    assert.equal((await request(app, '/roots/papers/files/same.txt')).status, 403);
    assert.equal((await request(app, '/api/folders')).status, 404);
    assert.equal((await post('/api/roots', data)).status, 200);
    assert.equal((await post('/api/roots', data)).status, 400);
    assert.equal((await post('/api/roots', { operation: 'remove', id: 'unknown' })).status, 400);
  }));

  await t.test('strict raw traversal, hidden and cross-root symlink boundaries', () => fixture(async ({ app, roots, post }) => {
    await post('/api/roots', { operation: 'add', id: 'papers', name: '논문', path: roots.papers });
    await fs.symlink(path.join(roots.results, 'same.txt'), path.join(roots.papers, 'escape.txt'));
    await fs.mkdir(path.join(roots.project, '.git'));
    await fs.writeFile(path.join(roots.project, '.git', 'secret'), 'secret');
    await fs.writeFile(path.join(roots.project, '.env'), 'secret');
    await fs.symlink(path.join(roots.project, '.git'), path.join(roots.project, 'git-link'));
    await fs.symlink(path.join(roots.project, 'same.txt'), path.join(roots.project, 'inside.txt'));
    const blocked = ['/files/%2e%2e/results/same.txt', '/files/%2Fetc/passwd', '/files/.env', '/files/.git/secret',
      '/files/git-link/secret', '/files/a%5Cb', '/files/same.txt%00', '/api/list?path=/tmp', '/api/list?path=../',
      '/roots/papers/files/escape.txt', '/roots/papers/files/%2e%2e/results/same.txt', '/roots/unknown/files/same.txt',
      '/api/text?root=unknown&path=same.txt', '/_preview?path=../results/same.txt'];
    for (const route of blocked) assert.equal((await request(app, route)).status, 403, route);
    assert.equal((await request(app, '/files/inside.txt')).body.toString(), 'project');
    const names = (await request(app, '/api/list')).json().entries.map(e => e.name);
    assert.equal(names.includes('.env') || names.includes('.git') || names.includes('git-link'), false);
    assert.equal((await request(app, '/files/%ZZ')).status, 400);
  }));

  await t.test('replaced root symlink is disconnected and excluded from fresh search', () => fixture(async ({ app, base, roots, post }) => {
    await post('/api/roots', { operation: 'add', id: 'papers', name: '논문', path: roots.papers });
    await fs.rename(roots.papers, path.join(base, 'old-papers'));
    await fs.symlink(roots.results, roots.papers);
    assert.equal((await request(app, '/api/info')).json().roots.find(root => root.id === 'papers').connected, false);
    assert.equal((await request(app, '/roots/papers/files/same.txt')).status, 403);
    assert.deepEqual((await request(app, '/api/search?q=same&refresh=1')).json().entries.map(e => e.root_id), ['project']);
    assert.equal((await request(app, '/api/search?q=same&root=project&refresh=1')).json().skipped, 0);
    assert.equal((await request(app, '/api/search?q=same&refresh=1')).json().skipped, 1);
  }));

  await t.test('symlink metadata keeps source identity and unavailable links cannot expose targets', () => fixture(async ({ app, roots }) => {
    await fs.mkdir(path.join(roots.project, 'docs'));
    await fs.writeFile(path.join(roots.project, 'docs', 'note.txt'), 'inside');
    await fs.symlink('docs', path.join(roots.project, 'linked-docs'));
    await fs.symlink('docs/note.txt', path.join(roots.project, 'linked-note.txt'));
    await fs.symlink('missing', path.join(roots.project, 'broken.txt'));
    await fs.symlink(path.join(roots.results, 'same.txt'), path.join(roots.project, 'external.txt'));
    await fs.symlink('loop', path.join(roots.project, 'loop'));
    const entries = (await request(app, '/api/list')).json().entries;
    const byName = name => entries.find(value => value.name === name);
    assert.equal(byName('linked-docs').kind, 'directory');
    assert.equal(byName('linked-docs').symlink, true);
    assert.equal(byName('linked-docs').link_target, 'docs');
    assert.equal(byName('linked-note.txt').path, 'linked-note.txt');
    assert.equal(byName('linked-note.txt').available, true);
    assert.equal((await request(app, '/api/list?path=linked-docs')).json().entries[0].path, 'linked-docs/note.txt');
    for (const name of ['broken.txt', 'external.txt', 'loop']) {
      assert.equal(byName(name).available, false);
      assert.equal(byName(name).symlink, true);
      const metadata = (await request(app, '/api/entry?path=' + name)).json().entry;
      assert.equal(metadata.path, name);
      assert.notEqual((await request(app, '/api/text?path=' + name)).status, 200);
      assert.notEqual((await request(app, '/_preview?path=' + name)).status, 200);
      assert.notEqual((await request(app, '/files/' + name)).status, 200);
    }
    assert.match(byName('external.txt').unavailable_reason, /루트 밖/);
    assert.match(byName('broken.txt').unavailable_reason, /없습니다/);
    assert.match(byName('loop').unavailable_reason, /순환/);
    const search = (await request(app, '/api/search?q=linked&refresh=1')).json().entries;
    assert.ok(search.some(value => value.path === 'linked-note.txt' && value.symlink));
    assert.equal(search.some(value => value.path === 'linked-docs/note.txt'), false);
  }));

  await t.test('Git HTTP routes isolate roots, filter hidden files and preserve staged versus working diffs', () => fixture(async ({ app, roots, post }) => {
    const git = (...args) => execute('git', ['-C', roots.project, '-c', 'core.hooksPath=/dev/null', ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeout: 5000,
    });
    await git('init', '-b', 'main');
    await git('add', 'same.txt');
    await git('-c', 'user.name=fbrowse test', '-c', 'user.email=fbrowse@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    await fs.writeFile(path.join(roots.project, 'same.txt'), 'staged line\n');
    await git('add', 'same.txt');
    await fs.writeFile(path.join(roots.project, 'same.txt'), 'working line\n');
    await fs.writeFile(path.join(roots.project, 'new 한글.txt'), 'new text\n');
    await fs.writeFile(path.join(roots.project, '.hidden.txt'), 'hidden\n');
    await fs.writeFile(path.join(roots.results, 'same.txt'), 'UNREGISTERED_TARGET_SECRET_90217');
    await fs.symlink(roots.results, path.join(roots.project, 'outside'));
    await fs.symlink(path.join(roots.results, 'same.txt'), path.join(roots.project, 'outside-link'));
    await post('/api/roots', { operation: 'add', id: 'results', name: '별도 루트', path: roots.results });
    const beforeIndex = await fs.readFile(path.join(roots.project, '.git', 'index'));
    const status = (await request(app, '/api/git/status?root=project')).json();
    assert.equal(status.available, true);
    assert.equal(status.root_id, 'project');
    assert.equal(status.branch, 'main');
    const modified = status.entries.find(value => value.path === 'same.txt');
    assert.equal(modified.index, 'M');
    assert.equal(modified.worktree, 'M');
    assert.ok(status.entries.some(value => value.path === 'new 한글.txt' && value.untracked));
    assert.equal(status.entries.some(value => value.path === '.hidden.txt'), false);
    const working = (await request(app, '/api/git/diff?path=same.txt')).json();
    const staged = (await request(app, '/api/git/diff?path=same.txt&staged=1')).json();
    assert.equal(working.kind, 'diff');
    assert.match(working.text, /working line/);
    assert.equal(staged.staged, true);
    assert.match(staged.text, /staged line/);
    assert.doesNotMatch(staged.text, /working line/);
    const link = (await request(app, '/api/git/diff?path=outside-link')).json();
    assert.doesNotMatch(link.text, /UNREGISTERED_TARGET_SECRET_90217/);
    for (const query of ['path=../same.txt', 'path=/etc/passwd', 'path=.hidden.txt', 'path=.git/config', 'root=unknown&path=same.txt'])
      assert.equal((await request(app, '/api/git/diff?' + query)).status, 403);
    const escape = await request(app, '/api/git/diff?path=outside/same.txt');
    assert.doesNotMatch(escape.body.toString(), /UNREGISTERED_TARGET_SECRET_90217/);
    const nonrepo = (await request(app, '/api/git/status?root=results')).json();
    assert.equal(nonrepo.available, false);
    assert.equal(nonrepo.reason, 'not_repository');
    assert.equal((await request(app, '/api/list?root=results')).status, 200);
    assert.deepEqual(await fs.readFile(path.join(roots.project, '.git', 'index')), beforeIndex);
  }));

  await t.test('missing Git remains optional for file browsing', () => fixture(async ({ app }) => {
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent-fbrowse-test-path';
    try {
      const status = (await request(app, '/api/git/status')).json();
      assert.equal(status.available, false);
      assert.equal(status.reason, 'git_unavailable');
      assert.equal((await request(app, '/api/list')).status, 200);
      assert.equal((await request(app, '/files/same.txt')).body.toString(), 'project');
    } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
  }));

  await t.test('showHidden exposes dotfiles while excluded dependency and VCS trees stay blocked', () => fixture(async ({ roots }) => {
    await fs.writeFile(path.join(roots.project, '.env'), 'visible by request');
    await fs.mkdir(path.join(roots.project, '.git'));
    await fs.writeFile(path.join(roots.project, '.git', 'secret'), 'excluded');
    await fs.mkdir(path.join(roots.project, 'node_modules'));
    const shown = await startServer({ root: roots.project, pdfjs: false, showHidden: true });
    try {
      assert.equal((await request(shown, '/files/.env')).status, 200);
      assert.equal((await request(shown, '/files/.git/secret')).status, 403);
      const names = (await request(shown, '/api/list')).json().entries.map(e => e.name);
      assert.equal(names.includes('.env'), true);
      assert.equal(names.includes('.git') || names.includes('node_modules'), false);
      assert.equal((await request(shown, '/api/search?q=.env&refresh=1')).json().total, 1);
    } finally { await shown.close(); }
  }));

  await t.test('HTML directory redirects, relative resources and document CSP', () => fixture(async ({ app, roots, post }) => {
    await fs.mkdir(path.join(roots.papers, 'docs'));
    await fs.writeFile(path.join(roots.papers, 'docs', 'index.html'), '<link rel="stylesheet" href="style.css"><script>parent.X=1</script>');
    await fs.writeFile(path.join(roots.papers, 'docs', 'style.css'), 'h1 {color: blue}');
    await fs.writeFile(path.join(roots.papers, 'image.svg'), '<svg><script>parent.X=1</script></svg>');
    await post('/api/roots', { operation: 'add', id: 'papers', name: '논문', path: roots.papers });
    const redirect = await request(app, '/roots/papers/files/docs');
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, '/roots/papers/files/docs/');
    const page = await request(app, '/roots/papers/files/docs/');
    assert.equal(page.status, 200);
    assert.match(page.body.toString(), /href="style.css"/);
    assert.match(page.headers['content-security-policy'], /script-src 'none'/);
    assert.equal((await request(app, '/roots/papers/files/docs/style.css')).headers['content-type'], 'text/css; charset=utf-8');
    assert.match((await request(app, '/roots/papers/files/image.svg')).headers['content-security-policy'], /script-src 'none'/);
    assert.equal((await request(app, '/roots/papers/files/')).headers.location, '/?root=papers&path=');
  }));

  await t.test('large streaming full/HEAD/Range, empty and sparse files', () => fixture(async ({ app, roots }) => {
    const content = Buffer.alloc(4 * 1024 * 1024 + 9);
    for (let i = 0; i < content.length; i++) content[i] = i % 251;
    const name = '큰 논문 #1%.pdf', route = '/files/' + encodeURIComponent(name);
    await fs.writeFile(path.join(roots.project, name), content);
    assert.deepEqual((await request(app, route)).body, content);
    const head = await request(app, route, { method: 'HEAD' });
    assert.equal(head.headers['content-type'], 'application/pdf');
    assert.equal(Number(head.headers['content-length']), content.length);
    assert.equal(head.body.length, 0);
    for (const [range, start, end] of [['bytes=100-199', 100, 200], ['bytes=-17', content.length - 17, content.length],
      ['bytes=4194304-', 4194304, content.length], ['bytes=0-9999999999999999999999', 0, content.length]]) {
      const response = await request(app, route, { headers: { Range: range } });
      assert.equal(response.status, 206);
      assert.equal(response.headers['content-range'], `bytes ${start}-${end - 1}/${content.length}`);
      assert.deepEqual(response.body, content.subarray(start, end));
    }
    for (const range of ['bytes=-0', 'bytes=10-5', 'bytes=999999999999999999999-', 'bytes=1-2,4-5', 'bytes=-', 'items=0-1']) {
      const response = await request(app, route, { headers: { Range: range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers['content-range'], `bytes */${content.length}`);
    }
    const rangeHead = await request(app, route, { method: 'HEAD', headers: { Range: 'bytes=10-19' } });
    assert.equal(rangeHead.status, 206);
    assert.equal(rangeHead.body.length, 0);
    assert.equal(rangeHead.headers['content-length'], '10');
    await fs.writeFile(path.join(roots.project, 'empty'), '');
    assert.equal((await request(app, '/files/empty')).body.length, 0);
    assert.equal((await request(app, '/files/empty', { headers: { Range: 'bytes=0-1' } })).status, 416);
    const huge = await fs.open(path.join(roots.project, 'huge.pdf'), 'w');
    try { await huge.truncate(1024 * 1024 * 1024); } finally { await huge.close(); }
    assert.equal((await request(app, '/files/huge.pdf', { method: 'HEAD' })).headers['content-length'], '1073741824');
    assert.deepEqual((await request(app, '/files/huge.pdf', { headers: { Range: 'bytes=-32' } })).body, Buffer.alloc(32));
  }));

  await t.test('strict BOM decoding, newline normalization, category filters and refreshed search', () => fixture(async ({ app, roots }) => {
    const examples = {
      'sample.py': '# 한글\r\ndef f():\r    return "<script>literal</script>"\n',
      'README.md': '# 제목\n', 'Makefile': 'all:\n\techo yes\n', 'Dockerfile': 'FROM scratch\n',
      'image.svg': '<svg/>', 'page.html': '<h1/>',
    };
    for (const [name, content] of Object.entries(examples)) await fs.writeFile(path.join(roots.project, name), content);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('한글\r\n둘째 줄', 'utf16le')]);
    await fs.writeFile(path.join(roots.project, 'utf16.txt'), utf16);
    await fs.writeFile(path.join(roots.project, 'utf8.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM\rline')]));
    const be = Buffer.from('한글\rline', 'utf16le'); be.swap16();
    await fs.writeFile(path.join(roots.project, 'be.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    const points = [...'한😀\r\n끝'].map(char => char.codePointAt(0));
    for (const little of [false, true]) {
      const buffer = Buffer.alloc(4 + points.length * 4);
      (little ? buffer.writeUInt32LE.bind(buffer) : buffer.writeUInt32BE.bind(buffer))(0xfeff, 0);
      points.forEach((point, i) => (little ? buffer.writeUInt32LE.bind(buffer) : buffer.writeUInt32BE.bind(buffer))(point, 4 + i * 4));
      await fs.writeFile(path.join(roots.project, `utf32-${little}.txt`), buffer);
      const preview = (await request(app, `/api/text?path=utf32-${little}.txt`)).json();
      assert.equal(preview.text, '한😀\n끝');
      assert.equal(preview.encoding, 'UTF-32');
    }
    assert.equal((await request(app, '/api/text?path=utf16.txt')).json().text, '한글\n둘째 줄');
    assert.equal((await request(app, '/api/text?path=be.txt')).json().text, '한글\nline');
    assert.equal((await request(app, '/api/text?path=utf8.txt')).json().text, 'BOM\nline');
    const source = (await request(app, '/api/text?path=sample.py')).json();
    assert.equal(source.language, 'python');
    assert.equal(source.text, examples['sample.py'].replace(/\r\n?/g, '\n'));
    assert.equal(source.markdown, false);
    assert.equal((await request(app, '/api/text?path=README.md')).json().markdown, true);
    assert.equal((await request(app, '/api/text?path=Makefile')).json().language, 'makefile');
    assert.equal((await request(app, '/api/text?path=Dockerfile')).json().language, 'dockerfile');
    for (const [name, bytes] of [['binary', [0, 255]], ['invalid', [0xc3, 0x28]], ['bad16', [0xff, 0xfe, 0x41]], ['bad32', [0xff, 0xfe, 0, 0, 1]]]) {
      await fs.writeFile(path.join(roots.project, name), Buffer.from(bytes));
      assert.equal((await request(app, '/api/text?path=' + name)).status, 415);
    }
    const categories = Object.fromEntries((await request(app, '/api/list')).json().entries.map(e => [e.name, e.category]));
    assert.equal(categories['sample.py'], 'code'); assert.equal(categories['README.md'], 'markdown');
    assert.equal(categories['image.svg'], 'media'); assert.equal(categories['page.html'], 'html');
    for (const [type, name] of [['code', 'sample.py'], ['markdown', 'README.md'], ['html', 'page.html']]) {
      const result = (await request(app, `/api/search?type=${type}&refresh=1`)).json();
      assert.deepEqual(result.entries.map(e => e.name), [name]);
    }
    await fs.writeFile(path.join(roots.project, 'new-report.pdf'), '%PDF-new');
    assert.equal((await request(app, '/api/search?q=new%20report&type=pdf&refresh=1')).json().total, 1);
    const large = 'print("한글")\n'.repeat(300_000);
    await fs.writeFile(path.join(roots.project, 'large.py'), large);
    assert.equal((await request(app, '/api/text?path=large.py')).json().text, large);
  }));

  await t.test('configuration updates serialize across processes and reject invalid saved schema', () => fixture(async ({ roots, base }) => {
    assert.equal(projectKey(roots.project).length, 16);
    assert.ok(projectConfig(roots.project).startsWith(path.join(base, 'config')));
    const script = `import {changeRoot} from ${JSON.stringify(new URL('../lib/storage.mjs', import.meta.url).href)}; await changeRoot(process.argv[1], 'add', process.argv[2], '동시 폴더', process.argv[3]);`;
    await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, roots.project, `parallel${i}`, roots.papers], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = ''; child.stderr.on('data', block => { errors += block; });
      child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(errors)));
    })));
    assert.equal(Object.keys(await readConfig(roots.project)).length, 8);
    assert.equal((await fs.stat(projectConfig(roots.project))).mode & 0o777, 0o600);
    await assert.rejects(changeRoot(roots.project, 'add', 'parallel0', 'duplicate', roots.results), /already exists/);
    await assert.rejects(changeRoot(roots.project, 'remove', 'missing'), /Unknown root/);
    await assert.rejects(changeRoot(roots.project, 'remove', 'project'), /Root ID/);
    await fs.writeFile(projectConfig(roots.project), JSON.stringify({ version: 1, project: '/wrong', roots: {} }));
    await assert.rejects(readConfig(roots.project), /Invalid project/);
  }));

  await t.test('simultaneous stale-lock recovery preserves every configuration edit', () => fixture(async ({ roots }) => {
    const lock = projectConfig(roots.project) + '.node-lock';
    await fs.mkdir(lock, { recursive: true });
    await fs.writeFile(path.join(lock, 'owner'), JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
    await Promise.all(Array.from({ length: 16 }, (_, i) => changeRoot(roots.project, 'add', `recovered${i}`, '복구 폴더', roots.papers)));
    assert.equal(Object.keys(await readConfig(roots.project)).length, 16);
    await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
    await assert.rejects(fs.stat(lock + '.reclaim'), { code: 'ENOENT' });
  }));

  await t.test('shutdown requires token and matching instance; closes only its own listener', () => fixture(async ({ app, roots, post }) => {
    const other = await startServer({ root: roots.results, pdfjs: false });
    try {
      assert.equal((await post('/api/shutdown', { instance_id: app.info.instance_id }, false)).status, 403);
      assert.equal((await post('/api/shutdown', { instance_id: 'wrong' })).status, 403);
      assert.equal((await request(app, '/api/info')).status, 200);
      const stopped = once(app.server, 'close');
      assert.equal((await post('/api/shutdown', { instance_id: app.info.instance_id })).status, 200);
      await stopped;
      assert.equal(app.server.listening, false);
      assert.equal((await request(other, '/api/info')).status, 200);
    } finally { await other.close(); }
  }));

  await t.test('offline assets reject corrupt cache and PDF download failure falls back', () => fixture(async ({ app, roots, base }) => {
    assert.equal((await request(app, '/_text_assets/unknown.js')).status, 404);
    assert.equal((await request(app, '/_pdfjs/web/viewer.html')).status, 404);
    const cache = path.join(base, 'cache', 'project-file-browser', 'text-assets');
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, '8ab71eb09c51f501e5e25157d9cff100e46cc29bcbfc744d0b746d451fca7f53.js'), 'corrupt');
    const originalFetch = globalThis.fetch, originalError = console.error;
    let downloads = 0, warning = '';
    globalThis.fetch = async () => { downloads++; return new Response('wrong-checksum'); };
    console.error = value => { warning += value; };
    try {
      await assert.rejects(textAsset('highlight.js'), /checksum/);
      const fallback = await startServer({ root: roots.results, pdfjs: true });
      try { assert.equal(fallback.info.pdfjs, false); } finally { await fallback.close(); }
      assert.match(warning, /Falling back/);
      assert.equal(downloads, 2);
      await assert.rejects(fs.stat(path.join(base, 'cache', 'project-file-browser', `pdfjs-${PDFJS_VERSION}-node`)), { code: 'ENOENT' });
    } finally { globalThis.fetch = originalFetch; console.error = originalError; }
  }));

  await t.test('math renderer and fonts are local with a strict asset allowlist', () => fixture(async ({ app }) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw Error('Unexpected download'); };
    try {
      for (const [name, type] of [['katex.min.js', 'text/javascript'], ['katex.min.css', 'text/css'],
        ['fonts/KaTeX_Main-Regular.woff2', 'font/woff2']]) {
        const result = await request(app, '/_math_assets/' + name);
        assert.equal(result.status, 200);
        assert.ok(result.headers['content-type'].startsWith(type));
        assert.ok(result.body.length > 1000);
        const head = await request(app, '/_math_assets/' + name, { method: 'HEAD' });
        assert.equal(head.body.length, 0);
        assert.equal(head.headers['content-length'], result.headers['content-length']);
      }
      assert.equal((await request(app, '/_app_assets/markdown-math.js')).status, 200);
      for (const name of ['../package.json', '%2e%2e/package.json', '%2Fetc/passwd', 'katex.js', 'fonts/../../package.json', 'LICENSE'])
        assert.ok([403, 404].includes((await request(app, '/_math_assets/' + name)).status));
    } finally { globalThis.fetch = originalFetch; }
  }));

  await t.test('verified viewer cache accepts symlinked XDG base and blocks asset traversal', () => fixture(async ({ roots, base }) => {
    const actual = path.join(base, 'actual-cache');
    await fs.mkdir(actual);
    await fs.symlink(actual, path.join(base, 'cache'));
    const viewer = path.join(actual, 'project-file-browser', `pdfjs-${PDFJS_VERSION}-node`);
    await fs.mkdir(path.join(viewer, 'web'), { recursive: true });
    const source = '<h1>verified cache fixture</h1>';
    await fs.writeFile(path.join(viewer, 'web', 'viewer.html'), source);
    await fs.writeFile(path.join(viewer, '.fbrowse-integrity.json'), JSON.stringify({ archive: PDFJS_SHA256,
      files: { 'web/viewer.html': createHash('sha256').update(source).digest('hex') } }));
    const cached = await startServer({ root: roots.results, pdfjs: true });
    try {
      assert.equal(cached.info.pdfjs, true);
      const page = await request(cached, '/_pdfjs/web/viewer.html');
      assert.equal(page.body.toString(), source);
      assert.equal(page.headers['content-security-policy'], undefined);
      assert.equal((await request(cached, '/_pdfjs/%2e%2e/outside.txt')).status, 403);
      assert.equal((await request(cached, '/_pdfjs/%2Fetc/passwd')).status, 403);
    } finally { await cached.close(); }
  }));
});
