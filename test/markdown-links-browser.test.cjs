// Follow real Markdown links without replacing the workspace or losing drafts.
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {fixture,dragTab,groupPoint,gate}=require('./workspace-test-helper.cjs');
fixture(async({ready,page,browser,open,tab,frame,register})=>{
  await fs.mkdir(ready.project+'/docs');
  const crossRootLinks={
    '상대 외부':'../../results/linked/deep/한글%20%25.md#section',
    '절대 외부':encodeURI(ready.results+'/linked/deep/한글 %.md')+'#section',
    '파일 URI':pathToFileURL(ready.results+'/linked/deep/한글 %.md').href+'#section',
    '연결 경로':'linked-root/deep/한글%20%25.md#section',
    '외부 폴더':'../../results/linked/deep/',
    '미연결 루트':'../../papers/same.txt',
  };
  const markdown='# Links\n\n[문서](target.md#세부-항목)\n\n[같은 문서](target.md)\n\n[파일](../same.txt)\n\n[PDF](../sample.pdf)\n\n[이미지](../image.svg)\n\n[다른 루트](/roots/other/files/same.txt)\n\n[앱 경로](/?root=project&path=docs%2Ftarget.md)\n\n[공백 한글](한글%20%25.md)\n\n[웹](https://links.example.test/guide?q=hello#section)\n\n[누락](missing.md)\n\n[지연](late.md)\n\n[폴더](../nested/)\n'+Object.entries(crossRootLinks).map(([label,href])=>'\n['+label+']('+href+')\n').join('');
  await fs.writeFile(ready.project+'/docs/links.md',markdown);
  await fs.writeFile(ready.project+'/docs/target.md','# Target\n\n'+('Some paragraph.\n\n').repeat(180)+'## 세부 항목\n\nDetails\n');
  await fs.writeFile(ready.project+'/docs/한글 %.md','# Unicode filename\n');
  await fs.writeFile(ready.project+'/docs/late.md','# Slow link\n');
  await fs.mkdir(ready.results+'/linked/deep',{recursive:true});
  await fs.writeFile(ready.results+'/linked/deep/한글 %.md','# Other root\n\n'+('Paragraph\n\n').repeat(180)+'## Section\n');
  await fs.symlink(ready.results+'/linked',ready.project+'/docs/linked-root');
  await register('other',ready.results);await page.goto(ready.url+'?root=project&path=docs%2Flinks.md');
  const source=await frame('docs/links.md');await source.locator('#markdown h1').waitFor();
  await source.locator('#mode').click();await source.locator('#editor').fill(markdown+'\nUnsaved Markdown draft\n');await source.locator('#mode').click();
  const code=await open('sample.py');await code.locator('#editor:not([readonly])').waitFor();
  const original=await fs.readFile(ready.project+'/sample.py','utf8');
  await code.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('\n# retained draft\n');
  const draft=await code.locator('#editor').inputValue();
  await dragTab(page,'sample.py',groupPoint(page,'docs/links.md','right'));
  await tab('docs/links.md').locator('.tab-activate').click();
  const sourceId=await tab('docs/links.md').getAttribute('data-tab');
  await page.evaluate(()=>{window.linkIdentity=state.tabs.map(tab=>({frame:tab.frame,doc:tab.frame.contentDocument}));window.openCalls=[];
    const original=window.open;window.open=function(...args){openCalls.push({args,active:navigator.userActivation.isActive});return original.apply(window,args);};});
  let dialogs=0;page.on('dialog',async dialog=>{dialogs++;await dialog.dismiss();});
  const sourceTab=()=>tab('docs/links.md').locator('.tab-activate').click();
  const count=()=>page.locator('.file-tab').count();
  const intact=async()=>{
    assert.equal(await page.evaluate(()=>linkIdentity.every(item=>item.frame.isConnected&&item.frame.contentDocument===item.doc)),true);
    assert.equal(await code.locator('#editor').inputValue(),draft);
    assert.equal(await source.locator('#editor').inputValue(),markdown+'\nUnsaved Markdown draft\n');
    assert.equal(await fs.readFile(ready.project+'/sample.py','utf8'),original);
    assert.equal(await fs.readFile(ready.project+'/docs/links.md','utf8'),markdown);
    assert.equal(await page.locator('.workspace-slot.is-visible').count(),2);
    assert.equal(dialogs,0,'opening a link never discards or confirms discarding retained drafts');
  };
  await source.getByRole('link',{name:'문서',exact:true}).click();
  const target=await frame('docs/target.md');await target.locator('#markdown h2').waitFor();
  const targetFrame=await (await page.locator('iframe[data-tab="'+await tab('docs/target.md').getAttribute('data-tab')+'"]').elementHandle()).contentFrame();
  await targetFrame.waitForFunction(()=>document.querySelector('#markdown').scrollTop>0);
  assert.equal(await count(),3);assert.equal(await tab('docs/target.md').evaluate(n=>n.closest('.pane-tabs').dataset.group),await tab('docs/links.md').evaluate(n=>n.closest('.pane-tabs').dataset.group));
  await intact();await sourceTab();await source.getByRole('link',{name:'같은 문서',exact:true}).click();
  await page.waitForFunction(()=>state.selected?.path==='docs/target.md');
  assert.equal(await count(),3,'existing exact file tab is activated, not duplicated');

  await sourceTab();await source.getByRole('link',{name:'파일',exact:true}).click({modifiers:['Control']});
  await tab('same.txt').waitFor();assert.equal(await page.evaluate(()=>state.activeTab),sourceId,'Ctrl+click opens a background file tab');
  await source.getByRole('link',{name:'공백 한글',exact:true}).click({button:'middle'});
  await tab('docs/한글 %.md').waitFor();assert.equal(await page.evaluate(()=>state.activeTab),sourceId,'middle click preserves the source tab');
  await source.getByRole('link',{name:'PDF',exact:true}).click();await tab('sample.pdf').waitFor();await intact();
  await sourceTab();await source.getByRole('link',{name:'이미지',exact:true}).click();await tab('image.svg').waitFor();await intact();
  await sourceTab();await source.getByRole('link',{name:'다른 루트',exact:true}).click();await tab('same.txt','other').waitFor();
  const other=await frame('same.txt','other');await other.locator('#code').filter({hasText:'results'}).waitFor();await intact();
  await sourceTab();const sourceRoot=await page.locator('#rootSelect').inputValue();
  await source.getByRole('link',{name:'상대 외부',exact:true}).click({modifiers:['Control']});
  await tab('linked/deep/한글 %.md','other').waitFor();
  assert.equal(await page.evaluate(()=>state.activeTab),sourceId);assert.equal(await page.locator('#rootSelect').inputValue(),sourceRoot);
  for(const label of ['상대 외부','절대 외부','파일 URI','연결 경로']){
    await sourceTab();
    // Navigation must reveal the actual file even with a restrictive sidebar search/filter.
    await page.locator('#type').selectOption('pdf');await page.locator('#search').fill('no-such-file');
    await source.getByRole('link',{name:label,exact:true}).click();
    await page.locator('#entries button.row.active[data-root="other"][data-path="linked/deep/한글 %.md"]').waitFor();
    assert.equal(await page.locator('#rootSelect').inputValue(),'other');
    assert.equal(await page.locator('#search').inputValue(),'');assert.equal(await page.locator('#type').inputValue(),'all');
    const linked=await frame('linked/deep/한글 %.md','other');await linked.locator('#markdown h2').waitFor();
    await page.waitForFunction(()=>state.tabs.find(tab=>tab.entry.root_id==='other'&&tab.entry.path==='linked/deep/한글 %.md').frame.contentDocument.querySelector('#markdown').scrollTop>0);
    await intact();
  }
  await sourceTab();await page.locator('#gitTab').click();
  await source.getByRole('link',{name:'외부 폴더',exact:true}).click();
  await page.locator('#entries button.row[data-root="other"][data-path="linked/deep"][aria-expanded="true"]').waitFor();
  assert.equal(await page.locator('#filesTab').getAttribute('aria-pressed'),'true');
  await sourceTab();await source.getByRole('link',{name:'미연결 루트',exact:true}).click();
  await source.locator('#notice').filter({hasText:'Manage Roots'}).waitFor();await intact();
  await sourceTab();const priorCount=await count();await source.getByRole('link',{name:'앱 경로',exact:true}).click();await page.waitForFunction(()=>state.selected?.path==='docs/target.md');assert.equal(await count(),priorCount);

  await sourceTab();await page.context().route('https://links.example.test/**',route=>route.fulfill({contentType:'text/html',body:'<h1>External site</h1>'}));
  const popup=page.context().waitForEvent('page');await source.getByRole('link',{name:'웹',exact:true}).click();
  const web=await popup;await web.getByRole('heading',{name:'External site'}).waitFor();
  assert.equal(await count(),priorCount);assert.equal(await page.evaluate(()=>state.activeTab),sourceId);
  assert.deepEqual(await page.evaluate(()=>openCalls),[]);await intact();await web.close();
  await source.getByRole('link',{name:'누락',exact:true}).click();await source.locator('#notice').filter({hasText:'File not found'}).waitFor();
  assert.equal(await count(),priorCount);await intact();

  // A slow response cannot steal focus from a later explicit tab selection.
  const entered=gate(),release=gate();await page.route('**/api/resolve-link?*',async route=>{
    if(new URL(route.request().url()).searchParams.get('href')!=='late.md')return route.continue();entered.release();await release.promise;await route.continue();
  });
  await source.getByRole('link',{name:'지연',exact:true}).click();await entered.promise;
  await tab('sample.py').locator('.tab-activate').click();const codeId=await tab('sample.py').getAttribute('data-tab');release.release();
  await tab('docs/late.md').waitFor();assert.equal(await page.evaluate(()=>state.activeTab),codeId);await page.unroute('**/api/resolve-link?*');
  await sourceTab();await source.getByRole('link',{name:'폴더',exact:true}).click();await page.locator('#entries [data-path="nested"][aria-expanded="true"]').waitFor();await intact();
  assert.equal(await page.evaluate(()=>fbrowseOpenExternal(null,'https://links.example.test')),false);
  await code.locator('#editor').focus();await page.keyboard.press('Control+z');assert.equal(await code.locator('#editor').inputValue(),original,'native undo survives all navigation');
  const anchorContext=await browser.newContext(),anchored=await anchorContext.newPage();
  try{
    await anchored.goto(ready.url+'?root=project&path=docs%2Ftarget.md#'+encodeURIComponent('세부-항목'));
    await anchored.waitForFunction(()=>document.querySelector('.workspace-slot.is-visible iframe')?.contentDocument?.querySelector('#markdown')?.scrollTop>0);
    await anchored.goto(new URL(await source.getByRole('link',{name:'절대 외부',exact:true}).getAttribute('href'),ready.url).href);
    await anchored.locator('#entries button.row.active[data-root="other"][data-path="linked/deep/한글 %.md"]').waitFor();
  }finally{await anchorContext.close();}
  console.log('PASS: internal file/Markdown/anchor/PDF/image/cross-root links and external browser pages retain groups, drafts and undo; background clicks, missing/slow paths; one native external page');
}).catch(error=>{console.error(error);process.exitCode=1;});
