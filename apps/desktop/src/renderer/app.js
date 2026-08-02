/**
 * Renderer — 会话 · 流式 · 权限 · 设置 · 多 provider（CX7）
 */

import { createRuntimeClient } from './runtime-client.js'
import { renderMarkdownInto } from './markdown.js'

/*
 * Motion system: GSAP is shipped beside this native ESM renderer by the
 * desktop build. Keep a CSS fallback for source-only previews and honor the
 * user's reduced-motion preference through gsap.matchMedia().
 */
const motion = globalThis.gsap || null
let reducedMotion = Boolean(
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
)
const motionMedia = motion?.matchMedia?.()
motionMedia?.add('(prefers-reduced-motion: reduce)', () => {
  reducedMotion = true
  return () => {
    reducedMotion = Boolean(
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    )
  }
})
if (motion) {
  document.documentElement.dataset.motionEngine = 'gsap'
  motion.defaults({ overwrite: 'auto' })
}

const MOTION_CLEAR_PROPS = 'opacity,visibility,transform'

function motionEnabled() {
  return Boolean(motion && !reducedMotion)
}

function clearMotion(target) {
  if (!target || !motion) return
  motion.set(target, { clearProps: MOTION_CLEAR_PROPS })
}

function motionFrom(
  target,
  {
    x = 0,
    y = 6,
    scale = 0.985,
    duration = 0.22,
    delay = 0,
    ease = 'power2.out',
    onComplete,
  } = {},
) {
  if (!target) return null
  if (!motionEnabled()) {
    clearMotion(target)
    onComplete?.()
    return null
  }
  motion.killTweensOf(target)
  return motion.fromTo(
    target,
    { autoAlpha: 0, x, y, scale },
    {
      autoAlpha: 1,
      x: 0,
      y: 0,
      scale: 1,
      duration,
      delay,
      ease,
      overwrite: 'auto',
      clearProps: MOTION_CLEAR_PROPS,
      onComplete,
    },
  )
}

function motionStagger(
  targets,
  { y = 6, scale = 0.995, duration = 0.2, each = 0.035 } = {},
) {
  const list = [...(targets || [])].filter(Boolean)
  if (!motionEnabled() || list.length === 0) return null
  motion.killTweensOf(list)
  return motion.fromTo(
    list,
    { autoAlpha: 0, y, scale },
    {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      duration,
      ease: 'power2.out',
      stagger: { each, from: 'start' },
      overwrite: 'auto',
      clearProps: MOTION_CLEAR_PROPS,
    },
  )
}

function motionShow(target, options = {}) {
  if (!target) return null
  target.hidden = false
  if (!motionEnabled()) return null
  return motionFrom(target, options)
}

function motionHide(target, { x = 0, y = -4, scale = 0.985, duration = 0.16, onComplete } = {}) {
  if (!target || target.hidden) {
    onComplete?.()
    return null
  }
  if (!motionEnabled()) {
    target.hidden = true
    clearMotion(target)
    onComplete?.()
    return null
  }
  motion.killTweensOf(target)
  return motion.to(target, {
    autoAlpha: 0,
    x,
    y,
    scale,
    duration,
    ease: 'power1.in',
    overwrite: 'auto',
    onComplete: () => {
      target.hidden = true
      clearMotion(target)
      onComplete?.()
    },
  })
}

function showModal(root, card = root?.querySelector('.perm-card')) {
  if (!root) return
  root.hidden = false
  if (!motionEnabled()) {
    clearMotion(root)
    if (card) clearMotion(card)
    return
  }
  const targets = [root, card].filter(Boolean)
  motion.killTweensOf(targets)
  motion.set(root, { autoAlpha: 0 })
  if (card) motion.set(card, { autoAlpha: 0, y: 14, scale: 0.975 })
  const timeline = motion.timeline({ defaults: { overwrite: 'auto' } })
  timeline.to(root, { autoAlpha: 1, duration: 0.18, ease: 'power2.out' })
  if (card) {
    timeline.to(
      card,
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: 0.24,
        ease: 'back.out(1.08)',
        clearProps: MOTION_CLEAR_PROPS,
      },
      '<0.02',
    )
  }
  return timeline
}

function hideModal(root, card = root?.querySelector('.perm-card'), onComplete) {
  if (!root || root.hidden) {
    onComplete?.()
    return null
  }
  if (!motionEnabled()) {
    root.hidden = true
    clearMotion(root)
    if (card) clearMotion(card)
    onComplete?.()
    return null
  }
  const targets = [root, card].filter(Boolean)
  motion.killTweensOf(targets)
  const timeline = motion.timeline({ defaults: { overwrite: 'auto' } })
  if (card) {
    timeline.to(card, {
      autoAlpha: 0,
      y: 8,
      scale: 0.985,
      duration: 0.14,
      ease: 'power1.in',
    })
  }
  timeline.to(
    root,
    {
      autoAlpha: 0,
      duration: 0.13,
      ease: 'power1.in',
      onComplete: () => {
        root.hidden = true
        targets.forEach(clearMotion)
        onComplete?.()
      },
    },
    card ? '<0.02' : 0,
  )
  return timeline
}

const statusEl = document.getElementById('status')
const runtimeStatusEl = document.getElementById('runtime-status')
const logEl = document.getElementById('log')
const promptEl = document.getElementById('prompt')
const composerModel = document.getElementById('composer-model')
const composerEffort = document.getElementById('composer-effort')
const composerUsage = document.getElementById('composer-usage')
const composerAttachments = document.getElementById('composer-attachments')
const sendBtn = document.getElementById('composer-send')
const queueBtn = document.getElementById('composer-queue')
const steerBtn = document.getElementById('composer-steer')
const interruptBtn = document.getElementById('composer-interrupt')
const permEl = document.getElementById('perm')
const permText = document.getElementById('perm-text')
const askEl = document.getElementById('ask')
const askQuestionsEl = document.getElementById('ask-questions')
const settingsEl = document.getElementById('settings')
const setMode = document.getElementById('set-mode')
const setMock = document.getElementById('set-mock')
const setCwd = document.getElementById('set-cwd')
const setProvider = document.getElementById('set-provider')
const setPreset = document.getElementById('set-preset')
const setModel = document.getElementById('set-model')
const setModelSuggestions = document.getElementById('set-model-suggestions')
const setModelMetadata = document.getElementById('set-model-metadata')
const setEffort = document.getElementById('set-effort')
const setEffortDetail = document.getElementById('set-effort-detail')
const settingsError = document.getElementById('set-settings-error')
const settingsClose = document.getElementById('settings-close')
const settingsSearch = document.getElementById('settings-search')
const settingsSearchEmpty = document.getElementById('settings-search-empty')
const settingsThemeToggle = document.getElementById('settings-theme-toggle')
const settingsThemeValue = document.getElementById('settings-theme-value')
const settingsRuntimeValue = document.getElementById('settings-runtime-value')
const settingsProviderValue = document.getElementById('settings-provider-value')
const settingsWorkspaceValue = document.getElementById('settings-workspace-value')
const hdrProvider = document.getElementById('hdr-provider')
const sessionListEl = document.getElementById('session-list')
const sidePanel = document.getElementById('side-panel')
const panelBody = document.getElementById('panel-body')
const btnPanel = document.getElementById('btn-panel')
const btnPanelClose = document.getElementById('btn-panel-close')
const btnTheme = document.getElementById('btn-theme')
const btnSidebar = document.getElementById('btn-sidebar')
const btnAttach = document.getElementById('btn-attach')
const btnNewSession = document.getElementById('btn-new-session')
const navAutomation = document.getElementById('nav-automation')
const navSkills = document.getElementById('nav-skills')
const navPlugins = document.getElementById('nav-plugins')
const userCard = document.getElementById('user-card')
const userAvatarLetter = document.getElementById('user-avatar-letter')
const userDot = document.getElementById('user-dot')
const userName = document.getElementById('user-name')
const viewChat = document.getElementById('view-chat')
const emptyWorkspace = document.getElementById('empty-workspace')
const viewCapability = document.getElementById('view-capability')
const capIcon = document.getElementById('cap-icon')
const capTitle = document.getElementById('cap-title')
const capDesc = document.getElementById('cap-desc')
const capPath = document.getElementById('cap-path')
const sessionTitleEl = document.getElementById('session-title')
const composerMode = document.getElementById('composer-mode')
const renameDialog = document.getElementById('rename-dialog')
const renameForm = document.getElementById('rename-form')
const renameTitle = document.getElementById('rename-title')
const renameLabel = document.getElementById('rename-label')
const renameInput = document.getElementById('rename-input')
const panelEls = {
  runtime: document.getElementById('panel-runtime'),
  local: document.getElementById('panel-local'),
  session: document.getElementById('panel-session'),
  mode: document.getElementById('panel-mode'),
  agents: document.getElementById('panel-agents'),
  agentsCount: document.getElementById('panel-agents-count'),
  sources: document.getElementById('panel-sources'),
}

let streamEl = null
let streamBuf = ''
/** @type {{ id: string, label?: string, kind?: string, model?: string, isActive?: boolean }[]} */
let lastProviders = []
/** @type {{ id: string, label?: string }[]} */
let lastPresets = []
let activeProviderId = ''
let fillingProviderSelect = false
let selectingSession = false
let composerRequestPending = false
let composerRefreshRevision = 0
let lastComposerActions = []
const toolRuntimeRows = new Map()
/** 项目组折叠态（内存级，按 cwd key） */
const collapsedProjects = new Set()
let currentView = 'chat'
let lastActiveSessionTitle = 'Session'
let currentWorkspaceCwd = ''
let selectedAttachmentPaths = []
let pendingRenameSubmit = null
let lastDetailsStatus = null
let activeProjectPop = null
let projectPopHideTimer = null

const composerButtons = {
  submit: sendBtn,
  queue: queueBtn,
  steer: steerBtn,
  interrupt: interruptBtn,
}

const runtimeClient = createRuntimeClient({
  transport: {
    hello: () => window.bolo.runtimeHello(),
    query: (request) => window.bolo.runtimeQuery(request),
    command: (command) => window.bolo.runtimeCommand(command),
  },
})

function renderRuntimeState(state) {
  document.documentElement.dataset.runtimeState = state.status
  updateSettingsOverview()
  // 用户区头像角标（与顶栏胶囊同源）
  if (userDot) userDot.dataset.state = state.status
  // snapshot 更新 → 环境信息浮层的子智能体/活动跟着刷新（同一份真实数据）
  fillPanelTasks()
  if (panelEls.runtime) panelEls.runtime.textContent = state.status
  if (!runtimeStatusEl) return
  runtimeStatusEl.dataset.state = state.status
  if (state.status === 'ready') {
    runtimeStatusEl.textContent = `Runtime v${state.protocolVersion} ready`
    return
  }
  if (state.status === 'incompatible') {
    runtimeStatusEl.textContent =
      `Runtime incompatible: ${String(state.detail).slice(0, 240)}`
    return
  }
  if (state.status === 'error') {
    runtimeStatusEl.textContent =
      `Runtime unavailable: ${String(state.detail).slice(0, 240)}`
    return
  }
  runtimeStatusEl.textContent =
    state.status === 'connecting' ? 'Runtime connecting…' : 'Runtime disconnected'
}

function renderComposerActions(actions) {
  lastComposerActions = Array.isArray(actions) ? actions : []
  for (const [action, button] of Object.entries(composerButtons)) {
    if (!button) continue
    const option = lastComposerActions.find((item) => item.action === action)
    button.disabled = composerRequestPending || option?.available !== true
    const reason =
      option?.available === false && option.unavailableReason
        ? ` — ${option.unavailableReason}`
        : ''
    button.title = `${option?.hint ?? action}${reason}`
  }
  // Send/Interrupt 一体化：turn 活跃时主按钮变「中断」，否则是「发送」。
  // Queue/Steer 保留 DOM 与 runtime 契约，但不再作为第二套主操作暴露。
  const interruptOption = lastComposerActions.find((i) => i.action === 'interrupt')
  const submitOption = lastComposerActions.find((i) => i.action === 'submit')
  const canInterrupt = interruptOption?.available === true
  const primaryOption = canInterrupt ? interruptOption : submitOption
  const nextMode = canInterrupt ? 'interrupt' : 'submit'
  const modeChanged = sendBtn.dataset.mode !== nextMode
  sendBtn.dataset.mode = nextMode
  if (modeChanged && motionEnabled()) {
    motion.fromTo(
      sendBtn,
      { scale: 0.86, rotation: nextMode === 'interrupt' ? -6 : 6 },
      {
        scale: 1,
        rotation: 0,
        duration: 0.22,
        ease: 'back.out(1.7)',
        clearProps: 'transform',
        overwrite: 'auto',
      },
    )
  }
  sendBtn.disabled = composerRequestPending || primaryOption?.available !== true
  sendBtn.title = canInterrupt
    ? `Interrupt${interruptOption?.unavailableReason ? ` — ${interruptOption.unavailableReason}` : ''}`
    : `Send (Enter)${submitOption?.available === false && submitOption.unavailableReason ? ` — ${submitOption.unavailableReason}` : ''}`
  queueBtn.hidden = true
  steerBtn.hidden = true
  interruptBtn.hidden = true // 视觉由 send 双态承担，DOM 保留（id 契约）
}

async function refreshComposerActions() {
  const revision = ++composerRefreshRevision
  try {
    const result = await window.bolo.getComposerActions({
      text: promptEl.value,
    })
    if (revision !== composerRefreshRevision) return
    renderComposerActions(result?.ok ? result.actions : [])
  } catch {
    if (revision !== composerRefreshRevision) return
    renderComposerActions([])
  }
}

runtimeClient.subscribe(renderRuntimeState)
renderRuntimeState(runtimeClient.getState())

async function activateSessionEntry(sessionId) {
  if (!sessionId || selectingSession || !window.bolo?.selectSession) return
  selectingSession = true
  sessionListEl?.setAttribute('aria-busy', 'true')
  try {
    const selected = await window.bolo.selectSession({ sessionId })
    if (!selected?.ok) {
      appendMsg(
        'system',
        `Session switch failed: ${selected?.detail ?? selected?.error ?? 'unknown'}`,
      )
      return
    }

    // These prompts belonged to the previous live session instance. The main
    // process has cancelled their pending owners; the renderer must drop its
    // stale ids too so a late click cannot send a misleading response.
    currentPermId = null
    hideModal(permEl, permEl.querySelector('.perm-card'))
    currentAskId = null
    closeAsk()
    endStreamBubble()

    await runtimeClient.refresh()
    await refreshStatus()
    await refreshProviders()
    await refreshSessions()
    if (!(await reloadTimeline())) await reloadMessages()
    await refreshComposerActions()
    // 会话恢复后 main 端 settings 已同步（syncDesktopSettingsFromSession），
    // 环境面板 cwd / 权限胶囊 / 用户区在这里跟手；切会话总是回到对话视图
    if (currentView !== 'chat') switchView('chat')
    try {
      const s = await window.bolo.getSettings()
      fillDetailsCwd(s?.cwd)
      fillUserCard(s?.cwd)
      if (composerMode && s?.permissionMode) {
        composerMode.value = s.permissionMode
        syncCustomSelect(composerMode)
      }
    } catch {
      /* 面板少一项不挡切换 */
    }
    promptEl.focus()
  } catch (error) {
    appendMsg('system', `Session switch error: ${error?.message ?? error}`)
  } finally {
    selectingSession = false
    sessionListEl?.removeAttribute('aria-busy')
  }
}

/**
 * 会话侧栏（v2：项目分组）。
 *
 * 排序、状态、标题回退**全部由 packages 的 buildSessionListView 决定**，
 * 这里只把它给的行放进 DOM —— 薄壳纪律：renderer 不重算业务状态。
 * 分组是纯展示层分桶：按条目自带的 cwd 聚合，**组内与组间都严格保持
 * packages 返回的原始顺序**（不二次排序），尤其「等待审批」置顶不能漂移。
 * 无 cwd 的会话落入「其他」桶。
 */
/** updatedAt（ISO）→ 人类可读相对时间；无效/未来时间回退原串 */
function formatRelativeTime(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return iso
  const diffMs = Date.now() - then
  if (diffMs < 0) return iso
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h`
  const day = Math.floor(hour / 24)
  if (day < 7) return `${day}d`
  return iso.slice(0, 10)
}

/** cwd → 项目名（路径末段；正反斜杠都处理） */
function projectNameOf(cwd) {
  if (!cwd) return ''
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || String(cwd)
}

const SVG_NS = 'http://www.w3.org/2000/svg'
/** 常量 path 数据构建 SVG（禁 innerHTML，XSS 门禁守着） */
function svgIcon(paths, viewBox = '0 0 24 24') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

const FOLDER_PATHS = [
  'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
]
const CHEVRON_PATHS = ['m6 9 6 6 6-6']

function updateSessionTitle(entries) {
  const active = entries.find((e) => e.active === true)
  lastActiveSessionTitle = active?.title || 'New session'
  if (!sessionTitleEl) return
  if (currentView === 'chat') {
    sessionTitleEl.textContent = lastActiveSessionTitle
  }
  sessionTitleEl.title = active?.cwd || ''
}

async function refreshSessions() {
  if (!sessionListEl || !window.bolo?.listSessions) return
  const animateSessionList = sessionListEl.dataset.motionReady !== 'true'
  let entries = []
  try {
    entries = await window.bolo.listSessions()
  } catch {
    return // 取不到就保持上一次的列表，不清空成「一个会话都没有」
  }
  const projectAliases = readPrefMap('bolo.projectAliases')
  const sessionAliases = readPrefMap('bolo.sessionAliases')
  const archivedSessions = readPref('bolo.archivedSessions')
  const unreadSessions = readPref('bolo.unreadSessions')
  entries = entries.map((entry) => ({
    ...entry,
    title: sessionAliases[entry.sessionId] || entry.title,
  }))
  updateSessionTitle(entries)
  closeProjectPop()
  sessionListEl.replaceChildren()

  const pinnedProjects = readPref('bolo.pinnedProjects')
  const hiddenProjects = readPref('bolo.hiddenProjects')
  const pinnedSessions = readPref('bolo.pinnedSessions')

  // 按 cwd 分桶（保持原始顺序）：key = cwd 或 ''（其他）
  const buckets = []
  let currentBucket = null
  for (const e of entries.filter((entry) => !archivedSessions.includes(entry.sessionId))) {
    const key = e.cwd || ''
    if (!currentBucket || currentBucket.key !== key) {
      // 同一路径的会话不一定相邻：先找已有桶，没有再开新桶
      currentBucket = buckets.find((b) => b.key === key)
      if (!currentBucket) {
        currentBucket = {
          key,
          name: projectAliases[key] || projectNameOf(key),
          items: [],
        }
        buckets.push(currentBucket)
      }
    }
    currentBucket.items.push(e)
  }

  // 用户偏好层（非业务重排）：置顶项目提前（按置顶先后），隐藏项目移出主列表；
  // 其余桶严格保持 packages 返回的原始顺序
  const visibleBuckets = buckets.filter((b) => !hiddenProjects.includes(b.key))
  const hiddenBuckets = buckets.filter((b) => hiddenProjects.includes(b.key))
  visibleBuckets.sort((a, b) => {
    const ai = pinnedProjects.indexOf(a.key)
    const bi = pinnedProjects.indexOf(b.key)
    if (ai < 0 && bi < 0) return 0
    if (ai < 0) return 1
    if (bi < 0) return -1
    return ai - bi
  })

  const buildSessionRow = (e) => {
    const li = document.createElement('li')
    li.className = 'session-item'
    li.tabIndex = 0
    li.setAttribute('role', 'option')
    li.dataset.sessionId = e.sessionId
    li.setAttribute('aria-selected', String(e.active === true))
    if (e.active) li.setAttribute('aria-current', 'true')
    li.addEventListener('click', () => {
      if (unreadSessions.includes(e.sessionId)) {
        setPrefItems('bolo.unreadSessions', [e.sessionId], false)
      }
      void activateSessionEntry(e.sessionId)
    })
    li.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      void activateSessionEntry(e.sessionId)
    })
    // 会话右键菜单：本地显示状态 + 可执行的系统/复制动作。
    li.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      const pinned = pinnedSessions.includes(e.sessionId)
      const unread = unreadSessions.includes(e.sessionId)
      openMenu(
        [
          {
            label: pinned ? '取消置顶' : '置顶任务',
            icon: ['M12 17l-5-3 5-3 5 3z', 'M12 2v5'],
            onClick: () => {
              togglePrefItem('bolo.pinnedSessions', e.sessionId)
              void refreshSessions()
            },
          },
          {
            label: '重命名任务',
            icon: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
            onClick: () =>
              openRenameDialog({
                title: '重命名任务',
                label: '任务名称',
                value: e.title,
                onSubmit: (value) => {
                  renameLocalItem('bolo.sessionAliases', e.sessionId, value)
                  void refreshSessions()
                },
              }),
          },
          {
            label: '归档任务',
            icon: ['M4 7h16v13H4z', 'M3 3h18v4H3z', 'M9 11h6'],
            onClick: () => {
              setPrefItems('bolo.archivedSessions', [e.sessionId], true)
              void refreshSessions()
            },
          },
          {
            label: unread ? '标为已读' : '标为未读',
            icon: ['M4 4h16v16H4z', 'm8 12 3 3 5-6'],
            onClick: () => {
              setPrefItems('bolo.unreadSessions', [e.sessionId], !unread)
              void refreshSessions()
            },
          },
          'sep',
          {
            label: '在资源管理器中打开',
            icon: FOLDER_PATHS,
            disabled: !e.cwd,
            onClick: () => void openWorkspacePath(e.cwd),
          },
          {
            label: '复制工作目录',
            icon: ['M8 8h12v12H8z', 'M4 16V4h12'],
            disabled: !e.cwd,
            onClick: () => void copyText(e.cwd, 'Working directory copied.'),
          },
          {
            label: '复制会话 ID',
            icon: ['M8 8h12v12H8z', 'M4 16V4h12'],
            onClick: () => void copyText(e.sessionId, 'Session ID copied.'),
          },
          {
            label: '复制深度链接',
            icon: ['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'],
            onClick: () =>
              void copyText(
                `bolo://session/${encodeURIComponent(e.sessionId)}`,
                'Session link copied.',
              ),
          },
          'sep',
          {
            label: '在新任务中继续',
            hint: '需要会话分叉',
            disabled: true,
            icon: ['M5 12h14', 'm13 6 6 6-6 6'],
          },
          {
            label: '在新工作树中继续',
            hint: '需要会话分叉',
            disabled: true,
            icon: ['M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
          },
          'sep',
          {
            label: '在新窗口中打开',
            hint: '单会话运行时',
            disabled: true,
            icon: ['M14 3h7v7', 'M10 14 21 3', 'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5'],
          },
        ],
        { x: event.clientX, y: event.clientY },
      )
    })

    const title = document.createElement('span')
    title.className = 'session-title'
    title.textContent = e.title
    li.appendChild(title)

    const meta = document.createElement('div')
    meta.className = 'session-meta'
    const left = document.createElement('span')
    left.className = 'session-meta-left'
    if (pinnedSessions.includes(e.sessionId)) {
      const pin = document.createElement('span')
      pin.className = 'session-pin'
      pin.appendChild(svgIcon(['M12 17l-5-3 5-3 5 3z', 'M12 2v5'], '0 0 24 24'))
      left.appendChild(pin)
    }
    const badge = document.createElement('span')
    badge.className = 'badge'
    badge.dataset.status = e.status
    badge.textContent = e.status.replace(/_/g, ' ')
    left.appendChild(badge)
    meta.appendChild(left)
    const right = document.createElement('span')
    right.className = 'session-meta-right'
    const time = document.createElement('span')
    time.className = 'session-time'
    time.textContent = formatRelativeTime(e.updatedAt)
    time.title = e.updatedAt
    right.appendChild(time)
    const count = document.createElement('span')
    count.className = 'session-count'
    count.textContent = `${e.messageCount} msgs`
    right.appendChild(count)
    meta.appendChild(right)
    li.appendChild(meta)

    if (e.needsAttention) li.setAttribute('data-attention', 'true')
    if (unreadSessions.includes(e.sessionId)) li.setAttribute('data-unread', 'true')
    // 完整信息放 tooltip：cwd + model（条目本体保持单行精简）
    const tipParts = []
    if (e.cwd) tipParts.push(e.cwd)
    if (e.model) tipParts.push(`model: ${e.model}`)
    if (tipParts.length) li.title = tipParts.join('\n')
    return li
  }

  for (const bucket of visibleBuckets) {
    const collapsed = collapsedProjects.has(bucket.key)
    // 有 cwd 的桶显示项目名组头；无 cwd 的桶在多桶并存时显示「其他」，
    // 只有它一个桶时平铺（首次使用不该看到一个孤零零的「其他」）
    const showHead = bucket.key !== '' || visibleBuckets.length > 1
    if (showHead) {
      const head = document.createElement('li')
      head.className = 'project-head' + (collapsed ? ' collapsed' : '')
      head.setAttribute('role', 'button')
      head.tabIndex = 0
      head.title = bucket.key || '无项目信息的会话'
      head.appendChild(svgIcon(FOLDER_PATHS))
      const name = document.createElement('span')
      name.className = 'project-name'
      name.textContent = bucket.key ? bucket.name : '其他'
      head.appendChild(name)
      // 项目悬浮卡（hover）：名称 / 会话数 / 完整路径
      if (bucket.key) {
        const pop = document.createElement('span')
        pop.className = 'project-pop'
        const popTitle = document.createElement('span')
        popTitle.className = 'pop-title'
        popTitle.appendChild(svgIcon(FOLDER_PATHS))
        const popName = document.createElement('span')
        popName.textContent = bucket.name
        popTitle.appendChild(popName)
        pop.appendChild(popTitle)
        const popRow = document.createElement('span')
        popRow.className = 'pop-row'
        popRow.appendChild(svgIcon(['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z']))
        const popCount = document.createElement('span')
        popCount.textContent = `${bucket.items.length} 个对话串`
        popRow.appendChild(popCount)
        pop.appendChild(popRow)
        const popPath = document.createElement('span')
        popPath.className = 'pop-path'
        popPath.textContent = bucket.key
        pop.appendChild(popPath)
        bindProjectPop(head, pop)
      }
      const count = document.createElement('span')
      count.className = 'project-count'
      count.textContent = String(bucket.items.length)
      head.appendChild(count)
      // 项目 hover 操作：快速重命名 + 完整 "…" 菜单。
      if (bucket.key) {
        const editBtn = document.createElement('button')
        editBtn.type = 'button'
        editBtn.className = 'project-menu-btn project-edit-btn'
        editBtn.setAttribute('aria-label', 'Rename project')
        editBtn.title = '重命名项目'
        editBtn.appendChild(
          svgIcon(['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z']),
        )
        editBtn.addEventListener('click', (event) => {
          event.stopPropagation()
          openRenameDialog({
            title: '重命名项目',
            label: '项目显示名称',
            value: bucket.name,
            onSubmit: (value) => {
              renameLocalItem('bolo.projectAliases', bucket.key, value)
              void refreshSessions()
            },
          })
        })
        head.appendChild(editBtn)

        const menuBtn = document.createElement('button')
        menuBtn.type = 'button'
        menuBtn.className = 'project-menu-btn'
        menuBtn.setAttribute('aria-label', 'Project menu')
        menuBtn.appendChild(
          svgIcon(['M12 5h.01M12 12h.01M12 19h.01'], '0 0 24 24'),
        )
        menuBtn.addEventListener('click', (event) => {
          event.stopPropagation()
          const pinned = pinnedProjects.includes(bucket.key)
          const rect = menuBtn.getBoundingClientRect()
          openMenu(
            [
              {
                label: pinned ? '取消置顶' : '置顶项目',
                icon: ['M12 17l-5-3 5-3 5 3z', 'M12 2v5'],
                onClick: () => {
                  togglePrefItem('bolo.pinnedProjects', bucket.key)
                  void refreshSessions()
                },
              },
              {
                label: '在资源管理器中打开',
                icon: FOLDER_PATHS,
                onClick: () => void openWorkspacePath(bucket.key),
              },
              {
                label: '创建永久工作树',
                hint: '需要 Git 工作树契约',
                disabled: true,
                icon: ['M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
              },
              {
                label: '重命名项目',
                icon: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
                onClick: () =>
                  openRenameDialog({
                    title: '重命名项目',
                    label: '项目显示名称',
                    value: bucket.name,
                    onSubmit: (value) => {
                      renameLocalItem('bolo.projectAliases', bucket.key, value)
                      void refreshSessions()
                    },
                  }),
              },
              {
                label: '归档任务',
                icon: ['M4 7h16v13H4z', 'M3 3h18v4H3z', 'M9 11h6'],
                onClick: () => {
                  setPrefItems(
                    'bolo.archivedSessions',
                    bucket.items.map((item) => item.sessionId),
                    true,
                  )
                  void refreshSessions()
                },
              },
              {
                label: '移除',
                icon: ['M18 6 6 18M6 6l12 12'],
                onClick: () => {
                  togglePrefItem('bolo.hiddenProjects', bucket.key)
                  void refreshSessions()
                },
              },
            ],
            { x: rect.left, y: rect.bottom + 4, anchor: menuBtn },
          )
        })
        head.appendChild(menuBtn)
      }
      const chevron = document.createElement('span')
      chevron.className = 'project-chevron'
      chevron.style.display = 'inline-flex'
      chevron.appendChild(svgIcon(CHEVRON_PATHS))
      head.appendChild(chevron)
      const toggle = () => {
        if (collapsedProjects.has(bucket.key)) collapsedProjects.delete(bucket.key)
        else collapsedProjects.add(bucket.key)
        void refreshSessions()
      }
      head.addEventListener('click', toggle)
      head.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        toggle()
      })
      sessionListEl.appendChild(head)
    }
    if (!collapsed) {
      // 用户偏好层：置顶会话在组内提前（稳定），其余保持 packages 顺序
      const items = bucket.items.slice().sort((a, b) => {
        const ai = pinnedSessions.includes(a.sessionId) ? 0 : 1
        const bi = pinnedSessions.includes(b.sessionId) ? 0 : 1
        return ai - bi
      })
      for (const e of items) sessionListEl.appendChild(buildSessionRow(e))
    }
  }

  const archivedEntries = entries.filter((entry) =>
    archivedSessions.includes(entry.sessionId),
  )
  if (archivedEntries.length > 0) {
    const archivedRow = document.createElement('li')
    archivedRow.className = 'hidden-projects-row'
    archivedRow.setAttribute('role', 'button')
    archivedRow.tabIndex = 0
    const archivedLabel = document.createElement('span')
    archivedLabel.textContent = `已归档 ${archivedEntries.length} 个任务`
    archivedRow.appendChild(archivedLabel)
    const archivedChevron = document.createElement('span')
    archivedChevron.className = 'project-chevron'
    archivedChevron.appendChild(svgIcon(CHEVRON_PATHS))
    archivedRow.appendChild(archivedChevron)
    const archivedList = document.createElement('div')
    archivedList.className = 'hidden-projects-list'
    archivedList.hidden = true
    for (const entry of archivedEntries) {
      const item = document.createElement('div')
      item.className = 'hidden-project-item'
      item.appendChild(svgIcon(['M4 7h16v13H4z', 'M3 3h18v4H3z']))
      const label = document.createElement('span')
      label.textContent = entry.title
      item.appendChild(label)
      const restore = document.createElement('button')
      restore.type = 'button'
      restore.textContent = '恢复'
      restore.addEventListener('click', (event) => {
        event.stopPropagation()
        setPrefItems('bolo.archivedSessions', [entry.sessionId], false)
        void refreshSessions()
      })
      item.appendChild(restore)
      archivedList.appendChild(item)
    }
    const toggleArchived = () => {
      const open = archivedList.hidden
      if (open) motionShow(archivedList, { y: -4, scale: 0.995, duration: 0.18 })
      else motionHide(archivedList, { y: -4, scale: 0.995, duration: 0.14 })
      archivedRow.classList.toggle('open', open)
    }
    archivedRow.addEventListener('click', toggleArchived)
    archivedRow.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggleArchived()
    })
    sessionListEl.appendChild(archivedRow)
    sessionListEl.appendChild(archivedList)
  }

  // 隐藏项目的恢复入口
  if (hiddenBuckets.length > 0) {
    const hiddenCount = hiddenBuckets.reduce((n, b) => n + b.items.length, 0)
    const row = document.createElement('li')
    row.className = 'hidden-projects-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    const label = document.createElement('span')
    label.textContent = `已隐藏 ${hiddenBuckets.length} 个项目（${hiddenCount} 个会话）`
    row.appendChild(label)
    const chev = document.createElement('span')
    chev.className = 'project-chevron'
    chev.style.display = 'inline-flex'
    chev.appendChild(svgIcon(CHEVRON_PATHS))
    row.appendChild(chev)
    const list = document.createElement('div')
    list.className = 'hidden-projects-list'
    list.hidden = true
    for (const b of hiddenBuckets) {
      const item = document.createElement('div')
      item.className = 'hidden-project-item'
      item.appendChild(svgIcon(FOLDER_PATHS))
      const name = document.createElement('span')
      name.textContent = b.name || '其他'
      item.appendChild(name)
      const restore = document.createElement('button')
      restore.type = 'button'
      restore.textContent = '恢复'
      restore.addEventListener('click', () => {
        togglePrefItem('bolo.hiddenProjects', b.key)
        void refreshSessions()
      })
      item.appendChild(restore)
      list.appendChild(item)
    }
    const toggleHidden = () => {
      const open = list.hidden
      if (open) motionShow(list, { y: -4, scale: 0.995, duration: 0.18 })
      else motionHide(list, { y: -4, scale: 0.995, duration: 0.14 })
      row.classList.toggle('open', open)
    }
    row.addEventListener('click', toggleHidden)
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggleHidden()
    })
    sessionListEl.appendChild(row)
    sessionListEl.appendChild(list)
  }

  if (animateSessionList) {
    sessionListEl.dataset.motionReady = 'true'
    motionStagger(
      [...sessionListEl.children].filter((item) => !item.hidden),
      { y: 5, scale: 0.997, duration: 0.2, each: 0.025 },
    )
  }
}

/**
 * 卡片渲染。
 *
 * 折叠与否、截断与否、状态是什么，**都由 packages 的 buildTimelineCards
 * 已经算好**（主进程经 bolo:getTimeline 下发）。这里只呈现。
 *
 * 全程用 textContent：模型输出是不可信内容，绝不当 HTML 注入。
 * 这条由 scripts/test-timeline-cards.ts 守着。
 */
function renderCard(card) {
  const el = document.createElement('article')
  el.className = 'card'
  el.dataset.kind = card.kind
  if (card.status) el.dataset.status = card.status

  const head = document.createElement('div')
  head.className = 'card-title'
  const kind = document.createElement('span')
  kind.className = 'card-kind'
  kind.textContent = card.kind
  head.appendChild(kind)
  const title = document.createElement('span')
  title.textContent = card.title
  head.appendChild(title)
  el.appendChild(head)

  if (card.body) {
    const body = document.createElement('pre')
    body.className = 'card-body'
    body.textContent = card.body
    // 折叠的卡先不显示正文，但保留在 DOM 里，展开无需再取数
    body.hidden = card.collapsed
    el.appendChild(body)

    if (card.collapsed) {
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'disclosure'
      toggle.textContent = 'show output'
      toggle.setAttribute('aria-expanded', 'false')
      toggle.addEventListener('click', () => {
        const nowHidden = !body.hidden
        if (nowHidden) motionHide(body, { y: -4, scale: 0.995, duration: 0.14 })
        else motionShow(body, { y: 4, scale: 0.995, duration: 0.18 })
        toggle.textContent = nowHidden ? 'show output' : 'hide output'
        toggle.setAttribute('aria-expanded', String(!nowHidden))
      })
      el.appendChild(toggle)
    }

    // 截断了就要说 —— 悄悄截会被读成「它就返回了这么多」
    if (card.truncated) {
      const note = document.createElement('div')
      note.className = 'truncated-note'
      note.textContent = 'output truncated (head and tail kept)'
      el.appendChild(note)
    }
  }

  return el
}

/**
 * 从结构化 timeline 重建历史。
 *
 * 与旧的 reloadMessages 的区别不是「更详细」而是**语义不同**：
 * 那个走 listMessages，把历史拍平成截断字符串，工具调用与 diff 一律丢失。
 */
async function reloadTimeline() {
  if (!window.bolo?.getTimeline) return false
  let r
  try {
    r = await window.bolo.getTimeline()
  } catch {
    return false
  }
  if (!r?.ok) {
    // 读不出来 ≠ 没有历史。清空成空白会让用户以为记录丢了。
    if (r?.code === 'unreadable') {
      appendMsg('system', `history could not be read: ${r.detail ?? 'unknown'}`)
    }
    return false
  }
  const cards = (r.cards ?? []).slice()
  toolRuntimeRows.clear()
  delete logEl.dataset.hydrated
  logEl.replaceChildren()
  for (const c of cards) logEl.appendChild(renderCard(c))
  if (motionEnabled()) {
    motionFrom(logEl.querySelectorAll('.card'), {
      y: 8,
      scale: 0.995,
      duration: 0.22,
    })
  }
  logEl.dataset.hydrated = 'true'
  syncEmptyWorkspace()
  logEl.scrollTop = logEl.scrollHeight
  return true
}

function syncEmptyWorkspace() {
  if (!emptyWorkspace || !logEl) return
  const hasConversation = Boolean(
    logEl.querySelector('.msg.user, .msg.assistant, .card, .file-change-cell'),
  )
  if (hasConversation) {
    emptyWorkspace.dataset.motionShown = 'false'
    if (!emptyWorkspace.hidden) motionHide(emptyWorkspace, { y: -8, scale: 0.99 })
    else emptyWorkspace.hidden = true
    return
  }
  if (emptyWorkspace.hidden) {
    emptyWorkspace.dataset.motionShown = 'false'
    motionShow(emptyWorkspace, { y: 10, scale: 0.985, duration: 0.28 })
  } else if (emptyWorkspace.dataset.motionShown !== 'true') {
    emptyWorkspace.dataset.motionShown = 'true'
    motionFrom(emptyWorkspace, { y: 10, scale: 0.985, duration: 0.28 })
  }
}

function appendMsg(role, text) {
  const div = document.createElement('div')
  div.className = `msg ${role}`
  // assistant/user 消息走 markdown（DOM 渲染，XSS 安全）；system 保持纯文本
  if (role === 'assistant' || role === 'user') {
    renderMarkdownInto(div, text)
  } else {
    div.textContent = text
  }
  logEl.appendChild(div)
  if (logEl.dataset.hydrated === 'true') {
    motionFrom(div, {
      y: role === 'system' || role === 'warning' ? 4 : 8,
      scale: role === 'system' || role === 'warning' ? 1 : 0.995,
      duration: role === 'system' || role === 'warning' ? 0.18 : 0.24,
    })
  }
  syncEmptyWorkspace()
  logEl.scrollTop = logEl.scrollHeight
  return div
}

function renderRuntimeEvent(e) {
  if (e.type === 'tool_progress') {
    let row = toolRuntimeRows.get(e.id)
    if (!row) {
      row = appendMsg('system', e.text)
      toolRuntimeRows.set(e.id, row)
    }
    row.dataset.runtimeEvent = 'tool_progress'
    row.dataset.state = e.state
    row.textContent = e.text
    logEl.scrollTop = logEl.scrollHeight
    return
  }
  if (e.type === 'control') {
    const row = appendMsg('system', e.text)
    row.dataset.runtimeEvent = 'control'
    row.dataset.state = e.state
  }
}

function stripAnsi(s) {
  return String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
}

/** U3：可折叠写后 cell（对照 CLI history cell） */
function appendFileChangeCell(e) {
  const collapsed = stripAnsi(e.cellCollapsed || e.summaryLine || '')
  const expanded = stripAnsi(
    e.cellExpanded ||
      [e.summaryLine, e.ansiUnified].filter(Boolean).join('\n') ||
      '',
  )
  const headLine =
    (collapsed.split('\n')[0] ||
      `✓ ${e.name}${e.path ? '  ' + e.path : ''}`) + ''

  const wrap = document.createElement('div')
  wrap.className = 'msg system file-change-cell'

  if (!expanded || expanded === headLine || expanded === collapsed) {
    wrap.textContent = collapsed || headLine
    logEl.appendChild(wrap)
    if (logEl.dataset.hydrated === 'true') {
      motionFrom(wrap, { y: 6, scale: 0.995, duration: 0.2 })
    }
    syncEmptyWorkspace()
    logEl.scrollTop = logEl.scrollHeight
    return wrap
  }

  const details = document.createElement('details')
  details.className = 'file-change-details'
  const summary = document.createElement('summary')
  summary.textContent = headLine
  const pre = document.createElement('pre')
  pre.className = 'file-change-body'
  const bodyLines = expanded.split('\n')
  const body =
    bodyLines[0] === headLine ? bodyLines.slice(1).join('\n') : expanded
  pre.textContent = body.trim() || expanded
  details.appendChild(summary)
  details.appendChild(pre)
  wrap.appendChild(details)
  logEl.appendChild(wrap)
  if (logEl.dataset.hydrated === 'true') {
    motionFrom(wrap, { y: 6, scale: 0.995, duration: 0.2 })
  }
  syncEmptyWorkspace()
  logEl.scrollTop = logEl.scrollHeight
  return wrap
}

function ensureStreamBubble() {
  if (!streamEl) {
    streamEl = appendMsg('assistant', '')
    streamEl.classList.add('streaming')
    streamBuf = ''
    streamDirty = false
  }
  return streamEl
}

/* ─────────────────────────────────────────────
   视图切换 / 任务板 / 环境信息面板（数据全部来自
   runtimeClient snapshot 与 getStatus —— 零新 IPC）
   ───────────────────────────────────────────── */

function transitionWorkspaceView(outgoing, incoming, direction = 1) {
  if (!outgoing || !incoming || outgoing === incoming) return
  if (!motionEnabled()) {
    outgoing.hidden = true
    incoming.hidden = false
    clearMotion(outgoing)
    clearMotion(incoming)
    return
  }

  motion.killTweensOf([outgoing, incoming])
  const timeline = motion.timeline({ defaults: { overwrite: 'auto' } })
  if (!outgoing.hidden) {
    timeline.to(outgoing, {
      autoAlpha: 0,
      x: direction * -16,
      duration: 0.15,
      ease: 'power1.in',
      onComplete: () => {
        outgoing.hidden = true
        clearMotion(outgoing)
      },
    })
  }
  timeline.add(() => {
    incoming.hidden = false
    motion.set(incoming, { autoAlpha: 0, x: direction * 16 })
  })
  timeline.to(
    incoming,
    {
      autoAlpha: 1,
      x: 0,
      duration: 0.24,
      ease: 'power2.out',
      clearProps: MOTION_CLEAR_PROPS,
    },
    '+=0.01',
  )
  return timeline
}

function switchView(name) {
  if (currentView === name) return
  const previousView = currentView
  currentView = name
  const isChat = name === 'chat'
  transitionWorkspaceView(
    previousView === 'chat' ? viewChat : viewCapability,
    isChat ? viewChat : viewCapability,
    isChat ? -1 : 1,
  )
  if (isChat) {
    clearCapabilityNav()
    if (sessionTitleEl) sessionTitleEl.textContent = lastActiveSessionTitle
    promptEl.focus()
  }
}

const CAPABILITY_PAGES = {
  automation: {
    title: '自动化',
    desc: '定时触发与事件 hooks 经配置文件定义：在 ~/.bolo/config.json 的 hooks 段声明触发条件与动作，CLI 与桌面共用同一份配置。图形化编辑器将在后续版本提供。',
    path: '~/.bolo/config.json · hooks',
    icon: ['M12 8v4l3 2', 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z'],
  },
  skills: {
    title: 'Skills',
    desc: '技能包（SKILL.md）为智能体扩展领域能力，经配置目录管理，CLI 与桌面共用。图形化管理将在后续版本提供。',
    path: '~/.bolo/skills',
    icon: [
      'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
      'M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
    ],
  },
  plugins: {
    title: '插件',
    desc: '插件扩展智能体的工具与通道，经配置目录管理。图形化管理将在后续版本提供。',
    path: '~/.bolo/plugins',
    icon: [
      'M14 7V5a2 2 0 0 0-4 0v2H7a2 2 0 0 0-2 2v3h2a2 2 0 1 1 0 4H5v3a2 2 0 0 0 2 2h3v-2a2 2 0 1 1 4 0v2h3a2 2 0 0 0 2-2v-3h-2a2 2 0 1 1 0-4h2V9a2 2 0 0 0-2-2z',
    ],
  },
  connectors: {
    title: '连接器',
    desc: 'MCP 连接器为当前工作区提供外部工具和资源。连接配置与 CLI 共用，可在项目或用户配置目录中管理。',
    path: '~/.bolo/mcp.json · <project>/.bolo/mcp.json',
    icon: [
      'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7',
      'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    ],
  },
}

function clearCapabilityNav() {
  for (const btn of [navAutomation, navSkills, navPlugins]) {
    btn?.classList.remove('active')
    btn?.removeAttribute('aria-current')
  }
}

function showCapability(kind) {
  const page = CAPABILITY_PAGES[kind]
  if (!page) return
  const previousView = currentView
  currentView = 'capability'
  transitionWorkspaceView(
    previousView === 'chat' ? viewChat : viewCapability,
    viewCapability,
    1,
  )
  clearCapabilityNav()
  const navBtn =
    kind === 'automation'
      ? navAutomation
      : kind === 'skills'
        ? navSkills
        : kind === 'plugins'
          ? navPlugins
          : null
  navBtn?.classList.add('active')
  navBtn?.setAttribute('aria-current', 'page')
  if (capIcon) {
    capIcon.replaceChildren()
    capIcon.appendChild(svgIcon(page.icon))
  }
  if (capTitle) capTitle.textContent = page.title
  if (capDesc) capDesc.textContent = page.desc
  if (capPath) capPath.textContent = page.path
  if (sessionTitleEl) sessionTitleEl.textContent = page.title
}

/** 任务行：状态点 + 标题 + kind 徽章 + state + 相对时间 */
function taskRow({ title, kind, state, updatedAt }) {
  const row = document.createElement('div')
  row.className = 'task-row'
  row.dataset.state = state || ''
  const dot = document.createElement('span')
  dot.className = 'task-dot'
  row.appendChild(dot)
  const titleEl = document.createElement('span')
  titleEl.className = 'task-title'
  titleEl.textContent = title || '(no description)'
  titleEl.title = title || ''
  row.appendChild(titleEl)
  if (kind) {
    const kindEl = document.createElement('span')
    kindEl.className = 'task-kind'
    kindEl.textContent = kind
    row.appendChild(kindEl)
  }
  const stateEl = document.createElement('span')
  stateEl.className = 'task-state'
  const time = formatRelativeTime(updatedAt)
  stateEl.textContent = time ? `${state} · ${time}` : String(state || '')
  row.appendChild(stateEl)
  return row
}

function firstLineOf(text, max = 90) {
  const line = String(text || '').split('\n')[0].trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function sourceRow({ label, detail, icon = FOLDER_PATHS }) {
  const row = document.createElement('div')
  row.className = 'board-source-row'
  row.appendChild(svgIcon(icon))
  const text = document.createElement('span')
  text.className = 'board-source-text'
  const labelEl = document.createElement('span')
  labelEl.textContent = label
  text.appendChild(labelEl)
  if (detail) {
    const detailEl = document.createElement('small')
    detailEl.textContent = detail
    detailEl.title = detail
    text.appendChild(detailEl)
  }
  row.appendChild(text)
  return row
}

function renderPanelSources() {
  if (!panelEls.sources) return
  panelEls.sources.replaceChildren()
  if (currentWorkspaceCwd) {
    panelEls.sources.appendChild(
      sourceRow({
        label: projectNameOf(currentWorkspaceCwd) || '工作区',
        detail: currentWorkspaceCwd,
      }),
    )
  }
  for (const filePath of selectedAttachmentPaths) {
    panelEls.sources.appendChild(
      sourceRow({
        label: projectNameOf(filePath),
        detail: filePath,
        icon: [
          'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
          'M14 2v6h6',
        ],
      }),
    )
  }
  if (lastDetailsStatus) {
    const provider =
      lastDetailsStatus.providerId || lastDetailsStatus.providerKind || 'Provider'
    panelEls.sources.appendChild(
      sourceRow({
        label: provider,
        detail: lastDetailsStatus.model || '默认模型',
        icon: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M8 12h8M12 8v8'],
      }),
    )
  }
}

/**
 * 任务板的子智能体区。runtime snapshot 已在 packages 中完成解析与校验，
 * renderer 只呈现，不维护第二套运行时状态。
 */
function fillPanelTasks() {
  const session = runtimeClient.getSnapshot()?.session
  const tasks = Array.isArray(session?.tasks) ? session.tasks : []

  if (panelEls.agents) {
    const taskSignature = tasks
      .slice(-6)
      .map((task) => `${task.id || task.description || ''}:${task.state}:${task.updatedAt || ''}`)
      .join('|')
    const tasksChanged = panelEls.agents.dataset.motionKey !== taskSignature
    panelEls.agents.dataset.motionKey = taskSignature
    panelEls.agents.replaceChildren()
    const activeCount = tasks.filter((t) =>
      ['queued', 'admitted', 'running'].includes(t.state),
    ).length
    if (panelEls.agentsCount) {
      panelEls.agentsCount.textContent =
        activeCount > 0 ? `${activeCount} 进行中` : `${tasks.length} 个`
    }
    for (const t of tasks.slice(-6).reverse()) {
      panelEls.agents.appendChild(
        taskRow({
          title: firstLineOf(t.description || t.prompt || t.agentType, 60),
          kind: t.agentType,
          state: t.state,
          updatedAt: t.updatedAt,
        }),
      )
    }
    if (tasksChanged) {
      motionStagger(panelEls.agents.children, {
        y: 4,
        scale: 0.995,
        duration: 0.18,
        each: 0.025,
      })
    }
  }
  renderPanelSources()
}

/** 任务板的当前会话段（getStatus 数据） */
function fillDetailsPanel(s) {
  if (!s || typeof s !== 'object') return
  lastDetailsStatus = s
  if (panelEls.runtime) {
    panelEls.runtime.textContent = runtimeClient.getState()?.status || '—'
  }
  if (panelEls.local) {
    panelEls.local.textContent = projectNameOf(s.cwd || currentWorkspaceCwd) || '本地'
    panelEls.local.title = s.cwd || currentWorkspaceCwd || ''
  }
  if (panelEls.session) {
    panelEls.session.textContent = s.id ? String(s.id).slice(0, 8) : '—'
    panelEls.session.title = s.id || ''
  }
  if (panelEls.mode) panelEls.mode.textContent = s.permissionMode ?? '—'
  if (s.cwd) currentWorkspaceCwd = s.cwd
  updateSettingsOverview(s)
  renderPanelSources()
  // composer 权限胶囊与 status 同源：切会话/改设置都要跟手
  if (composerMode && s.permissionMode && composerMode.value !== s.permissionMode) {
    composerMode.value = s.permissionMode
  }
  syncCustomSelect(composerMode)
}

function fillDetailsCwd(cwd) {
  currentWorkspaceCwd = cwd || ''
  if (panelEls.local) {
    panelEls.local.textContent = projectNameOf(cwd) || '本地'
    panelEls.local.title = cwd || ''
  }
  renderPanelSources()
}

/** composer 权限模式胶囊：即时生效（setSettings 部分补丁，不重建会话） */
async function applyComposerMode(value) {
  try {
    const r = await window.bolo.setSettings({ permissionMode: value })
    if (!r?.ok) {
      appendMsg('system', `Permission mode change failed: ${r?.error ?? 'unknown'}`)
    }
  } catch (e) {
    appendMsg('system', `Permission mode change error: ${e?.message ?? e}`)
  } finally {
    await refreshStatus()
  }
}

/** 设置卡片的分区导航 */
function settingsNavItems() {
  return [...document.querySelectorAll('.settings-nav-item')]
}

function settingsSections() {
  return [...document.querySelectorAll('.settings-section')]
}

function selectSettingsSection(target) {
  const items = settingsNavItems()
  const sections = settingsSections()
  const item = items.find((entry) => entry.dataset.section === target && !entry.hidden)
  if (!item) return false
  const current = sections.find((section) => !section.hidden)
  for (const entry of items) entry.classList.toggle('active', entry === item)
  for (const section of sections) section.hidden = section.dataset.section !== target
  const next = sections.find((section) => section.dataset.section === target)
  if (next && next !== current) motionFrom(next, { x: 10, y: 0, scale: 0.997, duration: 0.18 })
  return true
}

function applySettingsSearch(query = '') {
  const needle = String(query).trim().toLocaleLowerCase()
  const items = settingsNavItems()
  const sections = settingsSections()
  const titles = [...document.querySelectorAll('.settings-nav-title')]
  let firstMatch = null

  for (const item of items) {
    const section = sections.find((entry) => entry.dataset.section === item.dataset.section)
    const haystack = `${item.textContent} ${section?.textContent || ''}`.toLocaleLowerCase()
    const match = !needle || haystack.includes(needle)
    item.hidden = !match
    if (match && !firstMatch) firstMatch = item
  }

  for (const title of titles) title.hidden = Boolean(needle)
  if (!needle) {
    if (settingsSearchEmpty) settingsSearchEmpty.hidden = true
    const active = items.find((item) => item.classList.contains('active') && !item.hidden)
    selectSettingsSection(active?.dataset.section || items[0]?.dataset.section)
    return
  }

  if (firstMatch) {
    if (settingsSearchEmpty) settingsSearchEmpty.hidden = true
    selectSettingsSection(firstMatch.dataset.section)
  } else {
    for (const section of sections) section.hidden = true
    if (settingsSearchEmpty) settingsSearchEmpty.hidden = false
  }
}

function initSettingsNav() {
  for (const item of settingsNavItems()) {
    item.addEventListener('click', () => {
      if (settingsSearch) settingsSearch.value = ''
      applySettingsSearch('')
      selectSettingsSection(item.dataset.section)
    })
  }
  settingsSearch?.addEventListener('input', () => applySettingsSearch(settingsSearch.value))
}

function resetSettingsNav() {
  if (settingsSearch) settingsSearch.value = ''
  if (settingsSearchEmpty) settingsSearchEmpty.hidden = true
  for (const item of settingsNavItems()) item.hidden = false
  for (const title of document.querySelectorAll('.settings-nav-title')) title.hidden = false
  const items = settingsNavItems()
  items.forEach((item, index) => item.classList.toggle('active', index === 0))
  selectSettingsSection(items[0]?.dataset.section)
}

function closeSettings() {
  if (!settingsEl) return
  closeCustomSelect()
  closeMenu()
  hideModal(settingsEl, settingsEl.querySelector('.settings-card'), () => {
    resetSettingsNav()
    promptEl?.focus()
  })
}

function syncSettingsThemeLabel() {
  const light = document.documentElement.dataset.theme === 'light'
  if (settingsThemeValue) settingsThemeValue.textContent = light ? '浅色' : '深色'
  if (settingsThemeToggle) {
    settingsThemeToggle.setAttribute('aria-label', light ? '切换到深色主题' : '切换到浅色主题')
    settingsThemeToggle.title = light ? '切换到深色主题' : '切换到浅色主题'
  }
}

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  try {
    localStorage.setItem('bolo.theme', next)
  } catch {
    /* 主题偏好保存失败时仍保留本次会话的显示 */
  }
  syncSettingsThemeLabel()
}

function toggleTheme(event) {
  const source = event?.currentTarget || btnTheme
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
  if (motionEnabled() && source) {
    motion.fromTo(
      source,
      { rotation: -8, scale: 0.94 },
      {
        rotation: 0,
        scale: 1,
        duration: 0.24,
        ease: 'back.out(1.7)',
        clearProps: 'transform',
        overwrite: 'auto',
      },
    )
  }
}

function updateSettingsOverview(settings) {
  const runtime = runtimeClient.getState?.() || {}
  if (settingsRuntimeValue) {
    settingsRuntimeValue.textContent = runtime.status || 'disconnected'
  }
  if (settingsProviderValue) {
    const provider = lastProviders.find((entry) => entry.id === activeProviderId)
    settingsProviderValue.textContent = provider?.label || provider?.id || activeProviderId || '未配置'
    settingsProviderValue.title = provider?.model ? `${provider.id} · ${provider.model}` : provider?.id || ''
  }
  if (settingsWorkspaceValue) {
    const cwd = settings?.cwd || currentWorkspaceCwd
    settingsWorkspaceValue.textContent = projectNameOf(cwd) || '本地工作区'
    settingsWorkspaceValue.title = cwd || ''
  }
}

/* ─────────────────────────────────────────────
   弹出菜单（用户区 / 附件 / 项目 / 会话右键共用）
   ───────────────────────────────────────────── */

let activeMenu = null
let activeMenuAnchor = null
let activeSelectPopover = null
let activeSelectRoot = null
let activeSelectTrigger = null
let selectPopoverSequence = 0

const PERMISSION_MODE_DETAILS = {
  default: '按需询问：敏感操作执行前由你确认',
  acceptEdits: '自动接受文件修改，其他高风险操作仍需确认',
  plan: '只分析并制定方案，不直接修改文件或执行命令',
  auto: '在安全范围内自动执行，必要时再询问',
  bypassPermissions: '跳过所有权限确认，仅用于完全可信的环境',
}

const EFFORT_DETAILS = {
  auto: '自动匹配当前任务的推理强度',
  low: '快速响应，使用较少推理',
  medium: '平衡响应速度与分析深度',
  high: '深入分析复杂问题',
  max: '使用最大推理强度，响应时间更长',
}

function closeProjectPop() {
  if (projectPopHideTimer) {
    window.clearTimeout(projectPopHideTimer)
    projectPopHideTimer = null
  }
  const pop = activeProjectPop
  activeProjectPop = null
  if (!pop) return
  pop.classList.remove('is-visible')
  if (motionEnabled()) {
    pop.style.pointerEvents = 'none'
    motion.killTweensOf(pop)
    motion.to(pop, {
      autoAlpha: 0,
      x: -4,
      duration: 0.12,
      ease: 'power1.in',
      overwrite: 'auto',
      onComplete: () => {
        pop.remove()
        clearMotion(pop)
      },
    })
  } else {
    pop.remove()
  }
}

function scheduleProjectPopClose() {
  if (projectPopHideTimer) window.clearTimeout(projectPopHideTimer)
  projectPopHideTimer = window.setTimeout(() => closeProjectPop(), 120)
}

function customSelectOptionPresentation(select, option) {
  const value = option?.value || ''
  const fallbackLabel = option?.textContent?.trim() || value || '无可用选项'

  if (select.id === 'composer-mode') {
    return {
      label: fallbackLabel,
      description: PERMISSION_MODE_DETAILS[value] || '权限模式',
    }
  }

  if (select.id === 'composer-effort') {
    return {
      label: fallbackLabel,
      description: EFFORT_DETAILS[value] || '自定义推理强度',
    }
  }

  if (select.id === 'composer-model') {
    return {
      label: fallbackLabel,
      description: value === select.value ? '当前会话模型' : '切换到此模型',
    }
  }

  if (select.id === 'hdr-provider') {
    const provider = lastProviders.find((item) => item.id === value)
    const details = []
    if (provider?.isActive) details.push('当前 Provider')
    if (provider?.kind) details.push(`类型：${provider.kind}`)
    if (provider?.model) details.push(`模型：${provider.model}`)
    return {
      label: fallbackLabel,
      description: details.join(' · ') || '请在设置中添加 Provider',
    }
  }

  return { label: fallbackLabel, description: '' }
}

function syncCustomSelect(select) {
  if (!select) return
  const root = select.closest('.custom-select')
  const trigger = root?.querySelector('.select-trigger')
  const label = trigger?.querySelector('.select-trigger-label')
  if (!root || !trigger || !label) return
  const option = select.selectedOptions?.[0] || select.options?.[0]
  const presentation = customSelectOptionPresentation(select, option)
  label.textContent = presentation.label
  trigger.title = presentation.description
  trigger.disabled = select.disabled || select.options.length === 0
}

function closeCustomSelect({ restoreFocus = false } = {}) {
  const trigger = activeSelectTrigger
  const popover = activeSelectPopover
  const root = activeSelectRoot
  const direction = root?.dataset.direction === 'down' ? 1 : -1
  root?.classList.remove('is-open')
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false')
    trigger.removeAttribute('aria-controls')
  }
  activeSelectPopover = null
  activeSelectRoot = null
  activeSelectTrigger = null
  if (popover && motionEnabled()) {
    popover.style.pointerEvents = 'none'
    motion.killTweensOf(popover)
    motion.to(popover, {
      autoAlpha: 0,
      y: direction * 4,
      scale: 0.985,
      duration: 0.12,
      ease: 'power1.in',
      overwrite: 'auto',
      onComplete: () => {
        popover.remove()
        clearMotion(popover)
      },
    })
  } else {
    popover?.remove()
  }
  if (restoreFocus) trigger?.focus()
}

function focusCustomSelectOption(popover, nextIndex) {
  const options = [...popover.querySelectorAll('.select-option:not(:disabled)')]
  if (options.length === 0) return
  const normalized = (nextIndex + options.length) % options.length
  options[normalized].focus()
}

function positionCustomSelect(root, trigger, popover) {
  const triggerRect = trigger.getBoundingClientRect()
  const direction = root.dataset.direction === 'down' ? 'down' : 'up'
  const requestedWidth = Number(root.dataset.menuWidth) || triggerRect.width
  const width = Math.min(
    window.innerWidth - 16,
    Math.max(triggerRect.width, requestedWidth),
  )
  const availableHeight =
    direction === 'up'
      ? triggerRect.top - 14
      : window.innerHeight - triggerRect.bottom - 14

  popover.style.width = `${width}px`
  popover.style.maxHeight = `${Math.max(96, availableHeight)}px`
  const popoverHeight = popover.offsetHeight
  const alignEnd = root.dataset.align === 'end'
  const rawLeft = alignEnd ? triggerRect.right - width : triggerRect.left
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - width - 8))
  const rawTop =
    direction === 'up'
      ? triggerRect.top - popoverHeight - 6
      : triggerRect.bottom + 6
  const top = Math.max(
    8,
    Math.min(rawTop, window.innerHeight - popoverHeight - 8),
  )
  popover.style.left = `${left}px`
  popover.style.top = `${top}px`
}

function openCustomSelect(root) {
  const select = root?.querySelector('.native-select-sync')
  const trigger = root?.querySelector('.select-trigger')
  if (!select || !trigger || trigger.disabled) return

  closeMenu()
  closeCustomSelect()
  closeProjectPop()

  const popover = document.createElement('div')
  const direction = root.dataset.direction === 'down' ? 'down' : 'up'
  popover.className = 'select-popover'
  popover.dataset.direction = direction
  popover.id = `select-popover-${++selectPopoverSequence}`
  popover.setAttribute('role', 'listbox')
  popover.setAttribute('aria-label', select.getAttribute('aria-label') || 'Options')

  for (const option of select.options) {
    const row = document.createElement('button')
    const presentation = customSelectOptionPresentation(select, option)
    row.type = 'button'
    row.className = 'select-option'
    row.dataset.value = option.value
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(option.value === select.value))
    row.disabled = option.disabled || !option.value

    const label = document.createElement('span')
    label.className = 'select-option-label'
    label.textContent = presentation.label
    row.appendChild(label)

    if (presentation.description) {
      const description = document.createElement('span')
      description.className = 'select-option-description'
      description.textContent = presentation.description
      row.appendChild(description)
    }

    row.addEventListener('click', () => {
      if (row.disabled) return
      select.value = option.value
      syncCustomSelect(select)
      closeCustomSelect({ restoreFocus: true })
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    row.addEventListener('keydown', (event) => {
      const options = [...popover.querySelectorAll('.select-option:not(:disabled)')]
      const index = options.indexOf(row)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        focusCustomSelectOption(popover, index + (event.key === 'ArrowDown' ? 1 : -1))
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        focusCustomSelectOption(popover, event.key === 'Home' ? 0 : options.length - 1)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeCustomSelect({ restoreFocus: true })
      } else if (event.key === 'Tab') {
        closeCustomSelect()
      }
    })
    popover.appendChild(row)
  }

  document.body.appendChild(popover)
  positionCustomSelect(root, trigger, popover)
  root.classList.add('is-open')
  trigger.setAttribute('aria-expanded', 'true')
  trigger.setAttribute('aria-controls', popover.id)
  activeSelectPopover = popover
  activeSelectRoot = root
  activeSelectTrigger = trigger

  motionFrom(popover, {
    y: direction === 'up' ? 6 : -6,
    scale: 0.985,
    duration: 0.16,
  })
  motionStagger(popover.querySelectorAll('.select-option'), {
    y: direction === 'up' ? 4 : -4,
    scale: 0.995,
    duration: 0.14,
    each: 0.018,
  })

  const selected = popover.querySelector('.select-option[aria-selected="true"]')
  const fallback = popover.querySelector('.select-option:not(:disabled)')
  window.requestAnimationFrame(() => (selected || fallback)?.focus())
}

function initCustomSelects() {
  for (const root of document.querySelectorAll('.custom-select')) {
    const select = root.querySelector('.native-select-sync')
    const trigger = root.querySelector('.select-trigger')
    if (!select || !trigger) continue
    syncCustomSelect(select)
    select.addEventListener('change', () => syncCustomSelect(select))
    trigger.addEventListener('click', () => {
      if (activeSelectRoot === root) closeCustomSelect({ restoreFocus: true })
      else openCustomSelect(root)
    })
    trigger.addEventListener('keydown', (event) => {
      if (!['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return
      event.preventDefault()
      if (activeSelectRoot !== root) openCustomSelect(root)
    })
  }
}

function positionProjectPop(anchor, pop) {
  const anchorRect = anchor.getBoundingClientRect()
  const popRect = pop.getBoundingClientRect()
  const rightLeft = anchorRect.right + 10
  const left =
    rightLeft + popRect.width <= window.innerWidth - 8
      ? rightLeft
      : Math.max(8, anchorRect.left - popRect.width - 10)
  const top = Math.max(
    8,
    Math.min(anchorRect.top - 4, window.innerHeight - popRect.height - 8),
  )
  pop.style.left = `${left}px`
  pop.style.top = `${top}px`
}

function bindProjectPop(anchor, pop) {
  const show = () => {
    if (projectPopHideTimer) {
      window.clearTimeout(projectPopHideTimer)
      projectPopHideTimer = null
    }
    if (activeProjectPop === pop) return
    closeProjectPop()
    activeProjectPop = pop
    document.body.appendChild(pop)
    positionProjectPop(anchor, pop)
    pop.style.pointerEvents = 'auto'
    motionFrom(pop, { x: -5, y: 0, scale: 0.985, duration: 0.16, delay: 0.12 })
    window.requestAnimationFrame(() => {
      if (activeProjectPop === pop) pop.classList.add('is-visible')
    })
  }

  anchor.addEventListener('pointerenter', show)
  anchor.addEventListener('pointerleave', scheduleProjectPopClose)
  anchor.addEventListener('focusin', show)
  anchor.addEventListener('focusout', scheduleProjectPopClose)
  pop.addEventListener('pointerenter', () => {
    if (projectPopHideTimer) {
      window.clearTimeout(projectPopHideTimer)
      projectPopHideTimer = null
    }
  })
  pop.addEventListener('pointerleave', scheduleProjectPopClose)
}

function closeMenu() {
  const menu = activeMenu
  activeMenu = null
  if (activeMenuAnchor) {
    activeMenuAnchor.classList.remove('menu-open')
    activeMenuAnchor = null
  }
  if (!menu) return
  if (motionEnabled()) {
    menu.style.pointerEvents = 'none'
    motion.killTweensOf(menu)
    motion.to(menu, {
      autoAlpha: 0,
      y: -4,
      scale: 0.985,
      duration: 0.12,
      ease: 'power1.in',
      overwrite: 'auto',
      onComplete: () => {
        menu.remove()
        clearMotion(menu)
      },
    })
  } else {
    menu.remove()
  }
}

/**
 * items: { label, hint?, icon?: string[], danger?, disabled?, onClick?, header? } | 'sep'
 * anchor: 触发元素（可选，用于 menu-open 态）；up: 向上弹出（左下角用户区）
 */
function openMenu(items, { x, y, anchor = null, up = false } = {}) {
  closeCustomSelect()
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'app-menu'
  menu.setAttribute('role', 'menu')
  for (const item of items) {
    if (item === 'sep') {
      const sep = document.createElement('div')
      sep.className = 'menu-sep'
      menu.appendChild(sep)
      continue
    }
    if (item.header) {
      const head = document.createElement('div')
      head.className = 'menu-header'
      head.textContent = item.header
      menu.appendChild(head)
      continue
    }
    const row = document.createElement('button')
    row.type = 'button'
    row.className =
      'menu-item' + (item.disabled ? ' disabled' : '') + (item.danger ? ' danger' : '')
    row.setAttribute('role', 'menuitem')
    if (item.icon) row.appendChild(svgIcon(item.icon))
    const label = document.createElement('span')
    label.textContent = item.label
    row.appendChild(label)
    if (item.hint) {
      const hint = document.createElement('span')
      hint.className = 'menu-hint'
      hint.textContent = item.hint
      row.appendChild(hint)
    }
    if (!item.disabled && item.onClick) {
      row.addEventListener('click', () => {
        closeMenu()
        item.onClick()
      })
    }
    menu.appendChild(row)
  }
  document.body.appendChild(menu)
  // 边界防溢出
  const rect = menu.getBoundingClientRect()
  let left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
  let top = up ? y - rect.height - 6 : y
  top = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8))
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  activeMenu = menu
  activeMenuAnchor = anchor
  if (anchor) anchor.classList.add('menu-open')
  motionFrom(menu, { y: up ? 4 : -4, scale: 0.98, duration: 0.16 })
  motionStagger(menu.querySelectorAll('.menu-header, .menu-item'), {
    y: up ? -3 : 3,
    scale: 0.997,
    duration: 0.13,
    each: 0.018,
  })
}

document.addEventListener('pointerdown', (ev) => {
  if (!activeMenu) return
  if (activeMenu.contains(ev.target)) return
  if (activeMenuAnchor && activeMenuAnchor.contains(ev.target)) return
  closeMenu()
})

document.addEventListener('pointerdown', (event) => {
  if (!activeSelectPopover) return
  if (activeSelectPopover.contains(event.target)) return
  if (activeSelectTrigger?.contains(event.target)) return
  closeCustomSelect()
})

sessionListEl?.addEventListener('scroll', () => closeProjectPop(), { passive: true })
window.addEventListener('resize', () => {
  closeProjectPop()
  closeCustomSelect()
})

/** localStorage 偏好（置顶/隐藏/侧栏）——读取失败一律回退空 */
function readPref(key) {
  try {
    const raw = localStorage.getItem(key)
    const value = raw ? JSON.parse(raw) : []
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 存不了就只影响本次会话 */
  }
}

function readPrefMap(key) {
  try {
    const raw = localStorage.getItem(key)
    const value = raw ? JSON.parse(raw) : {}
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function writePrefMap(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 本地显示名称保存失败不影响会话 */
  }
}

function setPrefItems(key, items, enabled) {
  const list = readPref(key)
  const next = new Set(list)
  for (const item of items) {
    if (enabled) next.add(item)
    else next.delete(item)
  }
  writePref(key, [...next])
}

function togglePrefItem(key, item) {
  const list = readPref(key)
  const idx = list.indexOf(item)
  if (idx >= 0) list.splice(idx, 1)
  else list.push(item)
  writePref(key, list)
  return idx < 0 // true = 现在是置顶/隐藏态
}

function renameLocalItem(key, id, value) {
  const aliases = readPrefMap(key)
  const next = String(value || '').trim()
  if (next) aliases[id] = next
  else delete aliases[id]
  writePrefMap(key, aliases)
}

function closeRenameDialog() {
  if (!renameDialog) return
  pendingRenameSubmit = null
  hideModal(renameDialog, renameDialog.querySelector('.rename-card'), () => {
    promptEl.focus()
  })
}

function openRenameDialog({ title, label, value, onSubmit }) {
  if (!renameDialog || !renameInput) return
  closeMenu()
  if (renameTitle) renameTitle.textContent = title
  if (renameLabel) renameLabel.textContent = label
  renameInput.value = value || ''
  pendingRenameSubmit = onSubmit
  showModal(renameDialog, renameDialog.querySelector('.rename-card'))
  requestAnimationFrame(() => {
    renameInput.focus()
    renameInput.select()
  })
}

async function openWorkspacePath(cwd) {
  if (!cwd || !window.bolo?.openPath) return
  try {
    const result = await window.bolo.openPath(cwd)
    if (!result?.ok) {
      appendMsg('system', `Open path failed: ${result?.error ?? 'unknown'}`)
    }
  } catch (error) {
    appendMsg('system', `Open path error: ${error?.message ?? error}`)
  }
}

async function copyText(text, okMessage) {
  if (!text) return
  let ok = false
  try {
    await navigator.clipboard.writeText(text)
    ok = true
  } catch {
    // fallback：隐藏 textarea + execCommand（部分沙箱环境 clipboard 受限）
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
  }
  appendMsg('system', ok ? okMessage : 'Copy failed — clipboard unavailable.')
}

/* ─────────────────────────────────────────────
   用户区 / 侧栏开关 / 新建任务
   ───────────────────────────────────────────── */

function fillUserCard(cwd) {
  const name = projectNameOf(cwd) || 'Workspace'
  if (userName) {
    userName.textContent = name
    userName.title = cwd || ''
  }
  if (userAvatarLetter) userAvatarLetter.textContent = name.slice(0, 1).toUpperCase()
}

function openUserMenu() {
  const s = runtimeClient.getState()
  const runtimeLine =
    s.status === 'ready'
      ? `runtime v${s.protocolVersion} ready`
      : `runtime ${s.status}`
  const rect = userCard.getBoundingClientRect()
  openMenu(
    [
      { header: userName?.textContent || 'Workspace' },
      {
        label: '剩余用量',
        hint: composerUsage?.textContent || runtimeLine,
        disabled: true,
        icon: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
      },
      {
        label: '界面外观',
        icon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'],
        onClick: () => btnTheme?.click(),
      },
      {
        label: '设置',
        hint: 'Ctrl+,',
        icon: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
        onClick: () => void openSettings(),
      },
      'sep',
      {
        label: '退出登录',
        hint: '本地模式',
        disabled: true,
        icon: ['M10 17l5-5-5-5', 'M15 12H3', 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4'],
      },
    ],
    { x: rect.left, y: rect.top, anchor: userCard, up: true },
  )
}

function setSidebarHidden(hidden) {
  const sidebar = document.querySelector('.sidebar')
  if (!sidebar || !motionEnabled()) {
    document.body.classList.toggle('sidebar-hidden', hidden)
    writePref('bolo.sidebarHidden', hidden ? [1] : [])
    return
  }

  motion.killTweensOf(sidebar)
  if (hidden) {
    motion.to(sidebar, {
      autoAlpha: 0,
      x: -18,
      duration: 0.2,
      ease: 'power1.in',
      overwrite: 'auto',
      onComplete: () => {
        document.body.classList.add('sidebar-hidden')
        clearMotion(sidebar)
      },
    })
  } else {
    document.body.classList.remove('sidebar-hidden')
    motionFrom(sidebar, { x: -18, y: 0, scale: 1, duration: 0.24 })
  }
  writePref('bolo.sidebarHidden', hidden ? [1] : [])
}

function initSidebarState() {
  if (readPref('bolo.sidebarHidden').length > 0) {
    document.body.classList.add('sidebar-hidden')
  }
}

/** 新建任务 = 用当前设置重建会话（main 的 setSettings recreate 通道） */
async function startNewSession() {
  if (selectingSession) return
  selectingSession = true
  try {
    const r = await window.bolo.setSettings({ recreate: true })
    if (!r?.ok) {
      appendMsg('system', `New session failed: ${r?.error ?? 'unknown'}`)
      return
    }
    if (currentView !== 'chat') switchView('chat')
    // 悬挂状态清掉（与切会话同理）
    currentPermId = null
    hideModal(permEl, permEl.querySelector('.perm-card'))
    currentAskId = null
    closeAsk()
    endStreamBubble()
    await runtimeClient.refresh()
    await refreshStatus()
    await refreshProviders()
    await refreshSessions()
    if (!(await reloadTimeline())) await reloadMessages()
    await refreshComposerActions()
    try {
      const s = await window.bolo.getSettings()
      fillDetailsCwd(s?.cwd)
      fillUserCard(s?.cwd)
      if (composerMode && s?.permissionMode) {
        composerMode.value = s.permissionMode
        syncCustomSelect(composerMode)
      }
    } catch {
      /* 面板少一项不挡新建 */
    }
    promptEl.focus()
  } catch (e) {
    appendMsg('system', `New session error: ${e?.message ?? e}`)
  } finally {
    selectingSession = false
  }
}

function renderComposerAttachments() {
  if (!composerAttachments) return
  composerAttachments.replaceChildren()
  const hasAttachments = selectedAttachmentPaths.length > 0
  if (hasAttachments) {
    motionShow(composerAttachments, { y: 4, scale: 0.995, duration: 0.16 })
  } else {
    motionHide(composerAttachments, { y: -3, scale: 0.995, duration: 0.12 })
  }
  for (const filePath of selectedAttachmentPaths) {
    const chip = document.createElement('span')
    chip.className = 'attachment-chip'
    chip.title = filePath
    chip.appendChild(
      svgIcon([
        'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
        'M14 2v6h6',
      ]),
    )
    const label = document.createElement('span')
    label.textContent = projectNameOf(filePath)
    chip.appendChild(label)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.setAttribute('aria-label', `Remove ${projectNameOf(filePath)}`)
    remove.title = '移除附件'
    remove.appendChild(svgIcon(['M18 6 6 18M6 6l12 12']))
    remove.addEventListener('click', () => {
      selectedAttachmentPaths = selectedAttachmentPaths.filter(
        (item) => item !== filePath,
      )
      renderComposerAttachments()
      renderPanelSources()
      void refreshComposerActions()
    })
    chip.appendChild(remove)
    composerAttachments.appendChild(chip)
  }
  motionStagger(composerAttachments.querySelectorAll('.attachment-chip'), {
    y: 4,
    scale: 0.98,
    duration: 0.16,
    each: 0.025,
  })
}

async function chooseAttachmentFiles() {
  if (!window.bolo?.pickFiles) return
  try {
    const result = await window.bolo.pickFiles()
    if (!result?.ok) {
      if (!result?.cancelled) {
        appendMsg('system', `Choose files failed: ${result?.error ?? 'unknown'}`)
      }
      return
    }
    const paths = Array.isArray(result.paths)
      ? result.paths.filter((item) => typeof item === 'string' && item)
      : []
    selectedAttachmentPaths = [...new Set([...selectedAttachmentPaths, ...paths])]
    renderComposerAttachments()
    renderPanelSources()
    await refreshComposerActions()
    promptEl.focus()
  } catch (error) {
    appendMsg('system', `Choose files error: ${error?.message ?? error}`)
  }
}

function composerTextWithAttachments(promptText) {
  if (selectedAttachmentPaths.length === 0) return promptText
  const references = selectedAttachmentPaths
    .map((filePath) => `- ${filePath}`)
    .join('\n')
  return [promptText, `Attached files:\n${references}`].filter(Boolean).join('\n\n')
}

/** composer "+"：文件选择、斜杠命令与连接器入口。 */
function openAttachMenu() {
  const rect = btnAttach.getBoundingClientRect()
  openMenu(
    [
      {
        label: '斜杠命令',
        hint: '/help',
        icon: ['M7 8l-4 4 4 4M17 8l4 4-4 4M13 5l-2 14'],
        onClick: () => {
          promptEl.value = '/'
          promptEl.dispatchEvent(new Event('input', { bubbles: true }))
          promptEl.focus()
        },
      },
      'sep',
      {
        label: '添加文件引用',
        icon: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
        onClick: () => void chooseAttachmentFiles(),
      },
      {
        label: '连接器 · MCP',
        hint: '经 ~/.bolo 配置',
        icon: ['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'],
        onClick: () => showCapability('connectors'),
      },
    ],
    { x: rect.left, y: rect.top, anchor: btnAttach, up: true },
  )
}

function endStreamBubble() {
  if (streamEl) streamEl.classList.remove('streaming')
  streamEl = null
  streamBuf = ''
  streamDirty = false
}

// 流式 markdown：rAF 节流重渲染整个缓冲（消息量小，简单可靠）
let streamDirty = false
let streamRaf = 0
function scheduleStreamRender() {
  if (streamDirty || streamRaf) return
  streamDirty = true
  streamRaf = requestAnimationFrame(() => {
    streamRaf = 0
    if (!streamDirty || !streamEl) return
    streamDirty = false
    const bubble = streamEl
    bubble.replaceChildren()
    renderMarkdownInto(bubble, streamBuf)
    logEl.scrollTop = logEl.scrollHeight
  })
}

function formatStatusLine(s) {
  const pid = s.providerId || s.providerKind || '?'
  const kind = s.providerKind ? `/${s.providerKind}` : ''
  const effort = s.effortLevel ? ` · e=${s.effortLevel}` : ''
  const modelMetadata = s.modelMetadata
  const limits = modelMetadata
    ? ` · ctx=${modelMetadata.context.displayTokens} (${modelMetadata.context.sourceLabel}) · out=${modelMetadata.maxOutput.displayTokens} (${modelMetadata.maxOutput.sourceLabel})`
    : ''
  return `id=${String(s.id || '').slice(0, 8)} · mode=${s.permissionMode} · model=${s.model ?? 'unset'} · msgs=${s.messageCount} · ${pid}${kind === `/${pid}` ? '' : kind}${effort}${limits}`
}

function fillSelect(sel, items, activeId, mapLabel) {
  if (!sel) return
  fillingProviderSelect = true
  const prev = sel.value
  sel.innerHTML = ''
  if (!items.length) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.textContent = '(no providers — add preset)'
    sel.appendChild(opt)
  } else {
    for (const it of items) {
      const opt = document.createElement('option')
      opt.value = it.id
      opt.textContent = mapLabel(it)
      if (it.id === activeId) opt.selected = true
      sel.appendChild(opt)
    }
  }
  if (activeId) sel.value = activeId
  else if (prev && [...sel.options].some((o) => o.value === prev)) {
    sel.value = prev
  }
  syncCustomSelect(sel)
  fillingProviderSelect = false
}

function updateEffortHint(data) {
  if (!setEffortDetail) return
  const dialect = data.effortDialect || data.dialectId || '?'
  const level = data.effortLevel || 'auto'
  const ch = Array.isArray(data.effortChoosable)
    ? data.effortChoosable.join(', ')
    : Array.isArray(data.choosable)
      ? data.choosable.join(', ')
      : ''
  setEffortDetail.textContent = ch
    ? `effort=${level} · dialect=${dialect} · choosable: ${ch}`
    : `effort=${level} · dialect=${dialect}`
}

function updateModelMetadataHint(modelMetadata) {
  if (!setModelMetadata) return
  if (!modelMetadata?.context || !modelMetadata?.maxOutput) {
    setModelMetadata.textContent = ''
    motionHide(setModelMetadata, { y: -3, scale: 0.995, duration: 0.12 })
    delete setModelMetadata.dataset.status
    return
  }
  if (setModelMetadata.hidden) {
    motionShow(setModelMetadata, { y: 3, scale: 0.995, duration: 0.16 })
  }
  setModelMetadata.dataset.status = modelMetadata.status || 'ok'
  setModelMetadata.textContent =
    `ctx ${modelMetadata.context.displayTokens} (${modelMetadata.context.sourceLabel})` +
    ` · out ${modelMetadata.maxOutput.displayTokens} (${modelMetadata.maxOutput.sourceLabel})` +
    ` · metadata ${modelMetadata.status || 'ok'}`
}

function fillModelSuggestions(models) {
  if (!setModelSuggestions) return
  setModelSuggestions.innerHTML = ''
  for (const model of models) {
    const option = document.createElement('option')
    option.value = model
    setModelSuggestions.appendChild(option)
  }
}

function fillEffortChoices(choosable, active, target = setEffort) {
  if (!target) return
  const choices = ['auto', ...choosable.filter((value) => value !== 'auto')]
  target.innerHTML = ''
  for (const effort of choices) {
    const option = document.createElement('option')
    option.value = effort
    option.textContent = effort
    target.appendChild(option)
  }
  target.value = choices.includes(active) ? active : 'auto'
  syncCustomSelect(target)
}

function restoreEffortValue(value) {
  if (!setEffort) return
  if (![...setEffort.options].some((option) => option.value === value)) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value
    setEffort.appendChild(option)
  }
  setEffort.value = value
}

function setSettingsError(message) {
  if (!settingsError) return
  settingsError.textContent = message || ''
  if (message) {
    if (settingsError.hidden) {
      motionShow(settingsError, { y: 4, scale: 0.995, duration: 0.16 })
    }
  } else if (!settingsError.hidden) {
    motionHide(settingsError, { y: -3, scale: 0.995, duration: 0.12 })
  }
}

async function refreshProviders() {
  try {
    const data = await window.bolo.listProviders()
    if (!data?.ok) return
    lastProviders = data.providers || []
    lastPresets = data.presets || []
    const active = data.activeId || ''
    activeProviderId = active
    fillSelect(
      hdrProvider,
      lastProviders,
      active,
      (p) =>
        `${p.isActive ? '* ' : ''}${p.id}${p.model ? ` · ${p.model}` : ''}`,
    )
    fillSelect(
      setProvider,
      lastProviders,
      active,
      (p) =>
        `${p.id}  [${p.kind ?? '?'}]  ${p.model ?? ''}${p.hasKeyConfig ? '' : '  (no key env?)'}`,
    )
    fillSelect(setPreset, lastPresets, lastPresets[0]?.id || '', (p) =>
      `${p.id} — ${p.label || p.kind}`,
    )
    if (setModel) setModel.value = data.model || ''
    fillModelSuggestions(data.modelSuggestions || [])
    fillEffortChoices(data.choosable || [], data.effortLevel || 'auto')
    fillEffortChoices(data.choosable || [], data.effortLevel || 'auto', composerEffort)
    // composer 内联模型选择：建议列表 + 当前模型
    if (composerModel) {
      composerModel.innerHTML = ''
      const suggestions = data.modelSuggestions || []
      const all = [data.model, ...suggestions].filter(Boolean)
      const seen = new Set()
      for (const m of all) {
        if (seen.has(m)) continue
        seen.add(m)
        const option = document.createElement('option')
        option.value = m
        option.textContent = m
        if (m === data.model) option.selected = true
        composerModel.appendChild(option)
      }
      syncCustomSelect(composerModel)
    }
    updateModelMetadataHint(data.modelMetadata)
    updateUsageLine(data)
    updateEffortHint(data)
  } catch (e) {
    /* ignore list errors in header */
  }
}

function updateUsageLine(s) {
  if (!composerUsage) return
  if (!s?.usage) {
    composerUsage.textContent = ''
    return
  }
  const u = s.usage
  const parts = []
  if (u.inputTokens) parts.push(`↓${formatCount(u.inputTokens)}`)
  if (u.outputTokens) parts.push(`↑${formatCount(u.outputTokens)}`)
  composerUsage.textContent = parts.join(' ')
}

function formatCount(n) {
  if (n == null || !Number.isFinite(n)) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

async function refreshStatus() {
  try {
    const s = await window.bolo.getStatus()
    statusEl.textContent = formatStatusLine(s)
    updateModelMetadataHint(s.modelMetadata)
    updateEffortHint(s)
    updateUsageLine(s)
    fillDetailsPanel(s)
    updateSettingsOverview(s)
  } catch (e) {
    statusEl.textContent = `error: ${e?.message ?? e}`
  }
}

async function reloadMessages() {
  const list = await window.bolo.listMessages()
  toolRuntimeRows.clear()
  delete logEl.dataset.hydrated
  logEl.innerHTML = ''
  endStreamBubble()
  for (const m of list) {
    appendMsg(
      m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system',
      m.content || '',
    )
  }
  logEl.dataset.hydrated = 'true'
  syncEmptyWorkspace()
}

async function switchProvider(id, { fromHeader } = {}) {
  if (!id || fillingProviderSelect) return false
  try {
    const r = await window.bolo.useProvider({ id })
    if (r?.ok) {
      if (r.message) appendMsg('system', r.message)
      if (r.status) {
        statusEl.textContent = formatStatusLine(r.status)
        updateModelMetadataHint(r.status.modelMetadata)
        updateEffortHint(r.status)
      }
      await refreshProviders()
      await refreshStatus()
      return true
    } else {
      appendMsg('system', `provider switch failed: ${r?.error ?? 'unknown'}`)
      await refreshProviders()
      return false
    }
  } catch (e) {
    appendMsg('system', `provider switch error: ${e?.message ?? e}`)
    return false
  }
}

async function openSettings() {
  const s = await window.bolo.getSettings()
  setMode.value = s.permissionMode || 'default'
  setMock.checked = !!s.useMock
  setCwd.value = s.cwd || ''
  setSettingsError('')
  resetSettingsNav()
  await refreshProviders()
  updateSettingsOverview(s)
  syncSettingsThemeLabel()
  showModal(settingsEl, settingsEl.querySelector('.settings-card'))
}

async function applyModelEffortSettings(modelValue, effortValue) {
  try {
    const result = await window.bolo.setModelEffort({
      model: modelValue,
      effort: effortValue,
    })
    if (!result?.ok) {
      if (setModel) setModel.value = modelValue
      restoreEffortValue(effortValue)
      setSettingsError(result?.error || 'Model/effort update failed.')
      return false
    }
    setSettingsError('')
    return true
  } catch (error) {
    if (setModel) setModel.value = modelValue
    restoreEffortValue(effortValue)
    setSettingsError(`Model/effort update failed: ${error?.message ?? error}`)
    return false
  }
}

async function saveSettings() {
  setSettingsError('')
  const wantProvider = setProvider?.value
  const wantModel = setModel?.value.trim() || ''
  const wantEffort = setEffort?.value || 'auto'
  const r = await window.bolo.setSettings({
    permissionMode: setMode.value,
    useMock: setMock.checked,
    cwd: setCwd.value.trim(),
  })
  if (!r?.ok) {
    const message = r?.error ?? 'unknown'
    setSettingsError(`Settings failed: ${message}`)
    appendMsg('system', `Settings failed: ${message}`)
    return
  }

  if (wantProvider && wantProvider !== activeProviderId) {
    const providerApplied = await switchProvider(wantProvider)
    if (!providerApplied) {
      if (setModel) setModel.value = wantModel
      restoreEffortValue(wantEffort)
      setSettingsError('Provider switch failed.')
      return
    }
  }

  const modelEffortApplied = await applyModelEffortSettings(
    wantModel,
    wantEffort,
  )
  if (!modelEffortApplied) return

  closeSettings()
  // Keep the explicit save-path contract for reduced-motion and static checks;
  // normal mode finishes through hideModal so the closing timeline can play.
  if (reducedMotion && settingsEl) settingsEl.hidden = true
  appendMsg(
    'system',
    'Settings applied (session recreated if cwd/mock changed).',
  )
  await reloadMessages()
  await refreshStatus()
  await refreshProviders()
}

async function addPreset() {
  const presetId = setPreset?.value
  if (!presetId) {
    appendMsg('system', 'Pick a preset first.')
    return
  }
  try {
    const r = await window.bolo.addProvider({ presetId, scope: 'user' })
    if (r?.ok) {
      appendMsg('system', r.message || `Added ${r.id}`)
      await refreshProviders()
      if (setProvider && r.id) setProvider.value = r.id
    } else {
      appendMsg('system', `Add failed: ${r?.error ?? 'unknown'}`)
    }
  } catch (e) {
    appendMsg('system', `Add error: ${e?.message ?? e}`)
  }
}

async function performComposerAction(action) {
  const promptText = promptEl.value.trim()
  const text =
    action === 'interrupt'
      ? promptText
      : composerTextWithAttachments(promptText)
  if (action === 'submit') {
    if (!text || sendBtn.disabled) return
    sendBtn.disabled = true
    promptEl.value = ''
    selectedAttachmentPaths = []
    renderComposerAttachments()
    renderPanelSources()
    appendMsg('user', text)
    endStreamBubble()
    try {
      const pending = window.bolo.submit(text)
      await refreshComposerActions()
      const r = await pending
      if (r.type === 'slash' && r.message) {
        appendMsg('system', r.message)
      } else if (r.type === 'prompt' || r.type === 'turn') {
        // 优先走结构化 timeline；取不到才退回旧的扁平重拉，
        // 免得一处出问题就整段历史消失
        if (!(await reloadTimeline())) await reloadMessages()
        await refreshSessions()
      } else if (r.message) {
        appendMsg('system', String(r.message))
      }
      if (r.status) statusEl.textContent = formatStatusLine(r.status)
      else await refreshStatus()
      await runtimeClient.refresh()
      await refreshProviders()
    } catch (e) {
      appendMsg('system', `error: ${e?.message ?? e}`)
    } finally {
      await refreshComposerActions()
      promptEl.focus()
    }
    return
  }

  if (composerRequestPending) return
  if (action !== 'interrupt' && !text) return
  composerRequestPending = true
  renderComposerActions(lastComposerActions)
  try {
    const result = await window.bolo.composerControl({ action, text })
    if (!result?.ok) {
      appendMsg(
        'system',
        `${action} rejected: ${result?.error ?? result?.code ?? 'unknown'}`,
      )
      return
    }
    if (action === 'queue' || action === 'steer') {
      promptEl.value = ''
      selectedAttachmentPaths = []
      renderComposerAttachments()
      renderPanelSources()
    }
    if (!result.duplicate) {
      const message =
        action === 'queue'
          ? 'Queued for the next turn.'
          : action === 'steer'
            ? 'Steering the active turn.'
            : 'Interrupt requested.'
      appendMsg('system', message)
    }
    if (result.warning) {
      appendMsg('warning', `Warning: ${stripAnsi(result.warning)}`)
    }
    await runtimeClient.refresh()
    await refreshSessions()
    await refreshStatus()
  } catch (error) {
    appendMsg('system', `${action} error: ${error?.message ?? error}`)
  } finally {
    composerRequestPending = false
    await refreshComposerActions()
    promptEl.focus()
  }
}

window.bolo.onEvent((e) => {
  if (!e || typeof e !== 'object') return
  // core 发的是 `text`，此处曾写成 `text_delta` —— 那个事件名全仓不存在，
  // 分支从未执行过。桌面端的「流式」一直是假的：气泡不增量更新，
  // 靠 turn 结束后 reloadMessages() 全量重拉掩盖。
  // 名字对不上不会报错，只会静默失效，故由 test-desktop-event-contract.ts 守住。
  if (e.type === 'text' && e.text) {
    ensureStreamBubble()
    streamBuf += e.text
    scheduleStreamRender()
  }
  if (e.type === 'tool_start' && e.name) {
    const row = appendMsg('system', `→ ${e.name}`)
    if (e.id) {
      row.dataset.runtimeEvent = 'tool_start'
      row.dataset.state = 'started'
      toolRuntimeRows.set(e.id, row)
    }
  }
  if (e.type === 'tool_progress' && e.id && e.text) {
    renderRuntimeEvent(e)
  }
  if (e.type === 'control' && e.controlId && e.text) {
    renderRuntimeEvent(e)
  }
  if (e.type === 'tool_end' && e.name) {
    toolRuntimeRows.delete(e.id)
    if (
      e.cellCollapsed ||
      e.cellExpanded ||
      (e.summaryLine && (e.files?.length || e.ansiUnified))
    ) {
      appendFileChangeCell(e)
    } else if (e.summaryLine) {
      appendMsg('system', stripAnsi(e.summaryLine))
    } else {
      const pathPart = e.path ? `  ${e.path}` : ''
      const counts =
        e.added != null || e.removed != null
          ? `  +${e.added ?? 0}/-${e.removed ?? 0}`
          : ''
      appendMsg(
        'system',
        `${e.ok === false ? '✗' : '✓'} ${e.name}${pathPart}${counts}`,
      )
    }
  }
  if (e.type === 'error' && e.message) {
    appendMsg('system', e.message)
  }
  if (e.type === 'warning' && e.message) {
    appendMsg('warning', `Warning: ${stripAnsi(e.message)}`)
  }
  if (e.type === 'phase') {
    void refreshComposerActions()
  }
})

let currentPermId = null
window.bolo.onPermissionRequest((req) => {
  currentPermId = req.id
  let preview = req.preview?.summaryText || ''
  if (!preview && req.toolInput) {
    preview = JSON.stringify(req.toolInput ?? {}, null, 0).slice(0, 400)
  }
  preview = stripAnsi(preview)
  if (req.preview?.files?.length) {
    const lines = req.preview.files.map((f) => {
      const op = f.op === 'add' ? 'A' : f.op === 'delete' ? 'D' : 'M'
      return `  ${op} ${f.path}  +${f.added ?? 0}/-${f.removed ?? 0}`
    })
    preview = [
      `Allow ${req.toolName}?  (+${req.preview.added ?? 0}/-${req.preview.removed ?? 0})`,
      ...lines,
      req.preview.unifiedPreview
        ? stripAnsi(req.preview.unifiedPreview).split('\n').slice(0, 24).join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  } else if (req.preview?.paths?.length > 1) {
    preview = `${preview}\n(${req.preview.paths.length} paths)`
  }
  permText.textContent = preview
    ? preview.startsWith('Allow ')
      ? preview
      : `Allow ${req.toolName}?\n${preview}`
    : `Allow ${req.toolName}?`
  showModal(permEl, permEl.querySelector('.perm-card'))
})

function respondPerm(decision) {
  if (!currentPermId) return
  const id = currentPermId
  currentPermId = null
  hideModal(permEl, permEl.querySelector('.perm-card'))
  void window.bolo.respondPermission(id, decision)
}

/**
 * AskUserQuestion 对话框。
 *
 * 唯一需要小心的地方：**「没答」不能被表达成一个答案。**
 * 取消走 `{ cancelled: true }`；提交时若有任何一问没选也没写，
 * 就不让提交——交一个空 selected 下去，主进程那边会当成「答了」，
 * 而下游投影只会给出一句 `empty_selection`，用户看不懂发生了什么。
 */
let currentAskId = null

function renderAskQuestions(questions) {
  askQuestionsEl.textContent = ""
  questions.forEach((q, qi) => {
    const wrap = document.createElement("div")
    wrap.className = "ask-q"

    if (q.header) {
      const chip = document.createElement("div")
      chip.className = "ask-header"
      chip.textContent = q.header
      wrap.appendChild(chip)
    }

    const title = document.createElement("p")
    title.className = "ask-question"
    title.textContent = q.question
    wrap.appendChild(title)

    const type = q.multiSelect ? "checkbox" : "radio"
    ;(q.options || []).forEach((opt, oi) => {
      const row = document.createElement("label")
      row.className = "ask-option"
      const input = document.createElement("input")
      input.type = type
      input.name = "ask-q-" + qi
      input.value = opt.label
      input.dataset.qi = String(qi)
      input.dataset.oi = String(oi)
      const text = document.createElement("div")
      const label = document.createElement("div")
      label.className = "ask-option-label"
      label.textContent = opt.label
      text.appendChild(label)
      if (opt.description) {
        const desc = document.createElement("div")
        desc.className = "ask-option-desc"
        desc.textContent = opt.description
        text.appendChild(desc)
      }
      row.appendChild(input)
      row.appendChild(text)
      wrap.appendChild(row)
    })

    const custom = document.createElement("input")
    custom.type = "text"
    custom.className = "ask-custom"
    custom.placeholder = "Or answer in your own words"
    custom.dataset.custom = String(qi)
    wrap.appendChild(custom)

    askQuestionsEl.appendChild(wrap)
  })
}

/** 收集选择。返回 null = 有问题没答，调用方不得提交。 */
function collectAskSelections(count) {
  const out = []
  for (let qi = 0; qi < count; qi++) {
    const custom = askQuestionsEl.querySelector('[data-custom="' + qi + '"]')
    const typed = (custom && custom.value ? custom.value : "").trim()
    if (typed) {
      out.push({ selected: [typed], custom: true })
      continue
    }
    const checked = [...askQuestionsEl.querySelectorAll('input[name="ask-q-' + qi + '"]')]
      .filter((i) => i.checked)
      .map((i) => i.value)
    if (checked.length === 0) return null
    out.push({ selected: checked })
  }
  return out
}

window.bolo.onAskUserQuestion((payload) => {
  const questions = (payload && payload.questions) || []
  currentAskId = payload && payload.id
  renderAskQuestions(questions)
  showModal(askEl, askEl.querySelector('.perm-card'))
  askEl.dataset.count = String(questions.length)
})

function closeAsk() {
  hideModal(askEl, askEl.querySelector('.perm-card'), () => {
    askQuestionsEl.textContent = ""
  })
}

document.getElementById('ask-cancel')?.addEventListener('click', () => {
  if (!currentAskId) return
  const id = currentAskId
  currentAskId = null
  closeAsk()
  // 明确表达「放弃」，而不是交一个空答案
  void window.bolo.respondAskUserQuestion(id, { cancelled: true })
})

document.getElementById('ask-submit')?.addEventListener('click', () => {
  if (!currentAskId) return
  const count = Number(askEl.dataset.count || "0")
  const selections = collectAskSelections(count)
  if (!selections) {
    // 不静默、不代答：说清还差什么
    appendMsg("system", "Answer every question, or press Cancel.")
    return
  }
  const id = currentAskId
  currentAskId = null
  closeAsk()
  void window.bolo.respondAskUserQuestion(id, { selections })
})
document.getElementById('perm-allow')?.addEventListener('click', () =>
  respondPerm('allow'),
)
document.getElementById('perm-always')?.addEventListener('click', () =>
  respondPerm('allow_always'),
)
document.getElementById('perm-deny')?.addEventListener('click', () =>
  respondPerm('deny'),
)
// 主题：light / dark 双一等公民。记住选择，别每次启动都回默认。
btnTheme?.addEventListener('click', toggleTheme)
settingsThemeToggle?.addEventListener('click', toggleTheme)
try {
  const saved = localStorage.getItem('bolo.theme')
  if (saved === 'dark' || saved === 'light') {
    applyTheme(saved)
  } else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    applyTheme('dark')
  }
} catch {
  /* ignore */
}
syncSettingsThemeLabel()

// 右栏按需 toggle：常驻会把中间对话挤窄
function setPanel(open) {
  if (!sidePanel || !btnPanel) return
  if (open) {
    motionShow(sidePanel, { x: 14, y: -6, scale: 0.98, duration: 0.2 })
  } else {
    motionHide(sidePanel, { x: 14, y: -4, scale: 0.985, duration: 0.14 })
  }
  btnPanel.setAttribute('aria-expanded', String(open))
}
btnPanel?.addEventListener('click', () => setPanel(sidePanel?.hidden === true))
btnPanelClose?.addEventListener('click', () => setPanel(false))

document.getElementById('btn-settings')?.addEventListener('click', () =>
  void openSettings(),
)
document.getElementById('set-cancel')?.addEventListener('click', () => {
  closeSettings()
})
settingsClose?.addEventListener('click', closeSettings)
document.getElementById('set-save')?.addEventListener('click', () =>
  void saveSettings(),
)
document.getElementById('set-add-preset')?.addEventListener('click', () =>
  void addPreset(),
)
hdrProvider?.addEventListener('change', () => {
  if (fillingProviderSelect) return
  void switchProvider(hdrProvider.value, { fromHeader: true })
})
setProvider?.addEventListener('change', () => {
  if (fillingProviderSelect) return
  void switchProvider(setProvider.value)
})

// Send/Interrupt 一体按钮：按 data-mode 分发（中断态时圆钮变红 ■）
sendBtn.addEventListener('click', () =>
  void performComposerAction(
    sendBtn.dataset.mode === 'interrupt' ? 'interrupt' : 'submit',
  ),
)
queueBtn.addEventListener('click', () => void performComposerAction('queue'))
steerBtn.addEventListener('click', () => void performComposerAction('steer'))
interruptBtn.addEventListener('click', () =>
  void performComposerAction('interrupt'),
)

// 侧栏开关（按钮 + Ctrl+B）
btnSidebar?.addEventListener('click', () => {
  setSidebarHidden(!document.body.classList.contains('sidebar-hidden'))
})

// composer "+"：附件与连接器
btnAttach?.addEventListener('click', () => openAttachMenu())

// 新建任务
btnNewSession?.addEventListener('click', () => void startNewSession())

// 用户区菜单
userCard?.addEventListener('click', () => openUserMenu())

// 能力页导航
navAutomation?.addEventListener('click', () => showCapability('automation'))
navSkills?.addEventListener('click', () => showCapability('skills'))
navPlugins?.addEventListener('click', () => showCapability('plugins'))
document.getElementById('cap-back')?.addEventListener('click', () => switchView('chat'))
document.getElementById('cap-open-settings')?.addEventListener('click', () =>
  void openSettings(),
)

renameForm?.addEventListener('submit', (event) => {
  event.preventDefault()
  const value = renameInput?.value.trim()
  if (!value || !pendingRenameSubmit) return
  const submitRename = pendingRenameSubmit
  closeRenameDialog()
  submitRename(value)
})
document.getElementById('rename-close')?.addEventListener('click', closeRenameDialog)
document.getElementById('rename-cancel')?.addEventListener('click', closeRenameDialog)

initSettingsNav()
initCustomSelects()

for (const action of document.querySelectorAll('.empty-action')) {
  action.addEventListener('click', () => {
    const value = action.dataset.prompt?.trim()
    if (!value || !promptEl) return
    promptEl.value = value
    promptEl.dispatchEvent(new Event('input', { bubbles: true }))
    promptEl.focus()
  })
}
syncEmptyWorkspace()

// composer 权限模式胶囊：即时生效，不重建会话
composerMode?.addEventListener('change', () => {
  void applyComposerMode(composerMode.value)
})

promptEl.addEventListener('input', () => void refreshComposerActions())
promptEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault()
    void performComposerAction(
      sendBtn.dataset.mode === 'interrupt' ? 'interrupt' : 'submit',
    )
  }
})

// 多行自适应：随内容撑高（上限 180px，见 CSS max-height）
promptEl.addEventListener('input', () => {
  promptEl.style.height = 'auto'
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 180)}px`
})

// composer 内联模型/effort：变更即保存（复用 settings 的保存链）
if (composerModel) {
  composerModel.addEventListener('change', async () => {
    const applied = await applyModelEffortSettings(
      composerModel.value,
      composerEffort?.value,
    )
    if (!applied) await refreshProviders()
  })
}
if (composerEffort) {
  composerEffort.addEventListener('change', async () => {
    const applied = await applyModelEffortSettings(
      composerModel?.value,
      composerEffort.value,
    )
    if (!applied) await refreshProviders()
  })
}

// 键盘导航：Esc 逐层关闭（菜单 → 设置 → 询问 → 环境浮层）；
// Ctrl/Cmd+L 聚焦输入；Ctrl/Cmd+B 侧栏；Ctrl/Cmd+, 设置
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (activeSelectPopover) {
      closeCustomSelect({ restoreFocus: true })
      return
    }
    if (activeMenu) {
      closeMenu()
      return
    }
    if (renameDialog && !renameDialog.hidden) {
      closeRenameDialog()
      return
    }
    if (settingsEl && !settingsEl.hidden) {
      closeSettings()
      return
    }
    if (askEl && !askEl.hidden) {
      closeAsk()
      promptEl.focus()
      return
    }
    if (sidePanel && !sidePanel.hidden) {
      setPanel(false)
      return
    }
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'l') {
    ev.preventDefault()
    promptEl.focus()
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'b') {
    ev.preventDefault()
    setSidebarHidden(!document.body.classList.contains('sidebar-hidden'))
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key === ',') {
    ev.preventDefault()
    void openSettings()
  }
  if (settingsEl && !settingsEl.hidden && ev.key === '/' && document.activeElement !== settingsSearch) {
    ev.preventDefault()
    settingsSearch?.focus()
  }
})

initSidebarState()
renderComposerAttachments()

void (async () => {
  await runtimeClient.connect()
  await refreshStatus()
  await refreshProviders()
  await refreshSessions()
  await refreshComposerActions()
  // 结构化 timeline 取不到才退回扁平重拉：一处出问题不该让整段历史消失
  if (!(await reloadTimeline())) await reloadMessages()
  // composer 权限胶囊 / 环境面板 cwd / 用户区的初始值来自 settings（与 main 同源）
  try {
    const s = await window.bolo.getSettings()
    if (composerMode && s?.permissionMode) {
      composerMode.value = s.permissionMode
      syncCustomSelect(composerMode)
    }
    fillDetailsCwd(s?.cwd)
    fillUserCard(s?.cwd)
  } catch {
    /* 取不到就保持占位，不挡启动 */
  }
  appendMsg(
    'system',
    'Bolo desktop — streaming, permissions, multi-provider (CX7). /help works.',
  )
  promptEl.focus()
})()
