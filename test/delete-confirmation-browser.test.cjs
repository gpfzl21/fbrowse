// A successful deletion should finish its confirmation UI without another dismissal.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {fixture,gate}=require('./workspace-test-helper.cjs');
(async()=>fixture(async({ready,page,row,open,tab,requests})=>{
  for(const name of ['delete-clean.txt','delete-dirty.txt','delete-cancel.txt','delete-failure.txt','delete-uncertain.txt'])await fs.writeFile(ready.project+'/'+name,'baseline');
  for(const name of ['delete-folder','delete-hidden-folder']){
    await fs.mkdir(ready.project+'/'+name);await fs.writeFile(ready.project+'/'+name+'/child.txt','child');
  }
  await page.goto(ready.url);
  const keeper=await open('sample.py');await keeper.locator('#editor:not([readonly])').waitFor();
  const original=await keeper.locator('#editor').inputValue();await keeper.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('\nKEEP DRAFT');
  const draft=await keeper.locator('#editor').inputValue();
  await page.evaluate(()=>{const t=state.tabs[0];window.deleteKeeper={frame:t.frame,doc:t.frame.contentDocument};});
  const count=()=>requests.filter(r=>new URL(r.url).pathname==='/api/fs'&&r.method==='POST').length;
  const prompt=async file=>{
    await row(file).click({button:'right'});await page.locator('#contextDelete').click();
    await page.waitForFunction(()=>document.querySelector('#fsDialog').open&&!document.querySelector('#fsSubmit').disabled);
    assert.equal(await page.locator('#fsTitle').textContent(),'Really delete?');
    assert((await page.locator('#fsDescription').textContent()).includes(file));
  };
  const done=()=>page.waitForFunction(()=>!fsOperation);
  async function deleted(file){
    const before=count();await prompt(file);await page.locator('#fsSubmit').click();await done();
    assert.equal(count(),before+1,'one confirmation sends one mutation');
    assert.equal(await page.locator('#fsDialog').isVisible(),false,'successful deletion must close the warning instead of leaving a second Really delete? dialog');
    assert.equal(await page.locator('#fsProgress').isVisible(),false,'no completed deletion resurfaces through progress');
    assert.match(await page.locator('#status').textContent(),/Deleted permanently:/);
    await assert.rejects(fs.stat(ready.project+'/'+file),{code:'ENOENT'});
  }
  await deleted('delete-clean.txt');
  const dirty=await open('delete-dirty.txt');await dirty.locator('#editor:not([readonly])').waitFor();
  await dirty.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText(' DRAFT');
  await deleted('delete-dirty.txt');assert.equal(await tab('delete-dirty.txt').count(),0);
  const before=count();await prompt('delete-cancel.txt');await page.locator('#fsCancel').click();
  assert.equal(count(),before);assert.equal(await fs.readFile(ready.project+'/delete-cancel.txt','utf8'),'baseline');
  // Hold actual directory deletion responses to inspect visible and hidden progress.
  for(const [file,hide] of [['delete-folder',false],['delete-hidden-folder',true]]){
    const entered=gate(),release=gate();
    await page.route('**/api/fs',async route=>{const response=await route.fetch();entered.release();await release.promise;await route.fulfill({response});});
    await prompt(file);const before=count();await page.locator('#fsSubmit').click();await entered.promise;
    assert.equal(await page.locator('#fsTitle').textContent(),'Deleting…','confirmed directory deletion shows progress, not another warning');
    assert(!/really delete\?/i.test(await page.locator('#fsDescription').textContent()));
    assert(await page.locator('#fsSubmit').isHidden(),'confirmation action is removed during progress');
    if(hide){await page.locator('#fsCancel').click();assert(await page.locator('#fsProgress').isVisible());}
    release.release();await done();await page.unroute('**/api/fs');
    assert.equal(count(),before+1);assert(await page.locator('#fsDialog').isHidden());assert(await page.locator('#fsProgress').isHidden());
    await assert.rejects(fs.stat(ready.project+'/'+file),{code:'ENOENT'});
  }
  // Failures still need visible recovery information and must not claim success.
  await page.route('**/api/fs',route=>route.fulfill({status:409,json:{error:'Target changed before deletion.'}}));
  await prompt('delete-failure.txt');await page.locator('#fsSubmit').click();await done();
  assert(await page.locator('#fsDialog').isVisible());assert.match(await page.locator('#fsMessage').textContent(),/Target changed/);
  assert.equal(await fs.readFile(ready.project+'/delete-failure.txt','utf8'),'baseline');await page.locator('#fsCancel').click();await page.unroute('**/api/fs');
  // A lost response after the disk mutation must remain visible and never retry.
  await page.route('**/api/fs',async route=>{await route.fetch();await route.abort();});
  await prompt('delete-uncertain.txt');const beforeUnknown=count();await page.locator('#fsSubmit').click();await done();
  assert.equal(count(),beforeUnknown+1);assert(await page.locator('#fsDialog').isVisible());assert(await page.locator('#fsSubmit').isHidden());
  assert.equal(await page.locator('#fsTitle').textContent(),'Deletion result unknown');assert.match(await page.locator('#fsMessage').textContent(),/may already have changed/);
  await assert.rejects(fs.stat(ready.project+'/delete-uncertain.txt'),{code:'ENOENT'});await page.locator('#fsCancel').click();await page.unroute('**/api/fs');
  assert.equal(await keeper.locator('#editor').inputValue(),draft);
  assert.equal(await page.evaluate(()=>deleteKeeper.frame.isConnected&&deleteKeeper.frame.contentDocument===deleteKeeper.doc),true);
  await tab('sample.py').locator('.tab-activate').click();await keeper.locator('#editor').focus();await page.keyboard.press('Control+z');
  assert.equal(await keeper.locator('#editor').inputValue(),original,'unrelated draft and undo remain intact');
  console.log('PASS: one delete confirmation, automatic completion dismissal, directory progress/hide, cancel/failure recovery and unrelated draft/undo retention');
}))().catch(error=>{console.error(error);process.exitCode=1;});
