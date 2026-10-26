'use strict';
process.noDeprecation = true;
// AutoPump Server — headless 24/7 copy-trading engine for a spare PC.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, exec } = require('child_process');
const { Engine, startApi, lanAddresses, secure, VERSION, MAINTENANCE } = require('../engine');
const { downloadUpdate, swapAndRestart, cleanupOld } = require('./update');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  blue: '\x1b[38;2;111;133;255m', green: '\x1b[38;2;33;201;94m', red: '\x1b[38;2;255;98;46m',
  yellow: '\x1b[38;2;255;200;87m', gray: '\x1b[38;2;152;153;163m', white: '\x1b[38;2;247;247;247m',
};

const args = parseArgs(process.argv.slice(2));
const isPackaged = isSea();
const exePath = process.execPath;
const dataDir = resolveDataDir();
const cfgFile = path.join(dataDir, 'server.json');
const cfg = loadConfig();

let engine, api, keepAwake;

main().catch((e) => {
  console.error(`${C.red}Fatal: ${e.message}${C.reset}`);
  waitForKeyThenExit(1);
});

async function main() {
  process.stdout.write('\x1b]0;AutoPump Server\x07');
  banner();
  engine = new Engine({ dataDir });
  engine.on('event', (ev) => { if (ev.type === 'log') printLog(ev.entry); });
  engine.on('pin', () => printPairing());

  api = await startApiWithRetry();
  engine.start();
  if (MAINTENANCE) {
    // Maintenance: stop launching with Windows and don't hold the PC awake.
    try { if (startupEnabled()) { fs.unlinkSync(startupFile()); line(C.yellow, 'warn', 'Removed "start with Windows" while AutoPump is in maintenance'); } } catch { /* ignore */ }
    console.log(`  ${C.yellow}${C.bold}AutoPump is temporarily offline for maintenance.${C.reset} ${C.gray}No trades will be made. You can close this window.${C.reset}\n`);
  } else if (!args['allow-sleep']) keepAwake = preventSleep();

  printConnectInfo();
  printHelp();
  setupKeys();
  setInterval(printHeartbeat, 15 * 60e3);
  setupAutoUpdate();

  process.on('uncaughtException', (e) => line(C.red, 'error', `Unexpected: ${e.message}`));
  process.on('unhandledRejection', (e) => line(C.red, 'error', `Unexpected: ${e && e.message ? e.message : e}`));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
}

// After a self-update the previous process may still be releasing the port for a moment.
async function startApiWithRetry() {
  for (let i = 0; ; i++) {
    const a = startApi(engine, { port: cfg.port, token: cfg.token, name: cfg.name });
    try {
      await a.ready;
      return a;
    } catch (e) {
      await a.close().catch(() => {});
      if (e.code !== 'EADDRINUSE') throw e;
      if (i >= 15) throw new Error(`Port ${cfg.port} is already in use. Is the server already running? (change "port" in ${cfgFile})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function setupAutoUpdate() {
  if (!isPackaged || args['no-update']) return;
  cleanupOld(exePath);
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const u = await downloadUpdate(VERSION, exePath);
      if (!u) return;
      line(C.green, 'success', `Update ${u.version} downloaded — restarting into the new version…`);
      await stopAll();
      swapAndRestart(exePath, u.file, process.argv.slice(2));
      process.exit(0);
    } catch (e) {
      line(C.yellow, 'warn', `Update check failed: ${e.message}`);
    } finally {
      busy = false;
    }
  };
  setTimeout(run, 15000);
  setInterval(run, 3 * 3600e3);
}

function banner() {
  console.log('');
  console.log(`  ${C.white}${C.bold}auto${C.reset}${C.blue}${C.bold}pump${C.reset}  ${C.gray}server v${VERSION}${C.reset}`);
  console.log(`  ${C.gray}Copy-trading engine that keeps running 24/7. Leave this window open.${C.reset}`);
  console.log(`  ${C.dim}Unofficial tool — not affiliated with pump.fun or Fomo Labs.${C.reset}`);
  console.log('');
}

function printConnectInfo() {
  const ips = lanAddresses();
  const st = engine.statusView();
  console.log(`  ${C.white}${C.bold}Connect the desktop app${C.reset}`);
  console.log(`  ${C.gray}Desktop app → Settings → Connection → "Find servers" (same network), or enter:${C.reset}`);
  for (const ip of ips) console.log(`    ${C.blue}${ip.address}:${cfg.port}${C.reset}  ${C.dim}(${ip.ifname})${C.reset}`);
  if (!ips.length) console.log(`    ${C.yellow}No network adapter found — connect this PC to your network.${C.reset}`);
  printPairing();
  console.log(`  ${C.gray}Mode:${C.reset} ${st.mode === 'live' ? C.red + 'LIVE' : C.yellow + 'PAPER'}${C.reset}   ${C.gray}Wallet:${C.reset} ${st.wallet ? st.wallet.publicKey : 'not connected'}   ${C.gray}Traders:${C.reset} ${st.activeTargets}/${st.targets}`);
  console.log(`  ${C.gray}Data folder:${C.reset} ${dataDir}`);
  console.log('');
}

function printPairing() {
  if (!api) return;
  const pin = api.pin;
  console.log(`  ${C.gray}Pairing code:${C.reset} ${C.white}${C.bold}${pin.slice(0, 3)} ${pin.slice(3)}${C.reset}   ${C.dim}(rotates after use / every 10 min — press P for a new one)${C.reset}`);
}

function printHelp() {
  const startup = startupEnabled();
  console.log(`  ${C.dim}Keys:${C.reset} ${C.white}[S]${C.reset} start with Windows ${startup ? C.green + '(on)' : C.gray + '(off)'}${C.reset}  ${C.white}[P]${C.reset} new pairing code  ${C.white}[T]${C.reset} show access token  ${C.white}[I]${C.reset} status  ${C.white}[O]${C.reset} open data folder  ${C.white}[Q]${C.reset} quit`);
  console.log(`  ${C.dim}${'─'.repeat(78)}${C.reset}`);
}

function printHeartbeat() {
  const st = engine.statusView();
  const bal = st.solBalance == null ? '—' : st.solBalance.toFixed(4);
  line(C.gray, 'status', `${st.running ? 'running' : 'PAUSED'} · ${st.mode} · ${bal} SOL · ${st.activeTargets} traders · ${st.openPositions} positions · ${st.tradesToday} trades today · RPC ${st.rpcOk === false ? 'DOWN' : 'ok'}`);
}

function printLog(e) {
  const color = { success: C.green, error: C.red, warn: C.yellow, info: C.white, debug: C.dim }[e.level] || C.white;
  line(color, e.level, e.msg, e.ts);
}

function line(color, level, msg, ts = Date.now()) {
  const t = new Date(ts).toLocaleTimeString([], { hour12: false });
  const tag = { success: '✓', error: '✕', warn: '!', info: '•', status: '◷', debug: '·' }[level] || '•';
  console.log(`  ${C.dim}${t}${C.reset} ${color}${tag} ${msg}${C.reset}`);
}

function setupKeys() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    const k = buf.toString().toLowerCase();
    if (k === '\u0003' || k === 'q') return shutdown();
    if (k === 'p') { api.newPin(); }
    if (k === 't') console.log(`  ${C.gray}Access token:${C.reset} ${C.white}${cfg.token}${C.reset}  ${C.dim}(Desktop app → Settings → Connection → Manual)${C.reset}`);
    if (k === 'i') { printHeartbeat(); printConnectInfo(); }
    if (k === 'o') exec(`explorer "${dataDir}"`);
    if (k === 's') { toggleStartup(); printHelp(); }
  });
}

// ----- Windows integration -----
function startupFile() {
  return path.join(process.env.APPDATA || os.homedir(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'FomoTradingbotServer.cmd');
}

function startupEnabled() {
  return process.platform === 'win32' && fs.existsSync(startupFile());
}

function toggleStartup() {
  if (process.platform !== 'win32') return line(C.yellow, 'warn', 'Start-with-Windows is only available on Windows');
  const f = startupFile();
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    line(C.yellow, 'warn', 'Will no longer start with Windows');
  } else {
    const cmd = isPackaged ? `"${exePath}"` : `"${exePath}" "${path.resolve(process.argv[1])}"`;
    fs.writeFileSync(f, `@echo off\r\ncd /d "${path.dirname(exePath)}"\r\nstart "AutoPump Server" ${cmd}\r\n`);
    line(C.green, 'success', 'Will start automatically when you sign in to Windows');
  }
}

// Keeps the PC from sleeping while the server runs (no admin needed).
function preventSleep() {
  if (process.platform !== 'win32') return null;
  const ps = `$s='[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';` +
    `$t=Add-Type -MemberDefinition $s -Name P -Namespace W -PassThru;` +
    `while($true){[void]$t::SetThreadExecutionState([uint32]2147483649);Start-Sleep -Seconds 50}`;
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    line(C.gray, 'info', 'Sleep prevention on while the server runs (use --allow-sleep to disable)');
    return child;
  } catch {
    return null;
  }
}

async function stopAll() {
  try { keepAwake && keepAwake.kill(); } catch { /* gone */ }
  try { engine && engine.stop(); } catch { /* ignore */ }
  try { api && (await api.close()); } catch { /* ignore */ }
}

async function shutdown() {
  line(C.yellow, 'warn', 'Shutting down…');
  await stopAll();
  process.exit(0);
}

// ----- config & paths -----
function resolveDataDir() {
  if (args.data) { fs.mkdirSync(path.resolve(args.data), { recursive: true }); return path.resolve(args.data); }
  const candidates = isPackaged
    ? [path.join(path.dirname(exePath), 'FomoTradingbotServer-data')]
    : [path.join(__dirname, '..', 'data', 'server')];
  candidates.push(path.join(process.env.APPDATA || os.homedir(), 'FomoTradingbot', 'server'));
  for (const d of candidates) {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      return d;
    } catch { /* next */ }
  }
  throw new Error('No writable data folder found');
}

function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* new */ }
  c.port = Number(args.port || c.port || 7420);
  c.token = c.token || secure.randomToken();
  c.name = c.name || os.hostname();
  fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2));
  return c;
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const m = list[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] ?? (list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : true);
  }
  return out;
}

function isSea() {
  try { return require('node:sea').isSea(); } catch { return false; }
}

function waitForKeyThenExit(code) {
  if (!process.stdin.isTTY) process.exit(code);
  console.log(`  ${C.gray}Press any key to close.${C.reset}`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
}
