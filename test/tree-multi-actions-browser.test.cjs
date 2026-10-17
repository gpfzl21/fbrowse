const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {fixture,gate}=require('./workspace-test-helper.cjs');
fixture(async({ready,page,row,tab,open,post,register,requests})=>{
  await fs.mkdir(path.join(ready.project,'multi/folder/child'),{recursive:true});await fs.mkdir(path.join(ready.project,'destination'));
  for(const name of ['a.txt','b.txt','collision.txt','stale.txt','unknown.txt','later.txt'])await fs.writeFile(path.join(ready.project,'multi',name),'BASE '+name+'\n');
  await fs.writeFile(path.join(ready.project,'multi/folder/child/note.txt'),'CHILD\n');await fs.writeFile(path.join(ready.project,'destination/collision.txt'),'KEEP');
  await fs.mkdir(path.join(ready.project,'partial-tree'));await fs.writeFile(path.join(ready.project,'partial-tree/keep.txt'),'KEEP PARTIAL');await fs.writeFile(path.join(ready.project,'partial-tree/removed.txt'),'REMOVE');
  await page.goto(ready.url);await row('multi').click();await row('multi/folder').click();await row('multi/folder/child').click();
  const a=await open('multi/a.txt');await a.locator('#editor:not([readonly])').waitFor();
  await a.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('A DRAFT');
  const child=await open('multi/folder/child/note.txt');await child.locator('#editor:not([readonly])').waitFor();
  await child.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('CHILD DRAFT');
  await child.locator('#editor').evaluate(n=>n.setSelectionRange(1,3));
  await page.evaluate(()=>{window.multiIdentity=state.tabs.map(tab=>({tab,frame:tab.frame,doc:tab.frame.contentDocument,editor:tab.frame.contentDocument.querySelector('#editor'),start:tab.frame.contentDocument.querySelector('#editor').selectionStart,end:tab.frame.contentDocument.querySelector('#editor').selectionEnd}));});
  const choose=async paths=>{await page.locator('#entries').focus();await page.keyboard.press('Escape');for(const name of paths)await row(name).click({modifiers:['Control']});};
  const mutations=()=>requests.filter(r=>r.method==='POST'&&new URL(r.url).pathname==='/api/fs').length;
  async function start(source,destination='destination'){
    await row(source).scrollIntoViewIfNeeded();await row(destination).scrollIntoViewIfNeeded();const x=await row(source).locator('.filename').boundingBox(),y=await row(destination).boundingBox();
    await page.mouse.move(x.x+10,x.y+x.height/2);await page.mouse.down();await page.mouse.move(x.x+20,x.y+x.height/2+2,{steps:4});await page.mouse.move(y.x+y.width/2,y.y+y.height/2,{steps:10});await page.locator('.workspace-drag-ghost').waitFor();
  }
  async function drop(source){await start(source);await page.mouse.up();await page.waitForFunction(()=>!fsOperation);}
  const chosen=['multi/a.txt','multi/folder','multi/folder/child','multi/folder/child/note.txt'];await choose(chosen);
  let count=mutations();await start('multi/folder/child/note.txt');assert.match(await page.locator('.drag-name').textContent(),/2개/);await page.mouse.up();await tab('destination/a.txt').waitFor();await page.waitForFunction(()=>!fsOperation);
  assert.equal(mutations(),count+2,'parent/child overlap collapses to one target');await tab('destination/folder/child/note.txt').waitFor();
  assert(await page.evaluate(()=>multiIdentity.every(x=>x.tab.frame===x.frame&&x.frame.contentDocument===x.doc&&x.doc.querySelector('#editor')===x.editor&&x.editor.selectionStart===x.start&&x.editor.selectionEnd===x.end)),'all editor nodes and selections survive');
  assert.equal(await a.locator('#editor').inputValue(),'BASE a.txt\nA DRAFT');assert.equal(await child.locator('#editor').inputValue(),'CHILD\nCHILD DRAFT');
  await child.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.press('Control+z');assert.equal(await child.locator('#editor').inputValue(),'CHILD\n');await page.keyboard.press('Control+Shift+z');await page.keyboard.press('Control+s');
  await page.waitForFunction(()=>!state.tabs.find(t=>t.entry.path==='destination/folder/child/note.txt').frame.contentWindow.fbrowseEditor.dirty);
  assert.equal(await fs.readFile(path.join(ready.project,'destination/folder/child/note.txt'),'utf8'),'CHILD\nCHILD DRAFT');
  // A known collision is reported per path while an independent target can succeed.
  await choose(['multi/b.txt','multi/collision.txt']);count=mutations();await drop('multi/b.txt');assert.equal(mutations(),count+2);
  assert.equal(await fs.readFile(path.join(ready.project,'destination/b.txt'),'utf8'),'BASE b.txt\n');assert.equal(await fs.readFile(path.join(ready.project,'destination/collision.txt'),'utf8'),'KEEP');
  assert.match(await page.locator('#fsMessage').textContent(),/1개 완료, 1개 실패/);await page.locator('#fsCancel').click();
  // Pin both source versions at gesture start, then externally replace one.
  const looked=gate();await page.route('**/api/fs-info?*',async route=>{const response=await route.fetch();if(new URL(route.request().url()).searchParams.get('path')==='multi/stale.txt')looked.release();await route.fulfill({response});});
  await choose(['multi/collision.txt','multi/stale.txt']);await start('multi/stale.txt');await looked.promise;await fs.writeFile(path.join(ready.project,'multi/stale.txt'),'REPLACED');await page.mouse.up();await page.waitForFunction(()=>!fsOperation);await page.unroute('**/api/fs-info?*');
  assert.equal(await fs.readFile(path.join(ready.project,'multi/stale.txt'),'utf8'),'REPLACED');assert.match(await page.locator('#fsMessage').textContent(),/0개 완료, 2개 실패/);await page.locator('#fsCancel').click();
  // One confirmation, all affected dirty paths, cancellation causes no mutation.
  await choose(['destination/a.txt','destination/folder','destination/folder/child/note.txt']);
  await row('destination/a.txt').click({button:'right'});await page.locator('#contextDelete').click();await page.waitForFunction(()=>!document.querySelector('#fsSubmit').disabled);
  assert.match(await page.locator('#fsTarget').textContent(),/2개/);assert.match(await page.locator('#fsDescription').textContent(),/destination\/a.txt/);assert.match(await page.locator('#fsDescription').textContent(),/Unsaved changes in 1/);
  count=mutations();await page.locator('#fsCancel').click();assert.equal(mutations(),count);
  // A selected root registration is immutable even if changed after confirmation.
  await register('mutable',ready.results);await page.locator('#manageRoots').click();await page.locator('#closeRoots').click();await fs.writeFile(path.join(ready.results,'delete-a.txt'),'A');await fs.writeFile(path.join(ready.results,'delete-b.txt'),'B');
  await page.locator('#rootSelect').selectOption('mutable');await row('delete-a.txt').waitFor();await choose(['delete-a.txt','delete-b.txt']);await page.locator('#entries').focus();await page.keyboard.press('Delete');await page.waitForFunction(()=>!document.querySelector('#fsSubmit').disabled);
  const changed=await post('api/roots',{operation:'edit',id:'mutable',name:'mutable',path:ready.project});assert.equal(changed.status(),200);
  count=mutations();await page.locator('#fsSubmit').click();await page.waitForFunction(()=>!fsOperation);assert.equal(mutations(),count,'preflight mapping drift sends no mutations');assert.match(await page.locator('#fsMessage').textContent(),/루트/);await page.locator('#fsCancel').click();
  assert.equal(await fs.readFile(path.join(ready.results,'delete-a.txt'),'utf8'),'A');
  await page.locator('#rootSelect').selectOption('project');await row('destination').waitFor();
  await choose(['destination/a.txt','destination/folder','destination/folder/child/note.txt']);await page.locator('#entries').focus();await page.keyboard.press('Delete');await page.waitForFunction(()=>!document.querySelector('#fsSubmit').disabled);
  const deleting=gate(),finishDelete=gate();await page.route('**/api/fs',async route=>{const response=await route.fetch();if(route.request().postDataJSON().path==='destination/folder'){deleting.release();await finishDelete.promise;}await route.fulfill({response});});
  count=mutations();await page.locator('#fsSubmit').click();await deleting.promise;assert.equal(await page.locator('#fsCancel').textContent(),'Hide progress');await page.locator('#fsCancel').click();assert(await page.locator('#fsProgress').isVisible());finishDelete.release();await page.waitForFunction(()=>!fsOperation);await page.unroute('**/api/fs');assert.equal(mutations(),count+2);assert(await page.locator('#fsDialog').isHidden());assert(await page.locator('#fsProgress').isHidden());
  await assert.rejects(fs.stat(path.join(ready.project,'destination/folder')),{code:'ENOENT'});assert.equal(await tab('destination/a.txt').count(),0);assert.equal(await tab('destination/folder/child/note.txt').count(),0);
  // Known deletion failure keeps that editor; an independent confirmed target succeeds.
  const keeper=await open('sample.py');await keeper.locator('#editor:not([readonly])').waitFor();const baseline=await keeper.locator('#editor').inputValue();
  await keeper.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('KEEPER DRAFT');const keeperDraft=await keeper.locator('#editor').inputValue();
  const staleEditor=await open('multi/stale.txt');await staleEditor.locator('#editor:not([readonly])').waitFor();await staleEditor.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('STALE DRAFT');
  await choose(['multi/collision.txt','multi/stale.txt']);await page.locator('#entries').focus();await page.keyboard.press('Delete');await page.waitForFunction(()=>!document.querySelector('#fsSubmit').disabled);
  await fs.writeFile(path.join(ready.project,'multi/stale.txt'),'AFTER CONFIRM');count=mutations();await page.locator('#fsSubmit').click();await page.waitForFunction(()=>!fsOperation);assert.equal(mutations(),count+2);
  assert.match(await page.locator('#fsMessage').textContent(),/1개 완료, 1개 실패/);assert.equal(await staleEditor.locator('#editor').inputValue(),'REPLACEDSTALE DRAFT');assert.equal(await tab('multi/stale.txt').count(),1);await page.locator('#fsCancel').click();
  // Exercise the structured partial-delete response after deleting a real child.
  await row('partial-tree').click();const partial=await open('partial-tree/keep.txt');await partial.locator('#editor:not([readonly])').waitFor();await partial.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText(' PARTIAL DRAFT');
  await choose(['partial-tree','multi/later.txt']);await page.locator('#entries').focus();await page.keyboard.press('Delete');await page.waitForFunction(()=>!document.querySelector('#fsSubmit').disabled);
  await page.route('**/api/fs',async route=>{
    assert.equal(route.request().postDataJSON().path,'partial-tree');
    const version=await (await page.request.get(ready.url+'api/fs-info?root=project&path=partial-tree/removed.txt')).json();
    assert.equal((await post('api/fs',{action:'delete',root:'project',root_path:ready.project,path:'partial-tree/removed.txt',expected_version:version.version,confirmed:true})).status(),200);
    await route.fulfill({status:500,json:{error:'Deletion stopped after removing 1 entries',partial:true}});
  });count=mutations();await page.locator('#fsSubmit').click();await page.waitForFunction(()=>!fsOperation);await page.unroute('**/api/fs');assert.equal(mutations(),count+1);
  assert.match(await page.locator('#fsMessage').textContent(),/처리하지 않음/);assert.equal(await partial.locator('#editor').inputValue(),'KEEP PARTIAL PARTIAL DRAFT');assert(await partial.locator('#save').isDisabled());assert.equal(await tab('partial-tree/keep.txt').count(),1);
  assert.equal(await fs.readFile(path.join(ready.project,'multi/later.txt'),'utf8'),'BASE later.txt\n');assert.equal(await keeper.locator('#editor').inputValue(),keeperDraft);await page.locator('#fsCancel').click();
  await tab('sample.py').locator('.tab-activate').click();await keeper.locator('#editor').focus();await page.keyboard.press('Control+z');assert.equal(await keeper.locator('#editor').inputValue(),baseline,'unaffected draft native undo survives partial batch deletion');
  // Lost POST response: stop the remaining targets, preserve drafts, never retry.
  await choose(['multi/unknown.txt','multi/later.txt']);
  await page.route('**/api/fs',async route=>{await route.fetch();await route.abort();});count=mutations();await drop('multi/unknown.txt');await page.unroute('**/api/fs');
  assert.equal(mutations(),count+1);assert.match(await page.locator('#fsMessage').textContent(),/변경되었을 수/);assert.match(await page.locator('#fsMessage').textContent(),/처리하지 않음/);assert.equal(await fs.readFile(path.join(ready.project,'multi/later.txt'),'utf8'),'BASE later.txt\n');await page.locator('#fsCancel').click();
  console.log('PASS: physical group drag, parent overlap, iframe/draft/selection/undo/new-path save, per-path collision/stale results, one bulk confirmation/cancel, pinned root drift and lost-response stop without retry');
}).catch(error=>{console.error(error);process.exitCode=1;});
