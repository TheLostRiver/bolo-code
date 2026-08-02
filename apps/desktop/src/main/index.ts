/**
 * Electron main — core + 权限 + 设置 + 多 provider（CX7 / P5）
 * 产品逻辑在 packages/*；本文件只做 IPC 编排。无遥测。
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
} from 'electron'
import {
  createDesktopAskUserQuestion,
  type DesktopAskUserQuestionBridge,
} from './askUserQuestionBridge.ts'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// AR3F：静态导入而非 tsx + 计算路径的动态 import。
//
// 原先是 `register()` 之后再 `await import(pathToFileURL(join(repoRoot, '…/*.ts')))`，
// 那样 **esbuild 静态分析不了**，打包后四级相对路径也必然失效——
// 设计文档把打包列为「唯一必须从零搭的板块」，根因就在这里。
//
// 改成静态导入后 dev 与 prod 走**同一条路**（都跑打包产物），
// 不再维护两个会漂移的入口。
import {
  createSessionFromWorkspace,
  resumeSessionFromWorkspace,
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
  createSessionRuntimeTransport,
  createActiveSessionManager,
  scopeSessionRequestId,
  getSessionComposerActions,
  requestSessionComposerControl,
  takeNextSessionQueued,
  getSessionModelEffortSettings,
  getSessionModelMetadataView,
  updateSessionModelEffort,
  projectSessionRuntimeEventView,
  type SessionEvent,
} from '../../../../packages/core/src/index.ts'
import {
  buildTimelineCards,
  redactSecretsDeep,
} from '../../../../packages/shared/src/index.ts'
import { createMockProvider } from '../../../../packages/providers/src/index.ts'
import {
  listProviderPresets,
  addProviderProfileToConfigFile,
  loadConfigJson,
  mergeConfigs,
  getUserLayout,
  getProjectLayout,
  normalizeProviderRegistry,
} from '../../../../packages/config/src/index.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

type DesktopSession = Awaited<
  ReturnType<typeof createSessionFromWorkspace>
>['session']
type DesktopPermissionDecision = 'allow' | 'deny' | 'allow_always'

let mainWindow: BrowserWindow | null = null
const pendingPermissions = new Map<
  string,
  (decision: DesktopPermissionDecision) => void
>()

/** 桌面设置（会话级，重启窗口保留进程内） */
const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
] as const
type DesktopPermissionMode = (typeof PERMISSION_MODES)[number]

function toPermissionMode(v: unknown): DesktopPermissionMode | undefined {
  return typeof v === 'string' &&
    (PERMISSION_MODES as readonly string[]).includes(v)
    ? (v as DesktopPermissionMode)
    : undefined
}

const desktopSettings: {
  cwd: string
  useMock: boolean
  permissionMode: DesktopPermissionMode
} = {
  cwd: process.env.BOLO_DESKTOP_CWD?.trim() || process.cwd(),
  useMock:
    process.env.BOLO_PROVIDER === 'mock' ||
    process.env.BOLO_DESKTOP_MOCK !== '0',
  permissionMode: 'default',
}

function send(channel: string, payload: unknown) {
  mainWindow?.webContents.send(channel, payload)
}

function forwardDesktopSessionEvent(
  event: SessionEvent,
  ownsSession: () => boolean,
) {
  if (!ownsSession()) return
  const view = projectSessionRuntimeEventView(event)
  if (view) {
    send('bolo:event', view)
    return
  }
  if (event.type === 'control' || event.type === 'tool_progress') return
  send('bolo:event', event)
}

/**
 * AskUserQuestion 的桥。
 *
 * `send` 返回**是否真的推出去了**——没有窗口时桥立刻回 `unavailable`，
 * 而不是挂在那里等一个永远不会来的回包（那表现为 agent 整轮卡死）。
 * 逻辑与形状在 `askUserQuestionBridge.ts`，不 import electron，可离线测。
 */
const askUserQuestionBridge: DesktopAskUserQuestionBridge =
  createDesktopAskUserQuestion({
    send: (channel, payload) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false
      mainWindow.webContents.send(channel, payload)
      return true
    },
  })

function createDesktopAskPermission(
  scope: string,
  ownsSession: () => boolean,
) {
  return async (req: {
    toolName: string
    toolInput?: unknown
    toolUseId?: string
    preview?: unknown
  }): Promise<DesktopPermissionDecision> => {
    if (!ownsSession()) return 'deny'
    const id = scopeSessionRequestId(
      scope,
      req.toolUseId || `permission_${Date.now()}`,
    )
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

function cancelPendingSessionInteractions() {
  for (const [, resolve] of pendingPermissions) resolve('deny')
  pendingPermissions.clear()
  askUserQuestionBridge.cancelAll()
}

async function disposeDesktopSession(
  target: DesktopSession,
  _reason: 'replace' | 'shutdown' | 'candidate_rejected',
) {
  try {
    await endSession(target, { reason: 'other', closeMcp: true })
  } catch {
    try {
      await closeSessionMcp(target)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 从磁盘刷新 registry 并挂到 session（add provider 后用）。
 */
async function refreshSessionRegistry(s: DesktopSession) {
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

function sessionStatusPayload(s: DesktopSession) {
  const modelEffort = getSessionModelEffortSettings(s)
  return {
    id: s.id,
    cwd: s.cwd,
    model: modelEffort.model || null,
    permissionMode: s.permissionMode,
    messageCount: s.messages.length,
    /** 协议 kind（LlmProvider.id） */
    providerKind: s.provider?.id ?? null,
    /** 命名 profile id（config.providers key） */
    providerId: s.providerId ?? null,
    effortLevel: modelEffort.effortLevel,
    effortDialect: modelEffort.dialectId,
    effortChoosable: modelEffort.choosable,
    modelMetadata: getSessionModelMetadataView(s),
    settings: redactSecretsDeep({ ...desktopSettings }),
  }
}

function configureDesktopSession(
  target: DesktopSession,
  askPermission: ReturnType<typeof createDesktopAskPermission>,
  resumed: boolean,
): DesktopSession {
  if (desktopSettings.useMock) {
    target.provider = createMockProvider()
    target.deps = productionDeps(target.provider)
  }
  target.askPermission = askPermission
  target.askUserQuestion = askUserQuestionBridge.asker

  if (!resumed && target.permissionMode !== desktopSettings.permissionMode) {
    try {
      setPermissionMode(target, desktopSettings.permissionMode)
    } catch {
      target.permissionMode = desktopSettings.permissionMode
    }
  }
  return target
}

function syncDesktopSettingsFromSession(target: DesktopSession) {
  desktopSettings.cwd = target.cwd
  desktopSettings.permissionMode =
    toPermissionMode(target.permissionMode) ?? desktopSettings.permissionMode
}

async function createDesktopSession(scope: string): Promise<DesktopSession> {
  let ownedSession: DesktopSession | null = null
  const ownsSession = () =>
    ownedSession !== null && sessionManager.isCurrent(ownedSession, scope)
  const askPermission = createDesktopAskPermission(scope, ownsSession)
  const created = await createSessionFromWorkspace({
    cwd: desktopSettings.cwd,
    materializeUserState: true,
    connectMcp: false,
    systemPrompt: true,
    // 注意：createSessionFromWorkspace **不接受** permissionMode——
    // 此处曾传过一个会被静默忽略的同名选项。真正生效的是下面那次
    // setPermissionMode，所以别再把它加回来。
    askPermission,
    onEvent: (event) => {
      forwardDesktopSessionEvent(event, ownsSession)
    },
  })
  ownedSession = created.session
  return configureDesktopSession(ownedSession, askPermission, false)
}

async function resumeDesktopSession(
  sessionId: string,
  scope: string,
): Promise<DesktopSession> {
  let ownedSession: DesktopSession | null = null
  const ownsSession = () =>
    ownedSession !== null && sessionManager.isCurrent(ownedSession, scope)
  const askPermission = createDesktopAskPermission(scope, ownsSession)
  const resumed = await resumeSessionFromWorkspace({
    idOrPath: sessionId,
    cwd: desktopSettings.cwd,
    materializeUserState: true,
    connectMcp: false,
    systemPrompt: true,
    askPermission,
    onEvent: (event) => {
      forwardDesktopSessionEvent(event, ownsSession)
    },
  })
  ownedSession = resumed.session
  return configureDesktopSession(ownedSession, askPermission, true)
}

const sessionManager = createActiveSessionManager<DesktopSession>({
  create: createDesktopSession,
  resume: resumeDesktopSession,
  beforeReplace: () => cancelPendingSessionInteractions(),
  dispose: disposeDesktopSession,
})

async function ensureSession(forceNew = false): Promise<DesktopSession> {
  if (!forceNew) return sessionManager.ensure()
  const recreated = await sessionManager.recreate()
  if (!recreated.ok) throw new Error(recreated.detail)
  return recreated.session
}

const desktopRuntimeTransport = createSessionRuntimeTransport(() =>
  ensureSession(),
)

async function submitDesktopInput(s: DesktopSession, text: string) {
  let result = await submitUserInput(s, text, {
    querySource: 'desktop_composer',
  })
  while (true) {
    const next = await takeNextSessionQueued(s)
    if (next.persistenceWarning) {
      send('bolo:event', {
        type: 'warning',
        message: next.persistenceWarning,
      })
    }
    if (!next.control) break
    if (!next.control.prompt || !next.control.turnId) {
      send('bolo:event', {
        type: 'warning',
        message: `queued control "${next.control.controlId}" is missing its prompt or turn id`,
      })
      continue
    }
    result = await submitUserInput(s, next.control.prompt, {
      turnId: next.control.turnId,
      querySource: next.control.querySource ?? 'desktop_composer_queue',
    })
  }
  return result
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    webPreferences: {
      // 产物布局是 dist/{main.mjs, preload.cjs, renderer/}——与源码布局
      // (src/main, src/preload, src/renderer) 不同。这两条路径按**产物**算，
      // 因为跑起来的永远是打包产物（dev 也先 build 再 electron）。
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    title: 'Bolo Code',
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // BOLO_DESKTOP_SMOKE=1：启动一次、确认 renderer 真的挂上了、然后退出。
  //
  // 这条能抓住静态断言抓不到的一类问题：preload/renderer 路径写错时**构建不报错**，
  // 只在窗口打开那一刻白屏。让它在门禁里真跑一次，比断言字符串可靠得多。
  if (process.env.BOLO_DESKTOP_SMOKE === '1') {
    const smokeSelectId =
      process.env.BOLO_DESKTOP_SMOKE_SELECT_ID?.trim() ?? ''
    const fail = (why: string) => {
      process.stderr.write(`desktop smoke failed: ${why}
`)
      app.exit(1)
    }
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      fail(`did-fail-load ${code} ${desc} ${url}`)
    })
    mainWindow.webContents.on('did-finish-load', () => {
      void mainWindow?.webContents
        .executeJavaScript(
          // 三样都查：DOM 挂上了、preload 桥接可用、样式表真的加载了。
          // 只查 DOM 会漏掉「preload 路径错」和「CSS 404」这两种白屏成因。
          `(async () => {
             const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
             const started = Date.now()
             let runtime = document.documentElement.dataset.runtimeState || 'missing'
             while (runtime === 'connecting' && Date.now() - started < 10000) {
               await wait(25)
               runtime = document.documentElement.dataset.runtimeState || 'missing'
             }

             // 模态可关闭性：hidden 属性可能被 display:flex 覆盖（历史 bug），
             // 必须用 getComputedStyle 验证视觉状态。此段必须位于任何
             // settingsButton.click()（metadata 段）之前，否则 settings 已打开，
             // “初始隐藏”断言会与打开状态竞态。
             const modalEl = (id) => document.getElementById(id)
             const visualHidden = (id) => {
               const e = modalEl(id)
               return !e || getComputedStyle(e).display === 'none'
             }
             const modalsInitiallyHidden =
               visualHidden('settings') && visualHidden('perm') && visualHidden('ask')
             let settingsOpened = false
             let settingsClosedByCancel = false
             if (modalsInitiallyHidden) {
               const sb = document.getElementById('btn-settings')
               if (!sb) throw new Error('smoke: btn-settings missing')
               sb.click()
               const openStarted = Date.now()
               while (
                 !settingsOpened &&
                 Date.now() - openStarted < 10000
               ) {
                 settingsOpened = !visualHidden('settings')
                 if (!settingsOpened) await wait(25)
               }
               if (!settingsOpened) {
                 throw new Error('smoke: settings did not open')
               }
               const cancel = document.getElementById('set-cancel')
               if (!cancel) throw new Error('smoke: set-cancel missing')
               cancel.click()
               const closeStarted = Date.now()
               while (
                 !settingsClosedByCancel &&
                 Date.now() - closeStarted < 10000
               ) {
                 settingsClosedByCancel = visualHidden('settings')
                 if (!settingsClosedByCancel) await wait(25)
               }
               if (!settingsClosedByCancel) {
                 throw new Error('smoke: settings did not close via Cancel')
               }
             }

             const selectionTarget = ${JSON.stringify(smokeSelectId)}
             let beforeSessionId = null
             let afterSessionId = null
             let selected = selectionTarget === ''
             let selectionError = null
             let settingsApplied = false
             let settingsError = null
             let modelAfterSettings = null
             let effortAfterSettings = null
             let metadataVisible = false
             let metadataStatus = null
             if (selectionTarget) {
               const before = await window.bolo.getStatus()
               beforeSessionId = before && before.id
               const selectionStarted = Date.now()
               let row = null
               while (!row && Date.now() - selectionStarted < 10000) {
                 row = [...document.querySelectorAll('.session-item')]
                   .find((item) => item.dataset.sessionId === selectionTarget)
                 if (!row) await wait(25)
               }
               if (!row) {
                 selectionError = 'target session row was not rendered'
               } else {
                 row.click()
                 while (Date.now() - selectionStarted < 10000) {
                   const after = await window.bolo.getStatus()
                   afterSessionId = after && after.id
                   if (afterSessionId === selectionTarget) {
                     selected = true
                     break
                   }
                   await wait(25)
                 }
                 if (!selected) {
                   selectionError = 'target session did not become active'
                 }
               }
             }
             if (selected) {
               const changed = await window.bolo.setModelEffort({
                 model: 'desktop-smoke-model',
                 effort: 'high',
               })
               if (!changed || !changed.ok) {
                 settingsError = changed && (changed.error || changed.code) || 'mutation failed'
               } else {
                 const status = await window.bolo.getStatus()
                 modelAfterSettings = status && status.model
                 effortAfterSettings = status && status.effortLevel
                 metadataStatus =
                   status && status.modelMetadata && status.modelMetadata.status
                 settingsApplied =
                   modelAfterSettings === 'desktop-smoke-model' &&
                   effortAfterSettings === 'high'
                 const settingsButton = document.getElementById('btn-settings')
                 if (settingsButton) settingsButton.click()
                 const metadataStarted = Date.now()
                 let metadataLine = document.getElementById('set-model-metadata')
                 while (
                   metadataLine &&
                   metadataLine.dataset.status !== metadataStatus &&
                   Date.now() - metadataStarted < 10000
                 ) {
                   await wait(25)
                   metadataLine = document.getElementById('set-model-metadata')
                 }
                 const metadata = status && status.modelMetadata
                 metadataVisible =
                   !!metadataLine &&
                   metadataLine.hidden !== true &&
                   metadataLine.dataset.status === metadataStatus &&
                   !!metadata &&
                   metadataLine.textContent.includes(metadata.context.displayTokens) &&
                   metadataLine.textContent.includes(metadata.context.sourceLabel) &&
                   metadataLine.textContent.includes(metadata.maxOutput.displayTokens) &&
                   metadataLine.textContent.includes(metadata.maxOutput.sourceLabel)
               }
             }
             return JSON.stringify({
               log: !!document.getElementById('log'),
               sidebar: !!document.getElementById('session-list'),
               bridge: typeof window.bolo === 'object' && window.bolo !== null,
               styled: getComputedStyle(document.body).display !== '',
               sheets: document.styleSheets.length,
               runtime,
               modalsInitiallyHidden,
               settingsOpened,
               settingsClosedByCancel,
               selectionTarget,
               beforeSessionId,
               afterSessionId,
               selected,
               selectionError,
               settingsApplied,
               settingsError,
               modelAfterSettings,
               effortAfterSettings,
               metadataVisible,
               metadataStatus,
             })
           })()`,
        )
        .then((raw: string) => {
          const r = JSON.parse(raw) as Record<string, unknown>
          const missing: string[] = []
          for (const key of ['log', 'sidebar', 'bridge', 'styled']) {
            if (r[key] !== true) missing.push(key)
          }
          if (r.sheets === 0) missing.push('sheets')
          if (r.runtime !== 'ready') missing.push('runtime')
          if (r.modalsInitiallyHidden !== true) missing.push('modals-hidden')
          if (r.settingsOpened !== true) missing.push('settings-open')
          if (r.settingsClosedByCancel !== true) missing.push('settings-cancel')
          if (
            smokeSelectId &&
            (r.selected !== true ||
              r.afterSessionId !== smokeSelectId ||
              r.beforeSessionId === smokeSelectId)
          ) {
            missing.push(
              `selection(${String(r.selectionError ?? 'wrong session id')})`,
            )
          }
          if (
            r.settingsApplied !== true ||
            r.modelAfterSettings !== 'desktop-smoke-model' ||
            r.effortAfterSettings !== 'high'
          ) {
            missing.push(
              `model/effort(${String(r.settingsError ?? 'status mismatch')})`,
            )
          }
          if (
            r.metadataVisible !== true ||
            r.metadataStatus !== 'warning'
          ) {
            missing.push(
              `model-metadata(${String(r.metadataStatus ?? 'not visible')})`,
            )
          }
          if (missing.length) return fail(`renderer incomplete: ${missing.join(', ')}`)
          process.stdout.write(`desktop smoke ok: ${raw}
`)
          app.exit(0)
        })
        .catch((e: unknown) => fail(String(e)))
    })
    // 兜底：卡住也必须退出，否则门禁会挂死
    setTimeout(() => fail('timed out waiting for the window to load'), 30_000)
  }
}

function registerIpc() {
  ipcMain.handle('bolo:runtimeHello', async () =>
    desktopRuntimeTransport.hello(),
  )

  ipcMain.handle('bolo:runtimeQuery', async (_evt, request) =>
    desktopRuntimeTransport.query(request),
  )

  ipcMain.handle('bolo:runtimeCommand', async (_evt, command) =>
    desktopRuntimeTransport.command(command),
  )

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

  ipcMain.handle('bolo:pickFiles', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '添加文件引用',
      defaultPath: desktopSettings.cwd,
      properties: ['openFile', 'multiSelections'],
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return { ok: false, cancelled: true, paths: [] }
    return { ok: true, paths: result.filePaths }
  })

  ipcMain.handle('bolo:openPath', async (_event, payload) => {
    const target = payload?.path
    if (typeof target !== 'string' || !target.trim()) {
      return { ok: false, error: 'missing path' }
    }
    const resolved = path.resolve(target)
    try {
      const info = await stat(resolved)
      if (!info.isDirectory()) {
        return { ok: false, error: 'path is not a directory' }
      }
    } catch {
      return { ok: false, error: 'path does not exist' }
    }
    const error = await shell.openPath(resolved)
    return error ? { ok: false, error } : { ok: true, path: resolved }
  })

  ipcMain.handle('bolo:setSettings', async (_evt, patch) => {
    if (!patch || typeof patch !== 'object') {
      return { ok: false, error: 'bad patch' }
    }
    const previousSettings = { ...desktopSettings }
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
    const nextMode = toPermissionMode(patch.permissionMode)
    if (nextMode) desktopSettings.permissionMode = nextMode

    const shouldRecreate = needRecreate || patch.recreate === true
    const current = sessionManager.current()
    if (nextMode && current && !shouldRecreate) {
      try {
        setPermissionMode(current, nextMode)
      } catch {
        current.permissionMode = nextMode
      }
    }
    if (shouldRecreate) {
      const recreated = await sessionManager.recreate()
      if (!recreated.ok) {
        Object.assign(desktopSettings, previousSettings)
        return {
          ok: false,
          code: recreated.code,
          error: recreated.detail,
        }
      }
    }
    return { ok: true, settings: { ...desktopSettings } }
  })

  ipcMain.handle('bolo:selectSession', async (_evt, request) => {
    const selected = await sessionManager.select(request)
    if (!selected.ok) return selected
    syncDesktopSettingsFromSession(selected.session)
    return {
      ok: true,
      status: selected.status,
      sessionId: selected.sessionId,
      ...(selected.previousSessionId
        ? { previousSessionId: selected.previousSessionId }
        : {}),
      session: sessionStatusPayload(selected.session),
    }
  })

  // ── CX7：providers ──
  ipcMain.handle('bolo:listProviders', async () => {
    const s = await ensureSession()
    await refreshSessionRegistry(s)
    const list = listSessionProviders(s)
    const modelEffort = getSessionModelEffortSettings(s)
    return {
      ok: true,
      activeId: s.providerId ?? null,
      providerKind: s.provider?.id ?? null,
      ...modelEffort,
      modelMetadata: getSessionModelMetadataView(s),
      providers: list.map((p) => ({
        id: p.id,
        kind: p.kind ?? null,
        model: p.model ?? null,
        label: p.label ?? null,
        baseUrl: p.baseUrl ?? null,
        hasKeyConfig: p.hasKeyConfig === true,
        isDefault: p.isDefault === true,
        isActive: p.isActive === true,
        modelMetadata: p.modelMetadata,
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

  ipcMain.handle('bolo:setModelEffort', async (_evt, payload) => {
    const s = await ensureSession()
    const result = await updateSessionModelEffort(s, payload)
    return result.ok
      ? {
          ok: true,
          persisted: result.persisted,
          settings: result.settings,
          status: sessionStatusPayload(s),
        }
      : {
          ok: false,
          code: result.code,
          error: result.reason,
          settings: result.settings,
          status: sessionStatusPayload(s),
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

  ipcMain.handle('bolo:getComposerActions', async (_evt, payload) => {
    const s = await ensureSession()
    const text = typeof payload?.text === 'string' ? payload.text : ''
    return {
      ok: true,
      actions: getSessionComposerActions(s, text),
    }
  })

  ipcMain.handle('bolo:composerControl', async (_evt, payload) => {
    const s = await ensureSession()
    const result = await requestSessionComposerControl(s, {
      action: payload?.action,
      text: payload?.text,
    })
    return result.ok
      ? {
          ok: true,
          control: result.control,
          duplicate: result.duplicate === true,
          ...(result.persistenceWarning
            ? { warning: result.persistenceWarning }
            : {}),
          actions: getSessionComposerActions(s, ''),
        }
      : {
          ok: false,
          code: result.code,
          error: result.detail,
          actions: getSessionComposerActions(s, ''),
        }
  })

  ipcMain.handle('bolo:submit', async (_evt, text) => {
    const s = await ensureSession()
    const raw = typeof text === 'string' ? text : ''
    const result = await submitDesktopInput(s, raw)
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
    return s.messages.map((m: { role: string; content?: unknown }) => ({
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
    let snapshots: ReturnType<typeof buildRuntimeSnapshot>[] = []
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

  ipcMain.handle('bolo:ask_user_question_response', async (_evt, payload) => {
    const id = payload?.id
    if (typeof id !== 'string' || !id) {
      return { ok: false, error: 'missing question id' }
    }
    // 形状不在这里判：桥原样上交，由 projectAskUserQuestionAnswers 拒绝，
    // 它给的理由更精确。这里只负责认领 id。
    const accepted = askUserQuestionBridge.resolve(id, payload)
    return accepted ? { ok: true } : { ok: false, error: 'unknown question id' }
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
  await sessionManager.close()
  if (process.platform !== 'darwin') app.quit()
})
