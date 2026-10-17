// Real pointer/keyboard input; all files belong to a disposable server fixture.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {fixture}=require('./workspace-test-helper.cjs');
fixture(async({ready,page,row,open,requests})=>{
  await fs.mkdir(path.join(ready.project,'multi/nested'),{recursive:true});
  for(const name of ['a.txt','b.txt','c.txt','d.txt'])await fs.writeFile(path.join(ready.project,'multi',name),'BASE');
  await fs.writeFile(path.join(ready.project,'multi/nested/child.txt'),'CHILD');
  await fs.mkdir(path.join(ready.project,'large-selection'));
  await Promise.all(Array.from({length:1600},(_,i)=>fs.writeFile(path.join(ready.project,'large-selection',String(i).padStart(4,'0')+'.txt'),'x')));
  await page.goto(ready.url);await row('multi').click();await row('multi/nested').click();
  const selected=()=>page.locator('#entries .row[data-tree-selected="true"]').evaluateAll(nodes=>nodes.map(n=>n.dataset.path));
  const expect=async paths=>assert.deepEqual(await selected(),paths);
  await row('multi/a.txt').click();
  const tabs=await page.locator('.file-tab').count();
  await row('multi/c.txt').click({modifiers:['Control']});await expect(['multi/a.txt','multi/c.txt']);
  await row('multi/a.txt').click({modifiers:['Control']});await expect(['multi/c.txt']);
  await row('multi/b.txt').click({modifiers:['Meta']});await expect(['multi/b.txt','multi/c.txt']);
  assert.equal(await page.locator('.file-tab').count(),tabs,'modifier clicks do not open files');
  assert.equal(await page.locator('.workspace-drag-ghost').count(),0);
  await row('multi/nested').click({modifiers:['Control']});
  await row('multi/b.txt').click({modifiers:['Shift']});
  await expect(['multi/nested','multi/nested/child.txt','multi/a.txt','multi/b.txt']);
  await row('multi/d.txt').click({modifiers:['Control','Shift']});
  await expect(['multi/nested','multi/nested/child.txt','multi/a.txt','multi/b.txt','multi/c.txt','multi/d.txt']);
  assert.equal(await page.locator('#selectionCount').textContent(),'6개 선택');
  assert.equal(await row('multi/a.txt').getAttribute('aria-pressed'),'true');
  await row('multi/b.txt').click({button:'right'});await expect(['multi/nested','multi/nested/child.txt','multi/a.txt','multi/b.txt','multi/c.txt','multi/d.txt']);
  assert.match(await page.locator('#contextDelete').textContent(),/6/);assert(await page.locator('#contextRename').isDisabled());
  await page.keyboard.press('Escape');await expect(['multi/nested','multi/nested/child.txt','multi/a.txt','multi/b.txt','multi/c.txt','multi/d.txt']);
  await row('multi/c.txt').click({button:'right'});await page.keyboard.press('Escape');
  await row('same.txt').click({button:'right'});await expect(['same.txt']);await page.keyboard.press('Escape');
  await page.locator('#clearSelection').click();await expect([]);
  // A collapsed child cannot remain an actionable hidden target.
  await row('multi/a.txt').click({modifiers:['Control']});await row('multi').click();await expect(['multi']);
  await row('multi').click();await expect(['multi']);
  await row('multi/a.txt').click({modifiers:['Control']});
  await page.locator('#search').fill('sample.py');await row('sample.py').waitFor();await expect([]);
  await page.locator('#search').focus();await page.keyboard.press('Control+a');assert.equal(await page.locator('#search').inputValue(),'sample.py');await expect([]);
  await page.locator('#search').fill('');await row('multi/a.txt').waitFor();
  // Selection and shortcuts never enter an editor's document or undo history.
  const editor=await open('sample.py');await editor.locator('#editor:not([readonly])').waitFor();
  const original=await editor.locator('#editor').inputValue();await editor.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('\nNATIVE UNDO');
  const posts=()=>requests.filter(r=>r.method==='POST'&&new URL(r.url).pathname==='/api/fs').length;
  await editor.locator('#editor').focus();await page.keyboard.press('Control+a');await page.keyboard.press('Delete');assert.equal(posts(),0);
  await page.keyboard.press('Control+z');await page.keyboard.press('Control+z');assert.equal(await editor.locator('#editor').inputValue(),original);
  await row('multi/a.txt').click({modifiers:['Control']});await row('multi/d.txt').click({modifiers:['Shift']});
  await editor.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('UNDO AFTER SELECTION');await page.keyboard.press('Control+z');assert.equal(await editor.locator('#editor').inputValue(),original);
  // Marquee begins in the 5px tree gutter; cached content coordinates survive scroll.
  await page.locator('#clearSelection').click();await page.locator('#entries').evaluate(n=>n.scrollTop=0);
  const a=await row('multi/a.txt').boundingBox(),d=await row('multi/d.txt').boundingBox(),box=await page.locator('#entries').boundingBox();
  const start=async(y,x=box.x+2)=>{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+12,y+2,{steps:3});};
  await start(a.y+2);await page.mouse.move(box.x+box.width-15,d.y+d.height-2,{steps:12});
  await page.waitForFunction(()=>document.querySelector('.tree-marquee'));await page.mouse.up();await expect(['multi/a.txt','multi/b.txt','multi/c.txt','multi/d.txt']);
  assert.equal(await page.locator('.tree-marquee').count(),0);
  const before=await selected();await start(a.y+2);await page.mouse.move(box.x+60,a.y+a.height,{steps:5});await page.keyboard.press('Escape');await page.mouse.up();await expect(before);
  for(const cancel of ['pointercancel','blur']){
    await start(a.y+2);await page.mouse.move(box.x+70,a.y+20,{steps:4});
    await page.locator('.tree-marquee').waitFor();
    if(cancel==='blur')await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    else await page.locator('#entries').dispatchEvent('pointercancel',{pointerId:1,bubbles:true});
    await page.mouse.up();await expect(before);assert.equal(await page.locator('.tree-marquee').count(),0);
  }
  await page.locator('#clearSelection').click();await row('multi/a.txt').click({modifiers:['Control']});
  await page.keyboard.down('Control');await start(d.y+2);await page.mouse.move(box.x+100,d.y+d.height-2,{steps:8});await page.mouse.up();await page.keyboard.up('Control');await expect(['multi/a.txt','multi/d.txt']);
  await page.locator('#clearSelection').click();await row('large-selection').click();await row('large-selection/0000.txt').waitFor();
  await page.locator('#entries').evaluate(n=>n.scrollTop=0);
  // Count layout reads and network activity during 100 physical pointer updates.
  await page.evaluate(()=>{window.layoutReads=0;window.originalRect=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){if(this.matches?.('#entries .row'))window.layoutReads++;return originalRect.call(this);};});
  const largeBox=await page.locator('#entries').boundingBox(),first=await row('large-selection/0000.txt').boundingBox();
  const network=requests.length;await page.mouse.move(largeBox.x+2,first.y+2);await page.mouse.down();await page.mouse.move(largeBox.x+90,largeBox.y+largeBox.height-4,{steps:100});
  await page.waitForFunction(()=>document.querySelector('#entries').scrollTop>100);await page.mouse.up();
  const reads=await page.evaluate(()=>{Element.prototype.getBoundingClientRect=originalRect;return layoutReads;});
  assert(reads<1700,'one geometry snapshot, no row layout reads per pointer update: '+reads);
  assert.equal(requests.length,network,'marquee has no network requests');assert((await selected()).length>10);
  await page.locator('#entries').focus();await page.keyboard.press('Control+a');assert((await selected()).length>=1600);
  await page.keyboard.press('Escape');await row('large-selection/0000.txt').click({modifiers:['Control']});await row('large-selection/1599.txt').click({modifiers:['Shift']});
  await page.keyboard.press('Delete');assert.match(await page.locator('#status').textContent(),/100/);assert.equal(posts(),0,'bounded delete refuses excessive targets before mutation');
  await page.keyboard.press('Escape');await expect([]);
  console.log('PASS: Ctrl/Meta toggles, flattened Shift/additive ranges, context/count/accessibility, filtering, native editor undo, marquee/add/scroll/cancel and 1600-row cached geometry without network');
}).catch(error=>{console.error(error);process.exitCode=1;});
