const { fixture, groupPoint, groupRect, dragTab, gate } = require('./workspace-test-helper.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
(async()=>fixture(async({ready,page,row,tab,frame,open,register,post,requests})=>{
  const names=['first.txt','deleted.txt','stale.txt','unmounted.txt','remapped.txt','removed-root.txt','removed-target.txt','newer-focus.txt','disconnected.txt'];
  for(const name of names)await fs.writeFile(ready.project+'/'+name,name+'\n');
  await register('other',ready.results);
  const ghost=page.locator('.workspace-drag-ghost'),marker=page.locator('#workspaceInsertion');
  const model=()=>page.evaluate(()=>JSON.stringify({layout:state.layout,groups:[...state.groups].map(([id,g])=>[id,g.active]),activeTab:state.activeTab,activeGroup:state.activeGroup,root:state.root,tabs:state.tabs.map(t=>[t.id,t.group])}));
  async function clean(){assert(await ghost.isHidden());assert(await marker.isHidden());assert(await page.locator('#workspaceDrop').isHidden());assert(await page.locator('#workspaceDragCover').isHidden());assert.equal(await page.locator('.is-drag-source').count(),0);assert(await page.evaluate(()=>!pointerTabDrag&&!tabDrag&&!dragGhost));assert(await page.evaluate(()=>![...document.querySelectorAll('*')].some(n=>n.hasPointerCapture?.(1))));}
  async function begin(file,target){await row(file).locator('.filename').scrollIntoViewIfNeeded();const r=await row(file).locator('.filename').boundingBox();await page.mouse.move(r.x+15,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+25,r.y+r.height/2,{steps:4});await page.mouse.move(target.x,target.y,{steps:14});await page.mouse.move(target.x+1,target.y+1);await page.mouse.move(target.x,target.y);assert(await ghost.isVisible(),'physical source starts '+file);}
  async function drop(file,target){await begin(file,target);await page.mouse.up();await clean();}
  await page.goto(ready.url);await row('first.txt').waitFor();
  const area=await page.locator('#viewer .preview').boundingBox(),emptyPoint={x:area.x+area.width/2,y:area.y+area.height/2};
  // The very first drag cannot rely on an existing visible workspace or group rect.
  const empty=await model(),before=requests.length;
  await begin('first.txt',emptyPoint);await page.keyboard.press('Escape');await page.mouse.up();await clean();
  assert.equal(await model(),empty);assert.equal(await page.locator('.file-tab,.workspace-slot iframe').count(),0);assert.equal(requests.slice(before).filter(r=>/\/(?:api\/entry|_preview)/.test(r.url)).length,0);
  await drop('first.txt',emptyPoint);await tab('first.txt').waitFor();assert.equal(await page.locator('.pane-tabs').count(),1);assert.equal(await page.locator('.workspace-slot.is-visible').count(),1);
  await tab('first.txt').locator('.tab-close').click();assert.equal(await page.locator('.file-tab,.workspace-slot iframe').count(),0);
  await drop('first.txt',emptyPoint);await tab('first.txt').waitFor();assert.equal(await page.locator('.pane-tabs').count(),1);
  console.log('PASS: empty workspace cancel, first drop and drop after closing all tabs');
  await open('same.txt');await open('sample.py');
  const editor=await frame('sample.py');await editor.locator('#editor:not([readonly])').waitFor();await editor.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText(' race draft');
  await page.evaluate(()=>{const t=state.tabs.find(t=>t.entry.path==='sample.py');window.identity={frame:t.frame,win:t.frame.contentWindow,doc:t.frame.contentDocument,editor:t.frame.contentDocument.querySelector('#editor'),session:t.frame.contentWindow.fbrowseEditor.session};});
  for(const kind of ['stale','deleted','remapped','removed-root','removed-target','disconnected','newer-focus']){
    const file=kind+'.txt';
    if(['remapped','removed-root','disconnected'].includes(kind)){
      await fs.writeFile(ready.results+'/'+file,'other removed root\n');await page.locator('#rootSelect').selectOption('other');await row('same.txt').and(page.locator('[data-root=other]')).waitFor();await page.locator('#refresh').click();await row(file).waitFor();
    }
    if(kind==='newer-focus')await tab('same.txt').locator('.tab-activate').click();
    if(kind==='removed-target'){await open('README.md');await dragTab(page,'README.md',groupPoint(page,'same.txt','right'));}
    const target=await groupPoint(page,kind==='removed-target'?'README.md':'same.txt')(),held=gate(),seen=gate();let entryResponse;
    const route=async route=>{const response=kind==='deleted'?null:await route.fetch();seen.release();await held.promise;
      if(kind==='stale'){const data=await response.json();data.entry.path='wrong-stale-path.txt';await route.fulfill({response,json:data});}
      else if(response)await route.fulfill({response});else await route.continue();
    };
    await page.route('**/api/entry?*',route);
    const entryDone=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/entry').catch(error=>({error}));
    await drop(file,target);await seen.promise;const initial=await model();
    assert.equal(await tab(file,['remapped','removed-root','disconnected'].includes(kind)?'other':'project').count(),0,'held lookup has no eager tab '+kind);
    if(kind==='deleted')await fs.unlink(ready.project+'/'+file);
    if(kind==='remapped')assert.equal((await post('api/roots',{operation:'edit',id:'other',name:'other',path:ready.papers})).status(),200);
    if(kind==='disconnected')await fs.rename(ready.results,ready.results+'-offline');
    if(kind==='removed-root')assert.equal((await post('api/roots',{operation:'remove',id:'other'})).status(),200);
    if(kind==='removed-target')await tab('README.md').locator('.tab-close').click();
    if(kind==='newer-focus')await tab('sample.py').locator('.tab-activate').click();
    const expected=await model();const infoDone=kind==='deleted'?null:page.waitForResponse(r=>new URL(r.url()).pathname==='/api/info');
    held.release();entryResponse=await entryDone;if(infoDone)await infoDone;
    if(kind==='deleted')await page.locator('#status').filter({hasText:/파일을 열 수 없습니다/}).waitFor();
    await page.waitForTimeout(100);await page.unroute('**/api/entry?*',route);await clean();
    if(kind==='newer-focus'){
      await tab(file).waitFor();const activeId=await tab('sample.py').getAttribute('data-tab');
      assert.equal(await page.evaluate(()=>state.activeTab),activeId,'newer global tab preserved');
      assert.equal(await page.evaluate(id=>state.groups.get(state.tabs.find(t=>t.id===id).group).active,activeId),activeId,'newer group active tab preserved');
      assert.equal(await tab('sample.py').getAttribute('aria-selected'),'true');assert(await page.locator('.workspace-slot.is-visible iframe[data-tab='+JSON.stringify(activeId)+']').isVisible(),'newer tab remains visibly selected');
    }else{assert.equal(await tab(file,['remapped','removed-root','disconnected'].includes(kind)?'other':'project').count(),0,'race rejected '+kind);assert.equal(await model(),expected,'no wrong tab/phantom group '+kind);}
    if(kind==='remapped'){assert.equal((await post('api/roots',{operation:'edit',id:'other',name:'other',path:ready.results})).status(),200);await page.locator('#rootSelect').selectOption('project');await row('same.txt').and(page.locator('[data-root=project]')).waitFor();}
    if(kind==='disconnected'){await fs.rename(ready.results+'-offline',ready.results);await page.locator('#rootSelect').selectOption('project');await row('same.txt').and(page.locator('[data-root=project]')).waitFor();}
    if(kind==='removed-root'){await register('other',ready.results);await page.locator('#rootSelect').selectOption('project');await row('same.txt').and(page.locator('[data-root=project]')).waitFor();}
    console.log('PASS: held entry drop '+kind+' HTTP '+entryResponse.status());
  }
  // Removing a captured source node reproduces a tree refresh/unmount; no app function creates the result.
  const prior=await model();await begin('unmounted.txt',await groupPoint(page,'same.txt','right')());
  await row('unmounted.txt').evaluate(n=>n.remove());await page.mouse.move(1000,500);await page.mouse.up();await clean();assert.equal(await model(),prior,'unmounted source cancels without allocation');
  assert(await page.evaluate(()=>{const t=state.tabs.find(t=>t.entry.path==='sample.py'),r=identity;return t.frame===r.frame&&t.frame.contentWindow===r.win&&t.frame.contentDocument===r.doc&&t.frame.contentDocument.querySelector('#editor')===r.editor&&t.frame.contentWindow.fbrowseEditor.session===r.session;}));
  assert((await editor.locator('#editor').inputValue()).endsWith(' race draft'));
  assert.equal(requests.filter(r=>r.method==='POST'&&/\/api\/(?:fs|editor\/save)/.test(new URL(r.url).pathname)).length,0);
  await page.screenshot({path:'/tmp/fbrowse-drag-races-0.9.1.png',fullPage:true});
  console.log('PASS: stale/deleted/unmounted/remapped/removed-root/removed-target rejection, latest visible focus and exact draft frame identity');
}))().catch(error=>{console.error(error);process.exitCode=1;});
