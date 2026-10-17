// Actual headless Chromium acceptance; filesystem writes are confined to disposable fixtures.
const { fixture, gate, dragTab, groupPoint } = require('./workspace-test-helper.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
(async () => fixture(async ({ ready, page, register, row, tab, frame, open, requests }) => {
  const special = '한글 "quoted".txt';
  await fs.mkdir(path.join(ready.project, 'actions')); await fs.mkdir(path.join(ready.project, 'actions/inside'));
  await fs.writeFile(path.join(ready.project, 'actions', special), 'DISK BYTES\n');
  await fs.writeFile(path.join(ready.project, 'actions/inside/child.txt'), 'child disk\n');
  await fs.writeFile(path.join(ready.project, 'actions/inside/.hidden'), 'hidden disk');
  await fs.writeFile(path.join(ready.project, 'actions/inside/view.html'), '<link rel="stylesheet" href="style.css"><h1>relative asset</h1><script>parent.PWNED=1</script>');
  await fs.writeFile(path.join(ready.project, 'actions/inside/style.css'), 'h1 {color:rgb(1, 2, 3)}');
  await fs.writeFile(path.join(ready.project, 'mode.py'), '# Heading\n\n$E=mc^2$\n');
  await fs.writeFile(path.join(ready.project, 'saving.txt'), 'save baseline');
  await fs.writeFile(path.join(ready.project, 'readonly-large.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 120));
  const canary = path.join(path.dirname(ready.project), 'delete-canary.txt'); await fs.writeFile(canary, 'OUTSIDE SAFE');
  await fs.symlink(canary, path.join(ready.project, 'outside-action-link'));
  await fs.symlink(ready.results, path.join(ready.project, 'outside-folder-link'));
  await register('other', ready.results); await page.goto(ready.url);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(ready.url).origin });
  const fsDialog = page.locator('#fsDialog');
  const fsResponses = [];
  page.on('response', response => { if (new URL(response.url()).pathname === '/api/fs') fsResponses.push(response); });
  async function context(file) {
    if (file) { const parts = file.split('/'); for (let i = 1; i < parts.length; i++) { const parent = row(parts.slice(0, i).join('/')); await parent.waitFor(); if (await parent.getAttribute('aria-expanded') !== 'true') await parent.click(); } }
    if (file) { const unavailable = await row(file).getAttribute('aria-disabled') === 'true'; if (unavailable) { await row(file).evaluate(n => n.scrollIntoView({block:'nearest'})); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); } await row(file).click({ button: 'right', force: unavailable }); }
    else { const r = await page.locator('#entries').boundingBox(); await page.mouse.click(r.x + r.width - 4, r.y + r.height - 4, { button: 'right' }); }
    await page.locator('#treeMenu').waitFor();
  }
  async function action(file, name) { await context(file); await page.locator('#context' + name).click(); }
  async function submitted(actionName, run) {
    const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/fs' && r.request().method() === 'POST' && r.request().postDataJSON().action === actionName);
    pending.catch(() => {}); await run(); const response = await pending; const result = { status: response.status(), body: await response.json() }; await page.waitForFunction(() => !fsOperation); if (await fsDialog.isVisible() && await page.locator('#fsSubmit').isHidden()) await page.locator('#fsCancel').click(); return result;
  }
  async function named(file, actionName, name) {
    await action(file, actionName === 'mkdir' ? 'NewFolder' : 'Rename'); await fsDialog.waitFor(); await page.locator('#fsName').fill(name);
    return submitted(actionName, () => page.locator('#fsSubmit').click());
  }
  const deleteRequests = () => requests.filter(r => new URL(r.url).pathname === '/api/fs' && r.method === 'POST').length;
  async function confirmation(file, accept, during) {
    await action(file, 'Delete'); await fsDialog.waitFor(); await page.locator('#fsSubmit').waitFor(); await page.waitForFunction(() => !document.querySelector('#fsSubmit').disabled);
    const message = await page.locator('#fsDescription').textContent();
    assert.match(message, /really delete\?/i); assert(message.includes(path.basename(file)), 'confirmation names the selected item');
    assert(message.includes(path.join(ready.project, file)), 'confirmation includes server absolute path');
    if (during) await during(message);
    await page.locator(accept ? '#fsSubmit' : '#fsCancel').click(); return message;
  }
  async function edit(file, text, root = 'project') {
    await tab(file, root).locator('.tab-activate').click(); const f = await frame(file, root); await f.locator('#editor:not([readonly])').waitFor();
    await f.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(text); await page.waitForFunction(({file,root}) => state.tabs.some(t => t.entry.path === file && t.entry.root_id === root && t.editor?.dirty), {file,root}); return f;
  }
  async function remember(file, root = 'project') {
    const id = await tab(file, root).getAttribute('data-tab');
    await page.evaluate(id => {
      const frame = document.querySelector('iframe[data-tab="' + id + '"]'), doc = frame.contentDocument, editor = doc.querySelector('#editor');
      window.fsIdentity = { frame, parent: frame.parentNode, win: frame.contentWindow, doc, editor, value: editor.value,
        start: editor.selectionStart, end: editor.selectionEnd, session: frame.contentWindow.fbrowseEditor.session, loads: 0 };
      frame.addEventListener('load', () => fsIdentity.loads++);
    }, id); return id;
  }
  async function preserved(label) {
    assert(await page.evaluate(() => { const x = fsIdentity; return x.frame.isConnected && x.parent === x.frame.parentNode && x.win === x.frame.contentWindow && x.doc === x.frame.contentDocument && x.editor === x.doc.querySelector('#editor') && x.value === x.editor.value && x.start === x.editor.selectionStart && x.end === x.editor.selectionEnd && x.session === x.win.fbrowseEditor.session && x.loads === 0; }), label);
  }
  console.log('Filesystem browser: nine real menu entries and literal clipboard paths');
  await context('actions');
  const menu = ['NewFile', 'NewFolder', 'CopyFile', 'PasteFile', 'CopyPath', 'CopyRelativePath', 'Duplicate', 'Rename', 'Delete'];
  assert.equal(await page.locator('#treeMenu [role="menuitem"]').count(), 9);
  for (const id of menu) assert(await page.locator('#context' + id).isVisible(), id);
  await page.screenshot({path:'/tmp/fbrowse-context-menu-0.9.1.png',fullPage:true});
  await page.keyboard.press('Escape'); await row('actions').click();
  for (const [file, absolute, relative] of [['actions', path.join(ready.project, 'actions'), 'actions'], ['actions/' + special, path.join(ready.project, 'actions', special), 'actions/' + special]]) {
    await action(file, 'CopyPath'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), absolute);
    await action(file, 'CopyRelativePath'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), relative);
  }
  await page.locator('#home').click(); await action(null, 'CopyPath'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), ready.project);
  await action(null, 'CopyRelativePath'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '');
  await context(null); for (const id of ['Duplicate', 'Rename', 'Delete']) assert(await page.locator('#context' + id).isDisabled(), 'root ' + id); await page.keyboard.press('Escape');
  await page.locator('#rootSelect').selectOption('other'); await action('same.txt', 'CopyPath'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), path.join(ready.results, 'same.txt'));
  await action('same.txt', 'CopyRelativePath'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'same.txt');
  await open('same.txt'); const other = await edit('same.txt', ' OTHER DRAFT', 'other');
  await page.locator('#rootSelect').selectOption('project');

  console.log('Filesystem browser: nested file/folder creation at clicked target');
  assert.equal((await named(null, 'mkdir', 'root-created')).status, 201); assert((await fs.stat(path.join(ready.project, 'root-created'))).isDirectory());
  assert.equal((await named('actions', 'mkdir', 'new folder')).status, 201);
  if (await row('actions').getAttribute('aria-expanded') !== 'true') await row('actions').click(); await row('actions/new folder').waitFor();
  assert.equal((await named('actions/' + special, 'mkdir', 'beside file')).status, 201);
  await action('actions/inside', 'NewFile'); await page.locator('#newFileName').fill('clicked.md');
  const create = page.waitForResponse(r => new URL(r.url()).pathname === '/api/create' && r.request().method() === 'POST'); await page.locator('#createNewFile').click(); assert.equal((await create).status(), 201);
  assert.equal(await fs.readFile(path.join(ready.project, 'actions/inside/clicked.md'), 'utf8'), '');
  assert((await fs.stat(path.join(ready.project, 'actions/beside file'))).isDirectory());
  await action('actions', 'NewFolder'); await page.locator('#fsName').fill('cancelled'); await page.locator('#fsCancel').click(); await assert.rejects(fs.stat(path.join(ready.project, 'actions/cancelled')), { code: 'ENOENT' });

  console.log('Filesystem browser: duplicate dirty disk bytes, binary bytes, directory hidden child and links');
  // Open the actual file while retaining all background draft editors.
  if (!(await row('actions/' + special).isVisible())) await row('actions').click();
  const specialPath = 'actions/' + special; await open(specialPath); const specialFrame = await edit(specialPath, 'UNSAVED');
  const duplicate = await submitted('duplicate', () => action(specialPath, 'Duplicate')); assert.equal(duplicate.status, 201, JSON.stringify(duplicate));
  assert.equal(await fs.readFile(path.join(ready.project, duplicate.body.path), 'utf8'), 'DISK BYTES\n'); assert.equal(await specialFrame.locator('#editor').inputValue(), 'DISK BYTES\nUNSAVED');
  const duplicate2 = await submitted('duplicate', () => action(specialPath, 'Duplicate')); assert.equal(duplicate2.status, 201); assert.notEqual(duplicate.body.path, duplicate2.body.path);
  const binary = Buffer.alloc(10 * 1024 * 1024 + 5); for (let i = 0; i < binary.length; i++) binary[i] = i % 251;
  await fs.writeFile(path.join(ready.project, 'bytes.bin'), binary);
  // Refresh listing without reloading a dirty editor: collapse/expand tree through Home.
  await page.locator('#home').click();
  if (!(await row('bytes.bin').isVisible())) { await page.locator('#rootSelect').selectOption('other'); await page.locator('#rootSelect').selectOption('project'); }
  const beforeRequests = requests.length;
  const binaryCopy = await submitted('duplicate', () => action('bytes.bin', 'Duplicate')); assert.equal(binaryCopy.status, 201);
  assert.equal(hash(await fs.readFile(path.join(ready.project, binaryCopy.body.path))), hash(binary));
  assert.equal(requests.slice(beforeRequests).filter(r => ['/api/text', '/api/editor'].includes(new URL(r.url).pathname) && new URL(r.url).searchParams.get('path') === 'bytes.bin').length, 0, 'binary duplicate never fetches whole text');
  const folderCopy = await submitted('duplicate', () => action('actions', 'Duplicate')); assert.equal(folderCopy.status, 201);
  assert.equal(await fs.readFile(path.join(ready.project, folderCopy.body.path, 'inside/.hidden'), 'utf8'), 'hidden disk');
  const linkCopy = await submitted('duplicate', () => action('outside-action-link', 'Duplicate')); assert.equal(linkCopy.status, 201);
  assert((await fs.lstat(path.join(ready.project, linkCopy.body.path))).isSymbolicLink()); assert.equal(await fs.readlink(path.join(ready.project, linkCopy.body.path)), canary);

  console.log('Filesystem browser: file/folder rename retains iframe/editor/session/selection/native undo and saves new path only');
  if (!(await row(specialPath).isVisible())) await row('actions').click();
  await tab(specialPath).locator('.tab-activate').click(); await specialFrame.locator('#editor').evaluate(n => n.setSelectionRange(2, 7)); const specialId = await remember(specialPath);
  const renamed = await named(specialPath, 'rename', 'renamed 한글.txt'); assert.equal(renamed.status, 200, JSON.stringify(renamed)); await tab('actions/renamed 한글.txt').waitFor();
  assert.equal(await tab('actions/renamed 한글.txt').getAttribute('data-tab'), specialId); await preserved('file rename preserves fixed browsing/editor objects and selection');
  await specialFrame.locator('#editor').focus(); await page.keyboard.press('Control+z'); assert.equal(await specialFrame.locator('#editor').inputValue(), 'DISK BYTES\n');
  await page.keyboard.press('Control+Shift+z'); assert.equal(await specialFrame.locator('#editor').inputValue(), 'DISK BYTES\nUNSAVED');
  await page.keyboard.press('Control+s'); await specialFrame.locator('#notice').filter({ hasText: 'Saved.' }).waitFor();
  assert.equal(await fs.readFile(path.join(ready.project, 'actions/renamed 한글.txt'), 'utf8'), 'DISK BYTES\nUNSAVED'); await assert.rejects(fs.stat(path.join(ready.project, specialPath)), { code: 'ENOENT' });
  await row('actions/inside').click(); await open('actions/inside/child.txt'); const child = await edit('actions/inside/child.txt', 'CHILD DRAFT');
  await open('actions/inside/view.html'); const html = await frame('actions/inside/view.html'); await html.frameLocator('#htmlPreview').locator('h1').waitFor();
  await tab('actions/inside/child.txt').locator('.tab-activate').click(); await dragTab(page,'actions/inside/child.txt',groupPoint(page,'actions/inside/view.html','right'));
  await child.locator('#editor').evaluate(n => n.setSelectionRange(1, 5)); const childId = await remember('actions/inside/child.txt');
  const folderRename = await named('actions/inside', 'rename', 'moved'); assert.equal(folderRename.status, 200, JSON.stringify(folderRename));
  await tab('actions/moved/child.txt').waitFor(); assert.equal(await tab('actions/moved/child.txt').getAttribute('data-tab'), childId); await preserved('folder rename preserves dirty child');
  assert.equal(await page.locator('.workspace-slot.is-visible').count(), 2); await child.locator('#editor').focus(); await page.keyboard.press('Control+s'); await child.locator('#notice').filter({hasText:'Saved.'}).waitFor();
  assert.equal(await fs.readFile(path.join(ready.project, 'actions/moved/child.txt'), 'utf8'), 'child disk\nCHILD DRAFT'); await assert.rejects(fs.stat(path.join(ready.project, 'actions/inside')), { code: 'ENOENT' });
  await tab('actions/moved/view.html').locator('.tab-activate').click();
  await html.frameLocator('#htmlPreview').locator('h1').waitFor();
  assert.equal(await html.frameLocator('#htmlPreview').locator('h1').evaluate(n => getComputedStyle(n).color), 'rgb(1, 2, 3)');
  assert.equal(await html.locator('body').evaluate(() => window.PWNED), undefined);
  assert.equal(await other.locator('#editor').inputValue(), 'results OTHER DRAFT');

  console.log('Filesystem browser: extension changes and inflight-save rename refusal preserve recovery');
  await page.locator('#home').click(); await open('mode.py'); const mode = await frame('mode.py'); await mode.locator('#editor:not([readonly])').waitFor();
  const changedMode = await named('mode.py', 'rename', 'mode.md'); assert.equal(changedMode.status, 200); await tab('mode.md').waitFor();
  assert.equal(await mode.locator('#editor').inputValue(), '# Heading\n\n$E=mc^2$\n');
  await mode.locator('#mode').click(); await mode.locator('#markdown .katex').waitFor();
  await open('saving.txt'); const saving = await edit('saving.txt', ' SAVE DRAFT');
  const saveHeld = gate(), saveStarted = gate(), saveFinished = gate();
  await page.route('**/api/save', async route => { const response = await route.fetch(); saveStarted.release(); await saveHeld.promise; await route.fulfill({ response }); saveFinished.release(); });
  await saving.locator('#editor').focus(); await page.keyboard.press('Control+s'); await saveStarted.promise;
  await action('saving.txt', 'Rename'); await page.locator('#fsName').fill('saving-new.txt');
  const beforeBusyRename = deleteRequests(); await page.locator('#fsSubmit').click();
  await page.locator('#fsMessage').filter({hasText:/save|saving/i}).waitFor(); await page.waitForFunction(() => !fsOperation);
  assert.equal(deleteRequests(), beforeBusyRename, 'inflight save rejects rename before mutation POST');
  assert.equal(await saving.locator('#editor').inputValue(), 'save baseline SAVE DRAFT'); assert(await page.locator('#fsSubmit').isEnabled());
  saveHeld.release(); await saveFinished.promise; await page.unroute('**/api/save'); await saving.locator('#notice').filter({hasText:'Saved.'}).waitFor(); await page.locator('#fsCancel').click();
  assert.equal(await fs.readFile(path.join(ready.project, 'saving.txt'), 'utf8'), 'save baseline SAVE DRAFT'); await assert.rejects(fs.stat(path.join(ready.project, 'saving-new.txt')), {code:'ENOENT'});
  // Explicit server failures restore controls; no automatic duplicate retry.
  await page.route('**/api/fs', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({error:'Injected duplicate failure'}) }));
  const failedCopy = await submitted('duplicate', () => action('saving.txt', 'Duplicate')); assert.equal(failedCopy.status, 500);
  assert(await page.locator('#fsCancel').isEnabled()); assert(await page.locator('#fsSubmit').isEnabled()); await page.locator('#fsCancel').click(); await page.unroute('**/api/fs');
  // Accelerate only the app's 30s timeout clock; the request is genuinely aborted before reaching the server.
  const timeoutHeld = gate(), timeoutStarted = gate();
  await page.evaluate(() => { window.fsRealTimeout = window.setTimeout; window.setTimeout = (callback, delay, ...args) => fsRealTimeout(callback, delay === 30000 ? 100 : delay, ...args); });
  await page.route('**/api/fs', async route => { timeoutStarted.release(); await timeoutHeld.promise; await route.abort().catch(() => {}); });
  await action('saving.txt', 'Rename'); await page.locator('#fsName').fill('timeout-name.txt'); await page.locator('#fsSubmit').click(); await timeoutStarted.promise;
  await page.locator('#fsMessage').filter({hasText:/timed out/i}).waitFor(); await page.waitForFunction(() => !fsOperation);
  assert.equal(await page.locator('#fsName').inputValue(), 'timeout-name.txt'); assert(await page.locator('#fsCancel').isEnabled()); assert(await page.locator('#fsName').isEditable());
  assert.equal(await saving.locator('#editor').inputValue(), 'save baseline SAVE DRAFT');
  assert.match(await page.locator('#fsMessage').textContent(), /may already have changed/i);
  timeoutHeld.release(); await page.unroute('**/api/fs'); await page.evaluate(() => { window.setTimeout = window.fsRealTimeout; }); await page.locator('#fsCancel').click();
  assert.equal(await fs.readFile(path.join(ready.project, 'saving.txt'), 'utf8'), 'save baseline SAVE DRAFT'); await assert.rejects(fs.stat(path.join(ready.project, 'timeout-name.txt')), {code:'ENOENT'});

  console.log('Filesystem browser: large readonly viewer can rename and delete without blocking clean tabs');
  await page.locator('#home').click(); await open('readonly-large.txt'); const readonly = await frame('readonly-large.txt');
  await readonly.locator('#editor[aria-label="File source (read only)"]').waitFor(); assert(await readonly.locator('#editor').evaluate(n => n.readOnly));
  const readonlyRename = await named('readonly-large.txt', 'rename', 'readonly-moved.txt'); assert.equal(readonlyRename.status, 200, JSON.stringify(readonlyRename));
  await tab('readonly-moved.txt').waitFor(); assert(await readonly.locator('#editor').evaluate(n => n.readOnly));
  const readonlyDelete = await submitted('delete', () => confirmation('readonly-moved.txt', true)); assert.equal(readonlyDelete.status, 200, JSON.stringify(readonlyDelete));
  assert.equal(await tab('readonly-moved.txt').count(), 0);

  console.log('Filesystem browser: stale draft rename rejects; postrename external save conflicts');
  await tab('actions/renamed 한글.txt').locator('.tab-activate').click(); await edit('actions/renamed 한글.txt', ' KEEP DRAFT');
  await fs.writeFile(path.join(ready.project, 'actions/renamed 한글.txt'), 'EXTERNAL BEFORE');
  const conflict = await named('actions/renamed 한글.txt', 'rename', 'must-not-exist.txt'); assert.equal(conflict.status, 409);
  assert(await fsDialog.isVisible()); assert.equal(await page.locator('#fsName').inputValue(), 'must-not-exist.txt'); assert(await page.locator('#fsSubmit').isEnabled());
  await page.locator('#fsCancel').click(); assert.equal(await specialFrame.locator('#editor').inputValue(), 'DISK BYTES\nUNSAVED KEEP DRAFT');
  await fs.writeFile(path.join(ready.project, 'actions/moved/child.txt'), 'EXTERNAL AFTER');
  await tab('actions/moved/child.txt').locator('.tab-activate').click(); await edit('actions/moved/child.txt', ' STALE SAVE');
  const saveConflict = page.waitForResponse(r => new URL(r.url()).pathname === '/api/save'); await page.keyboard.press('Control+s'); assert.equal((await saveConflict).status(), 409);
  assert.equal(await fs.readFile(path.join(ready.project, 'actions/moved/child.txt'), 'utf8'), 'EXTERNAL AFTER'); assert((await child.locator('#editor').inputValue()).includes('STALE SAVE'));

  console.log('Filesystem browser: delete always confirms, cancellation sends no POST, folder warning and scoped tab closure');
  // A clean file still requires confirmation. Cancel must not even send a delete POST.
  const beforeCancel = deleteRequests(); await confirmation('same.txt', false); assert.equal(deleteRequests(), beforeCancel);
  assert.equal(await fs.readFile(path.join(ready.project, 'same.txt'), 'utf8'), 'project');
  const beforeDirtyCancel = deleteRequests(); const warning = await confirmation('actions/moved', false, () => page.screenshot({path:'/tmp/fbrowse-delete-confirmation-0.9.1.png',fullPage:true}));
  assert.match(warning, /contents|children/i); assert.match(warning, /unsaved|draft/i); assert.equal(deleteRequests(), beforeDirtyCancel);
  assert.equal(await tab('actions/moved/child.txt').count(), 1);
  await page.clock.install();
  const deleteHeld = gate(), deleteStarted = gate();
  await page.route('**/api/fs', async route => { const response = await route.fetch(); deleteStarted.release(); await deleteHeld.promise; await route.fulfill({response}); });
  const deleting = submitted('delete', () => confirmation('actions/moved', true)); await deleteStarted.promise;
  await page.clock.fastForward(31_000); assert.equal(await page.evaluate(() => fsOperation?.action), 'delete', 'recursive deletion survives more than thirty virtual seconds');
  await page.locator('#fsCancel').click(); assert(await page.locator('#fsProgress').isVisible());
  await open('same.txt'); const unrelatedId = await tab('same.txt').getAttribute('data-tab');
  const pendingTabs = await page.locator('.file-tab').count();
  await tab('same.txt').locator('.tab-activate').click({button:'right'});
  assert(await page.getByRole('menuitem',{name:'Close Other Tabs (All Groups)',exact:true}).isDisabled(), 'actual pending deletion blocks bulk close of its frozen tabs');
  assert(await page.getByRole('menuitem',{name:'Close All Tabs (All Groups)',exact:true}).isDisabled());
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.file-tab').count(), pendingTabs);
  await page.locator('#fsProgress').click(); assert(await fsDialog.isVisible()); assert(await page.locator('#fsSubmit').isDisabled());
  deleteHeld.release(); const folderDeleted = await deleting; await page.unroute('**/api/fs'); assert.equal(folderDeleted.status, 200);
  assert.equal(await page.evaluate(() => state.activeTab), unrelatedId, 'delete completion retains unrelated active preview');
  assert.equal(await tab('actions/moved/child.txt').count(), 0); assert.equal(await tab('actions/moved/view.html').count(), 0);
  assert.equal(await tab('actions/renamed 한글.txt').count(), 1); assert.equal(await other.locator('#editor').inputValue(), 'results OTHER DRAFT');
  await assert.rejects(fs.stat(path.join(ready.project, 'actions/moved')), { code: 'ENOENT' });
  const linkDeleted = await submitted('delete', () => confirmation('outside-action-link', true)); assert.equal(linkDeleted.status, 200); assert.equal(await fs.readFile(canary, 'utf8'), 'OUTSIDE SAFE');
  const folderLinkMessage = await confirmation('outside-folder-link', false); assert.match(folderLinkMessage, /link/i);
  assert(!/contents.*delet/i.test(folderLinkMessage), 'directory symlink confirmation promises link-only deletion');
  const staleDelete = await submitted('delete', () => confirmation('same.txt', true, async () => {
    await fs.rename(path.join(ready.project, 'same.txt'), path.join(ready.project, 'previous-same.txt')); await fs.writeFile(path.join(ready.project, 'same.txt'), 'REPLACEMENT SAFE');
  }));
  assert.equal(staleDelete.status, 409); assert.equal(await fs.readFile(path.join(ready.project, 'same.txt'), 'utf8'), 'REPLACEMENT SAFE'); await page.locator('#fsCancel').click();
  const recover = await submitted('duplicate', () => action('same.txt', 'Duplicate')); assert.equal(recover.status, 201, 'controls recover after failed delete');
  assert.equal(await fs.readFile(path.join(ready.results, 'same.txt'), 'utf8'), 'results');

  console.log('Filesystem browser: late lookup cannot change a newer dialog target');
  const lookupHeld = gate(), lookupStarted = gate(), lookupDone = gate();
  await page.route('**/api/fs-info**', async route => { if (new URL(route.request().url()).searchParams.get('path') !== 'same.txt') return route.continue(); const response = await route.fetch(); lookupStarted.release(); await lookupHeld.promise; await route.fulfill({response}); lookupDone.release(); });
  await action('same.txt', 'Rename'); await lookupStarted.promise; await page.locator('#fsCancel').click();
  await action('mode.md', 'Rename'); await page.waitForFunction(() => !document.querySelector('#fsSubmit').disabled); const currentTarget = await page.locator('#fsTarget').textContent();
  lookupHeld.release(); await lookupDone.promise; await page.unroute('**/api/fs-info**');
  assert.equal(await page.locator('#fsName').inputValue(), 'mode.md'); assert.equal(await page.locator('#fsTarget').textContent(), currentTarget); await page.locator('#fsCancel').click();

  console.log('Filesystem browser: held mutation cannot hijack switched root');
  const held = gate(), started = gate();
  await page.route('**/api/fs', async route => { if (route.request().postDataJSON().action !== 'duplicate') return route.continue(); const response = await route.fetch(); started.release(); await held.promise; await route.fulfill({ response }); });
  const beforeHeld = deleteRequests();
  const pending = submitted('duplicate', () => action('same.txt', 'Duplicate')); await started.promise;
  await page.clock.fastForward(31_000); assert.equal(await page.evaluate(() => fsOperation?.action), 'duplicate', 'duplicate survives thirty virtual seconds');
  await page.screenshot({path:'/tmp/fbrowse-filesystem-progress-0.9.1.png',fullPage:true});
  await page.locator('#fsCancel').click(); assert(await page.locator('#fsProgress').isVisible());
  await page.locator('#fsProgress').click(); assert(await fsDialog.isVisible()); assert(await page.locator('#fsSubmit').isDisabled());
  assert.equal(deleteRequests(), beforeHeld + 1, 'hide/reopen never resubmits'); await page.locator('#fsCancel').click();
  await page.locator('#rootSelect').selectOption('other'); await row('README.md').waitFor(); await open('README.md'); const previewId = await tab('README.md', 'other').getAttribute('data-tab');
  held.release(); assert.equal((await pending).status, 201); await page.unroute('**/api/fs');
  assert.equal(await page.locator('#rootSelect').inputValue(), 'other'); assert.equal(await page.evaluate(() => state.activeTab), previewId); assert.equal(await other.locator('#editor').inputValue(), 'results OTHER DRAFT');
  await page.locator('#rootSelect').selectOption('project'); await row('same.txt').waitFor();
  const cleanDeleted = await submitted('delete', () => confirmation('same.txt', true)); assert.equal(cleanDeleted.status, 200);
  assert.equal(await tab('same.txt').count(), 0); assert.equal(await tab('same.txt', 'other').count(), 1);
  assert.equal(await other.locator('#editor').inputValue(), 'results OTHER DRAFT'); assert.equal(await fs.readFile(path.join(ready.results, 'same.txt'), 'utf8'), 'results');
  await page.screenshot({ path: '/tmp/fbrowse-filesystem-0.9.1.png', fullPage: true });
  assert(fsResponses.length >= 15);
  console.log('PASS: nine actions, literal/root clipboard, nested creation, disk/binary/directory/link copy, rename editor identity/undo/new save/assets, stale versions, always-confirm delete/cancel/no POST/scoped tabs/link canary/race, held-root response');
}))().catch(error => { console.error(error); process.exitCode = 1; });
