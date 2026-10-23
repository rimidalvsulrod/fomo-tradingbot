'use strict';
// Jupiter: token info, prices, quotes, and swap execution (Ultra first, Metis swap API as fallback).
const { VersionedTransaction } = require('@solana/web3.js');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

class Jupiter {
  constructor(getSettings, log) {
    this.getSettings = getSettings;
    this.log = log;
    this.tokenCache = new Map();
    this.priceCache = new Map();
    this.gate = Promise.resolve();
  }

  // Spaces requests out so the free tier's rate limit isn't tripped.
  _slot() {
    // Free tier allows ~1 request/second; a (free) API key raises that a lot.
    const gap = this.getSettings().jupiterApiKey ? 120 : 1050;
    const p = this.gate.then(() => sleep(gap));
    this.gate = p;
    return this.gate;
  }

  get base() {
    return this.getSettings().jupiterApiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
  }

  async _fetch(pathname, opts = {}, attempt = 0) {
    const headers = { accept: 'application/json', ...(opts.headers || {}) };
    const key = this.getSettings().jupiterApiKey;
    if (key) headers['x-api-key'] = key;
    if (opts.body) headers['content-type'] = 'application/json';
    await this._slot();
    let res;
    try {
      res = await fetchWithTimeout(this.base + pathname, { ...opts, headers }, opts.timeout || 20000);
    } catch (e) {
      // Timeouts and dropped connections happen now and then; a retry almost always goes through.
      // Re-sending the same signed transaction to /execute is safe: it can only land once.
      if (attempt < 2) { await sleep(400 * (attempt + 1)); return this._fetch(pathname, opts, attempt + 1); }
      throw new Error(e.name === 'AbortError' ? 'Jupiter did not respond in time' : `can't reach Jupiter (${e.cause?.code || e.message})`);
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; }
    if (res.status === 429 && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return this._fetch(pathname, opts, attempt + 1);
    }
    if (!res.ok) {
      const err = new Error(json.error || json.errorMessage || `Jupiter HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async token(mint) {
    const hit = this.tokenCache.get(mint);
    if (hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
    let v = null;
    try {
      const list = await this._fetch(`/tokens/v2/search?query=${mint}`);
      const t = Array.isArray(list) ? list.find((x) => x.id === mint) || list[0] : null;
      if (t) {
        v = {
          mint: t.id, symbol: t.symbol, name: t.name, icon: t.icon, decimals: t.decimals,
          usdPrice: t.usdPrice, mcap: t.mcap, liquidity: t.liquidity, verified: !!t.isVerified,
        };
      }
    } catch (e) {
      this.log.debug(`token lookup failed for ${mint}: ${e.message}`);
    }
    if (!v) v = { mint, symbol: mint.slice(0, 4) + '…', name: 'Unknown token', icon: null, decimals: null };
    this.tokenCache.set(mint, { at: Date.now(), v });
    return v;
  }

  // Token info for many mints in one request (fills the same cache as token()).
  async tokens(mints) {
    const need = [...new Set(mints)].filter((m) => !this.tokenCache.has(m));
    for (let i = 0; i < need.length; i += 50) {
      try {
        const list = await this._fetch(`/tokens/v2/search?query=${need.slice(i, i + 50).join(',')}`);
        for (const t of Array.isArray(list) ? list : []) {
          this.tokenCache.set(t.id, { at: Date.now(), v: { mint: t.id, symbol: t.symbol, name: t.name, icon: t.icon, decimals: t.decimals, usdPrice: t.usdPrice, mcap: t.mcap, liquidity: t.liquidity, verified: !!t.isVerified } });
        }
      } catch (e) { this.log.debug(`batch token lookup failed: ${e.message}`); }
    }
    return Promise.all(mints.map((m) => this.token(m)));
  }

  async prices(mints) {
    const out = {};
    const need = [];
    for (const m of new Set(mints)) {
      const hit = this.priceCache.get(m);
      if (hit && Date.now() - hit.at < 6e3) out[m] = hit.v;
      else need.push(m);
    }
    for (let i = 0; i < need.length; i += 50) {
      const chunk = need.slice(i, i + 50);
      try {
        const res = await this._fetch(`/price/v3?ids=${chunk.join(',')}`);
        for (const m of chunk) {
          const p = res[m]?.usdPrice ?? null;
          out[m] = p;
          this.priceCache.set(m, { at: Date.now(), v: p });
        }
      } catch (e) {
        this.log.debug(`price lookup failed: ${e.message}`);
      }
    }
    return out;
  }

  async solPrice() {
    return (await this.prices([SOL_MINT]))[SOL_MINT] || 0;
  }

  async quote(inputMint, outputMint, amount) {
    const s = this.getSettings();
    const q = new URLSearchParams({
      inputMint, outputMint, amount: String(amount), slippageBps: String(s.slippageBps), restrictIntermediateTokens: 'true',
    });
    return this._fetch(`/swap/v1/quote?${q}`);
  }

  // Executes a swap for `keypair`. Returns { signature, inAmount, outAmount, route }.
  async swap({ keypair, connection, inputMint, outputMint, amount }) {
    const s = this.getSettings();
    if (s.router !== 'metis') {
      try {
        return await this._ultraSwap({ keypair, inputMint, outputMint, amount });
      } catch (e) {
        if (e.fatal) throw e;
        this.log.warn(`Ultra route failed (${e.message}); retrying via Jupiter swap API`);
      }
    }
    return this._metisSwap({ keypair, connection, inputMint, outputMint, amount });
  }

  async _ultraSwap({ keypair, inputMint, outputMint, amount }) {
    const q = new URLSearchParams({ inputMint, outputMint, amount: String(amount), taker: keypair.publicKey.toBase58() });
    const order = await this._fetch(`/ultra/v1/order?${q}`);
    if (!order.transaction) throw new Error(order.errorMessage || order.error || 'no route');
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    tx.sign([keypair]);
    const res = await this._fetch('/ultra/v1/execute', {
      method: 'POST',
      timeout: 60000,
      body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString('base64'), requestId: order.requestId }),
    });
    if (res.status !== 'Success') {
      const err = new Error(res.error || `swap failed (code ${res.code})`);
      // Landed-but-failed transactions must not be retried through another route.
      err.fatal = !!res.signature;
      err.signature = res.signature;
      throw err;
    }
    return {
      signature: res.signature,
      inAmount: String(res.inputAmountResult ?? res.totalInputAmount ?? order.inAmount),
      outAmount: String(res.outputAmountResult ?? res.totalOutputAmount ?? order.outAmount),
      route: 'ultra',
    };
  }

  async _metisSwap({ keypair, connection, inputMint, outputMint, amount }) {
    const s = this.getSettings();
    const quote = await this.quote(inputMint, outputMint, amount);
    const swap = await this._fetch('/swap/v1/swap', {
      method: 'POST',
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: { maxLamports: Math.round(s.maxPriorityFeeSol * 1e9), priorityLevel: 'veryHigh' },
        },
      }),
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    tx.sign([keypair]);
    const raw = tx.serialize();
    const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 2 });
    const ok = await confirm(connection, signature, raw, swap.lastValidBlockHeight);
    if (!ok.success) {
      const err = new Error(ok.error || 'transaction failed');
      err.fatal = true;
      err.signature = signature;
      throw err;
    }
    return { signature, inAmount: quote.inAmount, outAmount: quote.outAmount, route: 'metis' };
  }
}

async function confirm(connection, signature, raw, lastValidBlockHeight) {
  const started = Date.now();
  while (Date.now() - started < 75000) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const st = value[0];
    if (st) {
      if (st.err) return { success: false, error: 'on-chain error: ' + JSON.stringify(st.err) };
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { success: true };
    }
    if (lastValidBlockHeight) {
      const h = await connection.getBlockHeight('confirmed').catch(() => 0);
      if (h > lastValidBlockHeight) return { success: false, error: 'transaction expired' };
    }
    connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await sleep(2000);
  }
  return { success: false, error: 'confirmation timeout' };
}

async function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { Jupiter, SOL_MINT, USDC_MINT, USDT_MINT, fetchWithTimeout, sleep };
