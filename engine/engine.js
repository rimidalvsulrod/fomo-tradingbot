'use strict';
// The copy-trading engine: watches target wallets, mirrors their swaps, tracks positions.
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Connection, PublicKey } = require('@solana/web3.js');
const { Store } = require('./store');
const secure = require('./secure');
const { Jupiter, SOL_MINT, sleep } = require('./jupiter');
const { keypairFromSecret, tokenBalanceRaw, parseSwap, getParsedTx, keyStr } = require('./solana');
const { Discover, summarize } = require('./discover');

const VERSION = '1.9.0';

const DEFAULT_SETTINGS = {
  mode: 'paper', // 'paper' simulates fills with live quotes; 'live' signs real transactions
  running: true,
  rpcUrl: 'https://solana-rpc.publicnode.com', // free, no key, far higher limits than api.mainnet-beta
  jupiterApiKey: '',
  router: 'ultra', // 'ultra' | 'metis'
  pollMs: 4000,
  maxSignalAgeSec: 90,
  slippageBps: 500,
  maxPriorityFeeSol: 0.002,
  defaultBuySol: 0.05,
  maxTradeSol: 0.5,
  dailyLimitSol: 3,
  minReserveSol: 0.02,
  minSourceTradeSol: 0.005,
  maxOpenPositions: 30,
  buyOncePerToken: false,
  takeProfitPct: 0,
  stopLossPct: 0,
  trailingStopPct: 0,
  paperStartSol: 10,
};

const DEFAULT_TARGET = {
  enabled: true,
  mode: 'copy', // 'copy' | 'inverse' (do the opposite of the trader)
  sizing: 'fixed', // 'fixed' | 'ratio'
  fixedSol: null, // null = settings.defaultBuySol
  ratio: 0.1,
  maxSol: null,
  copyBuys: true,
  copySells: true,
};

class Engine extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.dataDir = dataDir;
    require('fs').mkdirSync(dataDir, { recursive: true });
    this.startedAt = Date.now();
    this.machineKey = secure.loadMachineKey(dataDir);
    this.store = new Store(path.join(dataDir, 'state.json'), {
      settings: DEFAULT_SETTINGS,
      wallet: null,
      targets: [],
      positions: { live: {}, paper: {} },
      paper: { sol: DEFAULT_SETTINGS.paperStartSol },
      trades: [],
      daily: { date: '', sol: 0 },
      cursors: {},
      realized: { live: 0, paper: 0 },
    });
    this.logs = [];
    this.keypair = null;
    this.seen = new Set();
    this.queue = Promise.resolve();
    this.pollTimer = null;
    this.subs = new Map();
    this.pollNow = new Set();
    this.polling = new Set();
    this.exiting = new Set();
    this.status = { rpcOk: null, lastPollAt: 0, lastError: null, solBalance: null };
    this.jup = new Jupiter(() => this.settings, this.logger());
    // Installs that still use the old rate-limited default move to the faster free endpoint.
    if (this.settings.rpcUrl === 'https://api.mainnet-beta.solana.com' && !this.settings.rpcMigrated) {
      this.settings.rpcUrl = DEFAULT_SETTINGS.rpcUrl;
      this.settings.rpcMigrated = true;
      this.store.save();
    }
    this._loadWallet();
    this._connect();
    this.discover = new Discover(this);
  }

  // ---------- state accessors ----------
  get s() { return this.store.data; }
  get settings() { return this.s.settings; }
  get mode() { return this.settings.mode === 'live' ? 'live' : 'paper'; }
  get positions() { return this.s.positions[this.mode]; }

  logger() {
    const mk = (level) => (msg, data) => this._log(level, msg, data);
    return { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug'), success: mk('success') };
  }

  _log(level, msg, data) {
    if (level === 'debug' && !process.env.FOMOBOT_DEBUG) return;
    const entry = { id: crypto.randomUUID(), ts: Date.now(), level, msg, data };
    this.logs.push(entry);
    if (this.logs.length > 600) this.logs.splice(0, this.logs.length - 600);
    this.emit('event', { type: 'log', entry });
  }

  _changed(kind) {
    this.store.save();
    this.emit('event', { type: kind });
  }

  // ---------- wallet ----------
  _loadWallet() {
    if (!this.s.wallet) return;
    try {
      this.keypair = keypairFromSecret(secure.open(this.machineKey, this.s.wallet.sealed));
    } catch (e) {
      this._log('error', 'Could not unlock the saved wallet on this machine. Import it again in Settings.');
      this.keypair = null;
    }
  }

  importWallet(secret) {
    const kp = keypairFromSecret(secret);
    this.s.wallet = { publicKey: kp.publicKey.toBase58(), sealed: secure.seal(this.machineKey, secret.trim()), addedAt: Date.now() };
    this.keypair = kp;
    this._log('success', `Wallet connected: ${short(kp.publicKey.toBase58())}`);
    this._changed('status');
    this.store.flush();
    this.refreshBalance();
    return this.s.wallet.publicKey;
  }

  generateWallet() {
    const { Keypair } = require('@solana/web3.js');
    const { bs58 } = require('./solana');
    const kp = Keypair.generate();
    const secret = bs58.encode(kp.secretKey);
    this.importWallet(secret);
    return { publicKey: kp.publicKey.toBase58(), secret };
  }

  removeWallet() {
    this.s.wallet = null;
    this.keypair = null;
    if (this.settings.mode === 'live') this.settings.mode = 'paper';
    this._log('warn', 'Wallet removed. Switched to paper trading.');
    this._changed('status');
  }

  // ---------- connection / lifecycle ----------
  _connect() {
    for (const id of [...this.subs.keys()]) this._unsubscribe(id);
    const url = this.settings.rpcUrl || DEFAULT_SETTINGS.rpcUrl;
    this.connection = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: false });
  }

  start() {
    this._log('info', `Engine v${VERSION} started (${this.mode === 'live' ? 'LIVE trading' : 'paper trading'})`);
    this._loop();
    this.balanceTimer = setInterval(() => this.refreshBalance(), 30000);
    this.riskTimer = setInterval(() => this._riskCheck().catch(() => {}), 8000);
    this.refreshBalance();
  }

  stop() {
    clearTimeout(this.pollTimer);
    clearInterval(this.balanceTimer);
    clearInterval(this.riskTimer);
    for (const id of [...this.subs.keys()]) this._unsubscribe(id);
    this.store.flush();
  }

  async refreshBalance() {
    if (!this.keypair) { this.status.solBalance = null; return; }
    try {
      const lamports = await this.connection.getBalance(this.keypair.publicKey);
      this.status.solBalance = lamports / 1e9;
      this.status.rpcOk = true;
      this.emit('event', { type: 'status' });
    } catch (e) {
      this.status.rpcOk = false;
      this.status.lastError = 'RPC: ' + e.message;
    }
  }

  setRunning(on) {
    this.settings.running = !!on;
    this._log(on ? 'success' : 'warn', on ? 'Copy trading resumed' : 'Copy trading paused');
    this._changed('status');
  }

  updateSettings(patch) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    const before = { ...this.settings };
    for (const k of Object.keys(patch || {})) {
      if (!allowed.includes(k)) continue;
      const def = DEFAULT_SETTINGS[k];
      let v = patch[k];
      if (k === 'jupiterApiKey' && String(v).startsWith('••••')) continue;
      if (typeof def === 'number') { v = Number(v); if (!Number.isFinite(v) || v < 0) continue; }
      if (typeof def === 'boolean') v = !!v;
      if (typeof def === 'string') v = String(v).trim();
      this.settings[k] = v;
    }
    if (this.settings.mode === 'live' && !this.keypair) {
      this.settings.mode = 'paper';
      throw httpError(400, 'Connect a wallet before switching to live trading.');
    }
    if (!['paper', 'live'].includes(this.settings.mode)) this.settings.mode = 'paper';
    this.settings.pollMs = Math.max(1500, this.settings.pollMs);
    if (before.rpcUrl !== this.settings.rpcUrl) { this._connect(); this.refreshBalance(); }
    if (before.mode !== this.settings.mode) {
      this._log(this.settings.mode === 'live' ? 'warn' : 'info',
        this.settings.mode === 'live' ? 'LIVE trading enabled — real transactions will be signed' : 'Switched to paper trading');
    }
    this._changed('status');
    return this.settings;
  }

  resetPaper() {
    this.s.positions.paper = {};
    this.s.paper.sol = this.settings.paperStartSol;
    this.s.realized.paper = 0;
    this.s.trades = this.s.trades.filter((t) => t.mode !== 'paper');
    this._log('info', `Paper account reset to ${this.settings.paperStartSol} SOL`);
    this._changed('positions');
  }

  // ---------- targets ----------
  addTarget(input) {
    const address = String(input.address || '').trim();
    try { new PublicKey(address); } catch { throw httpError(400, 'That is not a valid Solana wallet address.'); }
    const existing = this.s.targets.find((t) => t.address === address);
    if (existing) return this.updateTarget(existing.id, { ...input, enabled: true });
    const t = {
      ...DEFAULT_TARGET,
      id: crypto.randomUUID(),
      address,
      source: input.fomoUserId ? 'fomo' : 'wallet',
      fomoUserId: input.fomoUserId || null,
      handle: input.handle || null,
      name: input.name || input.handle || short(address),
      avatar: input.avatar || null,
      addedAt: Date.now(),
      stats: { copied: 0, skipped: 0, lastTradeAt: null },
    };
    applyTargetPatch(t, input);
    this.s.targets.push(t);
    this._log('success', `Now copying ${t.name}`);
    this._changed('targets');
    this._schedule(0);
    return t;
  }

  updateTarget(id, patch) {
    const t = this.s.targets.find((x) => x.id === id);
    if (!t) throw httpError(404, 'Trader not found');
    applyTargetPatch(t, patch);
    if (!t.enabled) this._unsubscribe(t.id);
    this._changed('targets');
    return t;
  }

  removeTarget(id) {
    const t = this.s.targets.find((x) => x.id === id);
    if (!t) throw httpError(404, 'Trader not found');
    this._unsubscribe(id);
    this.s.targets = this.s.targets.filter((x) => x.id !== id);
    delete this.s.cursors[id];
    this._log('info', `Stopped copying ${t.name}`);
    this._changed('targets');
  }

  // ---------- watcher ----------
  _schedule(ms) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this._loop(), ms);
  }

  async _loop() {
    try {
      const targets = this.s.targets.filter((t) => t.enabled);
      for (const t of targets) {
        this._ensureSubscription(t);
        await this._pollTarget(t);
      }
      this.status.lastPollAt = Date.now();
      if (this.status.rpcOk === false) this._log('success', 'RPC connection restored');
      this.status.rpcOk = true;
      this.status.lastError = null;
    } catch (e) {
      if (this.status.rpcOk !== false) this._log('error', `RPC error: ${e.message}`);
      this.status.rpcOk = false;
      this.status.lastError = 'RPC: ' + e.message;
    }
    // Live websocket pushes are the fast path; while every target has one, polling is only a backstop,
    // which also keeps the free RPC's rate limit free for the transaction lookups that matter.
    const enabled = this.s.targets.filter((t) => t.enabled);
    const allPushed = enabled.length > 0 && enabled.every((t) => this.subs.has(t.id));
    let delay = allPushed ? Math.max(this.settings.pollMs, 12000) : this.settings.pollMs;
    if (this.status.rpcOk === false) delay = Math.max(10000, delay);
    this._schedule(delay);
  }

  _ensureSubscription(t) {
    if (this.subs.has(t.id)) return;
    try {
      // The push carries the transaction signature, so it can be fetched immediately (no extra history lookup).
      const subId = this.connection.onLogs(new PublicKey(t.address), (ev) => {
        if (!ev || ev.err || !ev.signature) return;
        this._processSig(t, ev.signature, null, true).catch(() => {});
      }, 'confirmed');
      this.subs.set(t.id, { subId, conn: this.connection });
    } catch { /* websocket optional; polling continues */ }
  }

  async _processSig(t, signature, blockTime, fromPush = false) {
    if (this.seen.has(signature)) return;
    this.seen.add(signature);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
    let tx = null;
    // A just-pushed transaction can take a moment to become fetchable.
    for (let i = 0; i < (fromPush ? 6 : 1) && !tx; i++) {
      if (i) await sleep(350);
      tx = await getParsedTx(this.connection, signature).catch(() => null);
    }
    const swap = parseSwap(tx, t.address, signature);
    if (!swap) return;
    const bt = blockTime || tx.blockTime;
    const age = bt ? Math.max(0, Date.now() / 1000 - bt) : 0;
    this._enqueue(() => this._handleSignal(t, swap, age));
  }

  _unsubscribe(id) {
    const s = this.subs.get(id);
    if (!s) return;
    s.conn.removeOnLogsListener(s.subId).catch(() => {});
    this.subs.delete(id);
  }

  async _pollTarget(t) {
    if (this.polling.has(t.id)) return;
    this.polling.add(t.id);
    try {
      const pk = new PublicKey(t.address);
      const cursor = this.s.cursors[t.id];
      const sigs = await this.connection.getSignaturesForAddress(pk, cursor ? { until: cursor, limit: 25 } : { limit: 1 });
      if (!sigs.length) return;
      this.s.cursors[t.id] = sigs[0].signature;
      this.store.save();
      if (!cursor) return; // first sight: start from now, don't replay history
      for (const sig of sigs.reverse()) {
        if (sig.err) continue;
        await this._processSig(t, sig.signature, sig.blockTime);
      }
    } finally {
      this.polling.delete(t.id);
    }
  }

  _enqueue(fn) {
    this.queue = this.queue.then(fn).catch((e) => this._log('error', e.message));
  }

  async _handleSignal(t, swap, age) {
    const target = this.s.targets.find((x) => x.id === t.id) || t;
    const solPx = swap.stableDelta ? await this.jup.solPrice() : 0;
    const quoteSpentSol = -swap.solDelta + (solPx ? -swap.stableDelta / solPx : 0);
    const quoteGotSol = swap.solDelta + (solPx ? swap.stableDelta / solPx : 0);
    const inverse = target.mode === 'inverse';
    for (const leg of swap.legs) {
      const tok = await this.jup.token(leg.mint);
      const label = `${target.name} ${leg.side === 'buy' ? 'bought' : 'sold'} $${tok.symbol}`;
      const sizeText = leg.side === 'buy' && quoteSpentSol > 0 ? ` for ${fmt(quoteSpentSol)} SOL` : leg.side === 'sell' ? ` (${Math.round(leg.fraction * 100)}% of bag)` : '';
      const modeText = inverse ? (leg.side === 'buy' ? ' → opposite: sell' : ' → opposite: buy') : '';
      this._log('info', label + sizeText + modeText, { kind: 'signal', mint: leg.mint, targetId: target.id, sig: swap.signature, icon: tok.icon });
      this.emit('event', { type: 'signal', targetId: target.id, mint: leg.mint, side: leg.side });

      const skip = (reason) => {
        target.stats.skipped = (target.stats.skipped || 0) + 1;
        this._recordTrade({ status: 'skipped', reason, side: leg.side, mint: leg.mint, token: tok, target, sourceSig: swap.signature });
      };
      if (!this.settings.running) { skip('bot paused'); continue; }
      if (age > this.settings.maxSignalAgeSec) { skip(`signal too old (${Math.round(age)}s)`); continue; }

      if (leg.side === 'buy' && !target.copyBuys) { skip('their buys are switched off for this trader'); continue; }
      if (leg.side === 'sell' && !target.copySells) { skip('their sells are switched off for this trader'); continue; }
      // Opposite mode: their sell → you buy (sized off what they got), their buy → you sell your bag.
      const act = inverse ? (leg.side === 'buy' ? 'sell' : 'buy') : leg.side;
      const theirSol = leg.side === 'buy' ? quoteSpentSol : quoteGotSol;
      if (act === 'buy') await this._copyBuy(target, leg, tok, Math.max(0, theirSol), swap.signature, skip);
      else await this._copySell(target, leg, tok, Math.max(0, theirSol), swap.signature, skip, inverse);
    }
    this._changed('targets');
  }

  _budgetToday() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.s.daily.date !== today) this.s.daily = { date: today, sol: 0 };
    return this.s.daily;
  }

  async _copyBuy(target, leg, tok, theirSol, sourceSig, skip) {
    const st = this.settings;
    if (theirSol > 0 && theirSol < st.minSourceTradeSol) return skip(`their trade is below ${st.minSourceTradeSol} SOL`);
    const holding = this.positions[leg.mint];
    if (holding && st.buyOncePerToken) return skip('already holding this token');
    if (!holding && Object.keys(this.positions).length >= st.maxOpenPositions) return skip('max open positions reached');

    let size = target.sizing === 'ratio' ? theirSol * (target.ratio || 0) : target.fixedSol ?? st.defaultBuySol;
    size = Math.min(size, st.maxTradeSol, target.maxSol ?? Infinity);
    const daily = this._budgetToday();
    if (st.dailyLimitSol > 0) size = Math.min(size, st.dailyLimitSol - daily.sol);
    if (size <= 0) return skip('daily SOL limit reached');

    const balance = this.mode === 'live' ? await this._liveSol() : this.s.paper.sol;
    const reserve = st.minReserveSol + (this.mode === 'live' ? 0.003 : 0);
    size = Math.min(size, balance - reserve);
    size = Math.floor(size * 1e6) / 1e6;
    if (size < 0.001) return skip(`insufficient SOL (balance ${fmt(balance)} SOL)`);

    await this._executeBuy({ mint: leg.mint, tok, sol: size, target, sourceSig, decimals: leg.decimals });
  }

  async _copySell(target, leg, tok, theirSol, sourceSig, skip, inverse = false) {
    const pos = this.positions[leg.mint];
    if (!pos) return skip(inverse ? 'you don\'t hold this token, so there\'s nothing to sell' : 'not holding this token');
    const fraction = inverse || leg.fraction >= 0.95 || leg.fraction === 0 ? 1 : leg.fraction;
    await this._executeSell({ mint: leg.mint, tok, fraction, target, sourceSig, reason: inverse ? 'opposite' : 'copy' }).catch(() => {});
  }

  async _mintDecimals(mint) {
    const info = await this.connection.getParsedAccountInfo(new PublicKey(mint)).catch(() => null);
    return info?.value?.data?.parsed?.info?.decimals ?? 6;
  }

  async _liveSol() {
    const lamports = await this.connection.getBalance(this.keypair.publicKey);
    this.status.solBalance = lamports / 1e9;
    return lamports / 1e9;
  }

  // ---------- execution ----------
  async _executeBuy({ mint, tok, sol, target, sourceSig, decimals: hint, throwOnError = false }) {
    const lamports = Math.round(sol * 1e9);
    const base = { side: 'buy', mint, token: tok, target, sourceSig, sol };
    try {
      let outRaw, signature = null, route = 'paper';
      if (this.mode === 'live') {
        if (!this.keypair) throw new Error('no wallet connected');
        const r = await this.jup.swap({ keypair: this.keypair, connection: this.connection, inputMint: SOL_MINT, outputMint: mint, amount: lamports });
        outRaw = BigInt(r.outAmount);
        signature = r.signature;
        route = r.route;
        this.refreshBalance();
      } else {
        const q = await this.jup.quote(SOL_MINT, mint, lamports);
        outRaw = BigInt(q.outAmount);
        this.s.paper.sol -= sol;
      }
      const decimals = tok.decimals ?? hint ?? (await this._mintDecimals(mint));
      const pos = this.positions[mint] || {
        mint, symbol: tok.symbol, name: tok.name, icon: tok.icon, decimals,
        amountRaw: '0', costSol: 0, openedAt: Date.now(), targets: [],
      };
      pos.amountRaw = (BigInt(pos.amountRaw) + outRaw).toString();
      pos.costSol += sol;
      if (target && !pos.targets.includes(target.id)) pos.targets.push(target.id);
      this.positions[mint] = pos;
      this._budgetToday().sol += sol;
      if (target) { target.stats.copied = (target.stats.copied || 0) + 1; target.stats.lastTradeAt = Date.now(); }
      const tokens = Number(outRaw) / 10 ** decimals;
      this._recordTrade({ ...base, status: 'success', tokenAmount: tokens, txSig: signature, route });
      this._log('success', `${this.mode === 'paper' ? '[paper] ' : ''}Bought ${fmtAmt(tokens)} $${tok.symbol} for ${fmt(sol)} SOL`, { kind: 'trade', mint, sig: signature, icon: tok.icon });
      this._changed('positions');
      return { tokenAmount: tokens, signature };
    } catch (e) {
      this._recordTrade({ ...base, status: 'failed', reason: e.message, txSig: e.signature || null });
      this._log('error', `Buy $${tok.symbol} failed: ${e.message}`, { mint });
      if (throwOnError) throw httpError(502, e.message);
    }
  }

  async _executeSell({ mint, tok, fraction, target, sourceSig, reason }) {
    const pos = this.positions[mint];
    if (!pos) throw httpError(404, 'No open position for that token');
    tok = tok || (await this.jup.token(mint));
    const base = { side: 'sell', mint, token: tok, target, sourceSig, reason };
    try {
      let held = BigInt(pos.amountRaw);
      if (this.mode === 'live') {
        const bal = await tokenBalanceRaw(this.connection, this.keypair.publicKey.toBase58(), mint);
        held = bal.raw;
        if (held === 0n) {
          delete this.positions[mint];
          this._changed('positions');
          throw new Error('wallet no longer holds this token — position closed');
        }
      }
      const amount = fraction >= 1 ? held : (held * BigInt(Math.round(fraction * 10000))) / 10000n;
      if (amount <= 0n) throw new Error('nothing to sell');
      let outLamports, signature = null, route = 'paper';
      if (this.mode === 'live') {
        const r = await this.jup.swap({ keypair: this.keypair, connection: this.connection, inputMint: mint, outputMint: SOL_MINT, amount: amount.toString() });
        outLamports = Number(r.outAmount);
        signature = r.signature;
        route = r.route;
        this.refreshBalance();
      } else {
        const q = await this.jup.quote(mint, SOL_MINT, amount.toString());
        outLamports = Number(q.outAmount);
      }
      const solOut = outLamports / 1e9;
      const soldFrac = held > 0n ? Number((amount * 10000n) / held) / 10000 : 1;
      const costPart = pos.costSol * soldFrac;
      const pnl = solOut - costPart;
      if (this.mode === 'paper') this.s.paper.sol += solOut;
      this.s.realized[this.mode] += pnl;
      const remaining = held - amount;
      if (remaining <= 0n || soldFrac >= 0.999) delete this.positions[mint];
      else {
        pos.amountRaw = remaining.toString();
        pos.costSol -= costPart;
        if (pos.peakSol) pos.peakSol *= 1 - soldFrac;
      }
      if (target) { target.stats.copied = (target.stats.copied || 0) + 1; target.stats.lastTradeAt = Date.now(); }
      const tokens = Number(amount) / 10 ** pos.decimals;
      this._recordTrade({ ...base, status: 'success', sol: solOut, tokenAmount: tokens, pnlSol: pnl, txSig: signature, route });
      this._log('success', `${this.mode === 'paper' ? '[paper] ' : ''}Sold ${Math.round(soldFrac * 100)}% $${tok.symbol} for ${fmt(solOut)} SOL (${pnl >= 0 ? '+' : ''}${fmt(pnl)} SOL)`, { kind: 'trade', mint, sig: signature, icon: tok.icon });
      this._changed('positions');
      return { solOut, pnl, signature };
    } catch (e) {
      this._recordTrade({ ...base, status: 'failed', reason: e.message, txSig: e.signature || null });
      this._log('error', `Sell $${tok.symbol} failed: ${e.message}`, { mint });
      throw e;
    }
  }

  manualSell(mint, percent) {
    const fraction = Math.min(1, Math.max(0.01, Number(percent) / 100));
    return new Promise((resolve, reject) => {
      this._enqueue(() => this._executeSell({ mint, fraction, reason: 'manual' }).then(resolve, reject));
    });
  }

  manualBuy(mint, sol) {
    sol = Number(sol);
    if (!(sol > 0)) throw httpError(400, 'Enter an amount of SOL');
    try { new PublicKey(mint); } catch { throw httpError(400, 'Invalid token address'); }
    return new Promise((resolve, reject) => {
      this._enqueue(async () => {
        const tok = await this.jup.token(mint);
        return this._executeBuy({ mint, tok, sol, target: null, sourceSig: null, throwOnError: true }).then(resolve, reject);
      });
    });
  }

  async _riskCheck() {
    const { takeProfitPct: tp, stopLossPct: sl, trailingStopPct: tr } = this.settings;
    // Exit protections stay on even while copying is paused.
    if (!(tp > 0 || sl > 0 || tr > 0)) return;
    const list = await this.positionsView();
    let peaksMoved = false;
    for (const p of list) {
      const pos = this.positions[p.mint];
      if (!pos || p.valueSol == null || this.exiting.has(p.mint)) continue;
      let why = null;
      if (tr > 0) {
        // Trailing stop: remember the best value the position reached and exit if it falls tr% below it.
        const peak = Math.max(pos.peakSol || pos.costSol, p.valueSol);
        if (peak !== pos.peakSol) { pos.peakSol = peak; peaksMoved = true; }
        if (p.valueSol <= peak * (1 - tr / 100)) why = `trailing stop (-${tr}% from its best of ${fmt(peak)} SOL)`;
      }
      if (!why && p.pnlPct != null && tp > 0 && p.pnlPct >= tp) why = `take-profit +${tp}%`;
      if (!why && p.pnlPct != null && sl > 0 && p.pnlPct <= -sl) why = `stop-loss -${sl}%`;
      if (!why) continue;
      this.exiting.add(p.mint);
      this._log('warn', `$${p.symbol} hit ${why} — selling`);
      this._enqueue(() => this._executeSell({ mint: p.mint, fraction: 1, reason: why }).catch(() => {}).finally(() => this.exiting.delete(p.mint)));
    }
    if (peaksMoved) this.store.save();
  }

  _recordTrade(t) {
    const rec = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      mode: this.mode,
      side: t.side,
      status: t.status,
      reason: t.reason || null,
      mint: t.mint,
      symbol: t.token?.symbol,
      icon: t.token?.icon,
      sol: t.sol ?? null,
      tokenAmount: t.tokenAmount ?? null,
      pnlSol: t.pnlSol ?? null,
      txSig: t.txSig || null,
      sourceSig: t.sourceSig || null,
      route: t.route || null,
      targetId: t.target?.id || null,
      targetName: t.target?.name || (t.reason === 'manual' ? 'Manual' : t.reason || null),
      targetAvatar: t.target?.avatar || null,
    };
    this.s.trades.unshift(rec);
    if (this.s.trades.length > 1500) this.s.trades.length = 1500;
    this.store.save();
    this.emit('event', { type: 'trade', trade: rec });
  }

  // ---------- views ----------
  async positionsView() {
    const list = Object.values(this.positions);
    if (!list.length) return [];
    const prices = await this.jup.prices([SOL_MINT, ...list.map((p) => p.mint)]);
    const solUsd = prices[SOL_MINT] || 0;
    return list.map((p) => {
      const amount = Number(p.amountRaw) / 10 ** p.decimals;
      const px = prices[p.mint];
      const valueUsd = px != null ? amount * px : null;
      const valueSol = valueUsd != null && solUsd ? valueUsd / solUsd : null;
      const pnlSol = valueSol != null ? valueSol - p.costSol : null;
      return {
        ...p, amount, priceUsd: px ?? null, valueUsd, valueSol, pnlSol,
        pnlPct: pnlSol != null && p.costSol > 0 ? (pnlSol / p.costSol) * 100 : null,
        targetNames: p.targets.map((id) => this.s.targets.find((t) => t.id === id)?.name).filter(Boolean),
      };
    }).sort((a, b) => (b.valueSol || 0) - (a.valueSol || 0));
  }

  statusView() {
    const today = this._budgetToday();
    const trades = this.s.trades.filter((t) => t.mode === this.mode && t.status === 'success');
    return {
      app: 'fomo-tradingbot',
      version: VERSION,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      mode: this.mode,
      running: this.settings.running,
      wallet: this.s.wallet ? { publicKey: this.s.wallet.publicKey, unlocked: !!this.keypair } : null,
      solBalance: this.mode === 'live' ? this.status.solBalance : this.s.paper.sol,
      liveSolBalance: this.status.solBalance,
      paperSol: this.s.paper.sol,
      rpcOk: this.status.rpcOk,
      lastPollAt: this.status.lastPollAt,
      lastError: this.status.lastError,
      targets: this.s.targets.length,
      activeTargets: this.s.targets.filter((t) => t.enabled).length,
      openPositions: Object.keys(this.positions).length,
      realizedSol: this.s.realized[this.mode],
      spentToday: today.sol,
      tradesToday: trades.filter((t) => t.ts > startOfDay()).length,
      totalTrades: trades.length,
    };
  }

  targetsView() {
    return this.s.targets.map((t) => ({ ...t, watching: this.subs.has(t.id) }));
  }

  // Recent trades for a wallet plus what else it was doing, so the UI can explain an empty result
  // (e.g. a coin creator's wallet that only receives pump.fun fees and never signs a trade).
  async walletActivity(address, limit = 15) {
    const pk = new PublicKey(address);
    const fast = !/api\.mainnet-beta\.solana\.com/.test(this.settings.rpcUrl);
    const sigs = (await this.connection.getSignaturesForAddress(pk, { limit: fast ? 80 : 40 })).filter((x) => !x.err);
    const txs = await this.discover._txs(sigs.map((s) => s.signature));
    const stats = summarize(address, txs, sigs);
    this.discover.statsCache.set(address, { at: Date.now(), v: stats });
    const toks = await this.jup.tokens((stats.perCoin || []).map((c) => c.mint));
    stats.perCoin = (stats.perCoin || []).map((c, i) => ({ ...c, symbol: toks[i].symbol, name: toks[i].name, icon: toks[i].icon }));
    const out = [];
    for (let j = 0; j < txs.length && out.length < limit; j++) {
      const swap = parseSwap(txs[j], address, sigs[j].signature);
      if (!swap) continue;
      for (const leg of swap.legs) {
        const tok = await this.jup.token(leg.mint);
        out.push({
          signature: sigs[j].signature, ts: (sigs[j].blockTime || 0) * 1000, side: leg.side, mint: leg.mint, symbol: tok.symbol,
          name: tok.name, icon: tok.icon, tokenAmount: Math.abs(Number(leg.deltaRaw)) / 10 ** leg.decimals,
          sol: Math.abs(swap.solDelta), usd: Math.abs(swap.stableDelta),
        });
      }
    }
    return {
      trades: out.slice(0, limit), scanned: stats.scanned, signed: stats.signed, stats,
      oldest: sigs.length ? (sigs[sigs.length - 1].blockTime || 0) * 1000 : null,
    };
  }

  async testRpc(url) {
    const c = new Connection(String(url || '').trim(), 'confirmed');
    const t0 = Date.now();
    await c.getSlot();
    return { ok: true, ms: Date.now() - t0 };
  }
}

function applyTargetPatch(t, p) {
  const num = (v) => (v === null || v === '' || v === undefined ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
  if ('enabled' in p) t.enabled = !!p.enabled;
  if ('copyBuys' in p) t.copyBuys = !!p.copyBuys;
  if ('copySells' in p) t.copySells = !!p.copySells;
  if (p.sizing === 'fixed' || p.sizing === 'ratio') t.sizing = p.sizing;
  if (p.mode === 'copy' || p.mode === 'inverse') t.mode = p.mode;
  if (!t.mode) t.mode = 'copy';
  for (const k of ['fixedSol', 'ratio', 'maxSol']) if (k in p && num(p[k]) !== undefined) t[k] = num(p[k]);
  if (t.ratio == null) t.ratio = DEFAULT_TARGET.ratio;
  for (const k of ['name', 'handle', 'avatar', 'fomoUserId']) if (p[k]) t[k] = String(p[k]);
}

function startOfDay() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function short(a) { return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : ''; }
function fmt(n) { return Number(n).toFixed(Math.abs(n) >= 1 ? 3 : 4).replace(/\.?0+$/, '') || '0'; }
function fmtAmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(n >= 1 ? 2 : 6);
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = { Engine, VERSION, DEFAULT_SETTINGS, httpError };
