const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bolo', {
  getStatus: () => ipcRenderer.invoke('bolo:getStatus'),
  getSettings: () => ipcRenderer.invoke('bolo:getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('bolo:setSettings', patch),
  submit: (text) => ipcRenderer.invoke('bolo:submit', text),
  listMessages: () => ipcRenderer.invoke('bolo:listMessages'),
  /** AR3B：结构化 turn timeline（工具调用与 diff 不丢） */
  getTimeline: () => ipcRenderer.invoke('bolo:getTimeline'),
  /** AR3B：会话列表（含运行时状态徽标） */
  listSessions: () => ipcRenderer.invoke('bolo:listSessions'),
  /** CX7：多 provider */
  listProviders: () => ipcRenderer.invoke('bolo:listProviders'),
  useProvider: (idOrPayload) =>
    ipcRenderer.invoke('bolo:useProvider', idOrPayload),
  addProvider: (payload) => ipcRenderer.invoke('bolo:addProvider', payload),
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