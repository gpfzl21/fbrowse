import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { editorPath, readEditor } from './editor.mjs';
import { failure, LANGUAGES } from './files.mjs';

export const MAX_DIAGNOSTIC_BYTES = 512 * 1024;
export const MAX_DIAGNOSTIC_OUTPUT = 256 * 1024;
export const MAX_DIAGNOSTICS = 200;
const conflict = () => failure('File or root changed; reload before checking', 409);
const extensions = new Set(['.py', '.pyw', '.tex', '.sty', '.cls']);
const ruffErrors = /^(invalid-syntax|E9|F63|F7|F82|F831)/;

function clean(value, maximum = 1000) {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, maximum);
}

// Only server-startup configuration can select an executable. Never search the
// document CWD, accept a request filename, or inherit tool/config loader variables.
async function executable(name, override, searchPath) {
  if (override !== undefined && (typeof override !== 'string' || !path.isAbsolute(override))) return null;
  const candidates = override === undefined ? searchPath.split(path.delimiter)
    .filter(value => path.isAbsolute(value)).map(value => path.join(value, name)) : [override];
  for (const candidate of candidates) {
    try {
      const target = await fs.realpath(candidate);
      if (!(await fs.stat(target)).isFile()) continue;
      await fs.access(target, constants.X_OK);
      return target;
    } catch { /* Optional external checker. */ }
  }
  return null;
}

function diagnostic(line, column, endLine, endColumn, severity, code, message, lines) {
  if (![line, column, endLine, endColumn].every(value => Number.isSafeInteger(value) && value >= 1) ||
      typeof message !== 'string' || typeof code !== 'string' || !message.trim()) throw new Error('Invalid checker output');
  line = Math.min(line, lines.length);
  column = Math.min(column, lines[line - 1].length + 1);
  endLine = Math.max(line, Math.min(endLine, lines.length));
  endColumn = Math.min(endColumn, lines[endLine - 1].length + 1);
  if (line === endLine) endColumn = Math.max(column, endColumn);
  return { line, column, end_line: endLine, end_column: endColumn, severity,
    code: clean(code, 64), message: clean(message) };
}

export function parseRuff(output, text) {
  const values = JSON.parse(output), lines = text.split('\n').map(line => Array.from(line));
  if (!Array.isArray(values)) throw new Error('Invalid checker output');
  return values.slice(0, MAX_DIAGNOSTICS).map(value => {
    const code = value.code ?? 'invalid-syntax';
    if (typeof code !== 'string' || !value.location || !value.end_location) throw new Error('Invalid checker output');
    return diagnostic(value.location.row, value.location.column, value.end_location.row,
      value.end_location.column, ruffErrors.test(code) ? 'error' : 'warning', code, value.message, lines);
  });
}

export function parseChktex(output, text) {
  const lines = text.split('\n').map(line => Array.from(line));
  // ChkTeX reports UTF-8 byte columns. TabSize=1 makes tabs one byte too;
  // the public API consistently uses 1-based Unicode codepoint columns.
  const columnAt = (line, column) => {
    if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1)
      throw new Error('Invalid checker output');
    let bytes = 0, points = 1;
    for (const char of lines[Math.min(line, lines.length) - 1]) {
      const width = Buffer.byteLength(char);
      if (bytes + width > column - 1) break;
      bytes += width; points++;
    }
    return points;
  };
  return output.split('\n').filter(Boolean).slice(0, MAX_DIAGNOSTICS).map(value => {
    const match = /^(\d+)\t(\d+)\t(\d+)\t(Warning|Error|Message)\t(\d+)\t(.*)$/i.exec(value);
    if (!match) throw new Error('Invalid checker output');
    const [, row, column, length, kind, code, message] = match;
    return diagnostic(Number(row), columnAt(Number(row), Number(column)), Number(row),
      columnAt(Number(row), Number(column) + Number(length)),
      ({ warning: 'warning', error: 'error', message: 'info' })[kind.toLowerCase()], code, message, lines);
  });
}

function killGroup(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } }
}

// Exported indirectly through service tools/limits for deterministic fake-tool
// tests. The API never accepts tools, arguments, environment, CWD, or limits.
function runChecker(command, args, text, directory, signal, timeoutMs, searchPath) {
  return new Promise(resolve => {
    if (signal.aborted) { resolve({ reason: 'cancelled' }); return; }
    const child = spawn(command, args, { cwd: directory, detached: true, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: searchPath, HOME: directory,
        XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_DATA_HOME: directory,
        TMPDIR: directory, LC_ALL: 'C.UTF-8', NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1' } });
    let reason, size = 0, spawnError, timer;
    const blocks = [];
    const stop = why => { reason ||= why; killGroup(child); };
    const abort = () => stop('cancelled');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    const collect = stdout => block => {
      size += block.length;
      if (size > MAX_DIAGNOSTIC_OUTPUT) stop('output');
      else if (stdout) blocks.push(block);
    };
    child.stdout.on('data', collect(true));
    child.stderr.on('data', collect(false));
    child.on('error', error => { spawnError = error; });
    child.stdin.on('error', () => { /* EPIPE is normal when a checker exits early. */ });
    child.on('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      // A helper must not survive its checker, even if it closed inherited pipes.
      killGroup(child);
      resolve({ code, reason, spawnError, output: Buffer.concat(blocks).toString('utf8') });
    });
    child.stdin.end(text);
  });
}

export function createDiagnosticsService({ tools = {}, timeoutMs = 3000, maxRunning = 2, maxWaiting = 4 } = {}) {
  if (![timeoutMs, maxRunning, maxWaiting].every(Number.isSafeInteger) || timeoutMs < 1 ||
      timeoutMs > 30_000 || maxRunning < 1 || maxRunning > 16 || maxWaiting < 0 || maxWaiting > 64)
    throw new TypeError('Invalid diagnostics limits');
  const searchPath = (process.env.PATH || '/usr/bin:/bin').split(path.delimiter)
    .filter(value => path.isAbsolute(value)).join(path.delimiter);
  const configured = { ruff: tools.ruff ?? process.env.FBROWSE_RUFF,
    chktex: tools.chktex ?? process.env.FBROWSE_CHKTEX };
  let closed = false, directoryPromise, closePromise, running = 0;
  const queue = [], active = new Set(), pending = new Set();
  const directory = () => directoryPromise ||= fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-diagnostics-'));

  function drain() {
    while (!closed && running < maxRunning && queue.length) {
      const next = queue.shift();
      running++;
      next.start();
    }
  }

  async function inspect(getBoundary, data, options, signal, base) {
    if (signal.aborted) return { ...base, status: 'skipped', message: 'Check cancelled' };
    const boundary = await getBoundary();
    const snapshot = async () => {
      if (await getBoundary() !== boundary) throw conflict();
      const value = await readEditor(boundary, base.path, options.showHidden, options.project ?? boundary, data.root);
      if (await getBoundary() !== boundary || value.version !== data.expected_version) throw conflict();
    };
    await snapshot();
    let result;
    if (!extensions.has(path.extname(base.path).toLowerCase())) result = { ...base, status: 'unsupported' };
    else if (Buffer.byteLength(data.text) > MAX_DIAGNOSTIC_BYTES)
      result = { ...base, status: 'skipped', message: 'Live checks support text up to 512 KiB' };
    else if (signal.aborted) result = { ...base, status: 'skipped', message: 'Check cancelled' };
    else {
      const command = await executable(base.checker, configured[base.checker], searchPath);
      if (!command) result = { ...base, status: 'unavailable', message: `${base.checker === 'ruff' ? 'Ruff' : 'ChkTeX'} is unavailable; install it to enable live checks` };
      else {
        const args = base.checker === 'ruff' ? ['check', '--isolated', '--no-cache', '--no-fix',
          '--output-format', 'json', '--select', 'E4,E7,E9,F,B', '--stdin-filename', 'current.py', '-'] :
          // Structural mismatches are errors; typography remains warnings.
          ['-q', '-I0', '-g0', '-b0', '-S', 'TabSize=1', '-e9', '-e10', '-e15', '-e16', '-e17', '-e49',
            '-p', 'current.tex', '-f', '%l\t%c\t%d\t%k\t%n\t%m\n'];
        const checked = await runChecker(command, args, data.text, await directory(), signal, timeoutMs, searchPath);
        if (checked.reason) result = { ...base, status: 'skipped', message: ({ cancelled: 'Check cancelled',
          timeout: 'Live check timed out', output: 'Checker output exceeded 256 KiB' })[checked.reason] };
        else if (checked.spawnError || !(base.checker === 'ruff' ? [0, 1] : [0, 2, 3]).includes(checked.code))
          result = { ...base, status: 'unavailable', message: 'Checker could not complete the live check' };
        else {
          try { result = { ...base, status: 'ok', diagnostics: (base.checker === 'ruff' ? parseRuff : parseChktex)(checked.output, data.text) }; }
          catch { result = { ...base, status: 'unavailable', message: 'Checker returned an unsupported response' }; }
        }
      }
    }
    // Root removal/remapping and disk edits while the process ran invalidate
    // even an otherwise successful result. Read-only editor files remain usable.
    await snapshot();
    return result;
  }

  function check(getBoundary, data, options = {}) {
    const relative = editorPath(data.path, options.showHidden);
    if (typeof data.root !== 'string' || !data.root || Object.keys(data).some(key =>
      !['root', 'path', 'text', 'expected_version', 'request_id'].includes(key)) ||
      typeof data.text !== 'string' || !data.text.isWellFormed() || data.text.includes('\0') ||
      typeof data.expected_version !== 'string' || !/^[a-f0-9]{64}$/.test(data.expected_version) ||
      typeof data.request_id !== 'string' || !data.request_id || data.request_id.length > 128)
      throw failure('Explicit root, path, text, expected_version and request_id are required', 400);
    const language = LANGUAGES[path.extname(relative).toLowerCase()] || '';
    const base = { root_id: data.root, path: relative, request_id: data.request_id, language,
      checker: language === 'python' ? 'ruff' : language === 'latex' ? 'chktex' : null, diagnostics: [] };
    if (closed || options.signal?.aborted) return Promise.resolve({ ...base, status: 'skipped', message: 'Check cancelled' });
    if (running >= maxRunning && queue.length >= maxWaiting)
      return Promise.resolve({ ...base, status: 'busy', message: 'Live checks are busy; edit to try again' });
    const controller = new AbortController();
    let job;
    const promise = new Promise((resolve, reject) => {
      const abort = () => {
        controller.abort();
        const index = queue.indexOf(job);
        if (index >= 0) { queue.splice(index, 1); finish(); resolve({ ...base, status: 'skipped', message: 'Check cancelled' }); }
      };
      const finish = () => options.signal?.removeEventListener('abort', abort);
      job = { controller, cancel: abort, start() {
        active.add(job);
        inspect(getBoundary, data, options, controller.signal, base).then(resolve, error => {
          if (error.status) reject(error);
          else if (['ENOENT', 'ESTALE', 'ENOTDIR', 'ELOOP'].includes(error.code)) reject(conflict());
          else if (['EACCES', 'EPERM'].includes(error.code)) reject(failure('File or root is not readable', 403));
          else reject(failure('Live check could not complete', 500));
        }).finally(() => {
          finish(); active.delete(job); running--; drain();
        });
      } };
      options.signal?.addEventListener('abort', abort, { once: true });
      queue.push(job);
      drain();
    });
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    for (const job of [...queue, ...active]) job.cancel();
    closePromise = (async () => {
      await Promise.allSettled([...pending]);
      if (directoryPromise) await fs.rm(await directoryPromise, { recursive: true, force: true });
    })();
    return closePromise;
  }
  return { check, close };
}
