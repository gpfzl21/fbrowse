import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsNative from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {startServer} from '../lib/server.mjs';
import {readConfig} from '../lib/storage.mjs';
async function fixture(run){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'fbrowse-picker-'));
 const keys=['XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_CACHE_HOME'],saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 for(const key of keys)process.env[key]=path.join(base,key);
 const project=path.join(base,'project'),outside=path.join(base,'outside');await fs.mkdir(project);await fs.mkdir(outside);
 const app=await startServer({root:project,pdfjs:false});
 const post=async(route,data,headers={})=>{const response=await fetch(new URL(route,app.url),{method:'POST',headers:{'Content-Type':'application/json','X-Fbrowse-Token':app.info.config_token,...headers},body:JSON.stringify(data)});return {status:response.status,data:await response.json()};};
 const browse=async(directory,scope,extra={})=>(await post('api/folders',{path:directory,scope,...extra})).data;
 const info=async(context,name)=>(await post('api/folder-info',{capability:context.capability,name})).data;
 const action=async(context,action,name,extra={})=>post('api/folder-action',{capability:context.capability,action,name,...extra});
 try{await run({base,project,outside,app,post,browse,info,action});}
 finally{await app.close();for(const key of keys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];await fs.rm(base,{recursive:true,force:true});}
}
test('picker creates files/folders in unregistered directories without implicitly registering them',()=>fixture(async({project,outside,post,browse,action})=>{
 const context=(await browse(outside)).context;assert.equal(context.registered,false);
 assert.equal((await action(context,'create','한글 "file".txt')).status,201);assert.equal(await fs.readFile(path.join(outside,'한글 "file".txt'),'utf8'),'');
 assert.equal((await action(context,'mkdir','new folder')).status,201);
 assert.equal((await action(context,'create','new folder')).status,409);
 for(const name of ['../escape','/escape','a/b','a\\b','.','..'])assert.equal((await action(context,'create',name)).status,400);
 assert.deepEqual(await readConfig(project),{});assert.deepEqual(await fs.readdir(project),[]);
 assert.equal((await post('api/folder-action',{capability:context.capability,action:'create',name:'unauthorized'},{'X-Fbrowse-Token':'wrong'})).status,403);
 assert.equal((await post('api/folder-info',{capability:context.capability,name:'new folder'},{Origin:'https://evil.invalid'})).status,403);
 assert.equal((await post('api/folder-action',{capability:context.capability,action:'create',name:'cross-site'},{'Sec-Fetch-Site':'cross-site'})).status,403);
 assert.equal((await action(context,'mkdir','invalid',{path:'/tmp/elsewhere'})).status,400);
}));
test('picker moves and copies use pinned versions, scopes, existing no-overwrite guards and saved bytes',()=>fixture(async({outside,browse,info,action})=>{
 await fs.mkdir(path.join(outside,'destination'));await fs.writeFile(path.join(outside,'one.txt'),'ORIGINAL');
 const context=(await browse(outside)).context,destination=(await browse(path.join(outside,'destination'),context.capability)).context;
 assert.equal(destination.rootPath,outside);const original=await info(context,'one.txt');
 const moved=await action(context,'move','one.txt',{expected_version:original.version,destination:destination.capability});assert.equal(moved.status,200);assert.equal(moved.data.path,'destination/one.txt');
 const selected=await info(destination,'one.txt');await fs.writeFile(path.join(outside,'one.txt'),'KEEP');
 assert.equal((await action(destination,'move','one.txt',{expected_version:selected.version,destination:context.capability})).status,409);
 const copied=await action(destination,'copy','one.txt',{expected_version:selected.version,destination:context.capability});assert.equal(copied.status,201);assert.notEqual(copied.data.path,'one.txt');
 assert.equal(await fs.readFile(path.join(outside,copied.data.path),'utf8'),'ORIGINAL');
 await fs.writeFile(path.join(outside,'destination/one.txt'),'CHANGED');
 assert.equal((await action(destination,'delete','one.txt',{expected_version:selected.version,confirmed:true})).status,409);
 assert.equal(await fs.readFile(path.join(outside,'destination/one.txt'),'utf8'),'CHANGED');
 assert.equal((await action(context,'move','destination',{expected_version:(await info(context,'destination')).version,destination:destination.capability})).status,403);
}));
test('picker rejects forged/expired capabilities, replaced directory inodes and root registration races',()=>fixture(async({project,outside,post,browse,action,info})=>{
 await fs.mkdir(path.join(outside,'child'));await fs.writeFile(path.join(outside,'child/keep.txt'),'KEEP');
 const context=(await browse(outside)).context,child=(await browse(path.join(outside,'child'),context.capability)).context;
 assert.equal((await action({...context,capability:context.capability+'x'},'create','forged')).status,409);
 await fs.rename(path.join(outside,'child'),path.join(outside,'old-child'));await fs.mkdir(path.join(outside,'child'));
 assert.equal((await action(child,'create','wrong-directory')).status,409);assert.deepEqual(await fs.readdir(path.join(outside,'child')),[]);
 const clock=Date.now;try{Date.now=()=>clock()+31*60*1000;assert.equal((await action(context,'create','expired')).status,409);}finally{Date.now=clock;}
 assert.equal((await post('api/roots',{operation:'add',id:'external',name:'external',path:outside})).status,200);
 assert.equal((await action(context,'create','stale-registry')).status,409);
 const refreshed=(await browse(outside)).context;assert.equal(refreshed.root,'external');
 const parent=(await browse(path.dirname(project))).context,rootInfo=await info(parent,path.basename(project));
 assert.equal((await action(parent,'delete',path.basename(project),{expected_version:rootInfo.version,confirmed:true})).status,409);
 assert.equal((await action(parent,'rename',path.basename(project),{expected_version:rootInfo.version,new_name:'redirect'})).status,409);
}));
test('picker keeps hidden/excluded and symlink boundaries and requires delete confirmation',()=>fixture(async({project,outside,browse,action,info})=>{
 const context=(await browse(project)).context;await fs.writeFile(path.join(outside,'canary'),'CANARY');await fs.symlink(path.join(outside,'canary'),path.join(project,'link'));
 for(const name of ['.env','node_modules','.git'])assert.equal((await action(context,'create',name)).status,403);
 const version=(await info(context,'link')).version;assert.equal((await action(context,'delete','link',{expected_version:version})).status,400);
 assert.equal((await action(context,'delete','link',{expected_version:version,confirmed:true})).status,200);assert.equal(await fs.readFile(path.join(outside,'canary'),'utf8'),'CANARY');
 await fs.symlink(outside,path.join(project,'linked-parent'));const linked=(await browse(path.join(project,'linked-parent'),context.capability)).context;
 assert.equal((await action(linked,'move','canary',{expected_version:(await info(linked,'canary')).version,destination:context.capability})).status,403);
}));
test('picker partial recursive deletion returns structured partial status without pretending atomicity',()=>fixture(async({outside,browse,action,info})=>{
 await fs.mkdir(path.join(outside,'tree'));await fs.writeFile(path.join(outside,'tree/a'),'A');await fs.writeFile(path.join(outside,'tree/b'),'B');
 const context=(await browse(outside)).context,selected=await info(context,'tree');const original=fsNative.unlinkSync;let removed=0;
 fsNative.unlinkSync=target=>{if(String(target).startsWith('/proc/self/fd/')&&removed++)throw Object.assign(Error('injected failure'),{code:'EIO'});return original(target);};syncBuiltinESMExports();
 try{const result=await action(context,'delete','tree',{expected_version:selected.version,confirmed:true});assert.equal(result.status,500);assert.equal(result.data.partial,true);assert.match(result.data.error,/Deletion stopped/);}
 finally{fsNative.unlinkSync=original;syncBuiltinESMExports();}
 assert.equal((await fs.readdir(path.join(outside,'tree'))).length,1);
}));
