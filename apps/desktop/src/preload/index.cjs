/**
 * Preload CJS — Electron sandbox 对 ESM preload 支持不一致，用 CJS 更稳
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bolo', {
  getStatus: () => ipcRenderer.invoke('bolo:getStatus'),
  submit: (text) => ipcRenderer.invoke('bolo:submit', text),
  listMessages: () => ipcRenderer.invoke('bolo:listMessages'),
  onEvent: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('bolo:event', handler)
    return () => ipcRenderer.removeListener('bolo:event', handler)
  },
})