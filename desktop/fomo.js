'use strict';
// Fomo bridge: runs Fomo API calls inside a hidden fomo.family window so they use the user's own
// signed-in session (Fomo requires login to search and view profiles). No credentials touch this app.
const { BrowserWindow, session, shell, dialog } = require('electron');

const ORIGIN = 'https://fomo.family';
const API = 'https://prod-api.fomo.family';
const PARTITION = 'persist:fomo';
const CHAINS = '1399811149,8453,56,143'; // solana, base, bnb, monad
const SOLANA_NETWORK = 1399811149;
const LOGIN_HOSTS = /(^|\.)(fomo\.family|privy\.io|google\.com|apple\.com|appleid\.apple\.com|twitter\.com|x\.com|gstatic\.com|googleusercontent\.com|walletconnect\.com|coinbase\.com)$/;

class FomoBridge {
  constructor() {
    this.win = null;
    this.ready = null;
    this.me = null;
    this.ses = session.fromPartition(PARTITION);
  }

  _ensure() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    this.win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { partition: PARTITION, sandbox: true, backgroundThrottling: false } });
    this.win.webContents.setAudioMuted(true);
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.ready = new Promise((resolve) => {
      const done = () => setTimeout(resolve, 1200); // give Privy a moment to restore the session
      this.win.webContents.once('did-finish-load', done);
      this.win.webContents.once('did-fail-load', done);
      setTimeout(resolve, 20000);
    });
    this.win.loadURL(ORIGIN + '/');
    this.win.on('closed', () => { this.win = null; });
    return this.ready;
  }

  async _call(path, wc) {
    if (!wc) { await this._ensure(); wc = this.win.webContents; }
    const res = await wc.executeJavaScript(`(${pageFetch.toString()})(${JSON.stringify(API + path)}, ${JSON.stringify(CHAINS)})`, true);
    if (res.status === 200 && res.body && res.body.success !== false) return res.body.responseObject ?? res.body;
    const authErr = [401, 403, 430, 431].includes(res.status) || res.body?.statusCode === 401;
    const e = new Error(authErr ? 'Sign in to Fomo to search traders' : res.body?.message || res.error || `Fomo API error ${res.status}`);
    e.code = authErr ? 'FOMO_AUTH' : 'FOMO_ERR';
    throw e;
  }

  async status() {
    try {
      const ro = await this._call('/v2/users/current');
      this.me = normalizeUser(ro.user || ro);
      return { signedIn: true, me: this.me };
    } catch (e) {
      this.me = null;
      return { signedIn: false, error: e.code === 'FOMO_AUTH' ? null : e.message };
    }
  }

  login(parent) {
    return new Promise((resolve) => {
      const w = new BrowserWindow({
        parent, modal: false, width: 520, height: 820, title: 'Sign in to Fomo', autoHideMenuBar: true, backgroundColor: '#060510',
        webPreferences: { partition: PARTITION, sandbox: true },
      });
      w.webContents.setWindowOpenHandler(({ url }) => {
        try {
          if (LOGIN_HOSTS.test(new URL(url).hostname)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: PARTITION, sandbox: true } } };
        } catch { /* fallthrough */ }
        shell.openExternal(url);
        return { action: 'deny' };
      });
      // Google doesn't allow its sign-in inside app windows; tell the user which methods work instead.
      let warned = false;
      const watchGoogle = (wc) => wc.on('did-navigate', (_e, url) => {
        if (warned || !/accounts\.google\.com\/.*rejected/i.test(url)) return;
        warned = true;
        dialog.showMessageBox(w, {
          type: 'info',
          title: 'Google sign-in isn\'t available here',
          message: 'Google doesn\'t allow signing in from inside apps.',
          detail: 'Close the Google window and pick another option on the fomo login screen — Email (use the same address as your Google account), Apple, or X.',
        });
      });
      watchGoogle(w.webContents);
      w.webContents.on('did-create-window', (child) => watchGoogle(child.webContents));
      w.loadURL(ORIGIN + '/');
      let finished = false;
      const finish = async () => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        if (!w.isDestroyed()) w.close();
        if (this.win && !this.win.isDestroyed()) { this.win.destroy(); this.win = null; }
        resolve(await this.status());
      };
      const timer = setInterval(async () => {
        if (w.isDestroyed()) return;
        try {
          await this._call('/v2/users/current', w.webContents);
          finish();
        } catch { /* not yet */ }
      }, 2500);
      w.on('closed', finish);
    });
  }

  async logout() {
    await this.ses.clearStorageData();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.me = null;
    return { signedIn: false };
  }

  async search(q) {
    const term = String(q || '').trim().replace(/^@/, '');
    if (!term) return [];
    const ro = await this._call(`/v2/users/fuzzy-search?searchTerm=${encodeURIComponent(term)}`);
    return toList(ro, ['users']).map(normalizeUser).filter((u) => u.id || u.handle);
  }

  async leaderboard(window = '24h') {
    const path = window === 'all-time' ? '/v2/leaderboard' : `/v2/leaderboard/${encodeURIComponent(window)}`;
    const ro = await this._call(path);
    return toList(ro, ['leaderboard', 'users', 'entries']).map((row, i) => {
      const u = normalizeUser(row.user || row);
      u.rank = row.rank ?? i + 1;
      u.pnl = num(row.pnl ?? row.totalPnlUsd ?? row.realizedPnlUsd ?? row.pnlUsd ?? u.pnl);
      u.volume = num(row.volume ?? row.volumeUsd ?? u.volume);
      return u;
    });
  }

  async profile(ref) {
    const isId = /^\d+$/.test(String(ref)) || /^[0-9a-f-]{20,}$/i.test(String(ref));
    let ro;
    if (isId) ro = await this._call(`/v2/users/${encodeURIComponent(ref)}`);
    else ro = await this._call(`/v2/users/userHandle/${encodeURIComponent(String(ref).replace(/^@/, ''))}`);
    const user = normalizeUser(ro.user || ro);
    const id = user.id || ref;
    const [balances, swaps] = await Promise.all([
      this._call(`/v2/users/${encodeURIComponent(id)}/balances`).then(normalizeBalances).catch(() => []),
      this._call(`/v2/users/${encodeURIComponent(id)}/swaps`).then(normalizeSwaps).catch(() => []),
    ]);
    if (!user.address) {
      const sol = balances.find((b) => b.ownerAddress && isBase58(b.ownerAddress));
      if (sol) user.address = sol.ownerAddress;
    }
    return { user, balances, swaps };
  }
}

// Runs inside the fomo.family page. Uses the site's own session cookie; falls back to the Privy token header.
function pageFetch(url, chains) {
  const headers = { 'X-Supported-Chains': chains, 'App-Language': 'en' };
  const go = (extra) => fetch(url, { credentials: 'include', headers: { ...headers, ...extra } })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
    .catch((e) => ({ status: 0, error: String(e) }));
  return go({}).then((res) => {
    if (![401, 430, 431].includes(res.status)) return res;
    let tok = null;
    try {
      tok = JSON.parse(localStorage.getItem('privy:token') || 'null');
      if (!tok) { const m = document.cookie.match(/privy-token=([^;]+)/); tok = m && decodeURIComponent(m[1]); }
    } catch (e) { /* no token */ }
    return tok ? go({ Authorization: 'Bearer ' + tok }) : res;
  });
}

// ----- normalizers (Fomo's API is undocumented, so accept the common field spellings) -----
function toList(ro, keys) {
  if (Array.isArray(ro)) return ro;
  for (const k of keys) if (Array.isArray(ro?.[k])) return ro[k];
  const firstArr = ro && Object.values(ro).find(Array.isArray);
  return firstArr || [];
}

function normalizeUser(u = {}) {
  const handle = u.userHandle ?? u.handle ?? u.username ?? null;
  const addrs = findAddresses(u);
  return {
    id: u.id ?? u.userId ?? u.fomoId ?? null,
    handle,
    name: u.displayName ?? u.name ?? handle ?? 'Fomo trader',
    avatar: u.profilePictureLink ?? u.profilePicture ?? u.pfp ?? u.avatar ?? u.imageUrl ?? null,
    cover: u.coverPhotoLink ?? u.coverPhoto ?? null,
    bio: u.bio ?? u.description ?? null,
    verified: !!(u.verified ?? u.isVerified),
    followers: num(u.followerCount ?? u.followersCount ?? u.numFollowers ?? u.followers),
    following: num(u.followingCount ?? u.numFollowing ?? u.following),
    pnl: num(u.totalPnlUsd ?? u.pnl ?? u.realizedPnlUsd ?? u.pnlUsd),
    volume: num(u.volume ?? u.volumeUsd ?? u.totalVolumeUsd),
    tradeCount: num(u.tradeCount ?? u.numTrades),
    twitter: typeof u.twitter === 'string' ? u.twitter : u.twitterHandle ?? u.twitter?.username ?? null,
    address: u.address && isBase58(u.address) ? u.address : u.solanaAddress ?? u.svmAddress ?? addrs.sol,
    evmAddress: u.evmAddress ?? addrs.evm,
  };
}

function findAddresses(obj, depth = 0, out = { sol: null, evm: null }) {
  if (!obj || typeof obj !== 'object' || depth > 3) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      if (!out.evm && /^0x[0-9a-fA-F]{40}$/.test(v) && /addr|wallet/i.test(k)) out.evm = v;
      else if (!out.sol && isBase58(v) && /addr|wallet|solana|svm/i.test(k)) out.sol = v;
    } else if (v && typeof v === 'object') findAddresses(v, depth + 1, out);
  }
  return out;
}

function tokenOf(x) {
  const t = x.token || x.tokenInfo || x.asset || x;
  return {
    mint: t.address ?? t.tokenAddress ?? x.tokenAddress ?? t.mint ?? null,
    networkId: num(t.networkId ?? x.networkId ?? t.chainId ?? x.chainId),
    symbol: t.symbol ?? t.tokenSymbol ?? x.symbol ?? '???',
    name: t.name ?? t.tokenName ?? x.tokenName ?? '',
    icon: t.imageUrl ?? t.imageLargeUrl ?? t.imageSmallUrl ?? t.logo ?? t.image ?? t.icon ?? t.logoURI ?? null,
  };
}

function normalizeBalances(ro) {
  return toList(ro, ['balances', 'tokens', 'holdings']).map((b) => ({
    ...tokenOf(b),
    amount: num(b.balance ?? b.amount ?? b.tokenAmount ?? b.uiAmount),
    usd: num(b.usdValue ?? b.balanceUsd ?? b.valueUsd ?? b.usdAmount ?? b.value),
    pnl: num(b.totalPnlUsd ?? b.pnl ?? b.unrealizedPnlUsd ?? b.pnlUsd),
    pnlPct: num(b.totalPnlPercentage ?? b.pnlPercent ?? b.pnlPercentage),
    ownerAddress: b.walletAddress ?? b.ownerAddress ?? b.owner ?? null,
  })).filter((b) => b.mint).sort((a, b) => (b.usd || 0) - (a.usd || 0));
}

function normalizeSwaps(ro) {
  return toList(ro, ['swaps', 'trades']).map((s) => {
    const dir = String(s.direction ?? s.side ?? s.type ?? s.swapType ?? '').toLowerCase();
    const ts = s.blockTime ?? s.timestamp ?? s.createdAt ?? s.executedAt;
    return {
      ...tokenOf(s),
      side: dir.includes('sell') ? 'sell' : dir.includes('buy') ? 'buy' : s.isBuy === false ? 'sell' : 'buy',
      usd: num(s.usdAmount ?? s.amountUsd ?? s.valueUsd ?? s.totalUsd),
      tokenAmount: num(s.tokenAmount ?? s.amount),
      priceUsd: num(s.priceUsd ?? s.price),
      pnl: num(s.realizedPnlUsd ?? s.pnlUsd ?? s.pnl),
      ts: typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : ts ? Date.parse(ts) : null,
      tx: s.transactionHash ?? s.txHash ?? s.signature ?? null,
    };
  }).filter((s) => s.mint);
}

function isBase58(s) {
  return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { FomoBridge, SOLANA_NETWORK };
