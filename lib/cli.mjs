import { realpath, stat, readdir, readFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { projectConfig, readConfig, changeRoot, projectKey } from './storage.mjs';
import { stateBase, stateDirectory, withProjectLock, inspectState, startDaemon, stopDaemon, readLog } from './lifecycle.mjs';

const HELP = `Usage: fbrowse [start|url|logs|stop|restart] [PROJECT] [--no-pdfjs]
       fbrowse list
       fbrowse roots [list|add|edit|remove] [ID] [PATH] [--name NAME] [--project DIR]
       fbrowse help | version

  start      Start or reuse the project server (default: current folder)
  url        Print only the verified running server URL
  list       List running projects and URLs
  logs       Show the last 60 server log lines
  stop       Verify server identity and stop it with an authenticated HTTP request
  restart    Restart using the verified existing port
  roots      List, add, edit or remove roots in the existing XDG configuration
  help       Show help
  version    Show version

Options: --no-pdfjs, --show-hidden, --project DIR, --no-open (legacy compatibility)
Automatic browser opening is disabled. No files are created in the project folder.
`;
const commands = new Set(['start', 'url', 'list', 'logs', 'stop', 'restart', 'roots', 'help', 'version', '__serve']);

async function canonicalRoot(path = '.') {
  const root = await realpath(resolve(path));
  if (!(await stat(root)).isDirectory()) throw new Error(`Not a project folder: ${root}`);
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
      if (i + 1 >= args.length) throw new Error(`Option requires a value: ${item}`);
      if (Object.hasOwn(options, item)) throw new Error(`Duplicate option: ${item}`);
      options[item] = args[++i];
    } else if (['--no-pdfjs', '--show-hidden', '--no-open'].includes(item)) options[item] = true;
    else if (item.startsWith('-')) throw new Error(`Unknown option: ${item} (see fbrowse help)`);
    else positionals.push(item);
  }
  return { positionals, options };
}

function validateOptions(options, allowed) {
  for (const name of Object.keys(options)) if (!allowed.includes(name)) throw new Error(`Unsupported option for this command: ${name}`);
}

async function roots(args) {
  const { positionals, options } = parse(args);
  validateOptions(options, ['--project', '--name']);
  const [operation = 'list', id, path, ...extra] = positionals;
  if (!['list', 'add', 'edit', 'remove'].includes(operation)) throw new Error(`Unknown root operation: ${operation}`);
  const project = await canonicalRoot(options['--project']);
  if (operation === 'list') {
    if (id || path || extra.length || options['--name']) throw new Error('Do not specify an ID, path or name for roots list.');
    console.log(`project\t${basename(project) || project}\t${project}`);
    for (const [rootId, record] of Object.entries(await readConfig(project))) {
      let connected = false;
      try { connected = (await stat(record.path)).isDirectory(); } catch {}
      console.log(`${rootId}\t${record.name}\t${record.path}${connected ? '' : '\t[Disconnected]'}`);
    }
    return;
  }
  if (!id || extra.length || (operation === 'remove' && (path || options['--name'])) || (operation === 'add' && !path)) {
    throw new Error('Usage: roots add ID PATH [--name NAME], roots edit ID [PATH] [--name NAME], roots remove ID');
  }
  const existing = await readConfig(project);
  const previous = Object.hasOwn(existing, id) ? existing[id] : undefined;
  if (operation === 'edit' && !path && !options['--name']) throw new Error('roots edit requires a path or --name.');
  const rootPath = path ? resolve(path) : previous?.path;
  const name = options['--name'] ?? previous?.name ?? id;
  const affected = await changeRoot(project, operation, id, name, rootPath);
  console.log(`Root configuration saved (${affected ?? id}): ${await projectConfig(project)}`);
}

async function list() {
  let entries;
  try { entries = await readdir(stateBase(), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') { console.log('No file browser is running.'); return; } throw error; }
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
  if (!count) console.log('No file browser is running.');
}

async function serve(args) {
  const { positionals, options } = parse(args);
  validateOptions(options, ['--root', '--port', '--state-file', '--no-pdfjs', '--show-hidden']);
  if (positionals.length || !options['--root'] || !options['--state-file']) throw new Error('Internal command __serve requires --root and --state-file.');
  const port = Number(options['--port'] ?? 0);
  if (!/^\d+$/.test(options['--port'] ?? '0') || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
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
    if (args.length) throw new Error(`Do not specify arguments for ${command}.`);
    console.log(command === 'help' ? HELP.trimEnd() : '0.18.0');
    return;
  }
  if (command === 'roots') return roots(args);
  if (command === '__serve') return serve(args);
  if (command === 'list') {
    if (args.length) throw new Error('Do not specify arguments for list.');
    return list();
  }
  const { positionals, options } = parse(args);
  validateOptions(options, ['--project', '--no-pdfjs', '--show-hidden', '--no-open']);
  if (positionals.length > 1 || (positionals.length && options['--project'])) throw new Error('Specify only one project folder.');
  const root = await canonicalRoot(options['--project'] ?? positionals[0]);
  if (command === 'logs') {
    try { console.log(await readLog(stateDirectory(root))); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('No logs found. Start fbrowse first.'); throw error; }
    return;
  }
  if (command === 'url') {
    const current = await inspectState(root);
    if (current.status !== 'running') throw new Error('No verified server is running. Start fbrowse first.');
    console.log(current.url);
    return;
  }
  await withProjectLock(root, async directory => {
    if (command === 'stop') {
      await stopDaemon(root, directory);
      console.log(`Stopped: ${root}`);
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
