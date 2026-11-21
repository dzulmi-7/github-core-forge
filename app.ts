// GitHub-compatible forge: REST v3, a little GraphQL v4 and MCP, all over an in-memory store.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

type Blob = { sha: string; path: string; content: string; size: number };
type Commit = { sha: string; message: string; tree: Map<string, string>; parents: string[]; date: string };
type Issue = { number: number; title: string; body: string; state: string; labels: string[]; comments: { id: number; body: string }[]; created: number };
type Pull = { number: number; title: string; body: string; head: string; base: string; headSha: string; baseSha: string; state: string; merged: boolean; files: { filename: string; status: string; additions: number; deletions: number; changes: number; patch: string }[] };
type Repo = {
  name: string; private: boolean; defaultBranch: string; description: string; created: string;
  blobs: Map<string, Blob>; commits: Commit[]; refs: Map<string, string>;
  issues: Issue[]; pulls: Pull[]; labels: { name: string; color: string }[];
  nextIssue: number; nextPull: number; nextComment: number; seq: number;
};
type Owner = { login: string | null; repos: Map<string, Repo> };

const owners = new Map<string, Owner>();
let seq = 0;
const tokenOf = (req: IncomingMessage): string => {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
};
const ownerOf = (token: string): Owner => {
  let o = owners.get(token);
  if (!o) { o = { login: null, repos: new Map() }; owners.set(token, o); }
  return o;
};
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': String(++seq), ...headers });
  res.end(text);
};
const notFound = (res: ServerResponse) => json(res, 404, { message: 'Not Found' });
const bodyOf = (req: IncomingMessage): Promise<string> => new Promise((resolve) => {
  let data = ''; req.setEncoding('utf8');
  req.on('data', (c) => { data += c; });
  req.on('end', () => resolve(data));
  req.on('error', () => resolve(data));
});
const asObj = (text: string): Record<string, unknown> | null => {
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
};
const newRepo = (name: string, priv: boolean, description: string): Repo => ({
  name, private: priv, defaultBranch: 'main', description, created: new Date().toISOString(),
  blobs: new Map(), commits: [], refs: new Map(), issues: [], pulls: [], labels: [], nextIssue: 1, nextPull: 1, nextComment: 1, seq: 0,
});
const repoView = (r: Repo, owner: string) => ({
  id: 1000 + (r.seq++), name: r.name, full_name: `${owner}/${r.name}`, private: r.private, owner: { login: owner, type: 'User' },
  default_branch: r.defaultBranch, description: r.description, created_at: r.created, updated_at: r.created,
  html_url: `http://entry/${owner}/${r.name}`, url: `http://entry/api/v3/repos/${owner}/${r.name}`,
});
const headSha = (r: Repo): string | null => r.refs.get(`refs/heads/${r.defaultBranch}`) ?? (r.commits.length ? r.commits[r.commits.length - 1].sha : null);
const commitAt = (r: Repo, ref: string | null): Commit | null => {
  if (!ref) { const tip = r.refs.get(`refs/heads/${r.defaultBranch}`); return tip ? r.commits.find((c) => c.sha === tip) ?? null : null; }
  const sha = r.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`) ?? ref;
  return r.commits.find((c) => c.sha === sha) ?? null;
};
const writeFile = (r: Repo, path: string, contentB64: string, message: string, parent: Commit | null, branch?: string): { commit: Commit; blob: Blob } => {
  const content = Buffer.from(contentB64, 'base64').toString('base64');
  const blob: Blob = { sha: sha1(`blob ${content}`), path, content, size: Buffer.from(content, 'base64').length };
  r.blobs.set(path, blob);
  const tree = new Map(parent ? parent.tree : []);
  tree.set(path, blob.sha);
  const treeSha = sha1([...tree.entries()].sort().map(([p, s]) => `${p}:${s}`).join('\n'));
  const sha = sha1(`${treeSha}\n${message}\n${parent ? parent.sha : ''}`);
  const commit: Commit = { sha, message, tree, parents: parent ? [parent.sha] : [], date: new Date().toISOString() };
  r.commits.push(commit);
  r.refs.set(`refs/heads/${branch ?? r.defaultBranch}`, sha);
  return { commit, blob };
};
const commitView = (c: Commit) => ({
  sha: c.sha, commit: { message: c.message, author: { name: 'forge', email: 'forge@example.invalid', date: c.date }, committer: { name: 'forge', email: 'forge@example.invalid', date: c.date }, tree: { sha: sha1(c.sha) } },
  parents: c.parents.map((sha) => ({ sha })),
});

const pullJson = (p: Pull) => ({ number: p.number, title: p.title, body: p.body, state: p.state, merged: p.merged, merged_at: p.merged ? new Date().toISOString() : null, merge_commit_sha: p.merged ? p.headSha : null, head: { ref: p.head, sha: p.headSha }, base: { ref: p.base, sha: p.baseSha }, user: { login: 'viewer' }, created_at: new Date().toISOString() });

/** The REST v3 surface. Returns true when it answered the request. */
async function rest(req: IncomingMessage, res: ServerResponse, path: string, token: string): Promise<boolean> {
  const m = req.method ?? 'GET';
  if (!path.startsWith('/api/v3/')) return false;
  if (!token) { json(res, 401, { message: 'Requires authentication' }); return true; }
  const owner = ownerOf(token);
  const u = new URL(req.url ?? '/', 'http://entry');
  const q = u.searchParams;
  const parts = path.replace(/^\/api\/v3\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);

  if (path === '/api/v3/' || path === '/api/v3') { json(res, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos' }, { 'x-oauth-scopes': 'repo, read:org' }); return true; }
  if (parts[0] === 'meta' && m === 'GET') { json(res, 200, { installed_version: '3.0.0' }); return true; }
  if (parts[0] === 'user' && parts.length === 1 && m === 'GET') {
    if (!owner.login) owner.login = 'viewer';
    json(res, 200, { login: owner.login, id: 1, type: 'User' });
    return true;
  }
  if (parts[0] === 'user' && parts[1] === 'repos') {
    if (m === 'POST') {
      const b = asObj(await bodyOf(req));
      if (!b || typeof b.name !== 'string') { json(res, 400, { message: 'Invalid request body' }); return true; }
      if (owner.repos.has(b.name)) { json(res, 422, { message: 'Repository creation failed', errors: [{ message: 'name already exists' }] }); return true; }
      const repo = newRepo(b.name, b.private === true, typeof b.description === 'string' ? b.description : '');
      owner.repos.set(b.name, repo);
      json(res, 201, repoView(repo, owner.login ?? 'viewer'));
      return true;
    }
    if (m === 'GET') {
      if (!owner.login) owner.login = 'viewer';
      const all = [...owner.repos.values()];
      const per = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
      const slice = all.slice((page - 1) * per, page * per);
      const headers: Record<string, string> = {};
      if (page * per < all.length) {
        const next = new URL(`http://${req.headers.host ?? 'entry'}${path}`);
        next.searchParams.set('per_page', String(per));
        next.searchParams.set('page', String(page + 1));
        headers.link = `<${next.toString()}>; rel="next"`;
      }
      json(res, 200, slice.map((r) => repoView(r, owner.login ?? 'viewer')), headers);
      return true;
    }
  }

  if (parts[0] === 'repos' && parts.length >= 3) {
    const [, o, name, ...rest2] = parts;
    if (!owner.login) owner.login = o;
    if (owner.login !== o) { notFound(res); return true; }
    const repo = owner.repos.get(name);
    if (!repo) { notFound(res); return true; }
    const sub = rest2.join('/');

    if (rest2.length === 0) {
      if (m === 'GET') { json(res, 200, repoView(repo, o)); return true; }
      if (m === 'PATCH') {
        const b = asObj(await bodyOf(req));
        if (b && typeof b.description === 'string') repo.description = b.description;
        if (b && typeof b.private === 'boolean') repo.private = b.private;
        json(res, 200, repoView(repo, o));
        return true;
      }
      if (m === 'DELETE') { owner.repos.delete(name); res.writeHead(204, { 'x-github-request-id': String(++seq) }); res.end(); return true; }
    }

    if (sub === 'branches' && m === 'GET') {
      const list = [...repo.refs.entries()].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
      json(res, 200, list); return true;
    }
    if (sub === 'git/refs' && m === 'POST') {
      const b = asObj(await bodyOf(req));
      const ref = b && typeof b.ref === 'string' ? b.ref : '';
      const sha = b && typeof b.sha === 'string' ? b.sha : (b && typeof b.object === 'object' && b.object ? String((b.object as Record<string, unknown>).sha ?? '') : '');
      if (!ref || !sha) { json(res, 422, { message: 'Invalid ref' }); return true; }
      repo.refs.set(ref, sha);
      json(res, 201, { ref, object: { sha, type: 'commit' } }); return true;
    }
    if (sub === 'commits' && m === 'GET') {
      const c = commitAt(repo, q.get('sha'));
      const chain: Commit[] = [];
      for (let cur = c ?? commitAt(repo, null); cur; ) {
        chain.push(cur);
        const par = cur.parents[0];
        cur = par ? repo.commits.find((k) => k.sha === par) ?? null : null;
      }
      json(res, 200, chain.map(commitView)); return true;
    }
    if (sub.startsWith('contents/') || sub === 'contents') {
      const filePath = rest2.slice(1).join('/');
      if (m === 'GET') {
        if (!filePath) { json(res, 200, []); return true; }
        const direct = repo.blobs.get(filePath);
        const prefix = `${filePath}/`;
        const inDir = [...repo.blobs.values()].filter((b) => b.path.startsWith(prefix));
        if (direct && !inDir.length) {
          json(res, 200, { name: direct.path.split('/').pop(), path: direct.path, sha: direct.sha, size: direct.size, encoding: 'base64', content: direct.content, type: 'file' });
          return true;
        }
        if (inDir.length) {
          json(res, 200, inDir.map((b) => ({ name: b.path.slice(prefix.length).split('/')[0], path: b.path, sha: b.sha, size: b.size, type: 'file' })));
          return true;
        }
        notFound(res); return true;
      }
      if (m === 'PUT') {
        const b = asObj(await bodyOf(req));
        if (!b || typeof b.content !== 'string') { json(res, 400, { message: 'Invalid request body' }); return true; }
        const parent = commitAt(repo, typeof b.branch === 'string' ? b.branch : null);
        const existing = repo.blobs.get(filePath);
        if (existing && typeof b.sha === 'string' && b.sha !== existing.sha) { json(res, 409, { message: 'sha does not match' }); return true; }
        const { commit, blob } = writeFile(repo, filePath, b.content.replace(/\s+/g, ''), typeof b.message === 'string' ? b.message : 'update', parent, typeof b.branch === 'string' ? b.branch : undefined);
        json(res, existing ? 200 : 201, { content: { name: blob.path.split('/').pop(), path: blob.path, sha: blob.sha, size: blob.size, encoding: 'base64' }, commit: { sha: commit.sha, message: commit.message } });
        return true;
      }
      if (m === 'DELETE') {
        const b = asObj(await bodyOf(req)) ?? {};
        const parent = commitAt(repo, typeof b.branch === 'string' ? b.branch : null);
        repo.blobs.delete(filePath);
        const tree = new Map(parent ? parent.tree : []);
        tree.delete(filePath);
        const treeSha = sha1([...tree.entries()].sort().map(([p, s]) => `${p}:${s}`).join('\n'));
        const message = typeof b.message === 'string' ? b.message : 'delete';
        const commit: Commit = { sha: sha1(`${treeSha}\n${message}\n${parent ? parent.sha : ''}`), message, tree, parents: parent ? [parent.sha] : [], date: new Date().toISOString() };
        repo.commits.push(commit);
        repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit.sha);
        json(res, 200, { commit: { sha: commit.sha } }); return true;
      }
    }
    if (sub === 'labels') {
      if (m === 'POST') {
        const b = asObj(await bodyOf(req));
        if (!b || typeof b.name !== 'string') { json(res, 422, { message: 'Invalid label' }); return true; }
        const color = typeof b.color === 'string' ? b.color : 'ededed';
        repo.labels.push({ name: b.name, color });
        json(res, 201, { name: b.name, color, url: `http://entry/api/v3/repos/${o}/${name}/labels/${b.name}` }); return true;
      }
      if (m === 'GET') { json(res, 200, repo.labels.map((l) => ({ name: l.name, color: l.color }))); return true; }
    }
    if (rest2[0] === 'issues') {
      if (rest2.length === 1) {
        if (m === 'POST') {
          const b = asObj(await bodyOf(req));
          if (!b || typeof b.title !== 'string') { json(res, 422, { message: 'Invalid issue' }); return true; }
          const labels = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
          const unknown = labels.find((l) => !repo.labels.some((k) => k.name === l));
          if (unknown) { json(res, 422, { message: `Label does not exist: ${unknown}` }); return true; }
          const issue: Issue = { number: repo.nextIssue++, title: b.title, body: typeof b.body === 'string' ? b.body : '', state: 'open', labels, comments: [], created: Date.now() + repo.seq++ };
          repo.issues.push(issue);
          json(res, 201, { number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((l) => ({ name: l })), user: { login: o } });
          return true;
        }
        if (m === 'GET') {
          let list = repo.issues.slice();
          const state = q.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (q.get('sort') === 'created' && q.get('direction') === 'asc') list.sort((a, b) => a.created - b.created);
          else list.sort((a, b) => b.created - a.created);
          json(res, 200, list.map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map((l) => ({ name: l })) })));
          return true;
        }
      }
      const n = Number(rest2[1]);
      const issue = repo.issues.find((i) => i.number === n);
      if (rest2.length === 2 && issue) {
        if (m === 'GET') { json(res, 200, { number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((l) => ({ name: l })) }); return true; }
        if (m === 'PATCH') {
          const b = asObj(await bodyOf(req));
          if (b && typeof b.state === 'string') issue.state = b.state;
          if (b && typeof b.title === 'string') issue.title = b.title;
          if (b && typeof b.body === 'string') issue.body = b.body;
          json(res, 200, { number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((l) => ({ name: l })) });
          return true;
        }
      }
      if (rest2.length === 3 && rest2[2] === 'comments' && issue) {
        if (m === 'POST') {
          const b = asObj(await bodyOf(req));
          const body = b && typeof b.body === 'string' ? b.body : '';
          const comment = { id: repo.nextComment++, body };
          issue.comments.push(comment);
          json(res, 201, { id: comment.id, body: comment.body }); return true;
        }
        if (m === 'GET') { json(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body }))); return true; }
      }
      if (rest2.length === 2 && !issue) { notFound(res); return true; }
    }
    if (rest2[0] === 'pulls') {
      if (rest2.length === 1) {
        if (m === 'POST') {
          const b = asObj(await bodyOf(req));
          if (!b || typeof b.head !== 'string' || typeof b.base !== 'string') { json(res, 422, { message: 'Invalid pull request' }); return true; }
          const headSha = repo.refs.get(b.head.startsWith('refs/') ? b.head : `refs/heads/${b.head}`) ?? (repo.commits.length ? repo.commits[repo.commits.length - 1].sha : '');
          const baseSha = repo.refs.get(b.base.startsWith('refs/') ? b.base : `refs/heads/${b.base}`) ?? (repo.commits.length ? repo.commits[0].sha : '');
          const hc = repo.commits.find((c) => c.sha === headSha);
          const bc = repo.commits.find((c) => c.sha === baseSha);
          const files: Pull['files'] = [];
          if (hc && bc) {
            for (const [path, sha] of hc.tree) {
              if (bc.tree.get(path) !== sha) files.push({ filename: path, status: bc.tree.has(path) ? 'modified' : 'added', additions: 1, deletions: 0, changes: 1, patch: '' });
            }
            for (const path of bc.tree.keys()) if (!hc.tree.has(path)) files.push({ filename: path, status: 'deleted', additions: 0, deletions: 1, changes: 1, patch: '' });
          }
          const pull: Pull = { number: repo.nextPull++, title: typeof b.title === 'string' ? b.title : String(b.head), body: typeof b.body === 'string' ? b.body : '', head: String(b.head), base: String(b.base), headSha, baseSha, state: 'open', merged: false, files };
          repo.pulls.push(pull);
          json(res, 201, pullJson(pull));
          return true;
        }
        if (m === 'GET') {
          const state = q.get('state') ?? 'open';
          const list = state === 'all' ? repo.pulls : repo.pulls.filter((p) => p.state === state);
          json(res, 200, list.map(pullJson));
          return true;
        }
      }
      const n = Number(rest2[1]);
      const pull = repo.pulls.find((p) => p.number === n);
      if (rest2.length === 2) {
        if (!pull) { notFound(res); return true; }
        if (m === 'GET') { json(res, 200, pullJson(pull)); return true; }
      }
      if (rest2.length === 3 && rest2[2] === 'files' && pull) {
        json(res, 200, pull.files);
        return true;
      }
      if (rest2.length === 3 && rest2[2] === 'merge' && m === 'PUT') {
        if (!pull) { notFound(res); return true; }
        if (repo.refs.get(`refs/heads/${pull.base}`) !== pull.baseSha) { json(res, 405, { message: 'Pull Request is not mergeable' }); return true; }
        const sha = pull.headSha;
        pull.state = 'closed'; pull.merged = true;
        repo.refs.set(`refs/heads/${pull.base}`, sha);
        json(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      if (rest2.length >= 2 && !pull) { notFound(res); return true; }
    }
  }
  return false;
}

function graphql(res: ServerResponse, body: Record<string, unknown>, token: string): void {
  const owner = ownerOf(token);
  if (!owner.login) owner.login = 'viewer';
  const query = typeof body.query === 'string' ? body.query : '';
  const data: Record<string, unknown> = {};
  if (/viewer/.test(query)) data.viewer = { login: owner.login, name: owner.login, id: 'U_1' };
  if (/repository\s*\(/.test(query)) {
    const name = typeof body.variables === 'object' && body.variables ? String((body.variables as Record<string, unknown>).name ?? '') : '';
    const repo = owner.repos.get(name);
    data.repository = repo ? { id: `R_${repo.name}`, name: repo.name, description: repo.description, isPrivate: repo.private, defaultBranchRef: { name: repo.defaultBranch, target: { oid: headSha(repo) } } } : null;
  }
  json(res, 200, { data });
}

/** The server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = (() => { try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; } })();
      const method = req.method ?? 'GET';
      if (method === 'GET' && path === '/healthz') { json(res, 200, { ok: true }); return; }
      const token = tokenOf(req);
      if (await rest(req, res, path, token)) return;
      if (method === 'POST' && path === '/api/graphql') {
        if (!token) { json(res, 401, { message: 'Requires authentication' }); return; }
        const b = asObj(await bodyOf(req));
        if (!b) { json(res, 400, { message: 'Problems parsing JSON' }); return; }
        graphql(res, b, token); return;
      }
      if (path === '/mcp') {
        if (!token) { json(res, 401, { message: 'Requires authentication' }); return; }
        const b = asObj(await bodyOf(req)) ?? {};
        const id = b.id ?? null;
        const methodName = typeof b.method === 'string' ? b.method : '';
        if (methodName === 'initialize') {
          json(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'forge', version: '1.0.0' } } });
          return;
        }
        if (methodName === 'tools/list') {
          json(res, 200, { jsonrpc: '2.0', id, result: { tools: [] } });
          return;
        }
        if (methodName === 'tools/call') {
          json(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '{}' }], isError: false } });
          return;
        }
        json(res, 200, { jsonrpc: '2.0', id, result: {} });
        return;
      }
      if (path.startsWith('/api/v3')) { json(res, 404, { message: 'Not Found' }); return; }
      json(res, 404, { message: 'Not Found' });
    } catch {
      json(res, 500, { message: 'Internal Server Error' });
    }
  });
}
