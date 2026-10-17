import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDiagnosticsService, parseRuff, parseChktex, MAX_DIAGNOSTIC_BYTES, MAX_DIAGNOSTICS } from '../lib/diagnostics.mjs';
import { readEditor } from '../lib/editor.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(20); } assert.fail('fixture checker did not reach checkpoint'); }
const literal = JSON.stringify;

test('checker parsers bound output, sanitize messages and preserve severity/locations', () => {
  const item = (code, row = 1, column = 1) => ({ code, location: { row, column }, end_location: { row, column: column + 1 }, message: '<b>unsafe</b>\0\ntext' });
  const values = parseRuff(JSON.stringify([item('F401'), item('F821'), item(null), item('E999', 500, 500)]), '한글\n');
  assert.deepEqual(values.map(value => value.severity), ['warning', 'error', 'error', 'error']);
  assert.equal(values[0].message, '<b>unsafe</b>  text');
  assert.equal(values[3].line, 2); assert.equal(values[3].column, 1);
  assert.equal(parseRuff(JSON.stringify(Array.from({ length: 250 }, () => item('F401'))), 'x').length, MAX_DIAGNOSTICS);
  for (const output of ['{}', 'not JSON', '[{}]', JSON.stringify([item('F401', 0)])]) assert.throws(() => parseRuff(output, 'x'));
  const tex = parseChktex('1\t2\t1\tWarning\t8\tmessage\n1\t1\t1\tError\t16\terror\n1\t1\t1\tMessage\t1\tinfo\n', 'abc');
  assert.deepEqual(tex.map(value => value.severity), ['warning', 'error', 'info']); assert.equal(tex[0].end_column, 3);
  assert.throws(() => parseChktex('untrusted malformed output', 'x'));
});

test('checker lifecycle isolates stdin/config and bounds missing/malformed/flood/timeout/abort/queues', { timeout: 30_000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-diagnostics-unit-'));
  const root = path.join(base, 'project'), alternate = path.join(base, 'alternate');
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = path.join(base, key);
  const services = [], pids = [];
  const tool = async (name, body) => {
    const file = path.join(base, name + '.mjs');
    await fs.writeFile(file, '#!' + process.execPath + '\n' + body, { mode: 0o700 }); return file;
  };
  const service = (ruff, options = {}) => {
    const value = createDiagnosticsService({ tools: { ruff, chktex: '/no-such-checker' }, ...options }); services.push(value); return value;
  };
  try {
    await fs.mkdir(root); await fs.mkdir(alternate);
    await fs.writeFile(path.join(root, 'code.py'), 'disk = 1\n');
    await fs.writeFile(path.join(alternate, 'code.py'), 'alternate = 2\n');
    const make = async (text = 'unsaved = 2\n') => ({ root: 'project', path: 'code.py', text,
      expected_version: (await readEditor(root, 'code.py')).version, request_id: 'unit-check' });
    const data = await make();
    const check = (value, body = data, options = {}) => value.check(async () => root, body, options);
    await t.test('missing binary and oversized input are concise nonfatal statuses', async () => {
      const value = service('/definitely-absent/ruff');
      assert.equal((await check(value)).status, 'unavailable');
      const over = await check(value, { ...data, text: '#'.repeat(MAX_DIAGNOSTIC_BYTES + 1) });
      assert.equal(over.status, 'skipped'); assert.match(over.message, /512 KiB/);
    });
    await t.test('checker receives unsaved stdin, fixed args, neutral CWD/HOME and minimal environment', async () => {
      const capture = path.join(base, 'capture.json');
      const binary = await tool('capture', `import fs from 'node:fs';let text='';for await(const b of process.stdin)text+=b;fs.writeFileSync(${literal(capture)},JSON.stringify({text,args:process.argv.slice(2),cwd:process.cwd(),env:process.env}));process.stdout.write('[]');`);
      const value = service(binary); assert.equal((await check(value)).status, 'ok');
      const seen = JSON.parse(await fs.readFile(capture, 'utf8'));
      assert.equal(seen.text, data.text); assert.notEqual(seen.cwd, root); assert.equal(seen.env.HOME, seen.cwd);
      assert.ok(seen.args.includes('--isolated')); assert.ok(seen.args.includes('--no-cache')); assert.ok(seen.args.includes('--no-fix'));
      assert.ok(seen.args.includes('current.py')); assert.ok(!seen.args.some(arg => arg.includes(root)));
      assert.equal(seen.env.PYTHONPATH, undefined); assert.equal(seen.env.TEXINPUTS, undefined);
      await value.close(); assert.equal(await fs.stat(seen.cwd).then(() => true, () => false), false);
    });
    await t.test('malformed and output-flood checker responses cannot become diagnostics', async () => {
      const malformed = service(await tool('malformed', "process.stdin.resume();process.stdout.write('{broken');"));
      assert.equal((await check(malformed)).status, 'unavailable');
      const flood = service(await tool('flood', "process.stdin.resume();setInterval(()=>process.stdout.write('x'.repeat(65536)),1);"));
      const result = await check(flood); assert.equal(result.status, 'skipped'); assert.match(result.message, /256 KiB/);
    });
    const makeHanging = async name => {
      const pidFile = path.join(base, name + '-pids.json');
      const binary = await tool(name, `import fs from 'node:fs';import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${literal(pidFile)},JSON.stringify([process.pid,child.pid]));process.stdin.resume();setInterval(()=>{},1000);`);
      const collect = async () => { await until(() => fs.stat(pidFile).then(() => true, () => false)); const found = JSON.parse(await fs.readFile(pidFile, 'utf8')); pids.push(...found); return found; };
      return { binary, collect };
    };
    const gone = async ids => {
      await until(async () => (await Promise.all(ids.map(async pid => {
        try { const stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8'); return /\) [ZX] /.test(stat); }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
      }))).every(Boolean));
      t.diagnostic('Verified checker/helper PIDs terminated: ' + ids.join(','));
    };
    await t.test('timeout kills actual checker and descendant process group', async () => {
      const hanging = await makeHanging('timeout'), value = service(hanging.binary, { timeoutMs: 500 });
      const pending = check(value), ids = await hanging.collect();
      const result = await pending; assert.equal(result.status, 'skipped'); assert.match(result.message, /timed out/); await gone(ids);
    });
    await t.test('abort kills running checker/helper and cancels a queued job without spawning', async () => {
      const hanging = await makeHanging('abort'), value = service(hanging.binary, { maxRunning: 1, maxWaiting: 1 });
      const running = new AbortController(), queued = new AbortController();
      const first = check(value, data, { signal: running.signal }), ids = await hanging.collect();
      const second = check(value, data, { signal: queued.signal });
      assert.equal((await check(value)).status, 'busy'); queued.abort();
      assert.equal((await second).status, 'skipped'); running.abort();
      assert.equal((await first).status, 'skipped'); await gone(ids);
    });
    await t.test('service close kills an in-flight process and removes neutral scratch directory', async () => {
      const hanging = await makeHanging('close'), value = service(hanging.binary);
      const pending = check(value), ids = await hanging.collect(); await value.close();
      assert.equal((await pending).status, 'skipped'); await gone(ids);
    });
    await t.test('delayed completion cannot survive root remapping, disconnection or disk replacement', async () => {
      const marker = path.join(base, 'delay-start');
      const binary = await tool('delayed', `import fs from 'node:fs';process.stdin.resume();fs.writeFileSync(${literal(marker)},'started');setTimeout(()=>process.stdout.write('[]'),250);`);
      for (const action of ['remap', 'disconnect', 'disk']) {
        await fs.rm(marker, { force: true });
        let boundary = root;
        const pending = service(binary).check(async () => { if (!boundary) throw Object.assign(Error('Disconnected'), { status: 409 }); return boundary; }, await make());
        const rejected = assert.rejects(pending, error => error.status === 409);
        await until(() => fs.stat(marker).then(() => true, () => false));
        if (action === 'remap') boundary = alternate;
        else if (action === 'disconnect') boundary = null;
        else await fs.writeFile(path.join(root, 'code.py'), 'changed = 3\n');
        await rejected;
      }
    });
    assert.deepEqual(await fs.readdir(root), ['code.py']);
  } finally {
    await Promise.allSettled(services.map(value => value.close()));
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await fs.rm(base, { recursive: true, force: true });
  }
});
