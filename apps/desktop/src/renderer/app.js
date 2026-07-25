/**
 * Renderer — 会话 · 流式 · 权限 · 设置
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

let streamEl = null
let streamBuf = ''

function appendMsg(role, text) {
  const div = document.createElement('div')
  div.className = `msg ${role}`
  div.textContent = text
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
  return div
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

async function refreshStatus() {
  try {
    const s = await window.bolo.getStatus()
    statusEl.textContent = `id=${s.id.slice(0, 8)} · mode=${s.permissionMode} · model=${s.model ?? 'unset'} · msgs=${s.messageCount} · ${s.providerId ?? '?'}`
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

async function openSettings() {
  const s = await window.bolo.getSettings()
  setMode.value = s.permissionMode || 'default'
  setMock.checked = !!s.useMock
  setCwd.value = s.cwd || ''
  settingsEl.hidden = false
}

async function saveSettings() {
  const r = await window.bolo.setSettings({
    permissionMode: setMode.value,
    useMock: setMock.checked,
    cwd: setCwd.value.trim(),
  })
  settingsEl.hidden = true
  if (r?.ok) {
    appendMsg('system', 'Settings applied (session recreated if cwd/mock changed).')
    await reloadMessages()
    await refreshStatus()
  } else {
    appendMsg('system', `Settings failed: ${r?.error ?? 'unknown'}`)
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
    await refreshStatus()
  } catch (e) {
    appendMsg('system', `error: ${e?.message ?? e}`)
  } finally {
    sendBtn.disabled = false
    promptEl.focus()
  }
}

window.bolo.onEvent((e) => {
  if (!e || typeof e !== 'object') return
  if (e.type === 'text_delta' && e.text) {
    const el = ensureStreamBubble()
    streamBuf += e.text
    el.textContent = streamBuf
    logEl.scrollTop = logEl.scrollHeight
  }
  if (e.type === 'tool_start' && e.name) {
    appendMsg('system', `→ ${e.name}`)
  }
  if (e.type === 'tool_end' && e.name) {
    appendMsg('system', `${e.ok === false ? '✗' : '✓'} ${e.name}`)
  }
  if (e.type === 'error' && e.message) {
    appendMsg('system', e.message)
  }
})

let currentPermId = null
window.bolo.onPermissionRequest((req) => {
  currentPermId = req.id
  permText.textContent = `Allow ${req.toolName}?\n${JSON.stringify(req.toolInput ?? {}, null, 0).slice(0, 200)}`
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

sendBtn.addEventListener('click', () => void send())
promptEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault()
    void send()
  }
})

void (async () => {
  await refreshStatus()
  await reloadMessages()
  appendMsg(
    'system',
    'Bolo desktop — streaming, permissions, settings. /help works.',
  )
  promptEl.focus()
})()