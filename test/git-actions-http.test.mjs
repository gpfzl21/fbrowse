import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../lib/server.mjs';

const execute = promisify(execFile);
async function fixture(callback) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-actions-http-'));
  const saved = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'].map(key => [key, process.env[key]]));
  const root = path.join(base, 'repo');
  for (const name of ['repo', 'home', 'config', 'state', 'cache']) await fs.mkdir(path.join(base, name));
  Object.assign(process.env, { HOME: path.join(base, 'home'), XDG_CONFIG_HOME: path.join(base, 'config'),
    XDG_STATE_HOME: path.join(base, 'state'), XDG_CACHE_HOME: path.join(base, 'cache') });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const gitAt = async (directory, ...args) => (await execute('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgsign=false', ...args], { env, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const git = (...args) => gitAt(root, ...args);
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'fbrowse isolated HTTP test');
  await git('config', 'user.email', 'fbrowse@example.invalid');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'original\n');
  await git('add', 'tracked.txt');
  await git('commit', '-m', 'initial fixture');
  let app;
  try {
    app = await startServer({ root, pdfjs: false });
    async function request(route, data, { authenticated = true, origin, rootId = 'project' } = {}) {
      const options = { headers: {} };
      if (data !== undefined) {
        options.method = 'POST';
        options.headers['Content-Type'] = 'application/json';
        if (authenticated) options.headers['X-Fbrowse-Token'] = app.info.config_token;
        options.body = JSON.stringify({ root: rootId, ...data });
      }
      if (origin !== undefined) options.headers.Origin = origin;
      const response = await fetch(app.url + route.replace(/^\//, ''), options);
      return { status: response.status, body: await response.json() };
    }
    const context = async (id = 'project') => (await request('/api/git/context?root=' + id)).body;
    const expected = value => ({ expectedHead: value.head, expectedBranch: value.branch, expectedIndex: value.indexToken });
    await callback({ app, root, base, git, gitAt, request, context, expected });
  } finally {
    await app?.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(base, { recursive: true, force: true });
  }
}

test('Git action HTTP authentication, Origin and scope guards never mutate on rejected requests', () => fixture(async ({ root, git, request, context, expected }) => {
  await fs.writeFile(path.join(root, 'tracked.txt'), 'working\n');
  const head = await git('rev-parse', 'HEAD'), index = await fs.readFile(path.join(root, '.git/index'));
  const state = await context();
  assert.equal(state.available, true);
  assert.equal(state.canWrite, true);
  assert.equal(state.root_id, 'project');
  const data = { paths: ['tracked.txt'], ...expected(state) };
  assert.equal((await request('/api/git/stage', data, { authenticated: false })).status, 403);
  assert.equal((await request('/api/git/stage', data, { origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await request('/api/git/stage', { ...data, root: 'unknown' })).status, 403);
  assert.equal((await request('/api/git/stage', { ...data, force: true })).status, 400);
  assert.equal((await request('/api/git/stage', { ...data, root: '' })).status, 400);
  for (const name of ['../elsewhere.txt', '/etc/passwd', '.env', '.git/config'])
    assert.equal((await request('/api/git/stage', { ...data, paths: [name] })).status, 403);
  assert.equal((await request('/api/git/stage', { ...data, expectedIndex: '0'.repeat(64) })).status, 409);
  assert.equal((await request('/api/git/stage', { ...data, expectedBranch: 'other' })).status, 409);
  assert.equal((await request('/api/git/commit', { ...expected(state), message: 'x'.repeat(130 * 1024) })).status, 400);
  assert.equal((await request('/api/git/branches?offset=-1')).status, 400);
  assert.equal((await request('/api/git/history?limit=101')).status, 400);
  assert.equal((await request('/api/git/context?root=unknown')).status, 403);
  assert.equal(await git('rev-parse', 'HEAD'), head);
  assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), index);
  assert.equal(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8'), 'working\n');
}));

test('Git action HTTP stage, unstage, commit and confirmed push operate only on a temporary local remote', () => fixture(async ({ app, root, base, git, gitAt, request, context, expected }) => {
  await fs.writeFile(path.join(root, 'tracked.txt'), 'selected content\n');
  let state = await context();
  assert.equal((await request('/api/git/stage', { paths: ['tracked.txt'], ...expected(state) }, { origin: new URL(app.url).origin })).status, 200);
  assert.equal(await git('diff', '--cached', '--name-only'), 'tracked.txt');
  state = await context();
  assert.equal((await request('/api/git/unstage', { paths: ['tracked.txt'], ...expected(state) })).status, 200);
  assert.equal(await git('diff', '--cached', '--name-only'), '');
  assert.equal(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8'), 'selected content\n');
  state = await context();
  assert.equal((await request('/api/git/stage', { paths: ['tracked.txt'], ...expected(state) })).status, 200);
  state = await context();
  assert.equal(state.commitAllowed, true);
  const committed = await request('/api/git/commit', { message: 'literal $(not-a-shell) `text` 한글\n\nbody', ...expected(state) });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(await git('log', '-1', '--format=%s'), 'literal $(not-a-shell) `text` 한글');
  const head = await git('rev-parse', 'HEAD');
  assert.notEqual(head, state.head);
  assert.equal(await git('status', '--porcelain'), '');
  const remote = path.join(base, 'remote.git');
  await fs.mkdir(remote);
  await gitAt(remote, 'init', '--bare');
  await git('remote', 'add', 'origin', remote);
  state = await context();
  assert.equal(state.remotes[0].name, 'origin');
  const push = { remote: 'origin', branch: 'main', expectedHead: state.head, expectedBranch: state.branch, expectedPushToken: state.pushToken, setUpstream: true };
  assert.notEqual((await request('/api/git/push', { ...push, confirmed: false })).status, 200);
  await assert.rejects(gitAt(remote, 'rev-parse', '--verify', 'refs/heads/main'));
  const pushed = await request('/api/git/push', { ...push, confirmed: true });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
  assert.equal(await gitAt(remote, 'rev-parse', 'refs/heads/main'), head);
  const branches = await request('/api/git/branches?limit=1');
  assert.equal(branches.status, 200);
  assert.equal(branches.body.entries[0].current, true);
  const history = await request('/api/git/history?limit=1');
  assert.equal(history.body.entries[0].hash, head);
  assert.equal(history.body.more, true);
  const next = await request('/api/git/history?limit=1&offset=1');
  assert.notEqual(next.body.entries[0].hash, head);
  // Advance the temporary bare remote independently; an ordinary push must reject.
  const other = path.join(base, 'other');
  await gitAt(base, 'clone', '--branch', 'main', remote, other);
  await gitAt(other, 'config', 'user.name', 'other test');
  await gitAt(other, 'config', 'user.email', 'other@example.invalid');
  await fs.writeFile(path.join(other, 'other.txt'), 'independent commit\n');
  await gitAt(other, 'add', 'other.txt');
  await gitAt(other, 'commit', '-m', 'remote advanced');
  await gitAt(other, 'push', 'origin', 'main');
  const remoteHead = await gitAt(remote, 'rev-parse', 'refs/heads/main');
  const rejected = await request('/api/git/push', { ...push, confirmed: true });
  assert.notEqual(rejected.status, 200);
  assert.equal(await gitAt(remote, 'rev-parse', 'refs/heads/main'), remoteHead);
  assert.equal(await git('rev-parse', 'HEAD'), head);
  assert.equal(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8'), 'selected content\n');
}));

test('subdirectory roots can view history but cannot mutate their enclosing repository', () => fixture(async ({ root, git, request, context, expected }) => {
  const child = path.join(root, 'selected');
  await fs.mkdir(child);
  await fs.writeFile(path.join(child, 'note.txt'), 'before\n');
  await git('add', 'selected/note.txt');
  await git('commit', '-m', 'child fixture');
  await fs.writeFile(path.join(child, 'note.txt'), 'after\n');
  const registration = await request('/api/roots', { operation: 'add', id: 'child', name: '선택 폴더', path: child });
  assert.equal(registration.status, 200);
  const state = await context('child');
  assert.equal(state.available, true);
  assert.equal(state.canWrite, false);
  assert.equal((await request('/api/git/history?root=child')).status, 200);
  const index = await fs.readFile(path.join(root, '.git/index'));
  const result = await request('/api/git/stage', { paths: ['note.txt'], ...expected(state) }, { rootId: 'child' });
  assert.equal(result.status, 403);
  assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), index);
}));
