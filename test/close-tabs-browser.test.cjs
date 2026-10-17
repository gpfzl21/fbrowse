// Exercise bulk closure through the real menu with disposable files only.
const assert=require('node:assert/strict');
const {fixture,dragTab,groupPoint,gate}=require('./workspace-test-helper.cjs');
(async()=>fixture(async({page,ready,open,tab,frame,register,errors})=>{
  await register('other',ready.results);await page.goto(ready.url);
  const originals={},drafts={};
  async function edit(file){
    const f=await open(file);
    if(file.endsWith('.md'))await f.locator('#mode').click();
    await f.locator('#editor:not([readonly])').waitFor();
    originals[file]=await f.locator('#editor').inputValue();
    await f.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('\nDRAFT '+file);
    drafts[file]=await f.locator('#editor').inputValue();return f;
  }
  const code=await edit('sample.py'),md=await edit('README.md'),keep=await edit('same.txt');await open('page.html');
  await dragTab(page,'sample.py',groupPoint(page,'page.html','right'));
  await dragTab(page,'README.md',groupPoint(page,'sample.py','bottom'));
  await tab('page.html').locator('.tab-activate').click();
  assert.equal(await page.locator('.pane-tabs').count(),3);
  const model=()=>page.evaluate(()=>JSON.stringify({tabs:state.tabs.map(t=>[t.id,t.group,t.editor]),layout:state.layout,
    groups:[...state.groups].map(([id,g])=>[id,g.active]),active:state.activeTab,group:state.activeGroup,selected:state.selected,
    root:state.root,revision:state.workspaceRevision,url:location.href,expanded:state.previewExpanded}));
  await page.evaluate(()=>{window.identities=state.tabs.map(t=>({frame:t.frame,doc:t.frame.contentDocument,editor:t.frame.contentDocument.querySelector('#editor'),session:t.frame.contentWindow.fbrowseEditor?.session}));});
  const identities=()=>page.evaluate(()=>identities.every(i=>i.frame.isConnected&&i.frame.contentDocument===i.doc&&i.doc.querySelector('#editor')===i.editor&&i.frame.contentWindow.fbrowseEditor?.session===i.session));
  const menu=async(file,label)=>{await tab(file).locator('.tab-activate').click({button:'right'});return page.getByRole('menuitem',{name:label,exact:true});};
  const others='Close Other Tabs (All Groups)',all='Close All Tabs (All Groups)';
  for(const label of [others,all]){
    const before=await model(),button=await menu('same.txt',label);
    assert.equal(await model(),before,'opening an inactive tab menu does not activate it');
    let dialogs=0;
    const dismiss=dialog=>{dialogs++;assert(dialog.message().includes(label===others?'2 files':'3 files'));dialog.dismiss();};page.on('dialog',dismiss);
    await button.click();page.off('dialog',dismiss);
    assert.equal(dialogs,1,'one whole-set confirmation');assert.equal(await model(),before,'cancel is atomic');assert(await identities());
    for(const file of Object.keys(drafts))assert.equal(await (await frame(file)).locator('#editor').inputValue(),drafts[file]);
  }
  await code.locator('#editor').focus();await page.keyboard.press('Control+z');assert.equal(await code.locator('#editor').inputValue(),originals['sample.py'],'cancel retains undo');
  await page.keyboard.press('Control+Shift+z');assert.equal(await code.locator('#editor').inputValue(),drafts['sample.py']);
  // An actual in-flight save protects the entire target set, without partial closure.
  const entered=gate(),release=gate();
  await page.route('**/api/save',async route=>{entered.release();await release.promise;await route.continue();});
  await code.locator('#save').click();await entered.promise;
  let before=await model();assert(await (await menu('same.txt',others)).isDisabled());assert(await page.getByRole('menuitem',{name:all,exact:true}).isDisabled());
  assert.equal(await model(),before);await page.keyboard.press('Escape');
  // The busy tab can itself be kept; only closing targets are guarded.
  assert(await (await menu('sample.py',others)).isEnabled());await page.keyboard.press('Escape');
  release.release();await code.locator('#notice').filter({hasText:'Saved.'}).waitFor();await page.unroute('**/api/save');
  // Model the filesystem lock too, including a lock acquired after opening the menu.
  const button=await menu('same.txt',others);before=await model();
  await page.evaluate(()=>state.tabs.find(t=>t.entry.path==='README.md').fsBusy=true);
  await button.click();assert.equal(await model(),before);assert(await identities());
  assert(await (await menu('same.txt',others)).isDisabled());await page.keyboard.press('Escape');
  await page.evaluate(()=>state.tabs.find(t=>t.entry.path==='README.md').fsBusy=false);
  // Keep a background tab in another group, including its draft and undo stack.
  await tab('page.html').locator('.tab-activate').click();
  await page.evaluate(()=>{const t=state.tabs.find(t=>t.entry.path==='same.txt');window.retained={frame:t.frame,doc:t.frame.contentDocument,session:t.frame.contentWindow.fbrowseEditor.session};});
  const accept=dialog=>dialog.accept();page.on('dialog',accept);
  await (await menu('same.txt',others)).click();page.off('dialog',accept);
  assert.equal(await page.locator('.file-tab').count(),1);assert.equal(await page.locator('.pane-tabs').count(),1);assert.equal(await page.locator('.workspace-separator').count(),0);
  assert.equal(await page.evaluate(()=>state.tabs[0].id===state.activeTab&&state.tabs[0].frame===retained.frame&&retained.frame.contentDocument===retained.doc&&retained.frame.contentWindow.fbrowseEditor.session===retained.session),true);
  assert.equal(await keep.locator('#editor').inputValue(),drafts['same.txt']);
  await keep.locator('#editor').focus();await page.keyboard.press('Control+z');assert.equal(await keep.locator('#editor').inputValue(),originals['same.txt'],'retained tab keeps undo');
  await page.keyboard.press('Control+Shift+z');
  assert(await (await menu('same.txt',others)).isDisabled());await page.keyboard.press('Escape');
  // The scope also includes other registered roots; a dirty kept tab needs no confirmation.
  await open('README.md');await page.locator('#rootSelect').selectOption('other');
  await open('same.txt');assert.equal(await page.locator('.file-tab').count(),3);
  const unexpected=dialog=>{dialog.dismiss();throw Error('Kept draft must not be discarded or confirmed');};page.on('dialog',unexpected);
  await (await menu('same.txt',others)).click();page.off('dialog',unexpected);
  assert.equal(await page.locator('.file-tab').count(),1);assert.equal(await page.locator('#rootSelect').inputValue(),'project');assert.equal(await keep.locator('#editor').inputValue(),drafts['same.txt']);
  await open('README.md');await dragTab(page,'README.md',groupPoint(page,'same.txt','right'));
  // All closes every split, confirms once, removes contexts, and leaves a usable empty workspace.
  let dialogs=0;const acceptAll=dialog=>{dialogs++;dialog.accept();};page.on('dialog',acceptAll);
  await (await menu('README.md',all)).click();page.off('dialog',acceptAll);assert.equal(dialogs,1);
  assert.equal(await page.locator('.file-tab,.workspace-slot,.workspace-separator').count(),0);assert(await page.locator('#empty').isVisible());assert(await page.locator('#workspace').isHidden());
  assert.deepEqual(await page.evaluate(()=>({active:state.activeTab,selected:state.selected,editor:state.editor,groups:state.groups.size,path:new URL(location.href).searchParams.get('path')})),{active:null,selected:null,editor:null,groups:1,path:null});
  assert.equal(await page.evaluate(()=>retained.frame.isConnected),false);
  await open('sample.py');assert.equal(await page.locator('.file-tab').count(),1);assert.equal(await page.locator('.pane-tabs').count(),1);assert(await page.locator('#workspace').isVisible());
  assert.deepEqual(errors,[]);
  console.log('PASS: all-split atomic close/cancel, inactive keep, drafts/undo/frame retention, save/fs locks, empty workspace and reopen');
}))().catch(error=>{console.error(error);process.exitCode=1;});
