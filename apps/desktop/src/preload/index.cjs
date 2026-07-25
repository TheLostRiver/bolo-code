/**
 * Preload CJS — 白名单 bridge
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bolo', {
  getStatus: () => ipcRenderer.invoke('bolo:getStatus'),
  submit: (text) => ipcRenderer.invoke('bolo:submit', text),
  listMessages: () => ipcRenderer.invoke('bolo:listMessages'),
  respondPermission: (id, decision) =>
    ipcRenderer.invoke('bolo:permission_response', { id, decision }),
  onEvent: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('bolo:event', handler)
    return () => ipcRenderer.removeListener('bolo:event', handler)
  },
  onPermissionRequest: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('bolo:permission_request', handler)
    return () =>
      ipcRenderer.removeListener('bolo:permission_request', handler)
  },
})