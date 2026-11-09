import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHandler } from '../server/github.mjs';

const ORIGIN = 'https://weilun-bot.github.io';
const BACKEND = 'https://upload.example';
const ENV = {
  GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: Buffer.alloc(32, 7).toString('base64url'),
  BACKEND_ORIGIN: BACKEND, FRONTEND_URL: ORIGIN + '/svg-crop-pages/',
};
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>道路配置圖</text></svg>';
const SVG_OLD = '<svg xmlns="http://www.w3.org/2000/svg"><text>舊版</text></svg>';
const blobSha = text => createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex');
const files = () => [{ name: '道路配置.svg', content: SVG }, { name: '原圖-crops.json', content: '{"version":3,"crops":[]}' }];

function fixture() {
  const state = { clock: 1800000000000, role: 'write', userId: 7, head: 'a'.repeat(40), calls: [], race: false, revoked: false };
  const reply = (value, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    const body = options.body instanceof URLSearchParams ? Object.fromEntries(options.body) : options.body ? JSON.parse(options.body) : undefined;
    state.calls.push({ path: url.pathname, method, body, headers: options.headers });
    if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') return reply({ access_token: 'fake-github-user-token', token_type: 'bearer', expires_in: 28800 });
    assert.equal(url.origin, 'https://api.github.com', 'all service calls must stay on GitHub');
    if (state.revoked) return reply({}, 401);
    const path = url.pathname;
    if (path === '/user') return reply({ id: state.userId, login: 'editor' });
    if (/^\/applications\/test-client\/token$/.test(path) && method === 'DELETE') { state.revoked = true; return reply(null, 204); }
    if (/^\/repos\/WeiLun-bot\/(road-signal-guide|traffic-guide)$/.test(path)) return reply({ permissions: { push: state.role === 'write' } });
    if (path.endsWith('/collaborators/editor/permission')) return reply({ permission: state.role });
    if (path.endsWith('/git/ref/heads/main')) return reply({ object: { sha: state.head } });
    if (/\/git\/commits\/[a-z0-9]{40}$/.test(path) && method === 'GET') return reply({ tree: { sha: 'root-tree' } });
    if (path.endsWith('/git/trees/root-tree')) return reply({ tree: [{ path: 'media', mode: '040000', type: 'tree', sha: 'media-tree' }, { path: 'materials', mode: '040000', type: 'tree', sha: 'media-tree' }] });
    if (path.endsWith('/git/trees/media-tree')) return reply({ tree: [{ path: '03-modules', mode: '040000', type: 'tree', sha: 'chapter-tree' }, { path: '連結目錄', mode: '120000', type: 'blob', sha: 'symlink' }] });
    if (path.endsWith('/git/trees/chapter-tree')) return reply({ tree: [{ path: '道路配置.svg', mode: '100644', type: 'blob', sha: blobSha(state.existing ?? SVG_OLD) }] });
    if (path.endsWith('/git/trees') && method === 'POST') return reply({ sha: 'new-tree' });
    if (path.endsWith('/git/commits') && method === 'POST') return reply({ sha: 'f'.repeat(40) });
    if (path.endsWith('/git/refs/heads/main') && method === 'PATCH') {
      if (state.race) return reply({}, 422);
      state.head = body.sha; return reply({ object: { sha: body.sha } });
    }
    throw Error('Unexpected mock GitHub call: ' + method + ' ' + path);
  };
  const handle = createHandler({ fetcher, now: () => state.clock });
  const request = (path, { session, body, headers = {}, env = ENV, origin = ORIGIN } = {}) => handle(new Request(BACKEND + '/api/github' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(session ? { Authorization: 'Bearer ' + session } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  async function beginLogin(frontendOrigin = '') {
    const nonce = Buffer.alloc(32, 8).toString('base64url');
    const start = await request('/auth/login?nonce=' + nonce + (frontendOrigin ? '&origin=' + encodeURIComponent(frontendOrigin) : ''));
    assert.equal(start.status, 302);
    const location = new URL(start.headers.get('location'));
    return { nonce, location, cookie: start.headers.get('set-cookie').split(';')[0], cookieHeader: start.headers.get('set-cookie') };
  }
  async function login(frontendOrigin = '') {
    const flow = await beginLogin(frontendOrigin);
    const response = await request('/auth/callback?code=test-code&state=' + flow.location.searchParams.get('state'), { headers: { Cookie: flow.cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    const html = await response.text();
    const payload = JSON.parse(html.match(/window\.opener\.postMessage\((\{.*?\}),/)[1]);
    return { ...flow, html, payload, session: payload.session, response };
  }
  async function preview(session, extra = {}) {
    const response = await request('/preview', { session, body: { target: 'guide', folder: '03-modules', files: files(), ...extra } });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  }
  return { state, handle, request, beginLogin, login, preview };
}
const writes = state => state.calls.filter(call => ['POST', 'PATCH'].includes(call.method) && call.path.includes('/git/'));

test('anonymous callers cannot browse private folders or write files', async () => {
  const f = fixture();
  assert.equal((await f.request('/folders?target=guide')).status, 401);
  assert.equal((await f.request('/upload', { body: {} })).status, 401);
  assert.equal(f.state.calls.length, 0);
});

test('GitHub login binds state to a secure popup cookie, uses PKCE, and conceals the GitHub token', async () => {
  const f = fixture(); const flow = await f.beginLogin();
  assert.match(flow.cookieHeader, /__Host-svg-oauth=.*HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  assert.equal(flow.location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(flow.location.searchParams.get('redirect_uri'), BACKEND + '/api/github/auth/callback');
  assert.equal(flow.location.searchParams.has('scope'), false, 'GitHub App permissions come from installation');
  assert.equal((await f.request('/auth/callback?code=x&state=' + flow.location.searchParams.get('state'))).status, 401);
  assert.equal((await f.request('/auth/callback?code=x&state=wrong', { headers: { Cookie: flow.cookie } })).status, 400);
  const loggedIn = await f.login();
  assert.ok(loggedIn.session); assert.equal(loggedIn.payload.nonce, loggedIn.nonce);
  assert.equal(loggedIn.html.includes('fake-github-user-token'), false);
  assert.match(loggedIn.html, /https:\/\/weilun-bot.github.io/);
  assert.match(loggedIn.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(loggedIn.response.headers.get('set-cookie'), /Max-Age=0/);
  const exchange = f.state.calls.find(c => c.path === '/login/oauth/access_token');
  assert.equal(exchange.body.client_secret, ENV.GITHUB_CLIENT_SECRET);
  assert.ok(exchange.body.code_verifier);
});

test('cancelled OAuth returns a clear result without generating a session', async () => {
  const f = fixture(); const flow = await f.beginLogin();
  const response = await f.request('/auth/callback?error=access_denied&state=' + flow.location.searchParams.get('state'), { headers: { Cookie: flow.cookie } });
  assert.equal(response.status, 200); assert.match(await response.text(), /GitHub 登入已取消/); assert.equal(f.state.calls.length, 0);
});

test('OAuth returns login only to the allowed site that opened the popup', async () => {
  const f = fixture();
  const login = await f.login(BACKEND);
  assert.ok(login.html.includes(',' + JSON.stringify(BACKEND) + ');'));
  assert.equal(login.html.includes(',' + JSON.stringify(ORIGIN) + ');'), false);
  const bad = await f.request('/auth/login?' + new URLSearchParams({ nonce: Buffer.alloc(32, 8).toString('base64url'), origin: 'https://untrusted.example' }));
  assert.equal(bad.status, 400); assert.equal(bad.headers.get('location'), null); assert.equal(bad.headers.get('set-cookie'), null);
});

test('OAuth state and login sessions expire', async () => {
  const f = fixture(); const flow = await f.beginLogin(); f.state.clock += 601000;
  assert.equal((await f.request('/auth/callback?code=x&state=' + flow.location.searchParams.get('state'), { headers: { Cookie: flow.cookie } })).status, 401);
  const { session } = await f.login(); f.state.clock += 3600001;
  assert.equal((await f.request('/session', { session })).status, 401);
});

test('CORS permits only the configured site and backend, never wildcard origins', async () => {
  const f = fixture();
  const rejected = await f.request('/status', { origin: 'https://untrusted.example' });
  assert.equal(rejected.status, 403); assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  const accepted = await f.request('/status'); assert.equal(accepted.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
  const preflight = await f.handle(new Request(BACKEND + '/api/github/upload', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), ENV);
  assert.equal(preflight.status, 204); assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
});

test('being logged in without repository write access does not allow uploads', async () => {
  const f = fixture(); const { session } = await f.login(); f.state.role = 'read';
  const response = await f.request('/session', { session }); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).targets, []);
  assert.equal((await f.request('/folders?target=guide', { session })).status, 403);
  assert.equal((await f.request('/preview', { session, body: { target: 'guide', folder: '', files: files() } })).status, 403);
  assert.equal(writes(f.state).length, 0);
});

test('folder browsing stays inside the configured root and skips symlink directories', async () => {
  const f = fixture(); const { session } = await f.login();
  const listing = await f.request('/folders?target=guide', { session });
  assert.deepEqual((await listing.json()).folders, ['03-modules']);
  for (const folder of ['../materials', 'x/../../y', 'a\\b', '%2e%2e', '/absolute', 'a//b']) {
    assert.equal((await f.request('/folders?' + new URLSearchParams({ target: 'guide', folder }), { session })).status, 400, folder);
  }
  assert.equal((await f.request('/folders?target=guide&folder=連結目錄', { session })).status, 404);
  assert.equal((await f.request('/folders?target=other', { session })).status, 400);
});

test('preview rejects unsafe paths, duplicate names, invalid JSON and unsupported file types', async () => {
  const f = fixture(); const { session } = await f.login();
  const cases = [
    [{ name: '../outside.svg', content: SVG }], [{ name: 'script.js', content: 'alert(1)' }],
    [{ name: 'a.json', content: 'invalid' }], [{ name: 'a.svg', content: '<html>not svg</html>' }],
    [{ name: 'a.svg', content: SVG }, { name: 'A.svg', content: SVG }],
  ];
  for (const fileList of cases) assert.equal((await f.request('/preview', { session, body: { target: 'guide', folder: '03-modules', files: fileList } })).status, 400);
  assert.equal(writes(f.state).length, 0);
});

test('preview classifies Unicode filenames and requires explicit overwrite consent', async () => {
  const f = fixture(); const { session } = await f.login(); const plan = await f.preview(session);
  assert.deepEqual(plan.files.map(file => file.status), ['update', 'new']);
  assert.equal(plan.files[0].sha, blobSha(SVG)); assert.equal(plan.files[0].bytes, Buffer.byteLength(SVG));
  assert.equal(plan.directory, 'media/03-modules');
  const blocked = await f.request('/upload', { session, body: { plan: plan.plan, files: files() } });
  assert.equal(blocked.status, 409); assert.equal(writes(f.state).length, 0);
});

test('uploads create one commit for all changed files and never force-push', async () => {
  const f = fixture(); const { session } = await f.login(); const plan = await f.preview(session);
  const response = await f.request('/upload', { session, body: { plan: plan.plan, files: files(), overwrite: true } });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json(); assert.equal(result.count, 2); assert.match(result.url, /github.com\/WeiLun-bot\/road-signal-guide\/commit\//);
  const calls = writes(f.state); assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].body.tree.map(entry => entry.path), ['media/03-modules/道路配置.svg', 'media/03-modules/原圖-crops.json']);
  assert.equal(calls[0].body.base_tree, 'root-tree');
  assert.deepEqual(calls[1].body.parents, ['a'.repeat(40)]);
  assert.deepEqual(calls[2].body, { sha: 'f'.repeat(40), force: false });
});

test('a preview cannot be reused with altered files, another user, or a relocated target', async () => {
  const f = fixture(); const { session } = await f.login(); const plan = await f.preview(session);
  const changed = files(); changed[0].content = SVG_OLD;
  assert.equal((await f.request('/upload', { session, body: { plan: plan.plan, files: changed, overwrite: true } })).status, 409);
  const tokenParts = plan.plan.split('.'); tokenParts[1] = (tokenParts[1][0] === 'A' ? 'B' : 'A') + tokenParts[1].slice(1);
  assert.equal((await f.request('/upload', { session, body: { plan: tokenParts.join('.'), files: files(), overwrite: true } })).status, 401);
  f.state.userId = 9; const other = await f.login();
  assert.equal((await f.request('/upload', { session: other.session, body: { plan: plan.plan, files: files(), overwrite: true } })).status, 409);
  const env = { ...ENV, GITHUB_UPLOAD_TARGETS: JSON.stringify([{ id: 'guide', label: '整合指引', owner: 'WeiLun-bot', repo: 'road-signal-guide', branch: 'main', root: 'media/materials' }]) };
  assert.equal((await f.request('/upload', { env, session, body: { plan: plan.plan, files: files(), overwrite: true } })).status, 409);
  assert.equal(writes(f.state).length, 0);
});

test('concurrent updates are rejected before writes and races never overwrite the new head', async () => {
  const f = fixture(); const { session } = await f.login(); const plan = await f.preview(session);
  f.state.head = 'b'.repeat(40);
  assert.equal((await f.request('/upload', { session, body: { plan: plan.plan, files: files(), overwrite: true } })).status, 409);
  assert.equal(writes(f.state).length, 0);
  f.state.head = 'a'.repeat(40); f.state.race = true;
  assert.equal((await f.request('/upload', { session, body: { plan: plan.plan, files: files(), overwrite: true } })).status, 409);
  assert.equal(f.state.head, 'a'.repeat(40)); assert.equal(writes(f.state).at(-1).body.force, false);
});

test('permission removal and expired previews stop an already prepared upload', async () => {
  const f = fixture(); const { session } = await f.login(); const plan = await f.preview(session);
  f.state.role = 'read';
  assert.equal((await f.request('/upload', { session, body: { plan: plan.plan, files: files(), overwrite: true } })).status, 403);
  f.state.role = 'write'; f.state.clock += 600001;
  assert.equal((await f.request('/upload', { session, body: { plan: plan.plan, files: files(), overwrite: true } })).status, 401);
  assert.equal(writes(f.state).length, 0);
});

test('unchanged files are skipped without producing empty commits', async () => {
  const f = fixture(); f.state.existing = SVG; const { session } = await f.login();
  const list = [{ name: '道路配置.svg', content: SVG }]; const plan = await f.preview(session, { files: list });
  assert.equal(plan.files[0].status, 'unchanged');
  const response = await f.request('/upload', { session, body: { plan: plan.plan, files: list } });
  assert.deepEqual(await response.json(), { unchanged: true }); assert.equal(writes(f.state).length, 0);
});

test('oversized bodies and excessive file batches are rejected without GitHub writes', async () => {
  const f = fixture(); const { session } = await f.login();
  const tooLarge = [{ name: 'a.svg', content: '<svg>' + 'x'.repeat(4 * 1024 * 1024) + '</svg>' }];
  assert.equal((await f.request('/preview', { session, body: { target: 'guide', folder: '', files: tooLarge } })).status, 413);
  const tooMany = Array.from({ length: 65 }, (_, i) => ({ name: i + '.svg', content: SVG }));
  assert.equal((await f.request('/preview', { session, body: { target: 'guide', folder: '', files: tooMany } })).status, 400);
  assert.equal(writes(f.state).length, 0);
});

test('logout revokes the per-user token and subsequent calls cannot reuse it', async () => {
  const f = fixture(); const { session } = await f.login();
  assert.equal((await f.request('/logout', { session, body: {} })).status, 200);
  const revoke = f.state.calls.find(call => call.method === 'DELETE');
  assert.equal(revoke.headers.Authorization, 'Basic ' + btoa(ENV.GITHUB_CLIENT_ID + ':' + ENV.GITHUB_CLIENT_SECRET));
  assert.equal((await f.request('/session', { session })).status, 401);
});

test('Vercel rewrites route to the same handler and unconfigured services fail closed', async () => {
  const f = fixture();
  const routed = await f.handle(new Request(BACKEND + '/api/github?route=status', { headers: { Origin: ORIGIN } }), ENV);
  assert.deepEqual(await routed.json(), { ready: true });
  const missing = await f.request('/status', { env: {} }); assert.equal(missing.status, 503);
  assert.equal(missing.headers.get('access-control-allow-origin'), ORIGIN, 'the configured frontend can read setup errors');
  assert.equal((await missing.text()).includes('test-client-secret'), false);
});

test('public deployment origins default from site configuration while missing credentials still block login', async () => {
  const f = fixture();
  const env = { GITHUB_CLIENT_ID: ENV.GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: ENV.GITHUB_CLIENT_SECRET, SESSION_SECRET: ENV.SESSION_SECRET };
  const response = await f.request('/status', { env });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ready: true });
  const preflight = await f.handle(new Request('https://svg-crop-pages.vercel.app/api/github/upload', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), {});
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  const rejected = await f.request('/status', { env: {}, origin: 'https://untrusted.example' });
  assert.equal(rejected.status, 403); assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  const disabled = await f.request('/auth/login?nonce=' + Buffer.alloc(32, 8).toString('base64url'), { env: {} });
  assert.equal(disabled.status, 503); assert.equal(disabled.headers.get('location'), null);
});
