// Optional browser integration: FBROWSE_PLAYWRIGHT_MODULE=/path/to/playwright node test_browser.cjs
// Node/Playwright are test tools only. The application does not use them.
const {chromium}=require(process.env.FBROWSE_PLAYWRIGHT_MODULE||process.argv[2]||'playwright');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const fs=require('node:fs');
const assert=require('node:assert/strict');

(async()=>{
  const fixture=spawn('python3',['-B',__dirname+'/test_browser_fixture.py'],{cwd:__dirname,stdio:['ignore','pipe','inherit']});
  let browser;
  try{
    const ready=await Promise.race([
      new Promise((resolve,reject)=>{readline.createInterface({input:fixture.stdout}).once('line',line=>resolve(JSON.parse(line)));fixture.once('exit',code=>reject(Error('Fixture exited: '+code)));}),
      new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture timeout')),10000);timer.unref();})
    ]);
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(ready.url);
    await page.locator('button.row[data-path="same.txt"]').waitFor();
    async function register(name,path){
      await page.locator('#manageRoots').click();
      await page.locator('#browseFolder').click();
      await page.locator('#folderEntries [data-name="same.txt"]').waitFor();
      await page.locator('#folderUp').click();
      const basename=path.split('/').pop();
      await page.locator(`#folderEntries button[data-name="${basename}"]`).click();
      await page.locator('#folderEntries [data-name="same.txt"]').waitFor();
      if(name==='논문'){
        assert.equal(await page.locator('#folderEntries button[data-name="same.txt"]').count(),0);
        await page.locator('#folderEntries button[data-name="하위 폴더"]').click();
        await page.locator('#folderEntries [data-name="marker.txt"]').waitFor();
        await page.locator('#folderBreadcrumbs').getByRole('button',{name:'papers',exact:true}).click();
        await page.locator('#folderHidden').check();await page.locator('#folderEntries [data-name=".hidden-folder"]').waitFor();
        await page.locator('#folderHidden').uncheck();await page.locator('#folderEntries [data-name=".hidden-folder"]').waitFor({state:'detached'});
        await page.locator('#folderFilter').fill('same');assert.equal(await page.locator('#folderEntries .folder-entry').count(),1);
        await page.locator('#folderFilter').fill('');
        assert.equal((await (await page.request.get(ready.url+'api/info')).json()).roots.length,1);
        assert.equal((await page.request.get(ready.url+'roots/papers/files/same.txt')).status(),403);
        await page.locator('#folderLocation').fill(path+'/missing');await page.locator('#folderLocationForm button[type="submit"]').click();
        await page.locator('#folderError').waitFor();assert.ok(await page.locator('#chooseFolder').isDisabled());
        await page.locator('#cancelFolder').click();
        assert.equal((await (await page.request.get(ready.url+'api/info')).json()).roots.length,1);
        await page.locator('#browseFolder').click();await page.locator('#folderEntries [data-name="same.txt"]').waitFor();
        await page.locator('#folderUp').click();await page.locator('#folderEntries button[data-name="papers"]').click();await page.locator('#folderEntries [data-name="same.txt"]').waitFor();
        await page.screenshot({path:'/tmp/fbrowse-folder-picker.png'});
      }
      await page.locator('#folderLabel').fill(name);await page.locator('#chooseFolder').click();
      await page.locator('#rootMessage').filter({hasText:'저장했습니다.'}).waitFor();
      await page.locator('#closeRoots').click();
    }
    await register('논문',ready.papers);await register('실험결과',ready.results);
    const options=await page.locator('#rootSelect option').evaluateAll(nodes=>nodes.map(n=>({name:n.textContent,id:n.value})));
    const papers=options.find(o=>o.name==='논문').id,results=options.find(o=>o.name==='실험결과').id;
    async function switchRoot(root){await page.locator('#rootSelect').selectOption(root);await page.locator(`button.row[data-root="${root}"][data-path="same.txt"]`).waitFor();}
    async function openText(expected){
      await page.locator('button.row[data-path="same.txt"]').click();
      await page.frameLocator('#preview').locator('#code').filter({hasText:expected}).waitFor();
      assert.equal(await page.frameLocator('#preview').locator('#code').textContent(),expected);
    }
    await switchRoot('project');await openText('project');await switchRoot(papers);await openText('papers');
    assert.match(page.url(),new RegExp('root='+papers));
    await switchRoot(results);await openText('results');
    await page.goto(ready.url);await page.locator(`#rootSelect option[value="${results}"]:checked`).waitFor({state:'attached'});
    assert.equal(await page.locator('#rootPath').textContent(),ready.results);
    await page.locator('#search').fill('same');await page.locator('.search-result .result-path').filter({hasText:'실험결과'}).waitFor();
    await page.locator('#home').click();await page.locator('button.row[data-path="README.md"]').click();
    const preview=page.frameLocator('#preview');await preview.locator('#markdown table').waitFor();
    assert.equal(await preview.locator('#markdown script').count(),0);
    assert.match(await preview.locator('#markdown a').getAttribute('href'),new RegExp('root='+results));
    await preview.locator('#markdown a').click();await page.frameLocator('#preview').locator('#code').filter({hasText:'results'}).waitFor();
    await page.locator('button.row[data-path="page.html"]').click();
    await preview.locator('h1').waitFor();assert.equal(await preview.locator('h1').evaluate(n=>getComputedStyle(n).color),'rgb(1, 2, 3)');
    assert.equal(await page.evaluate(()=>window.DOCUMENT_SCRIPT_RAN),undefined);
    const before=await page.locator('#fileSidebar').evaluate(n=>n.getBoundingClientRect().width);
    const divider=await page.locator('#sidebarResize').boundingBox();
    await page.mouse.move(divider.x+5,divider.y+100);await page.mouse.down();await page.mouse.move(divider.x+130,divider.y+100);await page.mouse.up();
    assert.ok(await page.locator('#fileSidebar').evaluate(n=>n.getBoundingClientRect().width)>before+60);
    await page.locator('#expandPreview').click();await preview.locator('h1').click();await page.keyboard.press('Escape');
    assert.equal(await page.locator('#viewer').evaluate(n=>n.classList.contains('is-expanded')),false);
    assert.equal(await page.evaluate(()=>document.fullscreenElement),null);
    if(ready.pdfjs){
      await page.locator('button.row[data-path="sample.pdf"]').click();
      await preview.locator('#viewer .page').first().waitFor({timeout:20000});
      assert.match(await page.locator('#preview').getAttribute('src'),/#zoom=page-width/);
      await page.locator('#expandPreview').click();await preview.locator('#viewerContainer').click();await page.keyboard.press('Escape');
      assert.equal(await page.locator('#viewer').evaluate(n=>n.classList.contains('is-expanded')),false);
    }
    await page.locator('#manageRoots').click();
    const record=page.locator('.root-record').filter({hasText:'논문'});
    await record.getByRole('button',{name:'수정',exact:true}).click();
    await page.locator('#rootLabel').fill('참고 논문');await page.locator('#rootDirectory').fill(ready.project);
    await page.locator('#saveRoot').click();await page.locator('#rootMessage').filter({hasText:'저장했습니다.'}).waitFor();
    await page.locator('#closeRoots').click();await switchRoot(papers);await openText('project');
    fs.renameSync(ready.results,ready.results+'-offline');
    await page.locator('#refresh').click();await page.locator('#rootSelect option').filter({hasText:'연결 안 됨'}).waitFor({state:'attached'});
    await page.locator('#rootSelect').selectOption(results);await page.locator('#status').filter({hasText:'연결 안 됨'}).waitFor({state:'attached'});
    await switchRoot('project');await openText('project');
    await page.locator('#manageRoots').click();await page.locator('.root-record').filter({hasText:'참고 논문'}).getByRole('button',{name:'연결 제거'}).click();
    await page.locator('#rootMessage').filter({hasText:'저장했습니다.'}).waitFor();await page.locator('#closeRoots').click();
    assert.equal(await page.locator(`#rootSelect option[value="${papers}"]`).count(),0);
    assert.ok(fs.existsSync(ready.project+'/same.txt'));
    await page.screenshot({path:'/tmp/fbrowse-browser-check.png'});
    // Check actual highlighted glyph positions against the original logical line numbers.
    await page.setViewportSize({width:480,height:900});
    await page.goto(ready.url+'_preview?root=project&path=sample.py');
    await page.waitForFunction(()=>document.querySelectorAll('#code .hljs-keyword').length>=3);
    async function checkLines(label){
      const result=await page.evaluate(async()=>{
        await document.fonts.ready;syncLineNumbers();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        function top(node){const range=document.createRange();range.selectNodeContents(node);return range.getClientRects()[0].top;}
        const words=[...document.querySelectorAll('#code .hljs-keyword')].filter(n=>['def','class'].includes(n.textContent));
        return {deltas:words.map((word,i)=>top(document.querySelector('#lines').children[[2,5,11][i]-1])-top(word)),
          count:document.querySelector('#lines').children.length,preserved:document.querySelector('#code').textContent===data.text,
          wrap:document.querySelector('#source').classList.contains('wrap'),width:innerWidth,scrollWidth:document.querySelector('#source').scrollWidth};
      });
      console.log(label,result);assert.equal(result.count,13);assert.ok(result.preserved);assert.ok(result.deltas.every(n=>Math.abs(n)<=1));
      if(result.wrap)assert.ok(result.scrollWidth<=result.width+1);
    }
    await checkLines('wrapped 480px');await page.locator('#wrap').click();await checkLines('unwrapped');
    await page.locator('#wrap').click();await page.setViewportSize({width:800,height:900});await checkLines('wrapped 800px');
    assert.deepEqual(errors,[]);console.log('PASS: multi-root UI, persistence, preview, boundaries, divider, expansion, wrapping; PDF.js='+ready.pdfjs);
  }finally{
    if(browser)await browser.close();fixture.kill('SIGINT');
    await new Promise(resolve=>{if(fixture.exitCode!==null)resolve();else fixture.once('exit',resolve);});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
