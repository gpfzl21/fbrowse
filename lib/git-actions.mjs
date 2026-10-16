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
  not_repository: '이 폴더는 Git 저장소가 아닙니다.',
  git_unavailable: 'Git이 설치되어 있지 않거나 사용할 수 없습니다.',
  timeout: 'Git 응답 시간이 초과되었습니다. 상태를 새로 고친 뒤 확인하세요.',
  output_limit: 'Git 정보가 크기 제한을 초과했습니다. 터미널에서 확인하세요.',
  error: 'Git 정보를 가져올 수 없습니다. 터미널에서 저장소 상태를 확인하세요.',
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
    return fail('다른 Git 작업이 진행 중입니다. 완료 후 상태를 새로 고치세요.', 409);
  if (/author identity unknown|committer identity unknown|unable to auto-detect email|empty ident|ident name.*empty/i.test(stderr))
    return fail('Git 사용자 이름과 이메일이 없습니다. 터미널에서 Git 사용자 정보를 설정하세요.', 409);
  if (/authentication|permission denied|could not read (username|password)|terminal prompts disabled|credential|host key verification|publickey/i.test(stderr))
    return fail('인증에 실패했습니다. 터미널에서 Git 자격 증명과 SSH 연결을 설정한 뒤 다시 시도하세요.', 409);
  if (/non-fast-forward|fetch first|stale info|\[rejected\]/i.test(stderr))
    return fail('원격 브랜치가 변경되어 푸시를 거절했습니다. 터미널에서 상태를 확인하고 새로 고치세요.', 409);
  return fail(write ? 'Git 작업이 실패했습니다. 터미널에서 사용자 설정·훅·필터와 저장소 상태를 확인하고 새로 고치세요.' : messages.error, 409, 'error');
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
      if (reason) return reject(fail(write ? `${messages[reason]} 작업이 일부 적용되었을 수 있으니 자동으로 재시도하지 마세요.` : messages[reason], 409, reason));
      if (!accepted.includes(code)) return reject(commandError(Buffer.concat([...errors, ...output]).toString('utf8'), write));
      resolve({ code, output: Buffer.concat(output).toString('utf8') });
    });
  });
}

async function rootCheck(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw fail('유효한 절대 루트 경로가 필요합니다.', 403);
  try {
    if (await fs.realpath(root) !== root || !(await fs.lstat(root)).isDirectory()) throw new Error();
  } catch { throw fail('선택한 루트가 변경되었거나 접근할 수 없습니다.', 403); }
}

async function repository(root, deadline) {
  await rootCheck(root);
  const result = await run(root, ['rev-parse', '--show-toplevel'], deadline, { accepted: [0, 128] });
  if (result.code) throw fail(messages.not_repository, 403, 'not_repository');
  const top = result.output.replace(/\n$/, '');
  if (!path.isAbsolute(top) || !inside(top, root) || await fs.realpath(top) !== top)
    throw fail('저장소 루트 경계를 확인할 수 없습니다.', 403);
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
    try { await fs.lstat(path.join(repo.gitdir, name)); return '진행 중인 병합·리베이스 등 Git 작업을 터미널에서 먼저 완료하세요.'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

async function commitBlock(repo, fp, deadline, showHidden) {
  if (!repo.canWrite) return '저장소 최상위 폴더를 루트로 연결해야 변경할 수 있습니다.';
  if (!fp.branch) return '분리된 HEAD에서는 커밋할 수 없습니다. 터미널에서 브랜치를 선택하세요.';
  const pending = await operationReason(repo);
  if (pending) return pending;
  const conflicts = (await run(repo.top, ['ls-files', '--unmerged', '-z'], deadline)).output;
  if (conflicts) return '충돌을 터미널에서 해결한 뒤 다시 시도하세요.';
  const staged = (await run(repo.top, ['diff', '--cached', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', '--'], deadline)).output.split('\0').filter(Boolean);
  if (staged.length > 10000) throw fail(messages.output_limit, 409, 'output_limit');
  if (!staged.length) return '스테이징된 변경이 없습니다.';
  if (staged.some(name => !validPath(name, showHidden)))
    return '화면에서 숨기거나 제외한 파일이 스테이징되어 있습니다. 터미널에서 스테이징 범위를 확인하세요.';
  for (const name of staged) {
    if (Date.now() >= deadline) throw fail(messages.timeout, 409, 'timeout');
    try { await checkPath(repo.top, name, { allowMissing: true }); }
    catch { return '스테이징된 파일에 심볼릭 링크 폴더나 허용되지 않는 경로가 있습니다. 터미널에서 확인하세요.'; }
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
    catch (error) { if (error.code === 'ENOENT' && allowMissing) return; throw fail('파일이 없거나 경로에 접근할 수 없습니다.', 403); }
    if (i < parts.length - 1) {
      if (info.isSymbolicLink() || !info.isDirectory() || await fs.realpath(current) !== current)
        throw fail('심볼릭 링크 폴더나 루트 밖의 경로는 변경할 수 없습니다.', 403);
    } else if (!info.isFile() && !info.isSymbolicLink()) throw fail('명시적인 파일 경로만 선택하세요. 폴더 전체 작업은 지원하지 않습니다.', 400);
  }
}

function optionsObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('작업 입력 형식이 올바르지 않습니다.');
  return value;
}

function expected(options, fp, index = true) {
  if (!Object.hasOwn(options, 'expectedHead') || !Object.hasOwn(options, 'expectedBranch') ||
      !(options.expectedHead === null || (typeof options.expectedHead === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(options.expectedHead))) ||
      !(options.expectedBranch === null || (typeof options.expectedBranch === 'string' && options.expectedBranch.length <= 1024 && !/[\x00-\x20\x7f]/.test(options.expectedBranch))) ||
      (index && (typeof options.expectedIndex !== 'string' || !/^[a-f\d]{64}$/.test(options.expectedIndex))))
    throw fail('현재 HEAD·브랜치·인덱스 확인 정보가 필요합니다. 상태를 새로 고치세요.');
  if (options.expectedHead !== fp.head || options.expectedBranch !== fp.branch || (index && options.expectedIndex !== fp.indexToken))
    throw fail('다른 작업으로 Git 상태가 변경되었습니다. 상태를 새로 고친 뒤 다시 검토하세요.', 409);
}

function pageOptions(options, defaultLimit) {
  optionsObject(options);
  const { offset = 0, limit = defaultLimit } = options;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw fail('조회 범위는 offset 0~10000, limit 1~100이어야 합니다.');
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
      const pushReason = !repo.canWrite ? '저장소 최상위 폴더를 루트로 연결해야 푸시할 수 있습니다.' :
        !fp.branch || !fp.head ? '커밋이 있는 로컬 브랜치에서만 푸시할 수 있습니다.' :
          !remotes.some(remote => remote.urls.length === 1 && !remote.mirror) ? '푸시 URL이 하나인 미러가 아닌 기존 원격 저장소를 터미널에서 설정하세요.' : null;
      return { available: true, reason: null,
        message: '명시적 Git 작업에는 기존 사용자 설정·훅·필터가 적용됩니다. 편집기와 대화형 인증은 실행하지 않습니다.',
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
      if (!repo.canWrite) throw fail('저장소 최상위 폴더를 루트로 연결해야 변경할 수 있습니다.', 403);
      if (active.has(repo.key)) throw fail('이 저장소에서 다른 Git 작업이 진행 중입니다. 완료 후 새로 고치세요.', 409);
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
        throw fail('허용된 파일 경로를 중복 없이 1~500개 선택하세요. 경로 합계는 64KiB 이하여야 합니다.');
      for (const name of paths) {
        await checkPath(repo.top, name, { allowMissing: true });
        const records = (await run(repo.top, ['ls-files', '--stage', '-z', '--', name], deadline)).output.split('\0');
        const exact = records.filter(record => record.slice(record.indexOf('\t') + 1) === name);
        if (exact.some(record => !/^(100644|100755|120000) /.test(record)))
          throw fail('일반 파일과 링크만 변경할 수 있습니다. 하위 저장소는 터미널에서 관리하세요.', 403);
        const tracked = exact.length > 0;
        if (!tracked) {
          const headRecords = fp.head ? (await run(repo.top, ['ls-tree', '-z', 'HEAD', '--', name], deadline)).output.split('\0') : [];
          const head = headRecords.some(record => /^(100644|100755|120000) blob /.test(record) && record.slice(record.indexOf('\t') + 1) === name);
          if (!head && unstage) throw fail('스테이징 또는 추적된 파일만 해제할 수 있습니다.');
          if (!head) {
            await checkPath(repo.top, name);
            const others = (await run(repo.top, ['ls-files', '--others', '--exclude-standard', '-z', '--', name], deadline)).output.split('\0');
            if (!others.includes(name)) throw fail('Git에서 무시하거나 허용되지 않은 파일입니다.', 403);
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
      return { ok: true, message: unstage ? '선택한 파일의 스테이징을 해제했습니다. 파일 내용은 보존됩니다.' : '선택한 파일을 스테이징했습니다.' };
    });
  }

  async function commit(root, options) {
    return mutation(root, options, false, async (repo, fp, deadline) => {
      const { message } = options;
      if (typeof message !== 'string' || !message.trim() || message.includes('\0') || Buffer.byteLength(message) > 65536)
        throw fail('비어 있지 않은 커밋 메시지를 64KiB 이내로 입력하세요.');
      const reason = await commitBlock(repo, fp, deadline, showHidden);
      if (reason) throw fail(reason, 409);
      expected(options, await fingerprint(repo, deadline));
      await rootCheck(root);
      await run(repo.top, ['commit', '--file=-', '--cleanup=verbatim'], deadline, { write: true, input: message, repo });
      const hash = (await run(repo.top, ['rev-parse', '--verify', 'HEAD^{commit}'], deadline)).output.trim();
      return { ok: true, message: '스테이징된 변경을 커밋했습니다.', hash };
    });
  }

  async function push(root, options) {
    return mutation(root, options, true, async (repo, fp, deadline) => {
      const { remote, branch, confirmed, setUpstream = false } = options;
      if (confirmed !== true || typeof setUpstream !== 'boolean') throw fail('푸시 대상과 변경 내용을 검토한 뒤 명시적으로 확인하세요.');
      if (!fp.head || !fp.branch) throw fail('커밋이 있는 현재 로컬 브랜치에서만 푸시할 수 있습니다.', 409);
      if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(remote) ||
          typeof branch !== 'string' || branch.length > 1024 || /^[+-]/.test(branch) || /[\x00-\x20\x7f]/.test(branch))
        throw fail('유효한 기존 원격 저장소와 대상 브랜치를 선택하세요.');
      const valid = await run(repo.top, ['check-ref-format', `refs/heads/${branch}`], deadline, { accepted: [0, 1] });
      if (valid.code) throw fail('대상 브랜치 이름이 올바르지 않습니다.');
      const remotes = await remotesFor(repo, deadline);
      if (typeof options.expectedPushToken !== 'string' || !/^[a-f\d]{64}$/.test(options.expectedPushToken))
        throw fail('원격 저장소 검토 정보가 필요합니다. 푸시 대상을 새로 고쳐 다시 검토하세요.');
      if (options.expectedPushToken !== pushFingerprint(remotes))
        throw fail('원격 저장소 설정이 변경되었습니다. 푸시 대상을 새로 고쳐 다시 검토하세요.', 409);
      const selected = remotes.find(item => item.name === remote);
      if (!selected || selected.urls.length !== 1) throw fail('푸시 URL이 정확히 하나인 기존 원격 저장소를 선택하세요.');
      // Mirror configuration would broaden an otherwise explicit push. Reject it.
      if (selected.mirror) throw fail('미러 원격 저장소에는 푸시할 수 없습니다.');
      expected(options, await fingerprint(repo, deadline), false);
      await rootCheck(root);
      await run(repo.top, ['-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no', 'push', '--porcelain',
        ...(setUpstream ? ['--set-upstream'] : []), '--', remote, `refs/heads/${fp.branch}:refs/heads/${branch}`], deadline, { write: true, repo });
      return { ok: true, message: '검토한 브랜치를 원격 저장소에 푸시했습니다.', hash: fp.head };
    });
  }

  return { context, branches, history, stage: (root, options) => pathsAction(root, options, false),
    unstage: (root, options) => pathsAction(root, options, true), commit, push };
}
