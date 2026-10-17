// Use actual header buttons and disposable documents; no app action is invoked by tests.
const assert = require('node:assert/strict');
const { fixture, dragTab, groupPoint } = require('./workspace-test-helper.cjs');
fixture(async ({ ready, page, open, tab }) => {
  await page.goto(ready.url);
  assert.equal(await page.locator('aside #expandPreview, aside #fullscreenPreview, #open').count(), 0);
  const code = await open('sample.py'); await code.locator('#editor:not([readonly])').waitFor();
  const original = await code.locator('#editor').inputValue();
  await code.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n# header draft 한글\n');
  const draft = await code.locator('#editor').inputValue();
  for (const file of ['README.md', 'page.html', 'sample.pdf']) {
    const doc = await open(file);
    const controls = doc.getByRole('group', { name: 'Preview view controls' }); await controls.waitFor();
    const host = file.endsWith('.pdf') ? '#toolbarViewerRight' : '#previewHeader';
    assert.equal(await doc.locator(host + ' > .preview-view-actions').count(), 1, file + ': inside existing header');
    assert.equal(await page.locator('.workspace-slot[data-active="true"] > .preview-view-actions').count(), 0, 'no extra tool row');
    const expand = doc.getByRole('button', { name: 'Expand Preview', exact: true });
    const fullscreen = doc.getByRole('button', { name: 'Full Screen', exact: true });
    const sizes = await controls.locator('button').evaluateAll(nodes => nodes.map(n => [n.getBoundingClientRect().width, n.getBoundingClientRect().height]));
    assert.deepEqual(sizes, [[28,28],[28,28]]);
    await doc.locator('body').evaluate(() => { window.headerIdentity = { doc: document, controls: document.querySelector('.preview-view-actions') }; });
    await expand.click();
    assert.equal(await page.evaluate(() => state.tabs.find(t => t.id === state.activeTab).entry.path), file);
    assert.equal(await controls.isVisible(), false, 'header hides with immersive chrome');
    await page.locator('#exitExpanded').click(); await controls.waitFor();
    assert.equal(await doc.locator('body').evaluate(() => headerIdentity.doc === document && headerIdentity.controls === document.querySelector('.preview-view-actions')), true);
    await fullscreen.click(); await page.waitForFunction(() => document.fullscreenElement && state.previewExpanded);
    await page.locator('#exitExpanded').click(); await page.waitForFunction(() => !document.fullscreenElement && !state.previewExpanded);
    assert.equal(await fullscreen.evaluate(n => n === document.activeElement), true, 'fullscreen returns focus to actual header button');
  }
  await dragTab(page, 'README.md', groupPoint(page, 'sample.pdf', 'right'));
  // The PDF is visible in an inactive group. Its own button must target that PDF.
  const pdf = page.frameLocator('iframe[data-tab="' + await tab('sample.pdf').getAttribute('data-tab') + '"]');
  await pdf.getByRole('button', { name: 'Expand Preview', exact: true }).click();
  assert.equal(await page.evaluate(() => state.tabs.find(t => t.id === state.activeTab).entry.path), 'sample.pdf');
  await page.locator('#exitExpanded').click();
  await tab('sample.py').locator('.tab-activate').click();
  assert.equal(await code.locator('#editor').inputValue(), draft);
  await code.locator('#editor').focus(); await page.keyboard.press('Control+z'); assert.equal(await code.locator('#editor').inputValue(), original);
  await page.keyboard.press('Control+Shift+z'); assert.equal(await code.locator('#editor').inputValue(), draft);
  await page.emulateMedia({ colorScheme:'dark' });
  await tab('sample.pdf').locator('.tab-activate').click();
  await page.screenshot({ path:'/tmp/fbrowse-preview-header-pdf.png' });
  await tab('README.md').locator('.tab-activate').click();
  await page.screenshot({ path:'/tmp/fbrowse-preview-header-markdown.png' });
  for (const width of [750, 640, 320]) {
    await page.setViewportSize({ width, height:800 });
    await page.waitForFunction(id => {
      const doc = document.querySelector('iframe[data-tab="' + id + '"]').contentDocument;
      const button = doc.querySelector('#fullscreenPreview').getBoundingClientRect();
      const toolbar = doc.querySelector('#toolbarContainer').getBoundingClientRect();
      const viewer = doc.querySelector('#viewerContainer').getBoundingClientRect();
      return button.right <= doc.defaultView.innerWidth && button.x >= 0 && Math.abs(viewer.top-toolbar.bottom) <= 1;
    }, await tab('sample.pdf').getAttribute('data-tab'));
  }
  await page.setViewportSize({ width:750, height:800 });
  const md = page.frameLocator('iframe[data-tab="' + await tab('README.md').getAttribute('data-tab') + '"]');
  const narrow = md.getByRole('button', { name: 'Expand Preview', exact: true });
  await narrow.click(); await page.locator('#exitExpanded').click();
  console.log('PASS: document-header controls for PDF/HTML/Markdown, no sidebar/new-tab buttons or extra row, matching icons, narrow PDF toolbar wrapping without clipping or page overlap, physical expand/fullscreen/focus restoration, inactive split targeting, stable documents and draft/undo');
}).catch(error => { console.error(error); process.exitCode = 1; });
