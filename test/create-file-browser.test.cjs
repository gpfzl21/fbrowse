const { fixture, gate } = require('./workspace-test-helper.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
(async () => fixture(async ({ ready, page, post, register, row, tab, frame, dismiss }) => {
  await fs.mkdir(ready.project + '/nested/deeper'); await register('other', ready.results); await page.goto(ready.url);
  const dialog = page.locator('#newFileDialog'), nameInput = page.locator('#newFileName');
  async function context(file, keyboard) {
    if (file) {
      if (keyboard) { await row(file).focus(); await page.keyboard.press(keyboard); }
      else await row(file).click({ button: 'right' });
    } else {
      const r = await page.locator('#entries').boundingBox(); await page.mouse.click(r.x + r.width - 5, r.y + r.height - 5, { button: 'right' });
    }
    await page.locator('#contextNewFile').waitFor(); await page.locator('#contextNewFile').click(); await dialog.waitFor();
  }
  async function create(name) {
    await nameInput.fill(name); const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/create' && r.request().method() === 'POST');
    await page.locator('#createNewFile').click(); return response;
  }
  async function checkSource(file, root = 'project') {
    const f = await frame(file, root); await f.locator('#editor:not([readonly])').waitFor();
    assert.equal(await f.locator('#editor').inputValue(), ''); assert.equal(await f.locator('#editor').getAttribute('readonly'), null);
    assert(await f.locator('#editor').evaluate(n => document.activeElement === n));
    assert(!await f.locator('body').evaluate(() => new URL(location.href).searchParams.has('initialTab')));
    return f;
  }
  console.log('Create file: real context menus, captured targets and source-first editors');
  await context('nested'); assert.match(await page.locator('#newFileTarget').textContent(), /project.*\/nested$/);
  await nameInput.fill('cancelled.md'); await page.locator('#cancelNewFile').click();
  await assert.rejects(fs.stat(ready.project + '/nested/cancelled.md'), { code: 'ENOENT' });
  await row('nested').click(); await row('nested/deeper').waitFor(); await context('nested/deeper', 'Shift+F10');
  const name = '한글 "quoted" $ ` ; &.md', nested = 'nested/deeper/' + name;
  assert.equal((await create(name)).status(), 201); await row(nested).waitFor();
  const md = await checkSource(nested); assert.equal(await fs.readFile(ready.project + '/' + nested, 'utf8'), '');
  await md.locator('#editor').focus(); await page.keyboard.insertText('# Saved 한글\n\n$E=mc^2$\n'); await page.keyboard.press('Control+s');
  await md.locator('#notice').filter({ hasText: '저장했습니다.' }).waitFor();
  assert.equal(await fs.readFile(ready.project + '/' + nested, 'utf8'), '# Saved 한글\n\n$E=mc^2$\n');
  const preference = page.waitForResponse(r => new URL(r.url()).pathname === '/api/view-state' && r.request().method() === 'POST');
  await md.locator('#mode').click(); await preference; await md.locator('#markdown .katex').first().waitFor();
  await page.locator('#refresh').click(); const reloaded = await frame(nested); await reloaded.locator('#markdown .katex').first().waitFor();
  assert.equal(await reloaded.locator('#mode').getAttribute('aria-pressed'), 'false', 'explicit preview choice survives new-file reload');
  // A file context creates beside that file, not inside a filename.
  await context(nested, 'ContextMenu'); assert.match(await page.locator('#newFileTarget').textContent(), /\/nested\/deeper$/);
  const existing = await create(name); assert.equal(existing.status(), 409); assert(await dialog.isVisible()); assert.equal(await nameInput.inputValue(), name);
  assert.equal(await fs.readFile(ready.project + '/' + nested, 'utf8'), '# Saved 한글\n\n$E=mc^2$\n');
  await nameInput.fill('../escape'); await page.locator('#createNewFile').click(); assert(await dialog.isVisible()); assert.match(await page.locator('#newFileMessage').textContent(), /이름|구분자/);
  await page.locator('#cancelNewFile').click();
  await page.locator('#home').click(); await context(); assert.match(await page.locator('#newFileTarget').textContent(), /project.*\/$/);
  assert.equal((await create('blank.unknown')).status(), 201); await checkSource('blank.unknown');
  await page.locator('#newFile').focus(); await page.keyboard.press('Enter'); assert.equal((await create('new.html')).status(), 201); await checkSource('new.html');
  // External roots use the captured boundary, including nested file-parent context.
  await page.locator('#rootSelect').selectOption('other'); await row('nested').click(); await context('nested/README.md');
  assert.match(await page.locator('#newFileTarget').textContent(), /other.*\/nested$/);
  assert.equal((await create('external.md')).status(), 201); await checkSource('nested/external.md', 'other');
  assert.equal(await fs.readFile(ready.results + '/nested/external.md', 'utf8'), '');
  await assert.rejects(fs.stat(ready.project + '/nested/external.md'), { code: 'ENOENT' });
  // Finish a held response after root switch: it can only open the captured root/path.
  await page.locator('#rootSelect').selectOption('project'); await row('same.txt').waitFor(); await page.locator('#newFile').click();
  const pending = gate(), started = gate();
  await page.route('**/api/create', async route => { const response = await route.fetch(); started.release(); await pending.promise; await route.fulfill({ response }); });
  await nameInput.fill('pending.md'); await page.locator('#createNewFile').click(); await started.promise;
  assert(await page.locator('#cancelNewFile').isDisabled()); assert(await nameInput.evaluate(n => n.readOnly));
  await page.keyboard.press('Escape'); assert(await dialog.isVisible());
  await page.locator('#rootSelect').selectOption('other'); pending.release();
  await page.waitForFunction(() => !document.querySelector('#createNewFile').disabled);
  assert.equal(await page.locator('#rootSelect').inputValue(), 'other', 'held completion cannot hijack changed root');
  assert.equal(await tab('pending.md').count(), 0); assert.equal(await tab('pending.md', 'other').count(), 0);
  await page.unroute('**/api/create'); if(await dialog.isVisible())await page.locator('#cancelNewFile').click();
  assert.equal(await fs.readFile(ready.project + '/pending.md', 'utf8'), ''); await assert.rejects(fs.stat(ready.results + '/pending.md'), { code: 'ENOENT' });
  // Refresh exposes newly created files as actual Git untracked entries.
  await tab('blank.unknown').locator('.tab-activate').click(); await page.locator('#refresh').click();
  await page.locator('#gitTab').click(); await page.locator('#gitPanel [data-path="pending.md"]').first().waitFor();
  // Independent HTTP boundary, auth, atomicity and permissions checks supplement UI.
  const parallel = await Promise.all([0, 1, 2].map(() => post('api/create', { root: 'project', parent: '', name: 'parallel.txt' })));
  assert.deepEqual(parallel.map(r => r.status()).sort(), [201, 409, 409]);
  for (const data of [
    { root: 'project', parent: '../', name: 'outside.txt' }, { root: 'project', parent: '', name: '../outside.txt' },
    { root: 'missing', parent: '', name: 'missing.txt' }, { root: 'project', parent: '', name: '/absolute' },
  ]) assert((await post('api/create', data)).status() >= 400);
  await fs.mkdir(ready.project + '/blocked'); await fs.chmod(ready.project + '/blocked', 0o555);
  assert.equal((await post('api/create', { root: 'project', parent: 'blocked', name: 'denied.txt' })).status(), 403);
  await assert.rejects(fs.stat(ready.project + '/blocked/denied.txt'), { code: 'ENOENT' }); await fs.chmod(ready.project + '/blocked', 0o755);
  await fs.rename(ready.results, ready.results + '-offline');
  assert((await post('api/create', { root: 'other', parent: '', name: 'offline.txt' })).status() >= 400);
  await assert.rejects(fs.stat(ready.results + '-offline/offline.txt'), { code: 'ENOENT' });
  await page.screenshot({ path: '/tmp/fbrowse-create-0.9.1.png', fullPage: true });
  console.log('PASS: folder/file/blank/external-root menus, ShiftF10/ContextMenu/button, special filenames, cancel/conflict, source-first save/preview persistence, root race, Git untracked and HTTP atomicity/bounds/permissions');
}, { git: true }))().catch(error => { console.error(error); process.exitCode = 1; });
