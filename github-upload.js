(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const dialog = el('githubDialog');
  let backend = '', session = '', targets = [], folder = '', plan = null, files = null;
  let working = false, uploading = false, initialized = false, destinationReady = false, cancelLogin = null;
  const message = (text, error = false) => { el('githubStatus').textContent = text; el('githubStatus').classList.toggle('error', error); };
  const selectedTarget = () => targets.find(target => target.id === el('githubTarget').value);

  function controls() {
    const target = selectedTarget();
    el('githubSignIn').disabled = working || !initialized || !backend;
    el('githubSignIn').hidden = !!session;
    el('githubSignOut').hidden = !session;
    el('githubSignOut').disabled = working;
    el('githubDestination').disabled = working || !session || !targets.length;
    el('githubParent').disabled = working || !folder;
    el('githubPreview').disabled = working || !destinationReady || !target || !session;
    el('githubConfirm').disabled = working || !plan || !plan.files.some(f => f.status !== 'unchanged') || (plan.files.some(f => f.status === 'update') && !el('githubOverwrite').checked);
    el('githubClose').disabled = uploading;
  }
  function clearPlan() {
    plan = null; files = null; el('githubFiles').replaceChildren();
    el('githubOverwriteRow').hidden = true; el('githubOverwrite').checked = false;
    el('githubConfirm').textContent = '確認上傳'; el('githubResult').hidden = true;
    controls();
  }
  function clearSession() {
    session = ''; targets = []; folder = ''; destinationReady = false;
    el('githubAccount').textContent = '尚未登入';
    el('githubTarget').replaceChildren(new Option('請先登入', ''));
    el('githubFolder').replaceChildren(new Option('選擇子資料夾…', ''));
    el('githubPath').textContent = '尚未選擇位置'; clearPlan();
  }
  async function api(path, body) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && new TextEncoder().encode(payload).length > 4 * 1024 * 1024) throw Error('單次上傳上限為 4 MB，請減少裁切圖或分批上傳。');
    let response;
    try {
      response = await fetch(backend + '/api/github' + path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(60000), headers: { ...(session ? { Authorization: 'Bearer ' + session } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}) }, body: payload });
    } catch { throw Error('無法連線上傳服務，請稍後重試。'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) clearSession();
      if (response.status === 409) clearPlan();
      throw Error(data.error || '上傳服務暫時無法完成操作。');
    }
    return data;
  }
  async function initialize() {
    if (initialized) return;
    const response = await fetch(new URL('github-config.json', document.baseURI), { cache: 'no-store' });
    if (!response.ok) throw Error('無法讀取上傳位置設定。');
    const config = await response.json();
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    const configured = config.backendOrigin || ((location.hostname.endsWith('.vercel.app') || local) ? location.origin : '');
    if (!configured) { message('此網站尚未啟用 GitHub 登入上傳，請聯絡管理者。', true); controls(); return; }
    const url = new URL(configured);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw Error('上傳服務網址設定無效，請聯絡管理者。');
    backend = url.origin;
    await api('/status'); initialized = true;
    message('請使用具有儲存庫寫入權限的 GitHub 帳號登入。'); controls();
  }
  async function browse(nextFolder = '') {
    const target = selectedTarget(); if (!target) return;
    destinationReady = false; clearPlan();
    el('githubPath').textContent = '正在讀取 ' + target.owner + '/' + target.repo + ' / ' + target.root + (nextFolder ? '/' + nextFolder : '') + '…';
    const data = await api('/folders?' + new URLSearchParams({ target: target.id, folder: nextFolder }));
    folder = data.folder; destinationReady = true;
    el('githubPath').textContent = target.owner + '/' + target.repo + ' / ' + target.root + (folder ? '/' + folder : '') + ' · ' + target.branch;
    el('githubFolder').replaceChildren(new Option(data.folders.length ? '選擇下一層資料夾…' : '此資料夾沒有其他子資料夾', ''));
    for (const name of data.folders) el('githubFolder').add(new Option(name, name));
    el('githubFolder').disabled = !data.folders.length;
    message('已選擇儲存位置。完成裁切後，按「預覽本次上傳」。');
  }
  async function run(action) {
    if (working) return;
    working = true; controls();
    try { await action(); } catch (error) { message(error.message || '操作失敗，請重試。', true); }
    finally { working = false; uploading = false; controls(); }
  }
  function loginPopup() {
    const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
    const nonce = btoa(String.fromCharCode(...nonceBytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const popup = window.open('about:blank', 'svg-crop-github-login', 'popup,width=600,height=740');
    if (!popup) return Promise.reject(Error('請允許此網站開啟登入視窗，再試一次。'));
    return new Promise((resolve, reject) => {
      let interval, timeout;
      const finish = (error, value) => {
        window.removeEventListener('message', onMessage); clearInterval(interval); clearTimeout(timeout);
        cancelLogin = null; if (!popup.closed) popup.close();
        if (error) reject(error); else resolve(value);
      };
      const onMessage = event => {
        if (event.origin !== backend || event.source !== popup || event.data?.type !== 'svg-github-login' || event.data.nonce !== nonce) return;
        if (event.data.error) finish(Error(String(event.data.error)));
        else if (typeof event.data.session === 'string' && event.data.session.length < 14000) finish(null, event.data);
      };
      window.addEventListener('message', onMessage);
      interval = setInterval(() => { if (popup.closed) finish(Error('GitHub 登入已取消，請重試。')); }, 500);
      timeout = setTimeout(() => finish(Error('登入等候逾時，請重試。')), 5 * 60 * 1000);
      cancelLogin = () => finish(Error('GitHub 登入已取消。'));
      popup.location.href = backend + '/api/github/auth/login?' + new URLSearchParams({ nonce });
    });
  }
  el('githubUpload').onclick = () => {
    dialog.showModal();
    if (!initialized) run(initialize);
  };
  el('githubClose').onclick = () => { if (!uploading) { cancelLogin?.(); dialog.close(); } };
  dialog.addEventListener('cancel', event => { if (uploading) event.preventDefault(); else cancelLogin?.(); });
  el('githubSignIn').onclick = () => run(async () => {
    message('請在新視窗完成 GitHub 登入與授權。');
    const auth = await loginPopup(); session = auth.session;
    const data = await api('/session'); targets = data.targets;
    el('githubAccount').textContent = '@' + data.user.login;
    el('githubTarget').replaceChildren();
    for (const target of targets) el('githubTarget').add(new Option(target.label, target.id));
    if (targets.length) await browse('');
    else message('此帳號目前沒有可上傳的位置。請管理者確認儲存庫寫入權限與 GitHub App 的安裝範圍。', true);
  });
  el('githubSignOut').onclick = () => run(async () => {
    let failed = false;
    try { await api('/logout', {}); } catch { failed = true; }
    clearSession();
    message(failed ? '已從此頁登出。GitHub 授權未能撤銷，可至 GitHub 的應用程式設定移除授權。' : '已登出 GitHub。', failed);
  });
  el('githubTarget').onchange = () => run(async () => { folder = ''; await browse(''); });
  el('githubFolder').onchange = () => { const next = el('githubFolder').value; if (next) run(() => browse(folder ? folder + '/' + next : next)); };
  el('githubParent').onclick = () => run(() => browse(folder.split('/').slice(0, -1).join('/')));
  el('githubOverwrite').onchange = controls;
  el('githubPreview').onclick = () => run(async () => {
    clearPlan();
    if (!sourceRoot || !crops.length) throw Error('請先開啟 SVG 並建立裁切框。');
    if (crops.length > 63) throw Error('每次最多上傳 63 張裁切圖與一份設定，請減少裁切圖或分批處理。');
    message('正在產生圖檔並檢查 GitHub 上的同名檔案…');
    const entries = checkEntries([...crops.map(cropEntry), configEntry()]);
    const pending = entries.map(([name, content]) => ({ name, content }));
    const result = await api('/preview', { target: selectedTarget().id, folder, files: pending });
    files = pending; plan = result;
    const labels = { new: '新增', update: '取代', unchanged: '相同，略過' };
    for (const file of result.files) {
      const item = document.createElement('li');
      const name = document.createElement('span'); name.className = 'github-file-name'; name.textContent = file.name;
      const state = document.createElement('span'); state.className = 'github-file-state ' + file.status; state.textContent = labels[file.status];
      item.append(name, state); el('githubFiles').append(item);
    }
    const count = result.files.filter(f => f.status !== 'unchanged').length;
    el('githubOverwriteRow').hidden = !result.files.some(f => f.status === 'update');
    el('githubConfirm').textContent = '確認上傳 ' + count + ' 個檔案';
    message(count ? '請確認檔案清單與儲存位置，再按「確認上傳」。' : 'GitHub 上已有相同內容，本次無須上傳。');
  });
  el('githubConfirm').onclick = () => run(async () => {
    if (!plan || !files) return;
    uploading = true; controls(); message('正在將裁切素材提交到 GitHub，請稍候…');
    const result = await api('/upload', { plan: plan.plan, files, overwrite: el('githubOverwrite').checked });
    clearPlan();
    if (result.unchanged) { message('GitHub 上已有相同內容，本次無須上傳。'); return; }
    const link = new URL(result.url);
    if (link.origin === 'https://github.com') { el('githubResult').href = link.href; el('githubResult').hidden = false; }
    message('已上傳 ' + result.count + ' 個檔案，並建立一筆 GitHub 更新紀錄。教材網站依原有部署流程更新。');
  });
})();
