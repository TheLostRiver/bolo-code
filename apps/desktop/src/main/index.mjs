/**
 * Electron main — core + 权限 + 设置 + 多 provider（CX7 / P5）
 * 产品逻辑在 packages/*；本文件只做 IPC 编排。无遥测。
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'tsx/esm/api'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// src/main → src → desktop → apps → repo root
const repoRoot = path.resolve(__dirname, '../../../..')

register()

const {
  createSessionFromWorkspace,
  submitUserInput,
  closeSessionMcp,
  endSession,
  productionDeps,
  setPermissionMode,
  switchSessionProvider,
  listSessionProviders,
  attachProviderRegistry,
  loadSessionTimeline,
  loadSessionListEntries,
  getSessionPersistMeta,
  buildRuntimeSnapshot,
} = await import(
  pathToFileURL(path.join(repoRoot, 'packages/core/src/index.ts')).href
)
const { buildTimelineCards, redactSecretsDeep } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/shared/src/index.ts')).href
)
const {
  createMockProvider,
  detectEffortDialectId,
  listEffortChoosable,
  listBuiltinEffortDialectIds,
} = await import(
  pathToFileURL(path.join(repoRoot, 'packages/providers/src/index.ts')).href
)
const {
  listProviderPresets,
  addProviderProfileToConfigFile,
  loadConfigJson,
  mergeConfigs,
  getUserLayout,
  getProjectLayout,
  normalizeProviderRegistry,
} = await import(
  pathToFileURL(path.join(repoRoot, 'packages/config/src/index.ts')).href
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

async function destroySession(reason = 'other') {
  if (session) {
    try {
      await endSession(session, { reason, closeMcp: true })
    } catch {
      try {
        await closeSessionMcp(session)
      } catch {
        /* ignore */
      }
    }
    session = null
  }
}

/**
 * 从磁盘刷新 registry 并挂到 session（add provider 后用）。
 */
async function refreshSessionRegistry(s) {
  try {
    const user = await loadConfigJson(getUserLayout())
    const project = await loadConfigJson(getProjectLayout(s.cwd))
    const merged = mergeConfigs(user, project)
    const reg = normalizeProviderRegistry(merged)
    attachProviderRegistry(s, reg, s.providerId || reg.defaultId)
    return reg
  } catch {
    return s.providerRegistry ?? null
  }
}

function effortSnapshot(s) {
  try {
    const dialect =
      s.effortDialect ??
      s.providerProfile?.effortDialect ??
      detectEffortDialectId({
        kind: s.provider?.id,
        baseUrl: s.providerProfile?.baseUrl,
        model: s.model ?? s.providerProfile?.model,
      })
    const dialectId =
      typeof dialect === 'string'
        ? dialect
        : dialect && typeof dialect === 'object' && dialect.id
          ? String(dialect.id)
          : 'max-tokens'
    const choosable = listEffortChoosable(dialect, {
      isAgent: true,
      model: s.model ?? s.providerProfile?.model,
    })
    return {
      effortLevel: s.effortLevel ?? 'auto',
      dialectId,
      choosable,
    }
  } catch {
    return {
      effortLevel: s.effortLevel ?? 'auto',
      dialectId: null,
      choosable: [],
    }
  }
}

function sessionStatusPayload(s) {
  const effort = effortSnapshot(s)
  return {
    id: s.id,
    cwd: s.cwd,
    model: s.model ?? null,
    permissionMode: s.permissionMode,
    messageCount: s.messages.length,
    /** 协议 kind（LlmProvider.id） */
    providerKind: s.provider?.id ?? null,
    /** 命名 profile id（config.providers key） */
    providerId: s.providerId ?? null,
    effortLevel: effort.effortLevel,
    effortDialect: effort.dialectId,
    effortChoosable: effort.choosable,
    settings: redactSecretsDeep({ ...desktopSettings }),
  }
}

async function ensureSession(forceNew = false) {
  if (session && !forceNew) return session
  if (forceNew) await destroySession()

  const created = await createSessionFromWorkspace({
    cwd: desktopSettings.cwd,
    ensureDefaults: true,
    connectMcp: false,
    systemPrompt: true,
    permissionMode: desktopSettings.permissionMode,
    askPermission: createDesktopAskPermission(),
    onEvent: (e) => send('bolo:event', e),
  })
  session = created?.session ?? created

  if (desktopSettings.useMock) {
    // mock 覆盖协议实现，但保留 registry 以便 UI 列 providers
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
    return sessionStatusPayload(s)
  })

  // secret 不过界（ROADMAP AR3E 验收）。这里用的是**无边界展开**——
  // 日后有人往 desktopSettings 加字段就会自动跟着过界，且没有任何东西会报警。
  // 套一层抹除比每次 review 记得可靠。
  ipcMain.handle('bolo:getSettings', async () =>
    redactSecretsDeep({ ...desktopSettings }),
  )

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
      }
    }
    if (needRecreate || patch.recreate === true) {
      await ensureSession(true)
    }
    return { ok: true, settings: { ...desktopSettings } }
  })

  // ── CX7：providers ──
  ipcMain.handle('bolo:listProviders', async () => {
    const s = await ensureSession()
    await refreshSessionRegistry(s)
    const list = listSessionProviders(s)
    return {
      ok: true,
      activeId: s.providerId ?? null,
      providerKind: s.provider?.id ?? null,
      model: s.model ?? null,
      ...effortSnapshot(s),
      providers: list.map((p) => ({
        id: p.id,
        kind: p.kind ?? null,
        model: p.model ?? null,
        label: p.label ?? null,
        baseUrl: p.baseUrl ?? null,
        hasKeyConfig: p.hasKeyConfig === true,
        isDefault: p.isDefault === true,
        isActive: p.isActive === true,
      })),
      presets: listProviderPresets().map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        model: p.model ?? null,
        apiKeyEnv: p.apiKeyEnv ?? null,
        notes: p.notes ?? null,
      })),
    }
  })

  ipcMain.handle('bolo:useProvider', async (_evt, payload) => {
    const id = typeof payload === 'string' ? payload : payload?.id
    const model =
      typeof payload === 'object' && payload?.model
        ? String(payload.model).trim()
        : undefined
    if (!id || !String(id).trim()) {
      return { ok: false, error: 'provider id required' }
    }
    const s = await ensureSession()
    // mock 模式仍允许切 profile 元数据；真正请求仍 mock，除非关 mock
    if (desktopSettings.useMock) {
      // 允许切换以便用户配置；提示关 mock 才打真网
    }
    await refreshSessionRegistry(s)
    const sw = switchSessionProvider(s, String(id).trim(), {
      ...(model ? { model } : {}),
    })
    if (!sw.ok) {
      return { ok: false, error: sw.reason, status: sessionStatusPayload(s) }
    }
    // 若仍 useMock，协议层保持 mock，但 providerId/profile 已更新
    if (desktopSettings.useMock) {
      s.provider = createMockProvider()
      s.deps = productionDeps(s.provider)
    }
    return {
      ok: true,
      message: sw.message,
      status: sessionStatusPayload(s),
    }
  })

  ipcMain.handle('bolo:addProvider', async (_evt, payload) => {
    const presetId =
      typeof payload === 'string' ? payload : payload?.presetId
    if (!presetId || !String(presetId).trim()) {
      return { ok: false, error: 'presetId required' }
    }
    const s = await ensureSession()
    const added = await addProviderProfileToConfigFile({
      presetId: String(presetId).trim(),
      asId:
        typeof payload === 'object' && payload?.asId
          ? String(payload.asId).trim()
          : undefined,
      overwrite: !!(typeof payload === 'object' && payload?.overwrite),
      setDefault: !!(typeof payload === 'object' && payload?.setDefault),
      scope:
        typeof payload === 'object' && payload?.scope === 'project'
          ? 'project'
          : 'user',
      cwd: s.cwd,
    })
    if (!added.ok) {
      return { ok: false, error: added.reason }
    }
    await refreshSessionRegistry(s)
    return {
      ok: true,
      id: added.id,
      message: added.message,
      configPath: added.configPath,
      providers: listSessionProviders(s),
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
      status: sessionStatusPayload(s),
    }
  })

  ipcMain.handle('bolo:listMessages', async () => {
    const s = await ensureSession()
    return s.messages.map((m) => ({
      role: m.role,
      content: String(m.content ?? '').slice(0, 4000),
    }))
  })

  // AR3B：可回看的 turn timeline。
  //
  // 与 bolo:listMessages 的区别不是「更详细」而是**语义不同**：
  // listMessages 把历史拍平成截断字符串，工具调用与 diff 一律丢失；
  // 这里返回按 turn 分组、带工具与 diff 的结构化时间线。
  //
  // 装配与投影都在 packages（core/sessionViews + shared/turnTimeline），
  // 主进程只做转发 —— renderer 更不该重算。
  ipcMain.handle('bolo:getTimeline', async () => {
    const s = await ensureSession()
    const meta = getSessionPersistMeta(s)
    if (!meta?.filePath) {
      // 还没落盘的新会话：不是错误，也不是「读不出来」
      return { ok: true, cards: [], usedCompactBoundary: false }
    }
    // 三种情况在这里就分开了，renderer 不必自己猜：
    // not_found（还没写）/ unreadable（有文件但读不出）/ ok 且零 turn（真空）
    const r = await loadSessionTimeline(meta.filePath)
    if (!r.ok) return r
    // renderer 是原生 JS，导入不了 TS 包 —— 折叠/截断/状态在这里算好再下发，
    // 壳只负责把纯文本放进 DOM
    return {
      ok: true,
      usedCompactBoundary: r.usedCompactBoundary,
      cards: buildTimelineCards({ turns: r.turns }),
    }
  })

  // AR3B：会话列表。运行时状态来自当前会话的快照，
  // 其余会话没有快照 —— 视图模型会把它们标成 unknown 而不是 idle。
  ipcMain.handle('bolo:listSessions', async () => {
    const s = await ensureSession()
    let snapshots = []
    try {
      snapshots = [buildRuntimeSnapshot(s)]
    } catch {
      // 拿不到快照就当没有：标成 unknown 比编一个状态好
    }
    return await loadSessionListEntries({
      cwd: s.cwd,
      snapshots,
      activeSessionId: s.id,
    })
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