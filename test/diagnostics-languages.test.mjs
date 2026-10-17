import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { diagnosticsTarget, createDiagnosticsService, parseShellcheck, parseNative, MAX_DIAGNOSTIC_BYTES } from '../lib/diagnostics.mjs';
import { parseText } from '../lib/diagnostics-parsers.mjs';
import { readEditor } from '../lib/editor.mjs';

test('live checking has an explicit extension/dialect allowlist independent of highlighting', () => {
  for (const [file, text, language, checker] of [
    ['a.sh', '', 'sh', 'shellcheck'], ['a.bash', '', 'bash', 'shellcheck'],
    ['a.sh', '#!/bin/bash\r\n', 'bash', 'shellcheck'], ['a.bash', '#!/bin/dash\n', 'dash', 'shellcheck'],
    ['run', '#!/usr/bin/env -S ksh -e\n', 'ksh', 'shellcheck'],
    ['a.JS', '', 'javascript', 'babel'], ['a.jsx', '', 'javascript', 'babel'],
    ['a.tsx', '', 'typescript', 'babel'], ['a.json', '', 'json', 'json'], ['a.yml', '', 'yaml', 'yaml'],
  ]) assert.deepEqual([diagnosticsTarget(file, text).language, diagnosticsTarget(file, text).checker], [language, checker]);
  for (const [file, text] of [['a.zsh', '#!/bin/bash'], ['a.sh', '#!/bin/zsh'], ['a.sh', '#!/bin/fish'],
    ['a.sh', '#!/usr/bin/env -u BASH_ENV bash'], ['a.sh', '#!/usr/bin/python3']]) {
    const target = diagnosticsTarget(file, text); assert.equal(target.checker, undefined); assert.match(target.message, /unsupported/);
  }
  for (const file of ['a.jsonl', 'a.jsonc', 'a.go', 'a.toml', 'a.mts', 'a.txt', 'plain'])
    assert.equal(diagnosticsTarget(file, '').checker, undefined);
  assert.equal(diagnosticsTarget('a.d.ts', '').mode, '.d.ts');
});

test('real parsers normalize Unicode/CRLF/multiline ranges and recover multiple errors', async () => {
  const text = 'const 한글 = "😀";\tlet x; let x;\r\nlet y; let y;\r\n';
  const issues = await parseText('.js', text);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].column, [...text.slice(0, text.lastIndexOf('x;', text.indexOf('\r')))].length + 1);
  assert.equal(issues[1].line, 2); assert.equal(issues[1].column, 12);
  assert.deepEqual(parseNative(JSON.stringify(issues), text), issues);
  assert.deepEqual(await parseText('.tsx', 'const value: number = 1; const el = <div>{value}</div>;'), []);
  assert.deepEqual(await parseText('.d.ts', 'declare namespace API { const x: string; }'), []);
  assert.deepEqual(await parseText('.cjs', 'return module.exports;'), []);
  assert.ok((await parseText('.mjs', 'return 1;')).length);
  assert.ok((await parseText('json', '')).length);
  assert.deepEqual(await parseText('yaml', ''), []);
  const range = await parseText('yaml', 'key: "한글😀\r\n  unterminated');
  assert.ok(range.some(item => item.line === 2 && item.end_column === 15));
  const multiline = { line: 1, column: 2, end_line: 2, end_column: 3, severity: 'error', code: 'range', message: 'range' };
  assert.deepEqual(parseNative(JSON.stringify([multiline]), '한글😀\r\n\tend'), [multiline]);
  for (const output of ['{}', '[{}]', '[{"line":1,"column":1,"end_line":1,"end_column":2,"severity":"unknown","code":"x","message":"x"}]'])
    assert.throws(() => parseNative(output, 'x'));
  for (const output of ['{}', '{"comments":[{}]}', 'garbage']) assert.throws(() => parseShellcheck(output, 'x'));
});

test('new checker processes share size, timeout, abort/queue/close and missing-tool limits', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-languages-')), root = path.join(base, 'project');
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = path.join(base, key);
  const services = [];
  const service = options => { const value = createDiagnosticsService(options); services.push(value); return value; };
  try {
    await fs.mkdir(root);
    for (const file of ['data.json', 'run.sh']) await fs.writeFile(path.join(root, file), '');
    const make = async (file, text) => ({ root: 'project', path: file, text,
      expected_version: (await readEditor(root, file)).version, request_id: 'languages' });
    const data = await make('data.json', '{"x":1}');
    const limited = service({ timeoutMs: 1 });
    const timeout = await limited.check(async () => root, data);
    assert.equal(timeout.status, 'skipped'); assert.match(timeout.message, /timed out/);
    assert.equal((await limited.check(async () => root, { ...data, text: ' '.repeat(MAX_DIAGNOSTIC_BYTES + 1) })).status, 'skipped');
    const queued = service({ maxRunning: 1, maxWaiting: 1 });
    const activeAbort = new AbortController(), queueAbort = new AbortController();
    const first = queued.check(async () => root, data, { signal: activeAbort.signal });
    const second = queued.check(async () => root, data, { signal: queueAbort.signal });
    assert.equal((await queued.check(async () => root, data)).status, 'busy');
    queueAbort.abort(); activeAbort.abort();
    assert.equal((await first).status, 'skipped'); assert.equal((await second).status, 'skipped');
    await queued.close(); assert.equal((await queued.check(async () => root, data)).status, 'skipped');
    const missing = await service({ tools: { shellcheck: '/no/shellcheck' } }).check(async () => root, await make('run.sh', '#!/bin/sh\n'));
    assert.equal(missing.status, 'unavailable'); assert.match(missing.message, /apt install shellcheck.*FBROWSE_SHELLCHECK/);
    const invalidPath = await service({ tools: { shellcheck: './shellcheck' } }).check(async () => root, await make('run.sh', 'echo ok'));
    assert.equal(invalidPath.status, 'unavailable');
    assert.deepEqual(await fs.readdir(root), ['data.json', 'run.sh']);
  } finally {
    await Promise.allSettled(services.map(value => value.close()));
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await fs.rm(base, { recursive: true, force: true });
  }
});
