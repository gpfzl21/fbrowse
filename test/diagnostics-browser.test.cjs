// Physical Chromium inputs and real checkers; all sources live in disposable roots.
const { fixture, gate, dragTab, groupPoint, expandTab } = require('./workspace-test-helper.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) { for (let i = 0; i < 160; i++) { if (await check()) return; await sleep(50); } assert.fail(message); }
(async () => fixture(async ({ ready, browser, page, row, tab, frame, open, register }) => {
  const original = '# ' + '한글\tabc '.repeat(90) + '\nvalue = 1\n';
  const texOriginal = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';
  const files = { 'diagnostics.py': original, 'diagnostics.tex': texOriginal, 'readonly.py': 'value = 1\n',
    'overlimit.py': '#'.repeat(512 * 1024 + 1), 'rename.py': 'value = 1\n', 'delete.py': 'value = 1\n' };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(ready.project, name), text);
  await fs.chmod(path.join(ready.project, 'readonly.py'), 0o444);
  const before = Object.fromEntries(await Promise.all(Object.keys(files).map(async name => [name, { bytes: await fs.readFile(path.join(ready.project, name)), mtime: (await fs.stat(path.join(ready.project, name), { bigint: true })).mtimeNs }])));
  await fs.writeFile(path.join(ready.results, 'detached.py'), 'value = 1\n');
  await register('other', ready.results);
  const posts = [], responses = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/diagnostics') posts.push({ time: Date.now(), body: request.postDataJSON() }); });
  page.on('response', response => { if (new URL(response.url()).pathname === '/api/diagnostics') responses.push(response); });
  await page.goto(ready.url);
  let code = await open('diagnostics.py');
  const editor = () => code.locator('#editor');
  const status = () => code.locator('#diagnosticsStatus');
  const clean = async (target = code) => { await target.locator('#diagnosticsStatus').filter({ hasText: /오류 0 · 경고 0/ }).waitFor(); };
  const replace = async value => { await editor().focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(value); assert.equal(await editor().inputValue(), value); };
  const showProblems = async (target = code) => { if (await target.locator('#diagnosticsPanel').isHidden()) await target.locator('#diagnosticsToggle').click(); };
  await clean(); assert.ok(posts.some(post => post.body.path === 'diagnostics.py'));
  await code.locator('#diagnosticsToggle').click();
  assert.equal(await code.locator('#diagnosticsPanel').isVisible(), true);
  const firstId = await tab('diagnostics.py').getAttribute('data-tab');
  await page.evaluate(id => {
    const iframe = document.querySelector('iframe[data-tab="' + id + '"]');
    window.diagnosticIdentity = { iframe, win: iframe.contentWindow, doc: iframe.contentDocument, editor: iframe.contentDocument.querySelector('#editor') };
  }, firstId);
  console.log('Diagnostics browser: debounce, unsaved error/warning list, native undo and navigation');
  const start = posts.length;
  await replace(original + 'import os\n'); await sleep(180);
  await page.keyboard.insertText('def broken('); await sleep(180); await page.keyboard.insertText(':\n');
  const finalInputAt = Date.now(); await sleep(500); assert.equal(posts.length, start, 'no request during input burst or before debounce');
  await until(() => Promise.resolve(posts.length === start + 1), 'one request after typing pause');
  assert.ok(posts.at(-1).time - finalInputAt >= 650, 'approximately 800ms debounce');
  await code.locator('#diagnosticsList .diagnostic-error').first().waitFor({ state: 'attached' });
  assert.equal(posts.at(-1).body.text, await editor().inputValue(), 'current unsaved text sent to checker');
  assert.equal(await fs.readFile(path.join(ready.project, 'diagnostics.py'), 'utf8'), original);
  assert.ok(await code.locator('#lines [data-diagnostic-severity="error"]').count());
  await replace(original + 'import os\n');
  const warning = code.locator('#diagnosticsList button').filter({ hasText: 'F401' }); await warning.waitFor({ state: 'attached' }); await showProblems();
  await warning.click();
  assert.equal(await editor().evaluate(node => node.selectionStart), original.length + 'import '.length, 'line/column navigation selects exact source column');
  await editor().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('# undo canary\n');
  await page.keyboard.press('Control+z'); assert.equal(await editor().inputValue(), original + 'import os\n', 'native undo preserved');
  await page.keyboard.press('Control+Shift+z'); assert.equal(await editor().inputValue(), original + 'import os\n# undo canary\n');
  const unicode = '한글 = \"😀\"; missing_name\n'; await replace(unicode);
  await code.locator('#diagnosticsList button').filter({ hasText: 'F821' }).waitFor({ state: 'attached' });
  await showProblems(); await code.locator('#diagnosticsList button').filter({ hasText: 'F821' }).click();
  assert.equal(await editor().evaluate(node => node.selectionStart), unicode.indexOf('missing_name'), 'scalar columns map to UTF16 caret after Korean and emoji');
  await replace(original); await clean();
  assert.equal(await code.locator('#lines [data-diagnostic-severity]').count(), 0, 'fix clears gutter markers');
  assert.equal(await code.locator('#diagnosticsList button').count(), 0, 'fix clears issue list');
  assert(await page.evaluate(() => { const x = diagnosticIdentity; return x.iframe.isConnected && x.win === x.iframe.contentWindow && x.doc === x.iframe.contentDocument && x.editor === x.doc.querySelector('#editor'); }), 'checking preserves frame/document/textarea identity');
  const idle = posts.length; await sleep(1300); assert.equal(posts.length, idle, 'no idle polling');
  const ime = await page.context().newCDPSession(page);
  await editor().focus(); await page.keyboard.press('Control+End');
  const beforeIme = posts.length;
  await ime.send('Input.imeSetComposition', { text: '# 한국', selectionStart: 4, selectionEnd: 4 });
  await sleep(1000); assert.equal(posts.length, beforeIme, 'no checker request during IME composition');
  await ime.send('Input.insertText', { text: '# 한국어' });
  await until(() => Promise.resolve(posts.length === beforeIme + 1), 'composition commit schedules exactly one check'); await clean(); await ime.detach();
  console.log('Diagnostics browser: wrapped logical gutters at resized Korean/tab text');
  await replace(original + 'missing_name\n');
  await code.locator('#diagnosticsList button').filter({ hasText: 'F821' }).waitFor({ state: 'attached' });
  const selected = await editor().evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd }));
  for (const width of [970, 1500]) {
    await page.setViewportSize({ width, height: 1000 }); await sleep(250);
    const deltas = await code.locator('body').evaluate(() => {
      const text = document.querySelector('#code').textContent, starts = [0];
      for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
      return starts.slice(0, -1).map((offset, index) => {
        const walker = document.createTreeWalker(document.querySelector('#code'), NodeFilter.SHOW_TEXT); let node, remaining = offset;
        while (walker.nextNode()) { node = walker.currentNode; if (remaining < node.length) break; remaining -= node.length; }
        const range = document.createRange(); range.setStart(node, remaining); range.setEnd(node, Math.min(node.length, remaining + 1));
        return Math.abs(document.querySelector('#lines').children[index].getBoundingClientRect().top - range.getBoundingClientRect().top);
      });
    }); assert.ok(deltas.every(delta => delta < 4), 'DOMRange logical gutters align after wrap: ' + deltas.join(','));
    assert.deepEqual(await editor().evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd })), selected);
  }
  // An intentionally delayed real server result must not repaint a newer edit or another active file.
  const held = [];
  let holdNext = false, unavailableNext = false;
  await page.route('**/api/diagnostics', async route => {
    if (unavailableNext) {
      unavailableNext = false; const body = route.request().postDataJSON();
      return route.fulfill({ json: { root_id: body.root, path: body.path, request_id: body.request_id, language: 'python', checker: 'ruff', status: 'unavailable', diagnostics: [], message: 'Ruff is unavailable' } });
    }
    if (!holdNext) return route.continue();
    holdNext = false; const response = await route.fetch(), release = gate(); held.push({ release, response });
    await release.promise; await route.fulfill({ response }).catch(() => {});
  });
  const hold = async () => { const count = held.length; holdNext = true; await code.locator('#diagnosticsRetry').click(); await until(() => Promise.resolve(held.length === count + 1), 'real delayed result captured'); return held.at(-1); };
  console.log('Diagnostics browser: stale edit/tab/root/group and unavailable/overlimit/readonly lifecycle');
  let delayed = await hold(); await replace(original); await clean(); delayed.release.release(); await sleep(200); await clean();
  delayed = await hold(); const inactiveCount = posts.length; const textFrame = await open('same.txt'); delayed.release.release(); await sleep(1100);
  assert.equal(posts.length, inactiveCount, 'inactive Python iframe sends no requests'); assert(await textFrame.locator('#diagnosticsControls').isHidden());
  await tab('diagnostics.py').locator('.tab-activate').click(); await clean(); code = await frame('diagnostics.py');
  delayed = await hold(); await page.locator('#rootSelect').selectOption('other'); delayed.release.release(); const rootCount = posts.length; await sleep(1100); assert.equal(posts.length, rootCount, 'selected different root deactivates retained editor');
  await page.locator('#rootSelect').selectOption('project'); await tab('diagnostics.py').locator('.tab-activate').click(); await clean();
  // A visible background split remains inactive until explicitly selected.
  await open('same.txt'); await dragTab(page, 'same.txt', groupPoint(page, 'diagnostics.py', 'right'));
  const splitCount = posts.length; await sleep(1100); assert.equal(posts.length, splitCount, 'visible background group does not check');
  await tab('diagnostics.py').locator('.tab-activate').click(); await clean();
  delayed = await hold(); await page.locator('#gitTab').click();
  await page.locator('#gitPanel button.git-row[data-path="changes/mixed.txt"][data-group="unstaged"]').click();
  await page.locator('#diffContent').filter({ hasText: 'working version' }).waitFor(); delayed.release.release();
  const diffCount = posts.length; await sleep(1100); assert.equal(posts.length, diffCount, 'diff mode disables retained current-file checks');
  await page.locator('#filesTab').click(); await row('diagnostics.py').click(); await clean();
  unavailableNext = true; await code.locator('#diagnosticsRetry').click(); await status().filter({ hasText: /사용 불가/ }).waitFor();
  assert.equal(await code.locator('#diagnosticsList button').count(), 0); await code.locator('#diagnosticsRetry').click(); await clean();
  const readonly = await open('readonly.py'); await readonly.locator('#diagnosticsStatus').filter({ hasText: '읽기 전용' }).waitFor();
  const readonlyCount = posts.length; await sleep(1000); assert.equal(posts.length, readonlyCount);
  const over = await open('overlimit.py'); await over.locator('#diagnosticsStatus').filter({ hasText: /512 KiB/ }).waitFor();
  const overCount = posts.length; await sleep(1000); assert.equal(posts.length, overCount);
  const tex = await open('diagnostics.tex'); await clean(tex); await tex.locator('#diagnosticsToggle').click();
  await tex.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('Hello world...\n');
  await tex.locator('#diagnosticsList .diagnostic-warning').first().waitFor({ state: 'attached' }); assert.ok(await tex.locator('#lines [data-diagnostic-severity="warning"]').count());
  await tex.locator('#editor').focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText('\\begin{document}\n$x\n\\end{document}\n');
  await tex.locator('#diagnosticsList .diagnostic-error').first().waitFor({ state: 'attached' });
  assert.equal(await fs.readFile(path.join(ready.project, 'diagnostics.tex'), 'utf8'), texOriginal);
  const unicodeTex = '한글😀\tHello world...\n';
  await tex.locator('#editor').focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(unicodeTex);
  const texWarning = tex.locator('#diagnosticsList button').filter({ hasText: / · 11 · / }); await texWarning.waitFor({ state: 'attached' }); await showProblems(tex); await texWarning.click();
  assert.equal(await tex.locator('#editor').evaluate(node => node.selectionStart), unicodeTex.indexOf('...'), 'ChkTeX bytes/tabs navigate Unicode native caret');

  // User-controlled checking off cancels scheduling, including edits, without idle retries.
  code = await frame('diagnostics.py'); await tab('diagnostics.py').locator('.tab-activate').click(); await clean();
  await code.locator('#diagnosticsEnabled').click(); const offCount = posts.length;
  await replace(original + 'undefined_name\n'); await sleep(1100); assert.equal(posts.length, offCount, 'checking off suppresses editing requests');
  await code.locator('#diagnosticsEnabled').click(); await code.locator('#diagnosticsList button').filter({ hasText: 'F821' }).waitFor({ state: 'attached' });
  // Expanded mode retains the established hidden application toolbar and both exit gestures.
  for (const exit of ['click', 'Escape']) {
    await expandTab(page, 'diagnostics.py'); assert(await code.locator('#previewHeader').isHidden());
    if (exit === 'click') await page.locator('#exitExpanded').click(); else { await editor().focus(); await page.keyboard.press('Escape'); }
    assert(await code.locator('#previewHeader').isVisible());
  }
  console.log('Diagnostics browser: delayed rename/delete/detach results stay bound');
  code = await open('rename.py'); await clean(); delayed = await hold();
  const renameId = await tab('rename.py').getAttribute('data-tab');
  await row('rename.py').click({ button: 'right' }); await page.locator('#contextRename').click();
  await page.locator('#fsName').fill('renamed.py'); await page.locator('#fsSubmit').click();
  await tab('renamed.py').waitFor(); assert.equal(await tab('renamed.py').getAttribute('data-tab'), renameId);
  delayed.release.release(); await clean(); assert.equal(posts.at(-1).body.path, 'renamed.py', 'renamed file receives only newly bound diagnostics');
  code = await open('delete.py'); await clean(); delayed = await hold();
  await row('delete.py').click({ button: 'right' }); await page.locator('#contextDelete').click();
  await page.locator('#fsSubmit:enabled').click(); await tab('delete.py').waitFor({ state: 'detached' });
  delayed.release.release(); const deleteCount = posts.filter(post => post.body.path === 'delete.py').length; await sleep(1100); assert.equal(posts.filter(post => post.body.path === 'delete.py').length, deleteCount, 'deleted iframe cannot request or apply results');
  await page.locator('#fsSubmit').waitFor({ state: 'hidden' }); await page.locator('#fsCancel').click();
  await page.locator('#rootSelect').selectOption('other'); code = await open('detached.py'); await clean(); delayed = await hold();
  await page.locator('#manageRoots').click();
  await page.locator('.root-record').filter({ has: page.locator('strong').filter({ hasText: /^other$/ }) }).getByRole('button', { name: '연결 제거', exact: true }).click();
  await tab('detached.py', 'other').waitFor({ state: 'detached' }); delayed.release.release();
  await page.locator('#closeRoots').click(); const detachCount = posts.filter(post => post.body.root === 'other').length; await sleep(1100); assert.equal(posts.filter(post => post.body.root === 'other').length, detachCount, 'detached root cannot request or apply results');
  assert.equal(await fs.readFile(path.join(ready.results, 'detached.py'), 'utf8'), 'value = 1\n');
  await page.unroute('**/api/diagnostics');
  for (const [name, saved] of Object.entries(before).filter(([name]) => !['rename.py', 'delete.py'].includes(name))) {
    assert.deepEqual(await fs.readFile(path.join(ready.project, name)), saved.bytes, 'original bytes ' + name);
    assert.equal((await fs.stat(path.join(ready.project, name), { bigint: true })).mtimeNs, saved.mtime, 'original mtime ' + name);
  }
  assert.deepEqual(await fs.readFile(path.join(ready.project, 'renamed.py')), before['rename.py'].bytes);
  const artifact = process.env.FBROWSE_SCREENSHOT_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-diagnostics-browser-'));
  await fs.mkdir(artifact, { recursive: true }); await page.screenshot({ path: path.join(artifact, 'diagnostics.png'), fullPage: true });
  const standalone = await browser.newPage();
  try {
    const standalonePosts = []; standalone.on('request', request => { if (new URL(request.url()).pathname === '/api/diagnostics') standalonePosts.push(request.postDataJSON()); });
    await standalone.goto(ready.url + '_preview?root=project&path=diagnostics.py');
    await standalone.locator('#diagnosticsStatus').filter({ hasText: /오류 0 · 경고 0/ }).waitFor();
    assert.equal(standalonePosts.length, 1); assert.equal(standalonePosts[0].text, original, 'standalone preview checks its current disk-bound text');
  } finally { await standalone.close(); }
  assert.ok(posts.every(post => post.body.root && post.body.path && post.body.expected_version && post.body.request_id));
  assert.ok(responses.length > 10);
  console.log('PASS: real Python/LaTeX unsaved diagnostics, debounce/IME/off/no-poll, markers/navigation, native undo/frame identity, DOMRange wrap, stale lifecycle, groups, readonly/limit/unavailable, expanded exits and unchanged disk');
}, { git: true }))().catch(error => { console.error(error); process.exitCode = 1; });
