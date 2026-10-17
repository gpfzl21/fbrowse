// External sites must be top-level pages, including sites that refuse framing.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const {fixture,dragTab,groupPoint}=require('./workspace-test-helper.cjs');
const server=http.createServer((request,response)=>{
  response.setHeader('Content-Type','text/html');
  response.setHeader('Content-Security-Policy',"frame-ancestors 'none'");
  response.end('<h1>External site that refuses frames</h1>');
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  try{await fixture(async({ready,page,frame,open,tab,errors})=>{
    await fs.writeFile(ready.project+'/web-links.md','# Web links\n\n[External]('+origin+'/paper)\n');
    const opens=[];
    let bridge=false,fail=false;
    await page.route('**/api/external-browser',async route=>{
      const data=route.request().postDataJSON();
      if(data.action==='connect')return route.fulfill({json:{connected:bridge}});
      opens.push(data);return route.fulfill(fail?{status:503,json:{error:'Orca 연결을 확인할 수 없습니다.'}}:{json:{opened:true,background:data.background}});
    });
    await page.goto(ready.url+'?path=web-links.md');let source=await frame('web-links.md');await source.locator('#markdown h1').waitFor();
    // The ordinary browser uses its real anchor behavior, without window.open.
    for(const options of [{},{button:'middle'},{modifiers:['Control']}]){
      const created=page.context().waitForEvent('page');await source.getByRole('link',{name:'External',exact:true}).click(options);
      const external=await created;await external.getByRole('heading',{name:'External site that refuses frames'}).waitFor();
      assert.equal(await external.evaluate(()=>window.opener),null);await external.close();
      assert.equal(await page.locator('.file-tab').count(),1);assert.equal(await page.locator('.web-slot').count(),0);
    }
    await source.locator('#markdown').evaluate(node=>node.addEventListener('contextmenu',event=>{queueMicrotask(()=>{window.lastContextPrevented=event.defaultPrevented;});}));
    await source.getByRole('link',{name:'External',exact:true}).click({button:'right'});
    assert.equal(opens.length,0);assert.equal(await source.locator('body').evaluate(()=>window.lastContextPrevented),false,'native host menu also retained without CLI');
    bridge=true;await page.reload();source=await frame('web-links.md');await source.locator('#markdown h1').waitFor();
    assert.equal(await page.evaluate(()=>fbrowseExternalBrowser()),'orca');
    await source.locator('#mode').click();await source.locator('#editor').focus();await source.locator('#editor').press('Control+End');await page.keyboard.insertText('\nretained draft');await source.locator('#mode').click();
    const draft=await source.locator('#editor').inputValue();const code=await open('sample.py');await code.locator('#editor:not([readonly])').waitFor();
    await dragTab(page,'sample.py',groupPoint(page,'web-links.md','right'));await tab('web-links.md').locator('.tab-activate').click();
    const sourceId=await tab('web-links.md').getAttribute('data-tab');
    await page.evaluate(()=>{window.originalFileFrames=state.tabs.map(t=>({frame:t.frame,doc:t.frame.contentDocument}));window.open=()=>{throw Error('Duplicate native popup');};});
    const intact=async()=>{
      assert.equal(await source.locator('#editor').inputValue(),draft);
      assert.equal(await page.evaluate(()=>originalFileFrames.every(t=>t.frame.isConnected&&t.frame.contentDocument===t.doc)),true);
      assert.equal(await page.evaluate(()=>state.activeTab),sourceId);assert.equal(await page.locator('.pane-tabs').count(),2);
      assert.equal(await page.locator('.file-tab').count(),2);assert.equal(page.context().pages().length,1);
    };
    const link=source.getByRole('link',{name:'External',exact:true});
    const requestOpen=async action=>{const response=page.waitForResponse(r=>r.url().endsWith('/api/external-browser')&&r.request().postDataJSON().action==='open');await action();await response;};
    // Each default click takes the single verified Orca route, preserving drafts.
    for(const [options,background] of [[{},false],[{modifiers:['Control']},true],[{button:'middle'},true]]){
      const count=opens.length;await requestOpen(()=>link.click(options));
      assert.equal(opens.length,count+1);assert.equal(opens.at(-1).url,origin+'/paper');assert.equal(opens.at(-1).background,background);await intact();
    }
    assert.equal(new Set(opens.map(data=>data.request_id)).size,3);
    // Retain the host menu for laptop-default-browser and explicit Orca actions.
    await source.locator('#markdown').evaluate(node=>node.addEventListener('contextmenu',event=>{queueMicrotask(()=>{window.lastContextPrevented=event.defaultPrevented;});}));
    await link.click({button:'right'});assert.equal(opens.length,3);
    assert.equal(await source.locator('#webLinkMenu').count(),0);
    assert.equal(await source.locator('body').evaluate(()=>window.lastContextPrevented),false,'Orca host menu is not suppressed');
    fail=true;await requestOpen(()=>link.click());
    await source.locator('#notice').filter({hasText:'Orca 연결을 확인할 수 없습니다.'}).waitFor();assert.equal(opens.length,4);await intact();
    assert.deepEqual(await page.evaluate(({href})=>{const source=state.tabs[0].frame.contentWindow;return [fbrowseOpenExternal(null,href),fbrowseOpenExternal(source,'javascript:alert(1)'),fbrowseOpenExternal(source,location.origin)];},{href:origin+'/paper'}),[false,false,false]);
    await source.locator('#mode').click();await source.locator('#editor').focus();await page.keyboard.press('Control+z');assert.equal(await source.locator('#editor').inputValue(),'# Web links\n\n[External]('+origin+'/paper)\n');
    assert.deepEqual(errors,[]);
    console.log('PASS: native browser anchor pages despite framing denial; one verified Orca request per left/Ctrl/middle click; host menu retained; no retries; split/draft/frame/undo retention');
  });}finally{await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
