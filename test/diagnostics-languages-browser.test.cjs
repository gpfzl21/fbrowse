// Real parser/tool results and physical Chromium input, disposable roots only.
const { fixture, gate } = require('./workspace-test-helper.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) { for (let i = 0; i < 160; i++) { if (await check()) return; await sleep(50); } assert.fail(message); }
(async () => fixture(async ({ ready, page, open, tab, register }) => {
  const cases = [
    ['live.bash', '#!/bin/bash\nprintf "ok\\n"\n', '#!/bin/bash\necho "한글😀";\techo $missing\n', 'shellcheck'],
    ['live.js', 'const value = 1;\n', 'const 한글 = "😀";\tconst broken = ;\n', 'babel'],
    ['live.ts', 'const value: number = 1;\n', 'const 한글 = "😀";\tconst broken: = 1;\n', 'babel'],
    ['live.json', '{"value":1}\n', '{"한글":"😀",\t"a": , "b": }\n', 'json'],
    ['live.yaml', 'key: value\n', '한글: 😀\nkey: 1\nkey: 2\nunknown: !custom value\n', 'yaml'],
  ];
  const files = Object.fromEntries(cases.map(([name, text]) => [name, text]));
  files['live.zsh'] = '#!/bin/zsh\necho ok\n'; files['live.sh'] = '#!/bin/sh\nprintf "ok\\n"\n';
  files['run-live'] = '#!/usr/bin/env bash\nprintf "ok\\n"\n';
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(ready.project, name), text);
  const before = Object.fromEntries(await Promise.all(Object.keys(files).map(async name => [name, (await fs.stat(path.join(ready.project, name), { bigint: true })).mtimeNs])));
  await register('other', ready.results);
  const posts = [], results = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/diagnostics') posts.push(request.postDataJSON()); });
  page.on('response', async response => {
    if (new URL(response.url()).pathname === '/api/diagnostics') {
      try { results.push({ body: response.request().postDataJSON(), result: await response.json() }); } catch { /* Aborted response. */ }
    }
  });
  await page.goto(ready.url);
  let code;
  const editor = () => code.locator('#editor');
  const replace = async text => { await editor().focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(text); };
  const checked = async (file, text) => {
    await until(() => results.some(x => x.body.path === file && x.body.text === text), 'real result: ' + file);
    const value = results.filter(x => x.body.path === file && x.body.text === text).at(-1).result;
    assert.equal(value.status, 'ok', value.message);
    await until(async () => await code.locator('#diagnosticsList button').count() === value.diagnostics.length, 'rendered: ' + file);
    return value;
  };
  for (const [file, clean, broken, checker] of cases) {
    code = await open(file); await checked(file, clean);
    const count = posts.length; await replace(broken); await sleep(400);
    assert.equal(posts.length, count, 'debounce: ' + file);
    const result = await checked(file, broken); assert.equal(result.checker, checker); assert.ok(result.diagnostics.length);
    await code.locator('.diagnostic-underline').first().waitFor();
    const wave = await code.locator('.diagnostic-underline').first().boundingBox();
    await page.mouse.move(wave.x + wave.width / 2, wave.y);
    await code.locator('#diagnosticTooltip').waitFor({ state: 'visible' });
    assert.ok((await code.locator('#diagnosticTooltip').textContent()).includes(result.diagnostics[0].code));
    await code.locator('#diagnosticsToggle').click();
    await code.locator('#diagnosticsList button').first().click();
    const issue = result.diagnostics[0], lines = broken.split('\n');
    const offset = lines.slice(0, issue.line - 1).join('\n').length + (issue.line > 1 ? 1 : 0) +
      [...lines[issue.line - 1]].slice(0, issue.column - 1).join('').length;
    assert.equal(await editor().evaluate(node => node.selectionStart), offset, 'Unicode/tab navigation: ' + file);
    await editor().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' ');
    await page.keyboard.press('Control+z'); assert.equal(await editor().inputValue(), broken, 'native undo: ' + file);
    await code.locator('#diagnosticsEnabled').click();
    assert.equal(await code.locator('.diagnostic-underline').count(), 0);
    const off = posts.length; await replace(clean); await sleep(900); assert.equal(posts.length, off);
    await code.locator('#diagnosticsEnabled').click(); await code.locator('#diagnosticsStatus').filter({hasText:/Errors: 0 · Warnings: 0/}).waitFor();
    const retry = posts.length; await code.locator('#diagnosticsRetry').click();
    await until(() => posts.length > retry, 'retry: ' + file);
    await code.locator('#diagnosticsStatus').filter({hasText:/Errors: 0 · Warnings: 0/}).waitFor();
  }
  code = await open('live.zsh'); await code.locator('#diagnosticsStatus').filter({hasText:/Unsupported file.*zsh/}).waitFor();
  for (const file of ['live.sh', 'run-live']) { code = await open(file); await checked(file, files[file]); }
  await replace('#!/bin/zsh\necho ok\n'); await code.locator('#diagnosticsStatus').filter({hasText:/Unsupported file/}).waitFor();
  await replace(files['run-live']); await code.locator('#diagnosticsStatus').filter({hasText:/Errors: 0 · Warnings: 0/}).waitFor();

  // Hold real responses, then change text, roots, or close the owning frame.
  code = await open('live.json');
  const held = []; let holdNext = false;
  await page.route('**/api/diagnostics', async route => {
    if (!holdNext) return route.continue();
    holdNext = false; const response = await route.fetch(), release = gate(); held.push(release);
    await release.promise; await route.fulfill({ response }).catch(() => {});
  });
  const hold = async () => { const count = held.length; holdNext = true; await code.locator('#diagnosticsRetry').click(); await until(() => held.length > count, 'held real JSON result'); return held.at(-1); };
  await replace(cases[3][2]); await checked('live.json', cases[3][2]);
  let delayed = await hold(); await replace(files['live.json']);
  await code.locator('#diagnosticsStatus').filter({hasText:/Errors: 0 · Warnings: 0/}).waitFor(); delayed.release(); await sleep(200);
  assert.equal(await code.locator('#diagnosticsList button').count(), 0, 'old error cannot replace newer clean result');
  await replace(cases[3][2]); await code.locator('#diagnosticsList button').first().waitFor({state:'attached'});
  delayed = await hold(); await page.locator('#rootSelect').selectOption('other'); delayed.release();
  const inactive = posts.length; await sleep(1000); assert.equal(posts.length, inactive, 'other root sends no checks');
  await page.locator('#rootSelect').selectOption('project'); await tab('live.json').locator('.tab-activate').click();
  assert.equal(await editor().inputValue(), cases[3][2], 'draft retained across root switch');
  await code.locator('#diagnosticsList button').first().waitFor({state:'attached'});
  delayed = await hold();
  const dialog = page.waitForEvent('dialog'), closing = tab('live.json').locator('.tab-close').click();
  await (await dialog).accept(); await closing; await tab('live.json').waitFor({state:'detached'}); delayed.release();
  await sleep(100); const closed = posts.filter(x => x.path === 'live.json').length; await sleep(1000);
  assert.equal(posts.filter(x => x.path === 'live.json').length, closed, 'closed file cannot request checks');
  await page.unroute('**/api/diagnostics');
  for (const [file, text] of Object.entries(files)) {
    assert.equal(await fs.readFile(path.join(ready.project, file), 'utf8'), text);
    assert.equal((await fs.stat(path.join(ready.project, file), {bigint:true})).mtimeNs, before[file]);
  }
  console.log('PASS: real Bash/sh/JS/TS/JSON/YAML diagnostics, unsupported zsh/shebang edits, squiggles/hover/navigation, debounce/off/retry/undo, stale text/root/closed file and preserved drafts/disk');
}))().catch(error => { console.error(error); process.exitCode = 1; });
