'use strict';
// Secrets at rest (machine-local key file) and in transit (key derived from the access token).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadMachineKey(dataDir) {
  const f = path.join(dataDir, '.key');
  try {
    const k = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    if (k.length === 32) return k;
  } catch { /* create */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 });
  return k;
}

function seal(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function open(key, sealed) {
  const buf = Buffer.from(sealed, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

function transportKey(token) {
  return crypto.createHash('sha256').update('fomo-tradingbot/transport/' + token).digest();
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { loadMachineKey, seal, open, transportKey, randomToken, safeEqual };
