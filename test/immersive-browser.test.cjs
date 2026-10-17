// Physical first gestures and immersive viewers; every document and mutation is disposable.
const { fixture, groupPoint, groupRect, dragTab, expandTab, gate } = require('./workspace-test-helper.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const screenshot = (page, name) => page.screenshot({ path: '/tmp/fbrowse-immersive-' + name + '-0.9.1.png', fullPage: true });

async function firstGestures() {
  await fixture(async ({ ready, page, row, tab, open, requests }) => {
    const parts = ['padding', 'caret', 'size', 'badge', 'icon', 'filename', 'searchpath'];
    const targets = ['center', 'left', 'right', 'top', 'bottom', 'strip'];
    const cancellations = ['Escape', 'outside', 'pointercancel', 'lostcapture', 'blur'];
    const files = ['qa-empty.txt', 'qa-cancel.txt', 'qa-click.txt', ...cancellations.map(kind => 'qa-cancel-' + kind + '.txt'), ...parts.flatMap(part => targets.map(target => 'qa-' + part + '-' + target + '.txt'))];
    for (const file of files) await fs.writeFile(ready.project + '/' + file, file + '\n');
    const hashes = new Map(await Promise.all(files.map(async file => [file, createHash('sha256').update(await fs.readFile(ready.project + '/' + file)).digest('hex')])));
    await page.goto(ready.url); await row('qa-empty.txt').waitFor();
    const ghost = page.locator('.workspace-drag-ghost');
    const loads = () => requests.filter(r => /\/(?:_preview|roots\/[^/]+\/files\/)/.test(r.url)).length;
    const model = () => page.evaluate(() => JSON.stringify({ layout: state.layout, active: state.activeTab, groups: [...state.groups].map(([id, g]) => [id, g.active]), tabs: state.tabs.map(t => [t.id, t.group]) }));
    async function clean() {
      for (const selector of ['.workspace-drag-ghost', '#workspaceDrop', '#workspaceInsertion', '#workspaceDragCover']) assert(await page.locator(selector).isHidden(), selector + ' cleaned');
      assert.equal(await page.locator('.is-drag-source').count(), 0);
      assert(await page.evaluate(() => !pointerTabDrag && !tabDrag && !dragGhost && ![...document.querySelectorAll('*')].some(n => n.hasPointerCapture?.(1))), 'drag references and capture released');
    }
    async function begin(file, part, code) {
      await row(file).scrollIntoViewIfNeeded();
      if (code) { await code.locator('#editor').focus(); assert(await code.locator('#editor').evaluate(n => document.activeElement === n)); }
      assert.notEqual(await row(file).getAttribute('data-tree-selected'), 'true', 'never-selected source ' + file);
      assert.equal(await tab(file).count(), 0, 'never-opened source ' + file);
      const point = await row(file).evaluate((n, part) => {
        const selector = { badge: '.git-badge', searchpath: '.result-path' }[part] || '.' + part;
        const el = part === 'padding' ? n : n.querySelector(selector); if (!el) throw Error('Missing hit target ' + selector);
        const r = el.getBoundingClientRect(), x = r.x + (part === 'padding' ? 2 : r.width / 2), y = r.y + r.height / 2;
        const hit = document.elementFromPoint(x, y); if (!n.contains(hit)) throw Error('Source is obstructed');
        if (part === 'padding' && hit !== n) throw Error('Padding point must hit the whole row');
        return { x, y };
      }, part);
      const before = { tabs: await page.locator('.file-tab').count(), loads: loads() };
      await page.mouse.move(point.x, point.y); await page.mouse.down();
      await page.mouse.move(point.x + 3, point.y); assert(await ghost.isHidden(), 'below threshold remains click');
      await page.mouse.move(point.x + 6, point.y, { steps: 3 });
      assert(await ghost.isVisible(), 'FIRST held primary gesture reaches 6px: ' + part + ' ' + file);
      assert((await ghost.textContent()).includes(file));
      assert.equal(await page.locator('.file-tab').count(), before.tabs, 'no eager tab'); assert.equal(loads(), before.loads, 'no eager preview');
      return before;
    }
    async function move(point) { await page.mouse.move(point.x, point.y, { steps: 12 }); await page.mouse.move(point.x + 1, point.y + 1); await page.mouse.move(point.x, point.y); }
    const empty = await page.locator('#viewer .preview').boundingBox(), emptyPoint = { x: empty.x + empty.width / 2, y: empty.y + empty.height / 2 };
    const initial = await model(), initialRequests = requests.length;
    await begin('qa-cancel.txt', 'padding'); await move(emptyPoint); await page.keyboard.press('Escape'); await page.mouse.up(); await clean();
    assert.equal(await model(), initial); assert.equal(requests.slice(initialRequests).filter(r => /\/(?:api\/entry|_preview)/.test(r.url)).length, 0);
    await begin('qa-empty.txt', 'size'); await move(emptyPoint); await page.mouse.up(); await clean(); await tab('qa-empty.txt').waitFor();
    await tab('qa-empty.txt').locator('.tab-close').click(); assert.equal(await page.locator('.file-tab').count(), 0);
    const code = await open('sample.py'); await code.locator('#editor:not([readonly])').waitFor();
    for (const [index, cancel] of cancellations.entries()) {
      const file = 'qa-cancel-' + cancel + '.txt', part = parts[index];
      const before = await model(), requestStart = requests.length, initialLoads = loads();
      await begin(file, part, code); await move(await groupPoint(page, 'sample.py', 'right')());
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      if (cancel === 'outside') await move({ x: 4, y: 4 });
      if (cancel === 'pointercancel') await row(file).dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
      if (cancel === 'lostcapture') await row(file).evaluate(n => n.releasePointerCapture(1));
      if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.mouse.up(); await clean(); assert.equal(await model(), before, 'new row area cancellation leaves workspace unchanged ' + cancel);
      assert.equal(loads(), initialLoads); assert.equal(requests.slice(requestStart).filter(r => new URL(r.url).pathname === '/api/entry').length, 0);
    }
    for (const part of parts) for (const target of targets) {
      const file = 'qa-' + part + '-' + target + '.txt';
      if (part === 'searchpath') { await page.locator('#search').fill(file); await row(file).and(page.locator('.search-result')).waitFor(); }
      const base = await groupRect(page, 'sample.py');
      const point = target === 'strip' ? await tab('sample.py').boundingBox().then(r => ({ x: r.x + 2, y: r.y + r.height / 2 })) : await groupPoint(page, 'sample.py', target)();
      await begin(file, part, code); await move(point);
      if (target === 'strip') { assert(await page.locator('#workspaceInsertion').isVisible()); assert.equal(await page.locator('#workspaceInsertion').getAttribute('data-before'), await tab('sample.py').getAttribute('data-tab')); }
      else { assert(await page.locator('#workspaceDrop').isVisible()); assert.equal(await page.locator('#workspaceDrop').getAttribute('data-edge'), target); }
      await page.mouse.up(); await clean(); await tab(file).waitFor();
      const dropped = await groupRect(page, file);
      assert.equal(dropped.id === base.id, ['center', 'strip'].includes(target), 'actual docking destination ' + part + '/' + target);
      if (target === 'strip') assert.deepEqual(await page.locator('.pane-tabs .file-tab').evaluateAll(ns => ns.map(n => n.dataset.path)), [file, 'sample.py']);
      if (part === 'padding' && target === 'right') await screenshot(page, 'first-row-drop');
      await tab(file).locator('.tab-close').click(); assert.equal(await page.locator('.pane-tabs').count(), 1);
      console.log('PASS: first focused-iframe gesture ' + part + ' -> ' + target);
    }
    await page.locator('#home').click(); await row('qa-click.txt').waitFor();
    // A successful first click still activates; keyboard/context/clipboard remain usable.
    await code.locator('#editor').focus(); await row('qa-click.txt').locator('.size').click(); await tab('qa-click.txt').waitFor();
    await row('qa-click.txt').focus(); await page.keyboard.press('Enter'); assert.equal(await tab('qa-click.txt').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Shift+F10'); assert(await page.locator('#treeMenu').isVisible()); await page.keyboard.press('Escape');
    const copied = page.waitForResponse(r => new URL(r.url()).pathname === '/api/fs-info'); await row('qa-click.txt').focus(); await page.keyboard.press('Control+c'); assert.equal((await copied).status(), 200);
    await page.locator('#clipboardStatus').filter({ hasText: /복사됨/ }).waitFor();
    for (const file of ['nested', 'outside-link.txt', 'broken-link.txt']) {
      const before = await model(); await row(file).scrollIntoViewIfNeeded(); const r = await row(file).boundingBox();
      await page.mouse.move(r.x + 2, r.y + r.height / 2); await page.mouse.down(); await page.mouse.move(r.x + 9, r.y + r.height / 2);
      assert.equal(await ghost.isVisible(),file==='nested','available folders support tree moves; blocked links stay inert '+file); await move(await groupPoint(page, 'sample.py', 'right')()); assert(await page.locator('#workspaceDrop').isHidden(),'directories cannot dock');await page.mouse.up(); await clean(); assert.equal(await model(), before);
    }
    for (const [file, hash] of hashes) assert.equal(createHash('sha256').update(await fs.readFile(ready.project + '/' + file)).digest('hex'), hash);
    assert.equal(requests.filter(r => r.method === 'POST' && /\/api\/(?:fs$|save$|create)/.test(new URL(r.url).pathname)).length, 0, 'drag/copy metadata never mutates document files');
    console.log('PASS: first empty drop, no eager preview, cleanup, blocked/directory guards, ordinary click/keyboard/context/clipboard and unchanged source bytes');
  }, { git: true });
}

async function immersive() {
  await fixture(async ({ ready, page, row, tab, open, frame, requests }) => {
    await fs.appendFile(ready.project + '/sample.py', '\n' + ('# Persistent scroll fixture\n').repeat(200));
    await fs.writeFile(ready.project + '/immersive.md', '# Authored heading\n\n$E=mc^2$\n\n' + ('Paragraph preserving scroll and DOM.\n\n').repeat(160));
    await fs.writeFile(ready.project + '/immersive.html', '<style>body{margin:0}header{height:30px;background:#eee}</style><header>Authored HTML header</header><h1>Authored HTML heading</h1>\n' + '<p>Document content</p>\n'.repeat(180));
    await fs.writeFile(ready.project + '/late.txt', ('late line\n').repeat(200));
    await page.addInitScript(() => { window.fullscreenRequests = 0; Element.prototype.requestFullscreen = function () { fullscreenRequests++; return Promise.resolve(); }; });
    await page.goto(ready.url); const code = await open('sample.py'); await code.locator('#editor:not([readonly])').waitFor();
    const md = await open('immersive.md'); await md.locator('#markdown .katex').waitFor();
    const html = await open('immersive.html'); await html.frameLocator('#htmlPreview').locator('header').waitFor();
    await dragTab(page, 'sample.py', groupPoint(page, 'immersive.md', 'right'));
    // Fault-injected interface calls exercise the new bridge's source and URL binding guards.
    await tab('immersive.md').locator('.tab-activate').click();
    for (const key of ['root', 'path', 'editorSession']) {
      await md.locator('body').evaluate((n, key) => { window.validChromeURL = location.href; const url = new URL(location.href); url.searchParams.set(key, 'wrong-binding'); history.replaceState(null, '', url); }, key);
      await expandTab(page, 'immersive.md');
      assert(await md.locator('#previewHeader').evaluate(n => getComputedStyle(n).display !== 'none'), 'wrong ' + key + ' cannot hide header');
      await md.locator('body').evaluate(() => { history.replaceState(null, '', validChromeURL); parent.fbrowseSyncPreviewChrome(parent); });
      assert(await md.locator('#previewHeader').evaluate(n => getComputedStyle(n).display !== 'none'), 'unknown source cannot sync owned frame');
      await md.locator('body').evaluate(() => parent.fbrowseSyncPreviewChrome(window));
      assert(await md.locator('#previewHeader').isHidden(), 'valid source and binding sync owned frame');
      await page.getByRole('button', { name: '크게 보기 종료 · Esc', exact: true }).click();
    }
    const messageGuard = await page.evaluate(() => {
      const t = state.tabs.find(t => t.entry.path === 'immersive.md'), editor = t.editor;
      for (const failure of ['origin', 'source', 'root', 'path', 'session']) {
        const message = { type: 'fbrowse-editor-state', ...editor, dirty: true };
        if (['root', 'path', 'session'].includes(failure)) message[failure] = 'wrong-binding';
        window.dispatchEvent(new MessageEvent('message', { origin: failure === 'origin' ? 'https://foreign.invalid' : location.origin, source: failure === 'source' ? window : t.frame.contentWindow, data: message }));
        if (editor.dirty) return failure;
      }
      return null;
    });
    assert.equal(messageGuard, null, 'origin/source/root/path/session message guards retained');
    async function settle(view) { await view.locator('body').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))); }
    async function alignment(view, label) {
      await settle(view);
      const delta = await view.locator('#code').evaluate(n => {
        const offset = n.textContent.indexOf('\n') + 1, walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT); let node, left = offset;
        while (node = walker.nextNode()) { if (left < node.length) break; left -= node.length; }
        const range = document.createRange(); range.setStart(node, left); range.setEnd(node, left + 1); const line = range.getBoundingClientRect().top;
        range.selectNodeContents(document.querySelector('#lines span:nth-child(2)')); return Math.abs(line - range.getClientRects()[0].top);
      });
      assert(delta <= 1, 'actual glyph/gutter alignment ' + label + ': ' + delta);
    }
    async function retain(view, content, scrollSelector) {
      await view.locator('#editor').evaluate(n => n.setSelectionRange(3, 9));
      await view.locator(scrollSelector).evaluate(n => n.scrollTop = 130); await settle(view);
      await view.locator('body').evaluate((n, { content, scrollSelector }) => {
        const editor = document.querySelector('#editor'), scroll = document.querySelector(scrollSelector);
        window.immersiveIdentity = { doc: document, win: window, editor, session: fbrowseEditor.session, value: editor.value, start: editor.selectionStart, end: editor.selectionEnd,
          content: document.querySelector(content), child: document.querySelector(content).firstChild, scroll, top: scroll.scrollTop, wrap: document.querySelector('#wrap').getAttribute('aria-pressed') };
      }, { content, scrollSelector });
    }
    async function identical(view, label) {
      const details = await view.locator('body').evaluate(() => { const i = immersiveIdentity, e = document.querySelector('#editor'); return { scroll: [i.top, i.scroll.scrollTop], selection: [i.start, e.selectionStart, i.end, e.selectionEnd], content: i.content.isConnected && i.content.firstChild === i.child, wrap: [i.wrap, document.querySelector('#wrap').getAttribute('aria-pressed')] }; });
      assert(await view.locator('body').evaluate(() => { const i = immersiveIdentity, editor = document.querySelector('#editor'); return i.doc === document && i.win === window && i.editor === editor && i.session === fbrowseEditor.session && i.value === editor.value && i.start === editor.selectionStart && i.end === editor.selectionEnd && i.content.isConnected && i.content.firstChild === i.child && i.scroll.scrollTop === i.top && i.wrap === document.querySelector('#wrap').getAttribute('aria-pressed'); }), 'exact document/editor/session/selection/scroll/wrap/content identity ' + label + ' ' + JSON.stringify(details));
    }
    async function chrome(view, hidden, label, content) {
      await settle(view); assert.equal(await view.locator('#previewHeader').isVisible(), !hidden, 'app header ' + label);
      if (hidden) {
        assert.equal(await view.locator(content).evaluate(n => n.getBoundingClientRect().top), 0, 'document viewport starts at 0 ' + label);
        const viewer = await page.locator('#viewer').boundingBox(), slot = await page.locator('.workspace-slot.is-visible').boundingBox();
        assert(Math.abs(viewer.y - slot.y) <= 1 && Math.abs(viewer.height - slot.height) <= 1, 'no 38px outer spacer');
      }
    }
    for (const [file, view, mode, content, scrolling] of [
      ['sample.py', code, 'source-wrap', '#source', '#source'], ['sample.py', code, 'source-nowrap', '#source', '#source'],
      ['immersive.md', md, 'rendered', '#markdown', '#markdown'], ['immersive.md', md, 'source', '#source', '#source'],
      ['immersive.html', html, 'rendered', '#htmlViewport', '#htmlViewport'], ['immersive.html', html, 'source', '#source', '#source'],
    ]) {
      if (process.env.FBROWSE_IMMERSIVE_CASE && !new RegExp(process.env.FBROWSE_IMMERSIVE_CASE).test(file + '/' + mode)) continue;
      await tab(file).locator('.tab-activate').click();
      if (mode === 'source') await view.locator('#mode').click();
      if (mode === 'source-nowrap') await view.locator('#wrap').click();
      await view.locator(content).waitFor(); await retain(view, content, scrolling);
      if (file === 'immersive.html' && mode === 'rendered') await html.frameLocator('#htmlPreview').locator('body').evaluate(() => { document.scrollingElement.scrollTop = 130; window.retainedHTML = { doc: document, heading: document.querySelector('h1'), header: document.querySelector('header'), scroll: document.scrollingElement.scrollTop }; });
      const id = await tab(file).getAttribute('data-tab'); await page.locator('iframe[data-tab=' + JSON.stringify(id) + ']').evaluate(n => { window.immersiveFrame = n; window.immersiveWindow = n.contentWindow; });
      for (const exit of ['click', 'Escape']) {
        await expandTab(page, file); await chrome(view, true, file + '/' + mode, content); await identical(view, 'expanded ' + file + '/' + mode);
        assert(await page.evaluate(id => { const n = document.querySelector('iframe[data-tab=' + JSON.stringify(id) + ']'); return n === immersiveFrame && n.contentWindow === immersiveWindow; }, id));
        const background = file === 'sample.py' ? html : code;
        assert(await background.locator('#previewHeader').evaluate(n => getComputedStyle(n).display !== 'none' && !document.documentElement.hasAttribute('data-fbrowse-expanded')), 'background header CSS and expansion state unaffected');
        if (content === '#source') await alignment(view, 'expanded ' + mode);
        if (file === 'immersive.md' && mode === 'rendered') assert(await md.locator('#markdown h1').isVisible(), 'authored Markdown heading retained');
        if (file === 'immersive.html' && mode === 'rendered') assert(await html.frameLocator('#htmlPreview').locator('header').isVisible(), 'authored HTML header retained');
        if (exit === 'click') await screenshot(page, file.replace('.', '-') + '-' + mode);
        if (exit === 'Escape') { if (file === 'immersive.html' && mode === 'rendered') await html.locator('#htmlPreview').click({ position: { x: 100, y: 200 } }); else if (content === '#source') await view.locator('#editor').evaluate(n => n.focus({ preventScroll: true })); else await view.locator('#markdown').click({ position: { x: 100, y: 100 } }); await page.keyboard.press('Escape'); }
        else await page.getByRole('button', { name: '크게 보기 종료 · Esc', exact: true }).click();
        await chrome(view, false, file + '/' + mode, content); await identical(view, 'restored ' + file + '/' + mode);
        if (file === 'immersive.html' && mode === 'rendered') assert(await html.frameLocator('#htmlPreview').locator('body').evaluate(() => retainedHTML.doc === document && retainedHTML.header === document.querySelector('header') && retainedHTML.heading === document.querySelector('h1') && retainedHTML.scroll === document.scrollingElement.scrollTop), 'authored HTML document/header/heading/scroll retained');
        if (content === '#source') await alignment(view, 'restored ' + mode);
      }
      console.log('PASS: immersive ' + file + '/' + mode + ' × and focused Escape, zero header/spacer, retained state and authored content');
    }
    // Native undo and saves still work while the application save button is hidden.
    await tab('sample.py').locator('.tab-activate').click(); await code.locator('#wrap').click();
    const original = await code.locator('#editor').inputValue(); await code.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\nimmersive draft\n');
    const draft = await code.locator('#editor').inputValue(); await expandTab(page, 'sample.py'); assert(await code.locator('#save').isHidden());
    await code.locator('#editor').focus(); await page.keyboard.press('Control+z'); assert.equal(await code.locator('#editor').inputValue(), original);
    await page.keyboard.press('Control+Shift+z'); assert.equal(await code.locator('#editor').inputValue(), draft);
    assert((await tab('sample.py').textContent()).includes('●'), 'dirty notification reaches parent');
    await page.keyboard.press('Control+s'); await code.locator('#notice').filter({ hasText: '저장했습니다.' }).waitFor(); assert.equal(await fs.readFile(ready.project + '/sample.py', 'utf8'), draft);
    assert(await code.locator('#notice').isVisible(), 'save notice remains visible outside hidden header'); await screenshot(page, 'code'); await page.keyboard.press('Escape'); assert(await code.locator('#previewHeader').isVisible());
    // Hold the new text document load: expansion must apply after load and quick exit must win.
    for (const exitEarly of [false, true]) {
      const held = gate(), seen = gate(); const route = async route => { seen.release(); await held.promise; await route.continue(); };
      await page.route('**/_preview?*', route); await row('late.txt').click(); await tab('late.txt').waitFor(); await seen.promise;
      await expandTab(page, 'late.txt'); if (exitEarly) await page.getByRole('button', { name: '크게 보기 종료 · Esc', exact: true }).click();
      held.release(); const late = await frame('late.txt'); await late.locator('#editor:not([readonly])').waitFor(); await chrome(late, !exitEarly, 'load-after-expand ' + exitEarly, '#source');
      if (!exitEarly) { await late.locator('#editor').focus(); await page.keyboard.press('Escape'); }
      assert(await late.locator('#previewHeader').isVisible()); await page.unroute('**/_preview?*', route); await tab('late.txt').locator('.tab-close').click();
    }
    await row('late.txt').click(); await tab('late.txt').waitFor();
    const foreignId = await tab('late.txt').getAttribute('data-tab');
    await page.locator('iframe[data-tab=' + JSON.stringify(foreignId) + ']').evaluate(n => n.src = 'data:text/html,<header id="previewHeader">Foreign document header</header>');
    const foreign = await frame('late.txt'); await foreign.locator('#previewHeader').waitFor(); await expandTab(page, 'late.txt');
    await page.evaluate(id => fbrowseSyncPreviewChrome(state.tabs.find(t => t.id === id).frame.contentWindow), foreignId);
    assert(await foreign.locator('#previewHeader').evaluate(n => getComputedStyle(n).display !== 'none' && !document.documentElement.hasAttribute('data-fbrowse-expanded')), 'known source with foreign origin cannot style document chrome');
    await page.getByRole('button', { name: '크게 보기 종료 · Esc', exact: true }).click(); await tab('late.txt').locator('.tab-close').click();
    assert(ready.pdfjs, 'cached real PDF.js required'); const pdf = await open('sample.pdf'); await pdf.locator('#viewer .page').first().waitFor({ timeout: 20000 });
    await pdf.locator('#viewsManagerToggleButton').click();
    await pdf.locator('#viewsManager').waitFor();
    await pdf.locator('#viewerContainer').evaluate(() => new Promise(resolve => setTimeout(resolve, 250)));
    const before = await pdf.locator('#viewerContainer').boundingBox(), toolbar = await pdf.locator('#toolbarContainer').isVisible();
    const sidebarState = await pdf.locator('#outerContainer').getAttribute('class');
    const originalSheets = await pdf.locator('body').evaluate(() => { window.originalSheets = [...document.adoptedStyleSheets]; return originalSheets.length; });
    await pdf.locator('#viewerContainer').evaluate(n => { window.pdfIdentity = { viewer: n, page: document.querySelector('#viewer .page'), app: PDFViewerApplication, doc: PDFViewerApplication.pdfDocument }; });
    for (const exit of ['Escape', 'click']) {
      await expandTab(page, 'sample.pdf'); await settle(pdf); assert(await pdf.locator('#toolbarContainer').isHidden());
      const expanded = await pdf.locator('#viewerContainer').boundingBox(), size = await pdf.locator('body').evaluate(() => ({ height: innerHeight, width: innerWidth }));
      assert.equal(expanded.y, 0); assert.equal(expanded.x, 0); assert(Math.abs(expanded.height - size.height) <= 1); assert(Math.abs(expanded.width - size.width) <= 1, 'open PDF sidebar leaves no offset');
      assert.equal(await pdf.locator('body').evaluate(() => document.adoptedStyleSheets.length), originalSheets + 1);
      assert(await pdf.locator('#viewerContainer').evaluate(n => n === pdfIdentity.viewer && document.querySelector('#viewer .page') === pdfIdentity.page && PDFViewerApplication === pdfIdentity.app && PDFViewerApplication.pdfDocument === pdfIdentity.doc));
      await screenshot(page, 'pdf'); if (exit === 'Escape') { await pdf.locator('#viewerContainer').click(); await page.keyboard.press('Escape'); } else await page.getByRole('button', { name: '크게 보기 종료 · Esc', exact: true }).click();
      await settle(pdf); assert.equal(await pdf.locator('#toolbarContainer').isVisible(), toolbar); const restored = await pdf.locator('#viewerContainer').boundingBox();
      for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(restored[key] - before[key]) <= 1, 'PDF geometry restored ' + key);
      assert.equal(await pdf.locator('#outerContainer').getAttribute('class'), sidebarState, 'open sidebar state retained'); assert(await pdf.locator('#viewsManager').isVisible());
      assert(await pdf.locator('body').evaluate(() => document.adoptedStyleSheets.length === originalSheets.length && originalSheets.every((sheet, i) => document.adoptedStyleSheets[i] === sheet)), 'only owned adopted sheet removed');
    }
    assert.equal(await page.evaluate(() => fullscreenRequests), 0); console.log('PASS: hidden-button Ctrl+S/dirty/native undo, delayed-load and quick-exit races, real PDF chrome/height/document identity restoration, no fullscreen');
  });
}
(async () => {
  if (process.env.FBROWSE_IMMERSIVE_FOCUS !== 'viewers') await firstGestures();
  if (process.env.FBROWSE_IMMERSIVE_FOCUS !== 'gestures') await immersive();
})().catch(error => { console.error(error); process.exitCode = 1; });
