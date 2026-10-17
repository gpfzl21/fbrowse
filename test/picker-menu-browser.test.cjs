const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {fixture}=require('./workspace-test-helper.cjs');
fixture(async({ready,page,requests})=>{
 const directory=path.join(ready.project,'menu-qa');await fs.mkdir(directory);await fs.mkdir(path.join(directory,'child'));
 for(const name of ['a.txt','b.txt'])await fs.writeFile(path.join(directory,name),name);
 await page.goto(ready.url);await page.locator('#manageRoots').click();await page.locator('#browseFolder').click();
 await page.waitForFunction(()=>folderData&&document.querySelector('#folderEntries').getAttribute('aria-busy')==='false');
 await page.locator('#folderLocation').fill(directory);await page.locator('#folderLocationForm button[type=submit]').click();
 await page.waitForFunction(directory=>folderData?.path===directory&&document.querySelector('#folderEntries').getAttribute('aria-busy')==='false',directory);
 const item=name=>page.locator('#folderEntries .folder-entry').and(page.locator('[data-name='+JSON.stringify(name)+']'));
 const menu=page.locator('#folderMenu');
 const show=async name=>{await item(name).click({button:'right',position:{x:12,y:12}});assert(await menu.isVisible());};
 // Both rows are visible without scrolling: a scroll event must not hide this regression.
 const clickEnd=async(name,modifiers=[])=>{const box=await item(name).boundingBox();await item(name).click({position:{x:box.width-12,y:12},modifiers});};
 await show('a.txt');await clickEnd('b.txt');assert(await menu.isHidden(),'clicking another file dismisses the menu');assert.equal(await item('b.txt').getAttribute('aria-pressed'),'true');
 await show('b.txt');await clickEnd('a.txt',['Control']);assert(await menu.isHidden());assert.equal(await page.locator('#folderSelectedCount').textContent(),'2개 선택');
 await show('a.txt');await page.locator('#rootsTitle').click();assert(await menu.isHidden(),'clicking outside the picker panel dismisses the menu');
 await show('a.txt');await page.locator('#folderFilter').click();assert(await menu.isHidden());await page.keyboard.type('b.txt');assert.equal(await item('a.txt').count(),0);await page.locator('#folderFilter').fill('');
 await show('a.txt');await page.locator('#folderLabel').click();assert(await menu.isHidden());assert(await page.locator('#folderLabel').evaluate(n=>n===document.activeElement));
 // A second right click changes the target, while clicks inside the menu still run actions.
 await item('b.txt').click();await show('b.txt');await show('a.txt');await page.locator('#folderMenu [data-picker-action=rename]').click();
 await page.waitForFunction(()=>document.querySelector('#pickerFsDialog').open&&!document.querySelector('#pickerFsSubmit').disabled);
 assert.equal(await page.locator('#pickerFsName').inputValue(),'a.txt');assert(await menu.isHidden());
 await page.locator('#pickerFsCancel').click();
 await item('b.txt').focus();await page.keyboard.press('Shift+F10');assert(await menu.isVisible());await page.keyboard.press('Escape');assert(await menu.isHidden());
 await show('b.txt');await clickEnd('child');await page.waitForFunction(directory=>folderData?.path===directory&&document.querySelector('#folderEntries').getAttribute('aria-busy')==='false',path.join(directory,'child'));assert(await menu.isHidden(),'folder clicks both dismiss and navigate');
 assert.equal(requests.filter(r=>new URL(r.url).pathname==='/api/folder-action'&&r.method==='POST').length,0,'dismissing menus and canceling sends no mutation');
 assert.equal(await fs.readFile(path.join(directory,'b.txt'),'utf8'),'b.txt');
 console.log('PASS: picker menu dismisses on file/folder/control/dialog clicks; modifier selection, navigation, right-click retarget, menu actions and keyboard dismissal remain usable without mutations');
}).catch(error=>{console.error(error);process.exitCode=1;});
