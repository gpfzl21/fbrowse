// Physical Chromium gestures only construct drag results; all roots and race mutations are disposable.
const { fixture, groupRect, groupPoint, dragTab, gate } = require('./workspace-test-helper.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

(async () => fixture(async ({ ready, page, browser, post, register, row, tab, frame, open, requests }) => {
  const fixtures = ['left.txt','right.txt','top.txt','bottom.txt','six.txt','center.txt','insert.txt','cancel.txt','deleted.txt','unmounted.txt','remapped.txt','removed-root.txt','removed-target.txt'];
  for (const name of fixtures) await fs.writeFile(path.join(ready.project,name),name+'\n');
  for (let i=0;i<12;i++) await fs.writeFile(path.join(ready.project,'overflow-'+String(i).padStart(2,'0')+'-long-name.txt'),'overflow '+i+'\n');
  await fs.writeFile(path.join(ready.project,'outside-target.txt'),'temporary target\n');
  await fs.symlink('../papers/same.txt',path.join(ready.project,'outside-link.txt'));
  await register('other',ready.results);
  await page.goto(ready.url); await row('same.txt').waitFor();
  const originals = new Map();
  for (const root of [ready.project,ready.results]) for (const name of ['same.txt','sample.py',...fixtures.filter(()=>root===ready.project)]) {
    const data=await fs.readFile(path.join(root,name)); originals.set(path.join(root,name),createHash('sha256').update(data).digest('hex'));
  }
  const model=()=>page.evaluate(()=>JSON.stringify({layout:state.layout,groups:[...state.groups].map(([id,g])=>[id,g.active]),activeGroup:state.activeGroup,activeTab:state.activeTab,root:state.root,tabs:state.tabs.map(t=>[t.id,t.entry.root_id,t.entry.path,t.group])}));
  const ghost=page.locator('.workspace-drag-ghost'), marker=page.locator('#workspaceInsertion'), drop=page.locator('#workspaceDrop');
  const order=group=>page.locator('.pane-tabs[data-group='+JSON.stringify(group)+'] .file-tab').evaluateAll(ns=>ns.map(n=>n.dataset.tab));
  async function clean(label) {
    assert(await ghost.isHidden(),label+' ghost cleared'); assert(await marker.isHidden(),label+' insertion cleared');
    assert(await drop.isHidden(),label+' preview cleared'); assert(await page.locator('#workspaceDragCover').isHidden(),label+' cover cleared');
    assert.equal(await page.locator('.is-drag-source,[data-drag-source="true"]').count(),0,label+' source feedback cleared');
    assert.equal(await marker.getAttribute('data-group'),null,label+' target references cleared');assert.equal(await marker.getAttribute('data-before'),null,label+' before reference cleared');
    assert(await page.evaluate(()=>!pointerTabDrag&&!tabDrag),label+' drag references released');
    assert(await page.evaluate(()=>![...document.querySelectorAll('*')].some(n=>n.hasPointerCapture?.(1))),label+' pointer capture released');
  }
  async function move(x,y) { await page.mouse.move(x,y,{steps:12}); await page.mouse.move(x+1,y+1); await page.mouse.move(x,y); }
  async function ghostAt(point,source,file,root='project') {
    assert(await ghost.isVisible(),'ghost visible '+file); assert.equal(await ghost.getAttribute('data-source'),source);
    assert((await ghost.textContent()).includes(file),'ghost identifies path '+file);
    const r=await ghost.boundingBox(); assert(r.width>15&&r.height>10,'visible ghost geometry');
    const viewport=page.viewportSize(),expected={x:Math.max(0,Math.min(viewport.width-r.width-4,point.x+16)),y:Math.max(0,Math.min(viewport.height-r.height-4,point.y+18))};
    assert(Math.abs(r.x-expected.x)<2&&Math.abs(r.y-expected.y)<2,'ghost follows actual pointer with viewport clamping '+JSON.stringify({r,point,expected}));
    const text=await ghost.textContent(); assert(text.includes(root==='project'?'Project':root)||text.includes(root),'ghost identifies source root '+text);
  }
  async function start(locator,point,{source='tree',file,root='project'}={}) {
    await locator.scrollIntoViewIfNeeded(); const r=await locator.boundingBox(); const x=r.x+Math.min(25,r.width/2),y=r.y+r.height/2;
    await page.mouse.move(x,y); await page.mouse.down();
    await page.mouse.move(x+3,y+1); assert(await ghost.isHidden(),'below threshold no ghost'); assert(await drop.isHidden(),'below threshold no preview');
    await page.mouse.move(x+12,y+3,{steps:4}); await move(point.x,point.y); await ghostAt(point,source,file,root);assert.equal(await page.locator('.is-drag-source').count(),1,'source dimming feedback visible');
  }
  async function dragTree(file,point,{part='.filename',root='project',inspect,cancel}={}) {
    const before=await page.locator('.file-tab').count(),loads=requests.filter(r=>/\/(?:_preview|roots\/[^/]+\/files\/)/.test(r.url)).length;
    point=typeof point==='function'?await point():point;
    await start(row(file).locator(part),point,{file,root});
    assert.equal(await page.locator('.file-tab').count(),before,'tree drag starts without new tab');
    assert.equal(requests.filter(r=>/\/(?:_preview|roots\/[^/]+\/files\/)/.test(r.url)).length,loads,'tree drag starts without preview load');
    if(inspect)await inspect(point);
    if(cancel==='Escape')await page.keyboard.press('Escape');
    if(cancel==='outside')await move(4,4);
    if(cancel==='pointercancel')await page.locator('body').dispatchEvent('pointercancel',{pointerId:1,pointerType:'mouse',bubbles:true});
    if(cancel==='lostcapture')await row(file).evaluate(n=>{if(n.hasPointerCapture(1))n.releasePointerCapture(1);});
    if(cancel==='blur')await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    await page.mouse.up(); await clean('tree '+file+' '+(cancel||'drop'));
    if(cancel){assert.equal(await page.locator('.file-tab').count(),before,'cancel adds no tabs');assert.equal(requests.filter(r=>/\/(?:_preview|roots\/[^/]+\/files\/)/.test(r.url)).length,loads,'cancel sends no preview request');}
  }
  const code=await open('sample.py'); await code.locator('#editor:not([readonly])').waitFor();
  await code.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText(' preserved tree draft');
  await page.evaluate(()=>{const t=state.tabs.find(t=>t.entry.path==='sample.py');window.retained={frame:t.frame,win:t.frame.contentWindow,doc:t.frame.contentDocument,editor:t.frame.contentDocument.querySelector('#editor'),session:t.frame.contentWindow.fbrowseEditor.session};});
  const same=await open('same.txt');await same.locator('#editor').waitFor();
  console.log('Tree drag: four edges, nested six groups, actual icon/name gestures and source identity');
  for(const [file,target,edge,count] of [['left.txt','same.txt','left',2],['right.txt','same.txt','right',3],['top.txt','left.txt','top',4],['bottom.txt','right.txt','bottom',5],['six.txt','top.txt','right',6]]) {
    const r=await groupRect(page,target);
    await dragTree(file,groupPoint(page,target,edge),{part:count%2?'.icon':'.filename',inspect:async()=>{
      assert(await drop.isVisible());assert.equal(await drop.getAttribute('data-edge'),edge);assert.equal(await drop.getAttribute('data-group'),r.id);
      const p=await drop.boundingBox();assert(p.x>=r.x-2&&p.y>=r.y-2&&p.x+p.width<=r.x+r.width+2&&p.y+p.height<=r.y+r.height+2,'local preview');
      assert(Math.abs((['left','right'].includes(edge)?p.width/r.width:p.height/r.height)-.5)<.06,'local half preview');
    }});
    await tab(file).waitFor();await page.waitForFunction(n=>state.groups.size===n,count);
    const a=await groupRect(page,file),b=await groupRect(page,target);
    assert.notEqual(a.id,b.id); if(edge==='left')assert(a.x+a.width<=b.x+2);if(edge==='right')assert(b.x+b.width<=a.x+2);if(edge==='top')assert(a.y+a.height<=b.y+2);if(edge==='bottom')assert(b.y+b.height<=a.y+2);
  }
  await page.screenshot({path:'/tmp/fbrowse-tree-six-groups-0.9.1.png',fullPage:true});
  const beforeCancel=await model();
  for(const cancel of ['Escape','outside','pointercancel','lostcapture','blur']) {
    const before=requests.length;
    await dragTree('cancel.txt',groupPoint(page,'same.txt','bottom'),{cancel,inspect:async p=>{
      await move(28,110);await ghostAt({x:28,y:110},'tree','cancel.txt');assert(await drop.isHidden(),'outside workspace hides preview');
      await move(p.x,p.y);await ghostAt(p,'tree','cancel.txt');
      await page.screenshot({path:'/tmp/fbrowse-tree-ghost-0.9.1.png',fullPage:true});
    }});
    assert.equal(await model(),beforeCancel,'cancel model unchanged '+cancel);
    assert.equal(requests.slice(before).filter(r=>new URL(r.url).pathname==='/api/entry').length,0,'cancel sends no entry validation '+cancel);
  }
  await dragTree('center.txt',groupPoint(page,'same.txt'));await tab('center.txt').waitFor();assert.equal((await groupRect(page,'center.txt')).id,(await groupRect(page,'same.txt')).id);assert.equal(await page.locator('.pane-tabs').count(),6);
  // A tree gesture for an already-open dirty file reuses its browsing context and buffer.
  await dragTree('sample.py',groupPoint(page,'left.txt'));await page.waitForFunction(()=>state.tabs.find(t=>t.entry.path==='sample.py').group===state.tabs.find(t=>t.entry.path==='left.txt').group);
  assert.equal(await tab('sample.py').count(),1);assert((await code.locator('#editor').inputValue()).endsWith(' preserved tree draft'));
  assert(await page.evaluate(()=>{const r=retained,t=state.tabs.find(t=>t.entry.path==='sample.py');return t.frame===r.frame&&t.frame.contentWindow===r.win&&t.frame.contentDocument===r.doc&&t.frame.contentDocument.querySelector('#editor')===r.editor&&t.frame.contentWindow.fbrowseEditor.session===r.session;}));
  // Search results and same names in different roots retain source root identity.
  await page.locator('#search').fill('insert.txt');await row('insert.txt').and(page.locator('.search-result')).waitFor();
  const targetGroup=(await groupRect(page,'center.txt')).id;
  await dragTree('insert.txt',async()=>{const r=await tab('center.txt').boundingBox();return{x:r.x+3,y:r.y+r.height/2};},{inspect:async()=>{assert(await marker.isVisible());assert.equal(await marker.getAttribute('data-before'),await tab('center.txt').getAttribute('data-tab'));}});
  await tab('insert.txt').waitFor();const inserted=await order(targetGroup);assert(inserted.indexOf(await tab('insert.txt').getAttribute('data-tab'))+1===inserted.indexOf(await tab('center.txt').getAttribute('data-tab')));
  await page.locator('#home').click();await page.locator('#rootSelect').selectOption('other');await row('same.txt').waitFor();
  await dragTree('same.txt',groupPoint(page,'center.txt'),{root:'other'});await tab('same.txt','other').waitFor();assert.equal(await page.locator('.file-tab[data-path="same.txt"]').count(),2);
  assert.equal(await (await frame('same.txt','other')).locator('#editor').inputValue(),'results');
  await page.locator('#rootSelect').selectOption('project');await row('same.txt').waitFor();
  // Ordinary click, folder toggle and context menu still operate after drag cancellation.
  await row('nested').locator('.icon').click();await row('nested/README.md').waitFor();await row('nested').locator('.filename').click();assert.equal(await row('nested/README.md').count(),0);
  await row('same.txt').locator('.filename').click();assert.equal(await page.evaluate(()=>state.activeTab),await tab('same.txt').getAttribute('data-tab'));
  await row('same.txt').click({button:'right'});assert(await page.locator('#treeMenu').isVisible());await page.keyboard.press('Escape');
  for(const file of ['nested','outside-link.txt']) {
    const before=await model(),loc=row(file).locator('.icon');await loc.scrollIntoViewIfNeeded();const r=await loc.boundingBox(),p=await groupPoint(page,'same.txt','right')();
    await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await move(p.x,p.y);
    assert.equal(await ghost.isVisible(),file==='nested','only available directories can start a tree move '+file);assert(await drop.isHidden(),'directory cannot dock into the workspace');
    await page.mouse.up();await clean('unsupported '+file);assert.equal(await model(),before,'unsupported source no layout '+file);
  }
  // Workspace drops only open/move tabs; filesystem moves require a tree destination.
  const mutation=requests.filter(r=>r.method==='POST'&&/\/api\/(?:fs|filesystem|files|copy|move|rename|duplicate|delete|create|editor\/save)/.test(new URL(r.url).pathname));assert.deepEqual(mutation,[],'drag never posts filesystem mutations');
  for(const [file,hash] of originals)assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),hash,'drag preserves bytes '+file);
  assert.equal(browser.contexts().flatMap(c=>c.pages()).length,1,'no browser tabs opened');
  console.log('PASS: tree physical label/icon edge/center/search/strip drops, six groups, dirty reuse, root identity, cancellation cleanup and unchanged file bytes');
}))().catch(error=>{console.error(error);process.exitCode=1;});
