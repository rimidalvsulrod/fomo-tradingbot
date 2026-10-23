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
  update: { state: inv('app:updateState'), install: inv('app:installUpdate'), onState: on('app:update') },
  pump: { open: inv('pump:open') },
  onClipboard: on('app:clipboard'),
  setClipboardWatch: inv('app:setClipboardWatch'),
  onNav: on('app:nav'),
  always: { get: inv('app:247:get'), set: inv('app:247:set'), newPin: inv('app:247:newPin'), onState: on('app:247') },
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
});
