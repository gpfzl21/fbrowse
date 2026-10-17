const { previewControl } = require('./workspace-test-helper.cjs');
// Independent physical Chromium interactions; mutations use disposable fixture roots only.
const { fixture, dragTab, groupRect, groupPoint, expandTab } = require('./workspace-test-helper.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
(async () => fixture(async ({ ready, page, register, row, tab, frame, open, dismiss, errors, requests }) => {
  await fs.writeFile(ready.project + '/scroll.txt', ('scroll 한글 tab\tline\n').repeat(500));
  await fs.writeFile(ready.project+'/new-focus.txt','new group fixture\n');
  await register('other', ready.results); await page.goto(ready.url);
  const code = await open('sample.py'); await code.locator('#code .hljs-keyword').first().waitFor();
  const original = await code.locator('#editor').inputValue();
  await code.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\nretained 한글 draft\n');
  const draft = await code.locator('#editor').inputValue();
  await code.locator('#editor').evaluate(node => { node.setSelectionRange(2, 6); document.querySelector('#source').scrollTop = 180; });
  await open('README.md'); const markdown = await frame('README.md'); await markdown.locator('#markdown table').waitFor();
  await open('page.html'); const html = await frame('page.html'); await html.frameLocator('#htmlPreview').locator('h1').waitFor();
  await open('sample.pdf'); const pdf = await frame('sample.pdf');
  assert(ready.pdfjs, 'prepared PDF.js assets required for real PDF coverage');
  await pdf.locator('#viewer .page').first().waitFor({ timeout: 20000 });
  const scroll = await open('scroll.txt'); await scroll.locator('#editor').waitFor();
  await scroll.locator('#source').evaluate(n => n.scrollTop = 500);
  await tab('README.md').locator('.tab-activate').click(); await tab('scroll.txt').locator('.tab-activate').click();
  assert.equal(await scroll.locator('#source').evaluate(n => n.scrollTop), 500, 'same-geometry hide/show preserves scroll');
  await open('same.txt'); await row('sample.py').click(); assert.equal(await tab('sample.py').count(), 1, 'one tab for exact root/path');
  await page.evaluate(() => {
    window.identity = [...document.querySelectorAll('.workspace-slot iframe')].map(frame => {
      const doc = frame.contentDocument, editor = doc.querySelector('#editor');
      const item = { frame, parent: frame.parentNode, win: frame.contentWindow, doc, editor, session: frame.contentWindow.fbrowseEditor?.session,
        value: editor?.value, start: editor?.selectionStart, end: editor?.selectionEnd, loads: 0 };
      frame.addEventListener('load', () => item.loads++); return item;
    });
    window.dragCount = 0; document.addEventListener('dragstart', () => dragCount++);
    window.fullscreenRequests = 0; Element.prototype.requestFullscreen = function(){ fullscreenRequests++; return Promise.resolve(); };
  });
  async function identity(label) {
    assert(await page.evaluate(() => window.identity.every(item => item.frame.isConnected && item.frame.parentNode === item.parent &&
      item.frame.contentWindow === item.win && item.frame.contentDocument === item.doc && item.doc.querySelector('#editor') === item.editor &&
      item.frame.contentWindow.fbrowseEditor?.session === item.session && (!item.editor || (item.editor.value === item.value && item.editor.selectionStart === item.start && item.editor.selectionEnd === item.end)) && !item.loads)),
      'exact iframe/window/document/editor/session/selection/value/load identity: ' + label);
  }
  const visible = () => page.locator('.workspace-slot.is-visible').count();
  const closeRect = (a, b, label) => { for (const key of ['x','y','width','height']) assert(Math.abs(a[key]-b[key]) < 2, label+' '+key); };
  const snapshot = () => page.evaluate(() => JSON.stringify({ layout: state.layout, groups: [...state.groups], activeGroup: state.activeGroup, activeTab: state.activeTab, root: state.root, tabs: state.tabs.map(t=>[t.id,t.group]) }));
  async function split(file, target, edge, count, unaffected = []) {
    const before = await groupRect(page, target), retained = await Promise.all(unaffected.map(f => groupRect(page, f)));
    await dragTab(page, file, groupPoint(page, target, edge), { inspect: async () => {
      const drop = page.locator('#workspaceDrop'); assert(await drop.isVisible()); assert.equal(await drop.getAttribute('data-edge'), edge);
      assert.equal(await drop.getAttribute('data-group'), before.id, 'drop identifies target group');
      const r = await drop.boundingBox();
      assert(r.x >= before.x-2 && r.y >= before.y-2 && r.x+r.width <= before.x+before.width+2 && r.y+r.height <= before.y+before.height+2, 'preview stays inside target');
      assert(Math.abs((['left','right'].includes(edge) ? r.width/before.width : r.height/before.height)-.5)<.06, 'preview halves target group');
    }});
    assert.equal(await visible(), count); assert.equal(await page.locator('.workspace-separator').count(), count-1);
    const moved = await groupRect(page, file), targetAfter = await groupRect(page, target);
    assert.equal(targetAfter.id, before.id, 'target group ID stable'); assert.notEqual(moved.id,before.id);
    if (edge==='left') assert(moved.x+ moved.width <= targetAfter.x+2);
    if (edge==='right') assert(targetAfter.x+targetAfter.width <= moved.x+2);
    if (edge==='top') assert(moved.y+moved.height <= targetAfter.y+2);
    if (edge==='bottom') assert(targetAfter.y+targetAfter.height <= moved.y+2);
    for (let i=0;i<unaffected.length;i++) closeRect(await groupRect(page,unaffected[i]),retained[i], 'unrelated group unchanged '+unaffected[i]);
    await identity('split '+edge+' '+count);
  }
  async function mergeAll() {
    for (;;) {
      const strips = page.locator('.pane-tabs'); if (await strips.count()<=1) return;
      const target = await strips.first().locator('.file-tab').first().getAttribute('data-path');
      const other = strips.nth(1).locator('.file-tab').first(), file = await other.getAttribute('data-path'), root=await other.getAttribute('data-root');
      await dragTab(page,file,groupPoint(page,target),{root});
    }
  }
  // No invisible toolbar/spacer: the very first strip starts at the viewer's top.
  assert.equal(await page.locator('#workspaceTools,.workspace-tools,#workspaceExpand,#splitHorizontal,#splitVertical,#movePane,#mergePanes').count(), 0);
  const top = await page.locator('#viewer').boundingBox(), strip = await page.locator('.pane-tabs').boundingBox();
  assert(Math.abs(strip.y-top.y)<=2, 'tab strip starts directly at preview top');
  const slot = await page.locator('.workspace-slot.is-visible').boundingBox(); assert(Math.abs(slot.y-(strip.y+strip.height))<=2, 'content immediately follows tabs');
  console.log('Workspace: physical six-group nested mixed layout and local geometry');
  await split('sample.py','scroll.txt','right',2);
  await split('sample.pdf','sample.py','bottom',3,['scroll.txt']);
  await split('page.html','scroll.txt','bottom',4,['sample.py','sample.pdf']);
  const four = await Promise.all(['scroll.txt','page.html','sample.py','sample.pdf'].map(f=>groupRect(page,f)));
  assert(four[0].x<four[2].x && four[1].y>four[0].y && four[3].y>four[2].y, 'mixed 2x2 visible rectangles');
  await page.screenshot({path:'/tmp/fbrowse-four-groups-0.9.1.png',fullPage:true});
  await split('README.md','page.html','left',5,['sample.py','sample.pdf']);
  await split('same.txt','sample.pdf','top',6,['page.html','README.md','sample.py']);
  assert.equal(new Set(await page.locator('.pane-tabs').evaluateAll(ns=>ns.map(n=>n.dataset.group))).size,6,'six stable unique group IDs');
  assert.equal(await page.evaluate(()=>dragCount),0,'no competing native browser drag');
  await page.screenshot({path:'/tmp/fbrowse-six-groups-0.9.1.png',fullPage:true});
  const prior = await snapshot(); const rectangles = await Promise.all(['sample.py','sample.pdf','page.html','README.md','same.txt','scroll.txt'].map(f=>groupRect(page,f)));
  for (const cancel of ['Escape','outside','pointercancel']) {
    await dragTab(page,'sample.py',groupPoint(page,'page.html','left'),{ cancel, inspect: async()=>assert(await page.locator('#workspaceDrop').isVisible()) });
    assert.equal(await snapshot(),prior,'cancel preserves entire group model '+cancel);
    for(const [i,f] of ['sample.py','sample.pdf','page.html','README.md','same.txt','scroll.txt'].entries()) closeRect(await groupRect(page,f),rectangles[i],'cancel '+cancel);
    await identity('cancel '+cancel);
  }
  // Every nested divider is keyboard reachable and can cross iframe surfaces.
  const splitIds = await page.locator('.workspace-separator').evaluateAll(ns=>ns.map(n=>n.dataset.split));
  for (const id of splitIds) {
    const handle = page.locator('.workspace-separator[data-split='+JSON.stringify(id)+']');
    await handle.focus(); await page.keyboard.press('Home'); const low=Number(await handle.getAttribute('aria-valuenow'));
    await page.keyboard.press('End'); const high=Number(await handle.getAttribute('aria-valuenow')); assert(high>low,'Home/End adjust '+id);
    const orientation=await handle.getAttribute('aria-orientation'); const back=orientation==='vertical'?'ArrowLeft':'ArrowUp';
    await page.keyboard.press(back); assert(Number(await handle.getAttribute('aria-valuenow'))<high,'arrow adjusts '+id);
    await page.keyboard.press('Home'); for(let i=0;i<15;i++) await page.keyboard.press(orientation==='vertical'?'ArrowRight':'ArrowDown');
    const before=Number(await handle.getAttribute('aria-valuenow')), h=await handle.boundingBox();
    const stableBranches=[];
    for(const file of ['sample.py','sample.pdf','page.html','README.md','same.txt','scroll.txt']) {
      const r=await groupRect(page,file);
      if(orientation==='vertical'?(r.y+r.height<=h.y+1||r.y>=h.y+h.height-1):(r.x+r.width<=h.x+1||r.x>=h.x+h.width-1)) stableBranches.push([file,r]);
    }
    await page.mouse.move(h.x+h.width/2,h.y+h.height/2); await page.mouse.down();
    assert(await page.locator('body').evaluate(n=>n.classList.contains('is-workspace-resizing')),'iframe cover active '+id);
    await page.mouse.move(h.x+h.width/2+(orientation==='vertical'?24:0),h.y+h.height/2+(orientation==='horizontal'?24:0),{steps:12}); await page.mouse.up();
    assert(Number(await handle.getAttribute('aria-valuenow'))>before,'physical divider adjusts '+id);
    assert(!(await page.locator('body').evaluate(n=>n.classList.contains('is-workspace-resizing'))));
    for(const [file,r] of stableBranches) closeRect(await groupRect(page,file),r,'nested resize preserves outside branch '+id);
    const cancellation=await snapshot(), c=await handle.boundingBox();
    await page.mouse.move(c.x+c.width/2,c.y+c.height/2); await page.mouse.down();
    await handle.dispatchEvent('pointercancel',{pointerId:1,pointerType:'mouse',bubbles:true}); await page.mouse.up();
    assert(!(await page.locator('body').evaluate(n=>n.classList.contains('is-workspace-resizing'))),'divider cancel clears iframe cover '+id);
    assert.equal(await snapshot(),cancellation,'divider cancel before movement leaves model unchanged '+id);
  }
  await identity('all nested dividers');

  // Browser viewport changes exercise the workspace and source ResizeObservers.
  for(const width of [1400,1920,1680]) {
    await page.setViewportSize({width,height:1000});
    await code.locator('#lines').evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
    const area=await page.locator('#workspace').boundingBox();
    const boxes=await Promise.all(['sample.py','sample.pdf','page.html','README.md','same.txt','scroll.txt'].map(f=>groupRect(page,f)));
    for(const r of boxes) assert(r.x>=area.x-1 && r.y>=area.y-1 && r.x+r.width<=area.x+area.width+1 && r.y+r.height<=area.y+area.height+1,'all panes contained after resize '+width);
    for(let a=0;a<boxes.length;a++)for(let b=a+1;b<boxes.length;b++) {
      const x=Math.min(boxes[a].x+boxes[a].width,boxes[b].x+boxes[b].width)-Math.max(boxes[a].x,boxes[b].x);
      const y=Math.min(boxes[a].y+boxes[a].height,boxes[b].y+boxes[b].height)-Math.max(boxes[a].y,boxes[b].y);
      assert(x<=1||y<=1,'visible group rectangles never overlap');
    }
    const alignment=await code.locator('#code').evaluate(n=>{
      const offset=n.textContent.indexOf('\n')+1, walker=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let node,left=offset;
      while(node=walker.nextNode()){if(left<node.length)break;left-=node.length;}
      const range=document.createRange();range.setStart(node,left);range.setEnd(node,left+1);
      const second=range.getBoundingClientRect().top;range.selectNodeContents(document.querySelector('#lines span:nth-child(2)'));const gutter=range.getClientRects()[0].top;
      return {delta:Math.abs(second-gutter), firstHeight:document.querySelector('#lines span').getBoundingClientRect().height,line:parseFloat(getComputedStyle(n.parentElement).lineHeight)};
    });
    assert(alignment.delta<=1,'wrapped gutter tracks actual second line after nested resize '+width+' '+JSON.stringify(alignment));
    assert(alignment.firstHeight>alignment.line*2,'long first line wraps in visible nested pane');
  }
  await identity('viewport and source ResizeObservers');
  // The existing group strip has its own compact context menu; no extra toolbar.
  await tab('sample.py').locator('.tab-activate').click(); const menuPrior=await snapshot();
  const groupStrip=tab('sample.py').locator('xpath=parent::*');
  const stripBox=await groupStrip.boundingBox();
  await page.mouse.click(stripBox.x+stripBox.width-3,stripBox.y+stripBox.height/2,{button:'right'});
  assert(await page.getByRole('menuitem',{name:/Expand Current File/}).isVisible()); await page.keyboard.press('Escape');
  assert(await page.locator('#groupMenu').isHidden()); assert.equal(await snapshot(),menuPrior,'cancel group menu preserves layout/context');
  // New opens go into the focused existing group.
  await tab('same.txt').locator('.tab-activate').click(); const focusGroup=(await groupRect(page,'same.txt')).id;
  await open('new-focus.txt'); assert.equal((await groupRect(page,'new-focus.txt')).id,focusGroup); assert.equal(await visible(),6);
  await tab('new-focus.txt').locator('.tab-close').click(); assert.equal(await visible(),6,'closing non-last leaves group');
  for (const [i,file] of ['sample.py','sample.pdf','page.html'].entries()) {
    await tab(file).locator('.tab-activate').click();
    if(file==='page.html')await html.frameLocator('#htmlPreview').locator('h1').click();else if(file==='sample.pdf')await pdf.locator('#viewerContainer').click();else await code.locator('#editor').focus();
    const before=await snapshot(), beforeRects=await Promise.all(['sample.py','sample.pdf','page.html','README.md','same.txt','scroll.txt'].map(f=>groupRect(page,f)));
    await expandTab(page,file,{keyboard:i%2===1}); assert.equal(await visible(),1);
    assert.equal(await page.locator('#workspace').getAttribute('data-expanded-tab'),await tab(file).getAttribute('data-tab'));
    assert.equal(await page.locator('.pane-tabs:visible,.file-tab:visible,#viewerTabs:visible,.workspace-separator:visible').count(),0,'expanded hides every tab strip and separator');
    const expandedViewer=await page.locator('#viewer').boundingBox(), expandedSlot=await page.locator('.workspace-slot.is-visible').boundingBox();
    closeRect(expandedSlot,expandedViewer,'expanded document fills viewer without 38px spacer '+file);
    const exit=page.getByRole('button',{name:'Exit expanded preview · Esc',exact:true});
    assert(await exit.isVisible(),'expanded exit is visible '+file);
    assert.equal(await exit.textContent(),'×');assert.equal(await exit.getAttribute('title'),'Exit expanded preview · Esc');
    assert.equal(await exit.evaluate(node=>node.tagName),'BUTTON','exit remains a native button');
    const exitBox=await exit.boundingBox(),topMargin=exitBox.y-expandedViewer.y,rightMargin=expandedViewer.x+expandedViewer.width-exitBox.x-exitBox.width;
    assert(topMargin>=8&&topMargin<=20&&rightMargin>=8&&rightMargin<=20,'exit lies inside viewer top-right with bounded margins '+file);
    assert(exitBox.width>=28&&exitBox.width<=36&&exitBox.height>=28&&exitBox.height<=36,'exit is compact '+file);
    await exit.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
    assert(await exit.evaluate(node=>node===document.activeElement&&node.matches(':focus-visible')),'exit is keyboard reachable with visible focus '+file);
    assert(await exit.evaluate(node=>{const s=getComputedStyle(node);return s.outlineStyle==='solid'&&parseFloat(s.outlineWidth)>=2&&parseFloat(s.outlineOffset)>=2&&s.outlineColor!==s.backgroundColor;}),'exit has a contrasting focus ring '+file);
    await identity('while expanded '+file);
    await page.screenshot({path:'/tmp/fbrowse-expanded-'+file.replace('.','-')+'-0.9.1.png',fullPage:true});
    if(file==='page.html')await html.frameLocator('#htmlPreview').locator('h1').click();else if(file==='sample.pdf')await pdf.locator('#viewerContainer').click();else await code.locator('#editor').focus();
    await page.keyboard.press('Escape'); assert.equal(await visible(),6); assert.equal(await snapshot(),before,'expand restores full model '+file);
    for(const [j,f] of ['sample.py','sample.pdf','page.html','README.md','same.txt','scroll.txt'].entries())closeRect(await groupRect(page,f),beforeRects[j],'expand restore '+file);
    await identity('expand '+file);
    await expandTab(page,file);await exit.click();
    assert.equal(await visible(),6);assert.equal(await snapshot(),before,'top-right exit click restores full model '+file);
    assert(await exit.isHidden(),'exit is hidden in normal mode '+file);
    for(const [j,f] of ['sample.py','sample.pdf','page.html','README.md','same.txt','scroll.txt'].entries())closeRect(await groupRect(page,f),beforeRects[j],'exit click restore '+file);
    await identity('top-right exit click '+file);
  }
  // Right-clicking a background tab targets that tab, without losing explicit root choice.
  await page.locator('#rootSelect').selectOption('other'); await row('same.txt').waitFor();
  await expandTab(page,'sample.py'); assert.equal(await page.locator('#rootSelect').inputValue(),'other');
  assert.equal(await page.locator('#workspace').getAttribute('data-expanded-tab'),await tab('sample.py').getAttribute('data-tab'));
  await page.locator('#exitExpanded').click(); assert.equal(await page.locator('#rootSelect').inputValue(),'other');
  await page.locator('#rootSelect').selectOption('project'); await row('sample.py').waitFor();
  assert.equal(await page.evaluate(()=>fullscreenRequests),0);
  // Moving a last tab only collapses its local split, preserving unrelated groups.
  const unaffected=await groupRect(page,'scroll.txt'), htmlBefore=await groupRect(page,'page.html');
  await dragTab(page,'README.md',groupPoint(page,'page.html'));
  assert.equal(await visible(),5); closeRect(await groupRect(page,'scroll.txt'),unaffected,'local collapse leaves opposite branch');
  assert.equal((await groupRect(page,'README.md')).id,htmlBefore.id,'center move reaches target');
  // Close an arbitrary last-tab group and require its local sibling to grow only locally.
  const stable=await groupRect(page,'page.html');
  await page.evaluate(()=>{window.identity=window.identity.filter(item=>item.frame.dataset.tab!==state.tabs.find(t=>t.entry.path==='same.txt').id);});
  await tab('same.txt').locator('.tab-activate').click();
  await tab('same.txt').locator('.tab-close').click();
  assert.equal(await page.evaluate(()=>state.activeTab),await tab('sample.pdf').getAttribute('data-tab'),'closing active last tab focuses local sibling, preserving its active context');
  assert.equal(await visible(),4); closeRect(await groupRect(page,'page.html'),stable,'close collapse leaves other branch');
  assert.equal(await page.locator('.workspace-slot iframe').count(),await page.locator('.file-tab').count(),'no orphan frame after collapse');
  await mergeAll(); await identity('local moves collapse to one');
  // Reordering/inserting in a strip never creates a split.
  await dragTab(page,'sample.pdf',async()=>{const r=await page.locator('.pane-tabs .file-tab').first().boundingBox();return{x:r.x+5,y:r.y+r.height/2};});
  assert.equal(await visible(),1); assert.equal(await page.locator('.pane-tabs .file-tab').first().getAttribute('data-path'),'sample.pdf');
  await split('sample.py','scroll.txt','right',2);
  await dragTab(page,'sample.py',async()=>{const r=await tab('sample.pdf').boundingBox();return{x:r.x+4,y:r.y+r.height/2};});
  assert.equal(await visible(),1,'cross-group strip move collapses empty source');
  assert.equal(await page.locator('.pane-tabs .file-tab').first().getAttribute('data-path'),'sample.py');
  await tab('sample.py').locator('.tab-activate').click();
  assert.equal(await code.locator('#editor').inputValue(), draft); await code.locator('#editor').focus();
  await page.keyboard.press('Control+z'); assert.equal(await code.locator('#editor').inputValue(), original, 'native undo survives every physical tab movement');
  await page.keyboard.press('Control+Shift+z'); assert.equal(await code.locator('#editor').inputValue(), draft);
  // Dirty background tabs also protect full navigation; closing/reloading cancel keeps identity.
  await tab('README.md').locator('.tab-activate').click();
  await dismiss(() => page.evaluate(() => location.reload()), 'beforeunload');
  await dismiss(() => tab('sample.py').locator('.tab-close').click());
  await tab('sample.py').locator('.tab-activate').click(); await dismiss(() => page.locator('#refresh').click());
  assert.equal(await code.locator('#editor').inputValue(), draft);
  // Two simultaneously visible files save only the focused right pane, even with parent shortcut.
  await open('same.txt'); const right = await frame('same.txt'); await right.locator('#editor').waitFor();
  await dragTab(page, 'same.txt', groupPoint(page, 'sample.py', 'right')); await right.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' right only');
  await page.keyboard.press('Control+s'); await right.locator('#notice').filter({ hasText: 'Saved.' }).waitFor();
  assert.equal(await fs.readFile(ready.project + '/same.txt', 'utf8'), 'project right only');
  assert.equal(await fs.readFile(ready.project + '/sample.py', 'utf8'), original, 'save never writes left draft');
  await right.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' parent save');
  await page.locator('.workspace-separator').first().focus(); await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !state.tabs.find(t => t.entry.path === 'same.txt').frame.contentWindow.fbrowseEditor.dirty);
  assert.equal(await fs.readFile(ready.project + '/same.txt', 'utf8'), 'project right only parent save');
  // Messages require both the owning Window and exact root/path/session identity.
  const stateBefore = await page.evaluate(() => JSON.stringify(state.tabs.map(t => [t.id, t.editor?.dirty])));
  await page.evaluate(() => {
    const a = state.tabs.find(t => t.entry.path === 'same.txt'), b = state.tabs.find(t => t.entry.path === 'sample.py');
    for (const data of [{ ...a.editor, session: 'stale' }, { ...a.editor, root: 'other' }, { ...a.editor, path: 'wrong.txt' }])
      window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: a.frame.contentWindow, data: { ...data, type: 'fbrowse-editor-state', dirty: true } }));
    window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: b.frame.contentWindow, data: { ...a.editor, type: 'fbrowse-editor-state', dirty: true } }));
  });
  assert.equal(await page.evaluate(() => JSON.stringify(state.tabs.map(t => [t.id, t.editor?.dirty]))), stateBefore);
  await mergeAll(); await page.locator('#rootSelect').selectOption('other'); await row('same.txt').click();
  assert.equal(await page.locator('.file-tab[data-path="same.txt"]').count(), 2);
  const other = await frame('same.txt', 'other'); await other.locator('#info').filter({ hasText: /lines?/ }).waitFor(); assert.equal(await other.locator('#editor').inputValue(), 'other repository change');
  await other.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' other draft');
  await page.locator('#manageRoots').click(); const record = page.locator('.root-record').filter({ hasText: 'other' });
  await dismiss(() => record.getByRole('button', { name: 'Disconnect' }).click());
  await record.getByRole('button', { name: 'Edit', exact: true }).click(); await page.locator('#rootDirectory').fill(ready.project);
  await dismiss(() => page.locator('#saveRoot').click()); await page.locator('#closeRoots').click();
  assert.equal(await other.locator('#editor').inputValue(), 'other repository change other draft');
  await tab('sample.py').locator('.tab-activate').click(); assert.equal(await code.locator('#editor').inputValue(), draft);
  // Sidebar/full-page behavior works when focus is inside nested HTML and PDF viewers.
  await tab('page.html').locator('.tab-activate').click(); const side = page.locator('#sidebarResize'), sb = await side.boundingBox();
  const oldWidth = await page.locator('#fileSidebar').evaluate(n => n.offsetWidth);
  await page.mouse.move(sb.x + 3, sb.y + 90); await page.mouse.down(); await page.mouse.move(sb.x + 100, sb.y + 90, { steps: 10 }); await page.mouse.up();
  assert(await page.locator('#fileSidebar').evaluate(n => n.offsetWidth) > oldWidth + 50);
  for (const file of ['page.html', 'sample.pdf']) {
    await tab(file).locator('.tab-activate').click(); await (await previewControl(page, 'expandPreview')).click();
    if (file.endsWith('html')) await html.frameLocator('#htmlPreview').locator('h1').click(); else await pdf.locator('#viewerContainer').click();
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#viewer').evaluate(n => n.classList.contains('is-expanded')), false);
  }
  // Git diff/root changes retain drafts, and staging never implicitly saves a buffer.
  await tab('sample.py').locator('.tab-activate').click(); await page.locator('#gitTab').click();
  await page.locator('#gitPanel .git-group[data-group="unstaged"] button').filter({has:page.locator('.filename',{hasText:'changes/mixed.txt'})}).click();
  await page.locator('#diffContent').filter({hasText:'working version'}).waitFor();
  assert.equal(await code.locator('#editor').inputValue(),draft);
  await page.locator('#rootSelect').selectOption('other'); await page.waitForFunction(()=>state.root==='other');
  assert.equal(await page.locator('#rootSelect').inputValue(),'other');
  await tab('sample.py').locator('.tab-activate').click(); await page.locator('#gitTab').click();
  const staged=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/git/stage'&&r.request().method()==='POST');
  await page.locator('#gitPanel button[data-action="stage"][data-path="same.txt"]').click(); assert.equal((await staged).status(),200);
  assert.equal(await fs.readFile(ready.project+'/sample.py','utf8'),original); assert.equal(await code.locator('#editor').inputValue(),draft);
  await page.locator('#filesTab').click();
  // Accepting reload asks once and discards only the active scratch editor.
  await tab('same.txt','project').locator('.tab-activate').click(); await fs.writeFile(ready.project+'/reload.txt','reload disk\n'); await page.locator('#home').click();
  await page.locator('#refresh').click(); const scratch=await open('reload.txt'); await scratch.locator('#editor:not([readonly])').waitFor();
  await scratch.locator('#editor').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('scratch draft');
  let confirms=0;const accept=prompt=>{confirms++;prompt.accept();};page.on('dialog',accept);
  await page.locator('#refresh').click(); await scratch.locator('#editor[readonly]').waitFor({state:'hidden'});
  await page.waitForFunction(()=>state.tabs.find(t=>t.entry.path==='reload.txt').frame.contentWindow.document.querySelector('#editor')?.value==='reload disk\n');
  page.off('dialog',accept);assert.equal(confirms,1);assert.equal(await code.locator('#editor').inputValue(),draft);
  // Closing releases the browsing context, rather than retaining orphan editors.
  const closeId = await tab('page.html').getAttribute('data-tab'); await tab('page.html').locator('.tab-close').click();
  assert.equal(await page.locator('iframe[data-tab=' + JSON.stringify(closeId) + ']').count(), 0);
  const count = requests.length; await page.waitForTimeout(500); assert.equal(requests.length, count, 'idle workspace has no polling');
  await page.screenshot({ path: '/tmp/fbrowse-workspace-0.9.1.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: six recursive groups, local physical edge/center/strip drag and collapse, all dividers, cancellation, exact iframe identity, undo, focused saves, dirty guards, root isolation, PDF/HTML Escape and release');
}, { git: true }))().catch(error => { console.error(error); process.exitCode = 1; });
