'use strict';
// HTTP + WebSocket API in front of the engine, plus LAN discovery and PIN pairing.
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const secure = require('./secure');

const DISCOVERY_PORT = 47421;
const DISCOVERY_MAGIC = 'FOMOBOT_DISCOVER_V1';

function startApi(engine, { host = '0.0.0.0', port = 7420, token, name = os.hostname(), pairing = true, discovery = true } = {}) {
  const failures = new Map();
  let pin = newPin();
  let pinRotateTimer = null;
  if (pairing) pinRotateTimer = setInterval(() => { pin = newPin(); engine.emit('pin', pin); }, 10 * 60e3);

  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth });
  };

  route('GET', '/api/ping', () => ({ app: 'fomo-tradingbot', version: engine.statusView().version, name }), { auth: false });
  route('POST', '/api/pair', ({ body, ip }) => {
    if (!pairing) throw err(403, 'Pairing is disabled on this server');
    if (String(body.pin || '').replace(/\D/g, '') !== pin) { fail(ip); throw err(401, 'Wrong pairing code'); }
    engine._log('success', `Paired a new device (${ip})`);
    pin = newPin();
    engine.emit('pin', pin);
    return { token, name };
  }, { auth: false });

  route('GET', '/api/status', () => engine.statusView());
  route('GET', '/api/settings', () => publicSettings(engine.settings));
  route('PUT', '/api/settings', ({ body }) => publicSettings(engine.updateSettings(body)));
  route('POST', '/api/bot/start', () => { engine.setRunning(true); return engine.statusView(); });
  route('POST', '/api/bot/stop', () => { engine.setRunning(false); return engine.statusView(); });
  route('POST', '/api/paper/reset', () => { engine.resetPaper(); return engine.statusView(); });

  route('POST', '/api/wallet/import', ({ body }) => {
    const secret = body.enc ? secure.open(secure.transportKey(token), body.enc) : body.secret;
    if (!secret) throw err(400, 'Missing private key');
    try { return { publicKey: engine.importWallet(secret) }; } catch (e) { throw err(400, e.message); }
  });
  route('POST', '/api/wallet/generate', () => {
    const w = engine.generateWallet();
    return { publicKey: w.publicKey, enc: secure.seal(secure.transportKey(token), w.secret) };
  });
  route('DELETE', '/api/wallet', () => { engine.removeWallet(); return { ok: true }; });

  route('GET', '/api/targets', () => engine.targetsView());
  route('POST', '/api/targets', ({ body }) => engine.addTarget(body));
  route('PUT', '/api/targets/:id', ({ params, body }) => engine.updateTarget(params.id, body));
  route('DELETE', '/api/targets/:id', ({ params }) => { engine.removeTarget(params.id); return { ok: true }; });

  route('GET', '/api/positions', () => engine.positionsView());
  route('POST', '/api/positions/:mint/sell', ({ params, body }) => engine.manualSell(params.mint, body.percent ?? 100));
  route('POST', '/api/buy', ({ body }) => engine.manualBuy(body.mint, body.sol));

  route('GET', '/api/trades', ({ query }) => {
    const limit = Math.min(500, Number(query.get('limit')) || 200);
    const mode = query.get('mode') || engine.mode;
    return engine.s.trades.filter((t) => mode === 'all' || t.mode === mode).slice(0, limit);
  });
  route('GET', '/api/logs', () => engine.logs.slice(-300));
  route('GET', '/api/token/:mint', ({ params }) => engine.jup.token(params.mint));
  route('GET', '/api/wallet-activity/:address', ({ params, query }) => engine.walletActivity(params.address, Number(query.get('limit')) || 15));
  route('POST', '/api/rpc/test', async ({ body }) => {
    try { return await engine.testRpc(body.url); } catch (e) { throw err(400, `That RPC URL didn't work: ${e.message}`); }
  });

  function fail(ip) {
    const f = failures.get(ip) || { n: 0, at: Date.now() };
    if (Date.now() - f.at > 60e3) { f.n = 0; f.at = Date.now(); }
    f.n++;
    failures.set(ip, f);
  }
  function blocked(ip) {
    const f = failures.get(ip);
    return f && Date.now() - f.at < 60e3 && f.n >= 8;
  }
  function authorized(req, url) {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
    return t && secure.safeEqual(t, token);
  }

  const server = http.createServer(async (req, res) => {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return send(res, 204);
    const url = new URL(req.url, 'http://x');
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) return send(res, 404, { error: 'Not found' });
    if (blocked(ip)) return send(res, 429, { error: 'Too many attempts, wait a minute' });
    if (r.auth && !authorized(req, url)) { fail(ip); return send(res, 401, { error: 'Unauthorized — check the access token' }); }
    try {
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
      const out = await r.handler({ params, body, query: url.searchParams, ip });
      send(res, 200, out);
    } catch (e) {
      send(res, e.status || 500, { error: e.message || 'Server error' });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws' || !authorized(req, url)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.send(JSON.stringify({ type: 'hello', status: engine.statusView() }));
    });
  });
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 25000);
  const onEvent = (ev) => {
    const msg = JSON.stringify(ev.type === 'status' ? { ...ev, status: engine.statusView() } : ev);
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
  };
  engine.on('event', onEvent);

  let udp = null;
  if (discovery) {
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('message', (msg, rinfo) => {
      if (msg.toString() !== DISCOVERY_MAGIC) return;
      const reply = Buffer.from(JSON.stringify({ app: 'fomo-tradingbot', name, port: server.address().port, version: engine.statusView().version }));
      udp.send(reply, rinfo.port, rinfo.address);
    });
    udp.on('error', () => {});
    udp.bind(DISCOVERY_PORT);
  }

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });

  return {
    ready,
    server,
    get pin() { return pin; },
    newPin() { pin = newPin(); engine.emit('pin', pin); return pin; },
    close() {
      clearInterval(ping);
      clearInterval(pinRotateTimer);
      engine.off('event', onEvent);
      for (const ws of wss.clients) ws.terminate();
      if (udp) try { udp.close(); } catch { /* closed */ }
      return new Promise((r) => server.close(() => r()));
    },
  };
}

function publicSettings(s) {
  return { ...s, jupiterApiKey: s.jupiterApiKey ? '•••• set' : '' };
}

function newPin() {
  return String(crypto.randomInt(0, 1e6)).padStart(6, '0');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(err(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(err(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  if (status === 204) { res.writeHead(204); return res.end(); }
  const data = JSON.stringify(body ?? null, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

function err(status, message) { const e = new Error(message); e.status = status; return e; }

function lanAddresses() {
  const out = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) out.push({ ifname, address: a.address });
    }
  }
  return out;
}

module.exports = { startApi, lanAddresses, DISCOVERY_PORT, DISCOVERY_MAGIC };
