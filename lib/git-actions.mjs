import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { inside, visible } from './files.mjs';

const READ_MS = 5000, LOCAL_MS = 30000, PUSH_MS = 60000;
const OUTPUT_LIMIT = 2 * 1024 * 1024, INDEX_LIMIT = 32 * 1024 * 1024;
// Shared across service instances and worktrees, rather than just HTTP requests.
const active = new Set();
const fail = (message, status = 400, reason) => Object.assign(new Error(message), { status, reason });
const messages = {
  not_repository: 'This folder is not a Git repository.',
  git_unavailable: 'Git is not installed or is unavailable.',
  timeout: 'Git response timed out. Refresh and check the status.',
  output_limit: 'Git information exceeded the size limit. Check it in a terminal.',
  error: 'Could not load Git information. Check the repository status in a terminal.',
};

function environment(write) {
  // Preserve the user's normal system/global identity and configuration for an
  // explicit write, but never accept ambient repository/index/config overrides.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never',
    GIT_EDITOR: '/bin/false', GIT_SEQUENCE_EDITOR: '/bin/false',
    GIT_MERGE_AUTOEDIT: 'no', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oNumberOfPasswordPrompts=0 -oStrictHostKeyChecking=yes', LC_ALL: 'C' });
  if (!write) Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: '' });
  return env;
}

function commandError(stderr, write) {
  // Never return raw Git output: hooks, URLs and remote errors can contain secrets.
  if (/index\.lock|another git process|cannot lock ref|unable to create.*\.lock/i.test(stderr))
    return fail('Another Git operation is in progress. Refresh the status when it finishes.', 409);
  if (/author identity unknown|committer identity unknown|unable to auto-detect email|empty ident|ident name.*empty/i.test(stderr))
    return fail('Git user name and email are missing. Configure Git user identity in a terminal.', 409);
  if (/authentication|permission denied|could not read (username|password)|terminal prompts disabled|credential|host key verification|publickey/i.test(stderr))
    return fail('Authentication failed. Configure Git credentials and SSH in a terminal, then try again.', 409);
  if (/non-fast-forward|fetch first|stale info|\[rejected\]/i.test(stderr))
    return fail('Push rejected because the remote branch changed. Check the status in a terminal and refresh.', 409);
  return fail(write ? 'Git operation failed. Check user settings, hooks, filters and repository status in a terminal, then refresh.' : messages.error, 409, 'error');
}

function run(cwd, args, deadline, { write = false, input, accepted = [0], limit = OUTPUT_LIMIT, repo } = {}) {
  return new Promise((resolve, reject) => {
    if (Date.now() >= deadline) return reject(fail(messages.timeout, 409, 'timeout'));
    const safety = write ? ['-c', 'credential.interactive=false'] : [
      '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.untrackedCache=false', '-c', 'core.preloadIndex=false',
      '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=',
      '-c', 'protocol.allow=never', '-c', 'submodule.recurse=false',
    ];
    // A deliberate command uses normal configuration, but its repository and
    // worktree are anchored to the top-level that passed scope validation.
    const scope = repo ? [`--git-dir=${repo.gitdir}`, `--work-tree=${repo.top}`] : [];
    const child = spawn('git', ['--literal-pathspecs', ...scope, ...safety, ...args], {
      cwd, env: environment(write), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    const output = [], errors = [];
    let bytes = 0, errorBytes = 0, reason;
    const kill = why => {
      reason ||= why;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => kill('timeout'), Math.max(1, deadline - Date.now()));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= limit) output.push(chunk); else kill('output_limit');
    });
    child.stderr.on('data', chunk => {
      errorBytes += chunk.length;
      if (errorBytes <= 65536) errors.push(chunk); else kill('output_limit');
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', error => {
      clearTimeout(timer);
      const why = error.code === 'ENOENT' ? 'git_unavailable' : 'error';
      reject(fail(messages[why], 409, why));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (reason) return reject(fail(write ? `${messages[reason]} Some changes may have been applied. Do not retry automatically.` : messages[reason], 409, reason));
      if (!accepted.includes(code)) return reject(commandError(Buffer.concat([...errors, ...output]).toString('utf8'), write));
      resolve({ code, output: Buffer.concat(output).toString('utf8') });
    });
  });
}

async function rootCheck(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw fail('A valid absolute root path is required.', 403);
  try {
    if (await fs.realpath(root) !== root || !(await fs.lstat(root)).isDirectory()) throw new Error();
  } catch { throw fail('The selected root changed or is inaccessible.', 403); }
}

async function repository(root, deadline) {
  await rootCheck(root);
  const result = await run(root, ['rev-parse', '--show-toplevel'], deadline, { accepted: [0, 128] });
  if (result.code) throw fail(messages.not_repository, 403, 'not_repository');
  const top = result.output.replace(/\n$/, '');
  if (!path.isAbsolute(top) || !inside(top, root) || await fs.realpath(top) !== top)
    throw fail('Could not verify the repository root boundary.', 403);
  const gitdir = (await run(root, ['rev-parse', '--absolute-git-dir'], deadline)).output.replace(/\n$/, '');
  const common = (await run(root, ['rev-parse', '--git-common-dir'], deadline)).output.replace(/\n$/, '');
  return { root, top, gitdir: await fs.realpath(gitdir), key: await fs.realpath(path.resolve(root, common)), canWrite: root === top };
}

async function fingerprint(repo, deadline) {
  const branchRef = await run(repo.top, ['symbolic-ref', '-q', 'HEAD'], deadline, { accepted: [0, 1] });
  const ref = branchRef.code ? null : branchRef.output.trimEnd();
  const branch = ref?.startsWith('refs/heads/') ? ref.slice(11) : null;
  const headResult = await run(repo.top, ['rev-parse', '--verify', 'HEAD^{commit}'], deadline, { accepted: [0, 128] });
  const head = headResult.code ? null : headResult.output.trim();
  const index = path.join(repo.gitdir, 'index');
  const digest = createHash('sha256');
  let handle;
  try {
    handle = await fs.open(index, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > INDEX_LIMIT) throw fail(messages.output_limit, 409, 'output_limit');
    const buffer = Buffer.alloc(65536);
    let size = 0;
    while (true) {
      if (Date.now() >= deadline) throw fail(messages.timeout, 409, 'timeout');
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > INDEX_LIMIT) throw fail(messages.output_limit, 409, 'output_limit');
      digest.update(buffer.subarray(0, bytesRead));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    digest.update('fbrowse:missing-index:v1');
  } finally { await handle?.close(); }
  return { head, branch, indexToken: digest.digest('hex') };
}

function redactUrl(value) {
  // Drop userinfo, URL queries/fragments, controls and SCP-style usernames.
  return value.replace(/[\x00-\x1f\x7f]/g, '').replace(/([a-z][a-z\d+.-]*:\/\/)[^/]*@/gi, '$1')
    .replace(/^[^/@]+@(?=[^/]+:)/, '').split(/[?#]/, 1)[0].slice(0, 2048);
}

async function remotesFor(repo, deadline) {
  const names = (await run(repo.top, ['remote'], deadline, { limit: 65536 })).output.split('\n').filter(Boolean);
  if (names.length > 100) throw fail(messages.output_limit, 409, 'output_limit');
  const remotes = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name)) continue;
    const result = await run(repo.top, ['remote', 'get-url', '--push', '--all', name], deadline, { accepted: [0, 2], limit: 65536 });
    const urls = result.code ? [] : result.output.split('\n').filter(Boolean);
    const mirrorResult = await run(repo.top, ['config', '--bool', '--get', `remote.${name}.mirror`], deadline, { accepted: [0, 1] });
    const mirror = !mirrorResult.code && mirrorResult.output.trim() === 'true';
    remotes.push({ name, urls, mirror, url: urls.map(redactUrl).join(' · ') });
  }
  return remotes;
}

function pushFingerprint(remotes) {
  return createHash('sha256').update(JSON.stringify(remotes.map(({ name, urls, mirror }) => ({ name, urls, mirror })))).digest('hex');
}

async function operationReason(repo) {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']) {
    try { await fs.lstat(path.join(repo.gitdir, name)); return 'Complete the ongoing merge, rebase or other Git operation in a terminal first.'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

async function commitBlock(repo, fp, deadline, showHidden) {
  if (!repo.canWrite) return 'Connect the repository top-level folder as a root to make changes.';
  if (!fp.branch) return 'Cannot commit with detached HEAD. Select a branch in a terminal.';
  const pending = await operationReason(repo);
  if (pending) return pending;
  const conflicts = (await run(repo.top, ['ls-files', '--unmerged', '-z'], deadline)).output;
  if (conflicts) return 'Resolve conflicts in a terminal, then try again.';
  const staged = (await run(repo.top, ['diff', '--cached', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', '--'], deadline)).output.split('\0').filter(Boolean);
  if (staged.length > 10000) throw fail(messages.output_limit, 409, 'output_limit');
  if (!staged.length) return 'No staged changes.';
  if (staged.some(name => !validPath(name, showHidden)))
    return 'Hidden or excluded files are staged. Review the staged scope in a terminal.';
  for (const name of staged) {
    if (Date.now() >= deadline) throw fail(messages.timeout, 409, 'timeout');
    try { await checkPath(repo.top, name, { allowMissing: true }); }
    catch { return 'Staged files include symbolic link folders or disallowed paths. Check them in a terminal.'; }
  }
  return null;
}

function validPath(name, showHidden) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes('\0') &&
    !path.isAbsolute(name) && name.split('/').every(part => part && part !== '.' && part !== '..') && visible(name, showHidden);
}

async function checkPath(root, name, { allowMissing = false } = {}) {
  await rootCheck(root);
  const parts = name.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) { if (error.code === 'ENOENT' && allowMissing) return; throw fail('The file is missing or the path is inaccessible.', 403); }
    if (i < parts.length - 1) {
      if (info.isSymbolicLink() || !info.isDirectory() || await fs.realpath(current) !== current)
        throw fail('Symbolic link folders and paths outside the root cannot be modified.', 403);
    } else if (!info.isFile() && !info.isSymbolicLink()) throw fail('Select explicit file paths. Whole-folder operations are unsupported.', 400);
  }
}

function optionsObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid operation input format.');
  return value;
}

function expected(options, fp, index = true) {
  if (!Object.hasOwn(options, 'expectedHead') || !Object.hasOwn(options, 'expectedBranch') ||
      !(options.expectedHead === null || (typeof options.expectedHead === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(options.expectedHead))) ||
      !(options.expectedBranch === null || (typeof options.expectedBranch === 'string' && options.expectedBranch.length <= 1024 && !/[\x00-\x20\x7f]/.test(options.expectedBranch))) ||
      (index && (typeof options.expectedIndex !== 'string' || !/^[a-f\d]{64}$/.test(options.expectedIndex))))
    throw fail('Current HEAD, branch and index verification details are required. Refresh the status.');
  if (options.expectedHead !== fp.head || options.expectedBranch !== fp.branch || (index && options.expectedIndex !== fp.indexToken))
    throw fail('Git status changed due to another operation. Refresh and review it again.', 409);
}

function pageOptions(options, defaultLimit) {
  optionsObject(options);
  const { offset = 0, limit = defaultLimit } = options;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw fail('Query range must be offset 0–10000 and limit 1–100.');
  return { offset, limit };
}

function unavailable(error) {
  const reason = error.reason || 'error';
  return { available: false, reason, message: messages[reason] || messages.error };
}

export function createGitActions({ showHidden = false } = {}) {
  async function context(root) {
    try {
      const deadline = Date.now() + READ_MS, repo = await repository(root, deadline);
      const fp = await fingerprint(repo, deadline);
      const remotes = await remotesFor(repo, deadline);
      const commitReason = await commitBlock(repo, fp, deadline, showHidden);
      let upstream = null, ahead = 0, behind = 0;
      if (fp.branch) {
        const result = await run(repo.top, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', '--', `refs/heads/${fp.branch}`], deadline);
        const [remote, ref] = result.output.trimEnd().split('\0');
        if (remote && ref?.startsWith('refs/heads/')) {
          upstream = { remote, branch: ref.slice(11) };
          const counts = await run(repo.top, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}', '--'], deadline, { accepted: [0, 128] });
          if (!counts.code) [ahead, behind] = counts.output.trim().split(/\s+/).map(Number);
        }
      }
      const pushReason = !repo.canWrite ? 'Connect the repository top-level folder as a root to push.' :
        !fp.branch || !fp.head ? 'Only a local branch with commits can be pushed.' :
          !remotes.some(remote => remote.urls.length === 1 && !remote.mirror) ? 'Configure an existing non-mirror remote with one push URL in a terminal.' : null;
      return { available: true, reason: null,
        message: 'Explicit Git operations use existing user settings, hooks and filters. Editors and interactive authentication are disabled.',
        canWrite: repo.canWrite, ...fp, commitAllowed: !commitReason, commitReason,
        pushAllowed: !pushReason, pushReason, pushToken: pushFingerprint(remotes), remotes: remotes.map(({ name, url }) => ({ name, url })), upstream, ahead, behind };
    } catch (error) {
      return { ...unavailable(error), canWrite: false, branch: null, head: null, indexToken: null,
        commitAllowed: false, commitReason: messages[error.reason] || messages.error,
        pushAllowed: false, pushReason: messages[error.reason] || messages.error, pushToken: null, remotes: [], upstream: null, ahead: 0, behind: 0 };
    }
  }

  async function branches(root, options = {}) {
    const { offset, limit } = pageOptions(options, 50);
    try {
      const deadline = Date.now() + READ_MS, repo = await repository(root, deadline);
      const { branch } = await fingerprint(repo, deadline);
      const result = await run(repo.top, ['for-each-ref', '--sort=refname', `--count=${offset + limit + 1}`,
        '--format=%(refname)%00%(upstream:short)%00%(objectname)%00%(subject)', '--', 'refs/heads/', 'refs/remotes/'], deadline);
      const records = result.output.split('\n').filter(Boolean);
      const entries = records.slice(offset, offset + limit).map(line => {
        const [fullName, upstream, hash, subject] = line.split('\0');
        const remote = fullName.startsWith('refs/remotes/');
        const name = fullName.slice(remote ? 13 : 11);
        return { name, fullName, current: !remote && name === branch, remote, upstream: upstream || null, hash, subject };
      });
      return { entries, more: records.length > offset + limit, offset };
    } catch (error) { return { ...unavailable(error), entries: [], more: false, offset }; }
  }

  async function history(root, options = {}) {
    const { offset, limit } = pageOptions(options, 30);
    try {
      const deadline = Date.now() + READ_MS, repo = await repository(root, deadline);
      const fp = await fingerprint(repo, deadline);
      if (!fp.head) return { entries: [], more: false, offset };
      const result = await run(root, ['log', '--no-show-signature', '--no-decorate', '--no-color', '--no-ext-diff', '--no-textconv',
        `--skip=${offset}`, `--max-count=${limit + 1}`, '--format=%H%x00%h%x00%an%x00%aI%x00%s', 'HEAD', '--', '.'], deadline);
      const records = result.output.split('\n').filter(Boolean);
      const entries = records.slice(0, limit).map(line => {
        const [hash, shortHash, author, date, subject] = line.split('\0');
        return { hash, shortHash, author, date, subject };
      });
      return { entries, more: records.length > limit, offset };
    } catch (error) { return { ...unavailable(error), entries: [], more: false, offset }; }
  }

  async function mutation(root, options, push, action) {
    try {
      optionsObject(options);
      const deadline = Date.now() + (push ? PUSH_MS : LOCAL_MS), repo = await repository(root, deadline);
      if (!repo.canWrite) throw fail('Connect the repository top-level folder as a root to make changes.', 403);
      if (active.has(repo.key)) throw fail('Another Git operation is in progress in this repository. Refresh when it finishes.', 409);
      active.add(repo.key);
      try {
        const fp = await fingerprint(repo, deadline);
        expected(options, fp, !push);
        await rootCheck(root);
        return await action(repo, fp, deadline);
      } finally { active.delete(repo.key); }
    } catch (error) {
      if ([400, 403, 409].includes(error.status)) throw error;
      throw fail(messages[error.reason] || messages.error, 409, error.reason);
    }
  }

  async function pathsAction(root, options, unstage) {
    return mutation(root, options, false, async (repo, fp, deadline) => {
      const { paths } = options;
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 500 || new Set(paths).size !== paths.length ||
          paths.some(name => !validPath(name, showHidden)) || Buffer.byteLength(paths.join('\0')) > 65536)
        throw fail('Select 1–500 unique allowed file paths with a total size of at most 64 KiB.');
      for (const name of paths) {
        await checkPath(repo.top, name, { allowMissing: true });
        const records = (await run(repo.top, ['ls-files', '--stage', '-z', '--', name], deadline)).output.split('\0');
        const exact = records.filter(record => record.slice(record.indexOf('\t') + 1) === name);
        if (exact.some(record => !/^(100644|100755|120000) /.test(record)))
          throw fail('Only regular files and links can be modified. Manage submodules in a terminal.', 403);
        const tracked = exact.length > 0;
        if (!tracked) {
          const headRecords = fp.head ? (await run(repo.top, ['ls-tree', '-z', 'HEAD', '--', name], deadline)).output.split('\0') : [];
          const head = headRecords.some(record => /^(100644|100755|120000) blob /.test(record) && record.slice(record.indexOf('\t') + 1) === name);
          if (!head && unstage) throw fail('Only staged or tracked files can be unstaged.');
          if (!head) {
            await checkPath(repo.top, name);
            const others = (await run(repo.top, ['ls-files', '--others', '--exclude-standard', '-z', '--', name], deadline)).output.split('\0');
            if (!others.includes(name)) throw fail('Git ignores this file or its path is disallowed.', 403);
          }
        }
      }
      expected(options, await fingerprint(repo, deadline));
      await rootCheck(root);
      for (const name of paths) await checkPath(repo.top, name, { allowMissing: true });
      if (!unstage) await run(repo.top, ['add', '--', ...paths], deadline, { write: true, repo });
      else if (fp.head) await run(repo.top, ['restore', '--staged', '--source=HEAD', '--', ...paths], deadline, { write: true, repo });
      // An unborn branch has no source tree. --cached never removes worktree
      // content; --force permits unstage when that content differs from index.
      else await run(repo.top, ['rm', '--cached', '--force', '--', ...paths], deadline, { write: true, repo });
      return { ok: true, message: unstage ? 'Selected files unstaged. File contents are preserved.' : 'Selected files staged.' };
    });
  }

  async function commit(root, options) {
    return mutation(root, options, false, async (repo, fp, deadline) => {
      const { message } = options;
      if (typeof message !== 'string' || !message.trim() || message.includes('\0') || Buffer.byteLength(message) > 65536)
        throw fail('Enter a non-empty commit message of at most 64 KiB.');
      const reason = await commitBlock(repo, fp, deadline, showHidden);
      if (reason) throw fail(reason, 409);
      expected(options, await fingerprint(repo, deadline));
      await rootCheck(root);
      await run(repo.top, ['commit', '--file=-', '--cleanup=verbatim'], deadline, { write: true, input: message, repo });
      const hash = (await run(repo.top, ['rev-parse', '--verify', 'HEAD^{commit}'], deadline)).output.trim();
      return { ok: true, message: 'Staged changes committed.', hash };
    });
  }

  async function push(root, options) {
    return mutation(root, options, true, async (repo, fp, deadline) => {
      const { remote, branch, confirmed, setUpstream = false } = options;
      if (confirmed !== true || typeof setUpstream !== 'boolean') throw fail('Review the push destination and changes, then explicitly confirm.');
      if (!fp.head || !fp.branch) throw fail('Only the current local branch with commits can be pushed.', 409);
      if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(remote) ||
          typeof branch !== 'string' || branch.length > 1024 || /^[+-]/.test(branch) || /[\x00-\x20\x7f]/.test(branch))
        throw fail('Select a valid existing remote and target branch.');
      const valid = await run(repo.top, ['check-ref-format', `refs/heads/${branch}`], deadline, { accepted: [0, 1] });
      if (valid.code) throw fail('Invalid target branch name.');
      const remotes = await remotesFor(repo, deadline);
      if (typeof options.expectedPushToken !== 'string' || !/^[a-f\d]{64}$/.test(options.expectedPushToken))
        throw fail('Remote review details are required. Refresh the push destination and review it again.');
      if (options.expectedPushToken !== pushFingerprint(remotes))
        throw fail('Remote configuration changed. Refresh the push destination and review it again.', 409);
      const selected = remotes.find(item => item.name === remote);
      if (!selected || selected.urls.length !== 1) throw fail('Select an existing remote with exactly one push URL.');
      // Mirror configuration would broaden an otherwise explicit push. Reject it.
      if (selected.mirror) throw fail('Cannot push to a mirror remote.');
      expected(options, await fingerprint(repo, deadline), false);
      await rootCheck(root);
      await run(repo.top, ['-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no', 'push', '--porcelain',
        ...(setUpstream ? ['--set-upstream'] : []), '--', remote, `refs/heads/${fp.branch}:refs/heads/${branch}`], deadline, { write: true, repo });
      return { ok: true, message: 'The reviewed branch was pushed to the remote.', hash: fp.head };
    });
  }

  return { context, branches, history, stage: (root, options) => pathsAction(root, options, false),
    unstage: (root, options) => pathsAction(root, options, true), commit, push };
}
