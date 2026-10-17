// Physical headless Chromium inputs, real Ruff/ChkTeX, disposable sources only.
const { fixture, gate, dragTab, groupPoint, expandTab } = require('./workspace-test-helper.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let i = 0; i < 180; i++) { if (await check()) return; await sleep(50); } assert.fail(label); }

(async () => fixture(async ({ ready, page, row, tab, frame, open }) => {
  const originals = { 'decoration.py': 'value = 1\n', 'decoration.tex': '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n' };
  const before = {};
  for (const [file, text] of Object.entries(originals)) {
    const target = path.join(ready.project, file); await fs.writeFile(target, text);
    before[file] = (await fs.stat(target, { bigint: true })).mtimeNs;
  }
  const results = [];
  page.on('response', async response => {
    if (new URL(response.url()).pathname === '/api/diagnostics') {
      try { results.push({ text: response.request().postDataJSON().text, body: await response.json() }); } catch {}
    }
  });
  await page.goto(ready.url); let code = await open('decoration.py');
  const editor = () => code.locator('#editor');
  const waves = () => code.locator('.diagnostic-underline');
  const tooltip = () => code.locator('#diagnosticTooltip');
  const panel = () => code.locator('#diagnosticsPanel');
  const screenshot = name => page.screenshot({ path: path.join(process.env.FBROWSE_SCREENSHOT_DIR || '/tmp', 'diagnostic-' + name + '.png'), fullPage: true });
  const sourceRect = () => code.locator('#source').evaluate(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  async function replace(text) {
    const count = results.length;
    await editor().focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(text);
    assert.equal(await editor().inputValue(), text);
    assert.equal(await waves().count(), 0, 'input immediately clears stale squiggles');
    assert(await tooltip().isHidden(), 'input immediately dismisses tooltip');
    await until(() => Promise.resolve(results.slice(count).some(result => result.text === text)), 'current real checker result');
    const result = results.slice(count).find(result => result.text === text).body;
    assert.equal(result.status, 'ok', 'required real checker available');
    await until(async () => await code.locator('#diagnosticsList button').count() === result.diagnostics.length, 'issues rendered');
    if (result.diagnostics.length) { try { await until(async () => await waves().count() > 0, 'source squiggles painted'); } catch (error) { console.error('Decoration geometry failure', JSON.stringify({ diagnostics: result.diagnostics, geometry: await editor().evaluate(n => ({ text:n.value, shell:[document.querySelector('#source').scrollTop,document.querySelector('#source').scrollLeft], code:document.querySelector('#code').getBoundingClientRect().toJSON(), end:document.querySelector('#sourceEnd').getBoundingClientRect().toJSON(), viewport:[innerWidth,innerHeight] })) })); throw error; } }
    return result.diagnostics;
  }
  // Independent source DOMRange measurements; never call decoration implementation helpers.
  async function glyph(start, end = start + 1) {
    return code.locator('#code').evaluate((node, [start, end]) => {
      const locate = offset => { const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let last; while (w.nextNode()) { last = w.currentNode; if (offset <= last.length) return [last, offset]; offset -= last.length; } return [last, last.length]; };
      const a = locate(start), b = locate(end), range = document.createRange(); range.setStart(...a); range.setEnd(...b);
      return [...range.getClientRects()].filter(r => r.width > 0).map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }));
    }, [start, end]);
  }
  async function hoverOffset(offset, expected) {
    const r = (await glyph(offset))[0]; assert(r, 'glyph exists');
    const local = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    assert.equal(await editor().evaluate((node, p) => document.elementFromPoint(p.x, p.y) === node, local), true, 'native transparent textarea receives hover');
    const box = await editor().boundingBox(), localBox = await editor().evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    await page.mouse.move(box.x - localBox.x + local.x, box.y - localBox.y + local.y);
    await tooltip().waitFor({ state: 'visible' });
    for (const value of expected) assert((await tooltip().textContent()).includes(value), 'tooltip contains ' + value);
  }
  async function assertWave(start, end, severity) {
    const rects = await glyph(start, end);
    const painted = await waves().evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(), c = getComputedStyle(n); return { x: r.x, y: r.y, width: r.width, height: r.height, severity: n.dataset.severity, background: c.backgroundImage, repeat: c.backgroundRepeat, z: c.zIndex }; }));
    for (const r of rects) assert(painted.some(p => p.severity === severity && Math.abs(p.x-r.x)<2 && Math.abs(p.width-r.width)<3 && Math.abs(p.y-r.bottom)<5), 'wavy ' + severity + ' follows actual glyph range ' + JSON.stringify({ r, painted }));
    assert(painted.filter(p => p.severity === severity).every(p => p.background.includes('svg') && p.background.includes(severity === 'error' ? 'cf222e' : '9a6700') && p.repeat === 'repeat-x'), 'correct red/yellow repeating wave asset');
  }
  await code.locator('#diagnosticsStatus').filter({ hasText: /오류 0 · 경고 0/ }).waitFor();
  const identity = await tab('decoration.py').getAttribute('data-tab');
  await page.evaluate(id => { const f = document.querySelector('iframe[data-tab="'+id+'"]'); window.decorationIdentity = [f, f.contentWindow, f.contentDocument, f.contentDocument.querySelector('#editor')]; }, identity);
  console.log('Decoration: physical hover through textarea, overlapping real Ruff errors/warnings, Unicode and native editing');
  const unicode = '한글 = "😀";\tmissing_name\n';
  let issues = await replace(unicode);
  assert(issues.some(x => x.code === 'B018' && x.severity === 'warning'));
  assert(issues.some(x => x.code === 'F821' && x.severity === 'error'));
  const missing = unicode.indexOf('missing_name');
  await assertWave(missing, missing + 12, 'error');
  await hoverOffset(missing + 3, ['B018', 'F821', 'Found useless expression', 'Undefined name']);
  await screenshot('overlap-hover');
  const priority = await code.locator('.diagnostic-underline[data-severity="error"]').evaluateAll(nodes => nodes.every(n => Number(getComputedStyle(n).zIndex) > 0)); assert(priority, 'overlapping error paints above warning');
  await code.locator('#diagnosticsToggle').click(); await code.locator('#diagnosticsList button').filter({ hasText: 'F821' }).click();
  assert.equal(await editor().evaluate(n => n.selectionStart), missing, 'Unicode codepoint API converts to exact UTF16 caret');
  assert(await panel().isHidden(), 'item click dismisses popover');
  await editor().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('# undo\n');
  await page.keyboard.press('Control+z'); assert.equal(await editor().inputValue(), unicode, 'native Ctrl+Z');
  await page.keyboard.press('Control+Shift+z'); assert.equal(await editor().inputValue(), unicode + '# undo\n');
  const warningText = 'import os\n'; issues = await replace(warningText); assert(issues.some(x => x.code === 'F401'));
  await assertWave(7, 9, 'warning'); await hoverOffset(7, ['F401', 'imported but unused']);
  await page.mouse.move(2, 2); await tooltip().waitFor({ state: 'hidden' });
  // Selection is made with a real pointer drag over source glyphs.
  const a = (await glyph(7))[0], b = (await glyph(8))[0], eb = await editor().boundingBox(), el = await editor().evaluate(n => { const r = n.getBoundingClientRect(); return { x:r.x,y:r.y }; });
  await page.mouse.move(eb.x-el.x+a.x,eb.y-el.y+a.y+a.height/2); await page.mouse.down();
  await page.mouse.move(eb.x-el.x+b.x+b.width,eb.y-el.y+b.y+b.height/2,{steps:8}); await page.mouse.up();
  assert.equal(await editor().evaluate(n => n.value.slice(n.selectionStart,n.selectionEnd)), 'os', 'physical native selection');
  const eof = 'def broken('; issues = await replace(eof);
  assert(issues.some(x => x.code === 'invalid-syntax' && x.column === eof.length + 1 && x.end_column === x.column), 'real EOF zero-width syntax error');
  const finalGlyph = (await glyph(eof.length-1))[0], eofWave = await code.locator('.diagnostic-underline[data-severity="error"]').boundingBox();
  const ebEof = await editor().boundingBox(), elEof = await editor().evaluate(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y};});
  assert(Math.abs(eofWave.x-(ebEof.x-elEof.x+finalGlyph.x+finalGlyph.width))<2,'EOF wave follows final glyph');
  await page.mouse.move(eofWave.x+3,eofWave.y-5); await tooltip().waitFor({state:'visible'}); assert((await tooltip().textContent()).includes('unexpected EOF'));
  const wrapped = '한글 = "😀' + '한글\tabc '.repeat(20) + '"; missing_name\n';
  await replace(wrapped);
  for (const width of [970, 1430]) {
    await page.setViewportSize({ width, height: 900 }); await sleep(180);
    await assertWave(wrapped.indexOf('missing_name'), wrapped.indexOf('missing_name')+12, 'error');
    await hoverOffset(wrapped.indexOf('missing_name')+2, ['F821']);
    assert.equal(await editor().inputValue(), wrapped);
  }
  await code.locator('#wrap').click(); await sleep(120);
  // Scroll horizontally by actual wheel input, then check that the wave remains on its glyph.
  await editor().focus(); await page.keyboard.press('Control+End'); await page.keyboard.press('Home'); await page.keyboard.press('End');
  const src = await code.locator('#source').boundingBox(); await page.mouse.move(src.x+src.width-25,src.y+70); await page.mouse.wheel(10000,0); await sleep(180);
  await assertWave(wrapped.indexOf('missing_name'), wrapped.indexOf('missing_name')+12, 'error');
  await code.locator('#wrap').click();
  const multiline = 'def example():\n    (\n        "한글😀",\n        "두번째"\n    )\n';
  issues = await replace(multiline); const multi = issues.find(x => x.code === 'B018'); assert(multi && multi.end_line > multi.line, 'real multiline checker range');
  const begin = multiline.indexOf('(' , multiline.indexOf('\n')), end = multiline.lastIndexOf(')')+1;
  await assertWave(begin, end, 'warning'); await hoverOffset(multiline.indexOf('두번째'), ['B018']);
  const tex = await open('decoration.tex'); code = tex;
  await code.locator('#diagnosticsStatus').filter({ hasText: /오류 0 · 경고 0/ }).waitFor();
  const texText = '한글😀\tHello world...\n'; issues = await replace(texText); const dots = issues.find(x => x.code === '11'); assert(dots && dots.severity === 'warning');
  await assertWave(texText.indexOf('...'), texText.indexOf('...')+3, 'warning'); await hoverOffset(texText.indexOf('...'), ['11']);
  const unclosed = '\\begin{document}\n$x\n\\end{document}\n';
  issues = await replace(unclosed); assert(issues.some(x => x.code === '16' && x.column === x.end_column), 'real zero-width ChkTeX error');
  await hoverOffset(unclosed.indexOf('\\end'), ['16', 'Mathmode still on']);
  await tab('decoration.py').locator('.tab-activate').click(); code = await frame('decoration.py');
  console.log('Decoration: 200 real issues, narrow split floating bounds, internal wheel, exact navigation and dismissals');
  const many = Array.from({length:110},(_,i) => 'missing_'+i).join('\n')+'\n'; issues = await replace(many); assert.equal(issues.length,200,'real Ruff result cap');
  await open('same.txt'); await dragTab(page,'same.txt',groupPoint(page,'decoration.py','right'));
  await tab('decoration.py').locator('.tab-activate').click();
  await page.setViewportSize({ width:1100,height:780 }); await sleep(200);
  await until(async () => await waves().count()>0,'active split restored decorations');
  let closed = await sourceRect(); await code.locator('#diagnosticsToggle').click(); await panel().waitFor({state:'visible'});
  assert.deepEqual(await sourceRect(),closed,'popover never shifts code viewport');
  const bounds = await panel().evaluate(n => {const r=n.getBoundingClientRect(),b=document.querySelector('#diagnosticsToggle').getBoundingClientRect(),l=document.querySelector('#diagnosticsList'); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight,buttonBottom:b.bottom,buttonTop:b.top,scroll:l.scrollHeight,client:l.clientHeight};});
  await screenshot('narrow-popover');
  assert(bounds.x>=0&&bounds.y>=0&&bounds.right<=bounds.vw&&bounds.bottom<=bounds.vh,'popover within narrow iframe '+JSON.stringify(bounds));
  assert(bounds.width<=420&&bounds.height<=360&&bounds.scroll>bounds.client,'bounded internal list');
  assert(Math.min(Math.abs(bounds.y-bounds.buttonBottom),Math.abs(bounds.bottom-bounds.buttonTop))<20,'popover anchored near button');
  const lb = await code.locator('#diagnosticsList').boundingBox(); await page.mouse.move(lb.x+lb.width/2,lb.y+lb.height/2); await page.mouse.wheel(0,850); await sleep(150);
  assert(await code.locator('#diagnosticsList').evaluate(n=>n.scrollTop>0),'physical wheel scrolls list'); assert.deepEqual(await sourceRect(),closed);
  const last = code.locator('#diagnosticsList button').last(); await last.scrollIntoViewIfNeeded(); const text=await last.textContent(); const [line,column]=text.match(/^(\d+):(\d+)/).slice(1).map(Number); await last.click();
  assert.equal(await editor().evaluate(n=>n.selectionStart),many.split('\n').slice(0,line-1).reduce((n,s)=>n+s.length+1,0)+column-1,'scrolled issue exact caret');
  for(const how of ['outside','Escape','close']) {
    await code.locator('#diagnosticsToggle').click(); await panel().waitFor({state:'visible'});
    if(how==='outside')await editor().click(); else if(how==='Escape')await page.keyboard.press('Escape'); else await code.locator('#diagnosticsClose').click();
    assert(await panel().isHidden(),how+' dismisses');
  }
  await code.locator('#diagnosticsToggle').click(); await expandTab(page,'decoration.py');
  assert(await code.locator('#previewHeader').isHidden()); assert(await panel().isHidden(),'expanded hides popover');
  await editor().focus(); await page.keyboard.press('Escape'); assert(await code.locator('#previewHeader').isVisible(),'focused Esc still exits');
  await replace(unicode); await hoverOffset(missing,['F821']); await code.locator('#diagnosticsEnabled').click();
  assert.equal(await waves().count(),0); assert(await tooltip().isHidden()); await code.locator('#diagnosticsEnabled').click();
  await until(async()=>await waves().count()>0,'reenabled'); await hoverOffset(missing,['F821']); await tab('same.txt').locator('.tab-activate').click();
  assert.equal(await waves().count(),0,'inactive clears waves'); assert(await tooltip().isHidden()); await tab('decoration.py').locator('.tab-activate').click();
  await until(async()=>await waves().count()>0,'reactivation'); await hoverOffset(missing,['F821']);
  const mutation = gate(), mutationSeen = gate();
  await page.route('**/api/fs', async route => { mutationSeen.release(); await mutation.promise; await route.continue(); });
  await row('decoration.py').click({button:'right'}); await page.locator('#contextRename').click();
  await page.locator('#fsName').fill('decoration-renamed.py'); await page.locator('#fsSubmit:enabled').click(); await mutationSeen.promise;
  assert.equal(await waves().count(),0,'mutation lock clears waves'); assert(await tooltip().isHidden()); mutation.release();
  await tab('decoration-renamed.py').waitFor(); await page.locator('#fsDialog').waitFor({state:'hidden'}); await page.unroute('**/api/fs');
  // A bounded markup-looking message fixture tests escaping only; all geometry/checker cases above use real results.
  console.log('Decoration: literal markup tooltip escaping and bounded long messages');
  const markup='<img src=x onerror="window.DECORATION_PWNED=1"> & <b>literal</b> '+ '긴 메시지 '.repeat(100);
  await page.route('**/api/diagnostics',async route=>{const b=route.request().postDataJSON();return route.fulfill({json:{root_id:b.root,path:b.path,request_id:b.request_id,language:'python',checker:'ruff',status:'ok',diagnostics:[{line:1,column:1,end_line:1,end_column:3,severity:'error',code:'ESCAPE',message:markup}]}});});
  await replace('한글\n'); await hoverOffset(0,['ESCAPE','<img','<b>literal</b>']);
  assert.equal(await tooltip().locator('img,b,script').count(),0); assert.equal(await code.locator('body').evaluate(()=>window.DECORATION_PWNED),undefined);
  const tr=await tooltip().evaluate(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight};});
  assert(tr.x>=0&&tr.y>=0&&tr.right<=tr.vw&&tr.bottom<=tr.vh&&tr.height<=240,'long tooltip bounded');
  closed=await sourceRect();await code.locator('#diagnosticsToggle').click();assert.deepEqual(await sourceRect(),closed);await code.locator('#diagnosticsClose').click();
  await page.unroute('**/api/diagnostics');
  assert(await page.evaluate(()=>{const [f,w,d,e]=decorationIdentity;return f.isConnected&&f.contentWindow===w&&f.contentDocument===d&&d.querySelector('#editor')===e;}),'fixed frame/document/editor identity');
  assert.equal(await code.locator('#source').evaluate(n=>getComputedStyle(n).overflowAnchor),'none');
  for(const [file,text]of Object.entries(originals)){const target=file==='decoration.py'?'decoration-renamed.py':file;assert.equal(await fs.readFile(path.join(ready.project,target),'utf8'),text,'disk bytes unchanged');assert.equal((await fs.stat(path.join(ready.project,target),{bigint:true})).mtimeNs,before[file],'disk mtime unchanged');}
  await page.screenshot({path:path.join(process.env.FBROWSE_SCREENSHOT_DIR||'/tmp','diagnostic-decorations.png'),fullPage:true});
  console.log('PASS: physical real-checker squiggles/hover/overlap, Unicode, wrapped/nowrap/multiline ranges, resize/scroll, native undo/selection/frame identity, bounded floating 200-issue popover, cancellation/expanded exits, safe literal tooltip and unchanged disk');
}))().catch(error=>{console.error(error);process.exitCode=1;});
