import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultTargets } from '../server/targets.mjs';

// Browser-only integration test. This fake service never contacts GitHub or writes repository files.
test('collaborator can choose an existing chapter, review replacements and upload; conflicts preserve edits', { timeout: 40000 }, async t => {
  const edge = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  try { await access(edge); } catch { t.skip('Set EDGE_PATH to run the browser integration test.'); return; }
  const calls = [], pageErrors = [];
  let conflict = false, forbidFolder = false, writes = 0;
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/github-upload.js', ['github-upload.js', 'text/javascript; charset=utf-8']],
    ['/github-upload.css', ['github-upload.css', 'text/css; charset=utf-8']],
    ['/github-config.json', ['github-config.json', 'application/json; charset=utf-8']],
  ]);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type }); res.end(await readFile(new URL('../' + file, import.meta.url))); return;
      }
      const path = url.pathname.replace('/api/github', '');
      if (path === '/status') { send({ ready: true }); return; }
      if (path === '/auth/login') {
        const payload = JSON.stringify({ type: 'svg-github-login', nonce: url.searchParams.get('nonce'), session: 'test-browser-session' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><script>window.opener.postMessage(' + payload + ',location.origin);window.close();</script>'); return;
      }
      if (!url.pathname.startsWith('/api/github/')) { res.writeHead(404); res.end(); return; }
      assert.equal(req.headers.authorization, 'Bearer test-browser-session');
      if (path === '/session') { send({ user: { login: 'collaborator' }, targets: defaultTargets }); return; }
      if (path === '/folders') {
        if (forbidFolder) { send({ error: '測試：資料夾讀取失敗' }, 403); return; }
        send({ folder: url.searchParams.get('folder') || '', folders: url.searchParams.get('folder') ? [] : url.searchParams.get('target') === 'guide' ? ['03-modules'] : ['02-路口管制'] }); return;
      }
      const parts = []; for await (const chunk of req) parts.push(chunk);
      const body = JSON.parse(Buffer.concat(parts)); calls.push({ path, body });
      if (path === '/preview') {
        send({ plan: 'test-plan', files: body.files.map((file, i) => ({ name: file.name, status: i ? 'new' : 'update' })) }); return;
      }
      if (path === '/upload') {
        assert.equal(body.overwrite, true); assert.equal(body.plan, 'test-plan');
        if (conflict) { send({ error: '其他協作者已更新儲存庫，請重新預覽。' }, 409); return; }
        writes++; send({ count: body.files.length, url: 'https://github.com/WeiLun-bot/traffic-guide/commit/' + 'f'.repeat(40) }); return;
      }
      send({ error: 'Unexpected endpoint' }, 404);
    } catch (error) { pageErrors.push(error.message); res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const profile = await mkdtemp(join(tmpdir(), 'svg-crop-browser-'));
  const browser = spawn(edge, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket;
  t.after(async () => {
    if (socket?.readyState === WebSocket.OPEN) { try { socket.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); } catch {} socket.close(); }
    browser.kill(); await new Promise(resolve => server.close(resolve)); server.closeAllConnections();
  });
  async function until(probe) {
    for (let i = 0; i < 100; i++) { const result = await probe().catch(() => false); if (result) return result; await delay(100); }
    throw Error('Browser wait timed out.');
  }
  const port = await until(async () => Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]));
  const tab = await until(async () => (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(item => item.type === 'page'));
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0; const pending = new Map();
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) { const task = pending.get(data.id); pending.delete(data.id); data.error ? task.reject(Error(data.error.message)) : task.resolve(data.result); }
    if (data.method === 'Runtime.exceptionThrown') pageErrors.push(data.params.exceptionDetails.text + ': ' + (data.params.exceptionDetails.exception?.description || ''));
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  await command('Runtime.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: origin + '/' });
  await until(() => evaluate('typeof loadSVG === "function" && !!document.getElementById("githubUpload").onclick'));
  await evaluate('loadSVG(\'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect x="10" y="10" width="120" height="80" fill="teal"/></svg>\',"原圖.svg"); addCrop("rectangle",{x:0,y:0,w:150,h:100}); crops[0].name="路口裁切";renderAll();document.getElementById("githubUpload").click()');
  await until(() => evaluate('!document.getElementById("githubSignIn").disabled'));
  await evaluate('document.getElementById("githubSignIn").click()');
  await until(() => evaluate('document.getElementById("githubAccount").textContent === "@collaborator" && !document.getElementById("githubTarget").disabled && !document.getElementById("githubDestination").disabled'));
  await evaluate('document.getElementById("githubTarget").value="materials";document.getElementById("githubTarget").dispatchEvent(new Event("change"))');
  await until(() => evaluate('document.getElementById("githubPath").textContent.includes("traffic-guide / materials") && !document.getElementById("githubDestination").disabled'));
  await evaluate('document.getElementById("githubFolder").value="02-路口管制";document.getElementById("githubFolder").dispatchEvent(new Event("change"))');
  await until(() => evaluate('document.getElementById("githubPath").textContent.includes("materials/02-路口管制") && !document.getElementById("githubPreview").disabled'));
  await evaluate('document.getElementById("githubPreview").click()');
  await until(() => evaluate('document.querySelectorAll("#githubFiles li").length === 2 && !document.getElementById("githubPreview").disabled'));
  assert.equal(await evaluate('document.getElementById("githubConfirm").disabled'), true, 'replacement requires an explicit checkbox');
  assert.equal(await evaluate('document.querySelector("#githubFiles li").textContent.includes("路口裁切.svg")'), true);
  await evaluate('document.getElementById("githubOverwrite").checked=true;document.getElementById("githubOverwrite").dispatchEvent(new Event("change"))');
  assert.equal(await evaluate('document.getElementById("githubConfirm").disabled'), false);
  if (process.env.SVG_UPLOAD_SCREENSHOT) {
    const screenshot = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.SVG_UPLOAD_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  await evaluate('document.getElementById("githubConfirm").click()');
  await until(() => evaluate('!document.getElementById("githubResult").hidden'));
  assert.equal(writes, 1);
  const preview = calls.find(call => call.path === '/preview');
  assert.equal(preview.body.target, 'materials'); assert.equal(preview.body.folder, '02-路口管制');
  assert.deepEqual(preview.body.files.map(file => file.name), ['路口裁切.svg', '原圖-crops.json']);
  assert.equal(preview.body.files.some(file => file.name === '原圖.svg'), false);
  assert.equal(await evaluate('JSON.stringify(localStorage).includes("test-browser-session") || JSON.stringify(sessionStorage).includes("test-browser-session")'), false);

  // A failed navigation must not leave a stale, uploadable folder on screen.
  forbidFolder = true;
  await evaluate('document.getElementById("githubTarget").value="guide";document.getElementById("githubTarget").dispatchEvent(new Event("change"))');
  await until(() => evaluate('document.getElementById("githubStatus").textContent.includes("測試：資料夾讀取失敗")'));
  assert.equal(await evaluate('document.getElementById("githubPreview").disabled'), true);
  forbidFolder = false;
  await evaluate('document.getElementById("githubTarget").dispatchEvent(new Event("change"))');
  await until(() => evaluate('!document.getElementById("githubPreview").disabled'));
  await evaluate('document.getElementById("githubFolder").value="03-modules";document.getElementById("githubFolder").dispatchEvent(new Event("change"))');
  await until(() => evaluate('document.getElementById("githubPath").textContent.includes("media/03-modules") && !document.getElementById("githubPreview").disabled'));
  await evaluate('document.getElementById("githubPreview").click()');
  await until(() => evaluate('document.querySelectorAll("#githubFiles li").length === 2 && !document.getElementById("githubPreview").disabled'));
  conflict = true;
  await evaluate('document.getElementById("githubOverwrite").checked=true;document.getElementById("githubOverwrite").dispatchEvent(new Event("change"));document.getElementById("githubConfirm").click()');
  await until(() => evaluate('document.getElementById("githubStatus").textContent.includes("其他協作者已更新")'));
  assert.equal(await evaluate('document.getElementById("githubConfirm").disabled'), true);
  assert.equal(await evaluate('crops.length'), 1, 'a conflict must preserve the local crop');
  assert.equal(writes, 1, 'the conflicting upload must not produce a commit');
  assert.deepEqual(pageErrors, []);
});
