const {fixture,groupPoint,groupRect,dragTab}=require('./workspace-test-helper.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
(async()=>fixture(async({ready,page,row,tab,open,requests})=>{
  const files=Array.from({length:12},(_,i)=>'overflow-'+String(i).padStart(2,'0')+'-long-name.txt');
  for(const file of files)await fs.writeFile(ready.project+'/'+file,'strip fixture '+file+'\n');
  await page.goto(ready.url);for(const file of ['same.txt','sample.py','README.md',...files])await open(file);
  const marker=page.locator('#workspaceInsertion'),ghost=page.locator('.workspace-drag-ghost');
  const order=group=>page.locator('.pane-tabs[data-group='+JSON.stringify(group)+'] .file-tab').evaluateAll(ns=>ns.map(n=>n.dataset.tab));
  async function predict(movingFile,targetFile,side,{scroll=false,cross=false}={}){
    const source=tab(movingFile).locator('.tab-activate');await source.scrollIntoViewIfNeeded();const s=await source.boundingBox(),moving=await tab(movingFile).getAttribute('data-tab');
    await page.mouse.move(s.x+20,s.y+s.height/2);await page.mouse.down();await page.mouse.move(s.x+32,s.y+s.height/2,{steps:5});
    await page.mouse.move(28,110,{steps:10});assert(await ghost.isVisible(),'tab ghost remains visible outside workspace');assert((await ghost.textContent()).includes(movingFile));assert((await ghost.textContent()).includes('[project]'));const outside=await ghost.boundingBox();assert(Math.abs(outside.x-44)<2&&Math.abs(outside.y-128)<2,'tab ghost follows outside pointer');assert(await marker.isHidden());
    let group=(await groupRect(page,targetFile)).id,strip=page.locator('.pane-tabs[data-group='+JSON.stringify(group)+']'),box=await strip.boundingBox();
    if(scroll){
      const before=await strip.evaluate(n=>n.scrollLeft);
      // Actual pointer movement along the strip edge exercises its non-polling horizontal autoscroll.
      const scrollSteps=await strip.evaluate(n=>Math.ceil((n.scrollWidth-n.clientWidth)/18)+10);
      for(let i=0;i<scrollSteps;i++)await page.mouse.move(box.x+box.width-8-(i%2),box.y+box.height/2);
      assert((await strip.evaluate(n=>n.scrollLeft))>before,'held physical drag scrolls strip');assert(await strip.evaluate(n=>n.scrollLeft+n.clientWidth>=n.scrollWidth-2),'held drag reaches true end append');
      assert(await marker.isVisible(),'insertion remains visible during strip scroll');
      side='append';
    }else await tab(targetFile).scrollIntoViewIfNeeded();
    box=await strip.boundingBox();const target=await tab(targetFile).boundingBox();
    const point={x:side==='before'?target.x+3:side==='after'?target.x+target.width-3:box.x+box.width-5,y:box.y+box.height/2};
    await page.mouse.move(point.x,point.y,{steps:12});await page.mouse.move(point.x+1,point.y);await page.mouse.move(point.x,point.y);
    assert(await ghost.isVisible());assert.equal(await ghost.getAttribute('data-source'),'tab');assert((await ghost.textContent()).includes(movingFile));
    assert(await marker.isVisible());assert(await page.locator('#workspaceDrop').isHidden(),'strip uses insertion marker');
    assert.equal(await marker.getAttribute('data-group'),group);
    const peers=await strip.locator('.file-tab').evaluateAll((ns,moving)=>ns.filter(n=>n.dataset.tab!==moving).map(n=>{const r=n.getBoundingClientRect();return{id:n.dataset.tab,x:r.x,width:r.width};}),moving);
    const expectedBefore=peers.find(n=>point.x<n.x+n.width/2)?.id||'';
    assert.equal(await marker.getAttribute('data-before'),expectedBefore,'marker predicts BEFORE boundary excluding source');if(scroll)assert.equal(expectedBefore,'','end append marker has no before peer');
    const m=await marker.boundingBox(),boundary=expectedBefore?peers.find(n=>n.id===expectedBefore).x:peers.at(-1)?.x+peers.at(-1)?.width;
    const expectedX=Math.max(box.x+2,Math.min(box.x+box.width-4,boundary));assert(Math.abs(m.x-expectedX)<2,'visible marker matches specific peer boundary');
    const previous=await order(group),expected=previous.filter(id=>id!==moving),index=expectedBefore?expected.indexOf(expectedBefore):expected.length;expected.splice(index,0,moving);
    await page.screenshot({path:'/tmp/fbrowse-insertion-'+(scroll?'scroll':cross?'cross':side)+'-0.9.1.png',fullPage:true});
    await page.mouse.up();assert.deepEqual(await order(group),expected,'actual final order exactly matches visible marker '+movingFile+' '+side);
    assert(await marker.isHidden());assert(await ghost.isHidden());assert.equal(await page.locator('.is-drag-source').count(),0);assert(await page.evaluate(()=>!pointerTabDrag&&!tabDrag&&!dragGhost));
    return {previous,expected};
  }
  // Before, after, end append, source exclusion, near-self and horizontal scrolling.
  await predict(files[0],'sample.py','before');await predict(files[0],'sample.py','after');
  const noOp=await predict('sample.py','sample.py','before');assert.deepEqual(noOp.previous,noOp.expected,'drop near source preserves its exact relative order');
  await predict(files[1],files[0],'append',{scroll:true});
  await dragTab(page,'README.md',groupPoint(page,'same.txt','right'));
  assert.equal(await page.locator('.pane-tabs').count(),2);
  await predict('README.md','same.txt','before',{cross:true});assert.equal(await page.locator('.pane-tabs').count(),1,'cross group insertion collapses only empty source');
  // A sole opened file dropped at its own edge must not promise or allocate a phantom split.
  for(const file of ['sample.py','same.txt',...files])if(await tab(file).count())await tab(file).locator('.tab-close').click();
  assert.equal(await page.locator('.file-tab').count(),1);
  const prior=await page.evaluate(()=>JSON.stringify({layout:state.layout,tabs:state.tabs.map(t=>[t.id,t.group])}));
  await dragTab(page,'README.md',groupPoint(page,'README.md','right'),{inspect:async()=>{assert.equal(await page.locator('#workspaceDrop').getAttribute('data-edge'),'center','self split does not promise a half preview');assert((await page.locator('#workspaceDrop').textContent()).includes('다른 탭 없음'),'self split honestly describes unchanged placement');}});
  assert.equal(await page.evaluate(()=>JSON.stringify({layout:state.layout,tabs:state.tabs.map(t=>[t.id,t.group])})),prior);
  assert.equal(requests.filter(r=>r.method==='POST'&&/\/api\/(?:fs|editor\/save)/.test(new URL(r.url).pathname)).length,0);
  console.log('PASS: physical BEFORE/AFTER/end insertion, exact predicted order, near-self/source exclusion, horizontal strip scroll, cross-group collapse and sole-file self-drop');
}))().catch(error=>{console.error(error);process.exitCode=1;});
