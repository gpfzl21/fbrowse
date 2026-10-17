const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {fixture}=require('./workspace-test-helper.cjs');
fixture(async({ready,page,row,tab,open,post,requests})=>{
 for(const name of ['qa-a.txt','qa-b.txt','qa-c.txt','qa-drag.txt','qa-stale.txt','qa-delete-a.txt','qa-delete-b.txt'])await fs.writeFile(path.join(ready.papers,name),'DISK '+name);
 await fs.writeFile(path.join(ready.project,'qa-open.txt'),'BASE\n');await fs.mkdir(path.join(ready.project,'qa-destination'));
 await page.goto(ready.url);const editor=await open('qa-open.txt');await editor.locator('#editor:not([readonly])').waitFor();await editor.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('DRAFT');
 await editor.locator('#editor').evaluate(n=>n.setSelectionRange(1,3));
 await page.evaluate(()=>{const tab=state.tabs.find(tab=>tab.entry.path==='qa-open.txt');window.pickerIdentity={frame:tab.frame,doc:tab.frame.contentDocument,editor:tab.frame.contentDocument.querySelector('#editor')};});
 await page.locator('#manageRoots').click();await page.locator('#browseFolder').click();
 const item=name=>page.locator('#folderEntries .folder-entry').and(page.locator('[data-name='+JSON.stringify(name)+']'));
 const navigate=async directory=>{await page.waitForFunction(()=>folderData&&document.querySelector('#folderEntries').getAttribute('aria-busy')==='false');await page.locator('#folderLocation').fill(directory);await page.locator('#folderLocationForm button[type=submit]').click();await page.waitForFunction(directory=>folderData?.path===directory&&document.querySelector('#folderEntries').getAttribute('aria-busy')==='false',directory);};
 const done=()=>page.waitForFunction(()=>!folderBusy&&!fsOperation);
 const promptReady=()=>page.waitForFunction(()=>document.querySelector('#pickerFsDialog').open&&!document.querySelector('#pickerFsSubmit').disabled&&!document.querySelector('#pickerFsSubmit').hidden);
 const count=()=>requests.filter(r=>new URL(r.url).pathname==='/api/folder-action'&&r.method==='POST').length;
 const action=async(name,action)=>{await item(name).click({button:'right'});await page.locator('#folderMenu [data-picker-action='+action+']').click();};
 const submit=async name=>{await promptReady();if(name!==undefined)await page.locator('#pickerFsName').fill(name);await page.locator('#pickerFsSubmit').click();await done();};
 await navigate(ready.papers);
 await page.locator('#folderNewFolder').click();await submit('qa-새 폴더 "한글"');await item('qa-새 폴더 "한글"').waitFor();
 assert((await fs.stat(path.join(ready.papers,'qa-새 폴더 "한글"'))).isDirectory());
 await action('qa-새 폴더 "한글"','create');await submit('inside.txt');assert.equal(await fs.readFile(path.join(ready.papers,'qa-새 폴더 "한글"/inside.txt'),'utf8'),'');
 await page.locator('#folderNewFile').click();await submit('current.txt');await item('current.txt').waitFor();
 await item('qa-a.txt').click();await item('qa-c.txt').click({modifiers:['Control']});assert.equal(await page.locator('#folderSelectedCount').textContent(),'2 selected');
 await item('qa-c.txt').click({modifiers:['Meta']});assert.equal(await page.locator('#folderSelectedCount').textContent(),'1 selected');
 await item('qa-a.txt').click();await item('qa-c.txt').click({modifiers:['Shift']});assert.equal(await page.locator('#folderSelectedCount').textContent(),'3 selected');
 await item('qa-b.txt').click({button:'right'});assert.equal(await page.locator('#folderSelectedCount').textContent(),'3 selected');assert(await page.locator('#folderMenu [data-picker-action=rename]').isDisabled());await page.keyboard.press('Escape');
 await page.locator('#folderEntries').focus();await page.keyboard.press('Delete');await promptReady();assert.match(await page.locator('#pickerFsDescription').textContent(),/3 targets/);let before=count();await page.locator('#pickerFsCancel').click();assert.equal(count(),before,'cancel sends no mutation');
 await item('current.txt').click();await page.keyboard.press('F2');await submit('renamed.txt');await item('renamed.txt').waitFor();
 // Cut/paste retains frozen identities across flat directory navigation.
 await item('qa-a.txt').click();await item('qa-b.txt').click({modifiers:['Control']});await page.keyboard.press('Control+x');await page.locator('#folderClipboardStatus').filter({hasText:'Cut: 2 ·'}).waitFor();
 await item('qa-새 폴더 "한글"').click();await item('inside.txt').waitFor();await page.locator('#folderEntries').focus();before=count();await page.keyboard.press('Control+v');await done();assert.equal(count(),before+2);await item('qa-a.txt').waitFor();await item('qa-b.txt').waitFor();
 await action('qa-a.txt','duplicate');await submit();assert((await fs.readdir(path.join(ready.papers,'qa-새 폴더 "한글"'))).length===4);
 await page.locator('#folderUp').click();await item('qa-drag.txt').waitFor();await page.locator('#folderFilter').fill('qa-');await item('qa-drag.txt').dragTo(item('qa-새 폴더 "한글"'));await done();await page.waitForFunction(()=>!document.querySelector('#folderEntries [data-name="qa-drag.txt"]'));
 assert.equal(await fs.readFile(path.join(ready.papers,'qa-새 폴더 "한글"/qa-drag.txt'),'utf8'),'DISK qa-drag.txt');
 await item('qa-stale.txt').click();await page.keyboard.press('Control+x');await page.locator('#folderClipboardStatus').filter({hasText:'Cut: 1 ·'}).waitFor();await fs.writeFile(path.join(ready.papers,'qa-stale.txt'),'REPLACED');
 await item('qa-새 폴더 "한글"').click();await item('inside.txt').waitFor();await page.locator('#folderEntries').focus();await page.keyboard.press('Control+v');await done();assert.match(await page.locator('#pickerFsMessage').textContent(),/changed/);await page.locator('#pickerFsCancel').click();assert.equal(await fs.readFile(path.join(ready.papers,'qa-stale.txt'),'utf8'),'REPLACED');
 // Registered paths use exactly the existing in-place editor relocation protocol.
 await navigate(ready.project);await item('qa-open.txt').click();await page.keyboard.press('Control+x');await page.locator('#folderClipboardStatus').filter({hasText:'Cut: 1 ·'}).waitFor();await item('qa-destination').click();await page.locator('#folderEntries .note').waitFor();await page.locator('#folderEntries').focus();await page.keyboard.press('Control+v');await done();await item('qa-open.txt').waitFor();
 assert(await page.evaluate(()=>{const x=pickerIdentity;return x.frame.isConnected&&x.frame.contentDocument===x.doc&&x.editor===x.doc.querySelector('#editor')&&x.editor.selectionStart===1&&x.editor.selectionEnd===3;}));assert.equal(await editor.locator('#editor').inputValue(),'BASE\nDRAFT');
 await item('qa-open.txt').click();await page.keyboard.press('Delete');await promptReady();assert.match(await page.locator('#pickerFsDescription').textContent(),/Unsaved drafts in 1 tab/);before=count();await page.locator('#pickerFsCancel').click();assert.equal(count(),before);
 // Group delete is one confirmation and preserves unrelated open documents.
 await navigate(ready.papers);await item('qa-delete-a.txt').click();await item('qa-delete-b.txt').click({modifiers:['Control']});await page.keyboard.press('Delete');before=count();await submit();assert.equal(count(),before+2);await assert.rejects(fs.stat(path.join(ready.papers,'qa-delete-a.txt')),{code:'ENOENT'});assert.equal(await editor.locator('#editor').inputValue(),'BASE\nDRAFT');
 await item('qa-c.txt').click();await page.keyboard.press('Control+c');await page.locator('#folderClipboardStatus').filter({hasText:'Copy: 1 ·'}).waitFor();await navigate(ready.project);await page.locator('#folderEntries').focus();await page.keyboard.press('Control+v');await done();assert.equal(await fs.readFile(path.join(ready.project,'qa-c.txt'),'utf8'),'DISK qa-c.txt');
 // Folder text fields keep their native shortcuts; filtering drops hidden selection.
 await page.locator('#folderFilter').fill('nothing');await page.locator('#folderFilter').focus();await page.keyboard.press('Control+a');assert.equal(await page.locator('#folderSelectedCount').textContent(),'0 selected');await page.locator('#folderFilter').fill('');
 await page.locator('#cancelFolder').click();await page.locator('#closeRoots').click();await tab('qa-destination/qa-open.txt').waitFor();await editor.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.press('Control+z');assert.equal(await editor.locator('#editor').inputValue(),'BASE\n');await page.keyboard.press('Control+Shift+z');await page.keyboard.press('Control+s');await page.waitForFunction(()=>!state.tabs.find(tab=>tab.entry.path==='qa-destination/qa-open.txt').frame.contentWindow.fbrowseEditor.dirty);assert.equal(await fs.readFile(path.join(ready.project,'qa-destination/qa-open.txt'),'utf8'),'BASE\nDRAFT');
 await page.locator('#manageRoots').click();await page.locator('#browseFolder').click();await navigate(ready.papers);await page.locator('#folderNewFile').click();await promptReady();await page.locator('#pickerFsName').fill('mapping-race.txt');
 assert.equal((await post('api/roots',{operation:'add',id:'race',name:'race',path:ready.results})).status(),200);await page.locator('#pickerFsSubmit').click();await done();assert.match(await page.locator('#pickerFsMessage').textContent(),/changed/);await page.locator('#pickerFsCancel').click();await assert.rejects(fs.stat(path.join(ready.papers,'mapping-race.txt')),{code:'ENOENT'});
 await navigate(path.dirname(ready.project));await item(path.basename(ready.project)).click({button:'right'});await page.locator('#folderMenu [data-picker-action=rename]').click();await submit('must-not-rename');assert.match(await page.locator('#pickerFsMessage').textContent(),/Connected roots/);await page.locator('#pickerFsCancel').click();assert((await fs.stat(ready.project)).isDirectory());
 await navigate(ready.papers);await item('qa-새 폴더 "한글"').click();await item('inside.txt').waitFor();await page.screenshot({path:'/tmp/fbrowse-picker-actions.png',fullPage:true});await page.locator('#chooseFolder').click();await page.locator('#rootPath').filter({hasText:path.join(ready.papers,'qa-새 폴더 "한글"')}).waitFor();assert.equal(await tab('qa-destination/qa-open.txt').count(),1,'creating and registering a folder keeps the existing editor');
 console.log('PASS: unregistered picker create/file/folder/context, Ctrl/Meta/Shift selection, one delete confirmation/cancel, rename/duplicate/cut-paste/native drag, stale version/root guard and editor iframe/selection/draft/undo/new-path save');
}).catch(error=>{console.error(error);process.exitCode=1;});
