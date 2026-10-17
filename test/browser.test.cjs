// Optional browser integration: FBROWSE_PLAYWRIGHT_MODULE=/path/to/playwright node test/browser.test.cjs
// Playwright is optional test tooling; the runtime server uses Node only.
const {chromium}=require(process.env.FBROWSE_PLAYWRIGHT_MODULE||process.argv[2]||'playwright');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const fs=require('node:fs');
const assert=require('node:assert/strict');

(async()=>{
  const fixture=spawn(process.execPath,[__dirname+'/browser-fixture.mjs'],{cwd:__dirname+'/..',stdio:['ignore','pipe','inherit']});
  let browser;
  try{
    const ready=await Promise.race([
      new Promise((resolve,reject)=>{readline.createInterface({input:fixture.stdout}).once('line',line=>{try{resolve(JSON.parse(line));}catch(error){reject(error);}});fixture.once('error',reject);fixture.once('exit',code=>reject(Error('Fixture exited: '+code)));}),
      new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture timeout')),30000);timer.unref();})
    ]);
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const externalRequests=[];
    await page.route('**/*',route=>{
      if(new URL(route.request().url()).origin!==new URL(ready.url).origin){externalRequests.push(route.request().url());return route.abort();}
      return route.continue();
    });
    const originals=new Map(['sample.py','blank-tabs.py','same.txt'].map(file=>[file,fs.readFileSync(ready.project+'/'+file)]));
    const info=await (await page.request.get(ready.url+'api/info')).json();
    assert.equal(info.backend,'node');assert.equal(info.root,ready.project);
    await page.goto(ready.url);
    await page.locator('button.row[data-path="same.txt"]').waitFor();
    // Exercise real temporary files through the tree, search and server picker.
    const treeRow=path=>page.locator('#entries button.row').filter({has:page.locator('.filename')}).and(page.locator('[data-path='+JSON.stringify(path)+']'));
    const iconSamples=[['code.py','code'],['document.PDF','pdf'],['page.htm','html'],['notes.markdown','markdown'],
      ['plain.txt','text'],['unknown <& "한글".mystery','file'],['README','text'],['extensionless','file'],['picture.svg','media'],
      ['a very long filename that must truncate inside the narrow sidebar.txt','text']];
    async function checkIcon(row,type,selector='.icon'){
      const icon=row.locator(selector),svg=icon.locator('svg');
      assert.equal(await icon.count(),1);assert.equal(await svg.count(),1);
      assert.equal(await icon.getAttribute('data-icon'),type);
      assert.equal(await icon.textContent(),'');
      assert.equal(await icon.getAttribute('aria-hidden'),'true');
      assert.equal(await svg.getAttribute('aria-hidden'),'true');assert.equal(await svg.getAttribute('focusable'),'false');
      assert.ok(await icon.getAttribute('title'));
      assert.ok(await svg.locator('path').count());
      assert.equal(await svg.locator('text, image, use, foreignObject, script, title, [href], [tabindex]').count(),0);
      const box=await icon.evaluate(node=>{
        const rect=node.getBoundingClientRect(),svg=node.querySelector('svg'),shape=svg.getBoundingClientRect();
        return {width:rect.width,height:rect.height,svgWidth:shape.width,svgHeight:shape.height,
          color:getComputedStyle(node).color,stroke:getComputedStyle(svg).stroke};
      });
      assert.ok(box.width>=14&&box.width<=22&&box.height>=14&&box.height<=22,JSON.stringify(box));
      assert.ok(box.svgWidth>=14&&box.svgWidth<=22&&box.svgHeight>=14&&box.svgHeight<=22,JSON.stringify(box));
      assert.equal(box.color,box.stroke);
      return svg.innerHTML();
    }
    const closedFolder=await checkIcon(treeRow('icon-fixtures'),'folder');
    assert.equal(await treeRow('icon-fixtures').getAttribute('aria-expanded'),'false');
    await treeRow('icon-fixtures').click();await treeRow('icon-fixtures/code.py').waitFor();
    assert.equal(await treeRow('icon-fixtures').getAttribute('aria-expanded'),'true');
    assert.notEqual(await checkIcon(treeRow('icon-fixtures'),'folder-open'),closedFolder);
    const typeShapes=new Map();
    for(const [name,type] of iconSamples){
      const row=treeRow('icon-fixtures/'+name),shape=await checkIcon(row,type);
      assert.equal(await row.locator('.filename').textContent(),name);
      if(typeShapes.has(type))assert.equal(shape,typeShapes.get(type));else typeShapes.set(type,shape);
      assert.ok((await row.ariaSnapshot()).includes(name.replaceAll('"','\\"'))||(await row.ariaSnapshot()).includes(name));
    }
    assert.equal(new Set(typeShapes.values()).size,7,'File types must remain visually distinguishable');
    const specialName=iconSamples[5][0];
    await treeRow('icon-fixtures/'+specialName).click();
    await page.frameLocator('.workspace-slot.is-visible iframe').locator('#code').filter({hasText:'Unknown extension preview'}).waitFor();
    assert.ok(await treeRow('icon-fixtures/'+specialName).evaluate(node=>node.classList.contains('active')));
    assert.equal(await page.locator('#entries script, #entries img').count(),0);
    await treeRow('icon-fixtures').click();assert.equal(await treeRow('icon-fixtures/code.py').count(),0);
    assert.equal(await checkIcon(treeRow('icon-fixtures'),'folder'),closedFolder);
    await page.locator('#search').fill('icon-fixtures/');await page.locator('#entries .search-result').first().waitFor();
    for(const [name,type] of iconSamples)await checkIcon(treeRow('icon-fixtures/'+name),type);
    const searchLayout=await treeRow('icon-fixtures/code.py').evaluate(node=>({
      name:node.querySelector('.filename').getBoundingClientRect().left,path:node.querySelector('.result-path').getBoundingClientRect().left,
    }));
    assert.ok(Math.abs(searchLayout.name-searchLayout.path)<=2,'Search path aligns with filename');
    assert.deepEqual(externalRequests,[],'Icons must work without remote fonts or assets');
    await page.locator('#home').click();await treeRow('icon-fixtures').click();await treeRow('icon-fixtures/code.py').waitFor();
    await page.locator('#sidebarResize').focus();await page.keyboard.press('Home');
    const themeColors=[];
    for(const colorScheme of ['light','dark']){
      await page.emulateMedia({colorScheme});
      for(const [name,type] of iconSamples)await checkIcon(treeRow('icon-fixtures/'+name),type);
      assert.ok(await page.locator('#entries').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
      assert.ok(await treeRow('icon-fixtures/'+iconSamples.at(-1)[0]).locator('.filename').evaluate(node=>node.scrollWidth>node.clientWidth));
      themeColors.push(await treeRow('icon-fixtures/code.py').locator('.icon').evaluate(node=>getComputedStyle(node).color));
      await treeRow('icon-fixtures').scrollIntoViewIfNeeded();
      await page.screenshot({path:'/tmp/fbrowse-icons-'+colorScheme+'.png'});
    }
    assert.notEqual(themeColors[0],themeColors[1]);
    await page.emulateMedia({colorScheme:'light'});
    // Restore the usual width for the existing divider and preview regressions.
    await page.locator('#sidebarResize').focus();for(let i=0;i<5;i++)await page.keyboard.press('ArrowRight');
    await page.locator('#manageRoots').click();await page.locator('#browseFolder').click();
    await page.locator('#folderEntries [data-name="icon-fixtures"]').click();await page.locator('#folderEntries [data-name="code.py"]').waitFor();
    for(const [name,type] of iconSamples){
      const row=page.locator('#folderEntries .folder-entry').filter({has:page.locator('.folder-entry-name',{hasText:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})});
      await checkIcon(row,type,'.folder-icon');assert.equal(await row.locator('.folder-entry-name').textContent(),name);
      assert.equal(await row.evaluate(node=>node.tagName),'DIV');
    }
    await checkIcon(page.locator('#folderEntries [data-name="empty"]'),'folder','.folder-icon');
    await page.locator('#folderEntries [data-name="empty"]').click();await page.locator('#folderEntries .note').filter({hasText:'빈 폴더'}).waitFor();
    await page.locator('#cancelFolder').click();await page.locator('#closeRoots').click();await page.locator('#home').click();
    assert.deepEqual(externalRequests,[]);
    console.log('PASS: inline SVG icon types/fallback, special names, folder states, search, picker, accessibility, compact light/dark narrow sidebar; screenshots /tmp/fbrowse-icons-{light,dark}.png');
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
      await page.frameLocator('.workspace-slot.is-visible iframe').locator('#code').filter({hasText:expected}).waitFor();
      assert.equal(await page.frameLocator('.workspace-slot.is-visible iframe').locator('#code').textContent(),expected);
      assert.equal(await page.title(),'fbrowse');
    }
    await switchRoot('project');await openText('project');await switchRoot(papers);await openText('papers');
    assert.match(page.url(),new RegExp('root='+papers));
    await switchRoot(results);await openText('results');
    await page.goto(ready.url);await page.locator(`#rootSelect option[value="${results}"]:checked`).waitFor({state:'attached'});
    assert.equal(await page.locator('#rootPath').textContent(),ready.results);
    await page.locator('#search').fill('same');await page.locator('.search-result .result-path').filter({hasText:'실험결과'}).waitFor();
    await page.locator('#home').click();await page.locator('button.row[data-path="README.md"]').click();
    const preview=page.frameLocator('.workspace-slot.is-visible iframe');await preview.locator('#markdown table').waitFor();
    assert.equal(await preview.locator('#markdown script').count(),0);
    assert.equal(await preview.locator('#markdown [onerror], #markdown a[href^="javascript:"]').count(),0);
    assert.equal(await preview.locator('body').evaluate(()=>window.PWNED),undefined);
    const documentLink=preview.getByRole('link',{name:'동일 파일'});
    assert.match(await documentLink.getAttribute('href'),new RegExp('root='+results));
    await documentLink.click();await page.frameLocator('.workspace-slot.is-visible iframe').locator('#code').filter({hasText:'results'}).waitFor();
    await page.locator('button.row[data-path="page.html"]').click();
    const htmlPreview=preview.frameLocator('#htmlPreview');
    await htmlPreview.locator('h1').waitFor();assert.equal(await htmlPreview.locator('h1').evaluate(n=>getComputedStyle(n).color),'rgb(1, 2, 3)');
    assert.equal(await page.evaluate(()=>window.DOCUMENT_SCRIPT_RAN),undefined);
    assert.equal(await page.evaluate(()=>window.EXTERNAL_DOCUMENT_SCRIPT_RAN),undefined);
    assert.equal(await htmlPreview.locator('body').evaluate(()=>window.DOCUMENT_SCRIPT_RAN),undefined);
    const before=await page.locator('#fileSidebar').evaluate(n=>n.getBoundingClientRect().width);
    const divider=await page.locator('#sidebarResize').boundingBox();
    await page.mouse.move(divider.x+5,divider.y+100);await page.mouse.down();await page.mouse.move(divider.x+130,divider.y+100);await page.mouse.up();
    assert.ok(await page.locator('#fileSidebar').evaluate(n=>n.getBoundingClientRect().width)>before+60);
    await page.locator('#expandPreview').click();await htmlPreview.locator('h1').click();await page.keyboard.press('Escape');
    assert.equal(await page.locator('#viewer').evaluate(n=>n.classList.contains('is-expanded')),false);
    assert.equal(await page.evaluate(()=>document.fullscreenElement),null);
    if(ready.pdfjs){
      await page.locator('button.row[data-path="sample.pdf"]').click();
      await preview.locator('#viewer .page').first().waitFor({timeout:20000});
      assert.match(await page.locator('.workspace-slot.is-visible iframe').getAttribute('src'),/#zoom=page-width/);
      await page.locator('#expandPreview').click();await preview.locator('#viewerContainer').click();await page.keyboard.press('Escape');
      assert.equal(await page.locator('#viewer').evaluate(n=>n.classList.contains('is-expanded')),false);
    }else{
      await page.locator('button.row[data-path="sample.pdf"]').click();
      assert.match(await page.locator('.workspace-slot.is-visible iframe').getAttribute('src'),new RegExp('/roots/'+results+'/files/sample.pdf'));
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
    await page.locator('#manageRoots').click();
    await page.locator('#browseFolder').click();
    await page.locator('#folderError').filter({hasText:'프로젝트 폴더를 표시합니다'}).waitFor();
    assert.equal(await page.locator('#folderLocation').inputValue(),ready.project);
    await page.locator('#cancelFolder').click();await page.locator('#closeRoots').click();
    await switchRoot('project');await openText('project');
    await page.locator('#manageRoots').click();await page.locator('.root-record').filter({hasText:'참고 논문'}).getByRole('button',{name:'연결 제거'}).click();
    await page.locator('#rootMessage').filter({hasText:'저장했습니다.'}).waitFor();await page.locator('#closeRoots').click();
    assert.equal(await page.locator(`#rootSelect option[value="${papers}"]`).count(),0);
    assert.ok(fs.existsSync(ready.project+'/same.txt'));
    // Check actual highlighted glyph positions against the original logical line numbers.
    await page.setViewportSize({width:480,height:900});
    await page.goto(ready.url+'_preview?root=project&path=sample.py');
    await page.waitForFunction(()=>document.querySelectorAll('#code .hljs-keyword').length>=3);
    async function checkLines(label,logicalLines=[2,5,11],expectedCount=13){
      const result=await page.evaluate(async logicalLines=>{
        await document.fonts.ready;syncLineNumbers();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        function top(node){const range=document.createRange();range.selectNodeContents(node);return range.getClientRects()[0].top;}
        const words=[...document.querySelectorAll('#code .hljs-keyword')].filter(n=>['def','class'].includes(n.textContent));
        return {deltas:words.map((word,i)=>top(document.querySelector('#lines').children[logicalLines[i]-1])-top(word)),
          count:document.querySelector('#lines').children.length,preserved:document.querySelector('#code').textContent===data.text,
          wrap:document.querySelector('#source').classList.contains('wrap'),width:innerWidth,scrollWidth:document.querySelector('#source').scrollWidth};
      },logicalLines);
      console.log(label,result);assert.equal(result.count,expectedCount);assert.equal(result.deltas.length,logicalLines.length);assert.ok(result.preserved);assert.ok(result.deltas.every(n=>Math.abs(n)<=1));
      if(result.wrap)assert.ok(result.scrollWidth<=result.width+1);
    }
    await checkLines('wrapped 480px');await page.locator('#wrap').click();await checkLines('unwrapped');
    await page.locator('#wrap').click();await page.setViewportSize({width:800,height:900});await checkLines('wrapped 800px');
    await page.setViewportSize({width:240,height:900});await checkLines('wrapped 240px');
    await page.goto(ready.url+'_preview?root=project&path=blank-tabs.py');
    await page.waitForFunction(()=>document.querySelector('#code .hljs-keyword'));
    await checkLines('blank and tab-only lines',[10],13);
    await page.locator('#wrap').click();await checkLines('blank and tab-only lines unwrapped',[10],13);
    await page.locator('#wrap').click();await page.setViewportSize({width:1000,height:900});await checkLines('blank and tab-only lines resized',[10],13);
    await page.goto(ready.url+'_preview?root=project&path=nested%2FREADME.md');
    await page.locator('#markdown h1').waitFor();
    const nestedLink=new URL(await page.getByRole('link',{name:'동일 파일'}).getAttribute('href'),ready.url);
    assert.equal(nestedLink.searchParams.get('root'),'project');assert.equal(nestedLink.searchParams.get('path'),'nested/README.md');
    assert.equal(nestedLink.searchParams.get('link'),'../same.txt');
    const linkedPageReady=page.context().waitForEvent('page');await page.getByRole('link',{name:'동일 파일'}).click();
    const linkedPage=await linkedPageReady;
    await linkedPage.waitForFunction(()=>document.querySelector('.workspace-slot.is-visible iframe')?.contentDocument?.querySelector('#code')?.textContent==='project');
    await linkedPage.close();
    assert.equal(await page.locator('#markdown img').evaluate(n=>n.complete&&n.naturalWidth>0),true);
    assert.equal(await page.locator('#markdown img').getAttribute('src'),ready.url+'roots/project/files/image.svg');
    await page.locator('#mode').click();
    assert.equal(await page.locator('#code').textContent(),fs.readFileSync(ready.project+'/nested/README.md','utf8'));
    // Render delimiters before Markdown consumes backslashes, underscores, & and <.
    // Disallow every external request: KaTeX JS/CSS/fonts must be served locally.
    await page.goto(ready.url+'_preview?root=project&path=math.md');
    await page.locator('#markdown .katex').first().waitFor();
    await page.waitForFunction(()=>!document.querySelector('#markdown').hidden);
    assert.equal(await page.locator('#markdown .katex').count(),15);
    assert.equal(await page.locator('#markdown .katex-display').count(),7);
    const tex=await page.locator('#markdown annotation[encoding="application/x-tex"]').allTextContents();
    assert.ok(tex.includes('a_i + b_i'));assert.ok(tex.includes('\\frac{1}{2} < x \\land y'));
    assert.ok(tex.some(text=>text.startsWith('\\begin{align}')));
    assert.ok(tex.some(text=>text.includes('pmatrix')));
    assert.equal(await page.locator('#markdown table .katex').count(),1);
    assert.equal(await page.locator('#markdown pre .katex, #markdown code .katex').count(),0);
    assert.match(await page.locator('#markdown').textContent(),/가격 \$5 and \$10, 이스케이프 \$20, 미완성 \$x \+ 1/);
    assert.equal(await page.locator('#markdown .math-error').count(),1);
    assert.equal(await page.locator('#markdown a[href^="javascript:"], #markdown img').count(),0);
    assert.equal(await page.evaluate(()=>window.MATH_PWNED),undefined);
    await page.evaluate(()=>document.fonts.ready);
    assert.ok(await page.evaluate(()=>[...document.fonts].some(font=>font.family.includes('KaTeX')&&font.status==='loaded')));
    assert.deepEqual(externalRequests,[]);
    await page.locator('#mode').click();
    assert.equal(await page.locator('#code').textContent(),fs.readFileSync(ready.project+'/math.md','utf8'));
    await page.locator('#mode').click();assert.equal(await page.locator('#markdown .katex').count(),15);
    await page.setViewportSize({width:360,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.goto(ready.url+'_preview?root=project&path=math-environments.md');
    await page.locator('#markdown .katex').first().waitFor();
    assert.equal(await page.locator('#markdown .katex-display').count(),8);
    assert.equal(await page.locator('#markdown .math-error').count(),0);
    await page.goto(ready.url+'_preview?root=project&path=math-broken.md');
    await page.locator('#markdown h1').waitFor({timeout:5000});
    assert.equal(await page.locator('#code').textContent(),fs.readFileSync(ready.project+'/math-broken.md','utf8'));
    await page.route('**/_math_assets/katex.min.js',route=>route.abort());
    await page.goto(ready.url+'_preview?root=project&path=math.md');
    await page.locator('#markdown h1').waitFor();
    await page.locator('#notice').filter({hasText:'일반 Markdown으로 표시합니다'}).waitFor();
    assert.equal(await page.locator('#code').textContent(),fs.readFileSync(ready.project+'/math.md','utf8'));
    await page.unroute('**/_math_assets/katex.min.js');
    // Code-block controls copy only the displayed code, including whitespace and Unicode.
    const snippets=[['bash','printf "한글 $HOME"\n\techo done'],['python','print("<img src=x onerror=alert(1)>")'],['','plain text\n  spaces'],['made-up-language','unknown <&> syntax']];
    const blockSource='Inline `python` stays inline.\n\n'+snippets.map(([language,text])=>'```'+language+'\n'+text+'\n```').join('\n\n');
    fs.writeFileSync(ready.project+'/code-blocks.md',blockSource);
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(ready.url).origin});
    await page.goto(ready.url+'_preview?root=project&path=code-blocks.md');
    const blocks=page.locator('#markdown .markdown-code-block');await blocks.last().waitFor();
    assert.equal(await blocks.count(),snippets.length);assert.equal(await page.locator('#markdown>p code').count(),1);
    for(const [index,[language,text]] of snippets.entries()){
      const block=blocks.nth(index),button=block.getByRole('button',{name:(language||'text')+' 코드 블록 복사',exact:true});
      assert.equal(await block.locator('.code-block-language').textContent(),language||'text');
      assert.equal(await block.locator('pre code').textContent(),text+'\n');
      await button.click();await button.filter({hasText:'복사됨'}).waitFor();
      assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),text+'\n');
      const tools=await block.locator('.code-block-tools').boundingBox(),pre=await block.locator('pre').boundingBox();
      assert.ok(tools.y+tools.height<=pre.y+1,'controls never cover code');
      const badge=await block.locator('.code-block-language').boundingBox(),copy=await button.boundingBox();
      assert.ok(badge.x>=tools.x&&badge.x-tools.x<=16,'language badge is at upper left');
      assert.ok(copy.x-badge.x-badge.width>=8&&copy.x-badge.x-badge.width<=12&&copy.x+copy.width<=tools.x+tools.width-8,'COPY follows language at upper left');
    }
    assert.equal(await page.locator('#markdown img,#markdown script').count(),0,'code remains escaped');
    // Exercise real legacy copying when the embedded browser denies the Clipboard API.
    await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw Error('Denied for test');};});
    await blocks.first().getByRole('button').click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),snippets[0][1]+'\n');
    await page.locator('#mode').click();assert.equal(await page.locator('#code').textContent(),blockSource);
    await page.locator('#mode').click();assert.equal(await blocks.count(),snippets.length,'no duplicate controls after mode switch');
    assert.equal(fs.readFileSync(ready.project+'/code-blocks.md','utf8'),blockSource);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'compact controls fit narrow view');
    console.log('PASS: Markdown language badges, exact per-block clipboard and denied-API fallback, escaped code, narrow layout and mode switching');
    await page.unroute('**/*');
    for(const [file,formatted] of [['highlight-limit.py',true],['large.py',false],['markdown-limit.md',true],['large.md',false]]){
      await page.goto(ready.url+'_preview?root=project&path='+file);
      await page.waitForFunction(()=>window.hljs&&data&&document.querySelector('#code').textContent===data.text);
      if(formatted&&file.endsWith('.py'))await page.locator('#code .hljs-comment').waitFor();
      else if(formatted)await page.locator('#markdown h1').waitFor();
      else {await page.locator('#notice').filter({hasText:'30만 자 이하'}).waitFor();assert.equal(await page.locator('#code span').count(),0);assert.ok(await page.locator('#markdown').isHidden());}
      assert.equal(await page.locator('#code').textContent(),fs.readFileSync(ready.project+'/'+file,'utf8'));
    }
    for(const [file,count] of [['gutter-limit.txt',20000],['many-lines.txt',20001]]){
      await page.goto(ready.url+'_preview?root=project&path='+file);
      await page.waitForFunction(()=>data&&document.querySelector('#code').textContent===data.text);
      assert.equal(await page.locator('#lines span').count(),count===20000?count:0);
      assert.equal(await page.locator('#lines').isHidden(),count>20000);
      assert.equal(await page.locator('#code').textContent(),fs.readFileSync(ready.project+'/'+file,'utf8'));
    }
    for(const [file,original] of originals)assert.deepEqual(fs.readFileSync(ready.project+'/'+file),original);
    assert.deepEqual(errors,[]);console.log('PASS: Node multi-root UI, picker, persistence, sanitation, relative assets, math delimiters/environments/offline fonts, divider, expansion, logical wrapping, formatting/gutter limits; PDF.js='+ready.pdfjs);
  }finally{
    if(browser)await browser.close();fixture.kill('SIGINT');
    await new Promise(resolve=>{if(fixture.exitCode!==null)resolve();else fixture.once('exit',resolve);});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
