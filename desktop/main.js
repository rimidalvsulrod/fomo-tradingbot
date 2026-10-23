'use strict';
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, clipboard, dialog, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const WebSocket = require('ws');
const { Engine, startApi, secure, DISCOVERY_PORT, DISCOVERY_MAGIC, VERSION } = require('../engine');

app.setAppUserModelId('com.fomotradingbot.desktop');
// Data folder stays 'fomo-tradingbot' from before the rename so settings, wallet and traders carry over.
app.setPath('userData', process.env.FOMOBOT_USERDATA || path.join(app.getPath('appData'), 'fomo-tradingbot'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const userData = app.getPath('userData');
const logFile = path.join(userData, 'desktop.log');
function dlog(...a) {
  try { fs.mkdirSync(userData, { recursive: true }); fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${a.map((x) => (x && x.stack) || String(x)).join(' ')}
`); } catch { /* ignore */ }
}
process.on('uncaughtException', (e) => dlog('uncaught', e));
process.on('unhandledRejection', (e) => dlog('unhandled', e));
const cfgFile = path.join(userData, 'desktop.json');
let cfg = loadCfg();
let win = null;
let tray = null;
let quitting = false;
let local = null; // { engine, api, base, token }
let conn = null; // { kind, base, token, name }
let ws = null;
let wsTimer = null;
let connState = { connected: false, kind: cfg.connection.kind, name: null, error: null };
let connecting = null;
let startHidden = process.argv.includes('--hidden');

function loadCfg() {
  const def = {
    connection: { kind: 'local', host: '', port: 7420, token: '', name: '' },
    closeToTray: true,
    trayHintShown: false,
    run247: false, // start with Windows in the tray and keep the PC awake
    lanAccess: false, // let other PCs connect to this app's engine with a pairing code
    lanPort: 7420,
    lanToken: '',
  };
  try { return { ...def, ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), connection: { ...def.connection, ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')).connection } }; } catch { return def; }
}
function saveCfg() { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); }

// ---------- engine connection ----------
async function startLocalEngine() {
  if (local) return local;
  const engine = new Engine({ dataDir: path.join(userData, 'engine') });
  let api;
  let token;
  let lan = false;
  if (cfg.lanAccess) {
    // Same API the standalone server exposes, so another PC's app can pair with this one.
    if (!cfg.lanToken) { cfg.lanToken = secure.randomToken(); saveCfg(); }
    token = cfg.lanToken;
    api = startApi(engine, { host: '0.0.0.0', port: cfg.lanPort || 7420, token, name: os.hostname() });
    try { await api.ready; lan = true; } catch (e) {
      await api.close().catch(() => {});
      dlog('LAN access unavailable', e);
      api = null;
    }
  }
  if (!api) {
    token = secure.randomToken();
    api = startApi(engine, { host: '127.0.0.1', port: 0, token, pairing: false, discovery: false });
  }
  const port = await api.ready;
  engine.start();
  engine.on('pin', (pin) => send('app:247', state247()));
  local = { engine, api, base: `http://127.0.0.1:${port}`, token, lan, port };
  return local;
}

// ---------- 24/7 mode ----------
let awakeId = null;
function applyRun247() {
  const on = !!cfg.run247;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on, args: on ? ['--hidden'] : [] });
  if (on && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
}

function state247() {
  const ips = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) ips.push({ ifname, address: a.address });
  }
  return {
    run247: !!cfg.run247,
    lanAccess: !!cfg.lanAccess,
    lanActive: !!(local && local.lan),
    lanError: cfg.lanAccess && local && !local.lan ? `Port ${cfg.lanPort || 7420} is in use on this PC (is AutoPumpServer.exe running here too?)` : null,
    port: local && local.lan ? local.port : cfg.lanPort || 7420,
    pin: local && local.lan ? local.api.pin : null,
    ips,
  };
}

async function stopLocalEngine() {
  if (!local) return;
  try { local.engine.stop(); await local.api.close(); } catch { /* ignore */ }
  local = null;
}

function connect() {
  connecting = doConnect().finally(() => { connecting = null; });
  return connecting;
}

async function ensureConn() {
  if (connecting) await connecting;
  if (!conn) await connect();
}

async function doConnect() {
  closeWs();
  const c = cfg.connection;
  if (c.kind === 'remote' && c.host && c.token) {
    await stopLocalEngine();
    conn = { kind: 'remote', base: `http://${c.host}:${c.port || 7420}`, token: c.token, name: c.name || c.host };
  } else {
    const l = await startLocalEngine();
    conn = { kind: 'local', base: l.base, token: l.token, name: 'This PC' };
  }
  setConnState({ connected: false, kind: conn.kind, name: conn.name, error: null });
  openWs();
}

function openWs() {
  if (!conn) return;
  const url = conn.base.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(conn.token);
  const sock = new WebSocket(url, { handshakeTimeout: 6000 });
  ws = sock;
  sock.on('open', () => setConnState({ ...connState, connected: true, error: null }));
  sock.on('message', (data) => {
    try { send('engine:event', JSON.parse(data.toString())); } catch { /* ignore */ }
  });
  const retry = (err) => {
    if (ws !== sock) return;
    setConnState({ ...connState, connected: false, error: err ? friendlyNetError(err) : connState.error || 'Disconnected' });
    clearTimeout(wsTimer);
    wsTimer = setTimeout(openWs, 3000);
  };
  sock.on('error', (e) => { sock.lastErr = e; });
  sock.on('close', () => retry(sock.lastErr));
  sock.on('unexpected-response', (req, res) => { sock.lastErr = new Error(res.statusCode === 401 ? 'Access token rejected — pair again' : `HTTP ${res.statusCode}`); });
}

function closeWs() {
  clearTimeout(wsTimer);
  if (ws) { const s = ws; ws = null; try { s.terminate(); } catch { /* ignore */ } }
}

function setConnState(s) { connState = s; send('conn:state', s); updateTray(); }

async function engineRequest(method, p, body) {
  await ensureConn();
  try {
    const res = await fetch(conn.base + p, {
      method,
      headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === 'GET' ? 45000 : 120000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { error: json?.error || `Engine error ${res.status}`, status: res.status };
    return { data: json };
  } catch (e) {
    return { error: friendlyNetError(e), status: 0 };
  }
}

function friendlyNetError(e) {
  const m = String(e?.cause?.code || e?.code || e?.message || e);
  if (/ECONNREFUSED/.test(m)) return 'Bot not reachable — is the other PC on and the bot running?';
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timeout|aborted/i.test(m)) return 'Server not reachable — check the IP and that both PCs are on the same network';
  return e?.message || m;
}

function discover(ms = 1800) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      try {
        const j = JSON.parse(msg.toString());
        if (j.app === 'fomo-tradingbot') found.set(`${rinfo.address}:${j.port}`, { host: rinfo.address, port: j.port, name: j.name, version: j.version });
      } catch { /* ignore */ }
    });
    sock.on('error', () => {});
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const targets = new Set(['255.255.255.255']);
      for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
          if (a.family !== 'IPv4' || a.internal) continue;
          const ip = a.address.split('.').map(Number);
          const mask = a.netmask.split('.').map(Number);
          targets.add(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'));
        }
      }
      const msg = Buffer.from(DISCOVERY_MAGIC);
      const blast = () => { for (const t of targets) sock.send(msg, DISCOVERY_PORT, t, () => {}); };
      blast();
      setTimeout(blast, 600);
    });
    setTimeout(() => { try { sock.close(); } catch { /* closed */ } resolve([...found.values()]); }, ms);
  });
}

// ---------- window / tray ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1040, minHeight: 660,
    backgroundColor: '#060510',
    title: 'AutoPump',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#060510', symbolColor: '#9899a3', height: 44 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Started by Windows at sign-in (24/7 mode): stay in the tray until opened.
  win.once('ready-to-show', () => { if (startHidden) { startHidden = false; return; } win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); openExternal(url); } });
  win.on('close', (e) => {
    if (quitting || !cfg.closeToTray || connState.kind !== 'local') return;
    e.preventDefault();
    win.hide();
    if (!cfg.trayHintShown && tray) {
      tray.displayBalloon({ title: 'Still copy trading', content: 'AutoPump keeps running in the tray. Right-click the icon to quit.', iconType: 'info' });
      cfg.trayHintShown = true;
      saveCfg();
    }
  });
  // Closing for real (not to the tray) quits the app instead of leaving it running without a window.
  win.on('closed', () => {
    win = null;
    if (!quitting) { quitting = true; app.quit(); }
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.ico')));
  tray.setToolTip('AutoPump');
  tray.on('click', showWindow);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`AutoPump — ${connState.connected ? (connState.kind === 'local' ? 'running on this PC' : 'connected to ' + connState.name) : 'disconnected'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open AutoPump', click: showWindow },
    { type: 'separator' },
    { label: 'Pause copy trading', click: () => engineRequest('POST', '/api/bot/stop') },
    { label: 'Resume copy trading', click: () => engineRequest('POST', '/api/bot/start') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openExternal(url) {
  try { if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url); } catch { /* ignore */ }
}

function send(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }

// ---------- IPC ----------
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { return { error: e.message || String(e), code: e.code }; }
  });
}

handle('app:info', () => ({ version: VERSION, platform: process.platform, closeToTray: cfg.closeToTray, clipboardWatch: cfg.clipboardWatch !== false }));
handle('app:setCloseToTray', (v) => { cfg.closeToTray = !!v; saveCfg(); return { ok: true }; });
// ---------- pump.fun in your own browser + clipboard pick-up ----------
// pump.fun sits behind Cloudflare, which only works reliably in a normal browser, so open it there.
// When you copy a trader's address or profile link, the app offers to open/copy them.
handle('pump:open', (url) => {
  openExternal(typeof url === 'string' && /^https:\/\/pump\.fun\//.test(url) ? url : 'https://pump.fun/');
  return { ok: true };
});

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
let lastClip = null;
function clipboardTick() {
  if (cfg.clipboardWatch === false) return;
  let text = '';
  try { text = clipboard.readText().trim(); } catch { return; }
  if (text === lastClip) return;
  const first = lastClip === null;
  lastClip = text;
  if (first || text.length > 300) return; // ignore whatever was already on the clipboard at launch
  let address = null;
  if (ADDR_RE.test(text)) address = text;
  else {
    const m = text.match(/pump\.fun\/(profile|coin)\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (m) address = m[2];
  }
  if (address) send('app:clipboard', { address });
}
setInterval(clipboardTick, 1200);
handle('app:setClipboardWatch', (v) => { cfg.clipboardWatch = !!v; saveCfg(); return { ok: true }; });

handle('app:247:get', () => state247());
handle('app:247:set', async (patch = {}) => {
  if ('run247' in patch) {
    cfg.run247 = !!patch.run247;
    if (cfg.run247) cfg.closeToTray = true;
    applyRun247();
  }
  const lanChanged = 'lanAccess' in patch && !!patch.lanAccess !== !!cfg.lanAccess;
  if ('lanAccess' in patch) cfg.lanAccess = !!patch.lanAccess;
  saveCfg();
  if (lanChanged && connState.kind === 'local') { await stopLocalEngine(); await connect(); }
  return state247();
});
handle('app:247:newPin', () => { if (local && local.lan) local.api.newPin(); return state247(); });
handle('app:open', (url) => { openExternal(url); return { ok: true }; });
handle('app:copy', (text) => { clipboard.writeText(String(text)); return { ok: true }; });

handle('engine:req', (method, p, body) => engineRequest(method, p, body));
handle('conn:get', async () => { await ensureConn().catch(() => {}); return { ...connState, config: { ...cfg.connection, token: cfg.connection.token ? '••••' : '' } }; });
handle('conn:discover', () => discover());
handle('conn:useLocal', async () => { cfg.connection.kind = 'local'; saveCfg(); await connect(); return connState; });
handle('conn:pair', async ({ host, port, pin }) => {
  host = String(host || '').trim();
  port = Number(port) || 7420;
  const base = `http://${host}:${port}`;
  let res;
  try {
    res = await fetch(base + '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }), signal: AbortSignal.timeout(8000) });
  } catch (e) { throw new Error(friendlyNetError(e)); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Pairing failed (${res.status})`);
  cfg.connection = { kind: 'remote', host, port, token: j.token, name: j.name || host };
  saveCfg();
  await connect();
  return connState;
});
handle('conn:manual', async ({ host, port, token }) => {
  host = String(host || '').trim();
  port = Number(port) || 7420;
  const r = await fetch(`http://${host}:${port}/api/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }).catch((e) => { throw new Error(friendlyNetError(e)); });
  if (r.status === 401) throw new Error('Access token rejected');
  if (!r.ok) throw new Error(`Server answered ${r.status}`);
  const ping = await fetch(`http://${host}:${port}/api/ping`).then((x) => x.json()).catch(() => ({}));
  cfg.connection = { kind: 'remote', host, port, token: String(token).trim(), name: ping.name || host };
  saveCfg();
  await connect();
  return connState;
});

handle('wallet:import', async (secret) => {
  await ensureConn();
  const enc = secure.seal(secure.transportKey(conn.token), String(secret || '').trim());
  return engineRequest('POST', '/api/wallet/import', { enc });
});
handle('wallet:generate', async () => {
  await ensureConn();
  const r = await engineRequest('POST', '/api/wallet/generate');
  if (r.error) return r;
  return { data: { publicKey: r.data.publicKey, secret: secure.open(secure.transportKey(conn.token), r.data.enc) } };
});

// ---------- lifecycle ----------
// ---------- auto-update (GitHub releases) ----------
let updateState = { state: 'idle', version: null };
function setUpdateState(s) { updateState = s; send('app:update', s); }

function setupUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => setUpdateState({ state: 'downloading', version: i.version }));
  autoUpdater.on('update-downloaded', (i) => {
    setUpdateState({ state: 'ready', version: i.version });
    if (tray) tray.displayBalloon({ title: 'Update ready', content: `AutoPump ${i.version} is ready. Restart from the app to install it.`, iconType: 'info' });
  });
  autoUpdater.on('error', (e) => dlog('update error', e));
  const check = () => autoUpdater.checkForUpdates().catch((e) => dlog('update check failed', e));
  setTimeout(check, 5000);
  setInterval(check, 3 * 3600e3);
  handle('app:installUpdate', () => { quitting = true; autoUpdater.quitAndInstall(true, true); return { ok: true }; });
}
handle('app:updateState', () => updateState);

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (connState.kind !== 'local' || !cfg.closeToTray) app.quit(); });
app.on('will-quit', async () => { closeWs(); if (local) local.engine.stop(); });

app.whenReady().then(async () => {
  dlog('start', VERSION, app.isPackaged ? 'packaged' : 'dev');
  createWindow();
  try { createTray(); } catch (e) { dlog('tray failed', e); }
  setupUpdates();
  applyRun247();
  try {
    await connect();
  } catch (e) {
    dlog('connect failed', e);
    dialog.showErrorBox('AutoPump', 'Could not start the trading engine: ' + e.message);
  }
  if (process.env.FOMOBOT_SCREENSHOT) captureScreens(process.env.FOMOBOT_SCREENSHOT);
});

// Dev helper: FOMOBOT_SCREENSHOT=<dir> renders each screen to PNG and quits.
async function captureScreens(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  await wait(4000);
  const routes = (process.env.FOMOBOT_ROUTES || 'home,discover,copying,portfolio,activity,settings').split(',');
  for (const r of routes) {
    const [route, ref] = r.split('=');
    await win.webContents.executeJavaScript(`go(${JSON.stringify(route)}, ${JSON.stringify(ref ? { ref } : {})})`);
    await wait(Number(process.env.FOMOBOT_WAIT || 2500));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${route}${ref ? '-' + ref.replace(/\W/g, '').slice(0, 10) : ''}.png`), img.toPNG());
  }
  quitting = true;
  app.quit();
}
