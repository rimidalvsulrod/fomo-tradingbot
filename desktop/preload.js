'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('bot', {
  info: inv('app:info'),
  setCloseToTray: inv('app:setCloseToTray'),
  open: inv('app:open'),
  copy: inv('app:copy'),
  req: inv('engine:req'),
  onEvent: on('engine:event'),
  conn: {
    get: inv('conn:get'),
    discover: inv('conn:discover'),
    useLocal: inv('conn:useLocal'),
    pair: inv('conn:pair'),
    manual: inv('conn:manual'),
    onState: on('conn:state'),
  },
  wallet: { import: inv('wallet:import'), generate: inv('wallet:generate') },
  fomo: {
    status: inv('fomo:status'),
    login: inv('fomo:login'),
    loginBrowser: inv('fomo:loginBrowser'),
    logout: inv('fomo:logout'),
    search: inv('fomo:search'),
    leaderboard: inv('fomo:leaderboard'),
    profile: inv('fomo:profile'),
  },
});
