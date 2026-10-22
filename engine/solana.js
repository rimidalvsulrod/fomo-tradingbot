'use strict';
// Solana helpers: keypairs, balances, and turning a parsed transaction into a buy/sell signal.
const { Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
const { SOL_MINT, USDC_MINT, USDT_MINT } = require('./jupiter');

const STABLES = new Set([USDC_MINT, USDT_MINT]);

function keypairFromSecret(secret) {
  const s = String(secret || '').trim();
  let bytes;
  if (s.startsWith('[')) bytes = Uint8Array.from(JSON.parse(s));
  else bytes = bs58.decode(s);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error('Private key must be a base58 string or a JSON byte array (64 bytes).');
}

function isAddress(s) {
  try {
    const pk = new PublicKey(String(s).trim());
    return PublicKey.isOnCurve(pk.toBytes()) || String(s).trim().length >= 32;
  } catch {
    return false;
  }
}

async function tokenBalanceRaw(connection, owner, mint) {
  const res = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
  let total = 0n;
  let decimals = null;
  for (const a of res.value) {
    const amt = a.account.data.parsed?.info?.tokenAmount;
    if (!amt) continue;
    total += BigInt(amt.amount);
    decimals = amt.decimals;
  }
  return { raw: total, decimals };
}

function keyStr(k) {
  const v = k && k.pubkey !== undefined ? k.pubkey : k;
  return typeof v === 'string' ? v : v.toBase58();
}

// Raw JSON-RPC fetch: web3.js v1 rejects newer transaction versions, so skip its response validation.
async function getParsedTx(connection, signature) {
  const res = await connection._rpcRequest('getTransaction', [
    signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 },
  ]);
  if (res.error) throw new Error(res.error.message);
  return res.result;
}

// Returns null if the tx is not a swap by `owner`, else
// { signature, blockTime, legs: [{ side:'buy'|'sell', mint, decimals, deltaRaw, preRaw, fraction }],
//   solDelta (SOL, + = received), stableDelta (USD, + = received) }
function parseSwap(tx, owner, signature) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map(keyStr);
  const idx = keys.indexOf(owner);

  let lamports = 0;
  if (idx >= 0) {
    lamports = tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
    if (idx === 0) lamports += tx.meta.fee; // network fee isn't part of the trade
  }

  const tokens = new Map();
  const add = (list, key) => {
    for (const b of list || []) {
      if (b.owner !== owner) continue;
      const cur = tokens.get(b.mint) || { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals };
      cur[key] += BigInt(b.uiTokenAmount.amount);
      tokens.set(b.mint, cur);
    }
  };
  add(tx.meta.preTokenBalances, 'pre');
  add(tx.meta.postTokenBalances, 'post');

  let solDelta = lamports / 1e9;
  let stableDelta = 0;
  const legs = [];
  for (const [mint, b] of tokens) {
    const d = b.post - b.pre;
    if (d === 0n) continue;
    if (mint === SOL_MINT) { solDelta += Number(d) / 1e9; continue; }
    if (STABLES.has(mint)) { stableDelta += Number(d) / 10 ** b.decimals; continue; }
    legs.push({
      side: d > 0n ? 'buy' : 'sell',
      mint,
      decimals: b.decimals,
      deltaRaw: d,
      preRaw: b.pre,
      fraction: d < 0n && b.pre > 0n ? Number((-d * 10000n) / b.pre) / 10000 : 0,
    });
  }
  if (!legs.length) return null;

  const quoteIn = solDelta > 0.000001 || stableDelta > 0.0001;
  const quoteOut = solDelta < -0.000001 || stableDelta < -0.0001;
  const buys = legs.filter((l) => l.side === 'buy');
  const sells = legs.filter((l) => l.side === 'sell');
  // Token in with nothing paid (airdrop/transfer) or token out with nothing received (transfer) is not a trade,
  // unless it is a token-for-token swap.
  const tokenSwap = buys.length > 0 && sells.length > 0;
  if (!tokenSwap) {
    if (buys.length && !quoteOut) return null;
    if (sells.length && !quoteIn) return null;
  }
  return { signature, blockTime: tx.blockTime, legs, solDelta, stableDelta };
}

module.exports = { keypairFromSecret, isAddress, tokenBalanceRaw, parseSwap, getParsedTx, keyStr, bs58 };
