// Real Chromium input against disposable roots, including denied clipboard permission.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, dragTab, groupPoint } = require('./workspace-test-helper.cjs');
fixture(async ({ ready, page, row, tab, frame, open, register, requests }) => {
  const original = 'nested/한글 path.txt';
  await fs.writeFile(path.join(ready.project, original), 'PROJECT\n');
  await fs.writeFile(path.join(ready.results, 'same.txt'), 'OTHER\n');
  await fs.mkdir(path.join(ready.project, 'destination'));
  await register('other', ready.results);
  await page.goto(ready.url);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(ready.url).origin });
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.getByRole('button', { name: 'Manage Roots', exact: true }).click();
  await page.getByRole('button', { name: '＋ Browse and Connect Folder…', exact: true }).click();
  assert.equal(await page.locator('#rootsTitle').textContent(), 'Select a Folder to Connect');
  await page.locator('#cancelFolder').click(); await page.locator('#closeRoots').click();
  await row('nested').click(); const editor = await open(original);
  await editor.locator('#editor:not([readonly])').waitFor();
  assert.equal(await editor.locator('html').getAttribute('lang'), 'en');
  assert.equal(await editor.locator('#editor').getAttribute('aria-label'), 'Edit file source');
  await editor.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('DRAFT 한글');
  const draft = await editor.locator('#editor').inputValue();
  await page.locator('#rootSelect').selectOption('other'); await open('same.txt');
  const menu = page.locator('#groupMenu');
  const model = () => page.evaluate(() => JSON.stringify({ active: state.activeTab, group: state.activeGroup, root: state.root,
    selected: state.selected, selection: [...treeSelection.keys()], layout: state.layout, url: location.href }));
  const show = async (file = original, root = 'project') => {
    await tab(file, root).locator('.tab-activate').click({ button: 'right' }); await menu.waitFor();
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Expand Current File', 'Full Screen', 'Copy Relative Path', 'Copy Path',
      'Merge This Group', 'Close Tab', 'Close Other Tabs (All Groups)', 'Close All Tabs (All Groups)']);
    assert.equal(await menu.getByRole('menuitem', { name: /^Split / }).count(), 0);
  };
  const copied = async (file, root, relative, expected) => {
    const before = await model(), writes = requests.filter(r => r.method === 'POST').length;
    await show(file, root); assert.equal(await model(), before, 'inactive tab menu preserves navigation');
    await menu.getByRole('menuitem', { name: relative ? 'Copy Relative Path' : 'Copy Path', exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('#status').textContent === 'Copied: ' + expected, expected);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
    assert.equal(await model(), before, 'path copying preserves root, selection, active file and groups');
    assert.equal(requests.filter(r => r.method === 'POST').length, writes, 'copy does not mutate files');
    assert(await tab(file, root).locator('.tab-activate').evaluate(n => n === document.activeElement));
  };
  await copied(original, 'project', true, original);
  await copied(original, 'project', false, path.join(ready.project, original));
  await tab(original).locator('.tab-activate').click();
  await copied('same.txt', 'other', true, 'same.txt'); await copied('same.txt', 'other', false, path.join(ready.results, 'same.txt'));
  await show(); await page.keyboard.press('End'); assert.equal(await page.locator(':focus').textContent(), 'Close All Tabs (All Groups)');
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator(':focus').textContent(), 'Copy Relative Path'); await page.keyboard.press('Enter');
  await menu.waitFor({ state: 'hidden' }); await page.keyboard.press('Shift+F10'); await menu.waitFor(); await page.keyboard.press('Escape');
  assert(await tab(original).locator('.tab-activate').evaluate(n => n === document.activeElement));
  await show(); await page.locator('#rootName').click(); assert(await menu.isHidden());
  // Permission denial and missing API both use a selectable, exact path fallback.
  await page.evaluate(() => { window.originalClipboard = navigator.clipboard; Object.defineProperty(navigator, 'clipboard', { configurable: true,
    value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } } }); });
  for (const unavailable of [false, true]) {
    if (unavailable) await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    const before = await model(); await show();
    await menu.getByRole('menuitem', { name: unavailable ? 'Copy Relative Path' : 'Copy Path', exact: true }).click();
    await page.locator('#copyPathDialog').waitFor();
    const value = unavailable ? original : path.join(ready.project, original);
    assert.equal(await page.locator('#copyPathValue').inputValue(), value);
    assert.equal(await page.locator('#copyPathValue').evaluate(n => n.value.slice(n.selectionStart, n.selectionEnd)), value);
    await page.locator('#copyPathClose').click(); assert.equal(await model(), before);
  }
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard }));
  // Blank strip uses its own active tab while another group is focused.
  await dragTab(page, original, groupPoint(page, 'same.txt', 'right', 'other'));
  assert.equal(await page.locator('.pane-tabs').count(), 2);
  await tab('same.txt', 'other').locator('.tab-activate').click();
  const strip = page.locator('.pane-tabs').filter({ has: tab(original) }), box = await strip.boundingBox(), before = await model();
  await page.mouse.click(box.x + box.width - 5, box.y + box.height / 2, { button: 'right' });
  await menu.getByRole('menuitem', { name: 'Copy Path', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), path.join(ready.project, original)); assert.equal(await model(), before);
  // Physical rename and move update path bindings without replacing the editor or undo history.
  await page.locator('#rootSelect').selectOption('project');
  await row(original).click({ button: 'right' }); await page.locator('#contextRename').click();
  await page.locator('#fsName').fill('renamed 한글.txt'); await page.locator('#fsSubmit').click();
  let current = 'nested/renamed 한글.txt'; await tab(current).waitFor(); await page.waitForFunction(() => !fsOperation); await row(current).waitFor();
  await copied(current, 'project', true, current); await copied(current, 'project', false, path.join(ready.project, current));
  await row(current).click({ button: 'right' });
  // Move uses the same server and editor mutation path as the physical tree drag.
  await page.keyboard.press('Escape');
  const name = row(current).locator('.filename'), from = await name.boundingBox(), to = await row('destination').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 }); await page.mouse.up();
  current = 'destination/renamed 한글.txt'; await tab(current).waitFor(); await page.waitForFunction(() => !fsOperation);
  await copied(current, 'project', true, current); await copied(current, 'project', false, path.join(ready.project, current));
  await tab(current).locator('.tab-activate').click(); assert.equal(await editor.locator('#editor').inputValue(), draft);
  await editor.locator('#editor').focus(); await page.keyboard.press('Control+z'); assert.equal(await editor.locator('#editor').inputValue(), 'PROJECT\n');
  await page.keyboard.press('Control+Shift+z'); assert.equal(await editor.locator('#editor').inputValue(), draft);
  assert.equal(await (await frame(current)).locator('#editor').inputValue(), draft);
  assert.equal(await fs.readFile(path.join(ready.project, current), 'utf8'), 'PROJECT\n');
  // With no tabs, both path actions are present and disabled.
  page.once('dialog', d => d.accept()); await show(current); await menu.getByRole('menuitem', { name: 'Close All Tabs (All Groups)', exact: true }).click();
  // Empty workspace hides its strip; exercise the same contextmenu handler directly.
  const emptyStrip = page.locator('.pane-tabs'); await emptyStrip.dispatchEvent('contextmenu', { clientX: 500, clientY: 100 });
  assert(await menu.getByRole('menuitem', { name: 'Copy Relative Path', exact: true }).isDisabled());
  assert(await menu.getByRole('menuitem', { name: 'Copy Path', exact: true }).isDisabled()); await page.keyboard.press('Escape');
  console.log('PASS: English tab menu, no split commands, inactive multi-root path copy, denied/missing clipboard fallback, keyboard/focus/dismissal, blank strip, rename/move, physical split, drafts and native undo');
}).catch(error => { console.error(error); process.exitCode = 1; });
