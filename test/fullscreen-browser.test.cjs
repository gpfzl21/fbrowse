const { previewControl } = require('./workspace-test-helper.cjs');
// Exercise the actual browser Fullscreen API, alongside in-app expansion.
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { fixture, dragTab, groupPoint } = require('./workspace-test-helper.cjs');

fixture(async ({ ready, page, open, tab }) => {
  await page.goto(ready.url);
  const editorFrame = await open('sample.py');await editorFrame.locator('#editor:not([readonly])').waitFor();
  const original = await fs.readFile(ready.project + '/sample.py', 'utf8');
  const editor = editorFrame.locator('#editor');await editor.fill(original + '\n# unsaved fullscreen draft\n');
  await open('README.md');
  await dragTab(page, 'sample.py', groupPoint(page, 'README.md', 'right'));
  await tab('sample.py').locator('.tab-activate').click();
  await editor.evaluate(node => node.setSelectionRange(2, 5));
  const model = () => page.evaluate(() => JSON.stringify({ layout: state.layout, active: state.activeTab, activeGroup:state.activeGroup,
    groups: [...state.groups].map(([id,g]) => [id,g.active]), tabs: state.tabs.map(t => [t.id,t.group]) }));
  let before = await model();
  await page.evaluate(() => { window.fullscreenDocuments = [...document.querySelectorAll('.workspace-slot iframe')].map(frame => ({ frame, doc: frame.contentDocument })); });
  const unchanged = async () => {
    assert.equal(await model(), before);
    assert.equal(await editor.inputValue(), original + '\n# unsaved fullscreen draft\n');
    assert.deepEqual(await editor.evaluate(node => [node.selectionStart, node.selectionEnd]), [2,5]);
    assert.equal(await page.evaluate(() => fullscreenDocuments.every(({frame,doc}) => frame.contentDocument === doc)), true);
    assert.equal(await fs.readFile(ready.project + '/sample.py', 'utf8'), original);
  };
  const enter = async selector => {
    await (selector === '#fullscreenPreview' ? await previewControl(page, 'fullscreenPreview') : page.locator(selector)).click();
    await page.waitForFunction(() => document.fullscreenElement === document.querySelector('#viewer') && state.previewExpanded);
    assert.equal(await page.locator('#expandedFullscreen').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.workspace-slot.is-visible').count(), 1);
    assert.equal(await page.locator('#viewer').evaluate(n => Math.round(n.getBoundingClientRect().height)), await page.evaluate(() => innerHeight));
  };
  const exited = async expanded => {
    await page.waitForFunction(expanded => !document.fullscreenElement && state.previewExpanded === expanded && document.querySelector('#fullscreenPreview').getAttribute('aria-pressed')==='false', expanded);
    assert.equal(await page.locator('#fullscreenPreview').getAttribute('aria-pressed'), 'false');
  };

  // A normal entry returns to the same split model after Escape from the editor.
  await enter('#fullscreenPreview');await editor.click();await page.keyboard.press('Escape');await exited(false);
  // Clicking a textarea changes its selection, so restore the canary before checking.
  await editor.evaluate(node => node.setSelectionRange(2, 5));await unchanged();

  // An external browser exit preserves the preceding in-app expanded mode.
  await (await previewControl(page, 'expandPreview')).click();
  assert.equal(await page.evaluate(() => document.fullscreenElement), null);
  await enter('#expandedFullscreen');await page.evaluate(() => document.exitFullscreen());await exited(true);
  assert.equal(await page.locator('#expandedFullscreen').isVisible(), true);
  await page.locator('#exitExpanded').click();await unchanged();

  // Explicit fullscreen toggle restores the split; X exits both modes.
  await enter('#fullscreenPreview');await page.locator('#expandedFullscreen').click();await exited(false);await unchanged();
  await (await previewControl(page, 'expandPreview')).click();await enter('#expandedFullscreen');
  await page.locator('#exitExpanded').click();await exited(false);await unchanged();

  // Native fullscreen also keeps an HTML document and its nested frame intact.
  const html = await open('page.html');await html.frameLocator('#htmlPreview').locator('h1').waitFor();
  const nested = await html.locator('#htmlPreview').elementHandle();
  const nestedFrame = await nested.contentFrame();
  await enter('#fullscreenPreview');
  await html.frameLocator('#htmlPreview').locator('h1').click();await page.keyboard.press('Escape');await exited(false);
  assert.equal((await nested.contentFrame()), nestedFrame);

  // Denied requests leave layout and drafts untouched, with a visible explanation.
  await tab('sample.py').locator('.tab-activate').click();
  before = await model();
  await page.evaluate(() => { window.realFullscreen = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = () => Promise.reject(new TypeError('Permissions policy denied')); });
  await (await previewControl(page, 'fullscreenPreview')).click();await page.locator('#fullscreenNotice').waitFor();
  assert.equal(await page.evaluate(() => document.fullscreenElement), null);
  assert.equal(await page.locator('#viewer').evaluate(n => n.classList.contains('is-expanded')), false);
  await unchanged();
  await (await previewControl(page, 'expandPreview')).click();await page.locator('#expandedFullscreen').click();
  await page.locator('#fullscreenNotice').waitFor();
  assert.equal(await page.locator('#viewer').evaluate(n => n.classList.contains('is-expanded')), true);
  assert.equal(await page.locator('#expandedFullscreen').isEnabled(), true);
  await page.locator('#exitExpanded').click();
  await page.evaluate(() => { Element.prototype.requestFullscreen = realFullscreen; });

  const idleControls = async content => {
    await content.hover({position:{x:120,y:100}});
    await page.waitForFunction(() => !document.querySelector('#viewer').hasAttribute('data-controls-visible') && getComputedStyle(document.querySelector('#exitExpanded')).opacity==='0');
    assert.equal(await page.locator('#exitExpanded').evaluate(node => getComputedStyle(node).pointerEvents), 'none', 'hidden buttons do not intercept the document');
    await content.hover({position:{x:220,y:120}});
    await page.waitForFunction(() => document.querySelector('#viewer').hasAttribute('data-controls-visible'));
  };
  const slidesSource='<style>body{margin:0}svg{width:100%;height:100vh}</style><svg data-marpit-svg viewBox="0 0 1280 720"><text y="200">Slide one</text></svg><script>addEventListener("keydown",event=>{if(event.key==="ArrowRight")document.querySelector("text").textContent="Slide two";});</script><!--'+'x'.repeat(300001)+'-->';
  await fs.writeFile(ready.project+'/presentation.html',slidesSource);
  await page.goto(ready.url+'?root=project&path=presentation.html');
  const slideShell=page.frameLocator('.workspace-slot.is-visible iframe');await slideShell.locator('#slideMode').click();
  const slide=slideShell.frameLocator('#htmlPreview').locator('svg');await slide.waitFor();
  await (await previewControl(page, 'expandPreview')).click();
  assert.equal(await slideShell.locator('#notice').isVisible(), false);
  await idleControls(slide);await slide.click();await page.keyboard.press('ArrowRight');
  assert.equal(await slide.locator('text').textContent(), 'Slide two', 'pointer relay leaves slide navigation intact');
  await page.locator('#expandedFullscreen').focus();await page.keyboard.press('Tab');
  assert.equal(await page.locator('#exitExpanded').evaluate(node => node.matches(':focus-visible')), true);
  await page.waitForTimeout(2100);
  assert.equal(await page.locator('#exitExpanded').evaluate(node => getComputedStyle(node).opacity), '1', 'keyboard-focused controls stay visible');
  await page.locator('#exitExpanded').click();
  assert.equal(await fs.readFile(ready.project+'/presentation.html','utf8'),slidesSource);

  // Real PDF pointer movement reaches the app through its viewer frame in both modes.
  assert(ready.pdfjs,'real PDF.js required');const pdf=await open('sample.pdf');
  await pdf.locator('#viewer .page').first().waitFor({timeout:20000});
  await (await previewControl(page, 'expandPreview')).click();await idleControls(pdf.locator('#viewerContainer'));
  await page.locator('#expandedFullscreen').hover();await page.waitForTimeout(2100);
  assert.equal(await page.locator('#expandedFullscreen').evaluate(node => getComputedStyle(node).opacity), '1', 'hovered controls stay visible');
  await page.locator('#expandedFullscreen').click();
  await page.waitForFunction(() => document.fullscreenElement===document.querySelector('#viewer'));
  await idleControls(pdf.locator('#viewerContainer'));
  await page.locator('#exitExpanded').click();await exited(false);
  console.log('PASS: browser fullscreen restoration, stable drafts, source-only HTML notice, idle/hover/keyboard controls, real PDF and opaque slide pointer relay');
}).catch(error => { console.error(error); process.exitCode = 1; });
