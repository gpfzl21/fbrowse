// Browser tooling only; all server/filesystem writes belong to disposable fixture roots.
const { chromium } = require(process.env.FBROWSE_PLAYWRIGHT_MODULE || process.argv[2] || 'playwright');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const assert = require('node:assert/strict');
async function fixture(run, { git = false } = {}) {
  const child = spawn(process.execPath, [__dirname + '/browser-fixture.mjs'], {
    cwd: __dirname + '/..', stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...(git ? { FBROWSE_GIT_FIXTURE: '1' } : {}) },
  });
  let browser, page;
  const errors = [];
  try {
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Fixture startup timeout')), 30000);
      readline.createInterface({ input: child.stdout }).once('line', line => {
        clearTimeout(timeout); try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      });
      child.once('error', reject); child.once('exit', code => reject(Error('Fixture exited: ' + code)));
    });
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    page.setDefaultTimeout(12000);
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
    const info = await (await page.request.get(ready.url + 'api/info')).json();
    const post = (route, data) => page.request.post(ready.url + route, {
      headers: { 'X-Fbrowse-Token': info.config_token, Origin: new URL(ready.url).origin }, data,
    });
    const register = async (id, directory) => { const response = await post('api/roots', { operation: 'add', id, name: id, path: directory }); assert.equal(response.status(), 200); };
    const row = file => page.locator('#entries button.row').and(page.locator('[data-path=' + JSON.stringify(file) + ']'));
    const tab = (file, root = 'project') => page.locator('.file-tab').and(page.locator('[data-root=' + JSON.stringify(root) + '][data-path=' + JSON.stringify(file) + ']'));
    const frame = async (file, root = 'project') => { const id = await tab(file, root).getAttribute('data-tab'); return page.frameLocator('iframe[data-tab=' + JSON.stringify(id) + ']'); };
    const open = async file => { await row(file).click(); return frame(file, await page.locator('#rootSelect').inputValue()); };
    const dismiss = async (action, type = 'confirm') => {
      const dialog = page.waitForEvent('dialog'), pending = action(); const prompt = await dialog;
      assert.equal(prompt.type(), type); await prompt.dismiss(); await pending;
    };
    await run({ ready, browser, page, info, post, register, row, tab, frame, open, dismiss, errors, requests });
    assert.deepEqual(errors, []);
    assert.equal(browser.contexts().flatMap(context => context.pages()).length, 1, 'no startup browser or extra tabs');
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: '/tmp/fbrowse-0.9.1-failure.png', fullPage: true }).catch(() => {});
      console.error('Fixture page errors:', errors);
      console.error('Fixture failure state:', await page.evaluate(() => ({ root: state.root, rootSelect: document.querySelector('#rootSelect').value,
        rows: [...document.querySelectorAll('#entries .row')].map(n => [n.dataset.path, n.dataset.root]),
        status: document.querySelector('#status').textContent, fsMessage: document.querySelector('#fsMessage')?.textContent,
        fsTarget: document.querySelector('#fsTarget')?.textContent, fsDescription: document.querySelector('#fsDescription')?.textContent,
        operation: typeof fsOperation !== 'undefined' ? fsOperation?.action : null })).catch(() => null));
    }
    throw error;
  } finally {
    await browser?.close(); child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  }
}
const gate = () => { let release; const promise = new Promise(resolve => release = resolve); return { promise, release }; };
// These helpers use rendered geometry and actual pointer input, never invoke app actions.
const fileTab = (page, file, root = 'project') => page.locator('.file-tab[data-root=' + JSON.stringify(root) + '][data-path=' + JSON.stringify(file) + ']');
async function groupRect(page, file, root = 'project') {
  const tab = fileTab(page, file, root);
  return tab.evaluate(node => {
    const strip = node.closest('.pane-tabs'), r = strip.getBoundingClientRect();
    const group = strip.dataset.group || strip.dataset.pane;
    const slot = [...document.querySelectorAll('.workspace-slot.is-visible')].find(n => (n.dataset.group || n.dataset.pane) === group);
    if (!slot) throw Error('No visible content for group ' + group);
    const content = slot.getBoundingClientRect();
    return { id: group, x: r.x, y: r.y, width: r.width, height: content.bottom - r.y, tabHeight: r.height };
  });
}
async function dragTab(page, file, target, { root = 'project', inspect, cancel } = {}) {
  const label = fileTab(page, file, root).locator('.tab-activate');
  await label.scrollIntoViewIfNeeded(); const box = await label.boundingBox();
  const point = typeof target === 'function' ? await target() : target;
  const x = box.x + Math.min(35, box.width / 2), y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 12, y + 3, { steps: 5 });
  await page.mouse.move(point.x, point.y, { steps: 15 });
  await page.mouse.move(point.x + 1, point.y + 1); await page.mouse.move(point.x, point.y);
  if (inspect) await inspect();
  if (cancel === 'Escape') await page.keyboard.press('Escape');
  if (cancel === 'outside') await page.mouse.move(4, 4, { steps: 8 });
  if (cancel === 'pointercancel') await label.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
  await page.mouse.up();
  await page.locator('#workspaceDrop').waitFor({ state: 'hidden' });
  assert(await page.locator('#workspaceDragCover').isHidden(), 'drag cover removed');
  assert(await page.locator('.workspace-drag-ghost').isHidden(), 'drag ghost removed');
  assert(await page.locator('#workspaceInsertion').isHidden(), 'insertion marker removed');
  assert.equal(await page.locator('.is-drag-source').count(), 0, 'source dimming removed');
  assert(await page.evaluate(() => !pointerTabDrag && !tabDrag && !dragGhost), 'drag source references released');
  assert(await page.evaluate(() => ![...document.querySelectorAll('*')].some(node => node.hasPointerCapture?.(1))), 'pointer capture released');
}
function groupPoint(page, file, edge = 'center', root = 'project') {
  return async () => { const r = await groupRect(page, file, root); return {
    x: edge === 'left' ? r.x + 5 : edge === 'right' ? r.x + r.width - 5 : r.x + r.width / 2,
    y: edge === 'top' ? r.y + r.tabHeight + 5 : edge === 'bottom' ? r.y + r.height - 5 : r.y + r.tabHeight + (r.height - r.tabHeight) / 2,
  }; };
}
async function expandTab(page, file, { root = 'project', keyboard = false } = {}) {
  const label = fileTab(page, file, root).locator('.tab-activate');
  if (keyboard) { await label.focus(); await page.keyboard.press('Shift+F10'); }
  else await label.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Expand Current File/ }).click();
}
async function previewControl(page, id) {
  const tabId = await page.evaluate(() => state.activeTab);
  const fallback = page.locator('#slot-' + tabId + ' > .preview-view-actions #' + id);
  if (await fallback.count()) return fallback;
  return page.frameLocator('iframe[data-tab="' + tabId + '"]').locator('#' + id);
}
module.exports = { previewControl, fixture, gate, fileTab, groupRect, groupPoint, dragTab, expandTab };
