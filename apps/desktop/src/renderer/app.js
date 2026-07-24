/**
 * Renderer — 仅 UI；会话经 preload bridge
 */

const statusEl = document.getElementById('status')
const logEl = document.getElementById('log')
const promptEl = document.getElementById('prompt')
const sendBtn = document.getElementById('send')

function appendMsg(role, text) {
  const div = document.createElement('div')
  div.className = `msg ${role}`
  div.textContent = text
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
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
  for (const m of list) {
    appendMsg(m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system', m.content || '')
  }
}

async function send() {
  const text = promptEl.value.trim()
  if (!text) return
  sendBtn.disabled = true
  promptEl.value = ''
  appendMsg('user', text)
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
  if (e?.type === 'text_delta' && e.text) {
    // 流式：简化为忽略，提交结束后 listMessages 刷新
  }
  if (e?.type === 'error' && e.message) {
    appendMsg('system', e.message)
  }
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
  await reloadMessages()
  appendMsg('system', 'Bolo desktop shell — headless core via IPC. /help works.')
  promptEl.focus()
})()