'use strict';
// Signs in to fomo in the user's real Chrome/Edge (so Google/Apple sign-in work normally), using a
// separate browser profile owned by this app. When fomo reports a signed-in user, the fomo session
// (cookies + site storage) is handed to the app's own fomo window and the browser is closed.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ORIGIN = 'https://fomo.family';

function findBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const list = [
    ['Chrome', path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Chrome', path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Chrome', path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Edge', path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Edge', path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Brave', path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
    ['Brave', path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
  ];
  const hit = list.find(([, p]) => p && fs.existsSync(p));
  return hit ? { name: hit[0], exe: hit[1] } : null;
}

// Minimal Chrome DevTools Protocol client for one page target.
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    sock.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const p = msg.id && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
    sock.on('open', () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const n = ++id;
        pending.set(n, { resolve: res, reject: rej });
        sock.send(JSON.stringify({ id: n, method, params }));
      }),
      close: () => { try { sock.close(); } catch { /* closed */ } },
    }));
    sock.on('error', reject);
  });
}

async function readPort(profileDir, proc, ms = 20000) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (proc.exitCode !== null) throw new Error('The browser closed before it was ready.');
    try {
      const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
      if (port > 0) return port;
    } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error('The browser did not start in time.');
}

/**
 * Opens fomo.family in a real browser window and resolves with { browser, cookies, storage, user }
 * once the user is signed in. `checkSignedInExpr` is evaluated in the fomo tab and must resolve to a
 * truthy value only when the user is signed in.
 */
async function browserLogin({ profileDir, checkSignedInExpr, timeoutMs = 15 * 60e3 }) {
  const browser = findBrowser();
  if (!browser) throw Object.assign(new Error('Chrome or Edge not found. Install Google Chrome or Microsoft Edge, or sign in inside the app with Email.'), { code: 'NO_BROWSER' });
  fs.mkdirSync(profileDir, { recursive: true });
  try { fs.unlinkSync(path.join(profileDir, 'DevToolsActivePort')); } catch { /* none */ }

  const proc = spawn(browser.exe, [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=http://127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    ORIGIN + '/',
  ], { stdio: 'ignore', windowsHide: false });
  proc.on('error', () => {});

  const port = await readPort(profileDir, proc);
  const started = Date.now();
  try {
    while (Date.now() - started < timeoutMs) {
      if (proc.exitCode !== null) throw Object.assign(new Error('The browser was closed before sign-in finished.'), { code: 'CLOSED' });
      await sleep(2500);
      let targets;
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { continue; }
      const page = targets.find((t) => t.type === 'page' && String(t.url).startsWith(ORIGIN));
      if (!page || !page.webSocketDebuggerUrl) continue;
      let c;
      try {
        c = await cdp(page.webSocketDebuggerUrl);
        const r = await c.send('Runtime.evaluate', { expression: checkSignedInExpr, awaitPromise: true, returnByValue: true });
        const user = r.result && r.result.value;
        if (process.env.FOMOBOT_DEBUG) console.log('[browser-login] check', page.url, JSON.stringify(r.result));
        if (!user) continue;
        const { cookies } = await c.send('Network.getAllCookies');
        const st = await c.send('Runtime.evaluate', {
          expression: 'JSON.stringify(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))',
          returnByValue: true,
        });
        const storage = JSON.parse(st.result.value || '[]');
        try { await c.send('Browser.close'); } catch { /* closing */ }
        return { browser: browser.name, cookies: cookies.filter((x) => /fomo\.family$|privy\.io$/.test(x.domain.replace(/^\./, ''))), storage, user };
      } catch (e) {
        if (process.env.FOMOBOT_DEBUG) console.log('[browser-login] retry:', e.message); // page navigating
      } finally { if (c) c.close(); }
    }
    throw Object.assign(new Error('Sign-in timed out.'), { code: 'TIMEOUT' });
  } finally {
    setTimeout(() => { if (proc.exitCode === null) try { proc.kill(); } catch { /* gone */ } }, 3000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { browserLogin, findBrowser };
