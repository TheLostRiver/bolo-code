/**
 * Renderer — 会话 · 流式 · 权限 · 设置 · 多 provider（CX7）
 */

import { createRuntimeClient } from './runtime-client.js'

const statusEl = document.getElementById('status')
const runtimeStatusEl = document.getElementById('runtime-status')
const logEl = document.getElementById('log')
const promptEl = document.getElementById('prompt')
const sendBtn = document.getElementById('send')
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
const setEffort = document.getElementById('set-effort')
const hdrProvider = document.getElementById('hdr-provider')
const sessionListEl = document.getElementById('session-list')
const sidePanel = document.getElementById('side-panel')
const panelBody = document.getElementById('panel-body')
const btnPanel = document.getElementById('btn-panel')
const btnPanelClose = document.getElementById('btn-panel-close')
const btnTheme = document.getElementById('btn-theme')

let streamEl = null
let streamBuf = ''
/** @type {{ id: string, label?: string, kind?: string, model?: string, isActive?: boolean }[]} */
let lastProviders = []
/** @type {{ id: string, label?: string }[]} */
let lastPresets = []
let fillingProviderSelect = false
let selectingSession = false

const runtimeClient = createRuntimeClient({
  transport: {
    hello: () => window.bolo.runtimeHello(),
    query: (request) => window.bolo.runtimeQuery(request),
    command: (command) => window.bolo.runtimeCommand(command),
  },
})

function renderRuntimeState(state) {
  document.documentElement.dataset.runtimeState = state.status
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
    permEl.hidden = true
    currentAskId = null
    closeAsk()
    endStreamBubble()

    await runtimeClient.refresh()
    await refreshStatus()
    await refreshProviders()
    await refreshSessions()
    if (!(await reloadTimeline())) await reloadMessages()
    promptEl.focus()
  } catch (error) {
    appendMsg('system', `Session switch error: ${error?.message ?? error}`)
  } finally {
    selectingSession = false
    sessionListEl?.removeAttribute('aria-busy')
  }
}

/**
 * 会话侧栏。
 *
 * 排序、状态、标题回退**全部由 packages 的 buildSessionListView 决定**，
 * 这里只把它给的行放进 DOM —— 薄壳纪律：renderer 不重算业务状态。
 * 尤其「等待审批」置顶这件事不能在这层再排一次，否则两处规则会漂移。
 */
async function refreshSessions() {
  if (!sessionListEl || !window.bolo?.listSessions) return
  let entries = []
  try {
    entries = await window.bolo.listSessions()
  } catch {
    return // 取不到就保持上一次的列表，不清空成「一个会话都没有」
  }
  sessionListEl.replaceChildren()
  for (const e of entries) {
    const li = document.createElement('li')
    li.className = 'session-item'
    li.tabIndex = 0
    li.setAttribute('role', 'option')
    li.dataset.sessionId = e.sessionId
    li.setAttribute('aria-selected', String(e.active === true))
    if (e.active) li.setAttribute('aria-current', 'true')
    li.addEventListener('click', () => {
      void activateSessionEntry(e.sessionId)
    })
    li.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      void activateSessionEntry(e.sessionId)
    })

    const title = document.createElement('span')
    title.className = 'session-title'
    title.textContent = e.title
    li.appendChild(title)

    const meta = document.createElement('div')
    meta.className = 'session-meta'
    const badge = document.createElement('span')
    badge.className = 'badge'
    badge.dataset.status = e.status
    badge.textContent = e.status.replace(/_/g, ' ')
    meta.appendChild(badge)
    const count = document.createElement('span')
    count.textContent = `${e.messageCount} msg`
    meta.appendChild(count)
    li.appendChild(meta)

    sessionListEl.appendChild(li)
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
        body.hidden = nowHidden
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
  logEl.replaceChildren()
  for (const c of cards) logEl.appendChild(renderCard(c))
  logEl.scrollTop = logEl.scrollHeight
  return true
}

function appendMsg(role, text) {
  const div = document.createElement('div')
  div.className = `msg ${role}`
  div.textContent = text
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
  return div
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
  logEl.scrollTop = logEl.scrollHeight
  return wrap
}

function ensureStreamBubble() {
  if (!streamEl) {
    streamEl = appendMsg('assistant', '')
    streamBuf = ''
  }
  return streamEl
}

function endStreamBubble() {
  streamEl = null
  streamBuf = ''
}

function formatStatusLine(s) {
  const pid = s.providerId || s.providerKind || '?'
  const kind = s.providerKind ? `/${s.providerKind}` : ''
  const effort = s.effortLevel ? ` · e=${s.effortLevel}` : ''
  return `id=${String(s.id || '').slice(0, 8)} · mode=${s.permissionMode} · model=${s.model ?? 'unset'} · msgs=${s.messageCount} · ${pid}${kind === `/${pid}` ? '' : kind}${effort}`
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
  fillingProviderSelect = false
}

function updateEffortHint(data) {
  if (!setEffort) return
  const dialect = data.effortDialect || data.dialectId || '?'
  const level = data.effortLevel || 'auto'
  const ch = Array.isArray(data.effortChoosable)
    ? data.effortChoosable.join(', ')
    : Array.isArray(data.choosable)
      ? data.choosable.join(', ')
      : ''
  setEffort.textContent = ch
    ? `effort=${level} · dialect=${dialect} · choosable: ${ch}`
    : `effort=${level} · dialect=${dialect}`
}

async function refreshProviders() {
  try {
    const data = await window.bolo.listProviders()
    if (!data?.ok) return
    lastProviders = data.providers || []
    lastPresets = data.presets || []
    const active = data.activeId || ''
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
    updateEffortHint(data)
  } catch (e) {
    /* ignore list errors in header */
  }
}

async function refreshStatus() {
  try {
    const s = await window.bolo.getStatus()
    statusEl.textContent = formatStatusLine(s)
    updateEffortHint(s)
  } catch (e) {
    statusEl.textContent = `error: ${e?.message ?? e}`
  }
}

async function reloadMessages() {
  const list = await window.bolo.listMessages()
  logEl.innerHTML = ''
  endStreamBubble()
  for (const m of list) {
    appendMsg(
      m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system',
      m.content || '',
    )
  }
}

async function switchProvider(id, { fromHeader } = {}) {
  if (!id || fillingProviderSelect) return
  try {
    const r = await window.bolo.useProvider({ id })
    if (r?.ok) {
      if (r.message) appendMsg('system', r.message)
      if (r.status) {
        statusEl.textContent = formatStatusLine(r.status)
        updateEffortHint(r.status)
      }
      await refreshProviders()
      await refreshStatus()
    } else {
      appendMsg('system', `provider switch failed: ${r?.error ?? 'unknown'}`)
      await refreshProviders()
    }
  } catch (e) {
    appendMsg('system', `provider switch error: ${e?.message ?? e}`)
  }
}

async function openSettings() {
  const s = await window.bolo.getSettings()
  setMode.value = s.permissionMode || 'default'
  setMock.checked = !!s.useMock
  setCwd.value = s.cwd || ''
  await refreshProviders()
  settingsEl.hidden = false
}

async function saveSettings() {
  const r = await window.bolo.setSettings({
    permissionMode: setMode.value,
    useMock: setMock.checked,
    cwd: setCwd.value.trim(),
  })
  // provider 切换即时生效，不依赖 Save；Save 只管 mode/mock/cwd
  const wantProvider = setProvider?.value
  settingsEl.hidden = true
  if (r?.ok) {
    appendMsg(
      'system',
      'Settings applied (session recreated if cwd/mock changed).',
    )
    await reloadMessages()
    await refreshStatus()
    await refreshProviders()
    if (wantProvider) {
      await switchProvider(wantProvider)
    }
  } else {
    appendMsg('system', `Settings failed: ${r?.error ?? 'unknown'}`)
  }
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

async function send() {
  const text = promptEl.value.trim()
  if (!text) return
  sendBtn.disabled = true
  promptEl.value = ''
  appendMsg('user', text)
  endStreamBubble()
  try {
    const r = await window.bolo.submit(text)
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
    sendBtn.disabled = false
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
    const el = ensureStreamBubble()
    streamBuf += e.text
    el.textContent = streamBuf
    logEl.scrollTop = logEl.scrollHeight
  }
  if (e.type === 'tool_start' && e.name) {
    appendMsg('system', `→ ${e.name}`)
  }
  if (e.type === 'tool_end' && e.name) {
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
  permText.style.whiteSpace = 'pre-wrap'
  permText.style.maxHeight = '280px'
  permText.style.overflow = 'auto'
  permText.style.fontFamily =
    'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  permText.style.fontSize = '12px'
  permEl.hidden = false
})

function respondPerm(decision) {
  if (!currentPermId) return
  const id = currentPermId
  currentPermId = null
  permEl.hidden = true
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
  askEl.hidden = false
  askEl.dataset.count = String(questions.length)
})

function closeAsk() {
  askEl.hidden = true
  askQuestionsEl.textContent = ""
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
btnTheme?.addEventListener('click', () => {
  const root = document.documentElement
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
  root.dataset.theme = next
  try {
    localStorage.setItem('bolo.theme', next)
  } catch {
    /* 存不了就只影响本次会话，不该因此报错 */
  }
})
try {
  const saved = localStorage.getItem('bolo.theme')
  if (saved === 'dark' || saved === 'light') {
    document.documentElement.dataset.theme = saved
  } else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    document.documentElement.dataset.theme = 'dark'
  }
} catch {
  /* ignore */
}

// 右栏按需 toggle：常驻会把中间对话挤窄
function setPanel(open) {
  if (!sidePanel || !btnPanel) return
  sidePanel.hidden = !open
  btnPanel.setAttribute('aria-expanded', String(open))
}
btnPanel?.addEventListener('click', () => setPanel(sidePanel?.hidden === true))
btnPanelClose?.addEventListener('click', () => setPanel(false))

document.getElementById('btn-settings')?.addEventListener('click', () =>
  void openSettings(),
)
document.getElementById('set-cancel')?.addEventListener('click', () => {
  settingsEl.hidden = true
})
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

sendBtn.addEventListener('click', () => void send())
promptEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault()
    void send()
  }
})

void (async () => {
  await runtimeClient.connect()
  await refreshStatus()
  await refreshProviders()
  await refreshSessions()
  // 结构化 timeline 取不到才退回扁平重拉：一处出问题不该让整段历史消失
  if (!(await reloadTimeline())) await reloadMessages()
  appendMsg(
    'system',
    'Bolo desktop — streaming, permissions, multi-provider (CX7). /help works.',
  )
  promptEl.focus()
})()
