const { previewControl } = require('./workspace-test-helper.cjs');
// Physical Chromium input against real PDF.js; all files belong to disposable roots.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, expandTab, dragTab, groupPoint, gate } = require('./workspace-test-helper.cjs');
fixture(async ({ ready, page, open, tab, frame, row }) => {
  assert(ready.pdfjs, 'real PDF.js required');
  const bytes = await fs.readFile(path.join(ready.project, 'sample.pdf'));
  await fs.writeFile(path.join(ready.project, 'other.pdf'), bytes);
  await page.goto(ready.url);
  const code = await open('sample.py'); await code.locator('#editor:not([readonly])').waitFor();
  const original = await code.locator('#editor').inputValue();
  await code.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n# zoom draft 한글\n');
  const draft = await code.locator('#editor').inputValue();
  const pdf = await open('sample.pdf'); await pdf.locator('#viewer .page').first().waitFor({ timeout: 20000 });
  const percent = pdf.getByRole('spinbutton', { name: 'PDF zoom percentage' }), menu = pdf.locator('#scaleSelect');
  const panel = pdf.getByRole('group', { name: 'PDF zoom controls' });
  const scale = (target = pdf) => target.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.currentScale);
  const mode = (target = pdf) => target.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.currentScaleValue);
  const isScale = async (expected, file = 'sample.pdf') => {
    await page.waitForFunction(({ id, expected }) => Math.abs(document.querySelector('iframe[data-tab="' + id + '"]').contentWindow.PDFViewerApplication.pdfViewer.currentScale - expected) < 0.0001,
      { id: await tab(file).getAttribute('data-tab'), expected });
  };
  const enter = async value => { await percent.fill(String(value)); await percent.press('Enter'); };
  await percent.waitFor(); await page.waitForFunction(id => !document.querySelector('iframe[data-tab="' + id + '"]').contentDocument.querySelector('#fbrowsePdfZoomPercent').disabled, await tab('sample.pdf').getAttribute('data-tab'));
  assert(await panel.isHidden(), 'normal view keeps the native toolbar');
  assert.deepEqual(await menu.locator('option:not(#customScaleOption)').evaluateAll(nodes => nodes.map(n => n.value)), ['auto','page-actual','page-fit','page-width','0.5','0.75','1','1.25','1.5','2','3','4']);
  await menu.click(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await isScale(1);
  assert(await percent.evaluate(n => n.closest('#scaleSelectContainer') === document.querySelector('#scaleSelectContainer')), 'one field combines numeric entry and preset menu');
  const style = await percent.evaluate(n => ({ font:getComputedStyle(n).fontSize, height:n.closest('#scaleSelectContainer').getBoundingClientRect().height, button:document.querySelector('#zoomInButton').getBoundingClientRect().height, appearance:getComputedStyle(n).appearance, unit:getComputedStyle(n.nextElementSibling).fontSize }));
  assert.equal(style.font,'12px'); assert.equal(style.unit,style.font); assert(Math.abs(style.height-style.button)<=1); assert.equal(style.appearance,'textfield');
  const width = await pdf.locator('#viewer .page').first().evaluate(n => n.getBoundingClientRect().width);
  await enter(137.42); await isScale(1.3742);
  await pdf.locator('#zoomInButton').click(); await isScale(1.6); assert.equal(await percent.inputValue(), '160');
  await enter(137.42); await pdf.locator('#zoomOutButton').click(); await isScale(1.2);
  await menu.selectOption('1.25'); await isScale(1.25); assert.equal(await percent.inputValue(), '125');
  await pdf.locator('body').evaluate(() => { window.zoomIdentity = { doc: document, app: PDFViewerApplication, pdf: PDFViewerApplication.pdfDocument,
    viewer: PDFViewerApplication.pdfViewer, group: document.querySelector('#toolbarViewerMiddle'), menu: document.querySelector('#scaleSelect'), input: document.querySelector('#fbrowsePdfZoomPercent') }; });
  await page.screenshot({ path: '/tmp/fbrowse-pdf-zoom-normal.png', fullPage: true });
  await dragTab(page, 'sample.pdf', groupPoint(page, 'sample.py', 'right'));
  await expandTab(page, 'sample.pdf'); await panel.waitFor(); assert(await pdf.locator('#toolbarContainer').isHidden());
  assert(await pdf.locator('body').evaluate(() => document.querySelector('#fbrowsePdfZoom #toolbarViewerMiddle') === zoomIdentity.group), 'expanded mode moves the original controls');
  await menu.click(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await isScale(1);
  // Native +/- behave identically in both modes, including fractional fit/custom scales.
  await enter(137.42); await pdf.locator('#zoomInButton').click(); await isScale(1.6);
  await enter(137.42); await pdf.locator('#zoomOutButton').click(); await isScale(1.2);
  for (const [value,expected] of [['0.5',0.5],['0.75',0.75],['1',1],['1.25',1.25],['1.5',1.5],['2',2],['3',3],['4',4],['page-actual',1]]) {
    await menu.selectOption(value); await isScale(expected);
  }
  await enter(137); await isScale(1.37);
  await page.waitForFunction(({ id, width }) => Math.abs(document.querySelector('iframe[data-tab="' + id + '"]').contentDocument.querySelector('#viewer .page').getBoundingClientRect().width / width - 1.37) < 0.02,
    { id: await tab('sample.pdf').getAttribute('data-tab'), width });
  await percent.press('ArrowUp'); await percent.press('Enter'); await isScale(1.38);
  await percent.fill('125.5'); await percent.press('Tab'); await isScale(1.255);
  await enter(''); await isScale(1.255); assert.equal(await percent.inputValue(), '125.5');
  await enter(-5); await isScale(0.1); assert(await pdf.locator('#zoomOutButton').isDisabled()); assert.equal(await percent.getAttribute('max'), '2500');
  await menu.selectOption('auto'); assert.equal(await mode(), 'auto');
  await menu.selectOption('page-fit'); assert.equal(await mode(), 'page-fit');
  await menu.selectOption('page-width'); assert.equal(await mode(), 'page-width');
  const wideScale = await scale(); await page.setViewportSize({ width: 1155, height: 760 });
  await page.waitForFunction(id => document.querySelector('iframe[data-tab="' + id + '"]').contentWindow.PDFViewerApplication.pdfViewer.currentScale < 1.5, await tab('sample.pdf').getAttribute('data-tab'));
  assert((await scale()) < wideScale); assert(Math.abs(Number(await percent.inputValue()) - (await scale()) * 100) < 0.02);
  await percent.fill('133.7'); await page.setViewportSize({ width: 1250, height: 760 });
  await page.waitForFunction(id => document.querySelector('iframe[data-tab="' + id + '"]').contentWindow.PDFViewerApplication.pdfViewer.currentScale > 1.4, await tab('sample.pdf').getAttribute('data-tab'));
  assert.equal(await percent.inputValue(), '133.7', 'fit resize preserves a percentage still being typed');
  await percent.press('Enter'); await isScale(1.337);
  // Wheel zoom and keyboard input keep the same field/menu in sync without stealing focus.
  await menu.selectOption('page-actual'); await pdf.locator('#viewerContainer').click({ position: { x: 150, y: 120 } });
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  await page.waitForFunction(id => document.querySelector('iframe[data-tab="' + id + '"]').contentWindow.PDFViewerApplication.pdfViewer.currentScale > 1, await tab('sample.pdf').getAttribute('data-tab'));
  assert(Math.abs(Number(await percent.inputValue()) - (await scale()) * 100) < 0.02);
  await percent.focus(); await page.waitForTimeout(2100); assert.equal(await panel.evaluate(n => getComputedStyle(n).opacity), '1');
  await pdf.locator('#viewerContainer').click({ position: { x: 150, y: 120 } });
  await page.waitForFunction(id => getComputedStyle(document.querySelector('iframe[data-tab="' + id + '"]').contentDocument.querySelector('#fbrowsePdfZoom')).opacity === '0', await tab('sample.pdf').getAttribute('data-tab'));
  assert.equal(await panel.evaluate(n => getComputedStyle(n).pointerEvents), 'none');
  await pdf.locator('#viewerContainer').hover({ position: { x: 200, y: 130 } });
  await page.waitForFunction(id => getComputedStyle(document.querySelector('iframe[data-tab="' + id + '"]').contentDocument.querySelector('#fbrowsePdfZoom')).opacity === '1', await tab('sample.pdf').getAttribute('data-tab'));
  await page.setViewportSize({ width: 320, height: 700 }); await panel.hover();
  const box = await panel.boundingBox(), viewerBox = await page.locator('#viewer').boundingBox();
  assert(box.x >= viewerBox.x && box.x + box.width <= viewerBox.x + viewerBox.width + 1); assert(await menu.isVisible(), 'dropdown remains available in a narrow expanded viewer');
  assert(await panel.evaluate(n => { const box=n.getBoundingClientRect();return [...n.querySelectorAll('button,select,input')].every(control=>{const r=control.getBoundingClientRect();return r.x>=box.x&&r.right<=box.right+1&&r.y>=box.y&&r.bottom<=box.bottom+1;}); }), 'all controls stay inside the wrapped floating toolbar');
  await page.screenshot({ path: '/tmp/fbrowse-pdf-zoom-narrow.png', fullPage: true });
  await page.setViewportSize({ width: 1680, height: 1000 }); await pdf.locator('#viewerContainer').hover();
  await page.locator('#expandedFullscreen').click(); await page.waitForFunction(() => document.fullscreenElement === document.querySelector('#viewer'));
  await enter(143); await isScale(1.43); await page.screenshot({ path: '/tmp/fbrowse-pdf-zoom-expanded.png', fullPage: true });
  await panel.screenshot({ path: '/tmp/fbrowse-pdf-zoom-light-controls.png' });
  await page.emulateMedia({colorScheme:'dark'}); await panel.screenshot({ path: '/tmp/fbrowse-pdf-zoom-dark-controls.png' });
  await menu.click(); await page.screenshot({ path: '/tmp/fbrowse-pdf-zoom-dark-menu.png', fullPage: true }); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await enter(143); await isScale(1.43);
  await page.emulateMedia({colorScheme:'light'});
  await page.locator('#expandedFullscreen').click(); await page.waitForFunction(() => !document.fullscreenElement);
  await page.locator('#exitExpanded').click(); assert(await panel.isHidden()); assert(await pdf.locator('#toolbarContainer').isVisible());
  assert(await percent.isVisible()); await isScale(1.43);
  assert(await pdf.locator('body').evaluate(() => document === zoomIdentity.doc && PDFViewerApplication === zoomIdentity.app && PDFViewerApplication.pdfDocument === zoomIdentity.pdf && PDFViewerApplication.pdfViewer === zoomIdentity.viewer
    && document.querySelector('#toolbarViewer #toolbarViewerMiddle') === zoomIdentity.group && document.querySelector('#scaleSelect') === zoomIdentity.menu && document.querySelector('#fbrowsePdfZoomPercent') === zoomIdentity.input), 'original PDF, controls and field survive both mode changes');
  await enter(146.25); await isScale(1.4625); await expandTab(page, 'sample.pdf'); assert.equal(await percent.inputValue(), '146.25');
  await page.locator('#exitExpanded').click();
  const other = await open('other.pdf'); await other.locator('#viewer .page').first().waitFor({ timeout: 20000 });
  const otherPercent = other.getByRole('spinbutton', { name: 'PDF zoom percentage' }); await otherPercent.waitFor();
  await otherPercent.fill('117'); await otherPercent.press('Enter'); await isScale(1.17, 'other.pdf'); await isScale(1.4625);
  await expandTab(page, 'other.pdf'); assert.equal(await otherPercent.inputValue(), '117');
  await page.locator('#exitExpanded').click(); await expandTab(page, 'sample.py');
  assert.equal(await code.locator('#editor').inputValue(), draft); await code.locator('#editor').focus();
  await page.keyboard.press('Control+z'); assert.equal(await code.locator('#editor').inputValue(), original);
  await page.keyboard.press('Control+Shift+z'); assert.equal(await code.locator('#editor').inputValue(), draft); await page.keyboard.press('Escape');
  await page.evaluate(() => { window.closedZoom = state.tabs.find(t => t.entry.path === 'other.pdf').pdfZoomBinding; });
  await tab('other.pdf').locator('.tab-close').click(); assert(await page.evaluate(() => closedZoom.controller.signal.aborted && !closedZoom.input.isConnected));
  const entered = gate(), release = gate(), handled = gate();
  await page.route('**/_pdfjs/web/viewer.html?*', async route => { entered.release(); await release.promise; await route.continue(); handled.release(); });
  await row('other.pdf').click(); await entered.promise; await (await previewControl(page, 'expandPreview')).click(); release.release(); await handled.promise;
  await page.unroute('**/_pdfjs/web/viewer.html?*'); const delayed = await frame('other.pdf');
  await delayed.locator('#viewer .page').first().waitFor({ timeout: 20000 });
  const delayedPercent = delayed.getByRole('spinbutton', { name: 'PDF zoom percentage' }); await delayedPercent.fill('121'); await delayedPercent.press('Enter'); await isScale(1.21, 'other.pdf');
  assert.deepEqual(await fs.readFile(path.join(ready.project, 'sample.pdf')), bytes); assert.deepEqual(await fs.readFile(path.join(ready.project, 'other.pdf')), bytes);
  console.log('PASS: unified editable zoom field, physical preset menu, matching light/dark typography, native PDF +/- and complete scale menu in normal/expanded/fullscreen, exact decimal/keyboard entry in both modes, bounds/fit/resize/wheel sync, idle/focus/narrow layout, stable PDF/control nodes, independent documents, draft/undo, delayed load and cleanup');
}).catch(error => { console.error(error); process.exitCode = 1; });
