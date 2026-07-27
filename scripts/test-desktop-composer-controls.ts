/**
 * OI-06F1: Desktop composer controls and queue drain wiring.
 *
 * Run: npm run test:desktop-composer
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
    'getSessionComposerActions',
    'requestSessionComposerControl',
    'takeNextSessionQueued',
  ]) {
    assert(
      mainSource.includes(symbol),
      `Desktop main consumes packages-first ${symbol}`,
    )
  }
  for (const channel of [
    'bolo:getComposerActions',
    'bolo:composerControl',
  ]) {
    assert(
      mainSource.includes(`ipcMain.handle('${channel}'`),
      `Desktop main handles ${channel}`,
    )
    assert(
      preloadSource.includes(`ipcRenderer.invoke('${channel}'`),
      `preload exposes ${channel}`,
    )
  }

  const submitDesktopInput = functionBlock(
    mainSource,
    'async function submitDesktopInput',
  )
  for (const required of [
    'submitUserInput',
    'takeNextSessionQueued',
    'turnId:',
    'querySource:',
  ]) {
    assert(
      submitDesktopInput.includes(required),
      `Desktop submit path includes ${required}`,
    )
  }
  assert(
    /while\s*\(/.test(submitDesktopInput),
    'Desktop submit path drains every ready queue entry in FIFO order',
  )

  for (const id of [
    'composer-send',
    'composer-queue',
    'composer-steer',
    'composer-interrupt',
  ]) {
    assert(
      htmlSource.includes(`id="${id}"`),
      `composer exposes explicit ${id} control`,
    )
  }

  const refresh = functionBlock(
    rendererSource,
    'async function refreshComposerActions',
  )
  assert(
    refresh.includes('window.bolo.getComposerActions'),
    'renderer gets action availability from the packages-backed main process',
  )
  const perform = functionBlock(
    rendererSource,
    'async function performComposerAction',
  )
  assert(
    perform.includes('window.bolo.composerControl'),
    'queue/steer/interrupt share one explicit control path',
  )
  assert(
    perform.includes("action === 'submit'") &&
      perform.includes('window.bolo.submit'),
    'plain submit remains distinct from session controls',
  )
  assert(
    rendererSource.includes("addEventListener('input'") &&
      rendererSource.includes('refreshComposerActions'),
    'typing refreshes text-dependent composer availability',
  )

  console.log('PASS: desktop composer controls wiring')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
