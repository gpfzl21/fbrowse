const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {fixture,gate}=require('./workspace-test-helper.cjs');
fixture(async({ready,page,row,tab,frame,open})=>{
  await fs.mkdir(path.join(ready.project,'source/folder/child'),{recursive:true});
  await fs.mkdir(path.join(ready.project,'destination'));
  await fs.writeFile(path.join(ready.project,'source/draft.txt'),'SAVED\n');
  await fs.writeFile(path.join(ready.project,'source/folder/child/note.md'),'# Child\n');
  await fs.writeFile(path.join(ready.project,'source/collision.txt'),'SOURCE');
  await fs.writeFile(path.join(ready.project,'destination/collision.txt'),'DESTINATION');
  for(let i=0;i<60;i++)await fs.writeFile(path.join(ready.project,'zz-overflow-'+String(i).padStart(2,'0')+'.txt'),'scroll');
  await page.goto(ready.url);await row('source').click();
  const editor=await open('source/draft.txt');await editor.locator('#editor:not([readonly])').waitFor();
  await editor.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('DRAFT');
  const id=await tab('source/draft.txt').getAttribute('data-tab');
  await page.evaluate(()=>{const t=state.tabs.find(t=>t.entry.path==='source/draft.txt');window.moveIdentity={frame:t.frame,doc:t.frame.contentDocument,editor:t.frame.contentDocument.querySelector('#editor')};});
  async function start(file,target){
    const source=row(file).locator('.filename');await source.scrollIntoViewIfNeeded();await target.scrollIntoViewIfNeeded();
    const a=await source.boundingBox(),b=await target.boundingBox();
    await page.mouse.move(a.x+15,a.y+a.height/2);await page.mouse.down();await page.mouse.move(a.x+24,a.y+a.height/2+2,{steps:3});
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:12});
  }
  async function drop(file,target,{hover=false,cancel=false}={}){
    await start(file,target);await page.locator('.workspace-drag-ghost').waitFor();
    if(hover)await row('destination').and(page.locator('[aria-expanded="true"]')).waitFor();
    if(cancel)await page.keyboard.press('Escape');
    await page.mouse.up();await page.locator('.workspace-drag-ghost').waitFor({state:'hidden'});
    if(!cancel)await page.waitForFunction(()=>!fsOperation);
    assert.equal(await page.locator('.is-move-target,.is-drag-source').count(),0);
  }
  await start('source/draft.txt',row('destination'));
  await page.locator('.workspace-drag-ghost[data-drop="move"]').waitFor();
  await row('destination').and(page.locator('[aria-expanded="true"]')).waitFor();
  assert.equal(await page.locator('.is-drag-source').count(),1,'redraw keeps source feedback');
  await page.screenshot({path:'/tmp/fbrowse-tree-move.png',fullPage:true});
  await page.mouse.up();await tab('destination/draft.txt').waitFor();await page.waitForFunction(()=>!fsOperation);
  assert.equal(await tab('destination/draft.txt').getAttribute('data-tab'),id);
  assert(await page.evaluate(()=>{const t=state.tabs.find(t=>t.entry.path==='destination/draft.txt');return t.frame===moveIdentity.frame&&t.frame.contentDocument===moveIdentity.doc&&t.frame.contentDocument.querySelector('#editor')===moveIdentity.editor;}));
  assert.equal(await editor.locator('#editor').inputValue(),'SAVED\nDRAFT');
  await editor.locator('#editor').focus();await page.keyboard.press('Control+z');assert.equal(await editor.locator('#editor').inputValue(),'SAVED\n');
  await page.keyboard.press('Control+Shift+z');await page.keyboard.press('Control+s');await editor.locator('#dirty').filter({hasText:''}).waitFor();
  await page.waitForFunction(()=>state.tabs.find(t=>t.entry.path==='destination/draft.txt').frame.contentWindow.fbrowseEditor.dirty===false);
  assert.equal(await fs.readFile(path.join(ready.project,'destination/draft.txt'),'utf8'),'SAVED\nDRAFT');
  await drop('destination/draft.txt',page.locator('#listLabel'));await tab('draft.txt').waitFor();
  assert.equal(await fs.readFile(path.join(ready.project,'draft.txt'),'utf8'),'SAVED\nDRAFT');
  await row('source/folder').click();await row('source/folder/child').click();
  const child=await open('source/folder/child/note.md');await child.locator('#mode').click();
  await child.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('CHILD DRAFT');
  const childId=await tab('source/folder/child/note.md').getAttribute('data-tab');
  await drop('source/folder',row('destination'));await tab('destination/folder/child/note.md').waitFor();
  assert.equal(await tab('destination/folder/child/note.md').getAttribute('data-tab'),childId);assert((await child.locator('#editor').inputValue()).endsWith('CHILD DRAFT'));
  const before=await fs.readFile(path.join(ready.project,'source/collision.txt'),'utf8');
  await drop('source/collision.txt',row('destination'));await page.locator('#status').filter({hasText:'Could not move'}).waitFor();
  assert.equal(await fs.readFile(path.join(ready.project,'source/collision.txt'),'utf8'),before);assert.equal(await fs.readFile(path.join(ready.project,'destination/collision.txt'),'utf8'),'DESTINATION');
  await drop('source/collision.txt',row('destination'),{cancel:true});
  await start('destination/folder',row('destination/folder/child'));
  await page.locator('.workspace-drag-ghost[data-drop="invalid"]').waitFor();await page.mouse.up();
  assert.equal((await fs.stat(path.join(ready.project,'destination/folder'))).isDirectory(),true);
  // Capture the source version while dragging; replacing it before drop must fail.
  const lookup=gate();await page.route('**/api/fs-info?*',async route=>{
    if(new URL(route.request().url()).searchParams.get('path')!=='source/collision.txt')return route.continue();
    const response=await route.fetch();lookup.release();await route.fulfill({response});
  });
  await start('source/collision.txt',page.locator('#listLabel'));await lookup.promise;
  await fs.writeFile(path.join(ready.project,'source/collision.txt'),'REPLACED');await page.mouse.up();
  await page.locator('#status').filter({hasText:'Could not move'}).waitFor();
  assert.equal(await fs.readFile(path.join(ready.project,'source/collision.txt'),'utf8'),'REPLACED');
  await start('source/collision.txt',page.locator('#entries'));
  const box=await page.locator('#entries').boundingBox(),beforeScroll=await page.locator('#entries').evaluate(node=>node.scrollTop);
  await page.mouse.move(box.x+box.width-10,box.y+box.height-5,{steps:8});
  await page.waitForFunction(before=>document.querySelector('#entries').scrollTop>before+40,beforeScroll);
  await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await page.locator('.is-move-target,.is-drag-source').count(),0);
  console.log('PASS: physical file/folder moves, hover expansion, target/ghost feedback, root drop, drafts/identity/undo/save, collisions, cancellation, descendants and stale source');
}).catch(error=>{console.error(error);process.exitCode=1;});
