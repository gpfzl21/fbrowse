import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitActions } from '../lib/git-actions.mjs';

const execute = promisify(execFile);
function replaceEnv(changes) {
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
const expected = context => ({ expectedHead: context.head, expectedBranch: context.branch, expectedIndex: context.indexToken, expectedPushToken: context.pushToken });
const rejection = (status, pattern) => error => {
  assert.equal(error.status, status, error.message);
  assert.match(error.message, /[가-힣]/);
  if (pattern) assert.match(error.message, pattern);
  return true;
};

async function fixture(callback) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-git-actions-'));
  const root = path.join(base, 'repo'), home = path.join(base, 'home');
  await fs.mkdir(root);
  await fs.mkdir(home);
  const restoreEnv = replaceEnv({ HOME: home, XDG_CONFIG_HOME: home });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const at = async (cwd, ...args) => (await execute('git', args, { cwd, env, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const git = (...args) => at(root, ...args);
  const write = async (name, text) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  };
  const script = async (name, body) => {
    await write(name, `#!/bin/sh\n${body}\n`);
    await fs.chmod(path.join(root, name), 0o700);
  };
  const seed = async (name = 'file.txt', text = 'initial\n', message = 'initial') => {
    await write(name, text);
    await git('--literal-pathspecs', 'add', '--', name);
    await git('commit', '-qm', message);
  };
  const bare = async (name = 'remote.git') => {
    const target = path.join(base, name);
    await at(base, 'init', '--bare', '-q', target);
    await git('remote', 'add', name === 'remote.git' ? 'origin' : name.replace('.git', ''), target);
    return target;
  };
  try {
    await git('init', '-q', '--initial-branch=main');
    await git('config', 'user.name', 'Git Actions Test');
    await git('config', 'user.email', 'actions@invalid');
    await git('config', 'commit.gpgsign', 'false');
    await git('config', 'core.autocrlf', 'false');
    await callback({ base, root, home, git, at, write, script, seed, bare, service: createGitActions() });
  } finally { restoreEnv(); await fs.rm(base, { recursive: true, force: true }); }
}

test('Git actions against isolated real repositories and local bare remotes', async t => {
  await t.test('exact API, unborn fingerprints, explicit stage/unstage/commit and worktree preservation', () => fixture(async ({ root, git, write, service }) => {
    assert.deepEqual(Object.keys(service).sort(), ['branches', 'commit', 'context', 'history', 'push', 'stage', 'unstage']);
    let context = await service.context(root);
    assert.equal(context.available, true);
    assert.equal(context.canWrite, true);
    assert.equal(context.head, null);
    assert.equal(context.branch, 'main');
    assert.match(context.indexToken, /^[a-f0-9]{64}$/);
    assert.equal(context.commitAllowed, false);
    assert.equal(context.pushAllowed, false);
    assert.deepEqual(await service.history(root), { entries: [], more: false, offset: 0 });
    await write('first.txt', 'staged\n');
    await write('unrelated.txt', 'keep\n');
    await service.stage(root, { paths: ['first.txt'], ...expected(context) });
    let staged = await service.context(root);
    assert.notEqual(staged.indexToken, context.indexToken);
    assert.equal(staged.commitAllowed, true);
    await write('first.txt', 'working\n');
    await service.unstage(root, { paths: ['first.txt'], ...expected(staged) });
    assert.equal(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), 'working\n');
    assert.equal((await git('ls-files')).trim(), '');
    context = await service.context(root);
    await service.stage(root, { paths: ['first.txt'], ...expected(context) });
    await write('first.txt', 'later working\n');
    staged = await service.context(root);
    const result = await service.commit(root, { message: 'first deliberate commit\n\nbody', ...expected(staged) });
    assert.equal(result.ok, true);
    assert.match(result.hash, /^[a-f0-9]{40,64}$/);
    assert.equal(await git('show', 'HEAD:first.txt'), 'working\n');
    assert.equal(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), 'later working\n');
    assert.equal(await fs.readFile(path.join(root, 'unrelated.txt'), 'utf8'), 'keep\n');
    assert.equal((await git('ls-tree', '--name-only', 'HEAD')).trim(), 'first.txt');
    assert.equal((await service.context(root)).commitAllowed, false);
  }));

  await t.test('tracked unstage preserves staged/working content and unrelated index entries', () => fixture(async ({ root, git, write, seed, service }) => {
    await seed();
    await write('file.txt', 'index\n');
    await write('other.txt', 'other staged\n');
    await git('add', '--', 'file.txt', 'other.txt');
    await write('file.txt', 'worktree\n');
    const context = await service.context(root);
    await service.unstage(root, { paths: ['file.txt'], ...expected(context) });
    assert.equal(await git('show', ':file.txt'), 'initial\n');
    assert.equal(await git('show', ':other.txt'), 'other staged\n');
    assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'worktree\n');
    await fs.unlink(path.join(root, 'file.txt'));
    await service.stage(root, { paths: ['file.txt'], ...expected(await service.context(root)) });
    assert.match(await git('diff', '--cached', '--name-status'), /D\s+file.txt/);
    await service.unstage(root, { paths: ['file.txt'], ...expected(await service.context(root)) });
    assert.equal(await git('show', ':file.txt'), 'initial\n');
    await assert.rejects(fs.stat(path.join(root, 'file.txt')), { code: 'ENOENT' });
  }));

  await t.test('stale HEAD, same-HEAD branch changes, and index fingerprints reject writes', () => fixture(async ({ root, git, write, seed, service }) => {
    await seed();
    await write('file.txt', 'changed\n');
    const first = await service.context(root);
    await git('branch', 'same-head');
    await git('symbolic-ref', 'HEAD', 'refs/heads/same-head');
    await assert.rejects(service.stage(root, { paths: ['file.txt'], ...expected(first) }), rejection(409, /변경/));
    const second = await service.context(root);
    await git('add', '--', 'file.txt');
    await assert.rejects(service.commit(root, { message: 'stale index', ...expected(second) }), rejection(409, /변경/));
    const third = await service.context(root);
    await git('commit', '-qm', 'external commit');
    await assert.rejects(service.unstage(root, { paths: ['file.txt'], ...expected(third) }), rejection(409, /변경/));
    await assert.rejects(service.stage(root, { paths: ['file.txt'] }), rejection(400, /확인 정보/));
    assert.equal((await git('log', '--format=%s', '-1')).trim(), 'external commit');
  }));

  await t.test('literal file names, final links, deleted parents, and invalid/outside/directory paths', () => fixture(async ({ base, root, git, write, service }) => {
    const names = ['-option.txt', ':(glob)*.txt', 'name\nline.txt', 'tab\tname.txt', '공백 file.txt'];
    for (const name of names) await write(name, `literal ${name}`);
    await write('folder/inside.txt', 'inside');
    await fs.writeFile(path.join(base, 'external.txt'), 'external private');
    await fs.symlink(path.join(base, 'external.txt'), path.join(root, 'link'));
    await fs.symlink(base, path.join(root, 'outside'));
    await service.stage(root, { paths: [...names, 'link', 'folder/inside.txt'], ...expected(await service.context(root)) });
    assert.match(await git('ls-files', '--stage', '--', 'link'), /^120000 /);
    assert.equal(await git('show', ':link'), path.join(base, 'external.txt'));
    assert.equal(await fs.readFile(path.join(base, 'external.txt'), 'utf8'), 'external private');
    const invalid = [['../external.txt'], ['/etc/passwd'], ['folder/../link'], ['folder//inside.txt'], ['.'], ['folder'], ['outside/external.txt'], ['a\0b'], ['a\\b'], [''], ['.hidden'], ['node_modules/package.json'], ['.git/config'], ['missing.txt'], ['link', 'link'], [], Array(501).fill('link')];
    for (const paths of invalid) {
      await assert.rejects(service.stage(root, { paths, ...expected(await service.context(root)) }), error => {
        assert.ok([400, 403].includes(error.status), `${JSON.stringify(paths.slice(0, 3))}: ${error.message}`);
        return true;
      });
    }
    await service.commit(root, { message: 'literal paths', ...expected(await service.context(root)) });
    await fs.rm(path.join(root, 'folder'), { recursive: true });
    await service.stage(root, { paths: ['folder/inside.txt'], ...expected(await service.context(root)) });
    assert.match(await git('diff', '--cached', '--name-status'), /D\s+folder\/inside.txt/);
    await assert.rejects(service.stage(root, { paths: ['folder'], ...expected(await service.context(root)) }), rejection(403));
    await assert.rejects(service.unstage(root, { paths: ['folder'], ...expected(await service.context(root)) }), rejection(400));
    await write('.gitignore', '*.ignored\n');
    await write('cache.ignored', 'ignored');
    await assert.rejects(service.stage(root, { paths: ['cache.ignored'], ...expected(await service.context(root)) }), rejection(403, /무시/));
  }));

  await t.test('hidden/excluded staged files and hidden rename origins block commit', () => fixture(async ({ root, git, write, seed, service }) => {
    await seed();
    await write('file.txt', 'visible');
    await write('.secret', 'hidden');
    await git('add', '--', 'file.txt', '.secret');
    let context = await service.context(root);
    assert.equal(context.commitAllowed, false);
    assert.match(context.commitReason, /숨기거나 제외/);
    await assert.rejects(service.commit(root, { message: 'hidden', ...expected(context) }), rejection(409, /숨기거나 제외/));
    const showing = createGitActions({ showHidden: true });
    assert.equal((await showing.context(root)).commitAllowed, true);
    await showing.commit(root, { message: 'include visible hidden', ...expected(await showing.context(root)) });
    await git('mv', '--', '.secret', 'renamed.txt');
    context = await service.context(root);
    assert.equal(context.commitAllowed, false);
    await git('restore', '--staged', '--source=HEAD', '--', '.secret', 'renamed.txt');
    await write('node_modules/dependency', 'excluded');
    await git('add', '--force', '--', 'node_modules/dependency');
    assert.equal((await showing.context(root)).commitAllowed, false);
  }));

  await t.test('rename stage/unstage uses only explicit paths and preserves worktree', () => fixture(async ({ root, git, write, seed, service }) => {
    await seed('old.txt', 'rename contents\n');
    await fs.rename(path.join(root, 'old.txt'), path.join(root, 'new.txt'));
    await service.stage(root, { paths: ['old.txt', 'new.txt'], ...expected(await service.context(root)) });
    assert.match(await git('diff', '--cached', '--name-status'), /R100\s+old.txt\s+new.txt/);
    await write('untouched.txt', 'keep');
    await service.unstage(root, { paths: ['old.txt', 'new.txt'], ...expected(await service.context(root)) });
    assert.equal((await git('diff', '--cached', '--name-only')).trim(), '');
    assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'rename contents\n');
    await assert.rejects(fs.stat(path.join(root, 'old.txt')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(root, 'untouched.txt'), 'utf8'), 'keep');
  }));

  await t.test('top-level scope, canonical roots, missing Git and non-repository reads', () => fixture(async ({ base, root, write, seed, service }) => {
    await seed('sub/file.txt');
    const sub = path.join(root, 'sub');
    const context = await service.context(sub);
    assert.equal(context.available, true);
    assert.equal(context.canWrite, false);
    assert.equal(context.commitAllowed, false);
    assert.equal(context.pushAllowed, false);
    assert.match(context.commitReason, /최상위/);
    await write('sub/file.txt', 'changed');
    for (const method of ['stage', 'unstage', 'commit', 'push'])
      await assert.rejects(service[method](sub, { paths: ['file.txt'], message: 'no', ...expected(context) }), rejection(403, /최상위/));
    await fs.symlink(root, path.join(base, 'alias'));
    assert.equal((await service.context(path.join(base, 'alias'))).available, false);
    assert.equal((await service.context(base)).reason, 'not_repository');
    assert.equal((await service.history(base)).available, false);
    assert.equal((await service.branches(base)).available, false);
    const restore = replaceEnv({ PATH: '' });
    try { assert.equal((await service.context(root)).reason, 'git_unavailable'); }
    finally { restore(); }
  }));

  await t.test('on-demand bounded branches/history, subtree history, no hooks/filters/fsmonitor for reads', () => fixture(async ({ root, git, write, script, seed, service }) => {
    await seed('sub/file.txt', 'one', 'sub initial');
    await seed('outside.txt', 'outside', 'outside only');
    await seed('sub/file.txt', 'two', 'sub second');
    await seed('other.txt', 'other', 'other only');
    await git('branch', 'alpha');
    await git('branch', 'zeta');
    await script('.git/hooks/fsmonitor-watchman', 'touch read-helper-ran; echo token');
    await git('config', 'core.fsmonitor', '.git/hooks/fsmonitor-watchman');
    await script('.git/filter', 'touch read-filter-ran; cat');
    await git('config', 'filter.monitor.clean', path.join(root, '.git/filter'));
    await write('.gitattributes', '*.txt filter=monitor\n');
    const before = await fs.readFile(path.join(root, '.git/index'));
    const first = await service.branches(root, { limit: 2 });
    assert.deepEqual(first.entries.map(entry => entry.name), ['alpha', 'main']);
    assert.equal(first.more, true);
    assert.equal(first.entries[1].current, true);
    const second = await service.branches(root, { offset: 2, limit: 2 });
    assert.deepEqual(second.entries.map(entry => entry.fullName), ['refs/heads/zeta']);
    assert.equal(second.more, false);
    const log = await service.history(root, { limit: 2 });
    assert.deepEqual(log.entries.map(entry => entry.subject), ['other only', 'sub second']);
    assert.equal(log.more, true);
    assert.equal((await service.history(root, { offset: 2, limit: 2 })).more, false);
    const sub = await service.history(path.join(root, 'sub'));
    assert.deepEqual(sub.entries.map(entry => entry.subject), ['sub second', 'sub initial']);
    assert.match(sub.entries[0].date, /^\d{4}-\d\d-\d\dT/);
    assert.equal((await service.context(root)).available, true);
    assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), before);
    for (const marker of ['read-helper-ran', 'read-filter-ran']) await assert.rejects(fs.stat(path.join(root, marker)), { code: 'ENOENT' });
    for (const options of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 10001 }, { offset: '1' }, null])
      await assert.rejects(service.history(root, options), rejection(400));
    await assert.rejects(service.branches(root, { limit: Infinity }), rejection(400));
  }));

  await t.test('deliberate writes honor normal filters, hooks, identity and signing configuration', () => fixture(async ({ root, home, git, write, script, service }) => {
    await git('config', '--unset', 'user.name');
    await git('config', '--unset', 'user.email');
    await write('file.txt', 'hello filter\n');
    await script('.git/clean-filter', 'tr a-z A-Z');
    await git('config', 'filter.upper.clean', path.join(root, '.git/clean-filter'));
    await write('.gitattributes', '*.txt filter=upper\n');
    await service.stage(root, { paths: ['file.txt'], ...expected(await service.context(root)) });
    assert.equal(await git('show', ':file.txt'), 'HELLO FILTER\n');
    const restore = replaceEnv({ GIT_AUTHOR_NAME: 'Injected', GIT_AUTHOR_EMAIL: 'injected@invalid', GIT_COMMITTER_NAME: 'Injected', GIT_COMMITTER_EMAIL: 'injected@invalid' });
    try {
      await assert.rejects(service.commit(root, { message: 'missing identity', ...expected(await service.context(root)) }), rejection(409, /사용자/));
    } finally { restore(); }
    await fs.writeFile(path.join(home, '.gitconfig'), '[user]\n name = Existing Global User\n email = existing@invalid\n');
    await script('.git/hooks/pre-commit', 'echo hook-called > .git/hook-marker');
    const result = await service.commit(root, { message: 'normal global identity', ...expected(await service.context(root)) });
    assert.equal(result.ok, true);
    assert.equal((await git('show', '-s', '--format=%an <%ae>', 'HEAD')).trim(), 'Existing Global User <existing@invalid>');
    assert.equal((await fs.readFile(path.join(root, '.git/hook-marker'), 'utf8')).trim(), 'hook-called');
    await write('file.txt', 'second filter\n');
    await service.stage(root, { paths: ['file.txt'], ...expected(await service.context(root)) });
    await script('.git/hooks/pre-commit', 'echo "secret https://user:password@host/?token=private" >&2; exit 1');
    await assert.rejects(service.commit(root, { message: 'hook rejects', ...expected(await service.context(root)) }), error => {
      assert.equal(error.status, 409);
      assert.doesNotMatch(error.message, /secret|password|private|https:/);
      return true;
    });
    await fs.unlink(path.join(root, '.git/hooks/pre-commit'));
    await git('config', 'commit.gpgsign', 'true');
    await script('.git/signing', 'echo signing-called > .git/signing-marker; exit 1');
    await git('config', 'gpg.program', path.join(root, '.git/signing'));
    await assert.rejects(service.commit(root, { message: 'do not bypass signing', ...expected(await service.context(root)) }), rejection(409));
    assert.equal((await fs.readFile(path.join(root, '.git/signing-marker'), 'utf8')).trim(), 'signing-called');
    assert.equal((await service.context(root)).commitAllowed, true);
  }));

  await t.test('ambient Git overrides cannot redirect reads, identity, index or writes', () => fixture(async ({ base, root, git, write, seed, service }) => {
    await seed();
    await write('file.txt', 'changed\n');
    const alternateIndex = path.join(base, 'alternate-index');
    const restore = replaceEnv({ GIT_DIR: path.join(base, 'missing'), GIT_WORK_TREE: base, GIT_INDEX_FILE: alternateIndex,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Injected', GIT_TRACE: '1',
      GIT_CONFIG_GLOBAL: path.join(base, 'malicious-config'), GIT_SSH_COMMAND: 'false' });
    try {
      const context = await service.context(root);
      assert.equal(context.available, true);
      await service.stage(root, { paths: ['file.txt'], ...expected(context) });
      const result = await service.commit(root, { message: 'normal repository', ...expected(await service.context(root)) });
      assert.equal(result.ok, true);
    } finally { restore(); }
    assert.equal((await git('show', '-s', '--format=%an')).trim(), 'Git Actions Test');
    await assert.rejects(fs.stat(alternateIndex), { code: 'ENOENT' });
  }));

  await t.test('conflicts, merge/rebase/sequencer and detached HEAD block commit', () => fixture(async ({ root, git, write, seed, service }) => {
    await seed();
    await git('checkout', '-qb', 'topic');
    await seed('file.txt', 'topic\n', 'topic');
    await git('checkout', '-q', 'main');
    await seed('file.txt', 'main\n', 'main');
    await assert.rejects(git('merge', '--no-edit', 'topic'));
    const conflict = await service.context(root);
    assert.equal(conflict.commitAllowed, false);
    await assert.rejects(service.commit(root, { message: 'conflicted', ...expected(conflict) }), rejection(409));
    await git('merge', '--abort');
    await write('file.txt', 'staged\n');
    await git('add', '--', 'file.txt');
    for (const dir of ['rebase-merge', 'rebase-apply', 'sequencer']) {
      await fs.mkdir(path.join(root, '.git', dir));
      assert.equal((await service.context(root)).commitAllowed, false);
      await fs.rmdir(path.join(root, '.git', dir));
    }
    await git('checkout', '--detach', '-q');
    const detached = await service.context(root);
    assert.equal(detached.branch, null);
    assert.equal(detached.commitAllowed, false);
    assert.equal(detached.pushAllowed, false);
    await assert.rejects(service.commit(root, { message: 'detached', ...expected(detached) }), rejection(409, /분리/));
  }));

  await t.test('reviewed explicit non-force push and upstream to temporary bare remote only', () => fixture(async ({ root, git, at, write, seed, bare, service }) => {
    await seed();
    const remote = await bare();
    await git('branch', 'unrelated');
    await git('tag', 'untouched-tag');
    await git('config', 'push.followTags', 'true');
    let context = await service.context(root);
    assert.equal(context.pushAllowed, true);
    assert.deepEqual(context.remotes, [{ name: 'origin', url: remote }]);
    const push = { remote: 'origin', branch: 'reviewed', confirmed: true, setUpstream: true, ...expected(context) };
    await assert.rejects(service.push(root, { ...push, confirmed: false }), rejection(400, /명시적/));
    await assert.rejects(service.push(root, { ...push, remote: 'unknown' }), rejection(400));
    await assert.rejects(service.push(root, { ...push, branch: 'bad:branch' }), rejection(400));
    await assert.rejects(service.push(root, { ...push, branch: '+forced' }), rejection(400));
    await assert.rejects(service.push(root, { ...push, branch: '-bad' }), rejection(400));
    const result = await service.push(root, push);
    assert.equal(result.ok, true);
    assert.equal((await at(remote, 'rev-parse', 'refs/heads/reviewed')).trim(), context.head);
    assert.deepEqual((await at(remote, 'for-each-ref', '--format=%(refname)')).trim().split('\n'), ['refs/heads/reviewed']);
    context = await service.context(root);
    assert.deepEqual(context.upstream, { remote: 'origin', branch: 'reviewed' });
    assert.equal(context.ahead, 0);
    assert.equal(context.behind, 0);
    await write('file.txt', 'next\n');
    await service.stage(root, { paths: ['file.txt'], ...expected(context) });
    await service.commit(root, { message: 'next', ...expected(await service.context(root)) });
    context = await service.context(root);
    assert.equal(context.ahead, 1);
    await service.push(root, { remote: 'origin', branch: 'reviewed', confirmed: true, ...expected(context) });
    assert.equal((await at(remote, 'rev-parse', 'refs/heads/reviewed')).trim(), context.head);
  }));

  await t.test('push rejects non-fast-forward without changing local or remote state', () => fixture(async ({ base, root, git, at, seed, bare, service }) => {
    await seed();
    const remote = await bare();
    await service.push(root, { remote: 'origin', branch: 'main', confirmed: true, ...expected(await service.context(root)) });
    const clone = path.join(base, 'other-clone');
    await at(base, 'clone', '-q', '--branch', 'main', remote, clone);
    await at(clone, 'config', 'user.name', 'Remote Writer');
    await at(clone, 'config', 'user.email', 'remote@invalid');
    await fs.writeFile(path.join(clone, 'remote-only.txt'), 'remote');
    await at(clone, 'add', '--', 'remote-only.txt');
    await at(clone, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'remote change');
    await at(clone, 'push', '-q', 'origin', 'main');
    const remoteHead = (await at(remote, 'rev-parse', 'refs/heads/main')).trim();
    await seed('local-only.txt', 'local', 'local change');
    const before = await service.context(root), index = await fs.readFile(path.join(root, '.git/index'));
    await assert.rejects(service.push(root, { remote: 'origin', branch: 'main', confirmed: true, ...expected(before) }), rejection(409, /거절/));
    assert.equal((await git('rev-parse', 'HEAD')).trim(), before.head);
    assert.equal((await at(remote, 'rev-parse', 'refs/heads/main')).trim(), remoteHead);
    assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), index);
  }));

  await t.test('push URL redaction, multiple URLs, mirror, stale review and local auth failure', () => fixture(async ({ root, git, script, seed, bare, service }) => {
    await seed();
    await bare();
    await git('remote', 'set-url', '--push', 'origin', 'https://username:password@invalid.test/repo?token=secret#private');
    let context = await service.context(root);
    assert.deepEqual(context.remotes, [{ name: 'origin', url: 'https://invalid.test/repo' }]);
    await git('config', '--add', 'remote.origin.pushurl', '/temporary-second-url');
    context = await service.context(root);
    assert.equal(context.pushAllowed, false);
    await assert.rejects(service.push(root, { remote: 'origin', branch: 'main', confirmed: true, ...expected(context) }), rejection(400, /정확히 하나/));
    await git('config', '--unset-all', 'remote.origin.pushurl');
    await git('config', 'remote.origin.mirror', 'true');
    context = await service.context(root);
    await assert.rejects(service.push(root, { remote: 'origin', branch: 'main', confirmed: true, ...expected(context) }), rejection(400, /미러/));
    await git('config', 'remote.origin.mirror', 'false');
    await git('branch', 'other');
    await git('symbolic-ref', 'HEAD', 'refs/heads/other');
    await assert.rejects(service.push(root, { remote: 'origin', branch: 'main', confirmed: true, ...expected(context) }), rejection(409, /변경/));
    await script('.git/local-auth-failure', 'test "$GIT_TERMINAL_PROMPT" = 0 || exit 2\ntest "$GCM_INTERACTIVE" = never || exit 2\ntest "$GIT_ASKPASS" = /bin/false || exit 2\ncase "$GIT_SSH_COMMAND" in *BatchMode=yes*) ;; *) exit 2;; esac\necho auth-env-checked > .git/auth-marker\necho "Authentication failed https://user:password@host/?token=private" >&2\nexit 1');
    await git('config', 'remote.origin.receivepack', path.join(root, '.git/local-auth-failure'));
    await assert.rejects(service.push(root, { remote: 'origin', branch: 'main', confirmed: true, ...expected(await service.context(root)) }), error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /자격 증명/);
      assert.doesNotMatch(error.message, /password|private|https:/);
      return true;
    });
    assert.equal((await fs.readFile(path.join(root, '.git/auth-marker'), 'utf8')).trim(), 'auth-env-checked');
  }));

  await t.test('effective global includes and URL rewrites are reviewed; destination drift invalidates push token', () => fixture(async ({ base, root, home, git, at, seed, bare, service }) => {
    await seed();
    const first = await bare();
    const second = path.join(base, 'second.git');
    await at(base, 'init', '--bare', '-q', second);
    const included = path.join(home, 'included-config');
    await fs.writeFile(path.join(home, '.gitconfig'), `[include]\n path = ${included}\n`);
    await fs.writeFile(included, `[url "${first}"]\n pushInsteadOf = fbrowse-local:reviewed\n`);
    await git('remote', 'set-url', 'origin', 'fbrowse-local:reviewed');
    const firstReview = await service.context(root);
    assert.deepEqual(firstReview.remotes, [{ name: 'origin', url: first }]);
    assert.match(firstReview.pushToken, /^[a-f0-9]{64}$/);
    await assert.rejects(service.push(root, { remote: 'origin', branch: 'main', confirmed: true,
      expectedHead: firstReview.head, expectedBranch: firstReview.branch }), rejection(400, /검토 정보/));
    await service.push(root, { remote: 'origin', branch: 'main', confirmed: true, ...expected(firstReview) });
    assert.equal((await at(first, 'rev-parse', 'refs/heads/main')).trim(), firstReview.head);
    await fs.writeFile(included, `[url "${second}"]\n pushInsteadOf = fbrowse-local:reviewed\n`);
    await assert.rejects(service.push(root, { remote: 'origin', branch: 'main', confirmed: true, ...expected(firstReview) }), rejection(409, /설정이 변경/));
    assert.equal((await at(second, 'for-each-ref')).trim(), '');
    const nextReview = await service.context(root);
    assert.deepEqual(nextReview.remotes, [{ name: 'origin', url: second }]);
    assert.notEqual(nextReview.pushToken, firstReview.pushToken);
    await service.push(root, { remote: 'origin', branch: 'main', confirmed: true, ...expected(nextReview) });
    assert.equal((await at(second, 'rev-parse', 'refs/heads/main')).trim(), nextReview.head);
    // Identical redacted URLs must still fingerprint different credentials.
    await git('remote', 'set-url', '--push', 'origin', 'https://name:one@invalid.test/repo?token=first');
    const secretReview = await service.context(root);
    await git('remote', 'set-url', '--push', 'origin', 'https://name:two@invalid.test/repo?token=second');
    const secretChanged = await service.context(root);
    assert.equal(secretReview.remotes[0].url, secretChanged.remotes[0].url);
    assert.notEqual(secretReview.pushToken, secretChanged.pushToken);
    await assert.rejects(service.push(root, { remote: 'origin', branch: 'main', confirmed: true, ...expected(secretReview) }), rejection(409, /설정이 변경/));
  }));

  await t.test('core.worktree redirection cannot grant selected-root writes outside the repository', () => fixture(async ({ base, root, home, git, write, seed, service }) => {
    await seed();
    await write('file.txt', 'selected change');
    const context = await service.context(root);
    const external = path.join(base, 'outside-worktree');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'file.txt'), 'outside untouched');
    await fs.writeFile(path.join(home, '.gitconfig'), `[core]\n worktree = ${external}\n`);
    // Git ignores global core.worktree during repository setup on some versions;
    // explicit write anchors still keep that configuration from redirecting add.
    const globalContext = await service.context(root);
    if (globalContext.canWrite) {
      await service.stage(root, { paths: ['file.txt'], ...expected(globalContext) });
      assert.equal(await git('show', ':file.txt'), 'selected change');
      await service.unstage(root, { paths: ['file.txt'], ...expected(await service.context(root)) });
    } else await assert.rejects(service.stage(root, { paths: ['file.txt'], ...expected(context) }), rejection(403));
    await git('config', 'core.worktree', external);
    assert.equal((await service.context(root)).canWrite, false);
    await assert.rejects(service.stage(root, { paths: ['file.txt'], ...expected(context) }), rejection(403));
    assert.equal(await fs.readFile(path.join(external, 'file.txt'), 'utf8'), 'outside untouched');
    assert.equal((await git('diff', '--cached', '--name-only')).trim(), '');
  }));

  await t.test('unsafe index links and FIFOs fail promptly with redacted Korean errors', () => fixture(async ({ base, root, seed, service }) => {
    await seed();
    const before = await service.context(root), index = path.join(root, '.git/index');
    const external = path.join(base, 'external-index');
    await fs.copyFile(index, external);
    const bytes = await fs.readFile(external);
    await fs.unlink(index);
    await fs.symlink(external, index);
    assert.equal((await service.context(root)).available, false);
    await assert.rejects(service.stage(root, { paths: ['file.txt'], ...expected(before) }), error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /[가-힣]/);
      assert.doesNotMatch(error.message, /ELOOP|external-index|\/tmp\//);
      return true;
    });
    assert.deepEqual(await fs.readFile(external), bytes);
    await fs.unlink(index);
    await execute('mkfifo', [index]);
    const start = Date.now();
    assert.equal((await service.context(root)).available, false);
    assert.ok(Date.now() - start < 2000);
  }));

  await t.test('serialization across instances and linked worktrees; index lock rejection', () => fixture(async ({ base, root, git, at, write, script, seed, service }) => {
    await seed();
    const worktree = path.join(base, 'linked');
    await git('worktree', 'add', '-qb', 'linked-branch', worktree);
    const linkedService = createGitActions();
    assert.equal((await linkedService.context(worktree)).canWrite, true);
    await fs.writeFile(path.join(worktree, 'linked.txt'), 'linked');
    await linkedService.stage(worktree, { paths: ['linked.txt'], ...expected(await linkedService.context(worktree)) });
    await linkedService.commit(worktree, { message: 'worktree commit', ...expected(await linkedService.context(worktree)) });
    assert.equal((await at(worktree, 'log', '-1', '--format=%s')).trim(), 'worktree commit');
    assert.equal((await git('log', '-1', '--format=%s')).trim(), 'initial');
    await write('file.txt', 'staged');
    await service.stage(root, { paths: ['file.txt'], ...expected(await service.context(root)) });
    await script('.git/hooks/pre-commit', 'touch .git/commit-started\nsleep 1');
    const pending = service.commit(root, { message: 'serialized', ...expected(await service.context(root)) });
    for (let i = 0; i < 100; i++) {
      try { await fs.stat(path.join(root, '.git/commit-started')); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    await assert.rejects(linkedService.stage(worktree, { paths: ['linked.txt'], ...expected(await linkedService.context(worktree)) }), rejection(409, /진행 중/));
    await assert.rejects(createGitActions().commit(root, { message: 'double submit', ...expected(await service.context(root)) }), rejection(409, /진행 중/));
    assert.equal((await pending).ok, true);
    await fs.writeFile(path.join(root, '.git/index.lock'), 'external lock');
    await assert.rejects(service.stage(root, { paths: ['file.txt'], ...expected(await service.context(root)) }), rejection(409, /진행 중/));
    assert.equal(await fs.readFile(path.join(root, '.git/index.lock'), 'utf8'), 'external lock');
  }));

  await t.test('output limits terminate hooks, redact secrets, preserve index and allow later work', () => fixture(async ({ root, git, write, script, seed, service }) => {
    await seed();
    await write('file.txt', 'staged');
    await git('add', '--', 'file.txt');
    const before = await service.context(root), stagedBefore = await git('ls-files', '--stage');
    await script('.git/hooks/pre-commit', 'yes secret-output >&2');
    await assert.rejects(service.commit(root, { message: 'overflow', ...expected(before) }), rejection(409, /크기 제한.*일부 적용/s));
    assert.equal((await git('rev-parse', 'HEAD')).trim(), before.head);
    assert.equal(await git('ls-files', '--stage'), stagedBefore);
    await fs.unlink(path.join(root, '.git/hooks/pre-commit'));
    assert.equal((await service.commit(root, { message: 'recover', ...expected(await service.context(root)) })).ok, true);
  }));

  await t.test('local mutation timeout kills hook descendants, reports uncertainty and never retries', () => fixture(async ({ root, git, write, script, seed, service }) => {
    await seed();
    await write('file.txt', 'staged');
    await git('add', '--', 'file.txt');
    const before = await service.context(root), stagedBefore = await git('ls-files', '--stage');
    await script('.git/hooks/pre-commit', 'echo run >> .git/timeout-runs\nsleep 120\ntouch .git/should-never-run');
    const start = Date.now();
    await assert.rejects(service.commit(root, { message: 'timeout', ...expected(before) }), rejection(409, /초과.*자동으로 재시도/s));
    assert.ok(Date.now() - start >= 29000);
    assert.ok(Date.now() - start < 35000);
    assert.equal((await git('rev-parse', 'HEAD')).trim(), before.head);
    assert.equal(await fs.readFile(path.join(root, '.git/timeout-runs'), 'utf8'), 'run\n');
    await assert.rejects(fs.stat(path.join(root, '.git/should-never-run')), { code: 'ENOENT' });
    assert.equal(await git('ls-files', '--stage'), stagedBefore);
  }));

  await t.test('push timeout against local bare hook preserves refs and reports uncertain outcome without retries', () => fixture(async ({ root, git, at, seed, bare, service }) => {
    await seed();
    const remote = await bare();
    const before = await service.context(root);
    const hook = path.join(remote, 'hooks/pre-receive');
    await fs.writeFile(hook, '#!/bin/sh\necho run >> timeout-runs\nsleep 120\nexit 0\n');
    await fs.chmod(hook, 0o700);
    const start = Date.now();
    await assert.rejects(service.push(root, { remote: 'origin', branch: 'main', confirmed: true, ...expected(before) }), rejection(409, /초과.*자동으로 재시도/s));
    assert.ok(Date.now() - start >= 59000);
    assert.ok(Date.now() - start < 65000);
    assert.equal((await git('rev-parse', 'HEAD')).trim(), before.head);
    assert.equal((await at(remote, 'for-each-ref')).trim(), '');
    assert.equal(await fs.readFile(path.join(remote, 'timeout-runs'), 'utf8'), 'run\n');
  }));
});
