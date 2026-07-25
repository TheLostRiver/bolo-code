/**
 * Electron main — core + 权限 + 设置（mode/mock/cwd）
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'tsx/esm/api'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

register()

const {
  createSessionFromWorkspace,
  submitUserInput,
  closeSessionMcp,
  productionDeps,
  setPermissionMode,
} = await import(
  pathToFileURL(path.join(repoRoot, 'packages/core/src/index.ts')).href
)
const { createMockProvider } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/providers/src/index.ts')).href
)

let mainWindow = null
let session = null
const pendingPermissions = new Map()

/** 桌面设置（会话级，重启窗口保留进程内） */
const desktopSettings = {
  cwd: process.env.BOLO_DESKTOP_CWD?.trim() || process.cwd(),
  useMock:
    process.env.BOLO_PROVIDER === 'mock' ||
    process.env.BOLO_DESKTOP_MOCK !== '0',
  permissionMode: 'default',
}

function send(channel, payload) {
  mainWindow?.webContents.send(channel, payload)
}

function createDesktopAskPermission() {
  return async (req) => {
    const id = req.toolUseId || `p_${Date.now()}`
    return await new Promise((resolve) => {
      pendingPermissions.set(id, resolve)
      send('bolo:permission_request', {
        id,
        toolName: req.toolName,
        toolInput: req.toolInput,
        toolUseId: req.toolUseId,
        ...(req.preview ? { preview: req.preview } : {}),
      })
      setTimeout(() => {
        if (pendingPermissions.has(id)) {
          pendingPermissions.delete(id)
          resolve('deny')
        }
      }, 120_000)
    })
  }
}

async function destroySession() {
  if (session) {
    try {
      await closeSessionMcp(session)
    } catch {
      /* ignore */
    }
    session = null
  }
}

async function ensureSession(forceNew = false) {
  if (session && !forceNew) return session
  if (forceNew) await destroySession()

  session = await createSessionFromWorkspace({
    cwd: desktopSettings.cwd,
    ensureDefaults: true,
    connectMcp: false,
    systemPrompt: true,
    permissionMode: desktopSettings.permissionMode,
    askPermission: createDesktopAskPermission(),
    onEvent: (e) => send('bolo:event', e),
  })

  if (desktopSettings.useMock) {
    session.provider = createMockProvider()
    session.deps = productionDeps(session.provider)
  }
  session.askPermission = createDesktopAskPermission()
  if (
    desktopSettings.permissionMode &&
    session.permissionMode !== desktopSettings.permissionMode
  ) {
    try {
      setPermissionMode(session, desktopSettings.permissionMode)
    } catch {
      session.permissionMode = desktopSettings.permissionMode
    }
  }
  return session
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    title: 'Bolo Code',
  })
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpc() {
  ipcMain.handle('bolo:getStatus', async () => {
    const s = await ensureSession()
    return {
      id: s.id,
      cwd: s.cwd,
      model: s.model ?? null,
      permissionMode: s.permissionMode,
      messageCount: s.messages.length,
      providerId: s.provider?.id ?? null,
      settings: { ...desktopSettings },
    }
  })

  ipcMain.handle('bolo:getSettings', async () => ({ ...desktopSettings }))

  ipcMain.handle('bolo:setSettings', async (_evt, patch) => {
    if (!patch || typeof patch !== 'object') {
      return { ok: false, error: 'bad patch' }
    }
    let needRecreate = false
    if (typeof patch.cwd === 'string' && patch.cwd.trim()) {
      const next = path.resolve(patch.cwd.trim())
      if (next !== desktopSettings.cwd) {
        desktopSettings.cwd = next
        needRecreate = true
      }
    }
    if (typeof patch.useMock === 'boolean') {
      if (patch.useMock !== desktopSettings.useMock) {
        desktopSettings.useMock = patch.useMock
        needRecreate = true
      }
    }
    if (typeof patch.permissionMode === 'string' && patch.permissionMode) {
      desktopSettings.permissionMode = patch.permissionMode
      if (session && !needRecreate) {
        try {
          setPermissionMode(session, patch.permissionMode)
        } catch {
          session.permissionMode = patch.permissionMode
        }
      } else if (needRecreate) {
        // applied on recreate
      }
    }
    if (needRecreate || patch.recreate === true) {
      await ensureSession(true)
    }
    return { ok: true, settings: { ...desktopSettings } }
  })

  ipcMain.handle('bolo:submit', async (_evt, text) => {
    const s = await ensureSession()
    const raw = typeof text === 'string' ? text : ''
    const result = await submitUserInput(s, raw)
    return {
      type: result.type,
      message: 'message' in result ? result.message : undefined,
      terminalReason:
        'terminal' in result ? result.terminal?.reason : undefined,
      messageCount: s.messages.length,
    }
  })

  ipcMain.handle('bolo:listMessages', async () => {
    const s = await ensureSession()
    return s.messages.map((m) => ({
      role: m.role,
      content: String(m.content ?? '').slice(0, 4000),
    }))
  })

  ipcMain.handle('bolo:permission_response', async (_evt, payload) => {
    const id = payload?.id
    const decision = payload?.decision
    const resolve = id ? pendingPermissions.get(id) : undefined
    if (resolve) {
      pendingPermissions.delete(id)
      if (decision === 'allow' || decision === 'allow_always') {
        resolve(decision)
      } else {
        resolve('deny')
      }
      return { ok: true }
    }
    return { ok: false, error: 'unknown permission id' }
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  for (const [, resolve] of pendingPermissions) resolve('deny')
  pendingPermissions.clear()
  await destroySession()
  if (process.platform !== 'darwin') app.quit()
})