// Actual tree keyboard shortcuts and native clipboard acceptance, disposable disk/XDG only.
const { fixture } = require('./workspace-test-helper.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => fixture(async ({ ready, page, register, post, row, tab, frame, open }) => {
  const name = '한글 "quotes" <& $()` [x].txt';
  await fs.mkdir(path.join(ready.project, 'source/sub'), { recursive: true });
  await fs.mkdir(path.join(ready.results, 'target'));
  await fs.writeFile(path.join(ready.project, 'source', name), 'SAVED DISK\n');
  await fs.writeFile(path.join(ready.project, 'source/sub/child.txt'), 'CHILD');
  await fs.writeFile(path.join(ready.results, 'target/same.txt'), 'PARENT TARGET');
  await register('other', ready.results); await page.goto(ready.url);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(ready.url).origin });
  const calls = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/fs') calls.push(request.postDataJSON()); });
  const root = async id => { await page.locator('#rootSelect').selectOption(id); await row('README.md').waitFor(); };
  const reveal = async file => { const parts = file.split('/'); for (let i=1;i<parts.length;i++) { const parent=row(parts.slice(0,i).join('/')); if(await parent.getAttribute('aria-expanded')!=='true') await parent.click(); } };
  async function copy(file) {
    await reveal(file); const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/fs-info' && new URL(r.url()).searchParams.get('path')===file);
    await row(file).focus(); await page.keyboard.press('Control+c'); assert.equal((await response).status(),200);
    await page.locator('#clipboardStatus').filter({hasText:/복사됨/}).waitFor();
    await page.waitForFunction(()=>document.querySelector('#clipboardStatus').getAttribute('aria-busy')==='false');
  }
  async function paste(file, expectedParent, { blank = false, success = true } = {}) {
    if(blank) { const rect=await page.locator('#entries').boundingBox(); await page.mouse.click(rect.x+rect.width-4,rect.y+rect.height-4); }
    else { await reveal(file); await row(file).click(); await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))); }
    const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/fs' && r.request().postDataJSON().action==='copy');
    await page.keyboard.press('Control+v'); const response=await pending; const body=await response.json();
    assert.equal(response.status(),success?201:409,JSON.stringify(body));
    await page.waitForFunction(()=>document.querySelector('#clipboardStatus').getAttribute('aria-busy')==='false');
    const call=calls.at(-1); assert.equal(call.parent,expectedParent); assert.equal(call.source_root,'project'); assert.equal(call.source_root_path,ready.project);
    assert.equal(call.root_path,call.root==='other'?ready.results:ready.project);
    if(await page.locator('#fsDialog').isVisible()) await page.locator('#fsCancel').click();
    return body;
  }
  await reveal('source/'+name); await open('source/'+name); const editor=await frame('source/'+name);
  await editor.locator('#editor:not([readonly])').waitFor(); await editor.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('DRAFT ONLY');
  const draft=await editor.locator('#editor').inputValue(); const id=await tab('source/'+name).getAttribute('data-tab');
  await page.evaluate(id=>{ const f=document.querySelector('iframe[data-tab="'+id+'"]'); window.copyIdentity={f,win:f.contentWindow,doc:f.contentDocument,editor:f.contentDocument.querySelector('#editor'),session:f.contentWindow.fbrowseEditor.session}; },id);
  await page.evaluate(()=>navigator.clipboard.writeText('NATIVE TEXT CANARY'));
  await copy('source/'+name); assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'NATIVE TEXT CANARY','file copy uses memory metadata and leaves OS text clipboard alone');
  await root('other');
  const first=await paste('target','target'); assert.equal(first.path,'target/'+name); assert.equal(first.source_root_id,'project');
  const second=await paste('target','target'); assert.notEqual(second.path,first.path); assert(second.path.endsWith('.txt'));
  const beside=await paste('target/same.txt','target'); assert.notEqual(beside.path,first.path);
  const blank=await paste(null,'',{blank:true}); assert.equal(blank.path,name,'blank tree uses newly selected root');
  for(const result of [first,second,beside,blank]) assert.equal(await fs.readFile(path.join(ready.results,result.path),'utf8'),'SAVED DISK\n');
  assert.equal(await fs.readFile(path.join(ready.results,'target/same.txt'),'utf8'),'PARENT TARGET');
  assert.equal(await editor.locator('#editor').inputValue(),draft);
  assert(await page.evaluate(()=>{const i=copyIdentity;return i.f.isConnected&&i.f.contentWindow===i.win&&i.f.contentDocument===i.doc&&i.doc.querySelector('#editor')===i.editor&&i.win.fbrowseEditor.session===i.session;}));
  await tab('source/'+name).locator('.tab-activate').click();
  await editor.locator('#editor').focus(); await page.keyboard.press('Control+z'); assert.equal(await editor.locator('#editor').inputValue(),'SAVED DISK\n');
  await page.keyboard.press('Control+Shift+z'); assert.equal(await editor.locator('#editor').inputValue(),draft);
  // Input/editor text clipboard shortcuts must never issue file mutations or change the file reference.
  const before=calls.length;
  await page.locator('#search').fill('native input'); await page.locator('#search').focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'native input');
  await page.locator('#search').fill(''); await page.keyboard.press('Control+v'); assert.equal(await page.locator('#search').inputValue(),'native input');
  await page.locator('#search').fill('');
  await page.evaluate(()=>navigator.clipboard.writeText(' EDITOR TEXT'));
  await editor.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.press('Control+v');
  assert.equal(await editor.locator('#editor').inputValue(),draft+' EDITOR TEXT');
  await editor.locator('#editor').evaluate(n=>n.setSelectionRange(0,5));await page.keyboard.press('Control+c');assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'SAVED');assert.equal(calls.length,before);
  await root('project'); await copy('source'); await root('other');
  const directory=await paste('target','target'); assert.equal(await fs.readFile(path.join(ready.results,directory.path,'sub/child.txt'),'utf8'),'CHILD');
  await root('project'); await copy('source/'+name); await fs.writeFile(path.join(ready.project,'source',name),'EXTERNAL CHANGE'); await root('other');
  await paste('target','target',{success:false});
  await root('project');await copy('same.txt');await root('other');
  const sameName=await paste('target/same.txt','target');assert.notEqual(sameName.path,'target/same.txt');assert.equal(await fs.readFile(path.join(ready.results,sameName.path),'utf8'),'project');
  assert.equal(await fs.readFile(path.join(ready.results,'same.txt'),'utf8'),'results');
  // Context menu exposes the same metadata clipboard and preserves the native text clipboard.
  await root('project');await reveal('source/sub/child.txt');await row('source/sub/child.txt').click({button:'right'});await page.locator('#contextCopyFile').click();
  await page.locator('#clipboardStatus').filter({hasText:/복사됨/}).waitFor();await root('other');await row('target').click({button:'right'});
  const menuPaste=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/fs'&&r.request().postDataJSON().action==='copy');await page.locator('#contextPasteFile').click();assert.equal((await menuPaste).status(),201);
  await page.waitForFunction(()=>document.querySelector('#clipboardStatus').getAttribute('aria-busy')==='false');
  // Preflight rejects disappeared/remapped roots before submitting any mutation.
  async function refusedBeforePost() {
    const before=calls.length;await row('target').focus();await page.keyboard.press('Control+v');
    await page.locator('#clipboardStatus').filter({hasText:/실패|failed/i}).waitFor();assert.equal(calls.length,before,'invalid root never sends copy POST');
  }
  await root('project');await copy('source/sub/child.txt');await root('other');
  await fs.rename(ready.project,ready.project+'-unmounted');try{await refusedBeforePost();}finally{await fs.rename(ready.project+'-unmounted',ready.project);}
  await root('project');await copy('source/sub/child.txt');await root('other');
  assert.equal((await post('api/roots',{operation:'edit',id:'other',name:'other',path:ready.papers})).status(),200);
  await refusedBeforePost();
  assert.equal((await post('api/roots',{operation:'edit',id:'other',name:'other',path:ready.results})).status(),200);
  // Copy from a registered source then remove its mapping while another root is active.
  await root('other');await row('same.txt').focus();const sourceInfo=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/fs-info');await page.keyboard.press('Control+c');await sourceInfo;
  await page.locator('#clipboardStatus').filter({hasText:/복사됨/}).waitFor();await root('project');
  assert.equal((await post('api/roots',{operation:'remove',id:'other'})).status(),200);
  const beforeRemove=calls.length;await row('source').focus();await page.keyboard.press('Control+v');await page.locator('#clipboardStatus').filter({hasText:/실패|failed/i}).waitFor();assert.equal(calls.length,beforeRemove);
  await register('other',ready.results);
  await root('project'); await copy('same.txt'); await fs.unlink(path.join(ready.project,'same.txt')); await root('other');
  // Deleted source may use 404/409 depending on the boundary that detects disappearance.
  await row('target').focus(); const missing=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/fs'&&r.request().postDataJSON().action==='copy'); await page.keyboard.press('Control+v'); assert((await missing).status()>=400);
  if(await page.locator('#fsDialog').isVisible())await page.locator('#fsCancel').click();
  await page.screenshot({path:'/tmp/fbrowse-copy-0.9.1.png',fullPage:true});
  console.log('PASS: actual tree Ctrl+C/V, selected folder/file parent/blank and root switch, cross-root names/repeats/no overwrite, saved bytes, native text clipboard, editor identity/undo, directory/stale/deleted source');
}))().catch(error=>{console.error(error);process.exitCode=1;});
