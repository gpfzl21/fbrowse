// Optional real-browser integration; Playwright is test tooling, never a runtime dependency.
// FBROWSE_PLAYWRIGHT_MODULE=/tmp/fbrowse-browser-check/node_modules/playwright node test/editor-browser.test.cjs
const { chromium } = require(process.env.FBROWSE_PLAYWRIGHT_MODULE || process.argv[2] || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(50); }
  assert.fail(message);
}
const gate = () => { let release; const promise = new Promise(resolve => release = resolve); return { promise, release }; };

(async () => {
  const { startServer } = await import('../lib/server.mjs');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-editor-browser-'));
  const project = path.join(base, 'project'), other = path.join(base, 'other');
  const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  for (const key of envKeys) process.env[key] = path.join(base, key);
  let app, browser, page;
  const start = () => startServer({ root: project, port: 0, host: '127.0.0.1', pdfjs: false });
  const originals = {
    'plain.txt': 'hello\n\n\t한글\n', 'other.txt': 'other original\n',
    'code.py': 'value = "' + '한글 abc '.repeat(80) + '"\n\n\t# comment\nprint(value)\n',
    'paper.tex': '\\documentclass{article}\n\\begin{document}\n한글 $x^2$\n\\end{document}\n',
    'notes.md': '# Original\n\n$E=mc^2$\n',
    'docs/page.html': '<link rel="stylesheet" href="style.css"><h1>Original HTML</h1><img src="image.svg"><script>parent.PWNED=1</script>',
    'docs/style.css': 'h1{color:rgb(1,2,3)}',
    'docs/image.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12"/></svg>',
  };
  try {
    await Promise.all([project, other, path.join(project, 'docs')].map(directory => fs.mkdir(directory, { recursive: true })));
    try { await fs.cp(path.join(cache, 'project-file-browser', 'text-assets'), path.join(process.env.XDG_CACHE_HOME, 'project-file-browser', 'text-assets'), { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const [file, text] of Object.entries(originals)) await fs.writeFile(path.join(project, file), text);
    await fs.writeFile(path.join(project, 'large.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 120));
    await fs.writeFile(path.join(project, 'mixed.txt'), 'one\r\ntwo\n');
    await fs.writeFile(path.join(other, 'plain.txt'), 'other root\n');
    app = await start();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    page.setDefaultTimeout(10_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const info = await (await page.request.get(new URL('/api/info', app.url).href)).json();
    assert.equal(info.version, require('../package.json').version);
    const add = await page.request.post(new URL('/api/roots', app.url).href, {
      headers: { 'X-Fbrowse-Token': info.config_token, Origin: new URL(app.url).origin },
      data: { operation: 'add', id: 'other', name: 'Other root', path: other },
    }); assert.equal(add.status(), 200);
    await page.goto(app.url);
    const row = file => page.locator('#entries button.row').filter({ has: page.locator('.filename') }).and(page.locator('[data-path=' + JSON.stringify(file) + ']'));
    const frame = () => page.frameLocator('.workspace-slot.is-visible iframe');
    const editor = () => frame().locator('#editor');
    const text = () => editor().inputValue();
    async function open(file) {
      await row(file).click(); await frame().locator('#info').filter({ hasText: /lines?/ }).waitFor();
    }
    async function source() {
      if (await editor().isHidden()) await frame().locator('#mode').click();
      await editor().waitFor({ state: 'visible' });
    }
    async function replace(value) {
      await editor().focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(value);
      await until(async () => await text() === value, 'native edit reached the textarea');
    }
    async function save(value, shortcut = 'Control+s') {
      await editor().focus(); await page.keyboard.press(shortcut);
      await until(async () => await fs.readFile(path.join(project, value.file), 'utf8') === value.text, 'Ctrl+S wrote actual disk bytes');
      await until(async () => await frame().locator('#save').isDisabled(), 'save completed');
    }
    async function cancel(action, expected = 'confirm') {
      const dialog = page.waitForEvent('dialog'); const pending = action();
      const prompt = await dialog; assert.equal(prompt.type(), expected); await prompt.dismiss(); await pending;
    }

    console.log('Editor browser: direct text/code/LaTeX edits and native undo');
    await open('plain.txt'); assert.equal(await editor().getAttribute('readonly'), null);
    assert.equal(await frame().getByRole('button', { name: /^Edit$/ }).count(), 0);
    const edited = originals['plain.txt'] + 'typed 한글\n';
    await editor().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('typed 한글\n');
    await frame().locator('#dirty').filter({ hasText: 'Modified' }).waitFor();
    await save({ file: 'plain.txt', text: edited });
    const sameSession = await page.locator('.workspace-slot.is-visible iframe').getAttribute('src');
    await row('plain.txt').click();
    assert.equal(await page.locator('.workspace-slot.is-visible iframe').getAttribute('src'), sameSession, 'same-file selection keeps the editor and undo');
    await editor().focus();
    await page.keyboard.press('Control+z'); assert.equal(await text(), originals['plain.txt'], 'undo survives saving');
    await page.keyboard.press('Control+Shift+z'); assert.equal(await text(), edited);
    assert.equal(await frame().locator('#dirty').textContent(), '');
    for (const file of ['code.py', 'paper.tex']) {
      await open(file); assert.equal(await text(), originals[file]); assert.equal(await editor().getAttribute('readonly'), null);
      await editor().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n');
      await page.keyboard.press('Control+z'); assert.equal(await text(), originals[file]);
    }
    const ime = await page.context().newCDPSession(page);
    await editor().focus(); await page.keyboard.press('Control+End');
    await ime.send('Input.imeSetComposition', { text: '한국', selectionStart: 2, selectionEnd: 2 });
    await ime.send('Input.insertText', { text: '한국어' });
    assert.equal(await text(), originals['paper.tex'] + '한국어', 'IME composition commits Korean text');
    await page.keyboard.press('Tab'); assert.equal(await text(), originals['paper.tex'] + '한국어\t');
    await save({ file: 'paper.tex', text: originals['paper.tex'] + '한국어\t' }, 'Meta+s');
    await ime.detach();

    console.log('Editor browser: draft preview, math, sanitization and undo across tabs/save');
    await open('notes.md'); await frame().locator('#markdown .katex').first().waitFor();
    await source();
    // Append one native edit. CDP replacing an existing multiline selection has
    // a Chromium redo bug that also reproduces in a bare textarea.
    const addition = '\n# Unsaved 한글\n\n$\\frac{1}{2}$\n\n<script>window.PWNED=2</script>\n<img src=x onerror="window.PWNED=3">\n';
    const markdown = originals['notes.md'] + addition;
    await editor().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(addition);
    await frame().locator('#mode').click();
    await frame().locator('#markdown h1').filter({ hasText: 'Unsaved 한글' }).waitFor();
    await frame().locator('#markdown .katex').first().waitFor();
    assert.equal(await frame().locator('#markdown script, #markdown [onerror]').count(), 0);
    assert.equal(await fs.readFile(path.join(project, 'notes.md'), 'utf8'), originals['notes.md']);
    await source(); assert.equal(await text(), markdown);
    await page.keyboard.press('Control+z'); assert.equal(await text(), originals['notes.md']);
    await page.keyboard.press('Control+Shift+z'); assert.equal(await text(), markdown);
    await save({ file: 'notes.md', text: markdown });
    await frame().locator('#mode').click(); await source();
    await page.keyboard.press('Control+z'); assert.equal(await text(), originals['notes.md'], 'save and preview preserve native undo');
    await page.keyboard.press('Control+Shift+z'); assert.equal(await text(), markdown);

    console.log('Editor browser: unsaved HTML resources and blocked scripts');
    await row('docs').click(); await open('docs/page.html');
    assert.match(await page.locator('.workspace-slot.is-visible iframe').getAttribute('src'), /_preview/);
    let html = frame().frameLocator('#htmlPreview');
    await html.locator('h1').filter({ hasText: 'Original HTML' }).waitFor();
    await source();
    const htmlDraft = originals['docs/page.html'].replace('Original HTML', 'Unsaved HTML') + '<script src="/must-not-execute.js"></script><img src=x onerror="parent.PWNED=4">';
    await replace(htmlDraft); await frame().locator('#mode').click();
    await html.locator('h1').filter({ hasText: 'Unsaved HTML' }).waitFor();
    assert.equal(await html.locator('h1').evaluate(node => getComputedStyle(node).color), 'rgb(1, 2, 3)');
    await until(async () => await html.locator('img[src="image.svg"]').evaluate(node => node.complete && node.naturalWidth === 12), 'relative unsaved HTML image loads');
    assert.equal(await html.locator('body').evaluate(() => window.PWNED), undefined);
    assert.equal(await frame().locator('body').evaluate(() => window.PWNED), undefined);
    assert.equal(await page.evaluate(() => window.PWNED), undefined);
    assert.equal(await fs.readFile(path.join(project, 'docs/page.html'), 'utf8'), originals['docs/page.html']);
    await source(); await page.keyboard.press('Control+z'); assert.equal(await text(), originals['docs/page.html']);

    console.log('Editor browser: retained tabs preserve drafts and selection across file/root changes');
    await page.locator('#home').click(); await open('plain.txt');
    await editor().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('draft');
    await editor().evaluate(node => node.setSelectionRange(1, 4));
    const selection = await editor().evaluate(node => [node.selectionStart, node.selectionEnd]);
    const draftTab = page.locator('.file-tab[data-root="project"][data-path="plain.txt"]');
    await open('other.txt'); assert.equal(await text(), originals['other.txt']);
    await draftTab.locator('.tab-activate').click();
    assert.equal(await text(), edited + 'draft');
    assert.deepEqual(await editor().evaluate(node => [node.selectionStart, node.selectionEnd]), selection);
    await page.locator('#rootSelect').selectOption('other'); await row('plain.txt').waitFor();
    assert.equal(await page.locator('#rootSelect').inputValue(), 'other');
    await draftTab.locator('.tab-activate').click();
    assert.equal(await text(), edited + 'draft');
    assert.equal(await page.locator('#rootSelect').inputValue(), 'project');
    await cancel(() => draftTab.locator('.tab-close').click());
    await cancel(() => page.locator('#refresh').click()); assert.equal(await text(), edited + 'draft');
    await editor().focus(); await cancel(() => page.evaluate(() => location.reload()), 'beforeunload');
    assert.equal(await text(), edited + 'draft');

    console.log('Editor browser: failed save and external conflict preserve both sides');
    await page.route('**/api/save', route => route.abort('failed'));
    await editor().focus(); await page.keyboard.press('Control+s');
    await frame().locator('#notice').filter({ hasText: 'Could not save' }).waitFor();
    assert.equal(await text(), edited + 'draft'); assert.equal(await fs.readFile(path.join(project, 'plain.txt'), 'utf8'), edited);
    await page.unroute('**/api/save');
    await fs.writeFile(path.join(project, 'plain.txt'), 'external winner\n');
    await editor().focus(); await page.keyboard.press('Control+s');
    await frame().locator('#reload').waitFor();
    assert.equal(await text(), edited + 'draft'); assert.equal(await fs.readFile(path.join(project, 'plain.txt'), 'utf8'), 'external winner\n');
    await cancel(() => frame().locator('#reload').click()); assert.equal(await text(), edited + 'draft');
    page.once('dialog', prompt => prompt.accept()); await draftTab.locator('.tab-close').click(); await open('other.txt');

    console.log('Editor browser: delayed root response cannot replace the current editor');
    const held = gate(), started = gate();
    await page.route('**/api/editor?**', async route => {
      const request = new URL(route.request().url());
      if (request.searchParams.get('root') === 'project' && request.searchParams.get('path') === 'plain.txt') { started.release(); await held.promise; }
      await route.continue().catch(() => {});
    });
    await row('plain.txt').click(); await started.promise;
    await page.locator('#rootSelect').selectOption('other'); await row('plain.txt').click();
    await until(async () => await text() === 'other root\n', 'new root editor loads');
    held.release(); await page.unroute('**/api/editor?**'); await sleep(100);
    assert.equal(await text(), 'other root\n'); assert.equal(await page.locator('#rootSelect').inputValue(), 'other');
    // The current frame cannot spoof a previous root/session's dirty state.
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      origin: location.origin, source: document.querySelector('.workspace-slot.is-visible iframe').contentWindow,
      data: { type: 'fbrowse-editor-state', root: 'project', path: 'plain.txt', session: 'stale', dirty: true },
    })));

    console.log('Editor browser: fresh browser context and restarted server remember chosen tab');
    await page.locator('#rootSelect').selectOption('project'); await open('notes.md'); await source();
    await frame().locator('#mode').click(); await row('other.txt').click();
    await open('notes.md'); await frame().locator('#markdown h1').first().waitFor();
    await source();
    await until(async () => {
      const response = await page.request.get(new URL('/api/editor?root=project&path=notes.md', app.url).href);
      return (await response.json()).tab === 'source';
    }, 'source preference persisted');
    console.log('Editor browser: server shutdown leaves draft intact after rejected save');
    await editor().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('unsaved during shutdown');
    await app.close();
    await page.keyboard.press('Control+s');
    await frame().locator('#notice').filter({ hasText: 'Could not save' }).waitFor();
    assert.equal(await text(), markdown + 'unsaved during shutdown');
    assert.equal(await fs.readFile(path.join(project, 'notes.md'), 'utf8'), markdown);
    await page.context().close(); await app.close(); app = await start();
    const context = await browser.newContext(); page = await context.newPage();
    await page.goto(new URL('/?root=project&path=notes.md', app.url).href);
    await editor().waitFor({ state: 'visible' }); assert.equal(await text(), markdown);
    assert.equal(await frame().locator('#mode').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => /view|tab|editor/i.test(key))), false, 'file tabs do not use browser localStorage');
    await page.screenshot({ path: '/tmp/fbrowse-editor-0.9.1.png', fullPage: true });
    console.log('Editor browser: readonly fallback and textarea/mirror geometry');
    for (const file of ['mixed.txt', 'large.txt']) {
      await page.goto(new URL('/_preview?root=project&path=' + file, app.url).href);
      await page.locator('#editor[readonly]').waitFor();
      await page.locator('#notice').filter({ hasText: /read.only|8 MiB/i }).waitFor();
      assert.ok(await page.locator('#save').isDisabled());
      assert.equal((await page.locator('#editor').inputValue()).length, file === 'large.txt' ? 8 * 1024 * 1024 + 1 : 8);
    }
    await page.goto(new URL('/_preview?root=project&path=code.py', app.url).href);
    await page.locator('#code .hljs-keyword, #code .hljs-built_in').first().waitFor();
    for (const width of [240, 480, 800, 1000]) {
      await page.setViewportSize({ width, height: 850 });
      for (const wrap of [true, false]) {
        if ((await page.locator('#wrap').getAttribute('aria-pressed') === 'true') !== wrap) await page.locator('#wrap').click();
        // ResizeObserver delivery can follow the first two animation frames after viewport resize.
        await until(() => page.evaluate(() => {
          const a = document.querySelector('#editor').getBoundingClientRect(), b = document.querySelector('#code').parentElement.getBoundingClientRect();
          return ['x', 'y', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) <= 1);
        }), 'textarea and mirror settle to identical geometry after resize/wrap change');
        const geometry = await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const input = document.querySelector('#editor'), mirror = document.querySelector('#code').parentElement;
          const a = input.getBoundingClientRect(), b = mirror.getBoundingClientRect(), x = getComputedStyle(input), y = getComputedStyle(mirror);
          return { delta: ['x', 'y', 'width', 'height'].map(key => a[key] - b[key]),
            font: [x.fontFamily, x.fontSize, x.lineHeight, x.tabSize, x.padding],
            mirrorFont: [y.fontFamily, y.fontSize, y.lineHeight, y.tabSize, y.padding],
            preserved: input.value === document.querySelector('#code').textContent,
            overflow: input.scrollWidth - input.clientWidth };
        });
        assert.ok(geometry.delta.every(value => Math.abs(value) <= 1), JSON.stringify({ width, wrap, geometry }));
        assert.deepEqual(geometry.font, geometry.mirrorFont);
        assert.ok(geometry.preserved);
        if (wrap) assert.ok(geometry.overflow <= 1, JSON.stringify({ width, geometry }));
        else {
          await page.locator('#source').evaluate(node => node.scrollLeft = 200);
          assert.ok(await page.locator('#editor').evaluate(node => Math.abs(node.getBoundingClientRect().left - document.querySelector('#code').parentElement.getBoundingClientRect().left) <= 1));
        }
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: actual editor disk saves, native undo/redo, draft previews, HTML isolation, cancel/error/conflict/root races, browser and server restart');
  } finally {
    await browser?.close(); await app?.close();
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await fs.rm(base, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
