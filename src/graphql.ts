type Any = Record<string, any>;

export interface GraphQLContext {
  viewer: string;
  repositories: Map<string, Any>;
  repository(owner: string, name: string): Any | undefined;
  resolveBranch(repo: Any, ref: string): string | undefined;
  pullFiles(repo: Any, pull: Any): string[];
  mergePull(repo: Any, pull: Any): boolean;
  nextIssueNumber(): number;
  nextCommentId(): number;
}

type Field = { name: string; alias?: string; args: Record<string, unknown>; selections: Selection[] };
type Selection = Field | { kind: 'inline'; type: string; selections: Selection[] } | { kind: 'spread'; name: string };
type Token = { value: string; offset: number; kind: 'name' | 'string' | 'number' | 'punct' };

function tokenize(source: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < source.length;) {
    const c = source[i]!;
    if (/\s|,/u.test(c)) { i++; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    const offset = i;
    if (c === '"') {
      i++; let raw = '"';
      while (i < source.length) { const x = source[i++]!; raw += x; if (x === '\\' && i < source.length) raw += source[i++]!; else if (x === '"') break; }
      out.push({ value: JSON.parse(raw), offset, kind: 'string' }); continue;
    }
    if (/[A-Za-z_]/u.test(c)) { let j = i + 1; while (j < source.length && /[A-Za-z0-9_]/u.test(source[j]!)) j++; out.push({ value: source.slice(i,j), offset, kind: 'name' }); i=j; continue; }
    if (c === '-' || /[0-9]/u.test(c)) { let j=i+1; while(j<source.length&&/[0-9.]/u.test(source[j]!))j++;out.push({value:source.slice(i,j),offset,kind:'number'});i=j;continue; }
    if (source.startsWith('...', i)) { out.push({ value:'...', offset, kind:'punct' }); i += 3; continue; }
    if ('!$():=@[]{|}&'.includes(c)) { out.push({ value:c, offset, kind:'punct' }); i++; continue; }
    throw new Error(`Unexpected character ${c}`);
  }
  return out;
}

class Parser {
  private i = 0;
  readonly fragments = new Map<string, Selection[]>();
  private tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }
  private peek(v?: string) { return this.tokens[this.i]?.value === v; }
  private take() { const t=this.tokens[this.i++]; if(!t) throw new Error('Unexpected end of GraphQL document'); return t; }
  private expect(v: string) { const t=this.take(); if(t.value!==v) throw new Error(`Expected ${v}, got ${t.value}`); return t; }
  private name() { const t=this.take(); if(t.kind!=='name') throw new Error(`Expected a name, got ${t.value}`); return t.value; }
  private skipGroup(open: string, close: string) { this.expect(open);let depth=1;while(depth){const t=this.take();if(t.value===open)depth++;if(t.value===close)depth--;} }
  parse(): Selection[] {
    let root: Selection[] | undefined;
    while(this.i<this.tokens.length) {
      if(this.peek('fragment')) { this.take();const name=this.name();this.expect('on');this.name();this.fragments.set(name,this.selectionSet());continue; }
      if(this.peek('{')) { root=this.selectionSet();continue; }
      const op=this.name(); if(op!=='query'&&op!=='mutation'&&op!=='subscription') throw new Error(`Unknown operation ${op}`);
      if(!this.peek('(')&&!this.peek('{')) this.name();
      if(this.peek('(')) this.skipGroup('(',')');
      while(this.peek('@')) { this.take();this.name();if(this.peek('('))this.skipGroup('(',')'); }
      root=this.selectionSet();
    }
    return root??[];
  }
  private value(): unknown {
    const t=this.take();
    if(t.value==='$') return { variable:this.name() };
    if(t.value==='[') { const a:unknown[]=[];while(!this.peek(']'))a.push(this.value());this.take();return a; }
    if(t.value==='{') { const o:Any={};while(!this.peek('}')){const k=this.name();this.expect(':');o[k]=this.value();}this.take();return o; }
    if(t.value==='null')return null;if(t.value==='true')return true;if(t.value==='false')return false;
    if(t.kind==='string')return t.value;if(t.kind==='number')return Number(t.value);return t.value;
  }
  private selectionSet(): Selection[] {
    this.expect('{');const fields:Selection[]=[];
    while(!this.peek('}')) {
      if(this.peek('...')) { this.take();if(this.peek('on')){this.take();const type=this.name();fields.push({kind:'inline',type,selections:this.selectionSet()});}else fields.push({kind:'spread',name:this.name()});continue; }
      const first=this.name();let name=first,alias:string|undefined;
      if(this.peek(':')){this.take();alias=first;name=this.name();}
      const args:Record<string,unknown>={};if(this.peek('(')){this.take();while(!this.peek(')')){const k=this.name();this.expect(':');args[k]=this.value();}this.take();}
      while(this.peek('@')){this.take();this.name();if(this.peek('('))this.skipGroup('(',')');}
      fields.push({name,...(alias?{alias}:{}),args,selections:this.peek('{')?this.selectionSet():[]});
    }
    this.take();return fields;
  }
}

function valueOf(v: unknown, vars: Any): any {
  if(v&&typeof v==='object'&&!Array.isArray(v)&&'variable' in v)return vars[(v as Any).variable];
  if(Array.isArray(v))return v.map(x=>valueOf(x,vars));
  if(v&&typeof v==='object'){const o:Any={};for(const [k,x] of Object.entries(v))o[k]=valueOf(x,vars);return o;}
  return v;
}
function globalId(kind: string, raw: string): string { return Buffer.from(`${kind}:${raw}`).toString('base64url'); }
function issueId(repo: Any, n: number) { return globalId('Issue',`${repo.owner}/${repo.name}/${n}`); }
function repoId(repo: Any) { return globalId('Repository',`${repo.owner}/${repo.name}`); }
function pullId(repo: Any, n: number) { return globalId('PullRequest',`${repo.owner}/${repo.name}/${n}`); }
function typeName(value: Any): string {
  if(value?.__kind==='Repository')return 'Repository';if(value?.__kind==='Issue')return 'Issue';if(value?.__kind==='PullRequest')return 'PullRequest';
  if(value?.__kind==='User')return 'User';if(value?.__kind==='Ref')return 'Ref';if(value?.__kind==='Connection')return 'Connection';if(value?.__kind==='PullRequestConnection')return 'PullRequestConnection';if(value?.__kind==='PageInfo')return 'PageInfo';if(value?.__kind==='FileConnection')return 'FileConnection';if(value?.__kind==='File')return 'PullRequestChangedFile';if(value?.__kind==='Type')return '__Type';if(value?.__kind==='FieldDef')return 'FieldDef';if(value?.__kind==='EnumDef')return 'EnumDef';if(value?.__kind==='MutationPayload')return 'MutationPayload';if(value?.__kind==='CommentEdge')return 'CommentEdge';if(value?.__kind==='Comment')return 'Comment';
  return 'Query';
}
const TYPE_FIELDS:Record<string,string[]>={
  Issue:['id','number','title','state','body'],
  PullRequest:['id','number','headRefName','baseRefName','mergeable','state','merged','files'],
  Repository:['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issue','issues','pullRequests','pullRequest'],
  User:['login'], Ref:['name'], IssueConnection:['nodes','pageInfo'], PullRequestConnection:['nodes'], PullRequestChangedFile:['path'],
  __Type:['name','fields','enumValues'], PageInfo:['hasNextPage','endCursor'],
};
const ENUMS:Record<string,string[]>={SearchType:['ISSUE','REPOSITORY','USER','DISCUSSION','COMMIT'],IssueState:['OPEN','CLOSED'],PullRequestState:['OPEN','CLOSED','MERGED'],MergeableState:['MERGEABLE','CONFLICTING','UNKNOWN'],RepositoryPermission:['ADMIN','MAINTAIN','WRITE','TRIAGE','READ'],IssueOrderField:['CREATED_AT','UPDATED_AT','COMMENTS'],OrderDirection:['ASC','DESC'],PullRequestMergeMethod:['MERGE','SQUASH','REBASE']};

function resolveField(parent: Any, parentType: string, field: Field, vars: Any, ctx: GraphQLContext): any {
  const args:Any={};for(const [k,v] of Object.entries(field.args))args[k]=valueOf(v,vars);
  if(field.name==='__typename')return parentType;
  if(parentType==='Query') {
    if(field.name==='viewer')return {__kind:'User',login:ctx.viewer};
    if(field.name==='repository'){const r=ctx.repository(String(args.owner??''),String(args.name??''));return r?{__kind:'Repository',repo:r}:null;}
    if(field.name==='__type')return {__kind:'Type',name:String(args.name??'')};
    if(field.name==='node') {const id=String(args.id??'');for(const r of ctx.repositories.values()){if(repoId(r)===id)return {__kind:'Repository',repo:r};for(const i of r.issues.values())if(issueId(r,i.number)===id)return {__kind:'Issue',repo:r,issue:i};for(const p of r.pulls.values())if(pullId(r,p.number)===id)return {__kind:'PullRequest',repo:r,pull:p};}return null;}
  }
  if(parentType==='Repository') {
    const r=parent.repo;
    if(field.name==='id')return repoId(r);if(field.name==='databaseId')return r.id;
    if(field.name==='name')return r.name;if(field.name==='nameWithOwner')return `${r.owner}/${r.name}`;
    if(field.name==='owner')return {__kind:'User',login:r.owner};if(field.name==='defaultBranchRef')return {__kind:'Ref',name:r.default_branch};
    if(field.name==='viewerPermission')return 'ADMIN';if(field.name==='hasIssuesEnabled')return true;
    if(field.name==='issue'){const issue=r.issues.get(Number(args.number));return issue?{__kind:'Issue',repo:r,issue}:null;}
    if(field.name==='pullRequest'){const pull=r.pulls.get(Number(args.number));return pull?{__kind:'PullRequest',repo:r,pull}:null;}
    if(field.name==='issues'){
      let list=[...r.issues.values()];if(Array.isArray(args.states)&&args.states.length)list=list.filter(i=>args.states.includes(String(i.state).toUpperCase()));
      const dir=args.orderBy?.direction==='ASC'?1:-1;list.sort((a,b)=>{const time=String(a.created_at??'').localeCompare(String(b.created_at??''));return time?time*dir:(a.number-b.number)*dir;});
      let offset=0;if(typeof args.after==='string'){const decoded=Buffer.from(args.after,'base64url').toString();const m=/^issues:(\d+)$/.exec(decoded);if(m)offset=Number(m[1]);}
      const first=Number.isInteger(args.first)?Math.max(0,args.first):list.length;const rows=list.slice(offset,offset+first);
      return {__kind:'Connection',nodes:rows.map((i:Any)=>({__kind:'Issue',repo:r,issue:i})),pageInfo:{__kind:'PageInfo',hasNextPage:offset+rows.length<list.length,endCursor:rows.length?Buffer.from(`issues:${offset+rows.length}`).toString('base64url'):null}};
    }
    if(field.name==='pullRequests'){const list=[...r.pulls.values()].filter((p:any)=>p.state==='open').slice(0,Number(args.first)||100);return {__kind:'PullRequestConnection',nodes:list.map((p:any)=>({__kind:'PullRequest',repo:r,pull:p}))};}
  }
  if(parentType==='Issue') {const i=parent.issue,r=parent.repo;if(field.name==='id')return issueId(r,i.number);if(field.name==='number')return i.number;if(field.name==='title'||field.name==='body')return i[field.name];if(field.name==='state')return String(i.state).toUpperCase();}
  if(parentType==='PullRequest') {const p=parent.pull,r=parent.repo;
    if(field.name==='id')return pullId(r,p.number);if(field.name==='number')return p.number;if(field.name==='headRefName')return p.head.ref;if(field.name==='baseRefName')return p.base.ref;
    if(field.name==='mergeable')return 'MERGEABLE';if(field.name==='state')return p.merged?'MERGED':String(p.state).toUpperCase();if(field.name==='merged')return Boolean(p.merged);
    if(field.name==='files'){const paths=ctx.pullFiles(r,p).slice(0,Number(args.first)||100);return {__kind:'FileConnection',nodes:paths.map(path=>({__kind:'File',path}))};}
  }
  if(parentType==='User'&&field.name==='login')return parent.login;
  if(parentType==='Ref'&&field.name==='name')return parent.name;
  if(parentType==='Connection'&&field.name==='nodes')return parent.nodes;
  if(parentType==='Connection'&&field.name==='pageInfo')return parent.pageInfo;
  if(parentType==='PullRequestConnection'&&field.name==='nodes')return parent.nodes;
  if(parentType==='FileConnection'&&field.name==='nodes')return parent.nodes;
  if(parentType==='PageInfo'){if(field.name==='hasNextPage')return parent.hasNextPage;if(field.name==='endCursor')return parent.endCursor;}
  if(parentType==='PullRequestChangedFile'&&field.name==='path')return parent.path;
  if(parentType==='__Type'){
    if(field.name==='name')return parent.name;
    if(field.name==='fields')return (TYPE_FIELDS[parent.name]??[]).map(name=>({__kind:'FieldDef',name}));
    if(field.name==='enumValues')return (ENUMS[parent.name]??[]).map(name=>({__kind:'EnumDef',name}));
  }
  if((parentType==='FieldDef'||parentType==='EnumDef')&&field.name==='name')return parent.name;
  if(parentType==='Mutation') {
    const input=args.input??{};
    if(field.name==='createIssue'){
      const r=[...ctx.repositories.values()].find(x=>repoId(x)===input.repositoryId);if(!r)return null;
      const issue={number:ctx.nextIssueNumber(),title:String(input.title??''),body:String(input.body??''),state:'open',created_at:new Date().toISOString()};r.issues.set(issue.number,issue);
      return {__kind:'MutationPayload',type:'CreateIssuePayload',issue:{__kind:'Issue',repo:r,issue}};
    }
    if(field.name==='closeIssue'){
      for(const r of ctx.repositories.values())for(const i of r.issues.values())if(issueId(r,i.number)===input.issueId){i.state='closed';return {__kind:'MutationPayload',type:'CloseIssuePayload',issue:{__kind:'Issue',repo:r,issue:i}};}return null;
    }
    if(field.name==='addComment'){
      for(const r of ctx.repositories.values())for(const i of r.issues.values())if(issueId(r,i.number)===input.subjectId){const c={id:ctx.nextCommentId(),body:String(input.body??'')};(i.comments??=[]).push(c);return {__kind:'MutationPayload',type:'AddCommentPayload',commentEdge:{__kind:'CommentEdge',node:{__kind:'Comment',...c}}};}return null;
    }
    if(field.name==='createPullRequest'){
      const r=[...ctx.repositories.values()].find(x=>repoId(x)===input.repositoryId);if(!r)return null;
      const head=String(input.headRefName??''),base=String(input.baseRefName??r.default_branch),headSha=ctx.resolveBranch(r,head),baseSha=ctx.resolveBranch(r,base);if(!headSha||!baseSha)return null;
      const pull={number:Math.max(0,...[...r.pulls.keys()])+1,state:'open',title:String(input.title??''),body:'',head:{label:`${r.owner}:${head}`,ref:head,sha:headSha,repo:{name:r.name}},base:{label:`${r.owner}:${base}`,ref:base,sha:baseSha,repo:{name:r.name}},created_at:new Date().toISOString(),merged:false,merged_at:null,merge_commit_sha:null,base_sha:baseSha,head_sha:headSha};
      r.pulls.set(pull.number,pull);return {__kind:'MutationPayload',type:'CreatePullRequestPayload',pullRequest:{__kind:'PullRequest',repo:r,pull}};
    }
    if(field.name==='mergePullRequest'){
      for(const r of ctx.repositories.values())for(const p of r.pulls.values())if(pullId(r,p.number)===input.pullRequestId){const ok=ctx.mergePull(r,p);return {__kind:'MutationPayload',type:'MergePullRequestPayload',pullRequest:{__kind:'PullRequest',repo:r,pull:p},merged:ok};}return null;
    }
  }
  if(parentType==='MutationPayload') {
    if(field.name==='issue'||field.name==='pullRequest'||field.name==='commentEdge')return parent[field.name];
    if(field.name==='merged')return Boolean(parent.merged);
  }
  if(parentType==='CommentEdge'&&field.name==='node')return parent.node;
  if(parentType==='Comment'){if(field.name==='id')return globalId('IssueComment',String(parent.id));if(field.name==='body')return parent.body;}
  throw new Error(`Cannot query field "${field.name}" on type "${parentType}".`);
}

function complete(value:any, selections:Selection[], vars:Any, ctx:GraphQLContext, fragments:Map<string,Selection[]>, errors:Any[], parentType?:string):any {
  if(value===null||value===undefined)return null;
  if(Array.isArray(value))return value.map(x=>complete(x,selections,vars,ctx,fragments,errors));
  const type=parentType??typeName(value), out:Any={};
  for(const selection of selections){
    if('kind' in selection){if(selection.kind==='inline'){if(selection.type===type)Object.assign(out,complete(value,selection.selections,vars,ctx,fragments,errors,type));}else {const f=fragments.get(selection.name);if(f)Object.assign(out,complete(value,f,vars,ctx,fragments,errors,type));}continue;}
    const key=selection.alias??selection.name;
    try {const fieldValue=resolveField(value,type,selection,vars,ctx);out[key]=selection.selections.length?complete(fieldValue,selection.selections,vars,ctx,fragments,errors):fieldValue;}
    catch(e){errors.push({message:e instanceof Error?e.message:String(e),path:[key]});}
  }
  return out;
}

function executeOne(operation:Any, ctx:GraphQLContext):Any {
  const errors:Any[]=[];
  try {
    const parser=new Parser(tokenize(String(operation.query??''))), selections=parser.parse(), vars=operation.variables??{};
    const mutation=/^\s*mutation\b/u.test(String(operation.query??''));
    const data=complete({},selections,vars,ctx,parser.fragments,errors,mutation?'Mutation':'Query');
    return {data,...(errors.length?{errors}:{})};
  } catch(e){return {data:null,errors:[{message:e instanceof Error?e.message:String(e)}]};}
}

export function executeGraphQL(body: unknown, ctx: GraphQLContext): unknown {
  if(Array.isArray(body))return body.map(op=>executeOne(op,ctx));
  return executeOne(body,ctx);
}
