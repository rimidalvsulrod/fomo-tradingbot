'use strict';
// Trader discovery for pump.fun coins, built from public data only: Jupiter's token lists for
// trending/new coins, and on-chain transactions for who traded them and how well they did.
const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const { getParsedTx, keyStr, parseSwap } = require('./solana');
const { sleep } = require('./jupiter');

const LISTS = { toptraded: 'toptraded/1h', toptrending: 'toptrending/1h', recent: 'recent' };

class Discover {
  constructor(engine) {
    this.engine = engine;
    this.file = path.join(engine.dataDir, 'leaderboard.json');
    this.listCache = new Map();
    this.statsCache = new Map();
    this.board = { status: 'idle', startedAt: null, finishedAt: null, progress: { done: 0, total: 0, step: '' }, coins: [], rows: [] };
    try { Object.assign(this.board, JSON.parse(fs.readFileSync(this.file, 'utf8')), { status: 'idle' }); } catch { /* first run */ }
    // With a fast RPC, keep the leaderboard fresh in the background (the free one is too slow for that).
    this.autoTimer = setInterval(() => { if (this.fast && this.board.status !== 'scanning') this.scan(); }, 45 * 60e3);
    if (this.autoTimer.unref) this.autoTimer.unref();
  }

  // Is this address a wallet or a coin (token mint)?
  async kind(address) {
    const info = await this.conn.getAccountInfo(new PublicKey(address));
    if (!info) return 'wallet';
    const owner = info.owner.toBase58();
    return owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || owner === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? 'coin' : 'wallet';
  }

  get conn() { return this.engine.connection; }
  get fast() { return !/api\.mainnet-beta\.solana\.com/.test(this.engine.settings.rpcUrl); }

  // Fetches transactions in small paced batches; the free public RPC rate-limits bigger bursts.
  async _txs(signatures) {
    const step = this.fast ? 8 : 2;
    const out = [];
    for (let i = 0; i < signatures.length; i += step) {
      if (i && !this.fast) await sleep(250);
      const batch = signatures.slice(i, i + step);
      out.push(...(await Promise.all(batch.map((s) => getParsedTx(this.conn, s).catch(() => null)))));
    }
    return out;
  }

  async coins(list = 'toptraded') {
    const key = LISTS[list] ? list : 'toptraded';
    const hit = this.listCache.get(key);
    if (hit && Date.now() - hit.at < 60e3) return hit.v;
    const raw = await this.engine.jup._fetch(`/tokens/v2/${LISTS[key]}?limit=100`);
    const v = (Array.isArray(raw) ? raw : []).filter((t) => t.launchpad === 'pump.fun' || /pump$/.test(t.id)).map((t) => ({
      mint: t.id,
      symbol: t.symbol,
      name: t.name,
      icon: t.icon,
      mcap: t.mcap ?? null,
      usdPrice: t.usdPrice ?? null,
      liquidity: t.liquidity ?? null,
      holders: t.holderCount ?? null,
      change1h: t.stats1h?.priceChange ?? null,
      volume1h: (t.stats1h?.buyVolume || 0) + (t.stats1h?.sellVolume || 0),
      traders1h: t.stats1h?.numTraders ?? null,
      createdAt: t.createdAt ? Date.parse(t.createdAt) : null,
      graduated: !!t.graduatedPool,
      twitter: t.twitter || null,
    }));
    // Fresh-launch lists are full of copy-paste spam; keep one of each and only coins with a price.
    const seen = new Set();
    const clean = v.filter((c) => {
      const k = `${(c.symbol || '').toLowerCase()}|${(c.name || '').toLowerCase()}`;
      if (seen.has(k) || c.mcap == null) return false;
      seen.add(k);
      return true;
    });
    v.length = 0;
    v.push(...clean);
    this.listCache.set(key, { at: Date.now(), v });
    return v;
  }

  // Recent traders of one coin, grouped by wallet.
  async coinTraders(mint, maxTx = 40) {
    new PublicKey(mint);
    const sigs = (await this.conn.getSignaturesForAddress(new PublicKey(mint), { limit: maxTx })).filter((s) => !s.err);
    const txs = await this._txs(sigs.map((s) => s.signature));
    const byWallet = new Map();
    txs.forEach((tx, i) => {
      if (!tx) return;
      const signers = tx.transaction.message.accountKeys.filter((k) => k.signer).map(keyStr);
      for (const w of signers) {
        const sw = parseSwap(tx, w, sigs[i].signature);
        const leg = sw && sw.legs.find((l) => l.mint === mint);
        if (!leg) continue;
        const r = byWallet.get(w) || { address: w, buys: 0, sells: 0, boughtSol: 0, soldSol: 0, lastTs: 0 };
        if (leg.side === 'buy') { r.buys++; r.boughtSol += Math.max(0, -sw.solDelta); } else { r.sells++; r.soldSol += Math.max(0, sw.solDelta); }
        r.lastTs = Math.max(r.lastTs, (sigs[i].blockTime || 0) * 1000);
        byWallet.set(w, r);
        break;
      }
    });
    return [...byWallet.values()].sort((a, b) => (b.boughtSol + b.soldSol) - (a.boughtSol + a.soldSol));
  }

  // Win rate and profit from a wallet's recent trades. A coin counts as a finished trade once the wallet
  // sold at least 90% of what it bought inside the window; it's a win if it got back more SOL than it spent.
  async walletStats(address, maxTx = 60) {
    const hit = this.statsCache.get(address);
    if (hit && Date.now() - hit.at < 20 * 60e3) return hit.v;
    const sigs = (await this.conn.getSignaturesForAddress(new PublicKey(address), { limit: maxTx })).filter((s) => !s.err);
    const txs = await this._txs(sigs.map((s) => s.signature));
    const v = summarize(address, txs, sigs);
    this.statsCache.set(address, { at: Date.now(), v });
    return v;
  }

  leaderboard() { return this.board; }

  scan() {
    if (this.board.status === 'scanning') return this.board;
    const big = this.fast;
    const plan = { coins: big ? 6 : 3, txPerCoin: big ? 40 : 25, wallets: big ? 30 : 12, txPerWallet: big ? 60 : 35 };
    this.board = { ...this.board, status: 'scanning', startedAt: Date.now(), plan, progress: { done: 0, total: plan.coins + plan.wallets, step: 'Finding hot pump.fun coins…' } };
    this._runScan(plan).catch((e) => {
      this.board.status = 'error';
      this.board.error = e.message;
      this.engine.emit('event', { type: 'leaderboard' });
    });
    return this.board;
  }

  async _runScan(plan) {
    const tick = (step) => { this.board.progress.done++; if (step) this.board.progress.step = step; this.engine.emit('event', { type: 'leaderboard' }); };
    const coins = (await this.coins('toptraded')).slice(0, plan.coins);
    this.board.coins = coins.map((c) => ({ mint: c.mint, symbol: c.symbol, icon: c.icon }));
    const candidates = new Map();
    for (const c of coins) {
      this.board.progress.step = `Reading who trades $${c.symbol}…`;
      const traders = await this.coinTraders(c.mint, plan.txPerCoin).catch(() => []);
      for (const t of traders) {
        const r = candidates.get(t.address) || { address: t.address, volume: 0, coins: new Set() };
        r.volume += t.boughtSol + t.soldSol;
        r.coins.add(c.symbol);
        candidates.set(t.address, r);
      }
      tick();
    }
    const picked = [...candidates.values()].filter((c) => c.volume >= 0.05).sort((a, b) => b.volume - a.volume).slice(0, plan.wallets);
    this.board.progress.total = plan.coins + picked.length;
    // Keep earlier results (last 24h) so the board grows with every scan.
    const keep = (this.board.rows || []).filter((r) => r.checkedAt && Date.now() - r.checkedAt < 24 * 3600e3 && !picked.some((p) => p.address === r.address));
    const rows = [...keep];
    for (const c of picked) {
      this.board.progress.step = `Checking ${c.address.slice(0, 4)}…${c.address.slice(-4)}'s track record…`;
      const s = await this.walletStats(c.address, plan.txPerWallet).catch(() => null);
      if (s && s.trades > 0) {
        const { perCoin, ...rest } = s;
        rows.push({ ...rest, seenOn: [...c.coins], checkedAt: Date.now() });
        this.board.rows = [...rows];
      }
      tick();
    }
    this.board.status = 'done';
    this.board.finishedAt = Date.now();
    this.board.progress.step = '';
    try { fs.writeFileSync(this.file, JSON.stringify({ ...this.board, status: 'idle' })); } catch { /* ignore */ }
    this.engine.emit('event', { type: 'leaderboard' });
  }
}

function summarize(address, txs, sigs) {
  const perCoin = new Map();
  let trades = 0;
  let signed = 0;
  let lastTs = 0;
  let firstTs = Infinity;
  txs.forEach((tx, i) => {
    if (!tx) return;
    if (tx.transaction.message.accountKeys.some((k) => keyStr(k) === address && k.signer)) signed++;
    const sw = parseSwap(tx, address, sigs[i].signature);
    if (!sw) return;
    const ts = (sigs[i].blockTime || 0) * 1000;
    for (const leg of sw.legs) {
      const c = perCoin.get(leg.mint) || { mint: leg.mint, bought: 0n, sold: 0n, solIn: 0, solOut: 0 };
      if (leg.side === 'buy') { c.bought += leg.deltaRaw; c.solIn += Math.max(0, -sw.solDelta); } else { c.sold += -leg.deltaRaw; c.solOut += Math.max(0, sw.solDelta); }
      perCoin.set(leg.mint, c);
    }
    trades++;
    lastTs = Math.max(lastTs, ts);
    firstTs = Math.min(firstTs, ts);
  });
  let wins = 0;
  let closed = 0;
  let pnlSol = 0;
  const coinsList = [];
  for (const c of perCoin.values()) {
    const done = c.bought > 0n && c.sold * 10n >= c.bought * 9n;
    coinsList.push({ mint: c.mint, solIn: c.solIn, solOut: c.solOut, pnlSol: c.solOut - c.solIn, closed: done, holding: c.bought > c.sold });
    if (!done) continue;
    closed++;
    const p = c.solOut - c.solIn;
    pnlSol += p;
    if (p > 0) wins++;
  }
  coinsList.sort((a, b) => (b.closed - a.closed) || (b.pnlSol - a.pnlSol));
  return {
    address,
    trades,
    coins: perCoin.size,
    closed,
    wins,
    winRate: closed ? wins / closed : null,
    pnlSol,
    lastTs: lastTs || null,
    firstTs: firstTs === Infinity ? null : firstTs,
    scanned: txs.filter(Boolean).length,
    signed,
    perCoin: coinsList.slice(0, 25),
  };
}

module.exports = { Discover, summarize };
