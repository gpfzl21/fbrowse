import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createGitService } from '../lib/git.mjs';

const execute = promisify(execFile);
async function fixture(callback) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-git-test-'));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  await fs.mkdir(root);
  await fs.mkdir(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@invalid' });
  const git = async (...args) => (await execute('git', args, { cwd: root, env, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const write = async (name, data) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), data);
  };
  const commit = async () => { await git('add', '--all'); await git('commit', '-qm', 'fixture'); };
  try {
    await git('init', '-q', '--initial-branch=main');
    await callback({ base, root, home, git, write, commit, service: createGitService() });
  } finally { await fs.rm(base, { force: true, recursive: true }); }
}
function byPath(status) { return Object.fromEntries(status.entries.map(entry => [entry.path, entry])); }
function savedEnv(changes) {
  const old = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
}

test('Git service in isolated real repositories', async t => {
  await t.test('unborn branch, staged/unstaged/untracked content, cache and index preservation', () => fixture(async ({ root, git, write, service }) => {
    await write('draft.txt', 'untracked\n');
    let value = await service.status(root);
    assert.equal(value.available, true);
    assert.equal(value.branch, 'main');
    assert.equal(value.detached, false);
    assert.equal(byPath(value)['draft.txt'].status, 'U');
    assert.equal((await service.diff(root, 'draft.txt')).text, 'untracked\n');
    await git('add', '--', 'draft.txt');
    await write('draft.txt', 'working\n');
    assert.equal(byPath(await service.status(root))['draft.txt'].untracked, true);
    const refreshed = await service.status(root, { refresh: true });
    assert.equal(byPath(refreshed)['draft.txt'].index, 'A');
    assert.equal(byPath(refreshed)['draft.txt'].worktree, 'M');
    const indexBefore = await fs.readFile(path.join(root, '.git/index'));
    const staged = await service.diff(root, 'draft.txt', { staged: true });
    assert.equal(staged.kind, 'diff');
    assert.match(staged.text, /\+untracked/);
    assert.doesNotMatch(staged.text, /working/);
    const working = await service.diff(root, 'draft.txt');
    assert.match(working.text, /-untracked/);
    assert.match(working.text, /\+working/);
    const values = await Promise.all(Array.from({ length: 12 }, () => service.status(root, { refresh: true })));
    assert.ok(values.every(item => item === values[0]));
    assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), indexBefore);
    assert.equal((await fs.readdir(path.join(root, '.git'))).includes('index.lock'), false);
  }));

  await t.test('root-relative names, NUL records, ignored/hidden/excluded names and literal pathspecs', () => fixture(async ({ root, git, write, commit, service }) => {
    const odd = ['space name.txt', '한글😀.txt', 'quote"name.txt', 'new\nline.txt', 'tab\tname.txt', '-leading.txt', ':(glob)*.txt'];
    for (const name of odd) await write(`selected/${name}`, 'before\n');
    await write('elsewhere/secret.txt', 'outside selected root\n');
    await write('.gitignore', '*.ignored\n');
    await commit();
    for (const name of odd) await write(`selected/${name}`, 'after\n');
    await write('elsewhere/secret.txt', 'outside change\n');
    await write('selected/.hidden', 'hidden\n');
    await write('selected/cache.ignored', 'ignored\n');
    await write('selected/node_modules/dependency', 'excluded\n');
    const selected = path.join(root, 'selected');
    const value = await service.status(selected);
    assert.equal(value.available, true);
    assert.deepEqual(new Set(value.entries.map(entry => entry.path)), new Set([...odd, '.hidden']));
    assert.equal(value.entries.every(entry => entry.index === ' ' || entry.untracked), true);
    for (const name of odd) {
      const result = await service.diff(selected, name);
      assert.equal(result.kind, 'diff', name);
      assert.match(result.text, /-before\n\+after/);
      assert.doesNotMatch(result.text, /outside change/);
    }
    assert.equal((await service.diff(selected, '.hidden')).kind, 'text');
    assert.equal((await service.diff(selected, 'cache.ignored')).kind, 'unavailable');
    for (const name of ['../elsewhere/secret.txt', '/etc/passwd', 'node_modules/dependency', '.git/config', 'x/../space name.txt', 'x\\y', 'a\0b', '']) {
      assert.equal((await service.diff(selected, name)).kind, 'unavailable', JSON.stringify(name));
    }
    assert.equal((await service.status(root)).entries.some(entry => entry.path === 'elsewhere/secret.txt'), true);
    await git('add', '--', 'selected');
  }));

  await t.test('linked worktrees, nested repositories and detached HEAD', () => fixture(async ({ root, base, git, write, commit, service }) => {
    await write('file', 'before\n');
    await commit();
    const worktree = path.join(base, 'worktree');
    await git('worktree', 'add', '-q', '--detach', worktree);
    await fs.writeFile(path.join(worktree, 'file'), 'worktree\n');
    const value = await service.status(worktree);
    assert.equal(value.available, true);
    assert.equal(value.detached, true);
    assert.equal(value.branch, null);
    assert.deepEqual(value.entries.map(entry => entry.path), ['file']);
    assert.match((await service.diff(worktree, 'file')).text, /\+worktree/);
    assert.deepEqual((await service.status(root)).entries, []);
    const nested = path.join(root, 'nested');
    await fs.mkdir(nested);
    await git('-C', nested, 'init', '-q', '--initial-branch=inner');
    await fs.writeFile(path.join(nested, 'own'), 'nested\n');
    const inner = await service.status(nested);
    assert.equal(inner.branch, 'inner');
    assert.deepEqual(inner.entries.map(entry => entry.path), ['own']);
  }));

  await t.test('renames, deleted files and selected-root rename source confinement', () => fixture(async ({ root, git, write, commit, service }) => {
    await write('selected/old name', 'rename content\n');
    await write('selected/deleted', 'deleted content\n');
    await write('outside', 'outside original SECRET\n');
    await commit();
    await git('mv', '--', 'selected/old name', 'selected/new\nname');
    await git('mv', '--', 'outside', 'selected/entered');
    await fs.unlink(path.join(root, 'selected/deleted'));
    const selected = path.join(root, 'selected');
    const entries = byPath(await service.status(selected));
    assert.equal(entries['new\nname'].original_path, 'old name');
    assert.equal(entries['new\nname'].status, 'R');
    assert.equal(entries.entered.original_path, undefined);
    assert.equal(entries.deleted.status, 'D');
    assert.match((await service.diff(selected, 'deleted')).text, /-deleted content/);
    const renamed = await service.diff(selected, 'new\nname', { staged: true });
    assert.equal(renamed.kind, 'diff');
    assert.match(renamed.text, /rename from "old name"/);
    const entered = await service.diff(selected, 'entered', { staged: true });
    assert.doesNotMatch(entered.text, /rename from.*outside/);
    await git('add', '--', 'selected/deleted');
    assert.match((await service.diff(selected, 'deleted', { staged: true })).text, /-deleted content/);
    assert.equal((await service.diff(selected, 'deleted')).kind, 'empty');
  }));

  await t.test('conflicted entries and conflict worktree diff', () => fixture(async ({ root, git, write, commit, service }) => {
    await write('conflict', 'base\n'); await commit();
    await git('checkout', '-qb', 'other');
    await write('conflict', 'theirs\n'); await commit();
    await git('checkout', '-q', 'main');
    await write('conflict', 'ours\n'); await commit();
    await assert.rejects(git('merge', '--no-edit', 'other'));
    const entry = byPath(await service.status(root)).conflict;
    assert.equal(entry.conflict, true);
    assert.equal(entry.status, '!');
    assert.equal(entry.index, 'U');
    const result = await service.diff(root, 'conflict');
    assert.equal(result.kind, 'diff');
    assert.match(result.text, /<<<<<<< HEAD/);
    assert.equal((await service.diff(root, 'conflict', { staged: true })).kind, 'unavailable');
  }));

  await t.test('symlink leaf contents, broken/outside targets and blocked symlink parents', () => fixture(async ({ root, base, write, git, commit, service }) => {
    await write('target', 'inside secret\n');
    await write('directory/file', 'tracked child\n');
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'file'), 'EXTERNAL_CONTENT_SECRET\n');
    await fs.symlink('target', path.join(root, 'link'));
    await commit();
    await fs.unlink(path.join(root, 'link'));
    await fs.symlink(path.join(outside, 'file'), path.join(root, 'link'));
    await fs.symlink(path.join(outside, 'file'), path.join(root, 'outside-link'));
    await fs.symlink('missing-target', path.join(root, 'broken-link'));
    await fs.symlink('directory', path.join(root, 'directory-alias'));
    await fs.rm(path.join(root, 'directory'), { recursive: true });
    await fs.symlink(outside, path.join(root, 'directory'));
    const link = await service.diff(root, 'link');
    assert.equal(link.kind, 'diff');
    assert.match(link.text, /-target/);
    assert.ok(link.text.includes(outside));
    assert.doesNotMatch(link.text, /EXTERNAL_CONTENT_SECRET|inside secret/);
    assert.equal((await service.diff(root, 'outside-link')).text, path.join(outside, 'file'));
    assert.equal((await service.diff(root, 'broken-link')).text, 'missing-target');
    assert.equal((await service.diff(root, 'directory/file')).kind, 'unavailable');
    assert.equal((await service.diff(root, 'directory-alias/file')).kind, 'unavailable');
    await git('add', '--', 'link');
    const staged = await service.diff(root, 'link', { staged: true });
    assert.match(staged.text, /-target/);
    assert.doesNotMatch(staged.text, /EXTERNAL_CONTENT_SECRET/);
    const originalRoot = path.join(base, 'moved');
    await fs.rename(root, originalRoot);
    await fs.symlink(originalRoot, root);
    assert.equal((await service.diff(root, 'target')).kind, 'unavailable');
    assert.equal((await service.status(root, { refresh: true })).available, false);
  }));

  await t.test('binary, large text and bounded diff/status outputs', () => fixture(async ({ root, write, git, commit, service }) => {
    await write('binary', Buffer.from([0, 1, 2, 3]));
    await write('large', 'old\n');
    await write('diff-output', Array.from({ length: 90000 }, (_, i) => `old ${i}\n`).join(''));
    await commit();
    await write('binary', Buffer.from([0, 1, 9]));
    await write('untracked-binary', Buffer.from([0, 2]));
    await write('large', 'x'.repeat(2 * 1024 * 1024));
    await write('untracked-large', 'x'.repeat(256 * 1024));
    await write('unicode-large', '€'.repeat(50000));
    await write('diff-output', Array.from({ length: 90000 }, (_, i) => `new ${i}\n`).join(''));
    assert.equal((await service.diff(root, 'binary')).kind, 'binary');
    assert.equal((await service.diff(root, 'untracked-binary')).kind, 'binary');
    assert.equal((await service.diff(root, 'large')).truncated, true);
    const untracked = await service.diff(root, 'untracked-large');
    assert.equal(untracked.kind, 'text');
    assert.equal(untracked.truncated, true);
    assert.equal(Buffer.byteLength(untracked.text), 128 * 1024);
    const unicode = await service.diff(root, 'unicode-large');
    assert.equal(unicode.kind, 'text');
    assert.equal(unicode.truncated, true);
    assert.equal(unicode.text.includes('\ufffd'), false);
    assert.ok(Buffer.byteLength(unicode.text) <= 128 * 1024);
    const largeDiff = await service.diff(root, 'diff-output');
    assert.equal(largeDiff.kind, 'diff');
    assert.equal(largeDiff.truncated, true);
    assert.ok(Buffer.byteLength(largeDiff.text) <= 1024 * 1024);
    assert.match(largeDiff.text, /@@/);
    const directory = path.join(root, 'many');
    await fs.mkdir(directory);
    await Promise.all(Array.from({ length: 10020 }, (_, i) => fs.writeFile(path.join(directory, String(i).padStart(5, '0')), '')));
    const countBound = await service.status(root, { refresh: true });
    assert.equal(countBound.available, true);
    assert.equal(countBound.truncated, true);
    assert.equal(countBound.entries.length, 10000);
    await Promise.all(Array.from({ length: 10020 }, (_, i) => fs.rename(path.join(directory, String(i).padStart(5, '0')),
      path.join(directory, `${String(i).padStart(5, '0')}-${'x'.repeat(210)}`))));
    const status = await service.status(root, { refresh: true });
    assert.equal(status.available, true);
    assert.equal(status.truncated, true);
    assert.ok(status.entries.length <= 10000);
    assert.ok(status.entries.every(entry => !entry.path.startsWith('many/') || entry.path.endsWith('x'.repeat(210))));
    await git('status', '--porcelain');
  }));

  await t.test('racing parent-directory replacement cannot expose external file contents', () => fixture(async ({ root, base, write, commit, service }) => {
    await write('changing/file', 'inside\n'); await commit();
    await write('changing/file', 'inside modified\n');
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'file'), 'RACE_EXTERNAL_SECRET\n');
    const changing = path.join(root, 'changing'), parked = path.join(root, 'parked');
    let stop = false;
    const swaps = (async () => {
      while (!stop) {
        await fs.rename(changing, parked);
        await fs.symlink(outside, changing);
        await new Promise(resolve => setImmediate(resolve));
        await fs.unlink(changing);
        await fs.rename(parked, changing);
      }
    })();
    try {
      for (let i = 0; i < 30; i++) {
        const value = await service.diff(root, 'changing/file');
        assert.doesNotMatch(value.text, /RACE_EXTERNAL_SECRET/);
        assert.ok(['diff', 'empty', 'unavailable'].includes(value.kind));
      }
    } finally { stop = true; await swaps; }
    assert.match((await service.diff(root, 'changing/file')).text, /\+inside modified/);
  }));

  await t.test('Git environment sanitization, no external drivers/hooks, and no index/config writes', () => fixture(async ({ root, base, git, write, commit, service }) => {
    await write('file', 'before\n');
    await write('.gitattributes', 'file diff=evil filter=evil\n');
    await commit();
    const marker = path.join(base, 'executed');
    const script = path.join(base, 'helper');
    await fs.writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    await git('config', 'diff.evil.command', script);
    await git('config', 'diff.evil.textconv', script);
    await git('config', 'core.fsmonitor', script);
    await git('config', 'filter.evil.clean', script);
    await git('config', 'filter.evil.smudge', script);
    await git('config', 'filter.evil.process', script);
    await git('config', 'filter.evil.required', 'true');
    await fs.writeFile(path.join(root, '.git/hooks/post-index-change'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    const beforeIndex = await fs.readFile(path.join(root, '.git/index'));
    const beforeConfig = await fs.readFile(path.join(root, '.git/config'));
    await write('file', 'after\n');
    const restore = savedEnv({ GIT_DIR: '/not-a-repository', GIT_WORK_TREE: base,
      GIT_INDEX_FILE: path.join(base, 'wrong-index'), GIT_EXTERNAL_DIFF: script, GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: script, GIT_TRACE: marker,
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=bad'", GIT_OBJECT_DIRECTORY: base });
    try {
      const value = await service.status(root);
      assert.equal(value.available, true);
      assert.match(value.message, /필터/);
      assert.match((await service.diff(root, 'file')).text, /\+after/);
      assert.equal((await service.diff(root, 'file', { staged: true })).kind, 'empty');
    } finally { restore(); }
    await assert.rejects(fs.access(marker));
    await assert.rejects(fs.access(path.join(base, 'wrong-index')));
    assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), beforeIndex);
    assert.deepEqual(await fs.readFile(path.join(root, '.git/config')), beforeConfig);
  }));

  await t.test('graceful non-repository, unavailable Git and bounded timeout', () => fixture(async ({ root, base, service, write }) => {
    const plain = path.join(base, 'plain');
    await fs.mkdir(plain);
    assert.equal((await service.status(plain)).reason, 'not_repository');
    assert.equal((await service.diff(plain, 'file')).kind, 'unavailable');
    let restore = savedEnv({ PATH: '/no/git/here' });
    try {
      const missing = createGitService();
      assert.equal((await missing.status(root)).reason, 'git_unavailable');
      assert.equal((await missing.diff(root, 'file')).kind, 'unavailable');
    } finally { restore(); }
    const executables = path.join(base, 'bin');
    await fs.mkdir(executables);
    // exec replaces the shim so timeout kills the actual process without children.
    await fs.writeFile(path.join(executables, 'git'), '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o700 });
    restore = savedEnv({ PATH: executables });
    try {
      const start = Date.now();
      const value = await createGitService().status(root);
      assert.equal(value.reason, 'timeout');
      assert.ok(Date.now() - start < 6500);
    } finally { restore(); }
    await write('file', 'still works\n');
    assert.equal((await createGitService().status(root)).available, true);
  }));
});
