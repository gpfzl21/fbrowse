// Headless real HTTP actions against disposable repositories and a local bare remote only.
const {chromium}=require(process.env.FBROWSE_PLAYWRIGHT_MODULE||process.argv[2]||'playwright');
const {spawn,execFileSync}=require('node:child_process');
const readline=require('node:readline');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function snapshot(root){
  const result={};
  function visit(relative){for(const item of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){
    if(item.name==='.git')continue;const name=path.join(relative,item.name),full=path.join(root,name);
    if(item.isSymbolicLink())result[name]='link:'+fs.readlinkSync(full);
    else if(item.isDirectory())visit(name);else result[name]=fs.readFileSync(full).toString('base64');
  }}visit('');return result;
}
(async()=>{
  const fixture=spawn(process.execPath,[path.join(__dirname,'browser-fixture.mjs')],{cwd:path.join(__dirname,'..'),stdio:['ignore','pipe','inherit'],env:{...process.env,FBROWSE_GIT_ACTIONS_FIXTURE:'1',FBROWSE_GIT_FIXTURE:'0'}});
  let browser;
  try{
    const ready=await Promise.race([
      new Promise((resolve,reject)=>{readline.createInterface({input:fixture.stdout}).once('line',line=>{try{resolve(JSON.parse(line));}catch(error){reject(error);}});fixture.once('error',reject);fixture.once('exit',code=>reject(Error('Fixture exited: '+code)));}),
      new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture timeout')),60000);timer.unref();}),
    ]);
    // Every direct Git invocation is anchored to fixture output, never this checkout.
    assert.ok(ready.project.startsWith('/tmp/fbrowse-browser-'));assert.ok(ready.remote.startsWith('/tmp/fbrowse-browser-'));
    const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
    const sources=new Map([ready.project,ready.results,ready.papers].map(root=>[root,snapshot(root)]));
    const initialIndex=fs.readFileSync(path.join(ready.project,'.git/index')),initialHead=git(ready.project,'rev-parse','HEAD'),remoteHead=git(ready.remote,'rev-parse','refs/heads/browser-actions'),protectedHead=git(ready.remote,'rev-parse','refs/heads/protected-fixture');
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],posts=[],gets=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/git/')){if(request.method()==='POST')posts.push({action:url.pathname.split('/').pop(),body:request.postDataJSON()});else gets.push(url);}});
    const info=await (await page.request.get(ready.url+'api/info')).json();
    const get=async endpoint=>{const response=await page.request.get(ready.url+'api/git/'+endpoint);assert.equal(response.status(),200);return response.json();};
    const post=async(action,body)=>page.request.post(ready.url+'api/git/'+action,{headers:{'X-Fbrowse-Token':info.config_token},data:body});
    const current=()=>get('context?root=project');
    const action=(kind,file)=>page.locator(`#gitPanel button[data-action="${kind}"][data-path="${file}"]`);
    const changes=()=>page.locator('#gitView-changes').click();
    const refresh=async()=>{const generation=await page.evaluate(()=>state.gitGeneration);await page.locator('#refresh').click();await page.waitForFunction(previous=>state.gitGeneration>previous&&state.git&&state.gitContext&&!state.gitContextLoading,generation);};
    const idle=()=>page.waitForFunction(()=>!state.gitBusy.has(state.root)&&state.git&&state.gitContext&&!state.gitContextLoading);
    const result=()=>page.locator('#gitActionResult');
    await page.goto(ready.url);await page.locator('#entries button[data-path="same.txt"]').waitFor();
    assert.equal(posts.length,0);assert.equal(gets.filter(url=>/context|branches|history/.test(url.pathname)).length,0);
    assert.deepEqual(fs.readFileSync(path.join(ready.project,'.git/index')),initialIndex);assert.equal(git(ready.project,'rev-parse','HEAD'),initialHead);
    await page.locator('#gitTab').click();await idle();
    assert.ok(await page.locator('#gitCommit').isDisabled());assert.match(await page.locator('#gitCommitScope').textContent(),/0개/);
    assert.equal(gets.filter(url=>/branches|history/.test(url.pathname)).length,0);
    await page.locator('#gitView-branches').click();await page.locator('.git-meta').first().waitFor();
    assert.equal(await page.locator('.git-meta').count(),50);
    const branchFirst=await page.locator('.git-meta').first().textContent();await page.locator('.git-pages').getByRole('button',{name:'다음',exact:true}).click();
    await page.waitForFunction(()=>state.gitPages.branches?.offset===50&&!state.gitPages.branches.loading);assert.ok(await page.locator('.git-meta').count()>0);assert.notEqual(await page.locator('.git-meta').first().textContent(),branchFirst);
    await page.locator('#gitView-history').click();await page.waitForFunction(()=>state.gitPages.history&&!state.gitPages.history.loading);
    assert.equal(await page.locator('.git-meta').count(),30);assert.match(await page.locator('.git-meta').first().textContent(),/history entry 62/);
    await page.locator('.git-pages').getByRole('button',{name:'다음',exact:true}).click();await page.waitForFunction(()=>state.gitPages.history.offset===30&&!state.gitPages.history.loading);
    assert.equal(await page.locator('.git-meta').count(),30);await page.locator('.git-pages').getByRole('button',{name:'이전',exact:true}).click();await page.waitForFunction(()=>state.gitPages.history.offset===0&&!state.gitPages.history.loading);
    assert.equal(posts.length,0);await changes();
    // Cancel and Escape are read-only, including the bare remote's refs.
    await page.locator('#gitPush').click();await page.locator('#pushDialog').waitFor();
    assert.equal(await page.locator('#pushBranch').textContent(),'browser-actions');assert.equal(await page.locator('#pushTarget').textContent(),'refs/heads/browser-actions');assert.equal(await page.locator('#pushURL').textContent(),ready.remote);assert.ok(await page.locator('#pushUpstream').isChecked());
    await page.locator('#cancelPush').click();await page.locator('#gitPush').click();await page.keyboard.press('Escape');
    assert.equal(posts.length,0);assert.equal(git(ready.remote,'rev-parse','refs/heads/browser-actions'),remoteHead);
    // Real per-file stage/unstage preserve content and do not include unrelated paths.
    await action('stage','action.txt').click();await idle();await action('unstage','action.txt').waitFor();
    assert.equal(git(ready.project,'diff','--cached','--name-only'),'action.txt');
    assert.match(await page.locator('#gitCommitScope').textContent(),/1개/);
    const stagedPost=posts.find(entry=>entry.action==='stage').body;assert.equal(stagedPost.expectedHead,initialHead);assert.equal(stagedPost.expectedBranch,'browser-actions');assert.equal(typeof stagedPost.expectedIndex,'string');assert.deepEqual(stagedPost.paths,['action.txt']);
    await action('unstage','action.txt').click();await idle();assert.equal(git(ready.project,'diff','--cached','--name-only'),'');
    // External index changes make the displayed expectedIndex stale; server rejects it.
    git(ready.project,'add','unrelated.txt');await action('stage','action.txt').click();await idle();assert.match(await result().textContent(),/실패/);assert.equal(git(ready.project,'diff','--cached','--name-only'),'unrelated.txt');
    await action('unstage','unrelated.txt').click();await idle();
    // Busy UI prevents double submit; failure output is visible and can be retried explicitly.
    const gate=deferred(),started=deferred();let stageCalls=0;
    await page.route('**/api/git/stage',async route=>{stageCalls++;started.resolve();await gate.promise;await route.continue();});
    await action('stage','action.txt').click();await started.promise;assert.ok(await action('stage','action.txt').isDisabled());assert.match(await result().textContent(),/작업 중/);
    gate.resolve();await idle();await page.unroute('**/api/git/stage');assert.equal(stageCalls,1);
    fs.writeFileSync(path.join(ready.project,'.git/hooks/pre-commit'),'#!/bin/sh\nexit 1\n',{mode:0o755});
    await page.locator('#gitCommitMessage').fill('intentional rejected fixture commit');await page.locator('#gitCommit').click();await idle();assert.match(await result().textContent(),/실패/);assert.equal(git(ready.project,'rev-parse','HEAD'),initialHead);assert.equal(git(ready.project,'diff','--cached','--name-only'),'action.txt');
    fs.unlinkSync(path.join(ready.project,'.git/hooks/pre-commit'));
    await page.locator('#gitCommitMessage').fill('browser deliberate staged commit');await page.locator('#gitCommit').click();await idle();
    assert.equal(git(ready.project,'log','-1','--format=%s'),'browser deliberate staged commit');assert.equal(git(ready.project,'show','--format=','--name-only','HEAD'),'action.txt');assert.equal(git(ready.project,'diff','--name-only'),'unrelated.txt');
    assert.equal(await page.locator('#gitCommitMessage').inputValue(),'');assert.match(await result().textContent(),/완료/);
    await page.locator('#gitView-history').click();await page.waitForFunction(()=>state.gitPages.history&&!state.gitPages.history.loading);assert.match(await page.locator('.git-meta').first().textContent(),/browser deliberate staged commit/);await changes();
    await page.locator('#gitPush').click();await page.locator('#confirmPush').click();await idle();assert.equal(git(ready.remote,'rev-parse','refs/heads/browser-actions'),git(ready.project,'rev-parse','HEAD'));
    const push=posts.find(entry=>entry.action==='push').body;assert.equal(push.confirmed,true);assert.equal(push.remote,'origin');assert.equal(push.branch,'browser-actions');assert.equal(push.expectedBranch,'browser-actions');assert.ok(push.expectedHead);assert.equal(push.expectedIndex,undefined);assert.equal(typeof push.expectedPushToken,'string');assert.equal(push.setUpstream,true);assert.equal(git(ready.project,'config','branch.browser-actions.remote'),'origin');
    // Reviewed remote configuration cannot drift between review and final submission.
    await page.locator('#gitPush').click();const reviewedPushToken=await page.evaluate(()=>state.pushReview.context.pushToken);
    git(ready.project,'config','remote.origin.pushurl',ready.alternateRemote);
    const pushedHead=git(ready.remote,'rev-parse','refs/heads/browser-actions');
    const rejectedPush=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/git/push'&&response.request().method()==='POST');
    await page.locator('#confirmPush').click();assert.equal((await rejectedPush).status(),409);await idle();assert.match(await result().textContent(),/실패/);assert.equal(git(ready.remote,'rev-parse','refs/heads/browser-actions'),pushedHead);assert.equal(git(ready.alternateRemote,'rev-parse','refs/heads/browser-actions'),remoteHead);
    assert.equal(posts.filter(entry=>entry.action==='push').at(-1).body.expectedPushToken,reviewedPushToken);
    git(ready.project,'config','--unset','remote.origin.pushurl');await refresh();
    // Register independent hidden-staged and subtree roots through real root API.
    async function register(name,directory){const response=await page.request.post(ready.url+'api/roots',{headers:{'X-Fbrowse-Token':info.config_token},data:{operation:'add',name,path:directory}});assert.equal(response.status(),200);const data=await response.json();return data.roots.find(root=>root.name===name).id;}
    const hidden=await register('Hidden fixture',ready.results),subtree=await register('Subtree fixture',ready.subtree);
    await refresh();
    async function switchRoot(id){await page.locator('#rootSelect').selectOption(id);await page.waitForFunction(root=>state.root===root&&state.git&&state.gitContext&&!state.gitContextLoading,id);}
    await switchRoot(hidden);assert.ok(await page.locator('#gitCommit').isDisabled());assert.equal(await page.locator('#gitPanel [data-path=".hidden-stage.txt"]').count(),0);assert.match(await page.locator('#gitPanel').textContent(),/숨|표시|제외/);
    const hiddenContext=await get('context?root='+hidden);assert.equal(hiddenContext.commitAllowed,false);
    await switchRoot(subtree);assert.ok(await page.locator('#gitCommit').isDisabled());assert.ok(await page.locator('#gitPush').isDisabled());assert.match(await page.locator('#gitPanel').textContent(),/최상위|읽기/);
    // A late context/history response must never repaint another root.
    await switchRoot('project');const late=deferred(),lateStarted=deferred();
    await page.route('**/api/git/history?**',async route=>{if(new URL(route.request().url()).searchParams.get('root')==='project'){lateStarted.resolve();await late.promise;}await route.continue().catch(()=>{});});
    await page.locator('#gitView-history').click();await lateStarted.promise;await switchRoot(hidden);late.resolve();await page.unroute('**/api/git/history?**');await changes();assert.match(await page.locator('.git-branch').textContent(),/browser-actions/);assert.ok(await page.locator('#gitCommit').isDisabled());
    // Finish an original-root mutation after switching; result stays with its owner.
    await switchRoot('project');const mutationGate=deferred(),mutationStarted=deferred();
    await page.route('**/api/git/stage',async route=>{mutationStarted.resolve();await mutationGate.promise;await route.continue();});
    await action('stage','unrelated.txt').click();await mutationStarted.promise;await switchRoot(hidden);mutationGate.resolve();await page.waitForFunction(()=>!state.gitBusy.has('project'));
    assert.equal(await result().count(),0);assert.equal(git(ready.project,'diff','--cached','--name-only'),'unrelated.txt');await page.unroute('**/api/git/stage');
    await switchRoot('project');await result().filter({hasText:'완료'}).waitFor();await action('unstage','unrelated.txt').click();await idle();
    // The visible-file batch is explicit and bounded, and does not include the untracked group.
    await page.locator('[data-batch="unstaged"]').click();await idle();assert.equal(git(ready.project,'diff','--cached','--name-only'),'unrelated.txt');await page.locator('[data-batch="staged"]').click();await idle();
    // Conflict entries cannot be silently included in commit or batch actions.
    await switchRoot(hidden);git(ready.results,'reset','-q','HEAD','--','.hidden-stage.txt');
    const blob=git(ready.results,'rev-parse','HEAD:action.txt');
    execFileSync('git',['-C',ready.results,'update-index','--index-info'],{input:`0 ${'0'.repeat(40)}\taction.txt\n100644 ${blob} 1\taction.txt\n100644 ${blob} 2\taction.txt\n100644 ${blob} 3\taction.txt\n`});
    await refresh();assert.ok(await page.locator('#gitCommit').isDisabled());assert.ok(await action('stage','action.txt').isDisabled());assert.match(await page.locator('#gitPanel').textContent(),/충돌/);
    // A truncated visible staged scope cannot authorize a whole-index commit.
    await switchRoot('project');await action('stage','unrelated.txt').click();await idle();
    await page.route('**/api/git/status?**',async route=>{const response=await route.fetch();const body=await response.json();await route.fulfill({response,json:{...body,truncated:true}});});
    await refresh();await page.locator('#gitCommitMessage').fill('must remain disabled');assert.ok(await page.locator('#gitCommit').isDisabled());assert.match(await page.locator('#gitPanel').textContent(),/전체 스테이징/);
    await page.unroute('**/api/git/status?**');await refresh();await action('unstage','unrelated.txt').click();await idle();
    // An old HEAD is rejected by the real API, leaving index and refs untouched.
    await switchRoot('project');const latest=await current();const stale=await post('stage',{root:'project',paths:['unrelated.txt'],expectedHead:initialHead,expectedBranch:latest.branch,expectedIndex:latest.indexToken});assert.equal(stale.status(),409);assert.equal(git(ready.project,'diff','--cached','--name-only'),'');
    for(const [root,original]of sources)assert.deepEqual(snapshot(root),original,'source files remain unchanged: '+root);
    assert.equal(git(ready.remote,'rev-parse','refs/heads/protected-fixture'),protectedHead);assert.equal(git(ready.alternateRemote,'rev-parse','refs/heads/browser-actions'),remoteHead);
    assert.deepEqual(errors,[]);assert.equal(browser.contexts().flatMap(context=>context.pages()).length,1);
    console.log('Git action browser assertions passed (temporary repos and local bare remote only)');
  }finally{await browser?.close();fixture.kill('SIGTERM');await new Promise(resolve=>{if(fixture.exitCode!==null)return resolve();fixture.once('exit',resolve);});}
})().catch(error=>{console.error(error);process.exitCode=1;});
