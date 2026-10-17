// Browser behavior and origin isolation; all files live in disposable fixture roots.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { fixture } = require('./workspace-test-helper.cjs');

fixture(async ({ ready, page, errors, requests }) => {
  const html = `<!doctype html><html><head><style>svg{width:100%}</style></head><body>
    <svg data-marpit-svg viewBox="0 0 1280 720"><text y="50">First</text></svg>
    <svg data-marpit-svg viewBox="0 0 1280 720"><text y="50">Second</text></svg>
    <img src="slide-image.svg"><script src="slide-runtime.js"></script>
    <script>
      window.slideIndex=0;
      const slides=[...document.querySelectorAll('svg')];
      function show(){slides.forEach((slide,index)=>slide.style.display=index===slideIndex?'block':'none');}
      show();document.addEventListener('keydown',event=>{if(event.key==='ArrowRight'){slideIndex=Math.min(1,slideIndex+1);show();}if(event.key==='ArrowLeft'){slideIndex=Math.max(0,slideIndex-1);show();}});
      try{parent.document.body.dataset.slideEscaped='true';}catch{window.parentBlocked=true;}
      try{parent.localStorage.setItem('slideEscape','true');}catch{window.storageBlocked=true;}
      fetch('/api/info').catch(()=>{window.apiBlocked=true;document.body.dataset.ready='true';});
    </script></body></html>`;
  fs.writeFileSync(ready.project + '/slides.html', html);
  fs.writeFileSync(ready.project + '/ordinary.html', '<h1>Ordinary HTML</h1><script>window.ran=true</script>');
  fs.writeFileSync(ready.project + '/slide-runtime.js', 'window.relativeScriptRan=true;');
  fs.writeFileSync(ready.project + '/slide-image.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"/>');
  await page.goto(ready.url + '_preview?root=project&path=slides.html');
  const inner = page.frameLocator('#htmlPreview'), toggle = page.locator('#slideMode');
  await toggle.waitFor();
  assert.equal(await page.locator('#htmlPreview').getAttribute('sandbox'), 'allow-same-origin');
  assert.equal(await inner.locator('body').evaluate(() => window.slideIndex), undefined);
  assert.equal(await inner.locator('svg:visible').count(), 2);
  assert.equal(requests.some(r => r.url.endsWith('/slide-runtime.js')), false);

  await toggle.click();
  await inner.locator('body[data-ready="true"]').waitFor();
  assert.equal(await page.locator('#htmlPreview').getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await inner.locator('body').evaluate(() => window.relativeScriptRan), true);
  await inner.locator('img').evaluate(node => node.decode());
  assert.equal(await inner.locator('body').evaluate(() => window.parentBlocked && window.storageBlocked && window.apiBlocked), true);
  assert.equal(await page.locator('body').getAttribute('data-slide-escaped'), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('slideEscape')), null);
  assert.equal(await page.locator('#htmlPreview').evaluate(node => {
    try { return node.contentDocument === null; } catch { return true; }
  }), true);
  await inner.locator('svg:visible').click();await page.keyboard.press('ArrowRight');
  assert.equal(await inner.locator('svg:visible').textContent(), 'Second');
  await page.keyboard.press('ArrowLeft');assert.equal(await inner.locator('svg:visible').textContent(), 'First');
  assert.equal(await page.locator('#htmlViewport').evaluate(node => node.clientWidth), await page.locator('body').evaluate(node => node.clientWidth));

  await page.locator('#mode').click();
  const editor=page.locator('#editor');await editor.fill(html.replace('Second', 'Draft second'));
  await page.locator('#mode').click();await inner.locator('svg[style*="none"]').filter({hasText:'Draft second'}).waitFor({state:'attached'});
  await inner.locator('svg:visible').click();await page.keyboard.press('ArrowRight');
  assert.equal(await inner.locator('svg:visible').textContent(), 'Draft second');
  await toggle.click();await inner.locator('svg').nth(1).waitFor();
  assert.equal(await page.locator('#htmlPreview').getAttribute('sandbox'), 'allow-same-origin');
  assert.equal(await inner.locator('body').evaluate(() => window.slideIndex), undefined);
  assert.equal(await inner.locator('svg:visible').count(), 2);
  assert.equal(fs.readFileSync(ready.project + '/slides.html', 'utf8'), html);
  await page.locator('#mode').click();assert.ok((await editor.inputValue()).includes('Draft second'));

  await page.goto(ready.url + '_preview?root=project&path=ordinary.html');
  await inner.locator('h1').waitFor();assert.equal(await toggle.isVisible(), false);
  assert.equal(await inner.locator('body').evaluate(() => window.ran), undefined);
  assert.deepEqual(errors, []);
  console.log('PASS: slide keyboard navigation, local scripts/images, opaque origin/API isolation, static fallback and unchanged disk/drafts');
}).catch(error => { console.error(error); process.exitCode = 1; });
