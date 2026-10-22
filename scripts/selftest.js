'use strict';
// End-to-end check against mainnet: API auth, swap parsing on real transactions, paper buy/sell.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const { Engine, startApi } = require('../engine');
const { parseSwap, getParsedTx, keyStr } = require('../engine/solana');

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failed++;
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fomobot-test-'));
  const engine = new Engine({ dataDir: dir });
  const token = 'test-token';
  const api = startApi(engine, { host: '127.0.0.1', port: 0, token, discovery: false });
  const port = await api.ready;
  engine.start();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, tok = token) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  ok('ping without auth', (await fetch(base + '/api/ping').then((r) => r.json())).app === 'fomo-tradingbot');
  ok('status rejects bad token', (await call('GET', '/api/status', null, 'nope')).status === 401);
  const st = await call('GET', '/api/status');
  ok('status with token', st.status === 200 && st.json.mode === 'paper');
  ok('pair with wrong pin rejected', (await call('POST', '/api/pair', { pin: '000000x' })).status === 401);
  const paired = await call('POST', '/api/pair', { pin: api.pin });
  ok('pair with correct pin returns token', paired.json && paired.json.token === token);

  // Real swaps: pull recent pump AMM transactions and parse them from the fee payer's point of view.
  const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const sigs = await conn.getSignaturesForAddress(new PublicKey(PUMP_AMM), { limit: 12 });
  let parsed = 0;
  let sample = null;
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await getParsedTx(conn, s.signature).catch(() => null);
    if (!tx) continue;
    const payer = keyStr(tx.transaction.message.accountKeys[0]);
    const sw = parseSwap(tx, payer, s.signature);
    if (sw) {
      parsed++;
      if (!sample && sw.legs.length === 1 && sw.legs[0].side === 'buy') sample = { sw, payer };
      const leg = sw.legs[0];
      if (parsed <= 3) console.log(`      ${leg.side.toUpperCase()} ${leg.mint.slice(0, 6)}… sol Δ ${sw.solDelta.toFixed(4)} ${leg.side === 'sell' ? `(${Math.round(leg.fraction * 100)}% of bag)` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  ok('parses real mainnet swaps', parsed > 0, `${parsed} swaps detected in ${sigs.length} txs`);

  // Full copy pipeline on a real buy signal (paper mode).
  if (sample) {
    const t = engine.addTarget({ address: sample.payer, name: 'Signal test', fixedSol: 0.05 });
    engine.settings.minSourceTradeSol = 0;
    await engine._handleSignal(t, sample.sw, 1);
    const p = (await engine.positionsView()).find((x) => x.mint === sample.sw.legs[0].mint);
    const last = engine.s.trades[0];
    ok('copies a real buy signal', !!p, p ? `bought ${p.amount.toFixed(2)} ${p.symbol}` : `${last && last.status}: ${last && last.reason}`);
    engine.removeTarget(t.id);
  }

  // Targets
  const add = await call('POST', '/api/targets', { address: payerOf(sigs) || '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', name: 'Test trader', sizing: 'fixed', fixedSol: 0.1 });
  ok('add target', add.status === 200 && add.json.id, add.json && add.json.error);
  ok('reject bad address', (await call('POST', '/api/targets', { address: 'not-an-address' })).status === 400);
  const upd = await call('PUT', `/api/targets/${add.json.id}`, { sizing: 'ratio', ratio: 0.25, copySells: false });
  ok('update target', upd.json.sizing === 'ratio' && upd.json.ratio === 0.25 && upd.json.copySells === false);

  // Paper trading through Jupiter quotes
  const buy = await call('POST', '/api/buy', { mint: BONK, sol: 0.2 });
  ok('paper buy request', buy.status === 200, buy.json && buy.json.error);
  const pos = await call('GET', '/api/positions');
  const bonk = (pos.json || []).find((p) => p.mint === BONK);
  ok('paper position opened', !!bonk && bonk.amount > 0, bonk ? `${Math.round(bonk.amount)} ${bonk.symbol}, value ${bonk.valueSol?.toFixed(4)} SOL` : '');
  const sell = await call('POST', `/api/positions/${BONK}/sell`, { percent: 50 });
  ok('paper sell 50%', sell.status === 200 && sell.json.solOut > 0, sell.json && (sell.json.error || `got ${sell.json.solOut?.toFixed(4)} SOL`));
  const pos2 = await call('GET', '/api/positions');
  const bonk2 = (pos2.json || []).find((p) => p.mint === BONK);
  ok('position halved', bonk2 && Math.abs(bonk2.amount / bonk.amount - 0.5) < 0.01);
  const trades = await call('GET', '/api/trades');
  ok('trades recorded', trades.json.filter((t) => t.status === 'success' && t.mint === BONK).length === 2);
  const st2 = await call('GET', '/api/status');
  ok('paper balance moved', st2.json.solBalance < 10 && st2.json.solBalance > 9.7, `${st2.json.solBalance.toFixed(4)} SOL`);

  ok('live mode needs wallet', (await call('PUT', '/api/settings', { mode: 'live' })).status === 400);
  const gen = await call('POST', '/api/wallet/generate');
  ok('generate wallet', gen.status === 200 && gen.json.publicKey && gen.json.enc);
  const reload = new Engine({ dataDir: dir });
  ok('wallet survives restart (encrypted at rest)', reload.keypair && reload.keypair.publicKey.toBase58() === gen.json.publicKey);
  ok('no plaintext key on disk', !fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes('secretKey'));
  reload.stop();

  const del = await call('DELETE', `/api/targets/${add.json.id}`);
  ok('remove target', del.status === 200);

  engine.stop();
  await api.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function payerOf() { return null; }
