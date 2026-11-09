import { defaultTargets } from './targets.mjs';
import siteConfig from '../github-config.json' with { type: 'json' };

const encoder = new TextEncoder();
const PREFIX = '/api/github';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_FILES = 64;
const SESSION_SECONDS = 3600;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (data, status = 200) => Response.json(data, { status });
const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
const random = () => to64(crypto.getRandomValues(new Uint8Array(32)));
function to64(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function from64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail(401, '登入已失效，請重新登入 GitHub。');
  try { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
  catch { fail(401, '登入已失效，請重新登入 GitHub。'); }
}
function pathParts(path, allowEmpty = true) {
  if (typeof path !== 'string' || path.length > 500 || /[\\\u0000-\u001f%]/.test(path)) fail(400, '資料夾路徑無效。');
  if (!path && allowEmpty) return [];
  const parts = path.split('/');
  if (parts.length > 20 || parts.some(p => !p || p === '.' || p === '..' || p.trim() !== p || /^\.git(?:hub)?$/i.test(p))) fail(400, '資料夾路徑無效。');
  return parts;
}
function getOrigins(env) {
  let frontend, backend;
  try { frontend = new URL(env.FRONTEND_URL || siteConfig.frontendUrl); backend = new URL(env.BACKEND_ORIGIN || siteConfig.backendOrigin); }
  catch { fail(503, 'GitHub 上傳尚未啟用，請聯絡管理者。'); }
  for (const url of [frontend, backend]) {
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) fail(503, '登入服務網址設定無效。');
  }
  if (backend.pathname !== '/') fail(503, '登入服務網址設定無效。');
  return { frontend, backend };
}
function getConfig(env) {
  const { frontend, backend } = getOrigins(env);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) fail(503, 'GitHub 上傳尚未啟用，請聯絡管理者。');
  if (!/^[A-Za-z0-9_-]{43}$/.test(env.SESSION_SECRET)) fail(503, '登入服務金鑰設定無效。');
  let targets;
  try { targets = env.GITHUB_UPLOAD_TARGETS ? JSON.parse(env.GITHUB_UPLOAD_TARGETS) : defaultTargets; }
  catch { fail(503, '上傳位置設定無效。'); }
  if (!Array.isArray(targets) || !targets.length || targets.length > 20) fail(503, '上傳位置設定無效。');
  const ids = new Set();
  for (const target of targets) {
    if (!target || !/^[a-z][a-z0-9-]{0,39}$/.test(target.id) || ids.has(target.id) || typeof target.label !== 'string' || typeof target.owner !== 'string' || !/^[\w.-]+$/.test(target.owner) || typeof target.repo !== 'string' || !/^[\w.-]+$/.test(target.repo) || ['.', '..'].includes(target.repo) || typeof target.branch !== 'string' || !target.branch || target.branch.includes('..')) fail(503, '上傳位置設定無效。');
    pathParts(target.root, false); ids.add(target.id);
  }
  return { frontend, backend, targets, callback: backend.origin + PREFIX + '/auth/callback' };
}
async function keyFor(env) {
  const bytes = from64(env.SESSION_SECRET);
  if (bytes.length !== 32) fail(503, '登入服務金鑰設定無效。');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(value, env, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) }, await keyFor(env), encoder.encode(JSON.stringify(value)));
  return to64(iv) + '.' + to64(new Uint8Array(bytes));
}
async function unseal(value, env, purpose, now) {
  try {
    if (typeof value !== 'string' || value.length > (purpose === 'plan' ? 60000 : 14000)) throw Error();
    const parts = value.split('.'); if (parts.length !== 2) throw Error();
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(parts[0]), additionalData: encoder.encode(purpose) }, await keyFor(env), from64(parts[1]));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!Number.isFinite(data.exp) || data.exp <= now()) throw Error();
    return data;
  } catch { fail(401, purpose === 'plan' ? '上傳預覽已失效，請重新預覽。' : '登入已失效，請重新登入 GitHub。'); }
}
async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, '請使用 JSON 格式傳送。');
  if (Number(request.headers.get('content-length')) > MAX_BODY) fail(413, '單次上傳上限為 4 MB，請減少裁切圖或分批上傳。');
  const reader = request.body?.getReader(); if (!reader) fail(400, '缺少上傳資料。');
  const chunks = []; let length = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    length += next.value.length;
    if (length > MAX_BODY) { await reader.cancel(); fail(413, '單次上傳上限為 4 MB，請減少裁切圖或分批上傳。'); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, '上傳資料不是有效的 JSON。'); }
}
async function fileManifest(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) fail(400, '每次請上傳 1 至 64 個檔案。');
  const names = new Set(); const manifest = [];
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || file.name.length > 160 || /[\\/:*?"<>|\u0000-\u001f]/.test(file.name) || file.name.trim() !== file.name || !/\.(svg|json)$/i.test(file.name) || typeof file.content !== 'string' || !file.content.length) fail(400, '僅接受有效檔名的 SVG 與 JSON。');
    const folded = file.name.normalize('NFC').toLowerCase();
    if (names.has(folded)) fail(400, '輸出檔名重複，請修改裁切圖名稱。'); names.add(folded);
    if (/\.json$/i.test(file.name)) {
      try { JSON.parse(file.content); } catch { fail(400, file.name + ' 不是有效的 JSON。'); }
    } else if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(file.content)) fail(400, file.name + ' 不是有效的 SVG。');
    const content = encoder.encode(file.content);
    const header = encoder.encode('blob ' + content.length + '\0');
    const blob = new Uint8Array(header.length + content.length); blob.set(header); blob.set(content, header.length);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', blob));
    manifest.push({ name: file.name, sha: Array.from(hash, b => b.toString(16).padStart(2, '0')).join(''), bytes: content.length });
  }
  return manifest;
}
async function manifestDigest(manifest) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(manifest)));
  return to64(new Uint8Array(bytes));
}
function cookie(request, name) {
  return (request.headers.get('cookie') || '').split(';').map(c => c.trim()).find(c => c.startsWith(name + '='))?.slice(name.length + 1);
}
function oauthCookie(config, value, maxAge) {
  const secure = config.backend.protocol === 'https:';
  return (secure ? '__Host-svg-oauth' : 'svg-oauth') + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (secure ? '; Secure' : '');
}
function callbackPage(config, payload, frontendOrigin = config.frontend.origin) {
  const nonce = random();
  const safe = JSON.stringify(payload).replaceAll('<', '\\u003c');
  const target = JSON.stringify(frontendOrigin);
  return new Response('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>GitHub 登入</title><body><p id="status">正在完成登入…</p><script nonce="' + nonce + '">if(window.opener){window.opener.postMessage(' + safe + ',' + target + ');document.getElementById("status").textContent="已完成，請回到裁切工作室。";window.close()}else{document.getElementById("status").textContent="請回到裁切工作室重新按 GitHub 登入。"}</script></body></html>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; base-uri 'none'; frame-ancestors 'none'", 'Set-Cookie': oauthCookie(config, '', 0) },
  });
}

export function createHandler({ fetcher = fetch, now = () => Date.now() } = {}) {
  async function github(token, path, options = {}) {
    let response;
    try { response = await fetcher('https://api.github.com' + path, { ...options, signal: AbortSignal.timeout(15000), headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'User-Agent': 'svg-crop-studio', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }); }
    catch { fail(502, '暫時無法連線 GitHub，請稍後重試。'); }
    if (!response.ok) {
      if (response.status === 401) fail(401, 'GitHub 授權已失效，請重新登入。');
      if (response.status === 403) fail(403, 'GitHub 拒絕存取，請確認寫入權限與 GitHub App 安裝設定，或稍後重試。');
      if (response.status === 404) fail(404, '找不到儲存庫或資料夾，請確認 GitHub App 已安裝且你有存取權限。');
      if ([409, 422].includes(response.status)) fail(409, 'GitHub 上的內容或分支規則已變更，請重新預覽；受保護分支可能需要透過 Pull Request 更新。');
      fail(502, 'GitHub 未完成操作，請稍後重試。');
    }
    return response.status === 204 ? null : response.json();
  }
  const repoPath = target => '/repos/' + encodeURIComponent(target.owner) + '/' + encodeURIComponent(target.repo);
  async function checkWriter(session, target) {
    const repo = await github(session.token, repoPath(target));
    if (repo.permissions?.push === true) return repo;
    const permission = await github(session.token, repoPath(target) + '/collaborators/' + encodeURIComponent(session.user.login) + '/permission');
    if (!['write', 'maintain', 'admin'].includes(permission.permission) && permission.user?.permissions?.push !== true) fail(403, '你沒有這個儲存庫的寫入權限。');
    return repo;
  }
  async function snapshot(session, target) {
    const base = repoPath(target);
    const ref = await github(session.token, base + '/git/ref/heads/' + encodePath(target.branch));
    const commit = await github(session.token, base + '/git/commits/' + ref.object.sha);
    return { commit: ref.object.sha, tree: commit.tree.sha };
  }
  async function directory(session, target, tree, folder) {
    let current = tree;
    for (const part of [...pathParts(target.root, false), ...pathParts(folder)]) {
      const listing = await github(session.token, repoPath(target) + '/git/trees/' + current);
      if (listing.truncated) fail(409, '資料夾過大，無法完整檢查，請聯絡管理者。');
      const entry = listing.tree.find(e => e.path === part);
      if (!entry || entry.type !== 'tree' || entry.mode !== '040000') fail(404, '找不到指定子資料夾，請重新選擇。');
      current = entry.sha;
    }
    const listing = await github(session.token, repoPath(target) + '/git/trees/' + current);
    if (listing.truncated) fail(409, '資料夾過大，無法完整檢查，請聯絡管理者。');
    return listing.tree;
  }
  async function route(request, env, config, path, url) {
    if (path === '/status' && request.method === 'GET') return json({ ready: true });
    if (path === '/auth/login' && request.method === 'GET') {
      const clientNonce = url.searchParams.get('nonce');
      if (!/^[A-Za-z0-9_-]{32,100}$/.test(clientNonce || '')) fail(400, '請從裁切工作室開始登入。');
      const frontendOrigin = url.searchParams.get('origin') || config.frontend.origin;
      if (![config.frontend.origin, config.backend.origin].includes(frontendOrigin)) fail(400, '請從裁切工作室網站開始登入。');
      const state = random(), verifier = random();
      const challenge = to64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
      const auth = new URL('https://github.com/login/oauth/authorize');
      auth.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: config.callback, state, code_challenge: challenge, code_challenge_method: 'S256' });
      return new Response(null, { status: 302, headers: { Location: auth.href, 'Set-Cookie': oauthCookie(config, await seal({ state, verifier, clientNonce, frontendOrigin, exp: now() + 600000 }, env, 'oauth'), 600) } });
    }
    if (path === '/auth/callback' && request.method === 'GET') {
      // A popup-bound, single-use browser cookie prevents login CSRF and carries the PKCE verifier.
      const stored = await unseal(cookie(request, config.backend.protocol === 'https:' ? '__Host-svg-oauth' : 'svg-oauth'), env, 'oauth', now);
      if (url.searchParams.get('state') !== stored.state) fail(400, 'GitHub 登入狀態不符，請重新登入。');
      const frontendOrigin = stored.frontendOrigin || config.frontend.origin;
      if (![config.frontend.origin, config.backend.origin].includes(frontendOrigin)) fail(400, '網站設定已變更，請重新登入。');
      if (url.searchParams.has('error')) return callbackPage(config, { type: 'svg-github-login', nonce: stored.clientNonce, error: 'GitHub 登入已取消。' }, frontendOrigin);
      const code = url.searchParams.get('code'); if (!code || code.length > 500) fail(400, '缺少 GitHub 登入驗證碼。');
      let tokenResponse;
      try { tokenResponse = await fetcher('https://github.com/login/oauth/access_token', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: config.callback, code_verifier: stored.verifier }) }); }
      catch { fail(502, '暫時無法完成 GitHub 登入，請重試。'); }
      const data = await tokenResponse.json();
      if (!tokenResponse.ok || !data.access_token || data.token_type?.toLowerCase() !== 'bearer') return callbackPage(config, { type: 'svg-github-login', nonce: stored.clientNonce, error: 'GitHub 授權未完成，請重新登入。' }, frontendOrigin);
      const user = await github(data.access_token, '/user');
      const seconds = Math.min(SESSION_SECONDS, Number(data.expires_in) || SESSION_SECONDS);
      const session = await seal({ token: data.access_token, user: { id: user.id, login: user.login }, exp: now() + seconds * 1000 }, env, 'session');
      return callbackPage(config, { type: 'svg-github-login', nonce: stored.clientNonce, session, expiresAt: now() + seconds * 1000 }, frontendOrigin);
    }
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) fail(401, '請先登入 GitHub。');
    const session = await unseal(authorization.slice(7), env, 'session', now);
    if (path === '/session' && request.method === 'GET') {
      const user = await github(session.token, '/user');
      if (user.id !== session.user.id) fail(401, '登入已失效，請重新登入。');
      const targets = [];
      for (const target of config.targets) {
        try { await checkWriter(session, target); targets.push(target); }
        catch (error) { if (![403, 404].includes(error.status)) throw error; }
      }
      return json({ user: { login: user.login }, targets, expiresAt: session.exp });
    }
    if (path === '/logout' && request.method === 'POST') {
      // Revoke this user's GitHub token, so copied/old sealed sessions also stop working.
      await github(session.token, '/applications/' + encodeURIComponent(env.GITHUB_CLIENT_ID) + '/token', { method: 'DELETE', headers: { Authorization: 'Basic ' + btoa(env.GITHUB_CLIENT_ID + ':' + env.GITHUB_CLIENT_SECRET) }, body: JSON.stringify({ access_token: session.token }) });
      return json({ ok: true });
    }
    if (path === '/folders' && request.method === 'GET') {
      const target = config.targets.find(t => t.id === url.searchParams.get('target'));
      if (!target) fail(400, '上傳位置無效。');
      const folder = url.searchParams.get('folder') || ''; pathParts(folder);
      await checkWriter(session, target);
      const snap = await snapshot(session, target);
      const entries = await directory(session, target, snap.tree, folder);
      return json({ folder, folders: entries.filter(e => e.type === 'tree' && e.mode === '040000').map(e => e.path).sort((a, b) => a.localeCompare(b, 'zh-Hant')) });
    }
    if (path === '/preview' && request.method === 'POST') {
      const body = await readBody(request);
      const target = config.targets.find(t => t.id === body.target);
      if (!target) fail(400, '上傳位置無效。');
      const folder = body.folder ?? ''; pathParts(folder);
      const manifest = await fileManifest(body.files);
      await checkWriter(session, target);
      const snap = await snapshot(session, target);
      const entries = await directory(session, target, snap.tree, folder);
      const files = manifest.map(file => {
        const existing = entries.find(e => e.path.normalize('NFC').toLowerCase() === file.name.normalize('NFC').toLowerCase());
        if (existing && (existing.path !== file.name || existing.type !== 'blob' || !['100644', '100755'].includes(existing.mode))) fail(409, '檔名「' + file.name + '」與既有項目衝突，請重新命名。');
        return { ...file, status: !existing ? 'new' : existing.sha === file.sha ? 'unchanged' : 'update' };
      });
      const digest = await manifestDigest(manifest);
      const plan = await seal({ target: target.id, root: target.root, owner: target.owner, repo: target.repo, branch: target.branch, folder, userId: session.user.id, ...snap, digest, changes: files.filter(f => f.status !== 'unchanged').map(f => f.name), overwrite: files.some(f => f.status === 'update'), exp: now() + 600000 }, env, 'plan');
      return json({ plan, files, repository: target.owner + '/' + target.repo, branch: target.branch, directory: target.root + (folder ? '/' + folder : '') });
    }
    if (path === '/upload' && request.method === 'POST') {
      const body = await readBody(request);
      const plan = await unseal(body.plan, env, 'plan', now);
      const target = config.targets.find(t => t.id === plan.target);
      if (!target || target.root !== plan.root || target.owner !== plan.owner || target.repo !== plan.repo || target.branch !== plan.branch || session.user.id !== plan.userId) fail(409, '上傳位置或帳號已變更，請重新預覽。');
      pathParts(plan.folder);
      const manifest = await fileManifest(body.files);
      if (await manifestDigest(manifest) !== plan.digest) fail(409, '檔案已修改，請重新預覽後上傳。');
      if (plan.overwrite && body.overwrite !== true) fail(409, '請先確認取代同名檔案。');
      if (!plan.changes.length) return json({ unchanged: true });
      await checkWriter(session, target);
      const current = await snapshot(session, target);
      if (current.commit !== plan.commit) fail(409, '其他協作者已更新儲存庫，請重新預覽，避免覆寫別人的修改。');
      const base = repoPath(target);
      const folder = target.root + (plan.folder ? '/' + plan.folder : '');
      const tree = await github(session.token, base + '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: plan.tree, tree: body.files.filter(f => plan.changes.includes(f.name)).map(f => ({ path: folder + '/' + f.name, mode: '100644', type: 'blob', content: f.content })) }) });
      const commit = await github(session.token, base + '/git/commits', { method: 'POST', body: JSON.stringify({ message: '更新裁切素材：' + folder + '（' + plan.changes.length + ' 個檔案）', tree: tree.sha, parents: [plan.commit] }) });
      // Non-forced updates reject a racing commit instead of losing another editor's work.
      await github(session.token, base + '/git/refs/heads/' + encodePath(target.branch), { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
      return json({ count: plan.changes.length, commit: commit.sha, url: 'https://github.com/' + target.owner + '/' + target.repo + '/commit/' + commit.sha });
    }
    fail(404, '找不到這個操作。');
  }
  return async function handle(request, env) {
    let response, origins;
    try {
      origins = getOrigins(env);
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      if (origin && origin !== origins.frontend.origin && origin !== origins.backend.origin) fail(403, '不允許此網站存取上傳服務。');
      const path = url.pathname.startsWith(PREFIX + '/') ? url.pathname.slice(PREFIX.length) : '/' + (url.searchParams.get('route') || 'status');
      if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
      else response = await route(request, env, getConfig(env), path, url);
    } catch (error) {
      response = json({ error: error instanceof HttpError ? error.message : '服務暫時無法完成操作，請稍後重試。' }, error instanceof HttpError ? error.status : 500);
    }
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store'); headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    headers.set('Vary', 'Origin');
    const origin = request.headers.get('origin');
    if (origins && [origins.frontend.origin, origins.backend.origin].includes(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
    return new Response(response.body, { status: response.status, headers });
  };
}
