// The starter's HTTP surface, exactly as it ships: a health probe and an API root, and a JSON 404
// for everything else. The contest's real surface — git smart HTTP, REST v3 resources, GraphQL v4 and
// the MCP endpoint — is what you add (README.md names it, and the rules link below says what scores).
//
// app.ts is deliberately separate from main.ts: this is the server, the file you grow; main.ts is the
// entry <-> env lifecycle and should stay as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RepoStore } from './src/store.ts';
import { handleGit } from './src/git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': Math.random().toString(36).slice(2,14).toUpperCase(), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]!);
      const repo = decodeURIComponent(gitMatch[2]!);
      const endpoint = gitMatch[3]!;
      const query = new URL(req.url ?? '/', 'http://entry').searchParams;
      const action = endpoint === 'info/refs' ? 'info' : endpoint === 'git-upload-pack' ? 'upload' : 'receive';
      const service = endpoint === 'git-receive-pack' ? 'git-receive-pack' : endpoint === 'git-upload-pack' ? 'git-upload-pack' : query.get('service') ?? '';
      void handleGit(req, res, owner, repo, service, action, new RepoStore(owner, repo));
      return;
    }

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    const auth = req.headers.authorization;
    const authorized = token !== '' && auth === `Bearer ${token}`;
    if (path.startsWith('/api/v3/') && !authorized) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }

    // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    if (method === 'POST' && path === '/api/v3/user/repos') {
      void (async () => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { name?: string; description?: string; private?: boolean };
          if (typeof input.name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(input.name)) { sendJson(res, 422, { message: 'Validation Failed' }); return; }
          const owner = '_';
          const repo = new RepoStore(owner, input.name);
          if (repo.exists()) { sendJson(res, 422, { message: 'Repository already exists' }); return; }
          repo.create();
          sendJson(res, 201, { name: input.name, private: input.private ?? true, default_branch: 'main', description: input.description ?? '' });
        } catch { sendJson(res, 400, { message: 'Invalid JSON' }); }
      })();
      return;
    }

    const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (repoMatch && method === 'GET') {
      const owner = decodeURIComponent(repoMatch[1]!);
      const name = decodeURIComponent(repoMatch[2]!);
      const repo = new RepoStore(owner, name);
      if (!repo.exists()) sendJson(res, 404, { message: 'Not Found' });
      else sendJson(res, 200, { name, full_name: `${owner}/${name}`, private: true, default_branch: 'main', description: '' });
      return;
    }

    // Everything else, every method: GitHub's 404 body.
    sendJson(res, 404, { message: 'Not Found' });
  });
}
