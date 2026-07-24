/**
 * Electron main (plain ESM) — 托管 @bolo/core
 * 通过 tsx 注册加载 monorepo TS 源码。
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
} = await import(
  pathToFileURL(path.join(repoRoot, 'packages/core/src/index.ts')).href
)
const { createMockProvider } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/providers/src/index.ts')).href
)

let mainWindow = null
let session = null

function send(channel, payload) {
  mainWindow?.webContents.send(channel, payload)
}

async function ensureSession() {
  if (session) return session
  const forceMock =
    process.env.BOLO_PROVIDER === 'mock' ||
    process.env.BOLO_DESKTOP_MOCK !== '0'

  session = await createSessionFromWorkspace({
    cwd: process.env.BOLO_DESKTOP_CWD?.trim() || process.cwd(),
    ensureDefaults: true,
    connectMcp: false,
    systemPrompt: true,
    onEvent: (e) => send('bolo:event', e),
  })

  // 桌面默认 mock，无 key 可启动；设 BOLO_DESKTOP_MOCK=0 用 workspace provider
  if (forceMock) {
    session.provider = createMockProvider()
    session.deps = productionDeps(session.provider)
  }
  return session
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
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
    }
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
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  if (session) {
    try {
      await closeSessionMcp(session)
    } catch {
      /* ignore */
    }
    session = null
  }
  if (process.platform !== 'darwin') app.quit()
})