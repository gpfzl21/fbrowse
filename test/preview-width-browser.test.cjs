const { fixture, dragTab, groupPoint } = require('./workspace-test-helper.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
(async () => fixture(async ({ ready, page, row, frame, open }) => {
  const original = '# Width 한글\n\n' + 'Readable paragraph 한글 abc '.repeat(150) + '\n\n$E=mc^2$\n\n<script>window.PWNED=1</script>\n';
  await fs.writeFile(ready.project + '/width.md', original);
  await fs.writeFile(ready.project + '/nested/width.html', '<link rel="stylesheet" href="width.css"><main><h1>Own styles</h1><img src="../image.svg"><script>parent.PWNED=2</script><script src="../script.js"></script></main>');
  await fs.writeFile(ready.project + '/nested/width.css', 'body{margin:0}main{max-width:420px;margin:auto}h1{color:rgb(1,2,3)}');
  await page.setViewportSize({ width: 1920, height: 1000 }); await page.goto(ready.url); const md = await open('width.md');
  await md.locator('#markdown .katex').first().waitFor();
  const width = locator => locator.evaluate(n => n.getBoundingClientRect().width);
  assert.equal(await md.locator('body').evaluate(() => localStorage.length), 0, 'fresh origin has no saved width choice');
  assert.equal(await md.locator('#previewWidth').getAttribute('aria-pressed'), 'true', 'fresh Markdown defaults to full width');
  assert.equal(await width(md.locator('#markdown')), await md.locator('body').evaluate(() => innerWidth));
  await page.screenshot({path:'/tmp/fbrowse-markdown-default-full-0.9.1.png',fullPage:true});
  await md.locator('#markdown').evaluate(n => { window.articleChild = n.firstChild; window.editorNode = document.querySelector('#editor'); });
  await md.locator('#previewWidth').click(); assert.equal(await md.locator('#previewWidth').getAttribute('aria-pressed'), 'false');
  assert.equal(await width(md.locator('#markdown')), 1000, 'readable width remains an opt-in');
  await page.screenshot({path:'/tmp/fbrowse-markdown-readable-0.9.1.png',fullPage:true});
  assert(await md.locator('#markdown').evaluate(n=>n.firstChild===window.articleChild), 'width toggle preserves rendered math DOM');
  await page.reload(); let current = page.frameLocator('.workspace-slot.is-visible iframe'); await current.locator('#markdown .katex').first().waitFor();
  assert.equal(await current.locator('#previewWidth').getAttribute('aria-pressed'), 'false', 'explicit readable choice survives reload');
  assert.equal(await width(current.locator('#markdown')), 1000);
  assert.equal(await current.locator('body').evaluate(() => localStorage.getItem('fbrowse.previewWidth.markdown')), 'readable');
  await current.locator('#previewWidth').click(); await page.reload(); current = page.frameLocator('.workspace-slot.is-visible iframe');
  await current.locator('#markdown .katex').first().waitFor();
  assert.equal(await current.locator('#previewWidth').getAttribute('aria-pressed'), 'true', 'explicit full choice survives reload');
  assert.equal(await current.locator('body').evaluate(() => localStorage.getItem('fbrowse.previewWidth.markdown')), 'full');
  assert.equal(await current.locator('body').evaluate(() => localStorage.getItem('fbrowse.previewWidth')), null, 'Markdown choice does not change HTML setting');
  await current.locator('body').evaluate(()=>{localStorage.setItem('fbrowse.previewWidth','readable');localStorage.removeItem('fbrowse.previewWidth.markdown');});
  await page.reload(); current=page.frameLocator('.workspace-slot.is-visible iframe'); await current.locator('#markdown .katex').first().waitFor();
  assert.equal(await current.locator('#previewWidth').getAttribute('aria-pressed'),'true','legacy HTML readable choice cannot override new Markdown default');
  assert.equal(await width(current.locator('#markdown')),await current.locator('body').evaluate(()=>innerWidth));
  await current.locator('body').evaluate(()=>localStorage.removeItem('fbrowse.previewWidth'));
  await current.locator('#mode').click(); const editor = current.locator('#editor'); await editor.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\nwidth draft 한글\n');
  const draft = await editor.inputValue(); await page.keyboard.press('Control+s'); await current.locator('#notice').filter({ hasText: 'Saved.' }).waitFor();
  await editor.evaluate(n => { window.savedEditorNode = n; }); await current.locator('#mode').click();
  await current.locator('#markdown').evaluate(n => window.savedArticleChild = n.firstChild);
  for (const viewport of [1200, 740, 1920]) {
    await page.setViewportSize({ width: viewport, height: 1000 });
    for (const full of [false, true]) {
      if ((await current.locator('#previewWidth').getAttribute('aria-pressed') === 'true') !== full) await current.locator('#previewWidth').click();
      const pane = await current.locator('body').evaluate(() => innerWidth);
      assert(Math.abs(await width(current.locator('#markdown')) - (full ? pane : Math.min(1000, pane))) <= 1);
      assert(await current.locator('#markdown').evaluate(n => n.scrollWidth <= n.clientWidth + 1));
      assert(await current.locator('#markdown').evaluate(n => n.firstChild === window.savedArticleChild));
    }
  }
  await open('same.txt'); await dragTab(page,'same.txt',groupPoint(page,'width.md','right'));
  const retained = await frame('width.md');
  const mdPane = await retained.locator('body').evaluate(() => innerWidth);
  assert.equal(await width(retained.locator('#markdown')), mdPane, 'full Markdown uses actual split pane width');
  await page.locator('.workspace-separator').first().focus(); await page.keyboard.press('End');
  assert.equal(await width(retained.locator('#markdown')), await retained.locator('body').evaluate(() => innerWidth));
  await retained.locator('#mode').click(); assert(await retained.locator('#editor').evaluate(n => n === window.savedEditorNode));
  assert.equal(await retained.locator('#editor').inputValue(), draft); assert.equal(await retained.locator('#wrap').getAttribute('aria-pressed'), 'true');
  await retained.locator('#editor').focus(); await page.keyboard.press('Control+z'); assert.equal(await retained.locator('#editor').inputValue(), original);
  await page.keyboard.press('Control+Shift+z'); assert.equal(await retained.locator('#editor').inputValue(), draft);
  assert.equal(await fs.readFile(ready.project + '/width.md', 'utf8'), draft);
  await dragTab(page,'same.txt',groupPoint(page,'width.md'));  await row('nested').click(); const html = await open('nested/width.html'); const inner = html.frameLocator('#htmlPreview'); await inner.locator('h1').waitFor();
  assert.equal(await html.locator('#previewWidth').getAttribute('aria-pressed'), 'false', 'fresh HTML keeps readable width default');
  assert.equal(await width(html.locator('#htmlViewport')), Math.min(1000, await html.locator('body').evaluate(()=>innerWidth)));
  for (const full of [false, true]) {
    if ((await html.locator('#previewWidth').getAttribute('aria-pressed') === 'true') !== full) await html.locator('#previewWidth').click();
    const pane = await html.locator('body').evaluate(() => innerWidth);
    assert.equal(await width(html.locator('#htmlViewport')), full ? pane : Math.min(pane, 1000));
    assert.equal(await inner.locator('main').evaluate(n => n.getBoundingClientRect().width), 420, 'viewer respects author max-width');
    assert.equal(await inner.locator('h1').evaluate(n => getComputedStyle(n).color), 'rgb(1, 2, 3)');
    await inner.locator('img').evaluate(n => n.decode()); assert.equal(await inner.locator('img').evaluate(n => n.naturalWidth), 10);
    assert.equal(await inner.locator('body').evaluate(() => window.PWNED), undefined);
    assert.equal(await html.locator('#htmlPreview').getAttribute('sandbox'), 'allow-same-origin');
  }
  await page.screenshot({ path: '/tmp/fbrowse-preview-width-0.9.1.png', fullPage: true });
  console.log('PASS: default full Markdown, independent HTML readable default, explicit/legacy choice isolation, real pane widths, resize/split/reload persistence, preserved DOM/undo/text/wrap, math/sanitization, own CSS/assets and script blocking');
}))().catch(error => { console.error(error); process.exitCode = 1; });
