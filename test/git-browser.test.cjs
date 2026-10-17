// Optional headless integration: FBROWSE_PLAYWRIGHT_MODULE=/path/to/playwright node test/git-browser.test.cjs
const {chromium}=require(process.env.FBROWSE_PLAYWRIGHT_MODULE||process.argv[2]||'playwright');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');

function sourceSnapshot(directory){
  const found=new Map();
  function visit(relative){
    for(const entry of fs.readdirSync(path.join(directory,relative),{withFileTypes:true})){
      if(entry.name==='.git')continue;
      const name=path.join(relative,entry.name),full=path.join(directory,name);
      if(entry.isSymbolicLink())found.set(name,'link:'+fs.readlinkSync(full));
      else if(entry.isDirectory())visit(name);
      else found.set(name,fs.readFileSync(full));
    }
  }
  visit('');return found;
}
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
(async()=>{
  const fixture=spawn(process.execPath,[path.join(__dirname,'browser-fixture.mjs')],{
    cwd:path.join(__dirname,'..'),stdio:['ignore','pipe','inherit'],env:{...process.env,FBROWSE_GIT_FIXTURE:'1'},
  });
  let browser;
  try{
    const ready=await Promise.race([
      new Promise((resolve,reject)=>{readline.createInterface({input:fixture.stdout}).once('line',line=>{try{resolve(JSON.parse(line));}catch(error){reject(error);}});fixture.once('error',reject);fixture.once('exit',code=>reject(Error('Fixture exited: '+code)));}),
      new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture timeout')),30000);timer.unref();}),
    ]);
    const sources=new Map([ready.project,ready.papers,ready.results].map(root=>[root,sourceSnapshot(root)]));
    const indexes=new Map([ready.project,ready.results].map(root=>[root,fs.readFileSync(path.join(root,'.git/index'))]));
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    let statusRequests=0;
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/git/status')statusRequests++;});
    const row=name=>page.locator('#entries button.row').filter({has:page.locator('.filename',{hasText:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})});
    const change=(group,name)=>page.locator(`#gitPanel .git-group[data-group="${group}"] button`).filter({has:page.locator('.filename',{hasText:name})});
    async function marker(locator,code){await locator.locator('.git-badge').filter({hasText:code}).waitFor();assert.equal(await locator.getAttribute('data-git-status'),code);}
    // A held Git request must not delay the real file listing or preview.
    const heldStatus=deferred(),statusStarted=deferred();
    await page.route('**/api/git/status?**',async route=>{statusStarted.resolve();await heldStatus.promise;await route.continue().catch(()=>{});});
    await page.goto(ready.url);await row('same.txt').waitFor();await statusStarted.promise;
    await row('same.txt').click();await page.frameLocator('.workspace-slot.is-visible iframe').locator('#code').filter({hasText:'project'}).waitFor();
    heldStatus.resolve();await page.unroute('**/api/git/status?**');
    await marker(row('changes'),'!');assert.match(await row('changes').getAttribute('title'),/Changes in subfolders.*Conflict/s);
    await row('changes').click();await marker(row('mixed.txt'),'M');await marker(row('added.txt'),'A');await marker(row('new-name.txt'),'R');await marker(row('conflict.txt'),'!');
    for(const [name,label] of [['mixed.txt','Modified'],['added.txt','Added'],['new-name.txt','Renamed'],['conflict.txt','Conflict']])assert.match(await row(name).getAttribute('title'),new RegExp(label));
    const modifiedColor=await row('mixed.txt').locator('.filename').evaluate(node=>getComputedStyle(node).color);
    const addedColor=await row('added.txt').locator('.filename').evaluate(node=>getComputedStyle(node).color);
    assert.notEqual(modifiedColor,addedColor);
    await marker(row('untracked <& 한글.txt'),'U');
    assert.equal(await row('file-link.txt').locator('.symlink').textContent(),'↗');assert.match(await row('file-link.txt').getAttribute('title'),/same\.txt/);
    await row('file-link.txt').click();await page.frameLocator('.workspace-slot.is-visible iframe').locator('#code').filter({hasText:'project'}).waitFor();
    assert.equal(await row('directory-link').locator('.symlink').textContent(),'↗');
    await row('directory-link').click();
    const alias=page.locator('#entries button[data-path="directory-link/mixed.txt"]');await alias.waitFor();assert.equal(await alias.locator('.git-badge').count(),0);
    for(const name of ['outside-link.txt','broken-link.txt']){
      assert.ok(await row(name).isDisabled());assert.equal(await row(name).locator('.symlink').count(),1);
      assert.match(await row(name).getAttribute('title'),/↗.*(outside-secret|missing-target)/);assert.equal(await row(name).locator('.size').textContent(),'—');
    }
    // Searching uses the same lexical status colors and does not fetch Git again.
    const beforeSearch=statusRequests;await page.locator('#search').fill('mixed.txt');
    await page.locator('#entries .search-result[data-path="changes/mixed.txt"]').waitFor();await marker(row('mixed.txt'),'M');
    assert.equal(await row('mixed.txt').locator('.filename').evaluate(node=>getComputedStyle(node).color),modifiedColor);
    await page.locator('#search').fill('untracked-folder/child');await page.locator('#entries .search-result[data-path="untracked-folder/child.txt"]').waitFor();await marker(row('child.txt'),'U');
    assert.equal(statusRequests,beforeSearch);
    await page.locator('#home').click();await row('same.txt').waitFor();
    await page.locator('#gitTab').click();await page.locator('.git-branch').filter({hasText:'browser-fixture'}).waitFor();
    assert.ok(await page.locator('#entries').isHidden());
    await change('staged','changes/mixed.txt').click();await page.locator('#diffContent').filter({hasText:'staged version'}).waitFor();
    const staged=await page.locator('#diffContent').textContent();assert.match(staged,/<script>window.DIFF_PWNED=1<\/script>/);assert.doesNotMatch(staged,/working version/);
    assert.equal(await page.locator('#diffContent script, #diffContent img').count(),0);assert.equal(await page.evaluate(()=>window.DIFF_PWNED),undefined);
    assert.equal(await page.locator('#diffContent .diff-add').filter({hasText:'+++literal'}).count(),1);
    assert.ok(await page.locator('#diffContent .diff-add').count());assert.ok(await page.locator('#diffContent .diff-delete').count());
    const addColor=await page.locator('#diffContent .diff-add').first().evaluate(node=>getComputedStyle(node).backgroundColor);
    const deleteColor=await page.locator('#diffContent .diff-delete').first().evaluate(node=>getComputedStyle(node).backgroundColor);assert.notEqual(addColor,deleteColor);
    await change('unstaged','changes/mixed.txt').click();await page.locator('#diffContent').filter({hasText:'working version'}).waitFor();
    assert.notEqual(await page.locator('#diffContent').textContent(),staged);assert.equal(await page.locator('#diffContent img').count(),0);
    await page.context().grantPermissions(['clipboard-read','clipboard-write']);
    await page.locator('#copy').click();
    const copied=new URL(await page.evaluate(()=>navigator.clipboard.readText()));assert.equal(copied.searchParams.get('root'),'project');assert.equal(copied.searchParams.get('path'),'changes/mixed.txt');
    await page.locator('#showFile:enabled').waitFor();await page.locator('#showFile').click();
    await page.frameLocator('.workspace-slot.is-visible iframe').locator('#code').filter({hasText:'working version'}).waitFor();
    assert.match(await page.locator('.workspace-slot.is-visible iframe').getAttribute('src'),/root=project&path=changes%2Fmixed.txt/);
    await page.locator('#showDiff').click();await page.locator('#diffContent').filter({hasText:'working version'}).waitFor();
    await page.locator('#expandPreview').click();await page.keyboard.press('Escape');assert.equal(await page.locator('#viewer').evaluate(node=>node.classList.contains('is-expanded')),false);
    await change('staged','changes/new-name.txt').click();await page.locator('#diffContent').filter({hasText:'rename from'}).waitFor();
    assert.match(await change('staged','changes/new-name.txt').textContent(),/old-name.txt → changes\/new-name.txt/);
    assert.equal(await change('staged','changes/deleted.txt').getAttribute('data-git-status'),'D');assert.match(await change('staged','changes/deleted.txt').getAttribute('title'),/Deleted/);
    await change('staged','changes/deleted.txt').click();await page.locator('#diffContent').filter({hasText:'deleted file'}).waitFor();
    await page.waitForFunction(()=>document.querySelector('#showFile').title.includes('deleted'));assert.ok(await page.locator('#showFile').isDisabled());assert.ok(await page.locator('#open').isHidden());
    await change('unstaged','changes/binary.bin').click();await page.locator('#diffMessage').filter({hasText:'Binary'}).waitFor();
    await change('untracked','untracked <& 한글.txt').click();await page.locator('#diffContent').filter({hasText:'window.DIFF_PWNED=3'}).waitFor();
    assert.equal(await page.locator('#diffContent script').count(),0);assert.equal(await page.evaluate(()=>window.DIFF_PWNED),undefined);
    await change('untracked','outside-link.txt').click();await page.locator('#diffContent').filter({hasText:'../outside-secret.txt'}).waitFor();
    assert.doesNotMatch(await page.locator('#diffViewer').textContent(),/OUTSIDE_SECRET_NEVER_RENDER/);assert.ok(await page.locator('#showFile').isDisabled());
    // Number actual file lines from hunk coordinates, including omitted counts,
    // zero-length ranges, EOF markers and multiple hunks far apart in the file.
    const longAddition='+한글\t'+'abcdefghij '.repeat(150);
    const numberedPatch=['diff --git "a/a.txt" "b/a.txt"','--- a/a.txt','+++ b/a.txt',
      '@@ -40,4 +70,5 @@',' context','-old','\\ No newline at end of file',longAddition,'+added',' ',' tail',
      '@@ -100 +130 @@','-previous','+next','@@ -0,0 +1,2 @@','+first','+second',
      '@@ -999999 +0,0 @@','-removed',''].join('\n');
    await page.route('**/api/git/diff?**',route=>route.fulfill({json:{root_id:'project',path:'changes/mixed.txt',staged:false,kind:'diff',text:numberedPatch}}));
    await change('unstaged','changes/mixed.txt').click();await page.locator('#diffContent .diff-old').filter({hasText:'999999'}).waitFor();
    const positions=await page.locator('#diffContent .diff-line').evaluateAll(rows=>rows.map(row=>[row.dataset.oldLine,row.dataset.newLine]));
    assert.deepEqual(positions,[['',''],['',''],['',''],['',''],['40','70'],['41',''],['',''],['','71'],['','72'],['42','73'],['43','74'],['',''],['100',''],['','130'],['',''],['','1'],['','2'],['',''],['999999',''],['','']]);
    assert.equal((await page.locator('#diffContent .diff-code').allTextContents()).join(''),numberedPatch);
    const wrappedRow=page.locator('#diffContent .diff-line[data-new-line="71"]');
    async function checkWrappedNumbers(){
      const measured=await wrappedRow.evaluate(row=>({row:row.getBoundingClientRect().height,number:row.querySelector('.diff-new').getBoundingClientRect().top,code:row.querySelector('.diff-code').getBoundingClientRect().top,line:parseFloat(getComputedStyle(row).lineHeight)}));
      assert.ok(measured.row>measured.line*2);assert.ok(Math.abs(measured.number-measured.code)<1);
      assert.equal(await wrappedRow.locator('.diff-new').textContent(),'71');
      assert.ok(await page.locator('#diffViewer').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    }
    await checkWrappedNumbers();await page.setViewportSize({width:900,height:900});await checkWrappedNumbers();
    await page.locator('#diffWrap').click();
    assert.equal(await page.locator('#diffWrap').getAttribute('aria-pressed'),'false');
    const unwrapped=await wrappedRow.evaluate(row=>({height:row.getBoundingClientRect().height,line:parseFloat(getComputedStyle(row).lineHeight)}));
    assert.ok(Math.abs(unwrapped.height-unwrapped.line)<1);
    await page.locator('#diffViewer').evaluate(node=>node.scrollLeft=500);
    assert.ok(await wrappedRow.locator('.diff-gutter').evaluate(node=>Math.abs(node.getBoundingClientRect().left-document.querySelector('#diffViewer').getBoundingClientRect().left)<1));
    await page.locator('#diffWrap').click();await checkWrappedNumbers();
    await page.setViewportSize({width:1280,height:900});
    assert.deepEqual(await page.locator('#diffContent .diff-line').evaluateAll(rows=>rows.map(row=>[row.dataset.oldLine,row.dataset.newLine])),positions);
    await page.unroute('**/api/git/diff?**');
    // Plain untracked content has current-file line numbers and no original side.
    await change('untracked','untracked <& 한글.txt').click();await page.locator('#diffContent .diff-new').filter({hasText:'1'}).waitFor();
    assert.equal(await page.locator('#diffContent .diff-old').first().textContent(),'');
    // Explicit messages for bounded, empty and failed diffs, using the actual API shape.
    for(const data of [{kind:'empty',text:''},{kind:'diff',text:'+bounded\n',truncated:true},{kind:'unavailable',message:'Temporary failure',text:''},{kind:'diff',text:'+line\n'.repeat(25000),lineLimit:true}]){
      await page.route('**/api/git/diff?**',route=>route.fulfill({json:{root_id:'project',path:'changes/mixed.txt',staged:false,...data}}));
      await change('unstaged','changes/mixed.txt').click();
      await page.locator('#diffMessage').filter({hasText:data.kind==='empty'?'No changes to display':data.truncated||data.lineLimit?'part of the content':'Temporary failure'}).waitFor();
      if(data.lineLimit)assert.equal(await page.locator('#diffContent .diff-line').count(),20000);
      await page.unroute('**/api/git/diff?**');
    }
    const info=await (await page.request.get(ready.url+'api/info')).json();
    for(const [name,directory] of [['Other Git',ready.results],['Plain files',ready.papers]]){
      const response=await page.request.post(ready.url+'api/roots',{headers:{'X-Fbrowse-Token':info.config_token},data:{operation:'add',name,path:directory}});assert.ok(response.ok());
    }
    await page.locator('#refresh').click();await page.locator('#rootSelect option').filter({hasText:'Other Git'}).waitFor({state:'attached'});
    const roots=await (await page.request.get(ready.url+'api/info')).json();
    const other=roots.roots.find(root=>root.path===ready.results).id,plain=roots.roots.find(root=>root.path===ready.papers).id;
    const forced=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/git/status'&&new URL(request.url()).searchParams.get('refresh')==='1');await page.locator('#refresh').click();await forced;
    // A delayed diff and delayed status from project must not affect another root.
    const diffGate=deferred(),diffStarted=deferred(),gitGate=deferred(),gitStarted=deferred();
    await page.route('**/api/git/diff?**',async route=>{diffStarted.resolve();await diffGate.promise;await route.continue().catch(()=>{});});
    await change('unstaged','changes/mixed.txt').click();await diffStarted.promise;
    await page.route('**/api/git/status?**',async route=>{if(new URL(route.request().url()).searchParams.get('root')==='project'){gitStarted.resolve();await gitGate.promise;}await route.continue().catch(()=>{});});
    await page.locator('#refresh').click();await gitStarted.promise;
    await page.locator('#rootSelect').selectOption(other);await page.locator('.git-branch').filter({hasText:'browser-fixture'}).waitFor();
    diffGate.resolve();gitGate.resolve();await page.unroute('**/api/git/diff?**');await page.unroute('**/api/git/status?**');
    assert.ok(await page.locator('#diffViewer').isHidden());assert.ok(await page.locator('#viewerTabs').isHidden());
    assert.equal(await change('unstaged','same.txt').count(),1);assert.equal(await change('unstaged','changes/mixed.txt').count(),0);
    await page.locator('#filesTab').click();await marker(row('same.txt'),'M');assert.equal(await row('changes').locator('.git-badge').count(),0);
    await row('same.txt').click();await page.frameLocator('.workspace-slot.is-visible iframe').locator('#code').filter({hasText:'other repository change'}).waitFor();
    await page.locator('#rootSelect').selectOption(plain);await row('same.txt').waitFor();await page.locator('#gitTab').click();await page.locator('#gitPanel').filter({hasText:'not a Git repository'}).waitFor();
    await page.locator('#filesTab').click();await row('same.txt').click();await page.frameLocator('.workspace-slot.is-visible iframe').locator('#code').filter({hasText:'papers'}).waitFor();
    // Missing Git is optional and never disables the file view.
    await page.route('**/api/git/status?**',route=>route.fulfill({json:{root_id:plain,available:false,reason:'git_unavailable',entries:[]}}));
    await page.locator('#refresh').click();await page.locator('#gitTab').click();await page.locator('#gitPanel').filter({hasText:'Git is unavailable'}).waitFor();await page.locator('#filesTab').click();await row('same.txt').click();
    await page.frameLocator('.workspace-slot.is-visible iframe').locator('#code').filter({hasText:'papers'}).waitFor();await page.unroute('**/api/git/status?**');
    await page.route('**/api/git/status?**',route=>route.fulfill({json:{root_id:plain,available:true,branch:'fixture-status',entries:[],message:'Local filter note <script>window.NOTE_PWNED=1</script>'}}));
    await page.locator('#refresh').click();await page.locator('#gitTab').click();await page.locator('#gitPanel .note').filter({hasText:'Local filter note'}).waitFor();
    assert.equal(await page.locator('#gitPanel script').count(),0);assert.equal(await page.evaluate(()=>window.NOTE_PWNED),undefined);await page.unroute('**/api/git/status?**');
    const idleRequests=statusRequests;await page.waitForTimeout(2300);assert.equal(statusRequests,idleRequests,'Git must not continuously poll');
    for(const [root,snapshot] of sources)assert.deepEqual(sourceSnapshot(root),snapshot,'browser changed source files');
    for(const [root,index] of indexes)assert.deepEqual(fs.readFileSync(path.join(root,'.git/index')),index,'browser changed Git index');
    assert.deepEqual(errors,[]);console.log('PASS: Git groups, branch, colors, escaped staged/unstaged diffs, actual old/new line numbers, wrapping/resizing/sticky gutters, rename/deletion/binary/bounded/error states, symlinks, root races, optional Git, no polling, source/index unchanged');
  }finally{
    if(browser)await browser.close();fixture.kill('SIGINT');
    await new Promise(resolve=>{if(fixture.exitCode!==null)resolve();else fixture.once('exit',resolve);});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
