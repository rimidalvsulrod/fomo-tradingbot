'use strict';
// Self-update for the packaged server: pulls the server exe from the latest GitHub release,
// swaps it in place of the running exe (Windows allows renaming a running exe) and restarts.
const fs = require('fs');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const LATEST = 'https://api.github.com/repos/rimidalvsulrod/fomo-tradingbot/releases/latest';
// Current name first; older releases (and older servers looking for it) use the pre-rename name.
const ASSETS = ['PumpfunBotServer.exe', 'FomoTradingbotServer.exe'];

function newer(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// Removes the exe left behind by the previous update once it's no longer running.
function cleanupOld(exePath) {
  try { fs.unlinkSync(exePath + '.old'); } catch { /* none or still locked */ }
}

async function downloadUpdate(current, exePath) {
  const res = await fetch(LATEST, { headers: { 'user-agent': 'fomo-tradingbot-server', accept: 'application/vnd.github+json' } });
  if (!res.ok) return null;
  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/, '');
  if (!version || !newer(version, current)) return null;
  const asset = ASSETS.map((n) => (rel.assets || []).find((a) => a.name === n)).find(Boolean);
  if (!asset) return null;
  const file = exePath + '.new';
  const dl = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'fomo-tradingbot-server' } });
  if (!dl.ok) throw new Error(`download failed (${dl.status})`);
  await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(file));
  if (fs.statSync(file).size !== asset.size) { fs.unlinkSync(file); throw new Error('download incomplete'); }
  return { version, file };
}

// Call after the engine and API are stopped. Starts the new exe in its own console window.
function swapAndRestart(exePath, newFile, args) {
  cleanupOld(exePath);
  fs.renameSync(exePath, exePath + '.old');
  fs.renameSync(newFile, exePath);
  const quoted = args.map((a) => `"${String(a).replace(/"/g, '')}"`).join(' ');
  spawn('cmd.exe', ['/c', `start "Pumpfun Bot Server" "${exePath}" ${quoted}`], {
    detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
  }).unref();
}

module.exports = { downloadUpdate, swapAndRestart, cleanupOld, newer };
