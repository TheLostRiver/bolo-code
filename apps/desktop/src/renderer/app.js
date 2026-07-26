/**
 * Renderer — 会话 · 流式 · 权限 · 设置 · 多 provider（CX7）
 */

const statusEl = document.getElementById('status')
const logEl = document.getElementById('log')
const promptEl = document.getElementById('prompt')
const sendBtn = document.getElementById('send')
const permEl = document.getElementById('perm')
const permText = document.getElementById('perm-text')
const settingsEl = document.getElementById('settings')
const setMode = document.getElementById('set-mode')
const setMock = document.getElementById('set-mock')
const setCwd = document.getElementById('set-cwd')
const setProvider = document.getElementById('set-provider')
const setPreset = document.getElementById('set-preset')
const setEffort = document.getElementById('set-effort')
const hdrProvider = document.getElementById('hdr-provider')

let streamEl = null
let streamBuf = ''
/** @type {{ id: string, label?: string, kind?: string, model?: string, isActive?: boolean }[]} */
let lastProviders = []
/** @type {{ id: string, label?: string }[]} */
let lastPresets = []
let fillingProviderSelect = false

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
      await reloadMessages()
    } else if (r.message) {
      appendMsg('system', String(r.message))
    }
    if (r.status) statusEl.textContent = formatStatusLine(r.status)
    else await refreshStatus()
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

document.getElementById('perm-allow')?.addEventListener('click', () =>
  respondPerm('allow'),
)
document.getElementById('perm-always')?.addEventListener('click', () =>
  respondPerm('allow_always'),
)
document.getElementById('perm-deny')?.addEventListener('click', () =>
  respondPerm('deny'),
)
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
  await refreshStatus()
  await refreshProviders()
  await reloadMessages()
  appendMsg(
    'system',
    'Bolo desktop — streaming, permissions, multi-provider (CX7). /help works.',
  )
  promptEl.focus()
})()