// Opt-in, real internet + real Orca integration. Uses only its own pages/server.
// Run from an Orca worktree: node test/external-browser-orca.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createExternalBrowser } from '../lib/external-browser.mjs';
import { startServer } from '../lib/server.mjs';

const execute=promisify(execFile), environment={...process.env};
const command=environment.ORCA_CLI_COMMAND||(environment.ORCA_DEV_REPO_ROOT?'orca-dev':process.platform==='linux'?'orca-ide':'orca');
async function cli(...args){
  const {stdout}=await execute(command,[...args,'--json'],{env:environment,timeout:45000,maxBuffer:2*1024*1024});
  const receipt=JSON.parse(stdout);assert.equal(receipt.ok,true);return receipt.result;
}
async function evaluate(page,expression){
  const value=(await cli('eval','--page',page,'--expression',expression)).result;
  try{return JSON.parse(value);}catch{return value;}
}
async function until(check){
  const end=Date.now()+35000;
  while(Date.now()<end){const result=await check();if(result)return result;await delay(150);}
  throw Error('Timed out waiting for the real browser result');
}
async function click(page,name,role='link'){
  const snapshot=await cli('snapshot','--page',page),entry=Object.entries(snapshot.refs).find(([,v])=>v.name===name&&v.role===role);
  assert.ok(entry,'Missing '+role+': '+name);await cli('click','--page',page,'--element','@'+entry[0]);
}
const base=await mkdtemp('/tmp/fbrowse-orca-real-'),root=base+'/project';
const actual=createExternalBrowser(),owned=new Set(),evidence=[],receipts=[];
let app;
try{
  await mkdir(root);await writeFile(root+'/arxiv.md','# Real pages\n\n[ChatTS](https://arxiv.org/abs/2412.03104)\n\n[ReAct](https://arxiv.org/abs/2210.03629)\n');
  process.env.XDG_CONFIG_HOME=base+'/config';
  const externalBrowser={connect:(...args)=>actual.connect(...args),open:async(...args)=>{
    const result=await actual.open(...args);owned.add(result.browser_page_id);receipts.push(result);return result;
  }};
  app=await startServer({root,pdfjs:false,externalBrowser});
  const source=(await cli('tab','create','--worktree','path:'+process.cwd(),'--url',app.url+'?path=arxiv.md')).browserPageId;
  owned.add(source);
  // Creation returns before navigation, so startup discovery is not trapped
  // behind a CLI goto command waiting for its own in-flight network request.
  await until(async()=>await evaluate(source,`typeof fbrowseExternalBrowser==='function'&&fbrowseExternalBrowser()==='orca'&&Boolean(state.tabs[0]?.frame.contentDocument?.querySelector('#markdown a'))&&state.tabs.length===1`));
  await evaluate(source,`(()=>{const t=state.tabs[0];window.originalFrame=t.frame;window.originalDocument=t.frame.contentDocument;const doc=t.frame.contentDocument;const editor=doc.querySelector('#editor');editor.value+='\\nunsaved real-host draft';editor.dispatchEvent(new Event('input',{bubbles:true}));window.originalDraft=editor.value;window.externalNativeCalls=0;window.open=()=>{externalNativeCalls++;throw Error('Unexpected native fallback')};return true})()`);
  const intact=async()=>assert.deepEqual(await evaluate(source,`({same:state.tabs[0].frame===originalFrame&&originalFrame.contentDocument===originalDocument,draft:originalDocument.querySelector('#editor').value===originalDraft,tabs:state.tabs.length,native:externalNativeCalls})`),{same:true,draft:true,tabs:1,native:0});
  const pages=async()=>(await cli('tab','list','--worktree','path:'+process.cwd())).tabs;
  async function verify(action,url,title){
    await cli('tab','switch','--page',source);
    const before=(await pages()).length,index=receipts.length;
    await action();
    await until(async()=>receipts.length>index);
    assert.equal(receipts.length,index+1);
    const target=receipts[index].browser_page_id;
    const content=await until(async()=>{
      const value=await evaluate(target,'({title:document.title,url:location.href,heading:document.querySelector("h1.title")?.textContent,abstract:document.querySelector("blockquote.abstract")?.textContent})');
      return value.heading?.includes(title)&&value.abstract?.length>100?value:null;
    });
    assert.equal(content.url,url);assert.ok(content.title.includes(title));
    assert.equal((await pages()).length,before+1,'one click creates exactly one top-level page');
    if(action.name==='backgroundReAct')assert.equal((await pages()).find(t=>t.browserPageId===source)?.active,true,'background open restores source focus');
    await intact();evidence.push({action:action.name,url,title:content.title,newPages:1,draftRetained:true});
    await cli('tab','close','--page',target);owned.delete(target);
  }
  await verify(async function leftChatTS(){await click(source,'ChatTS');},'https://arxiv.org/abs/2412.03104','ChatTS');
  await verify(async function leftReAct(){await click(source,'ReAct');},'https://arxiv.org/abs/2210.03629','ReAct');
  await cli('tab','switch','--page',source);
  const point=await evaluate(source,`(()=>{const f=state.tabs[0].frame,r=f.getBoundingClientRect(),a=[...f.contentDocument.querySelectorAll('#markdown a')].find(a=>a.textContent==='ReAct').getBoundingClientRect();return {x:r.x+a.x+a.width/2,y:r.y+a.y+a.height/2}})()`);
  await verify(async function backgroundReAct(){
    await cli('mouse','move','--page',source,'--x',String(point.x),'--y',String(point.y));
    await cli('mouse','down','--page',source,'--button','middle');await cli('mouse','up','--page',source,'--button','middle');
  },'https://arxiv.org/abs/2210.03629','ReAct');
  await cli('tab','switch','--page',source);
  const before=(await pages()).length,requests=receipts.length;
  await evaluate(source,`state.tabs[0].frame.contentDocument.addEventListener('contextmenu',event=>{queueMicrotask(()=>{window.lastContextPrevented=event.defaultPrevented;});})`);
  await cli('mouse','move','--page',source,'--x',String(point.x),'--y',String(point.y));
  await cli('mouse','down','--page',source,'--button','right');await cli('mouse','up','--page',source,'--button','right');
  assert.equal(await evaluate(source,'lastContextPrevented'),false);
  assert.equal(await evaluate(source,"!state.tabs[0].frame.contentDocument.querySelector('#webLinkMenu')"),true);
  assert.equal(receipts.length,requests);assert.equal((await pages()).length,before);await intact();
  evidence.push({action:'nativeContextMenu',newOrcaPages:0,extraRequests:0,contextDefaultPrevented:false,draftRetained:true});
  await writeFile('/tmp/fbrowse-external-real-evidence.json',JSON.stringify({cli:command,runtime:(await cli('status')).runtime.appVersion,evidence},null,2)+'\n');
  console.log(JSON.stringify({passed:true,evidence},null,2));
}finally{
  for(const page of owned){try{await cli('tab','close','--page',page);}catch{console.error('Could not close owned test page:',page);}}
  await app?.close();
  if(environment.XDG_CONFIG_HOME===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=environment.XDG_CONFIG_HOME;
  await rm(base,{recursive:true,force:true});
}
