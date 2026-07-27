/**
 * OI-06E: Desktop session selection/resume wiring.
 *
 * Run: npm run test:desktop-session-selection
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error('FAIL:', message)
    process.exit(1)
  }
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
  const mainFile = path.join('apps', 'desktop', 'src', 'main', 'index.ts')
  const preloadFile = path.join(
    'apps',
    'desktop',
    'src',
    'preload',
    'index.cjs',
  )
  const rendererFile = path.join(
    'apps',
    'desktop',
    'src',
    'renderer',
    'app.js',
  )
  const [mainSource, preloadSource, rendererSource] = await Promise.all([
    fs.readFile(mainFile, 'utf8'),
    fs.readFile(preloadFile, 'utf8'),
    fs.readFile(rendererFile, 'utf8'),
  ])

  for (const symbol of [
    'createActiveSessionManager',
    'resumeSessionFromWorkspace',
    'scopeSessionRequestId',
  ]) {
    assert(
      mainSource.includes(symbol),
      `Desktop main consumes packages-first ${symbol}`,
    )
  }
  assert(
    /ipcMain\.handle\(\s*'bolo:selectSession'/.test(mainSource),
    'Desktop main exposes bolo:selectSession',
  )
  const resumeSession = functionBlock(
    mainSource,
    'async function resumeDesktopSession',
  )
  assert(
    !resumeSession.includes('desktopSettings.permissionMode =') &&
      !resumeSession.includes('desktopSettings.cwd ='),
    'loading a candidate does not mutate active Desktop settings before publish',
  )
  assert(
    mainSource.includes('syncDesktopSettingsFromSession(selected.session)'),
    'Desktop settings follow the resumed session only after selection succeeds',
  )
  assert(
    /selectSession:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(\s*'bolo:selectSession'/.test(
      preloadSource,
    ),
    'preload exposes selectSession through the context bridge',
  )

  const activation = functionBlock(
    rendererSource,
    'async function activateSessionEntry',
  )
  assert(
    activation.includes('window.bolo.selectSession'),
    'the shared activation path invokes selectSession',
  )
  for (const refresh of [
    'runtimeClient.refresh',
    'refreshStatus',
    'refreshProviders',
    'refreshSessions',
    'reloadTimeline',
  ]) {
    assert(
      activation.includes(refresh),
      `successful activation refreshes ${refresh}`,
    )
  }
  assert(
    activation.includes('currentPermId = null') &&
      activation.includes('currentAskId = null'),
    'successful activation clears stale renderer approval ownership',
  )

  const sessionRendering = functionBlock(
    rendererSource,
    'async function refreshSessions',
  )
  assert(
    sessionRendering.includes("addEventListener('click'"),
    'session rows activate on click',
  )
  assert(
    sessionRendering.includes("addEventListener('keydown'") &&
      sessionRendering.includes("'Enter'") &&
      sessionRendering.includes("' '"),
    'session rows activate with Enter and Space',
  )
  assert(
    sessionRendering.includes('e.sessionId'),
    'renderer forwards the packages-provided stable session id',
  )

  console.log('PASS: desktop session selection wiring')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
