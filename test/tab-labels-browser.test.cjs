// Real pointer/keyboard input; all files and registered roots are disposable fixtures.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {fixture,dragTab,groupPoint}=require('./workspace-test-helper.cjs');
fixture(async({ready,page,row,tab,frame,open,post})=>{
 const unique='unique/deep/한글 파일.txt',a='alpha/src/index.txt',b='beta/src/index.txt';
 for(const file of [unique,a,b,'src/index.txt','index.txt']){await fs.mkdir(path.dirname(path.join(ready.project,file)),{recursive:true});await fs.writeFile(path.join(ready.project,file),'BASE\n');}
 for(const [id,directory] of [['left',ready.papers],['right',ready.results]]){
  await fs.mkdir(path.join(directory,'alpha/src'),{recursive:true});await fs.writeFile(path.join(directory,a),id);
  assert.equal((await post('api/roots',{operation:'add',id,name:'Shared',path:directory})).status(),200);
 }
 await page.goto(ready.url);
 const expand=async file=>{const parts=file.split('/');for(let i=1;i<parts.length;i++){const node=row(parts.slice(0,i).join('/'));await node.waitFor();if(await node.getAttribute('aria-expanded')!=='true')await node.click();}};
 const openPath=async(file,root='project')=>{if(await page.locator('#rootSelect').inputValue()!==root)await page.locator('#rootSelect').selectOption(root);await expand(file);await open(file);await tab(file,root).locator('.tab-name').waitFor();};
 const label=async(file,description='',root='project')=>{
  const item=tab(file,root);assert.equal(await item.locator('.tab-name').textContent(),file.split('/').pop());
  assert.equal(await item.locator('.tab-description').textContent(),description);assert.equal(await item.locator('.tab-description').isHidden(),!description);
  assert((await item.getAttribute('title')).includes(file));assert((await item.locator('.tab-activate').getAttribute('aria-label')).includes(file));
 };
 await openPath(unique);await label(unique);assert.equal(await tab(unique).locator('.tab-activate').textContent(),'한글 파일.txt');
 assert((await tab(unique).getAttribute('title')).includes(path.join(ready.project,unique)));
 await openPath(a);await label(a);const editor=await frame(a);await editor.locator('#editor:not([readonly])').waitFor();
 await editor.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('DRAFT');await editor.locator('#editor').evaluate(n=>n.setSelectionRange(1,3));
 await page.evaluate(file=>{const tab=state.tabs.find(tab=>tab.entry.path===file);window.labelIdentity={frame:tab.frame,doc:tab.frame.contentDocument,editor:tab.frame.contentDocument.querySelector('#editor'),loads:0};tab.frame.addEventListener('load',()=>labelIdentity.loads++);},a);
 const unchanged=async()=>assert(await page.evaluate(()=>{const x=labelIdentity;return x.frame.isConnected&&x.frame.contentDocument===x.doc&&x.doc.querySelector('#editor')===x.editor&&x.editor.value==='BASE\nDRAFT'&&x.editor.selectionStart===1&&x.editor.selectionEnd===3&&x.loads===0;}),'label updates preserve iframe, editor, draft, selection and load identity');
 await openPath(b);await label(a,'alpha/src');await label(b,'beta/src');await label(unique);await unchanged();
 assert(await tab(a).locator('.tab-description').evaluate(n=>parseFloat(getComputedStyle(n).fontSize)<parseFloat(getComputedStyle(n.parentElement).fontSize)),'hint is smaller than filename');
 await page.screenshot({path:'/tmp/fbrowse-tab-labels-duplicates.png',fullPage:true});
 await dragTab(page,a,groupPoint(page,b,'right'));await label(a,'alpha/src');await label(b,'beta/src');await unchanged();
 await openPath('src/index.txt');await label('src/index.txt','project · src');await label(a,'alpha/src');
 await openPath('index.txt');await label('index.txt','project · /');await unchanged();
 await openPath(a,'left');await openPath(a,'right');await label(a,'Shared [left] · src','left');await label(a,'Shared [right] · src','right');await label(a,'project · alpha/src');await unchanged();
 for(const root of ['left','right'])await tab(a,root).locator('.tab-close').click();await label(a,'alpha/src');
 for(const file of ['src/index.txt','index.txt',b])await tab(file).locator('.tab-close').click();await label(a);await unchanged();
 await openPath(b);await label(a,'alpha/src');
 // Parent-folder rename and file rename update hints immediately without replacing editors.
 await row('alpha').click({button:'right'});await page.locator('#contextRename').click();await page.locator('#fsName').fill('renamed');await page.locator('#fsSubmit').click();
 const renamed='renamed/src/index.txt';await tab(renamed).waitFor();await label(renamed,'renamed/src');await label(b,'beta/src');await unchanged();
 await expand(renamed);await row(renamed).click({button:'right'});await page.locator('#contextRename').click();await page.locator('#fsName').fill('unique.txt');await page.locator('#fsSubmit').click();
 const final='renamed/src/unique.txt';await tab(final).waitFor();await label(final);await label(b);await unchanged();
 await tab(final).locator('.tab-activate').click();await editor.locator('#editor').focus();await page.keyboard.press('Control+End');await page.keyboard.press('Control+z');assert.equal(await editor.locator('#editor').inputValue(),'BASE\n');
 await page.keyboard.press('Control+Shift+z');await page.keyboard.press('Control+s');await page.waitForFunction(file=>!state.tabs.find(tab=>tab.entry.path===file).frame.contentWindow.fbrowseEditor.dirty,final);assert.equal(await fs.readFile(path.join(ready.project,final),'utf8'),'BASE\nDRAFT');
 await page.screenshot({path:'/tmp/fbrowse-tab-labels.png',fullPage:true});
 console.log('PASS: basename-only tabs, shortest distinct folder hints, ancestor/root-level and same-label multi-root collisions, split/close/rename updates, full tooltip/accessibility, stable editor draft/selection/native undo and new-path save');
}).catch(error=>{console.error(error);process.exitCode=1;});
