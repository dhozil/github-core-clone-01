import { createHash, randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RepoStore, ZERO, buildTree, parseTree, type GitObject, type TreeEntry } from './src/store.ts';
import { handleGit } from './src/git-http.ts';
import { executeGraphQL } from './src/graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const VIEWER = 'adaiversen';
type AnyObj = Record<string, any>;
type FileEntry = { sha: string; data: Buffer };
type RepoMeta = { id: number; owner: string; name: string; description: string; private: boolean; default_branch: string; labels: Map<string, AnyObj>; issues: Map<number, AnyObj>; pulls: Map<number, AnyObj>; };
const repositories = new Map<string, RepoMeta>();
let issueNumber = 0, commentId = 0;
const keyOf = (o: string, r: string) => `${o.toLowerCase()}/${r.toLowerCase()}`;
const reqId = () => randomBytes(9).toString('hex').toUpperCase();
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string,string> = {}) {
  const rid = reqId();
  if (status === 204) { res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': rid, ...headers }); res.end(); return; }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': rid, ...headers }); res.end(text);
}
function pathOf(req: IncomingMessage): string { try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; } }
async function readBody(req: IncomingMessage): Promise<AnyObj> {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) throw new Error('Invalid JSON');
  const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON');
  return value;
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) throw new Error('Invalid JSON');
  return JSON.parse(raw) as unknown;
}
function repository(owner: string, name: string): RepoMeta | undefined { return repositories.get(keyOf(owner,name)); }
function repoStore(meta: RepoMeta): RepoStore { return new RepoStore(meta.owner, meta.name); }
function repoExists(meta: RepoMeta): boolean { const store=repoStore(meta); return existsSync(`${store.path}/config`); }
function notFound(res: ServerResponse) { sendJson(res,404,{message:'Not Found'}); }
function resolveCommit(meta: RepoMeta, ref?: string): string | undefined {
  const store=repoStore(meta); const refs=store.refs(); const requested=ref || meta.default_branch;
  if (/^[0-9a-f]{40}$/i.test(requested)) return store.object(requested)?.type==='commit' ? requested : undefined;
  return refs.get(requested.startsWith('refs/')?requested:`refs/heads/${requested}`);
}
function flattenTree(store: RepoStore, treeSha: string): Map<string,FileEntry> {
  const files=new Map<string,FileEntry>(); const walk=(sha:string,prefix:string)=>{const obj=store.object(sha);if(!obj||obj.type!=='tree')return;for(const ent of parseTree(obj.data)){const path=prefix?`${prefix}/${ent.name}`:ent.name;if(ent.mode==='40000'||ent.mode==='040000')walk(ent.oid,path);else if(ent.mode!=='160000'){const blob=store.object(ent.oid);if(blob?.type==='blob')files.set(path,{sha:ent.oid,data:blob.data});}}};walk(treeSha,'');return files;
}
function filesAt(meta:RepoMeta, commitSha?:string): Map<string,FileEntry> { if(!commitSha)return new Map();const s=repoStore(meta).object(commitSha);if(!s||s.type!=='commit')return new Map();const m=/^tree ([0-9a-f]{40})/m.exec(s.data.toString());return m?flattenTree(repoStore(meta),m[1]!):new Map(); }
function writeTree(store:RepoStore, files:Map<string,FileEntry>): string {
  type Node={files:Map<string,FileEntry>;dirs:Map<string,Node>};const root:Node={files:new Map(),dirs:new Map()};
  for(const [path,entry] of files){const parts=path.split('/').filter(Boolean);if(!parts.length)continue;let node=root;for(const part of parts.slice(0,-1)){let child=node.dirs.get(part);if(!child){child={files:new Map(),dirs:new Map()};node.dirs.set(part,child);}node=child;}node.files.set(parts[parts.length-1]!,entry);}
  const build=(node:Node):string=>{const entries:TreeEntry[]=[];for(const [name,f] of node.files)entries.push({mode:'100644',name,oid:f.sha});for(const [name,child] of node.dirs)entries.push({mode:'40000',name,oid:build(child)});return store.writeObject({type:'tree',data:buildTree(entries)});};return build(root);
}
function commitTree(meta:RepoMeta, files:Map<string,FileEntry>, message:string, branch:string, parent?:string): {commitSha:string;treeSha:string} {
  const store=repoStore(meta), treeSha=writeTree(store,files), now=Math.floor(Date.now()/1000);
  const parents=parent?`parent ${parent}\n`:'';
  const data=Buffer.from(`tree ${treeSha}\n${parents}author Forge <forge@localhost> ${now} +0000\ncommitter Forge <forge@localhost> ${now} +0000\n\n${message}\n`);
  const commitSha=store.writeObject({type:'commit',data});store.setRef(`refs/heads/${branch}`,commitSha);return {commitSha,treeSha};
}
function commitInfo(store:RepoStore, sha:string) {const obj=store.object(sha);if(!obj||obj.type!=='commit')return null;const text=obj.data.toString();return {sha,commit:{message:text.split('\n\n')[1]?.trimEnd()??''}};}
function getIssue(meta:RepoMeta,n:number){return meta.issues.get(n);}
function apiRepo(pathParts:string[]): RepoMeta | undefined { if(pathParts.length<4||pathParts[0]!=='api'||pathParts[1]!=='v3'||pathParts[2]!=='repos')return;const o=decodeURIComponent(pathParts[3]!),n=decodeURIComponent(pathParts[4]??'');const r=repository(o,n);return r&&repoExists(r)?r:undefined; }

function mergePullForGraphQL(meta: RepoMeta, pull: AnyObj): boolean {
  const currentTip=resolveCommit(meta,pull.base.ref)??pull.base_sha;
  if(pull.state==='closed')return false;
  const baseFiles=filesAt(meta,pull.base_sha),currentFiles=filesAt(meta,currentTip),headFiles=filesAt(meta,pull.head_sha);
  for(const p of new Set([...baseFiles.keys(),...currentFiles.keys(),...headFiles.keys()])){
    const b=baseFiles.get(p)?.sha,c=currentFiles.get(p)?.sha,h=headFiles.get(p)?.sha;
    if(c!==b&&h!==b&&c!==h)return false;
  }
  const merged=new Map(currentFiles);
  for(const p of new Set([...baseFiles.keys(),...headFiles.keys()])){
    const before=baseFiles.get(p),head=headFiles.get(p);if(before?.sha===head?.sha)continue;if(head)merged.set(p,head);else merged.delete(p);
  }
  const result=commitTree(meta,merged,`Squash merge pull request #${pull.number}`,pull.base.ref,currentTip);
  pull.state='closed';pull.merged=true;pull.merged_at=new Date().toISOString();pull.merge_commit_sha=result.commitSha;pull.base.sha=result.commitSha;return true;
}

async function graphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token=process.env.MAKEFUN_SHOP_TOKEN??'';
  if(!token||req.headers.authorization!==`Bearer ${token}`){sendJson(res,401,{message:'Bad credentials'});return;}
  if((req.method??'GET')!=='POST'){sendJson(res,405,{message:'Method Not Allowed'});return;}
  let body:unknown;try{body=await readJson(req);}catch{sendJson(res,400,{message:'Invalid JSON'});return;}
  const result=executeGraphQL(body,{
    viewer:VIEWER,
    repositories,
    repository:(owner,name)=>repository(owner,name),
    resolveBranch:(meta,ref)=>resolveCommit(meta as RepoMeta,ref),
    pullFiles:(meta,pull)=>{
      const m=meta as RepoMeta,before=filesAt(m,pull.base_sha),after=filesAt(m,pull.head_sha);
      return [...after.keys()].filter(path=>before.get(path)?.sha!==after.get(path)?.sha).concat([...before.keys()].filter(path=>!after.has(path)));
    },
    mergePull:(meta,pull)=>mergePullForGraphQL(meta as RepoMeta,pull),
    nextIssueNumber:()=>++issueNumber,
    nextCommentId:()=>++commentId,
  });
  sendJson(res,200,result);
}

async function rest(req:IncomingMessage,res:ServerResponse):Promise<void>{
  const url=new URL(req.url??'/', 'http://entry'), path=url.pathname, method=req.method??'GET';
  const parts=path.split('/').filter(Boolean); const token=process.env.MAKEFUN_SHOP_TOKEN??'';
  if((path==='/api/v3'||path.startsWith('/api/v3/')) && (!token||req.headers.authorization!==`Bearer ${token}`)){sendJson(res,401,{message:'Bad credentials'});return;}
  if(method==='GET'&&(path==='/api/v3'||path==='/api/v3/')){sendJson(res,200,{current_user_url:'/api/v3/user',rate_limit_url:'/api/v3/rate_limit'},{'x-oauth-scopes':'repo, read:org'});return;}
  if(method==='GET'&&path==='/api/v3/meta'){sendJson(res,200,{installed_version:'3.0.0'});return;}
  if(method==='POST'&&path==='/api/v3/user/repos'){
    let b:AnyObj;try{b=await readBody(req);}catch{sendJson(res,400,{message:'Invalid JSON'});return;}
    if(typeof b.name!=='string'||!/^[A-Za-z0-9_.-]+$/.test(b.name)){sendJson(res,422,{message:'Validation Failed'});return;}
    const owner=VIEWER,name=b.name,key=keyOf(owner,name);if(repository(owner,name)){sendJson(res,422,{message:'Repository already exists'});return;}
    const meta:RepoMeta={id:repositories.size+1,owner,name,description:typeof b.description==='string'?b.description:'',private:b.private!==false,default_branch:typeof b.default_branch==='string'?b.default_branch:'main',labels:new Map(),issues:new Map(),pulls:new Map()};
    new RepoStore(owner,name).create();repositories.set(key,meta);sendJson(res,201,{id:repositories.size,name,full_name:`${owner}/${name}`,owner:{login:owner},private:meta.private,default_branch:meta.default_branch,description:meta.description});return;
  }
  if(method==='GET'&&path==='/api/v3/user/repos'){
    const all=[...repositories.values()].filter(r=>r.owner.toLowerCase()===VIEWER).sort((a,b)=>a.name.localeCompare(b.name));const per=Math.max(1,Math.min(100,Number(url.searchParams.get('per_page'))||30)),page=Math.max(1,Number(url.searchParams.get('page'))||1),start=(page-1)*per,items=all.slice(start,start+per).map(r=>repoJson(r));const headers:Record<string,string>={};if(start+per<all.length){const origin=`${url.protocol}//${req.headers.host??'localhost'}`,next=new URL(path,origin);next.searchParams.set('per_page',String(per));next.searchParams.set('page',String(page+1));headers.link=`<${next.toString()}>; rel="next"`;}sendJson(res,200,items,headers);return;
  }
  if(parts[0]!=='api'||parts[1]!=='v3'){notFound(res);return;}
  if(parts[2]==='repos'){
    const owner=decodeURIComponent(parts[3]??''),name=decodeURIComponent(parts[4]??''),meta=repository(owner,name);
    // A same-named repository owned by somebody else is intentionally invisible.
    if(!meta||owner.toLowerCase()!==VIEWER||!repoExists(meta)){notFound(res);return;}
    const tail=parts.slice(5).map(decodeURIComponent), base=`/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    if(tail.length===0){
      if(method==='GET'){sendJson(res,200,repoJson(meta));return;}
      if(method==='PATCH'){let b:AnyObj;try{b=await readBody(req);}catch{sendJson(res,400,{message:'Invalid JSON'});return;}if(typeof b.description==='string')meta.description=b.description;if(typeof b.private==='boolean')meta.private=b.private;sendJson(res,200,repoJson(meta));return;}
      if(method==='DELETE'){repositories.delete(keyOf(owner,name));const s=repoStore(meta);rmSync(s.path,{recursive:true,force:true});sendJson(res,204,null);return;}
    }
    if(tail[0]==='git'&&tail[1]==='refs'&&method==='POST'){
      let b:AnyObj;try{b=await readBody(req);}catch{sendJson(res,400,{message:'Invalid JSON'});return;}const ref=String(b.ref??''),sha=String(b.sha??'');if(!ref.startsWith('refs/heads/')||repoStore(meta).object(sha)?.type!=='commit'){sendJson(res,422,{message:'Invalid ref'});return;}repoStore(meta).setRef(ref,sha);sendJson(res,201,{ref,object:{sha}});return;
    }
    if(tail[0]==='branches'&&method==='GET'){const refs=repoStore(meta).refs();sendJson(res,200,[...refs].filter(([r])=>r.startsWith('refs/heads/')).map(([r,sha])=>({name:r.slice(11),commit:{sha}})));return;}
    if(tail[0]==='commits'&&method==='GET'){
      const store=repoStore(meta),tip=resolveCommit(meta,url.searchParams.get('sha')??undefined);const out:AnyObj[]=[],seen=new Set<string>();let cur=tip;while(cur&&!seen.has(cur)){seen.add(cur);const info=commitInfo(store,cur);if(info)out.push(info);const c=store.object(cur);if(!c)break;const p=/^parent ([0-9a-f]{40})/m.exec(c.data.toString());cur=p?.[1];}sendJson(res,200,out);return;
    }
    if(tail[0]==='contents'&&(method==='GET'||method==='PUT'||method==='DELETE')){
      const filePath=tail.slice(1).join('/');if(!filePath){notFound(res);return;}const ref=url.searchParams.get('ref')??url.searchParams.get('branch')??undefined;const tip=resolveCommit(meta,ref);const files=filesAt(meta,tip);const old=files.get(filePath);
      if(method==='GET'){
        if(old){sendJson(res,200,{name:filePath.split('/').pop(),path:filePath,sha:old.sha,size:old.data.length,type:'file',encoding:'base64',content:old.data.toString('base64')});return;}
        const prefix=filePath.replace(/\/$/,'')+'/';const children=new Map<string,{dir:boolean;entry:FileEntry}>();for(const [p,e] of files){if(!p.startsWith(prefix))continue;const rest=p.slice(prefix.length),segment=rest.split('/')[0]!;children.set(segment,{dir:rest.includes('/'),entry:e});}if(children.size){sendJson(res,200,[...children].map(([name,x])=>({name,path:`${prefix}${name}`,sha:x.entry.sha,type:x.dir?'dir':'file'})));return;}notFound(res);return;
      }
      let b:AnyObj;try{b=await readBody(req);}catch{sendJson(res,400,{message:'Invalid JSON'});return;}
      const branch=String(b.branch??meta.default_branch),branchTip=resolveCommit(meta,branch);const branchFiles=filesAt(meta,branchTip);const current=branchFiles.get(filePath);
      if(method==='PUT'){
        if(current&&(!b.sha||String(b.sha)!==current.sha)){sendJson(res,409,{message:'Conflict: sha does not match'});return;}if(!current&&b.sha){sendJson(res,409,{message:'Conflict: file does not exist'});return;}
        const data=Buffer.from(String(b.content??''),'base64'),store=repoStore(meta),blobSha=store.writeObject({type:'blob',data});branchFiles.set(filePath,{sha:blobSha,data});const result=commitTree(meta,branchFiles,String(b.message??'Update file'),branch,branchTip);sendJson(res,current?200:201,{content:{name:filePath.split('/').pop(),path:filePath,sha:blobSha,size:data.length,type:'file',encoding:'base64'},commit:{sha:result.commitSha}});return;
      }
      if(!current){notFound(res);return;}if(!b.sha||String(b.sha)!==current.sha){sendJson(res,409,{message:'Conflict: sha does not match'});return;}branchFiles.delete(filePath);const result=commitTree(meta,branchFiles,String(b.message??'Delete file'),branch,branchTip);sendJson(res,200,{commit:{sha:result.commitSha}});return;
    }
    if(tail[0]==='labels'&&method==='POST'){
      let b:AnyObj;try{b=await readBody(req);}catch{sendJson(res,400,{message:'Invalid JSON'});return;}if(typeof b.name!=='string'||!b.name){sendJson(res,422,{message:'Validation Failed'});return;}const label={id:meta.labels.size+1,name:b.name,color:String(b.color??'ededed'),description:''};meta.labels.set(b.name.toLowerCase(),label);sendJson(res,201,label);return;
    }
    if(tail[0]==='issues'){
      if(tail.length===1&&method==='GET'){const state=url.searchParams.get('state')??'open',direction=url.searchParams.get('direction')==='asc'?1:-1;const list=[...meta.issues.values()].filter(i=>state==='all'||i.state===state).sort((a,b)=>(a.number-b.number)*direction);sendJson(res,200,list);return;}
      if(tail.length===1&&method==='POST'){
        let b:AnyObj;try{b=await readBody(req);}catch{sendJson(res,400,{message:'Invalid JSON'});return;}const names=Array.isArray(b.labels)?b.labels.map((x:any)=>typeof x==='string'?x:String(x?.name??'')):[];if(names.some((x:string)=>!meta.labels.has(x.toLowerCase()))){sendJson(res,422,{message:'Validation Failed'});return;}const issue={number:++issueNumber,title:String(b.title??''),body:String(b.body??''),state:'open',labels:names.map((n:string)=>meta.labels.get(n.toLowerCase())),created_at:new Date().toISOString()};meta.issues.set(issue.number,issue);sendJson(res,201,issue);return;
      }
      const n=Number(tail[1]);const issue=getIssue(meta,n);if(!Number.isInteger(n)||!issue){notFound(res);return;}
      if(tail.length===2&&method==='GET'){sendJson(res,200,issue);return;}
      if(tail.length===2&&method==='PATCH'){let b:AnyObj;try{b=await readBody(req);}catch{sendJson(res,400,{message:'Invalid JSON'});return;}if(b.state==='closed'||b.state==='open')issue.state=b.state;sendJson(res,200,issue);return;}
      if(tail[2]==='comments'){
        if(method==='POST'){let b:AnyObj;try{b=await readBody(req);}catch{sendJson(res,400,{message:'Invalid JSON'});return;}const c={id:++commentId,body:String(b.body??'')};(issue.comments??=[]).push(c);sendJson(res,201,c);return;}
        if(method==='GET'){sendJson(res,200,issue.comments??[]);return;}
      }
      notFound(res);return;
    }
    if(tail[0]==='pulls'){
      if(tail.length===1&&method==='GET'){const state=url.searchParams.get('state')??'open';sendJson(res,200,[...meta.pulls.values()].filter(p=>state==='all'||p.state===state));return;}
      if(tail.length===1&&method==='POST'){
        let b:AnyObj;try{b=await readBody(req);}catch{sendJson(res,400,{message:'Invalid JSON'});return;}const headRef=String(b.head??''),baseRef=String(b.base??meta.default_branch),store=repoStore(meta),headSha=resolveCommit(meta,headRef),baseSha=resolveCommit(meta,baseRef);if(!headSha||!baseSha){sendJson(res,422,{message:'Validation Failed'});return;}const pull={number:meta.pulls.size+1,state:'open',title:String(b.title??''),body:String(b.body??''),head:{label:`${owner}:${headRef}`,ref:headRef,sha:headSha,repo:{name}},base:{label:`${owner}:${baseRef}`,ref:baseRef,sha:baseSha,repo:{name}},created_at:new Date().toISOString(),merged:false,merged_at:null,merge_commit_sha:null,base_sha:baseSha,head_sha:headSha};meta.pulls.set(pull.number,pull);sendJson(res,201,pull);return;
      }
      const n=Number(tail[1]),pull=meta.pulls.get(n);if(!Number.isInteger(n)||!pull){notFound(res);return;}
      if(tail[2]==='files'&&method==='GET'){const before=filesAt(meta,pull.base_sha),after=filesAt(meta,pull.head_sha),changed:AnyObj[]=[];for(const [p,f] of after){const prior=before.get(p);if(prior?.sha===f.sha)continue;const lines=Math.max(1,f.data.toString('utf8').split(/\r?\n/).filter(Boolean).length);changed.push({filename:p,status:prior?'modified':'added',additions:lines,deletions:0,changes:lines,sha:f.sha,contents_url:`${base}/contents/${p}`});}for(const [p,f] of before)if(!after.has(p))changed.push({filename:p,status:'removed',additions:0,deletions:Math.max(1,f.data.toString('utf8').split(/\r?\n/).filter(Boolean).length),changes:Math.max(1,f.data.toString('utf8').split(/\r?\n/).filter(Boolean).length)});sendJson(res,200,changed);return;}
      if(tail[2]==='merge'&&method==='PUT'){
        const currentTip=resolveCommit(meta,pull.base.ref)??pull.base_sha;if(pull.state==='closed'){sendJson(res,405,{message:'Pull Request is not mergeable'});return;}
        const baseFiles=filesAt(meta,pull.base_sha),currentFiles=filesAt(meta,currentTip),headFiles=filesAt(meta,pull.head_sha);let conflict=false;for(const p of new Set([...baseFiles.keys(),...currentFiles.keys(),...headFiles.keys()])){const b=baseFiles.get(p)?.sha,c=currentFiles.get(p)?.sha,h=headFiles.get(p)?.sha;if(c!==b&&h!==b&&c!==h){conflict=true;break;}}
        if(conflict){sendJson(res,405,{message:'This pull request has conflicts'});return;}
        const merged=new Map(currentFiles);for(const p of new Set([...baseFiles.keys(),...headFiles.keys()])){const before=baseFiles.get(p),head=headFiles.get(p);if(before?.sha===head?.sha)continue;if(head)merged.set(p,head);else merged.delete(p);}
        const result=commitTree(meta,merged,`Squash merge pull request #${n}`,pull.base.ref,currentTip);pull.state='closed';pull.merged=true;pull.merged_at=new Date().toISOString();pull.merge_commit_sha=result.commitSha;pull.base.sha=result.commitSha;sendJson(res,200,{sha:result.commitSha,merged:true,message:'Pull Request successfully merged'});return;
      }
      if(tail.length===2&&method==='GET'){sendJson(res,200,pull);return;}
      notFound(res);return;
    }
    notFound(res);return;
  }
  notFound(res);
}
function repoJson(r:RepoMeta){return {id:r.id,name:r.name,full_name:`${r.owner}/${r.name}`,owner:{login:r.owner},private:r.private,default_branch:r.default_branch,description:r.description};}

export function createApp(): Server {
 return createServer((req,res)=>{
  const path=pathOf(req),method=req.method??'GET';
  const gitMatch=/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if(gitMatch){const owner=decodeURIComponent(gitMatch[1]!),repo=decodeURIComponent(gitMatch[2]!),endpoint=gitMatch[3]!,query=new URL(req.url??'/','http://entry').searchParams;const action=endpoint==='info/refs'?'info':endpoint==='git-upload-pack'?'upload':'receive';const service=endpoint==='git-receive-pack'?'git-receive-pack':endpoint==='git-upload-pack'?'git-upload-pack':query.get('service')??'';void handleGit(req,res,owner,repo,service,action,new RepoStore(owner,repo));return;}
  if(method==='GET'&&path==='/healthz'){sendJson(res,200,{ok:true});return;}
  if(path==='/api/graphql'){void graphql(req,res).catch(()=>{if(!res.headersSent)sendJson(res,500,{message:'Internal Server Error'});});return;}
  if(path==='/api/v3'||path.startsWith('/api/v3/')){void rest(req,res).catch(()=>{if(!res.headersSent)sendJson(res,500,{message:'Internal Server Error'});});return;}
  notFound(res);
 });
}
