const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {fixture}=require('./workspace-test-helper.cjs');
fixture(async({ready,page,row,tab,frame,open})=>{
  for(const name of ['pairs.py','pairs.md','pairs.tex','pairs.txt'])await fs.writeFile(path.join(ready.project,name),'');
  await fs.writeFile(path.join(ready.project,'pairs-readonly.txt'),'one\r\ntwo\n');
  await page.goto(ready.url);
  let view=await open('pairs.py'),editor=view.locator('#editor');await editor.locator('xpath=.').waitFor();
  const reset=async(text='')=>{await editor.fill(text);await editor.focus();await page.keyboard.press('Control+End');};
  const value=()=>editor.inputValue();
  const caret=()=>editor.evaluate(node=>[node.selectionStart,node.selectionEnd]);
  for(const [left,right] of [['(',')'],['[',']'],['{','}'],['"','"'],["'","'"],['`','`']]){
    await reset();await page.keyboard.type(left);assert.equal(await value(),left+right);assert.deepEqual(await caret(),[1,1]);
    await page.keyboard.type('value'+right);assert.equal(await value(),left+'value'+right);assert.deepEqual(await caret(),[7,7]);
    await reset();await page.keyboard.type(left);await page.keyboard.press('Backspace');assert.equal(await value(),'');
  }
  await reset();await page.keyboard.type('([{x}])');assert.equal(await value(),'([{x}])');assert.deepEqual(await caret(),[7,7]);
  await reset();await page.keyboard.type('(hello world');await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');await page.keyboard.press('Control+Delete');
  await page.keyboard.press('End');await page.keyboard.press('ArrowLeft');const afterDelete=await value();await page.keyboard.type(')');assert.equal(await value(),afterDelete,'forward word deletion retains the generated closing delimiter');
  await reset('hello');await page.keyboard.press('Control+a');await page.keyboard.type('{');
  assert.equal(await value(),'{hello}');assert.deepEqual(await caret(),[1,6]);
  await page.keyboard.type('x}');assert.equal(await value(),'{x}');
  await reset(')');await page.keyboard.press('Home');await page.keyboard.type(')');assert.equal(await value(),'))','manually written closers are not swallowed');
  await reset('word');await page.keyboard.press('Home');await page.keyboard.type('(');assert.equal(await value(),'(word','word insertion keeps native typing');
  await reset();await page.keyboard.type("don't");assert.equal(await value(),"don't");
  await reset('\\');await page.keyboard.type('(');assert.equal(await value(),'\\(');
  await reset();await page.keyboard.type('(');await page.keyboard.press('Control+z');assert.equal(await value(),'');
  await page.keyboard.press('Control+Shift+z');assert.equal(await value(),'()','native redo restores the pair');
  await reset();await page.keyboard.insertText('({$');assert.equal(await value(),'({$','paste does not expand delimiters');
  await reset();await page.keyboard.type('$');assert.equal(await value(),'$','code dollars stay native');
  for(const name of ['pairs.md','pairs.tex']){
    view=await open(name);if(name.endsWith('.md'))await view.locator('#mode').click();editor=view.locator('#editor');
    await reset();await page.keyboard.type('$x$');assert.equal(await value(),'$x$');assert.deepEqual(await caret(),[3,3]);
    await reset();await page.keyboard.type('$$');assert.equal(await value(),'$$$$');assert.deepEqual(await caret(),[2,2]);
    await page.keyboard.type('x$$');assert.equal(await value(),'$$x$$');assert.deepEqual(await caret(),[5,5]);
    await reset();await page.keyboard.type('$$');await page.keyboard.press('Backspace');assert.equal(await value(),'');
    await reset('\\');await page.keyboard.type('$');assert.equal(await value(),'\\$');
  }
  view=await open('pairs.txt');editor=view.locator('#editor');await reset();await page.keyboard.type('$');assert.equal(await value(),'$');
  const ime=await page.context().newCDPSession(page);await reset();
  await ime.send('Input.imeSetComposition',{text:'한국',selectionStart:2,selectionEnd:2});await ime.send('Input.insertText',{text:'한국어'});
  assert.equal(await value(),'한국어');await page.keyboard.type('(');assert.equal(await value(),'한국어()');
  await ime.send('Input.imeSetComposition',{text:'한',selectionStart:1,selectionEnd:1});
  await ime.send('Input.imeSetComposition',{text:'한국',selectionStart:2,selectionEnd:2});await ime.send('Input.insertText',{text:'한국어'});
  await page.keyboard.type(')');assert.equal(await value(),'한국어(한국어)','IME inside a generated pair retains the closing delimiter');await ime.detach();
  await reset();await page.keyboard.type('(');await page.keyboard.type('x');await page.keyboard.type(')');
  await page.keyboard.press('Control+s');await page.waitForFunction(()=>state.tabs.find(tab=>tab.entry.path==='pairs.txt').frame.contentWindow.fbrowseEditor.dirty===false);
  assert.equal(await fs.readFile(path.join(ready.project,'pairs.txt'),'utf8'),'(x)');
  await editor.focus();await page.keyboard.press('Control+z');assert.notEqual(await value(),'(x)','undo remains available after save');
  const readonly=await open('pairs-readonly.txt');await readonly.locator('#editor[readonly]').waitFor();
  await readonly.locator('#editor').focus();await page.keyboard.type('(');assert.equal(await readonly.locator('#editor').inputValue(),'one\ntwo\n');
  console.log('PASS: lightweight bracket/quote pairs, tracked closing/deletion, nested/selection input, inline/display math, escape/paste/IME, readonly and native undo/redo/save');
}).catch(error=>{console.error(error);process.exitCode=1;});
