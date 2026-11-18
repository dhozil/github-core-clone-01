import type { IncomingMessage, ServerResponse } from 'node:http';

type Repo = { id: number; owner: string; name: string; description: string; private: boolean; default_branch: string; issues: Map<number, Record<string, any>>; pulls: Map<number, Record<string, any>> };
type Ops = { token: string; viewer: string; repo(owner: string, name: string): Repo | undefined; createRepo(name: string): unknown; nextIssue(): number; merge(meta: Repo, pull: Record<string, any>): boolean };
const tools = [
  { name: 'create_repo', description: 'Create a repository.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List repository issues.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
const response = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const error = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
export async function handleMcp(req: IncomingMessage, res: ServerResponse, ops: Ops): Promise<void> {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
  let rpc: any; try { rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(error(null, -32700, 'Parse error'))); return; }
  const id = rpc?.id ?? null, method = rpc?.method, params = rpc?.params ?? {};
  if (method === 'tools/call' && (!ops.token || req.headers.authorization !== `Bearer ${ops.token}`)) { res.writeHead(401); res.end(); return; }
  let out: any;
  if (method === 'server/discover') out = response(id, { serverInfo: { name: 'github-core-clone', version: '1.0.0' }, capabilities: { tools: {} }, supportedVersions: ['2026-07-28', '2025-11-25'] });
  else if (method === 'initialize') out = response(id, { protocolVersion: params.protocolVersion ?? '2025-11-25', serverInfo: { name: 'github-core-clone', version: '1.0.0' }, capabilities: { tools: {} } });
  else if (method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
  else if (method === 'tools/list') out = response(id, { tools });
  else if (method === 'tools/call') {
    const name = String(params.name ?? '').toLowerCase().split(/__|__/).pop(), a = params.arguments ?? {};
    if (!tools.some(t => t.name === name)) out = error(id, -32602, 'Unknown tool');
    else {
      const missing = (tools.find(t => t.name === name)!.inputSchema.required as string[]).some(k => a[k] === undefined);
      if (missing) out = { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Missing required arguments' }] } };
      else { let value: any;
        if (name === 'create_repo') value = ops.createRepo(a.name);
        else { const meta = ops.repo(a.owner, a.repo); if (!meta) value = { message: 'Not Found' };
          else if (name === 'get_repo') value = { id: meta.id, name: meta.name, full_name: `${meta.owner}/${meta.name}`, owner: { login: meta.owner }, private: meta.private, default_branch: meta.default_branch, description: meta.description };
          else if (name === 'create_issue') { value = { number: ops.nextIssue(), title: a.title, body: a.body ?? '', state: 'open', labels: [], created_at: new Date().toISOString() }; meta.issues.set(value.number, value); }
          else if (name === 'list_issues') value = [...meta.issues.values()].filter(i => !a.state || a.state === 'all' || i.state === a.state);
          else if (name === 'create_pull_request') { value = { number: meta.pulls.size + 1, state: 'open', title: a.title, head: { ref: a.head }, base: { ref: a.base }, merged: false }; meta.pulls.set(value.number, value); }
          else { const pull = meta.pulls.get(Number(a.pull_number)); if (!pull) value = { message: 'Not Found' }; else { ops.merge(meta, pull); value = pull; } }
        }
        out = response(id, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
      }
    }
  } else out = error(id, -32601, 'Method not found');
  const accept = String(req.headers.accept ?? '');
  if (accept.includes('text/event-stream')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`event: message\ndata: ${JSON.stringify(out)}\n\n`); }
  else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
}
