// External pages remain in workspace tabs without asking the browser host for popups.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const {fixture,dragTab,groupPoint}=require('./workspace-test-helper.cjs');
const server=http.createServer();
const hits=[];
server.on('request',(request,response)=>{
  hits.push(request.url);
  response.setHeader('Content-Type','text/html');
  if(request.url==='/blocked'){
    response.setHeader('X-Frame-Options','DENY');response.setHeader('Content-Security-Policy',"frame-ancestors 'none'");
  }
  response.end('<h1>External '+request.url+'</h1><script>try{parent.document.body.dataset.REMOTE_ACCESS="bad"}catch{document.body.dataset.isolated="true"}</script>');
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  try{await fixture(async({ready,page,browser,frame,open,tab})=>{
    await fs.writeFile(ready.project+'/web-links.md','# Web links\n\n[External]('+origin+'/ok)\n\n[Background]('+origin+'/background)\n\n[Blocked]('+origin+'/blocked)\n');
    await page.goto(ready.url+'?path=web-links.md');const source=await frame('web-links.md');await source.locator('#markdown h1').waitFor();
    await source.locator('#mode').click();await source.locator('#editor').press('Control+End');await source.locator('#editor').press('Enter');await source.locator('#mode').click();
    const draft=await source.locator('#editor').inputValue(),code=await open('sample.py');await code.locator('#editor:not([readonly])').waitFor();
    await dragTab(page,'sample.py',groupPoint(page,'web-links.md','right'));await tab('web-links.md').locator('.tab-activate').click();
    const sourceId=await tab('web-links.md').getAttribute('data-tab');
    await page.evaluate(()=>{window.popupCalls=0;window.open=()=>{popupCalls++;throw Error('Unexpected browser popup');};window.originalFileFrames=state.tabs.map(t=>({frame:t.frame,doc:t.frame.contentDocument}));});
    const sourceTab=()=>tab('web-links.md').locator('.tab-activate').click();
    const webTab=path=>page.locator('.file-tab[data-path='+JSON.stringify(origin+path)+']');
    const webSlot=async path=>page.locator('#slot-'+await webTab(path).getAttribute('data-tab'));
    const remote=async path=>page.frameLocator('iframe[data-tab="'+await webTab(path).getAttribute('data-tab')+'"]');
    const intact=async()=>{
      assert.equal(await source.locator('#editor').inputValue(),draft);
      assert.equal(await page.evaluate(()=>originalFileFrames.every(t=>t.frame.isConnected&&t.frame.contentDocument===t.doc)),true);
      assert.equal(await page.evaluate(()=>popupCalls),0);assert.equal(page.context().pages().length,1);
      assert.equal(await page.evaluate(()=>document.body.dataset.REMOTE_ACCESS),undefined);
      assert.equal(await page.locator('.pane-tabs').count(),2);
    };
    await source.getByRole('link',{name:'External',exact:true}).click({button:'right'});await page.keyboard.press('Escape');
    assert.equal(await page.locator('.file-tab').count(),2);await intact();
    await source.getByRole('link',{name:'External',exact:true}).click();await webTab('/ok').waitFor();
    await (await remote('/ok')).getByRole('heading',{name:'External /ok'}).waitFor();
    assert.equal(await (await remote('/ok')).locator('body').getAttribute('data-isolated'),'true');
    const externalId=await webTab('/ok').getAttribute('data-tab');
    assert.equal(await page.evaluate(()=>state.activeTab),externalId);assert.equal(await page.locator('#rootSelect').inputValue(),'project');
    assert.equal(await webTab('/ok').evaluate(n=>n.closest('.pane-tabs').dataset.group),await tab('web-links.md').evaluate(n=>n.closest('.pane-tabs').dataset.group));
    const slot=await webSlot('/ok');assert.equal(await slot.getByRole('textbox',{name:'원래 웹 주소'}).inputValue(),origin+'/ok');
    const fallback=slot.getByRole('link',{name:'브라우저로 열기'});assert.equal(await fallback.getAttribute('href'),origin+'/ok');assert.equal(await fallback.getAttribute('target'),'_blank');
    assert.equal(await slot.locator('iframe').getAttribute('sandbox'),'allow-scripts allow-same-origin allow-forms');
    await intact();await sourceTab();await source.getByRole('link',{name:'External',exact:true}).click();
    assert.equal(await page.locator('.file-tab').count(),3);assert.equal(await page.evaluate(()=>state.activeTab),externalId);assert.equal(hits.filter(p=>p==='/ok').length,1);
    await sourceTab();await source.getByRole('link',{name:'Background',exact:true}).click({modifiers:['Control']});await webTab('/background').waitFor();
    assert.equal(await page.evaluate(()=>state.activeTab),sourceId);assert.equal(hits.includes('/background'),false,'background page is not fetched until selected');
    await webTab('/background').locator('.tab-activate').click();await (await remote('/background')).getByRole('heading',{name:'External /background'}).waitFor();await intact();
    await sourceTab();await source.getByRole('link',{name:'Background',exact:true}).click({button:'middle'});
    assert.equal(await page.evaluate(()=>state.activeTab),sourceId);assert.equal(await page.locator('.file-tab').count(),4);
    const refused=page.waitForResponse(origin+'/blocked'),framingError=page.waitForEvent('console',{predicate:message=>message.type()==='error'&&/frame-ancestors|Refused to frame|Refused to display/.test(message.text())});await source.getByRole('link',{name:'Blocked',exact:true}).click();await webTab('/blocked').waitFor();await refused;await framingError;
    const blocked=await webSlot('/blocked');
    assert.ok(hits.includes('/blocked'));assert.equal(await (await remote('/blocked')).getByRole('heading',{name:'External /blocked'}).count(),0);
    await blocked.locator('summary').click();await blocked.getByText('사이트가 다른 앱 안의 표시를 차단할 수 있습니다.',{exact:false}).waitFor();
    assert.equal(await blocked.getByRole('link',{name:'브라우저로 열기'}).getAttribute('href'),origin+'/blocked');await intact();
    await page.locator('#expandPreview').click();assert.equal(await page.locator('#viewer').evaluate(n=>n.classList.contains('is-expanded')),true);await page.locator('#exitExpanded').click();await intact();
    await page.locator('#refresh').click();await page.waitForFunction(()=>state.tabs.find(t=>t.id===state.activeTab)?.pendingWebLoad===false);await intact();
    await page.evaluate(({href,sourceId})=>{const source=state.tabs.find(t=>t.id===sourceId).frame.contentWindow;return [fbrowseOpenExternal(source,'javascript:alert(1)'),fbrowseOpenExternal(source,'file:///etc/passwd'),fbrowseOpenExternal(source,location.origin),fbrowseOpenExternal(null,href)];},{href:origin+'/ok',sourceId}).then(result=>assert.deepEqual(result,[false,false,false,false]));
    // A shared web-tab link restores directly without filesystem lookups for a URL.
    const context=await browser.newContext(),restored=await context.newPage();
    try{await restored.goto(ready.url+'?'+new URLSearchParams({root:'project',web:origin+'/ok'}));await restored.getByRole('button',{name:'웹 · '+origin+'/ok',exact:true}).waitFor();await restored.frameLocator('.web-slot>iframe').getByRole('heading',{name:'External /ok'}).waitFor();}finally{await context.close();}
    await webTab('/blocked').locator('.tab-close').click();await webTab('/background').locator('.tab-close').click();await webTab('/ok').locator('.tab-close').click();
    assert.equal(await page.locator('.file-tab').count(),2);await sourceTab();await intact();
    console.log('PASS: external workspace tabs, no popups, right/middle/Ctrl clicks, reuse, lazy background loading, site framing refusal fallback, isolation, reload/share/fullscreen and draft/split retention');
  });}finally{await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
