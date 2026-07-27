/**
 * OI-06F2: Desktop model/effort settings wiring.
 *
 * Run: npm run test:desktop-session-settings
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

function functionBlock(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert(start >= 0, `${signature} is missing`)
  const open = source.indexOf('{', start)
  assert(open >= 0, `${signature} has no body`)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  assert(false, `${signature} has unbalanced braces`)
  return ''
}

async function main() {
  const [mainSource, preloadSource, rendererSource, htmlSource] =
    await Promise.all([
      fs.readFile(
        path.join('apps', 'desktop', 'src', 'main', 'index.ts'),
        'utf8',
      ),
      fs.readFile(
        path.join('apps', 'desktop', 'src', 'preload', 'index.cjs'),
        'utf8',
      ),
      fs.readFile(
        path.join('apps', 'desktop', 'src', 'renderer', 'app.js'),
        'utf8',
      ),
      fs.readFile(
        path.join('apps', 'desktop', 'src', 'renderer', 'index.html'),
        'utf8',
      ),
    ])

  for (const symbol of [
    'getSessionModelEffortSettings',
    'updateSessionModelEffort',
  ]) {
    assert(
      mainSource.includes(symbol),
      `Desktop main consumes packages-first ${symbol}`,
    )
  }
  assert(
    !mainSource.includes('function effortSnapshot'),
    'Desktop removes its duplicate effort snapshot implementation',
  )

  const channel = 'bolo:setModelEffort'
  assert(
    mainSource.includes(`ipcMain.handle('${channel}'`),
    `Desktop main handles ${channel}`,
  )
  assert(
    preloadSource.includes(`ipcRenderer.invoke('${channel}'`),
    `preload exposes ${channel}`,
  )
  const handler = functionBlock(
    mainSource,
    `ipcMain.handle('${channel}'`,
  )
  assert(
    handler.includes('updateSessionModelEffort'),
    'Desktop mutation delegates to the packages-first transaction',
  )

  assert(
    /<input[^>]+id="set-model"[^>]+list="set-model-suggestions"/.test(
      htmlSource,
    ),
    'settings exposes an editable model input backed by suggestions',
  )
  assert(
    htmlSource.includes('<datalist id="set-model-suggestions">'),
    'settings includes the model suggestions datalist',
  )
  assert(
    /<select[^>]+id="set-effort"/.test(htmlSource),
    'settings exposes effort as a select control',
  )
  assert(
    htmlSource.includes('id="set-settings-error"'),
    'settings has an inline mutation error surface',
  )

  const refresh = functionBlock(rendererSource, 'async function refreshProviders')
  for (const field of [
    'modelSuggestions',
    'choosable',
    'setModel',
    'fillEffortChoices',
  ]) {
    assert(
      refresh.includes(field),
      `provider refresh projects ${field} into the settings controls`,
    )
  }

  const apply = functionBlock(
    rendererSource,
    'async function applyModelEffortSettings',
  )
  assert(
    apply.includes('window.bolo.setModelEffort'),
    'renderer calls the model/effort mutation channel',
  )
  assert(
    apply.includes('setSettingsError') && apply.includes('return false'),
    'mutation failure is rendered inline and returned to the Save path',
  )
  assert(
    !apply.includes('settingsEl.hidden = true'),
    'the mutation helper cannot close settings on failure',
  )

  const save = functionBlock(rendererSource, 'async function saveSettings')
  const applyAt = save.indexOf('await applyModelEffortSettings')
  const closeAt = save.indexOf('settingsEl.hidden = true')
  assert(
    rendererSource.includes('let activeProviderId') &&
      refresh.includes('activeProviderId = active'),
    'renderer tracks the active provider reported by main',
  )
  assert(
    save.includes('wantProvider !== activeProviderId'),
    'Save does not re-switch an already active provider',
  )
  assert(
    applyAt >= 0 && closeAt > applyAt,
    'Save applies model/effort before closing settings',
  )
  assert(
    /if\s*\(\s*!modelEffortApplied\s*\)\s*return/.test(save),
    'Save keeps the modal and old input visible when mutation fails',
  )

  console.log('PASS: desktop model/effort settings wiring')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
