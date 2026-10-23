'use strict';
// Runs in the "Browse pump.fun" window. Adds one floating button on trader profiles and coin pages
// that hands the wallet / coin to the main app. It doesn't read or change anything else on the page.
const { ipcRenderer } = require('electron');

const B58 = '[1-9A-HJ-NP-Za-km-z]{32,44}';
let current = '';

function target() {
  const p = location.pathname;
  let m = p.match(new RegExp(`^/profile/(${B58})`));
  if (m) return { kind: 'trader', id: m[1], label: 'Copy this trader in AutoPump' };
  m = p.match(new RegExp(`^/(?:coin|advanced/coin)/(${B58})`));
  if (m) return { kind: 'coin', id: m[1], label: 'See who trades this in AutoPump' };
  return null;
}

function render() {
  const t = target();
  const key = t ? t.kind + t.id : '';
  if (key === current) return;
  current = key;
  document.getElementById('autopump-btn')?.remove();
  if (!t || !document.body) return;
  const b = document.createElement('button');
  b.id = 'autopump-btn';
  b.textContent = t.label;
  b.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:12px 18px;border-radius:999px;border:0;'
    + 'background:#516af6;color:#fff;font:700 14px/1 system-ui,Segoe UI,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)';
  b.onclick = () => ipcRenderer.send('pump:handoff', { kind: t.kind, id: t.id });
  document.body.appendChild(b);
}

// pump.fun is a single-page app, so watch for route changes.
setInterval(render, 800);
window.addEventListener('DOMContentLoaded', render);
