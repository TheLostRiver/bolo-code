const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bolo', {
  runtimeHello: () => ipcRenderer.invoke('bolo:runtimeHello'),
  runtimeQuery: (request) => ipcRenderer.invoke('bolo:runtimeQuery', request),
  runtimeCommand: (command) =>
    ipcRenderer.invoke('bolo:runtimeCommand', command),
  getStatus: () => ipcRenderer.invoke('bolo:getStatus'),
  getSettings: () => ipcRenderer.invoke('bolo:getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('bolo:setSettings', patch),
  getComposerActions: (payload) =>
    ipcRenderer.invoke('bolo:getComposerActions', payload),
  composerControl: (payload) =>
    ipcRenderer.invoke('bolo:composerControl', payload),
  submit: (text) => ipcRenderer.invoke('bolo:submit', text),
  listMessages: () => ipcRenderer.invoke('bolo:listMessages'),
  /** AR3B：结构化 turn timeline（工具调用与 diff 不丢） */
  getTimeline: () => ipcRenderer.invoke('bolo:getTimeline'),
  /** AR3B：会话列表（含运行时状态徽标） */
  listSessions: () => ipcRenderer.invoke('bolo:listSessions'),
  /** OI-06E：选择并恢复盘上的会话 */
  selectSession: (request) => ipcRenderer.invoke('bolo:selectSession', request),
  /** CX7：多 provider */
  listProviders: () => ipcRenderer.invoke('bolo:listProviders'),
  useProvider: (idOrPayload) =>
    ipcRenderer.invoke('bolo:useProvider', idOrPayload),
  addProvider: (payload) => ipcRenderer.invoke('bolo:addProvider', payload),
  respondPermission: (id, decision) =>
    ipcRenderer.invoke('bolo:permission_response', { id, decision }),
  // AskUserQuestion：一次 push + 一次回包。cancelled 与 selections 互斥，
  // 「没答」绝不能被表达成一个空答案——见 askUserQuestionBridge.ts。
  respondAskUserQuestion: (id, response) =>
    ipcRenderer.invoke('bolo:ask_user_question_response', { id, ...response }),
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
  onAskUserQuestion: (handler) => {
    ipcRenderer.on('bolo:ask_user_question', handler)
    return () => {
      ipcRenderer.removeListener('bolo:ask_user_question', handler)
    }
  },
})
