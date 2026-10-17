import { realpath, stat, readdir, readFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { projectConfig, readConfig, changeRoot, projectKey } from './storage.mjs';
import { stateBase, stateDirectory, withProjectLock, inspectState, startDaemon, stopDaemon, readLog } from './lifecycle.mjs';

const HELP = `사용법: fbrowse [start|url|logs|stop|restart] [PROJECT] [--no-pdfjs]
       fbrowse list
       fbrowse roots [list|add|edit|remove] [ID] [PATH] [--name NAME] [--project DIR]
       fbrowse help | version

  start      프로젝트 서버 시작 또는 재사용 (기본값: 현재 폴더)
  url        확인된 실행 서버 주소만 출력
  list       실행 중인 프로젝트와 주소
  logs       최근 서버 로그 60줄
  stop       서버 신원 확인 후 인증된 HTTP 요청으로 종료
  restart    확인된 기존 포트를 유지하여 재시작
  roots      기존 XDG 설정의 등록 루트 조회·추가·수정·제거
  help       도움말
  version    버전

옵션: --no-pdfjs, --show-hidden, --project DIR, --no-open (이전 명령 호환)
브라우저 자동 열기는 비활성화되어 있습니다. 프로젝트 폴더에 파일을 만들지 않습니다.
`;
const commands = new Set(['start', 'url', 'list', 'logs', 'stop', 'restart', 'roots', 'help', 'version', '__serve']);

async function canonicalRoot(path = '.') {
  const root = await realpath(resolve(path));
  if (!(await stat(root)).isDirectory()) throw new Error(`프로젝트 폴더가 아닙니다: ${root}`);
  return root;
}

function parse(args) {
  const positionals = [];
  const options = {};
  const valued = new Set(['--project', '--root', '--port', '--state-file', '--name']);
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (item === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (valued.has(item)) {
      if (i + 1 >= args.length) throw new Error(`옵션 값이 필요합니다: ${item}`);
      if (Object.hasOwn(options, item)) throw new Error(`중복 옵션입니다: ${item}`);
      options[item] = args[++i];
    } else if (['--no-pdfjs', '--show-hidden', '--no-open'].includes(item)) options[item] = true;
    else if (item.startsWith('-')) throw new Error(`알 수 없는 옵션입니다: ${item} (fbrowse help 참고)`);
    else positionals.push(item);
  }
  return { positionals, options };
}

function validateOptions(options, allowed) {
  for (const name of Object.keys(options)) if (!allowed.includes(name)) throw new Error(`이 명령에서 지원하지 않는 옵션입니다: ${name}`);
}

async function roots(args) {
  const { positionals, options } = parse(args);
  validateOptions(options, ['--project', '--name']);
  const [operation = 'list', id, path, ...extra] = positionals;
  if (!['list', 'add', 'edit', 'remove'].includes(operation)) throw new Error(`알 수 없는 루트 작업입니다: ${operation}`);
  const project = await canonicalRoot(options['--project']);
  if (operation === 'list') {
    if (id || path || extra.length || options['--name']) throw new Error('roots list에는 ID·경로·이름을 지정하지 마세요.');
    console.log(`project\t${basename(project) || project}\t${project}`);
    for (const [rootId, record] of Object.entries(await readConfig(project))) {
      let connected = false;
      try { connected = (await stat(record.path)).isDirectory(); } catch {}
      console.log(`${rootId}\t${record.name}\t${record.path}${connected ? '' : '\t[연결 안 됨]'}`);
    }
    return;
  }
  if (!id || extra.length || (operation === 'remove' && (path || options['--name'])) || (operation === 'add' && !path)) {
    throw new Error('사용법: roots add ID PATH [--name NAME], roots edit ID [PATH] [--name NAME], roots remove ID');
  }
  const existing = await readConfig(project);
  const previous = Object.hasOwn(existing, id) ? existing[id] : undefined;
  if (operation === 'edit' && !path && !options['--name']) throw new Error('roots edit에는 경로나 --name이 필요합니다.');
  const rootPath = path ? resolve(path) : previous?.path;
  const name = options['--name'] ?? previous?.name ?? id;
  const affected = await changeRoot(project, operation, id, name, rootPath);
  console.log(`루트 설정 저장 (${affected ?? id}): ${await projectConfig(project)}`);
}

async function list() {
  let entries;
  try { entries = await readdir(stateBase(), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') { console.log('실행 중인 파일 탐색기가 없습니다.'); return; } throw error; }
  let count = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
    const directory = join(stateBase(), entry.name);
    try {
      const record = JSON.parse(await readFile(join(directory, 'server.json'), 'utf8'));
      if (typeof record.root !== 'string' || projectKey(record.root) !== entry.name) continue;
      const current = await inspectState(record.root, directory);
      if (current.status === 'running') { console.log(`${current.url}\t${record.root}`); count++; }
    } catch { /* Stale or unverified entries are never advertised. */ }
  }
  if (!count) console.log('실행 중인 파일 탐색기가 없습니다.');
}

async function serve(args) {
  const { positionals, options } = parse(args);
  validateOptions(options, ['--root', '--port', '--state-file', '--no-pdfjs', '--show-hidden']);
  if (positionals.length || !options['--root'] || !options['--state-file']) throw new Error('내부 명령 __serve에는 --root와 --state-file이 필요합니다.');
  const port = Number(options['--port'] ?? 0);
  if (!/^\d+$/.test(options['--port'] ?? '0') || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('올바르지 않은 포트입니다.');
  const root = await canonicalRoot(options['--root']);
  const { startServer } = await import('./server.mjs');
  const running = await startServer({ root, port, host: '127.0.0.1', pdfjs: !options['--no-pdfjs'], showHidden: !!options['--show-hidden'], stateFile: resolve(options['--state-file']) });
  console.log(`fbrowse ${running.url} ${root}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await running.close(); }
    catch (error) { console.error(`fbrowse: ${error.message}`); process.exitCode = 1; }
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  running.server.once('close', () => {
    process.removeListener('SIGTERM', close);
    process.removeListener('SIGINT', close);
  });
}

export async function main(argv = []) {
  const args = [...argv];
  let command = 'start';
  if (args[0] === '--version' || args[0] === '-v') { args.shift(); command = 'version'; }
  else if (args[0] === '--help' || args[0] === '-h') { args.shift(); command = 'help'; }
  else if (commands.has(args[0])) command = args.shift();
  if (command === 'help' || command === 'version') {
    if (args.length) throw new Error(`${command}에는 인수를 지정하지 마세요.`);
    console.log(command === 'help' ? HELP.trimEnd() : '0.10.1');
    return;
  }
  if (command === 'roots') return roots(args);
  if (command === '__serve') return serve(args);
  if (command === 'list') {
    if (args.length) throw new Error('list에는 인수를 지정하지 마세요.');
    return list();
  }
  const { positionals, options } = parse(args);
  validateOptions(options, ['--project', '--no-pdfjs', '--show-hidden', '--no-open']);
  if (positionals.length > 1 || (positionals.length && options['--project'])) throw new Error('프로젝트 폴더 하나만 지정하세요.');
  const root = await canonicalRoot(options['--project'] ?? positionals[0]);
  if (command === 'logs') {
    try { console.log(await readLog(stateDirectory(root))); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('로그가 없습니다. fbrowse로 먼저 실행하세요.'); throw error; }
    return;
  }
  if (command === 'url') {
    const current = await inspectState(root);
    if (current.status !== 'running') throw new Error('확인된 실행 서버가 없습니다. fbrowse로 먼저 실행하세요.');
    console.log(current.url);
    return;
  }
  await withProjectLock(root, async directory => {
    if (command === 'stop') {
      await stopDaemon(root, directory);
      console.log(`종료: ${root}`);
      return;
    }
    const startOptions = { pdfjs: options['--no-pdfjs'] ? false : undefined, showHidden: !!options['--show-hidden'] };
    if (command === 'restart') {
      const previous = await stopDaemon(root, directory);
      if (previous.status === 'running') {
        startOptions.port = previous.record.port;
        startOptions.pdfjs ??= previous.info.pdfjs;
      }
    }
    const current = await startDaemon(root, directory, startOptions);
    console.log(current.url);
  });
}
