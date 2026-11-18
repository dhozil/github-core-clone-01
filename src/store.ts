import { ByteCache } from './cache.ts';
import { storeRoot, storeOperation } from './store-root.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit'|'tree'|'blob'|'tag';
export interface GitObject { type: ObjType; data: Buffer }
export interface TreeEntry { mode:string; name:string; oid:string }
export const ZERO='0'.repeat(40);
// Git objects are immutable and keyed by their hash. Sharing parsed objects across RepoStore instances
// avoids repeating synchronous reads and inflate work for every request to the same repository.
const objectCache=new ByteCache<string,GitObject|null>(48*1024*1024);
const refsCache=new ByteCache<string,Map<string,string>>(4*1024*1024);
export function hashObject(type:ObjType,data:Uint8Array):string { const b=Buffer.from(data); return createHash('sha1').update(`${type} ${b.length}\0`).update(b).digest('hex'); }
export function parseCommit(data:Buffer) { const h=data.toString('utf8').split('\n\n',1)[0]!.split('\n'); return {tree:h.find(x=>x.startsWith('tree '))?.slice(5)??'',parents:h.filter(x=>x.startsWith('parent ')).map(x=>x.slice(7))}; }
export function parseTree(data:Buffer):TreeEntry[] { const out:TreeEntry[]=[]; let i=0; while(i<data.length){const s=data.indexOf(32,i),n=data.indexOf(0,s+1); if(s<0||n<0||n+21>data.length) throw Error('bad tree');out.push({mode:data.subarray(i,s).toString(),name:data.subarray(s+1,n).toString(),oid:data.subarray(n+1,n+21).toString('hex')});i=n+21;}return out; }
export function buildTree(entries:TreeEntry[]):Buffer { const sorted=[...entries].sort((a,b)=>Buffer.compare(Buffer.from(a.mode==='40000'?a.name+'/':a.name),Buffer.from(b.mode==='40000'?b.name+'/':b.name))); return Buffer.concat(sorted.flatMap(e=>[Buffer.from(`${e.mode} ${e.name}\0`),Buffer.from(e.oid,'hex')])); }

function present(path:string) {
  try { statSync(path); return true; }
  catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return false; throw error; }
}
function atomicWrite(path:string,data:string|Buffer) {
  const temp=path+'.lock';
  writeFileSync(temp,data);
  renameSync(temp,path);
}

export class RepoStore {
  private repoPath: string;
  constructor(owner:string,name:string) {
    if (!/^[\w.-]+$/.test(owner) || owner==='.' || owner==='..' || owner.endsWith('.') || !/^[\w.-]+$/.test(name)) throw Error('invalid repository path');
    this.repoPath=join(owner.toLowerCase(),name.toLowerCase()+'.git');
  }
  get root(){return storeRoot();}
  get path(){return join(this.root,this.repoPath);}
  hasConfig(){return storeOperation(()=>present(join(this.path,'config')));}
  remove(){storeOperation(()=>{rmSync(this.path,{recursive:true,force:true});this.clearCaches();});}
  exists(){return storeOperation(()=>{if(present(join(this.path,'config')))return true;if(!present(this.root))return false;for(const owner of readdirSync(this.root,{withFileTypes:true})){if(!owner.isDirectory())continue;const candidate=join(this.root,owner.name,`${this.path.split(/[\\/]/).pop()}`);if(present(join(candidate,'config'))){this.repoPath=join(owner.name,this.repoPath.split(/[\\/]/).pop()!);return true;}}return false;});}
  create(){return storeOperation(()=>{this.clearCaches();mkdirSync(join(this.path,'objects','pack'),{recursive:true});mkdirSync(join(this.path,'refs','heads'),{recursive:true});mkdirSync(join(this.path,'refs','tags'),{recursive:true});writeFileSync(join(this.path,'HEAD'),'ref: refs/heads/main\n');writeFileSync(join(this.path,'config'),'[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n');});}
  clearCaches(){const prefix=this.path+String.fromCharCode(0);for(const key of objectCache.keys())if(key.startsWith(prefix))objectCache.delete(key);refsCache.delete(this.path);}
  object(oid:string):GitObject|undefined {return storeOperation(()=>{ if(!/^[0-9a-f]{40}$/.test(oid))return;const key=this.path+String.fromCharCode(0)+oid;if(objectCache.get(key)!==undefined)return objectCache.get(key)??undefined;const p=join(this.path,'objects',oid.slice(0,2),oid.slice(2));if(!present(p)){objectCache.set(key,null,0);return;}try{const b=inflateSync(readFileSync(p)),z=b.indexOf(0),head=b.subarray(0,z).toString(),sp=head.indexOf(' '),obj={type:head.slice(0,sp) as ObjType,data:b.subarray(z+1)};objectCache.set(key,obj,b.buffer.byteLength);return obj;}catch(error){if ((error as NodeJS.ErrnoException).code==='ENOENT') return; throw error;} });}
  writeObject(obj:GitObject):string {let retryWrite=false;return storeOperation(()=>{const oid=hashObject(obj.type,obj.data),p=join(this.path,'objects',oid.slice(0,2));mkdirSync(p,{recursive:true});const f=join(p,oid.slice(2));if(retryWrite||!present(f)){retryWrite=true;writeFileSync(f,deflateSync(Buffer.concat([Buffer.from(`${obj.type} ${obj.data.length}\0`),obj.data])));retryWrite=false;}objectCache.set(this.path+String.fromCharCode(0)+oid,obj,obj.data.buffer.byteLength);return oid;});}
  refs():Map<string,string>{return storeOperation(()=>{const cached=refsCache.get(this.path);if(cached)return cached;const out=new Map<string,string>(); const walk=(dir:string,pre:string)=>{if(!present(dir))return;for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name),n=`${pre}/${e.name}`;if(e.isDirectory())walk(p,n);else{const m=/^([0-9a-f]{40})/.exec(readFileSync(p,'utf8'));if(m&&!n.endsWith('.lock'))out.set(n,m[1]!);}}};walk(join(this.path,'refs'),'refs');const packed=join(this.path,'packed-refs');if(present(packed))for(const l of readFileSync(packed,'utf8').split(/\r?\n/)){const m=/^([0-9a-f]{40}) (.+)$/.exec(l);if(m&&!out.has(m[2]!))out.set(m[2]!,m[1]!);}refsCache.set(this.path,out,[...out.keys()].reduce((n,k)=>n+192+k.length*2,0));return out;});}
  head():{oid?:string;target?:string}{return storeOperation(()=>{const h=readFileSync(join(this.path,'HEAD'),'utf8').trim();if(h.startsWith('ref: ')){const target=h.slice(5);return {target,oid:this.refs().get(target)};}return {oid:h};});}
  setRef(ref:string,oid:string|null){return storeOperation(()=>{const segments=ref.split('/');if(segments[0]!=='refs'||segments.length<3||segments.some(x=>!x||/[\\:]/.test(x)||x.startsWith('.')||x.endsWith('.')||x.toLowerCase().endsWith('.lock')))throw Error('invalid ref');const file=join(this.path,...segments);if(oid===null){try{unlinkSync(file)}catch(error){if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;};refsCache.delete(this.path);return;}mkdirSync(join(file,'..'),{recursive:true});atomicWrite(file,oid+'\n');refsCache.delete(this.path);});}
  isAncestor(old:string,next:string):boolean{if(old===next)return true;const todo=[next],seen=new Set<string>();while(todo.length){const x=todo.pop()!;if(seen.has(x))continue;seen.add(x);if(x===old)return true;const o=this.object(x);if(o?.type==='commit')todo.push(...parseCommit(o.data).parents);}return false;}
  closure(tips:string[], depth?:number, shallowHave:string[]=[]):{objects:Map<string,GitObject>; boundaries:string[]}{const objects=new Map<string,GitObject>(),seen=new Set<string>(),boundaries:string[]=[];const q=tips.map(oid=>({oid,level:1}));while(q.length){const {oid,level}=q.shift()!;if(seen.has(oid))continue;seen.add(oid);const obj=this.object(oid);if(!obj)continue;objects.set(oid,obj);if(obj.type==='commit'){const c=parseCommit(obj.data);q.push({oid:c.tree,level});if(depth&&level>=depth&&c.parents.length){boundaries.push(oid);continue;}for(const p of c.parents){if(shallowHave.includes(p))continue;q.push({oid:p,level:level+1});}}else if(obj.type==='tag'){const m=/^object ([0-9a-f]{40})/m.exec(obj.data.toString());if(m)q.push({oid:m[1]!,level});}else if(obj.type==='tree')for(const e of parseTree(obj.data))if(e.mode!=='160000')q.push({oid:e.oid,level});}return {objects,boundaries};}
}
