import { readBytes } from './http-body.ts';
import { ByteCache } from './cache.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RepoStore, ZERO, parseCommit, parseTree, type GitObject } from './store.ts';
import { readPack, writePack } from './pack.ts';

const pkt=(s:string|Buffer)=>{const b=Buffer.isBuffer(s)?s:Buffer.from(s);return Buffer.concat([Buffer.from((b.length+4).toString(16).padStart(4,'0')),b]);};
const FLUSH=Buffer.from('0000');
const flush=()=>FLUSH;
function json(res:ServerResponse,status:number,body:any){const b=Buffer.from(JSON.stringify(body)+'\n');res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':b.length,'x-github-request-id':cryptoId()});res.end(b);}
function cryptoId(){return Math.random().toString(36).slice(2,14).toUpperCase();}
function gitReply(res:ServerResponse,type:string,b:Buffer){
  const raw = res as ServerResponse & { endGit?: (type: string, body: Buffer, requestId: string) => void };
  if (raw.endGit) { raw.endGit(type, b, cryptoId()); return; }
  const id = cryptoId();
  res.writeHead(200,{'content-type':type,'content-length':b.length,'x-github-request-id':id,'cache-control':'no-cache'});
  res.end(b);
}
function decodePackets(b:Buffer){let p=0;const out:Buffer[]=[];while(p+4<=b.length){const n=parseInt(b.toString('ascii',p,p+4),16);if(!Number.isFinite(n))throw Error('invalid pkt-line');p+=4;if(n===0)return {out,p};if(n===1||n===2)continue;if(n<4||p+n-4>b.length)throw Error('truncated pkt-line');const end=p+n-4;out.push(b.subarray(p,end));p=end;}return {out,p};}
function refList(store:RepoStore){const refs=store.refs(),head=store.head(),out=[...refs].sort(([a],[b])=>a.localeCompare(b));if(head.target)out.unshift(['HEAD',head.oid??ZERO] as [string,string]);else if(head.oid)out.unshift(['HEAD',head.oid]);return out;}
function peel(store:RepoStore,oid:string){let obj=store.object(oid);while(obj?.type==='tag'){const m=/^object ([0-9a-f]{40})/m.exec(obj.data.toString());if(!m)return '';oid=m[1]!;obj=store.object(oid);}return oid;}
function buildV0Advertisement(store:RepoStore,service:string){const refs=refList(store),caps=service==='git-upload-pack'?'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main object-format=sha1 agent=makefun':'report-status side-band-64k delete-refs ofs-delta agent=makefun';let b=pkt(`# service=${service}\n`);if(!refs.length)b=Buffer.concat([b,pkt(`${ZERO} capabilities^{}\0${caps}\n`)]);else for(let i=0;i<refs.length;i++){const [name,oid]=refs[i]!;b=Buffer.concat([b,pkt(`${oid} ${name}${i===0?'\0'+caps:''}\n`)]);const obj=store.object(oid);if(name.startsWith('refs/tags/')&&obj?.type==='tag'){const peeled=peel(store,oid);if(peeled&&peeled!==oid)b=Buffer.concat([b,pkt(`${peeled} ${name}^{}\n`)]);}}return Buffer.concat([b,flush()]);}
// The ref map identifies the repository lifetime, including deletion and recreation.
const advertisements = new WeakMap<Map<string,string>, { version: number; upload?: Buffer; receive?: Buffer }>();
function v0Advertisement(store: RepoStore, service: string): Buffer {
  const refs = store.refs(), version = store.advertisementVersion();
  let entry = advertisements.get(refs);
  if (entry?.version !== version) {
    entry = { version };
    advertisements.set(refs, entry);
  }
  const key = service === 'git-upload-pack' ? 'upload' : 'receive';
  return entry[key] ??= buildV0Advertisement(store, service);
}
const V2_ADVERTISEMENT = Buffer.concat([pkt('version 2\n'),pkt('agent=makefun\n'),pkt('object-format=sha1\n'),pkt('ls-refs=unborn\n'),pkt('fetch=shallow wait-for-done\n'),flush()]);
function closure(store:RepoStore,roots:string[],depth?:number,shallow:string[]=[]){const objects=new Map<string,GitObject>(),seen=new Set<string>(),boundaries:string[]=[];const q=roots.map(oid=>({oid,level:1}));while(q.length){const {oid,level}=q.shift()!;if(seen.has(oid))continue;seen.add(oid);const o=store.object(oid);if(!o)continue;objects.set(oid,o);if(o.type==='commit'){const c=parseCommit(o.data);if(c.tree)q.push({oid:c.tree,level});if(shallow.includes(oid)){boundaries.push(oid);continue;}if(depth&&level>=depth&&c.parents.length){boundaries.push(oid);continue;}for(const p of c.parents)q.push({oid:p,level:level+1});}else if(o.type==='tree'){for(const e of parseTree(o.data))if(e.mode!=='160000')q.push({oid:e.oid,level});}else if(o.type==='tag'){const m=/^object ([0-9a-f]{40})/m.exec(o.data.toString());if(m)q.push({oid:m[1]!,level});}}return {objects,boundaries};}
const NAK = pkt('NAK\n'), PACKFILE = pkt('packfile\n');
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
function framePack(prefix:Buffer[],pack:Buffer){
  const parts=[...prefix];
  for(let i=0;i<pack.length;i+=60000){
    const data=pack.subarray(i,i+60000);
    parts.push(Buffer.from((data.length+5).toString(16).padStart(4,'0')+'\x01'),data);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
const packedCache=new ByteCache<string,Buffer>(64*1024*1024);
const packSnapshots=new WeakMap<Map<string,string>,{version:number; id:number}>();
let nextPackSnapshot=0;
function packedReply(store:RepoStore,wants:string[],haves:string[],depth:number|undefined,shallow:string[],v2:boolean){
  const refs=store.refs(), version=store.advertisementVersion();
  let snapshot=packSnapshots.get(refs);
  if(snapshot?.version!==version){
    snapshot={version,id:++nextPackSnapshot};
    packSnapshots.set(refs,snapshot);
  }
  // A new snapshot invalidates every previous key for this repo. The shared LRU
  // bounds memory even when many repositories have cached responses.
  wants.sort();haves.sort();shallow.sort();
  const key=JSON.stringify([snapshot.id,v2,String(depth),wants,haves,shallow]);
  const cached=packedCache.get(key);
  if(cached)return cached;
  const {objects,boundaries}=closure(store,wants,depth);
  const effectiveShallow=depth===1?[]:shallow;
  for(const oid of closure(store,haves,undefined,effectiveShallow).objects.keys())objects.delete(oid);
  const prefix:Buffer[]=[];
  if(depth){
    if(v2)prefix.push(pkt('shallow-info\n'));
    for(const oid of boundaries)prefix.push(pkt(`shallow ${oid}\n`));
    if(v2)prefix.push(FLUSH);
  }
  prefix.push(v2?PACKFILE:NAK);
  const reply=framePack(prefix,writePack(objects.values(), 9));
  packedCache.set(key,reply,reply.buffer.byteLength);
  return reply;
}
function lsRefs(store:RepoStore,lines:string[]){const sym=lines.includes('symrefs\n'),peeling=lines.includes('peel\n'),prefix=lines.filter(x=>x.startsWith('ref-prefix ')).map(x=>x.slice(11).trim());const refs=refList(store).filter(([n])=>!prefix.length||prefix.some(p=>n.startsWith(p)));const out:Buffer[]=[];for(const [name,oid] of refs){if(name==='HEAD'&&oid===ZERO&&!store.head().oid){if(lines.includes('unborn\n'))out.push(pkt(`unborn HEAD symref-target:${store.head().target??'refs/heads/main'}\n`));continue;}let extra=name==='HEAD'&&sym?` symref-target:${store.head().target??'refs/heads/main'}`:'';if(peeling&&name.startsWith('refs/tags/')){const target=peel(store,oid);if(target&&target!==oid)extra+=` peeled:${target}`;}out.push(pkt(`${oid} ${name}${extra}\n`));}return Buffer.concat([...out,flush()]);}
async function upload(req:IncomingMessage,res:ServerResponse,store:RepoStore){const buffered=(req as IncomingMessage&{__rawBody?:Buffer}).__rawBody,b=Buffer.isBuffer(buffered)?buffered:await readBytes(req);const {out,p}=decodePackets(b);const lines=out.map(x=>x.toString());const v2=req.headers['git-protocol']==='version=2';if(v2){const command=lines.find(x=>x.startsWith('command='))?.slice(8).trim()??'';const args=lines.filter(x=>!x.startsWith('command=')&&!x.startsWith('agent=')&&!x.startsWith('object-format='));if(command==='ls-refs'){gitReply(res,'application/x-git-upload-pack-result',lsRefs(store,args));return;}if(command==='fetch'){const wants=args.filter(x=>x.startsWith('want ')).map(x=>x.slice(5).trim()),haves=args.filter(x=>x.startsWith('have ')).map(x=>x.slice(5).trim()),depthLine=args.find(x=>x.startsWith('deepen ')),depth=depthLine?Number(depthLine.slice(7)):undefined,shallow=args.filter(x=>x.startsWith('shallow ')).map(x=>x.slice(8).trim());gitReply(res,UPLOAD_RESULT,packedReply(store,wants,haves,depth,shallow,true));return;}}
  const wants=lines.filter(x=>x.startsWith('want ')).map(x=>x.slice(5).trim().split(' ')[0]!);const haves=lines.filter(x=>x.startsWith('have ')).map(x=>x.slice(5).trim());const dep=lines.find(x=>x.startsWith('deepen ')),depth=dep?Number(dep.slice(7)):undefined;const shallow=lines.filter(x=>x.startsWith('shallow ')).map(x=>x.slice(8).trim());gitReply(res,UPLOAD_RESULT,packedReply(store,wants,haves,depth,shallow,false));}
async function receive(req:IncomingMessage,res:ServerResponse,store:RepoStore){const buffered=(req as IncomingMessage&{__rawBody?:Buffer}).__rawBody,b=Buffer.isBuffer(buffered)?buffered:await readBytes(req);const {out,p}=decodePackets(b);const commands:{old:string;next:string;ref:string}[]=[];for(const payload of out){const text=payload.toString();if(!text.trim())continue;const [old,next,ref]=text.split('\0',1)[0]!.trim().split(/\s+/);if(old&&next&&ref)commands.push({old,next,ref});}let unpack='ok';if(p<b.length){try{store.storeVerifiedObjects(readPack(b.subarray(p),oid=>store.object(oid)));}catch(e){unpack=(e as Error).message;}}
  const result:string[]=[`unpack ${unpack}\n`];const refs=store.refs();for(const c of commands){const oldNow=refs.get(c.ref)??ZERO;let reason='';if(unpack!=='ok')reason='unpack failed';else if(oldNow!==c.old)reason='stale info';else if(c.next===ZERO){if(oldNow===ZERO)reason='reference does not exist';else store.setRef(c.ref,null);}else if(c.old!==ZERO&&!store.isAncestor(c.old,c.next))reason='non-fast-forward';else if(!store.object(c.next))reason='missing object';else store.setRef(c.ref,c.next);result.push(reason?`ng ${c.ref} ${reason}\n`:`ok ${c.ref}\n`);}const report=result.map(pkt);const size=report.reduce((n,part)=>n+part.length,9);const side=Buffer.concat([Buffer.from(size.toString(16).padStart(4,'0')+'\x01'),...report,FLUSH,FLUSH],size+4);gitReply(res,'application/x-git-receive-pack-result',side);}
export async function handleGit(req:IncomingMessage,res:ServerResponse,owner:string,repo:string,service:string,action:'info'|'upload'|'receive',store:RepoStore):Promise<void>{if(!store.exists()){json(res,404,{message:'Not Found'});return;}try{if(action==='info'){if(service!=='git-upload-pack'&&service!=='git-receive-pack'){json(res,400,{message:'Invalid service'});return;}if(service==='git-receive-pack'&&req.headers['git-protocol']==='version=2'){json(res,400,{message:'Protocol v2 receive-pack is unsupported'});return;}const b=service==='git-upload-pack'&&req.headers['git-protocol']==='version=2'?V2_ADVERTISEMENT:v0Advertisement(store,service);gitReply(res,service==='git-upload-pack'?'application/x-git-upload-pack-advertisement':'application/x-git-receive-pack-advertisement',b);return;}if(action==='upload')await upload(req,res,store);else await receive(req,res,store);}catch(error){if(res.headersSent){res.destroy();return;}const io=!!(error as NodeJS.ErrnoException).code;json(res,io?500:400,{message:io?'Git storage error':'Malformed git request'});}}
