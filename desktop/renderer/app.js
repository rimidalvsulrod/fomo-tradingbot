'use strict';
/* global bot */

// ================= helpers =================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
const short = (a, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : '');
const isSolAddr = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || '').trim());
// Accepts a plain wallet or a profile/account link (pump.fun, Solscan, GMGN, Birdeye…). Coin links are rejected.
function parseTraderInput(raw) {
  const s = String(raw || '').trim();
  if (isSolAddr(s)) return { address: s };
  if (/pump\.fun\/(coin|advanced\/coin)\//i.test(s)) return { error: "That's a coin link, not a trader. On the coin page, click a trader's name in the trades list and copy their profile link instead." };
  const m = s.match(/\/(?:profile|account|address|wallet|portfolio|user)\/([1-9A-HJ-NP-Za-km-z]{32,44})/i) || s.match(/[?&](?:address|wallet)=([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (m) return { address: m[1] };
  return { error: "Couldn't find a wallet in that. Paste a pump.fun profile link (pump.fun/profile/…) or a Solana wallet address." };
}
const tokenUrl = (mint) => (/pump$/.test(mint) ? `https://pump.fun/coin/${mint}` : `https://dexscreener.com/solana/${mint}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtSol(n, d) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const dec = d ?? (a >= 100 ? 2 : a >= 1 ? 3 : 4);
  return n.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, dec), maximumFractionDigits: dec });
}
function fmtUsd(n, sign = false) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const s = a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'K' : a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : sign ? '+' : ''}$${s}`;
}
function fmtAmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  if (a >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}
function fmtPct(n) { return n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`; }
function pnlClass(n) { return n == null ? '' : n >= 0 ? 'up' : 'down'; }
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}
function agoText(ts) { const a = ago(ts); return a === 'now' ? 'just now' : a + ' ago'; }
function timeStr(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

const GRADS = [['#516af6', '#8b5cf6'], ['#21c95e', '#0ea5e9'], ['#ff622e', '#f43f5e'], ['#f59e0b', '#ef4444'], ['#06b6d4', '#516af6'], ['#a855f7', '#ec4899']];
function avatar(src, name, cls = '') {
  const u = safeUrl(src);
  const ini = esc(String(name || '?').replace(/^@/, '').slice(0, 1).toUpperCase());
  const g = GRADS[[...String(name || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % GRADS.length];
  const fallback = `<span class="avatar ${cls}" style="background:linear-gradient(135deg,${g[0]},${g[1]})">${ini}</span>`;
  if (!u) return fallback;
  return `<img class="avatar ${cls}" src="${esc(u)}" alt="" data-fb="${esc(fallback)}">`;
}
function tokImg(src, sym, cls = '') {
  const u = safeUrl(src);
  const fb = `<span class="tok ${cls}">${esc(String(sym || '?').slice(0, 3))}</span>`;
  if (!u) return fb;
  return `<img class="tok ${cls}" src="${esc(u)}" alt="" data-fb="${esc(fb)}">`;
}

// ================= icons =================
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="3"/><path d="M16 8V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h2"/>',
  pie: '<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
  ext: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  clip: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z"/><circle cx="16" cy="14.5" r="1.3" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-5-6.7"/>',
  arrowL: '<path d="M15 5l-7 7 7 7"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>',
};
function icon(name, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}
const VERIFIED = '<svg class="verified" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2l2.4 1.8 3-.2.9 2.9 2.5 1.7-1 2.8 1 2.8-2.5 1.7-.9 2.9-3-.2L12 22l-2.4-1.8-3 .2-.9-2.9-2.5-1.7 1-2.8-1-2.8 2.5-1.7.9-2.9 3 .2z"/><path d="m8.5 12 2.4 2.4 4.6-4.8" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SOL_ICON = '<svg class="sol" viewBox="0 0 24 24"><defs><linearGradient id="sg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/></linearGradient></defs><circle cx="12" cy="12" r="12" fill="#0b0a1c"/><path fill="url(#sg)" d="M7.3 15.4h9.9l-1.6 1.7H5.7zM7.3 6.9h9.9l-1.6 1.7H5.7zM16.7 11.1H6.8l1.6-1.7h9.9z"/></svg>';

// ================= state =================
const S = {
  route: 'home',
  params: {},
  status: null,
  settings: null,
  targets: [],
  positions: [],
  trades: [],
  logs: [],
  conn: { connected: false, kind: 'local' },
  fomo: { signedIn: false, me: null, checked: false },
  discover: { q: '', error: null },
  activityTab: 'trades',
  activityFilter: 'all',
  info: {},
};

async function api(method, path, body) {
  const r = await bot.req(method, path, body);
  if (r && r.error) throw Object.assign(new Error(r.error), { status: r.status });
  return r.data;
}
const GET = (p) => api('GET', p);
const POST = (p, b) => api('POST', p, b || {});
const PUT = (p, b) => api('PUT', p, b || {});
const DEL = (p) => api('DELETE', p);


// ================= toasts & modals =================
function toast(msg, level = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = `<span class="lv"></span><div class="grow">${esc(msg)}</div>`;
  $('#toasts').appendChild(el);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
}

function modal(html, { wide = false, onMount } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
  const ov = root.firstChild;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  $$('[data-close]', ov).forEach((b) => b.addEventListener('click', close));
  if (onMount) onMount(ov.firstChild, close);
  return close;
}

function confirmModal({ title, body, ok = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const close = modal(`
      <div class="row"><h3>${esc(title)}</h3><button class="icon-btn x" data-close>${icon('x')}</button></div>
      <div class="body"><div class="muted" style="line-height:1.55">${body}</div></div>
      <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cfOk">${esc(ok)}</button></div>`,
    { onMount: (m, c) => { $('#cfOk', m).onclick = () => { done = true; c(); resolve(true); }; } });
    const obs = new MutationObserver(() => { if (!$('#modal-root').firstChild) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe($('#modal-root'), { childList: true });
    void close;
  });
}

// ================= data loading =================
async function loadStatus() {
  try {
    S.status = await GET('/api/status');
  } catch { S.status = null; }
  renderChrome();
}
async function loadSettings() { try { S.settings = await GET('/api/settings'); } catch { /* keep */ } }
async function loadTargets() { try { S.targets = await GET('/api/targets'); } catch { /* keep */ } }
async function loadPositions() { try { S.positions = await GET('/api/positions'); } catch { /* keep */ } }
async function loadTrades() { try { S.trades = await GET('/api/trades?limit=300'); } catch { /* keep */ } }
async function loadLogs() { try { S.logs = (await GET('/api/logs')).reverse(); } catch { /* keep */ } }
async function loadAll() {
  await Promise.all([loadStatus(), loadSettings(), loadTargets(), loadPositions(), loadTrades(), loadLogs()]);
}

const debounced = {};
function soon(key, fn, ms = 350) {
  clearTimeout(debounced[key]);
  debounced[key] = setTimeout(fn, ms);
}

function onEngineEvent(ev) {
  if (ev.type === 'hello') { S.status = ev.status; renderChrome(); loadAll().then(render); return; }
  if (ev.type === 'status') { if (ev.status) S.status = ev.status; renderChrome(); if (S.route === 'home' && !$('#modal-root').firstChild) soon('render', render); return; }
  if (ev.type === 'log') {
    S.logs.unshift(ev.entry);
    if (S.logs.length > 400) S.logs.length = 400;
    if (S.route === 'home') soon('feed', renderFeed, 120);
    if (S.route === 'activity' && S.activityTab === 'logs') soon('render', render);
    return;
  }
  if (ev.type === 'trade') {
    const t = ev.trade;
    S.trades.unshift(t);
    if (t.status === 'success') toast(`${t.mode === 'paper' ? '[Paper] ' : ''}${t.side === 'buy' ? 'Bought' : 'Sold'} $${t.symbol} ${t.sol != null ? '· ' + fmtSol(t.sol) + ' SOL' : ''}${t.targetName ? ' · copied ' + t.targetName : ''}`, 'success');
    else if (t.status === 'failed') toast(`${t.side === 'buy' ? 'Buy' : 'Sell'} $${t.symbol} failed: ${t.reason}`, 'error', 6500);
    soon('pos', () => loadPositions().then(() => { if (['home', 'portfolio'].includes(S.route)) render(); }), 600);
    soon('st', loadStatus, 500);
    if (S.route === 'activity') soon('render', render);
    return;
  }
  if (ev.type === 'targets') soon('tg', () => loadTargets().then(() => { if (['home', 'copying', 'profile'].includes(S.route)) render(); }), 400);
  if (ev.type === 'positions') soon('pos', () => loadPositions().then(() => { if (['home', 'portfolio'].includes(S.route)) render(); }), 400);
}

// ================= chrome =================
const NAV = [
  ['home', 'Home', 'home'],
  ['discover', 'Add trader', 'plus'],
  ['copying', 'Copying', 'copy'],
  ['portfolio', 'Portfolio', 'pie'],
  ['activity', 'Activity', 'activity'],
  ['settings', 'Settings', 'gear'],
];

function renderChrome() {
  const active = S.route === 'profile' ? 'discover' : S.route;
  $('#nav').innerHTML = NAV.map(([id, label, ic]) => {
    const badge = id === 'copying' && S.targets.filter((t) => t.enabled).length ? `<span class="nav-badge">${S.targets.filter((t) => t.enabled).length}</span>` : '';
    return `<button class="nav-item ${active === id ? 'active' : ''}" data-go="${id}">${icon(ic)}<span>${label}</span>${badge}</button>`;
  }).join('');

  const c = S.conn;
  const dotCls = c.connected ? 'on' : c.error ? 'off' : 'warn';
  const t1 = c.connected ? (c.kind === 'local' ? 'Running on this PC' : 'Connected to server') : c.kind === 'remote' ? 'Server offline' : 'Starting engine…';
  const t2 = c.connected ? (c.kind === 'local' ? 'Closes to tray to keep running' : c.name) : c.error || 'Connecting…';
  $('#connPill').innerHTML = `<span class="dot ${dotCls}"></span><div class="grow"><div class="t1">${esc(t1)}</div><div class="t2">${esc(t2)}</div></div>`;

  const st = S.status;
  const mode = st?.mode || 'paper';
  $('#modePill').className = `mode-pill ${mode}`;
  $('#modePill').textContent = mode === 'live' ? '● Live trading' : 'Paper trading';
  $('#balPill').innerHTML = `${SOL_ICON}<span class="num">${st ? fmtSol(st.solBalance ?? 0) : '—'}</span><span class="muted" style="font-weight:600">SOL</span>`;
  const running = st?.running;
  const rb = $('#runBtn');
  rb.className = `run-btn ${running ? 'on' : 'off'}`;
  rb.innerHTML = running ? `<span class="dot on" style="width:8px;height:8px"></span>Copying on` : `${icon('pause')}Paused`;
  rb.title = running ? 'Click to pause copy trading' : 'Click to resume copy trading';
}

// ================= router =================
function go(route, params = {}) {
  S.route = route;
  S.params = params;
  render();
  $('#view').scrollTop = 0;
}

async function render() {
  renderChrome();
  const v = $('#view');
  const fn = VIEWS[S.route] || VIEWS.home;
  const html = fn();
  if (typeof html === 'string') { v.innerHTML = html; bindView(v); }
}

function bindView(root) {
  $$('[data-go]', root).forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); go(el.dataset.go, el.dataset.ref ? { ref: el.dataset.ref } : {}); }));
  $$('[data-profile]', root).forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('button:not([data-profile])')) return;
    go('profile', { ref: el.dataset.profile });
  }));
  $$('[data-open]', root).forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); bot.open(el.dataset.open); }));
  $$('[data-copytext]', root).forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); bot.copy(el.dataset.copytext); toast('Copied to clipboard'); }));
  (VIEW_BIND[S.route] || (() => {}))(root);
}

// ================= views =================
const VIEWS = {};
const VIEW_BIND = {};

// ---------- HOME ----------
VIEWS.home = () => {
  const st = S.status;
  if (!st) return `<div class="loading"><span class="spinner"></span>Connecting to the trading engine…</div>`;
  const posValue = S.positions.reduce((a, p) => a + (p.valueSol || 0), 0);
  const unreal = S.positions.reduce((a, p) => a + (p.pnlSol || 0), 0);
  const total = (st.solBalance || 0) + posValue;
  const active = S.targets.filter((t) => t.enabled);
  const sparkData = buildSpark();
  return `
  <div class="hero">
   <div class="hero-main">
    <div class="label">${icon('wallet', '')}<span>${st.mode === 'live' ? 'Wallet value' : 'Paper portfolio'}</span>${st.mode === 'paper' ? '<span class="badge paper">SIMULATED</span>' : '<span class="badge live">LIVE</span>'}</div>
    <div class="big">${fmtSol(total, 3)}<small>SOL</small></div>
    <div class="sub">
      <span>Cash ${fmtSol(st.solBalance ?? 0)} SOL</span>
      <span>In positions ${fmtSol(posValue)} SOL</span>
      <span class="${pnlClass(unreal)}">Unrealized ${unreal >= 0 ? '+' : ''}${fmtSol(unreal)} SOL</span>
      <span class="${pnlClass(st.realizedSol)}">Realized ${st.realizedSol >= 0 ? '+' : ''}${fmtSol(st.realizedSol)} SOL</span>
    </div>
   </div>
    <div class="hero-actions">
      ${!active.length ? `<button class="btn white" data-go="discover">${icon('plus')}Add a trader to copy</button>` : ''}
      <button class="btn ${st.running ? 'ghost' : 'green'}" id="heroRun">${st.running ? icon('pause') + 'Pause copying' : icon('play') + 'Start copying'}</button>
    </div>
  </div>

  ${speedCard()}

  <div class="grid g4" style="margin-top:16px">
    <div class="stat"><div class="k">${icon('users')}Copying</div><div class="v">${active.length}<small>trader${active.length === 1 ? '' : 's'}</small></div></div>
    <div class="stat"><div class="k">${icon('pie')}Open positions</div><div class="v">${st.openPositions}</div></div>
    <div class="stat"><div class="k">${icon('bolt')}Trades today</div><div class="v">${st.tradesToday}</div></div>
    <div class="stat"><div class="k">${icon('shield')}Spent today</div><div class="v">${fmtSol(st.spentToday)}<small>/ ${S.settings?.dailyLimitSol ? fmtSol(S.settings.dailyLimitSol) : '∞'} SOL</small></div></div>
  </div>

  <div class="home-grid">
    <div class="grid" style="align-content:start">
      <div class="card pad0">
        <div class="card-h" style="padding:18px 20px 0"><h3>Traders you copy</h3><a class="link" data-go="copying">Manage</a></div>
        ${active.length || S.targets.length ? `<div class="list" style="margin-top:6px">${S.targets.slice(0, 6).map(targetRow).join('')}</div>` : `
          <div class="empty"><div class="ico">${icon('copy')}</div><h4>You're not copying anyone yet</h4><p>Paste a trader's pump.fun profile link or Solana wallet and hit Copy. Every buy and sell they make gets mirrored.</p><button class="btn primary" data-go="discover">${icon('plus')}Add a trader</button></div>`}
      </div>
      <div class="card pad0">
        <div class="card-h" style="padding:18px 20px 0"><h3>Top positions</h3><a class="link" data-go="portfolio">View all</a></div>
        ${S.positions.length ? `<div class="list" style="margin-top:6px">${S.positions.slice(0, 5).map(posMiniRow).join('')}</div>` : `<div class="empty" style="padding:28px"><p style="margin:0">No open positions. Copied buys show up here.</p></div>`}
      </div>
    </div>
    <div class="grid" style="align-content:start">
      <div class="card">
        <div class="card-h"><h3>Realized P&L</h3><span class="muted small" style="margin-left:auto">${st.totalTrades} trades</span></div>
        ${sparkData}
      </div>
      <div class="card pad0">
        <div class="card-h" style="padding:18px 18px 4px"><h3>Live feed</h3><span class="dot ${S.conn.connected ? 'on' : 'off'}" style="margin-left:6px"></span><a class="link" data-go="activity">Activity</a></div>
        <div class="feed-scroll" id="feed">${feedHtml()}</div>
      </div>
    </div>
  </div>`;
};

function buildSpark() {
  const sells = S.trades.filter((t) => t.status === 'success' && t.pnlSol != null && t.mode === S.status?.mode).slice().reverse();
  if (sells.length < 2) return `<div class="muted small" style="padding:18px 0">Your realized profit chart appears after your first closed trades.</div>`;
  let acc = 0;
  const pts = sells.map((t) => (acc += t.pnlSol));
  const min = Math.min(0, ...pts), max = Math.max(0, ...pts);
  const W = 400, H = 64;
  const x = (i) => (i / (pts.length - 1)) * W;
  const y = (v) => H - 4 - ((v - min) / (max - min || 1)) * (H - 8);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const col = acc >= 0 ? '#21c95e' : '#ff622e';
  return `<div class="big num ${pnlClass(acc)}" style="font-size:26px;font-weight:800;letter-spacing:-.03em;margin-bottom:8px">${acc >= 0 ? '+' : ''}${fmtSol(acc)} SOL</div>
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="spg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".35"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <path d="${d}L${W},${H}L0,${H}Z" fill="url(#spg)"/><path d="${d}" fill="none" stroke="${col}" stroke-width="2.2" vector-effect="non-scaling-stroke"/>
    <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(255,255,255,.12)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/></svg>`;
}

function feedHtml() {
  const items = S.logs.filter((l) => l.level !== 'debug').slice(0, 60);
  if (!items.length) return `<div class="empty" style="padding:28px"><p style="margin:0">Waiting for trades… signals from the traders you copy stream in here live.</p></div>`;
  return items.map((l) => `<div class="feed-item"><span class="lv ${esc(l.level)}"></span>${l.data?.icon ? tokImg(l.data.icon, '', 'sm') : ''}<div class="grow" style="line-height:1.45">${esc(l.msg)}${l.data?.sig ? ` <a data-open="https://solscan.io/tx/${esc(l.data.sig)}" class="small">tx</a>` : ''}</div><span class="when">${timeStr(l.ts)}</span></div>`).join('');
}
function renderFeed() { const f = $('#feed'); if (f) { f.innerHTML = feedHtml(); bindView(f); } }

function targetRow(t) {
  const size = (t.mode === 'inverse' ? 'Opposite · ' : '') + (t.sizing === 'ratio' ? `${Math.round((t.ratio || 0) * 100)}% of their size` : `${fmtSol(t.fixedSol ?? S.settings?.defaultBuySol ?? 0)} SOL per buy`);
  return `<div class="li click" data-profile="${esc('wallet:' + t.address)}">
    ${avatar(t.avatar, t.name)}
    <div class="grow"><div class="name ellipsis">${esc(t.name)}${t.handle ? ` <span class="muted" style="font-weight:500">@${esc(t.handle)}</span>` : ''}</div>
    <div class="meta">${esc(size)} · ${t.stats?.copied || 0} copied${t.stats?.lastTradeAt ? ' · last trade ' + agoText(t.stats.lastTradeAt) : ''}</div></div>
    <label class="switch green" title="${t.enabled ? 'Copying' : 'Paused'}"><input type="checkbox" data-toggle-target="${esc(t.id)}" ${t.enabled ? 'checked' : ''}><span></span></label>
  </div>`;
}

function posMiniRow(p) {
  return `<div class="li">${tokImg(p.icon, p.symbol)}<div class="grow"><div class="name">${esc(p.symbol)}</div><div class="meta">${fmtAmt(p.amount)} · cost ${fmtSol(p.costSol)} SOL</div></div>
  <div class="right"><div class="num" style="font-weight:700">${fmtSol(p.valueSol)} SOL</div><div class="small num ${pnlClass(p.pnlPct)}">${fmtPct(p.pnlPct)}</div></div></div>`;
}

function bindTargetToggles(root) {
  $$('[data-toggle-target]', root).forEach((el) => {
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('change', async () => {
      try { await PUT(`/api/targets/${el.dataset.toggleTarget}`, { enabled: el.checked }); toast(el.checked ? 'Copying resumed' : 'Copying paused for this trader'); loadTargets().then(renderChrome); } catch (e) { toast(e.message, 'error'); el.checked = !el.checked; }
    });
  });
}

// The free public RPC is rate-limited, which slows signals and wallet lookups. A free Helius key fixes that.
function usingPublicRpc() { return /api\.mainnet-beta\.solana\.com/.test(S.settings?.rpcUrl || 'api.mainnet-beta.solana.com'); }
function speedCard() {
  let dismissed = false;
  try { dismissed = localStorage.getItem('speedCardDismissed') === '1'; } catch { /* storage unavailable */ }
  if (!S.settings || !usingPublicRpc() || dismissed) return '';
  return `<div class="card" style="margin-top:16px;border-color:rgba(255,200,87,.3)">
    <div class="row" style="align-items:flex-start;gap:14px">
      <div class="server-ico" style="background:var(--yellow-bg);color:var(--yellow)">${icon('bolt')}</div>
      <div class="grow">
        <div style="font-weight:800">Copy trades faster</div>
        <div class="small muted" style="margin:4px 0 12px;line-height:1.5">You're on the free shared Solana connection, which is rate-limited. A free Helius key makes the bot react faster and load wallets in seconds. <a data-open="https://dashboard.helius.dev/">Get a free key</a> (sign up, copy the API key), then paste it here.</div>
        <div class="row"><input class="input mono grow" id="heliusKey" placeholder="Paste your Helius API key (or a full RPC URL)" spellcheck="false"><button class="btn primary" id="heliusSave">Connect</button></div>
      </div>
      <button class="icon-btn" id="speedDismiss" title="Hide">${icon('x')}</button>
    </div>
  </div>`;
}

async function connectRpc(raw) {
  const v = String(raw || '').trim();
  if (!v) return toast('Paste your Helius API key first', 'warn');
  const url = /^https?:\/\//.test(v) ? v : `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(v)}`;
  try {
    const t = await POST('/api/rpc/test', { url });
    S.settings = await PUT('/api/settings', { rpcUrl: url, pollMs: 2000 });
    toast(`Connected — ${t.ms} ms response. Copying is now faster.`, 'success');
    profileCache.clear();
    render();
  } catch (e) { toast(e.message, 'error', 7000); }
}

VIEW_BIND.home = (root) => {
  const hs = $('#heliusSave', root);
  if (hs) hs.onclick = () => connectRpc($('#heliusKey', root).value);
  const sd = $('#speedDismiss', root);
  if (sd) sd.onclick = () => { try { localStorage.setItem('speedCardDismissed', '1'); } catch { /* ignore */ } render(); };
  const b = $('#heroRun', root);
  if (b) b.onclick = toggleRunning;
  bindTargetToggles(root);
};

async function toggleRunning() {
  if (!S.status) return;
  try {
    S.status = await POST(S.status.running ? '/api/bot/stop' : '/api/bot/start');
    render();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- ADD TRADER ----------
VIEWS.discover = () => {
  const d = S.discover;
  return `
  <div class="page-title">Add a trader</div>
  <div class="page-sub">Paste the Solana wallet of anyone you want to copy. The bot watches it on-chain and mirrors their buys and sells.</div>
  <div class="card">
    <div class="row">
      <div class="search-wrap grow" style="max-width:none">
        <span class="search-ico">${icon('wallet')}</span>
        <input id="discQ" class="mono" placeholder="Paste a pump.fun profile link or Solana wallet" value="${esc(d.q)}" autocomplete="off" spellcheck="false">
      </div>
      <button class="btn primary" id="discGo">${icon('search')}View wallet</button>
    </div>
    ${d.error ? `<div class="note warn" style="margin-top:14px">${icon('warn')}<div>${esc(d.error)}</div></div>` : ''}
  </div>
  <div class="grid g3" style="margin-top:16px">
    <div class="stat"><div class="k">${icon('search')}1 · Get their wallet</div><div class="small muted" style="margin-top:8px;line-height:1.55">On pump.fun, open a coin, click a trader's name in its trades, and copy their profile link. <a data-open="https://pump.fun">Open pump.fun</a></div></div>
    <div class="stat"><div class="k">${icon('activity')}2 · Check their trades</div><div class="small muted" style="margin-top:8px;line-height:1.55">Paste it above. You'll see what that wallet bought and sold recently, straight from the blockchain.</div></div>
    <div class="stat"><div class="k">${icon('copy')}3 · Hit Copy trader</div><div class="small muted" style="margin-top:8px;line-height:1.55">Pick a fixed SOL amount or a % of their size. From then on every buy and sell is mirrored.</div></div>
  </div>
  ${S.targets.length ? `<div class="card pad0" style="margin-top:16px"><div class="card-h" style="padding:18px 20px 0"><h3>Wallets you copy</h3><a class="link" data-go="copying">Manage</a></div><div class="list" style="margin-top:6px">${S.targets.map(targetRow).join('')}</div></div>` : ''}`;
};

function runSearch(q) {
  const d = S.discover;
  d.q = String(q || '').trim();
  if (!d.q) return;
  const r = parseTraderInput(d.q);
  if (r.address) { d.error = null; go('profile', { ref: 'wallet:' + r.address }); return; }
  d.error = r.error;
  if (S.route === 'discover') render(); else go('discover');
}

VIEW_BIND.discover = (root) => {
  const q = $('#discQ', root);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(q.value); });
  q.addEventListener('paste', () => setTimeout(() => { if (parseTraderInput(q.value).address) runSearch(q.value); }, 0));
  $('#discGo', root).onclick = () => runSearch(q.value);
  bindTargetToggles(root);
};

// ---------- WALLET PROFILE ----------
const profileCache = new Map();
VIEWS.profile = () => {
  const ref = S.params.ref;
  const p = profileCache.get(ref);
  if (!p) { setTimeout(() => loadProfile(ref), 0); return `<div class="loading"><span class="spinner"></span>Loading wallet…</div>`; }
  const u = p.user;
  const copying = S.targets.find((t) => t.address === u.address);
  return `
  <button class="btn ghost sm" data-go="discover" style="margin-bottom:12px">${icon('arrowL')}Back</button>
  <div class="card pad0">
    <div class="cover" style="height:110px"></div>
    <div class="prof">
      <div class="row" style="align-items:flex-end">
        ${avatar(u.avatar, u.name, 'lg')}
        <div class="grow"></div>
        <div class="addr-chip">${SOL_ICON.replace('class="sol"', 'style="width:15px;height:15px"')}<span class="mono">${short(u.address, 5)}</span><button data-copytext="${esc(u.address)}" title="Copy address">${icon('clip')}</button><button data-open="https://solscan.io/account/${esc(u.address)}" title="View on Solscan">${icon('ext')}</button></div>
        <button class="btn ghost" data-open="https://pump.fun/profile/${esc(u.address)}">${icon('ext')}pump.fun profile</button>
        ${copying
          ? `<button class="btn ghost" id="editCopy">${icon('gear')}Settings</button><button class="btn ${copying.enabled ? 'green' : 'ghost'}" id="toggleCopy">${copying.enabled ? icon('check') + (copying.mode === 'inverse' ? 'Doing opposite' : 'Copying') : icon('play') + 'Resume'}</button>`
          : `<button class="btn primary lg" id="startCopy">${icon('copy')}Copy trader</button>`}
      </div>
      <h2>${esc(u.name)}</h2>
      <div class="handle mono">${esc(u.address)}</div>
      <div class="prof-stats">
        ${p.swaps ? `<div><div class="k">Recent trades</div><div class="v">${p.swaps.length}</div></div>` : ''}
        ${copying ? `<div><div class="k">You copied</div><div class="v">${copying.stats?.copied || 0}</div></div>` : ''}
      </div>
    </div>
    <div class="tabs"><button class="on">Recent trades</button></div>
    ${profileTrades(p)}
  </div>`;
};

function profileTrades(p) {
  if (!p.swaps) {
    const publicRpc = /api\.mainnet-beta\.solana\.com/.test(S.settings?.rpcUrl || 'api.mainnet-beta.solana.com');
    return `<div class="loading" style="flex-direction:column"><div class="row"><span class="spinner"></span>Reading recent trades on-chain…</div>
      ${publicRpc ? `<div class="small faint" style="max-width:460px;text-align:center;line-height:1.5">This can take up to a minute on the free Solana connection. A free Helius RPC URL (Settings → Execution) makes it — and copying — much faster.</div>` : ''}</div>`;
  }
  if (!p.swaps.length) {
    const sc = p.scan || {};
    const msg = sc.scanned >= 8 && sc.signed === 0
      ? `This wallet didn't make any of its last ${sc.scanned} transactions itself — it's only receiving payments, usually pump.fun creator fees from people trading a coin it created. It looks like a coin creator, not an active trader, so there's nothing to copy yet. Pick someone from a coin's trades list instead.`
      : `No trades in this wallet's last ${sc.scanned || 'few'} transactions${sc.oldest ? ` (back to ${new Date(sc.oldest).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})` : ''}. If you copy it anyway, the bot will act on its next trade.`;
    return `<div class="empty"><div class="ico">${icon('info')}</div><p style="max-width:520px">${esc(msg)}</p></div>`;
  }
  return `<table class="t"><thead><tr><th>Token</th><th>Side</th><th class="r">Size</th><th class="r">When</th><th></th></tr></thead><tbody>
  ${p.swaps.slice(0, 60).map((s) => `<tr>
    <td><div class="row" style="cursor:pointer" data-open="${esc(tokenUrl(s.mint))}" title="Open coin">${tokImg(s.icon, s.symbol, 'sm')}<div><div style="font-weight:700">${esc(s.symbol)}</div><div class="small faint ellipsis" style="max-width:220px">${esc(s.name || '')}</div></div></div></td>
    <td><span class="badge ${s.side}">${s.side.toUpperCase()}</span></td>
    <td class="r num">${s.sol ? fmtSol(s.sol) + ' SOL' : s.usd ? fmtUsd(s.usd) : '—'}<div class="small faint">${s.tokenAmount ? fmtAmt(s.tokenAmount) : ''}</div></td>
    <td class="r muted">${s.ts ? agoText(s.ts) : ''}</td>
    <td class="r">${s.signature ? `<button class="icon-btn" data-open="https://solscan.io/tx/${esc(s.signature)}" title="View on Solscan">${icon('ext')}</button>` : ''}</td>
  </tr>`).join('')}</tbody></table>`;
}

function loadProfile(ref) {
  if (profileCache.has(ref)) return;
  const address = ref.replace(/^wallet:/, '');
  const t = S.targets.find((x) => x.address === address);
  const data = { user: { name: t?.name || short(address, 5), avatar: t?.avatar, address }, swaps: null };
  profileCache.set(ref, data);
  if (S.route === 'profile' && S.params.ref === ref) render();
  GET(`/api/wallet-activity/${address}?limit=10`).catch(() => []).then((swaps) => {
    data.swaps = Array.isArray(swaps) ? swaps : swaps.trades || [];
    data.scan = Array.isArray(swaps) ? null : swaps;
    if (S.route === 'profile' && S.params.ref === ref) render();
  });
}

VIEW_BIND.profile = (root) => {
  const p = profileCache.get(S.params.ref);
  if (!p) return;
  const sc = $('#startCopy', root); if (sc) sc.onclick = () => openCopyModal(p.user);
  const copying = S.targets.find((t) => t.address === p.user.address);
  const ec = $('#editCopy', root); if (ec) ec.onclick = () => openCopyModal(p.user, copying);
  const tc = $('#toggleCopy', root); if (tc) tc.onclick = async () => {
    try { await PUT(`/api/targets/${copying.id}`, { enabled: !copying.enabled }); await loadTargets(); render(); } catch (e) { toast(e.message, 'error'); }
  };
};

// ---------- COPY MODAL ----------
function openCopyModal(u, existing) {
  if (!u.address) { toast('This trader has no Solana wallet to copy', 'warn'); return; }
  const st = S.settings || {};
  const t = existing || S.targets.find((x) => x.address === u.address) || {};
  let sizing = t.sizing || 'fixed';
  let mode = t.mode || 'copy';
  modal(`
    <div class="row">${avatar(u.avatar, u.name, 'sm')}<div><h3>${existing ? 'Trader settings' : 'Follow ' + esc(u.name)}</h3><div class="small muted">${u.handle ? '@' + esc(u.handle) + ' · ' : ''}<span class="mono">${short(u.address, 5)}</span></div></div><button class="icon-btn x" data-close>${icon('x')}</button></div>
    <div class="body">
      <div class="field"><label>Name (so you recognise them)</label><input class="input" id="cpName" value="${esc(existing ? u.name : '')}" placeholder="e.g. their pump.fun name"></div>
      <div class="field"><span class="lbl">Mode</span>
        <div class="seg accent" id="mdSeg"><button data-md="copy" class="${mode === 'copy' ? 'on' : ''}">Copy them</button><button data-md="inverse" class="${mode === 'inverse' ? 'on' : ''}">Do the opposite</button></div>
        <span class="hint" id="mdHint"></span>
      </div>
      <div class="field"><span class="lbl" id="szLbl">How much to buy when they buy</span>
        <div class="seg accent" id="szSeg"><button data-sz="fixed" class="${sizing === 'fixed' ? 'on' : ''}">Fixed amount</button><button data-sz="ratio" class="${sizing === 'ratio' ? 'on' : ''}">% of their size</button></div>
      </div>
      <div class="field" id="fxField"><label>SOL per buy</label><div class="input-wrap"><input class="input num" id="fxSol" type="number" min="0" step="0.01" value="${t.fixedSol ?? st.defaultBuySol ?? 0.05}"><span class="unit">SOL</span></div></div>
      <div class="field hide" id="rtField"><label>Percent of their trade size</label><div class="input-wrap"><input class="input num" id="rtPct" type="number" min="1" max="1000" step="1" value="${Math.round((t.ratio ?? 0.1) * 100)}"><span class="unit">%</span></div><span class="hint" id="rtHint"></span></div>
      <div class="field"><label>Max SOL per trade (optional)</label><div class="input-wrap"><input class="input num" id="mxSol" type="number" min="0" step="0.01" placeholder="Global max: ${st.maxTradeSol ?? '—'} SOL" value="${t.maxSol ?? ''}"><span class="unit">SOL</span></div></div>
      <div>
        <div class="toggle-row"><div class="grow"><div class="t">React to their buys</div><div class="d" id="buyDesc"></div></div><label class="switch"><input type="checkbox" id="cpBuy" ${t.copyBuys !== false ? 'checked' : ''}><span></span></label></div>
        <div class="toggle-row"><div class="grow"><div class="t">React to their sells</div><div class="d" id="sellDesc"></div></div><label class="switch"><input type="checkbox" id="cpSell" ${t.copySells !== false ? 'checked' : ''}><span></span></label></div>
      </div>
      <div class="summary" id="cpSum"></div>
      ${S.status?.mode !== 'live' ? `<div class="note warn">${icon('info')}<div>You're in <b>paper mode</b> — trades are simulated with live prices. Switch to Live in Settings when you're ready.</div></div>` : `<div class="note danger">${icon('warn')}<div><b>Live mode.</b> Real SOL from your wallet will be spent when this trader buys.</div></div>`}
    </div>
    <div class="foot">${existing ? `<button class="btn danger" id="cpRemove">${icon('trash')}Stop copying</button>` : `<button class="btn ghost" data-close>Cancel</button>`}<button class="btn primary" id="cpSave">${existing ? 'Save' : icon('copy') + 'Start copying'}</button></div>`,
  {
    onMount: (m, close) => {
      const upd = () => {
        $('#fxField', m).classList.toggle('hide', sizing !== 'fixed');
        $('#rtField', m).classList.toggle('hide', sizing !== 'ratio');
        $$('[data-sz]', m).forEach((b) => b.classList.toggle('on', b.dataset.sz === sizing));
        $$('[data-md]', m).forEach((b) => b.classList.toggle('on', b.dataset.md === mode));
        const inv = mode === 'inverse';
        const who = esc($('#cpName', m).value.trim() || u.name);
        const mx = Number($('#mxSol', m).value) || st.maxTradeSol;
        const buys = $('#cpBuy', m).checked, sells = $('#cpSell', m).checked;
        const sizeTxt = sizing === 'fixed' ? `<b>${fmtSol(Number($('#fxSol', m).value) || 0)} SOL</b>` : `<b>${Number($('#rtPct', m).value) || 0}%</b> of their SOL size`;
        $('#mdHint', m).textContent = inv
          ? 'Fade them: when they sell a coin you buy it, and when they buy a coin you hold you sell it.'
          : 'Mirror them: buy when they buy, sell when they sell.';
        $('#szLbl', m).textContent = inv ? 'How much to buy when they sell' : 'How much to buy when they buy';
        $('#rtHint', m).textContent = inv ? 'They sell for 2 SOL at 10% → you buy 0.2 SOL.' : 'They buy 2 SOL at 10% → you buy 0.2 SOL.';
        $('#buyDesc', m).textContent = inv ? 'When they buy a coin you hold, sell all of it' : 'Buy the same coin when they buy';
        $('#sellDesc', m).textContent = inv ? 'When they sell a coin, buy it' : 'Sell the same share of your position when they sell';
        $('#cpSum', m).innerHTML = inv
          ? `${sells ? `When ${who} sells a coin, you buy ${sizeTxt} of it (capped at ${fmtSol(mx)} SOL).` : 'Their sells are ignored.'} ${buys ? 'When they buy a coin you hold, you sell all of it.' : 'Their buys are ignored.'}`
          : `${buys ? `When ${who} buys a coin, you buy ${sizeTxt} (capped at ${fmtSol(mx)} SOL).` : 'Their buys are ignored.'} ${sells ? 'When they sell, you sell the same percentage of your position.' : 'Their sells are ignored — you manage exits yourself.'}`;
        $('#cpSave', m).innerHTML = existing ? 'Save' : inv ? `${icon('refresh')}Start fading` : `${icon('copy')}Start copying`;
      };
      $$('[data-sz]', m).forEach((b) => b.onclick = () => { sizing = b.dataset.sz; upd(); });
      $$('[data-md]', m).forEach((b) => b.onclick = () => { mode = b.dataset.md; upd(); });
      $$('input', m).forEach((i) => i.addEventListener('input', upd));
      upd();
      $('#cpSave', m).onclick = async () => {
        const body = {
          address: u.address, name: $('#cpName', m).value.trim() || u.name, avatar: u.avatar,
          sizing, fixedSol: Number($('#fxSol', m).value), ratio: (Number($('#rtPct', m).value) || 0) / 100,
          maxSol: $('#mxSol', m).value === '' ? null : Number($('#mxSol', m).value),
          copyBuys: $('#cpBuy', m).checked, copySells: $('#cpSell', m).checked, enabled: true, mode,
        };
        try {
          if (existing) await PUT(`/api/targets/${existing.id}`, body); else await POST('/api/targets', body);
          close();
          toast(existing ? 'Settings saved' : mode === 'inverse' ? `Now doing the opposite of ${body.name}` : `Now copying ${body.name}`, 'success');
          profileCache.delete('wallet:' + u.address);
          await loadTargets();
          render();
        } catch (e) { toast(e.message, 'error'); }
      };
      const rm = $('#cpRemove', m);
      if (rm) rm.onclick = async () => {
        try { await DEL(`/api/targets/${existing.id}`); close(); toast(`Stopped copying ${u.name}`); await loadTargets(); render(); } catch (e) { toast(e.message, 'error'); }
      };
    },
  });
}

// ---------- COPYING ----------
VIEWS.copying = () => {
  const list = S.targets;
  return `
  <div class="row" style="align-items:flex-end;margin-bottom:18px">
    <div class="grow"><div class="page-title">Copying</div><div class="page-sub" style="margin:0">Traders whose buys and sells are mirrored into your wallet.</div></div>
    <button class="btn primary" data-go="discover">${icon('plus')}Add a trader</button>
  </div>
  <div class="card pad0">
    ${!list.length ? `<div class="empty"><div class="ico">${icon('copy')}</div><h4>No traders yet</h4><p>Paste a trader's pump.fun profile link or Solana wallet to start copying.</p><button class="btn primary" data-go="discover">${icon('plus')}Add a trader</button></div>` : `
    <table class="t"><thead><tr><th>Trader</th><th>Size</th><th>Copies</th><th class="r">Copied</th><th class="r">Skipped</th><th class="r">Last trade</th><th class="r">Status</th><th></th></tr></thead><tbody>
    ${list.map((t) => `<tr>
      <td><div class="row click" style="cursor:pointer" data-profile="${esc('wallet:' + t.address)}">${avatar(t.avatar, t.name, 'sm')}<div><div style="font-weight:700">${esc(t.name)}</div><div class="small muted">${t.handle ? '@' + esc(t.handle) + ' · ' : ''}<span class="mono">${short(t.address)}</span></div></div></div></td>
      <td class="num">${t.sizing === 'ratio' ? Math.round(t.ratio * 100) + '% of theirs' : fmtSol(t.fixedSol ?? S.settings?.defaultBuySol) + ' SOL'}${t.maxSol ? `<div class="small faint">max ${fmtSol(t.maxSol)} SOL</div>` : ''}</td>
      <td>${t.mode === 'inverse' ? '<span class="badge blue">OPPOSITE</span> ' : ''}${t.copyBuys ? '<span class="badge buy">BUYS</span> ' : ''}${t.copySells ? '<span class="badge sell">SELLS</span>' : ''}</td>
      <td class="r num">${t.stats?.copied || 0}</td>
      <td class="r num muted">${t.stats?.skipped || 0}</td>
      <td class="r muted">${t.stats?.lastTradeAt ? agoText(t.stats.lastTradeAt) : '—'}</td>
      <td class="r"><label class="switch green" style="display:inline-block;vertical-align:middle"><input type="checkbox" data-toggle-target="${esc(t.id)}" ${t.enabled ? 'checked' : ''}><span></span></label></td>
      <td class="r"><button class="icon-btn" data-edit-target="${esc(t.id)}" title="Edit">${icon('gear')}</button></td>
    </tr>`).join('')}</tbody></table>`}
  </div>
  <div class="note" style="margin-top:16px">${icon('info')}<div>The engine watches each wallet on-chain and copies within seconds. Signals older than ${S.settings?.maxSignalAgeSec ?? 90}s, below ${S.settings?.minSourceTradeSol ?? 0} SOL, or beyond your limits are skipped and logged in Activity.</div></div>`;
};

VIEW_BIND.copying = (root) => {
  bindTargetToggles(root);
  $$('[data-edit-target]', root).forEach((b) => b.onclick = () => {
    const t = S.targets.find((x) => x.id === b.dataset.editTarget);
    openCopyModal({ address: t.address, name: t.name, avatar: t.avatar }, t);
  });
};

// ---------- PORTFOLIO ----------
VIEWS.portfolio = () => {
  const ps = S.positions;
  const value = ps.reduce((a, p) => a + (p.valueSol || 0), 0);
  const cost = ps.reduce((a, p) => a + (p.costSol || 0), 0);
  const pnl = value - cost;
  const paper = S.status?.mode !== 'live';
  return `
  <div class="row" style="align-items:flex-end;margin-bottom:18px">
    <div class="grow"><div class="page-title">Portfolio</div><div class="page-sub" style="margin:0">${paper ? 'Simulated positions from paper trading.' : 'Positions opened by the bot in your wallet.'}</div></div>
    ${paper ? `<button class="btn ghost" id="resetPaper">${icon('refresh')}Reset paper account</button>` : ''}
    <button class="btn primary" id="manualBuy">${icon('plus')}Buy a token</button>
  </div>
  <div class="grid g4">
    <div class="stat"><div class="k">Positions value</div><div class="v">${fmtSol(value)}<small>SOL</small></div></div>
    <div class="stat"><div class="k">Cost basis</div><div class="v">${fmtSol(cost)}<small>SOL</small></div></div>
    <div class="stat"><div class="k">Unrealized P&L</div><div class="v ${pnlClass(pnl)}">${pnl >= 0 ? '+' : ''}${fmtSol(pnl)}<small>SOL</small></div></div>
    <div class="stat"><div class="k">Realized P&L</div><div class="v ${pnlClass(S.status?.realizedSol)}">${(S.status?.realizedSol ?? 0) >= 0 ? '+' : ''}${fmtSol(S.status?.realizedSol ?? 0)}<small>SOL</small></div></div>
  </div>
  <div class="card pad0" style="margin-top:16px">
    ${!ps.length ? `<div class="empty"><div class="ico">${icon('pie')}</div><h4>No open positions</h4><p>When a trader you copy buys, the position appears here with live P&L.</p></div>` : `
    <table class="t"><thead><tr><th>Token</th><th class="r">Amount</th><th class="r">Value</th><th class="r">Cost</th><th class="r">P&L</th><th>From</th><th class="r">Sell</th></tr></thead><tbody>
    ${ps.map((p) => `<tr>
      <td><div class="row">${tokImg(p.icon, p.symbol)}<div><div style="font-weight:700">${esc(p.symbol)}</div><div class="small faint ellipsis" style="max-width:180px">${esc(p.name || '')}</div></div><button class="icon-btn" data-open="${esc(tokenUrl(p.mint))}" title="Chart">${icon('ext')}</button></div></td>
      <td class="r num">${fmtAmt(p.amount)}</td>
      <td class="r num"><b>${fmtSol(p.valueSol)} SOL</b><div class="small faint">${fmtUsd(p.valueUsd)}</div></td>
      <td class="r num muted">${fmtSol(p.costSol)} SOL</td>
      <td class="r num ${pnlClass(p.pnlSol)}"><b>${p.pnlSol != null ? (p.pnlSol >= 0 ? '+' : '') + fmtSol(p.pnlSol) : '—'}</b><div class="small">${fmtPct(p.pnlPct)}</div></td>
      <td class="small muted">${esc((p.targetNames || []).join(', ') || 'Manual')}</td>
      <td class="r"><div class="row" style="justify-content:flex-end;gap:6px">${[25, 50, 100].map((pc) => `<button class="btn ${pc === 100 ? 'danger' : 'ghost'} xs" data-sell="${esc(p.mint)}" data-pct="${pc}">${pc === 100 ? 'All' : pc + '%'}</button>`).join('')}</div></td>
    </tr>`).join('')}</tbody></table>`}
  </div>`;
};

VIEW_BIND.portfolio = (root) => {
  $$('[data-sell]', root).forEach((b) => b.onclick = async () => {
    const pos = S.positions.find((p) => p.mint === b.dataset.sell);
    const pct = Number(b.dataset.pct);
    if (S.status?.mode === 'live' && !(await confirmModal({ title: `Sell ${pct}% of $${pos.symbol}?`, body: `This sends a real swap from your wallet at market price.`, ok: `Sell ${pct}%`, danger: true }))) return;
    b.innerHTML = '<span class="spinner sm"></span>';
    try { const r = await POST(`/api/positions/${b.dataset.sell}/sell`, { percent: pct }); toast(`Sold for ${fmtSol(r.solOut)} SOL`, 'success'); } catch (e) { toast(e.message, 'error'); }
    await loadPositions(); await loadStatus(); render();
  });
  const rp = $('#resetPaper', root);
  if (rp) rp.onclick = async () => {
    if (!(await confirmModal({ title: 'Reset paper account?', body: `Clears simulated positions and history and resets the balance to ${S.settings?.paperStartSol ?? 10} SOL.`, ok: 'Reset', danger: true }))) return;
    try { await POST('/api/paper/reset'); await loadAll(); render(); toast('Paper account reset', 'success'); } catch (e) { toast(e.message, 'error'); }
  };
  $('#manualBuy', root).onclick = () => modal(`
    <div class="row"><h3>Buy a token</h3><button class="icon-btn x" data-close>${icon('x')}</button></div>
    <div class="body">
      <div class="field"><label>Token mint address</label><input class="input mono" id="mbMint" placeholder="Paste a Solana token address" spellcheck="false"></div>
      <div class="field"><label>Amount</label><div class="input-wrap"><input class="input num" id="mbSol" type="number" min="0" step="0.01" value="${S.settings?.defaultBuySol ?? 0.05}"><span class="unit">SOL</span></div></div>
      ${S.status?.mode === 'live' ? `<div class="note danger">${icon('warn')}<div>Live mode — this spends real SOL.</div></div>` : `<div class="note warn">${icon('info')}<div>Paper mode — simulated with a live Jupiter quote.</div></div>`}
    </div>
    <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="mbGo">Buy</button></div>`,
  { onMount: (m, close) => {
    $('#mbGo', m).onclick = async () => {
      const mint = $('#mbMint', m).value.trim();
      if (!isSolAddr(mint)) { toast('Enter a valid token address', 'error'); return; }
      $('#mbGo', m).innerHTML = '<span class="spinner sm"></span>';
      try { await POST('/api/buy', { mint, sol: Number($('#mbSol', m).value) }); close(); await loadPositions(); render(); } catch (e) { toast(e.message, 'error'); $('#mbGo', m).textContent = 'Buy'; }
    };
  } });
};

// ---------- ACTIVITY ----------
VIEWS.activity = () => {
  const tab = S.activityTab;
  const f = S.activityFilter;
  const mode = S.status?.mode || 'paper';
  let trades = S.trades.filter((t) => t.mode === mode);
  if (f === 'success') trades = trades.filter((t) => t.status === 'success');
  if (f === 'skipped') trades = trades.filter((t) => t.status === 'skipped');
  if (f === 'failed') trades = trades.filter((t) => t.status === 'failed');
  return `
  <div class="row" style="align-items:flex-end;margin-bottom:18px">
    <div class="grow"><div class="page-title">Activity</div><div class="page-sub" style="margin:0">Every signal the bot saw and what it did — ${mode} mode.</div></div>
    <div class="seg"><button class="${tab === 'trades' ? 'on' : ''}" data-atab="trades">Trades</button><button class="${tab === 'logs' ? 'on' : ''}" data-atab="logs">Engine log</button></div>
  </div>
  <div class="card pad0">
  ${tab === 'trades' ? `
    <div style="padding:14px 20px" class="chips">${[['all', 'All'], ['success', 'Executed'], ['skipped', 'Skipped'], ['failed', 'Failed']].map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-af="${k}">${l}</button>`).join('')}</div>
    ${!trades.length ? `<div class="empty"><p>Nothing here yet.</p></div>` : `
    <table class="t"><thead><tr><th>Time</th><th>Trader</th><th>Action</th><th>Token</th><th class="r">SOL</th><th class="r">P&L</th><th>Result</th><th></th></tr></thead><tbody>
    ${trades.slice(0, 250).map((t) => `<tr>
      <td class="muted small" style="white-space:nowrap">${new Date(t.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${timeStr(t.ts)}</td>
      <td><div class="row" style="gap:8px">${t.targetName ? avatar(t.targetAvatar, t.targetName, 'xs') : ''}<span class="ellipsis" style="max-width:140px">${esc(t.targetName || '—')}</span></div></td>
      <td><span class="badge ${t.side}">${String(t.side).toUpperCase()}</span></td>
      <td><div class="row" style="gap:8px">${tokImg(t.icon, t.symbol, 'sm')}<b class="ellipsis" style="max-width:120px">${esc(t.symbol || short(t.mint))}</b></div></td>
      <td class="r num">${t.sol != null ? fmtSol(t.sol) : '—'}</td>
      <td class="r num ${pnlClass(t.pnlSol)}">${t.pnlSol != null ? (t.pnlSol >= 0 ? '+' : '') + fmtSol(t.pnlSol) : ''}</td>
      <td>${t.status === 'success' ? '<span class="badge ok">DONE</span>' : t.status === 'skipped' ? '<span class="badge skip">SKIPPED</span>' : '<span class="badge fail">FAILED</span>'}${t.reason && t.status !== 'success' ? `<div class="small faint wrap" style="max-width:200px">${esc(t.reason)}</div>` : ''}</td>
      <td class="r">${t.txSig ? `<button class="icon-btn" data-open="https://solscan.io/tx/${esc(t.txSig)}" title="Your transaction">${icon('ext')}</button>` : ''}${t.sourceSig ? `<button class="icon-btn" data-open="https://solscan.io/tx/${esc(t.sourceSig)}" title="Their transaction">${icon('target')}</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`}` : `<div class="feed-scroll" style="max-height:none">${feedHtml()}</div>`}
  </div>`;
};

VIEW_BIND.activity = (root) => {
  $$('[data-atab]', root).forEach((b) => b.onclick = () => { S.activityTab = b.dataset.atab; render(); });
  $$('[data-af]', root).forEach((b) => b.onclick = () => { S.activityFilter = b.dataset.af; render(); });
};

// ---------- SETTINGS ----------
const SET = { discovered: null, discovering: false, newSecret: null };

VIEWS.settings = () => {
  const st = S.status || {};
  const s = S.settings || {};
  const c = S.conn;
  const num = (k, label, unit, hint, step = '0.01') => `<div class="field"><label>${label}</label><div class="input-wrap"><input class="input num" data-set="${k}" type="number" min="0" step="${step}" value="${esc(s[k] ?? '')}">${unit ? `<span class="unit">${unit}</span>` : ''}</div>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  return `
  <div class="page-title">Settings</div><div class="page-sub">Connection, wallet, and how the bot trades.</div>
  <div class="settings-grid">
    <div class="grid" style="align-content:start">
      <div class="card">
        <div class="card-h">${icon('server')}<h3>Where the bot runs</h3></div>
        <div class="row" style="padding:12px 14px;border-radius:14px;background:var(--bg2);border:1px solid var(--line)">
          <span class="dot ${c.connected ? 'on' : 'off'}"></span>
          <div class="grow"><div style="font-weight:700">${c.kind === 'local' ? 'This PC' : esc(c.name || 'Remote server')}</div><div class="small muted">${c.connected ? (c.kind === 'local' ? 'Engine runs inside this app. Closing the window keeps it in the tray.' : 'Connected — the server keeps copying even when this app is closed.') : esc(c.error || 'Connecting…')}</div></div>
          ${c.kind === 'remote' ? `<button class="btn ghost sm" id="useLocal">Use this PC</button>` : ''}
        </div>
        ${c.kind === 'local' && S.always ? `
        <div class="sec-title">Run 24/7 on this PC</div>
        <div class="toggle-row"><div class="grow"><div class="t">Run 24/7</div><div class="d">Starts with Windows (in the tray), keeps this PC awake, and keeps copying when you close the window. Turn this on for the PC that stays on.</div></div><label class="switch green"><input type="checkbox" id="sw247" ${S.always.run247 ? 'checked' : ''}><span></span></label></div>
        <div class="toggle-row"><div class="grow"><div class="t">Let my other PCs connect</div><div class="d">Control this bot from the app on another PC on the same network. Windows may ask to allow it through the firewall — click Allow.</div></div><label class="switch"><input type="checkbox" id="swLan" ${S.always.lanAccess ? 'checked' : ''}><span></span></label></div>
        ${S.always.lanError ? `<div class="note warn" style="margin-top:8px">${icon('warn')}<div>${esc(S.always.lanError)}</div></div>` : ''}
        ${S.always.lanActive ? `<div class="server-item" style="margin-top:8px"><div class="server-ico">${icon('link')}</div><div class="grow"><div class="small muted">On your other PC: Settings → Find computers, or enter</div><div class="mono" style="margin-top:2px">${S.always.ips.map((i) => `${esc(i.address)}:${esc(S.always.port)}`).join(' · ') || 'no network found'}</div></div><div style="text-align:right"><div class="small muted">Pairing code</div><div class="num" style="font-size:22px;font-weight:800;letter-spacing:.12em">${esc(String(S.always.pin || '').replace(/(\d{3})(\d{3})/, '$1 $2'))}</div><a class="small" id="newPin">New code</a></div></div>` : ''}` : ''}
        <div class="sec-title">${c.kind === 'local' ? 'Control a bot on another PC' : 'Switch computer'}</div>
        <div class="muted small" style="line-height:1.55;margin-bottom:12px">If the bot runs on another PC (this app with “Let my other PCs connect” on, or FomoTradingbotServer.exe), find it here. Both PCs need to be on the same network.</div>
        <div class="row"><button class="btn primary" id="discoverBtn">${SET.discovering ? '<span class="spinner sm"></span>Searching…' : icon('search') + 'Find computers'}</button><button class="btn ghost" id="manualConn">Enter IP manually</button></div>
        ${SET.discovered ? `<div style="margin-top:14px">${SET.discovered.length ? SET.discovered.map((d) => `<div class="server-item"><div class="server-ico">${icon('server')}</div><div class="grow"><div style="font-weight:700">${esc(d.name)}</div><div class="small muted mono">${esc(d.host)}:${esc(d.port)} · v${esc(d.version)}</div></div><button class="btn primary sm" data-pair="${esc(d.host)}" data-port="${esc(d.port)}" data-name="${esc(d.name)}">Pair</button></div>`).join('') : `<div class="note warn">${icon('warn')}<div>Nothing found. Make sure the bot is running on the other PC (this app with “Let my other PCs connect” on, or FomoTradingbotServer.exe), both PCs are on the same Wi-Fi/LAN, and Windows Firewall allowed it (it asks the first time). Or use “Enter IP manually”.</div></div>`}</div>` : ''}
      </div>

      <div class="card">
        <div class="card-h">${icon('wallet')}<h3>Trading wallet</h3>${st.wallet ? `<span class="badge ok" style="margin-left:auto">CONNECTED</span>` : ''}</div>
        ${st.wallet ? `
          <div class="row" style="padding:12px 14px;border-radius:14px;background:var(--bg2);border:1px solid var(--line)">${SOL_ICON.replace('class="sol"', 'style="width:30px;height:30px"')}<div class="grow"><div class="mono" style="font-size:13px">${esc(st.wallet.publicKey)}</div><div class="small muted">${st.liveSolBalance != null ? fmtSol(st.liveSolBalance) + ' SOL' : 'Balance loading…'} ${st.wallet.unlocked ? '' : ' · <span class="down">locked — import again</span>'}</div></div>
            <button class="icon-btn" data-copytext="${esc(st.wallet.publicKey)}" title="Copy">${icon('clip')}</button><button class="icon-btn" data-open="https://solscan.io/account/${esc(st.wallet.publicKey)}" title="Solscan">${icon('ext')}</button></div>
          ${SET.newSecret ? `<div class="sec-title">Back up this private key now</div><div class="secret-box">${esc(SET.newSecret)}</div><div class="row" style="margin-top:10px"><button class="btn ghost sm" data-copytext="${esc(SET.newSecret)}">${icon('clip')}Copy key</button><button class="btn ghost sm" id="hideSecret">I saved it</button></div><div class="note warn" style="margin-top:10px">${icon('warn')}<div>This key is shown once. Anyone with it controls the wallet. Import it in Phantom to see the wallet there too.</div></div>` : ''}
          <div class="muted small" style="margin:12px 0;line-height:1.5">Send SOL to this address to fund copy trades. Use a dedicated wallet with only what you're willing to trade.</div>
          <button class="btn danger sm" id="removeWallet">${icon('trash')}Remove wallet</button>`
        : `
          <div class="muted small" style="line-height:1.55;margin-bottom:12px">The bot signs trades with this wallet. Use a fresh wallet just for copy trading. The key is encrypted on ${c.kind === 'local' ? 'this PC' : 'the server PC'} and never leaves it.</div>
          <div class="field"><label>Import private key</label><textarea class="input" id="pk" placeholder="Base58 private key (Phantom → Settings → Export private key) or JSON byte array" spellcheck="false"></textarea></div>
          <div class="row" style="margin-top:12px"><button class="btn primary" id="importPk">${icon('key')}Import wallet</button><span class="muted small">or</span><button class="btn ghost" id="genWallet">${icon('sparkle')}Create new wallet</button></div>`}
      </div>
    </div>

    <div class="grid" style="align-content:start">
      <div class="card">
        <div class="card-h">${icon('bolt')}<h3>Trading mode</h3></div>
        <div class="seg accent" id="modeSeg"><button data-mode="paper" class="${st.mode !== 'live' ? 'on' : ''}">Paper (simulated)</button><button data-mode="live" class="${st.mode === 'live' ? 'on' : ''}">Live</button></div>
        <div class="muted small" style="margin-top:12px;line-height:1.55">${st.mode === 'live' ? '<span class="down"><b>Live:</b></span> real swaps are signed with your wallet through Jupiter.' : '<b style="color:var(--yellow)">Paper:</b> every copy uses a real Jupiter quote but no transaction is sent. Start here to see how a trader performs.'}</div>
        <div class="toggle-row" style="margin-top:6px"><div class="grow"><div class="t">Copy trading active</div><div class="d">Master switch for all traders</div></div><label class="switch green"><input type="checkbox" id="runningSw" ${st.running ? 'checked' : ''}><span></span></label></div>
      </div>

      <div class="card">
        <div class="card-h">${icon('shield')}<h3>Sizing & risk limits</h3></div>
        <div class="form-grid">
          ${num('defaultBuySol', 'Default buy size', 'SOL', 'Used by traders set to “fixed”.')}
          ${num('maxTradeSol', 'Max per trade', 'SOL', 'Hard cap for any single buy.')}
          ${num('dailyLimitSol', 'Daily spend limit', 'SOL', '0 = no limit.')}
          ${num('minReserveSol', 'Keep in reserve', 'SOL', 'Never spend below this balance.')}
          ${num('minSourceTradeSol', 'Ignore their trades under', 'SOL', 'Skips dust and test buys.', '0.001')}
          ${num('maxOpenPositions', 'Max open positions', '', '', '1')}
          ${num('takeProfitPct', 'Auto take-profit', '%', '0 = off. Sells all at this gain.', '1')}
          ${num('stopLossPct', 'Auto stop-loss', '%', '0 = off. Sells all at this loss.', '1')}
          ${num('trailingStopPct', 'Trailing stop', '%', '0 = off. Sells all if a coin falls this far below the best value it reached.', '1')}
          <div class="field"><label>&nbsp;</label><div class="hint" style="line-height:1.5">Stops are checked every few seconds and stay on even when copying is paused — but only while the bot is running. Use the 24/7 server so they keep working when your PC is off.</div></div>
        </div>
        <div class="toggle-row" style="margin-top:8px"><div class="grow"><div class="t">Buy each token once</div><div class="d">Ignore repeat buys of a token you already hold</div></div><label class="switch"><input type="checkbox" data-set-bool="buyOncePerToken" ${s.buyOncePerToken ? 'checked' : ''}><span></span></label></div>
        <button class="btn primary" style="margin-top:12px" id="saveRisk">Save limits</button>
      </div>

      <div class="card">
        <div class="card-h">${icon('gear')}<h3>Execution</h3></div>
        <div class="form-grid">
          <div class="field"><label>Swap route</label><select class="input" data-set="router"><option value="ultra" ${s.router !== 'metis' ? 'selected' : ''}>Jupiter Ultra (recommended)</option><option value="metis" ${s.router === 'metis' ? 'selected' : ''}>Jupiter Swap API + your RPC</option></select></div>
          ${num('slippageBps', 'Slippage (Swap API)', 'bps', '500 = 5%. Ultra sets slippage automatically.', '10')}
          ${num('maxPriorityFeeSol', 'Max priority fee', 'SOL', '', '0.0005')}
          ${num('maxSignalAgeSec', 'Skip signals older than', 'sec', '', '5')}
          ${num('pollMs', 'Poll interval', 'ms', 'Plus instant websocket triggers.', '500')}
          ${num('paperStartSol', 'Paper starting balance', 'SOL', '', '1')}
        </div>
        <div class="field" style="margin-top:14px"><label>Solana RPC URL</label><input class="input mono" data-set="rpcUrl" value="${esc(s.rpcUrl || '')}" spellcheck="false"><span class="hint">The free public RPC works but is rate-limited. A free Helius/QuickNode URL makes copying faster and more reliable.</span></div>
        <div class="field" style="margin-top:14px"><label>Jupiter API key (optional)</label><input class="input mono" data-set="jupiterApiKey" value="${esc(s.jupiterApiKey || '')}" placeholder="From portal.jup.ag — raises rate limits" spellcheck="false"></div>
        <button class="btn primary" style="margin-top:14px" id="saveExec">Save execution settings</button>
      </div>

      <div class="card">
        <div class="card-h">${icon('info')}<h3>App</h3><span class="muted small" style="margin-left:auto">v${esc(S.info.version || '')}</span></div>
        <div class="toggle-row"><div class="grow"><div class="t">Keep running in the tray</div><div class="d">Closing the window keeps the local engine copying</div></div><label class="switch"><input type="checkbox" id="trayToggle" ${S.info.closeToTray ? 'checked' : ''}><span></span></label></div>
        <div class="small faint" style="margin-top:10px;line-height:1.5">Unofficial tool, not affiliated with Fomo Labs or pump.fun. Copy trading is risky — memecoins can go to zero in minutes. Nothing here is financial advice.</div>
      </div>
    </div>
  </div>`;
};

VIEW_BIND.settings = (root) => {
  const s = S.settings || {};
  const b = (id, fn) => { const el = $('#' + id, root); if (el) el.onclick = fn; };
  b('useLocal', async () => { S.conn = await bot.conn.useLocal(); await loadAll(); render(); toast('Running the engine on this PC'); });
  const s247 = $('#sw247', root);
  if (s247) s247.onchange = async () => {
    S.always = await bot.always.set({ run247: s247.checked });
    toast(s247.checked ? 'Running 24/7: starts with Windows and keeps this PC awake' : '24/7 mode off', 'success');
    render();
  };
  const sLan = $('#swLan', root);
  if (sLan) sLan.onchange = async () => {
    sLan.disabled = true;
    S.always = await bot.always.set({ lanAccess: sLan.checked });
    await loadAll();
    render();
  };
  b('newPin', async () => { S.always = await bot.always.newPin(); render(); });
  if (!S.always) bot.always.get().then((a) => { S.always = a; if (S.route === 'settings') render(); });
  b('discoverBtn', async () => {
    SET.discovering = true; render();
    SET.discovered = await bot.conn.discover();
    SET.discovering = false; render();
  });
  $$('[data-pair]', root).forEach((el) => el.onclick = () => pairModal(el.dataset.pair, el.dataset.port, el.dataset.name));
  b('manualConn', () => manualConnModal());
  b('importPk', async () => {
    const v = $('#pk', root).value.trim();
    if (!v) return toast('Paste a private key first', 'warn');
    const r = await bot.wallet.import(v);
    $('#pk', root).value = '';
    if (r.error) return toast(r.error, 'error');
    toast('Wallet imported', 'success');
    await loadStatus(); render();
  });
  b('genWallet', async () => {
    const r = await bot.wallet.generate();
    if (r.error) return toast(r.error, 'error');
    SET.newSecret = r.data.secret;
    await loadStatus(); render();
  });
  b('hideSecret', () => { SET.newSecret = null; render(); });
  b('removeWallet', async () => {
    if (!(await confirmModal({ title: 'Remove wallet?', body: 'The bot will forget this key and switch to paper mode. Your funds stay in the wallet — make sure you have the key backed up.', ok: 'Remove', danger: true }))) return;
    try { await DEL('/api/wallet'); SET.newSecret = null; await loadAll(); render(); } catch (e) { toast(e.message, 'error'); }
  });
  $$('[data-mode]', root).forEach((el) => el.onclick = async () => {
    const mode = el.dataset.mode;
    if (mode === S.status?.mode) return;
    if (mode === 'live') {
      if (!S.status?.wallet) return toast('Import or create a wallet first', 'warn');
      const ok = await confirmModal({ title: 'Switch to live trading?', body: `From now on the bot spends <b>real SOL</b> from ${short(S.status.wallet.publicKey)} whenever a trader you copy buys — up to ${fmtSol(s.maxTradeSol)} SOL per trade and ${s.dailyLimitSol ? fmtSol(s.dailyLimitSol) + ' SOL per day' : 'no daily limit'}. Memecoins are extremely risky.`, ok: 'Go live', danger: true });
      if (!ok) return;
    }
    try { await PUT('/api/settings', { mode }); await loadAll(); render(); toast(mode === 'live' ? 'Live trading on' : 'Paper trading on', mode === 'live' ? 'warn' : 'success'); } catch (e) { toast(e.message, 'error'); }
  });
  const rs = $('#runningSw', root); if (rs) rs.onchange = toggleRunning;
  const save = async (fields) => {
    const patch = {};
    $$('[data-set]', root).forEach((el) => { if (fields.includes(el.dataset.set)) patch[el.dataset.set] = el.value; });
    $$('[data-set-bool]', root).forEach((el) => { if (fields.includes(el.dataset.setBool)) patch[el.dataset.setBool] = el.checked; });
    try { S.settings = await PUT('/api/settings', patch); toast('Settings saved', 'success'); render(); } catch (e) { toast(e.message, 'error'); }
  };
  b('saveRisk', () => save(['defaultBuySol', 'maxTradeSol', 'dailyLimitSol', 'minReserveSol', 'minSourceTradeSol', 'maxOpenPositions', 'takeProfitPct', 'stopLossPct', 'trailingStopPct', 'buyOncePerToken']));
  b('saveExec', () => save(['router', 'slippageBps', 'maxPriorityFeeSol', 'maxSignalAgeSec', 'pollMs', 'paperStartSol', 'rpcUrl', 'jupiterApiKey']));
  const tt = $('#trayToggle', root); if (tt) tt.onchange = async () => { await bot.setCloseToTray(tt.checked); S.info.closeToTray = tt.checked; };
};

function pairModal(host, port, name) {
  modal(`
    <div class="row"><div class="server-ico">${icon('server')}</div><div><h3>Pair with ${esc(name || host)}</h3><div class="small muted mono">${esc(host)}:${esc(port)}</div></div><button class="icon-btn x" data-close>${icon('x')}</button></div>
    <div class="body">
      <div class="field"><label>Pairing code shown in the server window</label><input class="input pin-input num" id="pin" maxlength="7" placeholder="000 000" autocomplete="off"></div>
    </div>
    <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pairGo">Pair</button></div>`,
  { onMount: (m, close) => {
    const inp = $('#pin', m); inp.focus();
    const go2 = async () => {
      $('#pairGo', m).innerHTML = '<span class="spinner sm"></span>';
      const r = await bot.conn.pair({ host, port, pin: inp.value.replace(/\D/g, '') });
      if (r.error) { toast(r.error, 'error'); $('#pairGo', m).textContent = 'Pair'; return; }
      S.conn = r; close(); toast(`Connected to ${name || host}`, 'success');
      await sleep(400); await loadAll(); render();
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go2(); });
    $('#pairGo', m).onclick = go2;
  } });
}

function manualConnModal() {
  modal(`
    <div class="row"><h3>Connect to a server</h3><button class="icon-btn x" data-close>${icon('x')}</button></div>
    <div class="body">
      <div class="form-grid" style="grid-template-columns:2fr 1fr"><div class="field"><label>Server IP</label><input class="input mono" id="mHost" placeholder="192.168.1.50"></div><div class="field"><label>Port</label><input class="input mono" id="mPort" value="7420"></div></div>
      <div class="seg" id="mSeg"><button class="on" data-m="pin">Pairing code</button><button data-m="token">Access token</button></div>
      <div class="field" id="mPinF"><label>Pairing code</label><input class="input pin-input num" id="mPin" maxlength="7" placeholder="000 000"></div>
      <div class="field hide" id="mTokF"><label>Access token (press T in the server window)</label><input class="input mono" id="mTok"></div>
      <div class="note">${icon('info')}<div>The server window lists its IP addresses. Use the one on your home network (usually 192.168.x.x or 10.x.x.x).</div></div>
    </div>
    <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="mGo">Connect</button></div>`,
  { onMount: (m, close) => {
    let kind = 'pin';
    $$('[data-m]', m).forEach((x) => x.onclick = () => { kind = x.dataset.m; $$('[data-m]', m).forEach((y) => y.classList.toggle('on', y === x)); $('#mPinF', m).classList.toggle('hide', kind !== 'pin'); $('#mTokF', m).classList.toggle('hide', kind !== 'token'); });
    $('#mGo', m).onclick = async () => {
      const host = $('#mHost', m).value.trim(), port = $('#mPort', m).value.trim();
      if (!host) return toast('Enter the server IP', 'warn');
      $('#mGo', m).innerHTML = '<span class="spinner sm"></span>';
      const r = kind === 'pin' ? await bot.conn.pair({ host, port, pin: $('#mPin', m).value.replace(/\D/g, '') }) : await bot.conn.manual({ host, port, token: $('#mTok', m).value.trim() });
      if (r.error) { toast(r.error, 'error'); $('#mGo', m).textContent = 'Connect'; return; }
      S.conn = r; close(); toast('Connected to server', 'success');
      await sleep(400); await loadAll(); render();
    };
  } });
}

// ================= boot =================
// Broken remote images fall back to initials (inline onerror handlers are blocked by the CSP).
document.addEventListener('error', (e) => {
  const el = e.target;
  if (el && el.tagName === 'IMG' && el.dataset.fb) el.outerHTML = el.dataset.fb;
}, true);
document.addEventListener('click', (e) => {
  const g = e.target.closest('#nav [data-go], #connPill');
  if (g) go(g.dataset.go);
});
$('#runBtn').onclick = toggleRunning;
$('.search-ico').innerHTML = icon('search');
const gs = $('#globalSearch');
gs.addEventListener('keydown', (e) => { if (e.key === 'Enter') { runSearch(gs.value); gs.blur(); } });
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); gs.focus(); gs.select(); } });

function renderUpdate(u) {
  const b = $('#updBtn');
  if (!u || u.state !== 'ready') { b.classList.add('hide'); return; }
  b.classList.remove('hide');
  b.innerHTML = `${icon('refresh')}Update to ${esc(u.version)} — restart`;
}
$('#updBtn').onclick = () => { $('#updBtn').innerHTML = '<span class="spinner sm"></span>Restarting…'; bot.update.install(); };
bot.update.onState(renderUpdate);
bot.always.onState((a) => { S.always = a; if (S.route === 'settings' && !$('#modal-root').firstChild) render(); });
bot.update.state().then(renderUpdate);

bot.onEvent(onEngineEvent);
bot.conn.onState((s) => { const was = S.conn.connected; S.conn = s; renderChrome(); if (s.connected && !was) loadAll().then(render); if (S.route === 'settings') soon('render', render); });

(async () => {
  S.info = await bot.info();
  const c = await bot.conn.get();
  if (c && !c.error) S.conn = c;
  render();
  await loadAll();
  render();
  setInterval(() => { loadStatus(); if (['home', 'portfolio'].includes(S.route)) loadPositions().then(() => { if (!$('#modal-root').firstChild && ['home', 'portfolio'].includes(S.route)) render(); }); }, 15000);
})();
