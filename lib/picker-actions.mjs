import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHmac, randomBytes, timingSafeEqual, createHash} from 'node:crypto';
import {failure} from './files.mjs';
import {filesystemAction, filesystemInfo} from './filesystem-actions.mjs';
import {createFile} from './create-file.mjs';

const within=(base,value)=>value===base||value.startsWith(base==='/'?'/':base+'/');
const identity=info=>`${info.dev}:${info.ino}`;
const conflict=()=>failure('폴더나 루트 연결이 변경되었습니다. 목록을 새로 불러온 뒤 다시 선택하세요.',409);
const fields=(data,allowed)=>{
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!allowed.includes(key)))throw failure('Unsupported folder operation options',400);
};

// Stateless, short-lived browsing capabilities bind the canonical boundary and
// the displayed directory inode. They never register a root or grant arbitrary
// absolute-path writes; actions still use the existing fd-anchored primitives.
export function createPickerActions({project,getRoots,showHidden=false}){
  const secret=randomBytes(32);
  const signature=roots=>createHash('sha256').update(JSON.stringify(Object.entries(roots).sort())).digest('hex');
  const sign=value=>createHmac('sha256',secret).update(value).digest('base64url');
  function encode(value){const payload=Buffer.from(JSON.stringify(value)).toString('base64url');return payload+'.'+sign(payload);}
  function decode(token){
    if(typeof token!=='string'||token.length>20000)throw failure('폴더 목록에서 대상을 다시 선택하세요.',400);
    const [body,mac,...extra]=token.split('.'),expected=sign(body||'');
    if(extra.length||typeof mac!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(mac)||mac.length!==expected.length||!timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))throw conflict();
    let value;try{value=JSON.parse(Buffer.from(body,'base64url'));}catch{throw conflict();}
    if(!value||value.expires<Date.now())throw conflict();return value;
  }
  async function canonical(directory){const info=await fs.lstat(directory,{bigint:true});if(!info.isDirectory()||await fs.realpath(directory)!==directory)throw conflict();return identity(info);}
  async function resolve(token){
    const value=decode(token),roots=await getRoots();
    if(signature(roots)!==value.registry||await canonical(value.boundary)!==value.boundaryIdentity||await canonical(value.directory)!==value.directoryIdentity)throw conflict();
    return {...value,roots};
  }
  async function issue(directory,previous,preferred){
    const roots=await getRoots(),matching=Object.entries(roots).filter(([,root])=>within(root.path,directory));
    matching.sort(([a,x],[b,y])=>(a===preferred?-1:b===preferred?1:y.path.length-x.path.length));
    let boundary=matching[0]?.[1].path||directory,root=matching[0]?.[0]||'@picker';
    if(!matching.length&&previous)try{const old=await resolve(previous);if(old.root==='@picker'&&within(old.boundary,directory))boundary=old.boundary;}catch{}
    const parent=path.relative(boundary,directory).split(path.sep).join('/');
    const value={boundary,root,parent,directory,registry:signature(roots),boundaryIdentity:await canonical(boundary),directoryIdentity:await canonical(directory),expires:Date.now()+30*60*1000};
    return {capability:encode(value),root,rootPath:boundary,parent,registered:root!=='@picker'};
  }
  function selected(ctx,name){
    if(typeof name!=='string'||!name||name==='.'||name==='..'||!name.isWellFormed()||/[/\\\0]/.test(name))throw failure('폴더 구분자 없는 이름 하나를 선택하세요.',400);
    return ctx.parent?ctx.parent+'/'+name:name;
  }
  async function info(data){
    fields(data,['capability','name']);const ctx=await resolve(data.capability),relative=selected(ctx,data.name);
    return filesystemInfo(async()=>(await resolve(data.capability)).boundary,relative,ctx.root,showHidden,ctx.boundary);
  }
  async function mutate(data){
    const allowed={create:[],mkdir:[],rename:['new_name','expected_version','editors'],duplicate:['expected_version'],delete:['expected_version','confirmed'],move:['expected_version','destination','editors'],copy:['expected_version','destination']};
    fields(data,['action','capability','name',...(allowed[data?.action]||[])]);
    if(!['create','mkdir','rename','duplicate','delete','move','copy'].includes(data.action))throw failure('Unsupported folder action',400);
    const ctx=await resolve(data.capability),getBoundary=async()=>(await resolve(data.capability)).boundary;
    if(data.action==='create')return createFile(getBoundary,ctx.parent,data.name,ctx.root,showHidden,ctx.boundary);
    if(data.action==='mkdir')return filesystemAction(getBoundary,{action:'mkdir',root:ctx.root,parent:ctx.parent,name:data.name},showHidden,ctx.boundary,project);
    const relative=selected(ctx,data.name),absolute=path.join(ctx.boundary,relative);
    if(['rename','move','delete'].includes(data.action)&&Object.values(ctx.roots).some(root=>within(absolute,root.path)))
      throw failure('연결된 루트 자체나 그 상위 폴더는 이동·이름 변경·삭제할 수 없습니다.',409);
    let destination;
    if(['copy','move'].includes(data.action)){
      destination=await resolve(data.destination);
      if(data.action==='move'&&(ctx.root!==destination.root||ctx.boundary!==destination.boundary))throw failure('이동은 같은 작업 기준 폴더 안에서 가능합니다. 공통 상위 폴더에서 다시 선택하세요.',403);
    }
    const guard=async()=>{const boundary=await getBoundary();if(destination)await resolve(data.destination);return boundary;};
    const payload={action:data.action,root:ctx.root,path:relative,expected_version:data.expected_version};
    if(['move','delete'].includes(data.action))payload.root_path=ctx.boundary;
    if(data.action==='delete')payload.confirmed=data.confirmed;
    if(data.action==='rename')payload.name=data.new_name;
    if(['rename','move'].includes(data.action))payload.editors=data.editors;
    if(data.action==='move')payload.parent=destination.parent;
    if(data.action==='copy')return filesystemAction(async()=>(await resolve(data.destination)).boundary,{
      action:'copy',root:destination.root,root_path:destination.boundary,parent:destination.parent,
      source_root:ctx.root,source_root_path:ctx.boundary,source_path:relative,expected_version:data.expected_version,
    },showHidden,destination.boundary,project,{sourceBoundary:ctx.boundary,getSourceBoundary:guard});
    return filesystemAction(guard,payload,showHidden,ctx.boundary,project);
  }
  return {issue,info,mutate};
}
