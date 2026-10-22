'use strict';
// Dev helper: fills a paper-trading engine data dir with real simulated trades (used for screenshots).
// Usage: node scripts/seed-demo.js <engineDataDir>
const { Connection, PublicKey } = require('@solana/web3.js');
const { Engine } = require('../engine');
const { getParsedTx, keyStr, parseSwap } = require('../engine/solana');

const TOKENS = {
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  POPCAT: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
};

(async () => {
  const dir = process.argv[2];
  if (!dir) throw new Error('pass an engine data dir');
  const engine = new Engine({ dataDir: dir });
  const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const sigs = await conn.getSignaturesForAddress(new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'), { limit: 25 });
  const wallets = [];
  for (const s of sigs) {
    if (wallets.length >= 2 || s.err) continue;
    const tx = await getParsedTx(conn, s.signature).catch(() => null);
    if (!tx) continue;
    const payer = keyStr(tx.transaction.message.accountKeys[0]);
    if (parseSwap(tx, payer, s.signature) && !wallets.includes(payer)) wallets.push(payer);
  }
  const names = ['Pump wallet A', 'Pump wallet B'];
  const targets = wallets.map((address, i) => engine.addTarget({ address, name: names[i], fixedSol: i ? undefined : 0.1, sizing: i ? 'ratio' : 'fixed', ratio: 0.2 }));
  const t0 = targets[0] || null;
  for (const [sym, mint] of Object.entries(TOKENS)) {
    const tok = await engine.jup.token(mint);
    await engine._executeBuy({ mint, tok, sol: sym === 'JITOSOL' ? 0.4 : 0.25, target: t0, sourceSig: null });
  }
  await engine._executeSell({ mint: TOKENS.POPCAT, fraction: 0.5, target: t0, reason: 'copy' }).catch(() => {});
  await engine._executeSell({ mint: TOKENS.BONK, fraction: 0.3, target: t0, reason: 'copy' }).catch(() => {});
  engine.store.flush();
  engine.stop();
  console.log('seeded', wallets.length, 'targets');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
