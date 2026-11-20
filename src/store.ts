import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { storeRoot } from './store-root.ts';
export type ObjType = 'commit'|'tree'|'blob'|'tag';
export interface GitObject { type: ObjType; data: Buffer }
export interface TreeEntry { mode:string; name:string; oid:string }
export const ZERO='0'.repeat(40);
interface RepositoryData { objects:Map<string,GitObject>; refs:Map<string,string>; head:string; advertisementVersion:number; onRefChange?: () => void }
const repositories=new Map<string,RepositoryData>();
export function hashObject(type:ObjType,data:Uint8Array):string { return createHash('sha1').update(`${type} ${data.byteLength}\0`).update(data).digest('hex'); }
export function parseCommit(data:Buffer) { const h=data.toString('utf8').split('\n\n',1)[0]!.split('\n'); return {tree:h.find(x=>x.startsWith('tree '))?.slice(5)??'',parents:h.filter(x=>x.startsWith('parent ')).map(x=>x.slice(7))}; }
export function parseTree(data:Buffer):TreeEntry[] { const out:TreeEntry[]=[]; let i=0; while(i<data.length){const s=data.indexOf(32,i),n=data.indexOf(0,s+1); if(s<0||n<0||n+21>data.length) throw Error('bad tree');out.push({mode:data.subarray(i,s).toString(),name:data.subarray(s+1,n).toString(),oid:data.subarray(n+1,n+21).toString('hex')});i=n+21;}return out; }
export function buildTree(entries:TreeEntry[]):Buffer { const sorted=[...entries].sort((a,b)=>Buffer.compare(Buffer.from(a.mode==='40000'?a.name+'/':a.name),Buffer.from(b.mode==='40000'?b.name+'/':b.name))); return Buffer.concat(sorted.flatMap(e=>[Buffer.from(`${e.mode} ${e.name}\0`),Buffer.from(e.oid,'hex')])); }

export class RepoStore {
  private repoPath:string;
  constructor(owner:string,name:string){
    if (!/^[\w.-]+$/.test(owner)||owner==='.'||owner==='..'||owner.endsWith('.')||!/^[\w.-]+$/.test(name))throw Error('invalid repository path');
    this.repoPath=owner.toLowerCase()+'/'+name.toLowerCase()+'.git';
  }
  get root(){return storeRoot();}
  get path(){return join(this.root,this.repoPath);}
  private data(){const data=repositories.get(this.repoPath);if(!data)throw Error('repository unavailable');return data;}
  hasConfig(){return repositories.has(this.repoPath);}
  remove(){repositories.delete(this.repoPath);}
  exists(){if(this.hasConfig())return true;const name=this.repoPath.slice(this.repoPath.indexOf('/'));for(const key of repositories.keys())if(key.endsWith(name)){this.repoPath=key;return true;}return false;}
  create(onRefChange?: () => void){repositories.set(this.repoPath,{objects:new Map(),refs:new Map(),head:'ref: refs/heads/main',advertisementVersion:0,onRefChange});}
  clearCaches(){}
  object(oid:string):GitObject|undefined{return this.data().objects.get(oid);}
  writeObject(obj:GitObject):string{return this.storeVerifiedObject(hashObject(obj.type,obj.data),obj);}
  storeVerifiedObject(oid:string,obj:GitObject){const data=this.data();if(!data.objects.has(oid)){data.objects.set(oid,obj);data.advertisementVersion++;}return oid;}
  storeVerifiedObjects(objects:Map<string,GitObject>):number{const data=this.data();for(const [oid,obj] of objects)if(!data.objects.has(oid)){data.objects.set(oid,obj);data.advertisementVersion++;}return objects.size;}
  advertisementVersion(){return this.data().advertisementVersion;}
  refs():Map<string,string>{return this.data().refs;}
  head():{oid?:string;target?:string}{const h=this.data().head;if(h.startsWith('ref: ')){const target=h.slice(5);return {target,oid:this.refs().get(target)};}return {oid:h};}
  setRef(ref:string,oid:string|null){const segments=ref.split('/');if(segments[0]!=='refs'||segments.length<3||segments.some(x=>!x||/[\\:]/.test(x)||x.startsWith('.')||x.endsWith('.')||x.toLowerCase().endsWith('.lock')))throw Error('invalid ref');const data=this.data();if(oid===null?data.refs.delete(ref):data.refs.get(ref)!==oid){if(oid!==null)data.refs.set(ref,oid);data.advertisementVersion++;data.onRefChange?.();}}
  isAncestor(old:string,next:string):boolean{if(old===next)return true;const todo=[next],seen=new Set<string>();while(todo.length){const x=todo.pop()!;if(seen.has(x))continue;seen.add(x);if(x===old)return true;const o=this.object(x);if(o?.type==='commit')todo.push(...parseCommit(o.data).parents);}return false;}
  closure(tips:string[], depth?:number, shallowHave:string[]=[]):{objects:Map<string,GitObject>; boundaries:string[]}{const objects=new Map<string,GitObject>(),seen=new Set<string>(),boundaries:string[]=[];const q=tips.map(oid=>({oid,level:1}));while(q.length){const {oid,level}=q.shift()!;if(seen.has(oid))continue;seen.add(oid);const obj=this.object(oid);if(!obj)continue;objects.set(oid,obj);if(obj.type==='commit'){const c=parseCommit(obj.data);q.push({oid:c.tree,level});if(depth&&level>=depth&&c.parents.length){boundaries.push(oid);continue;}for(const p of c.parents){if(shallowHave.includes(p))continue;q.push({oid:p,level:level+1});}}else if(obj.type==='tag'){const m=/^object ([0-9a-f]{40})/m.exec(obj.data.toString());if(m)q.push({oid:m[1]!,level});}else if(obj.type==='tree')for(const e of parseTree(obj.data))if(e.mode!=='160000')q.push({oid:e.oid,level});}return {objects,boundaries};}
}
