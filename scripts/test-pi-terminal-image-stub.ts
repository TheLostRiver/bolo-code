/**
 * piTerminalImageStub 单测：直接 import 本地 stub，覆盖 env 探测矩阵、
 * capabilities 缓存/覆盖、cell 尺寸、图片行识别、hyperlink 与删除序列。
 *
 * 生产 bundle 与 tsx 测试共用同一 stub 实现（piCompat 直连 + 构建期替换），
 * 本测试是 stub 行为的直接真源；pi-tui 内部模块（tui.js/markdown.js）对
 * capabilities 的消费语义由 test-cli-tui-transcript 等真实渲染测试覆盖。
 */
import { strict as assert } from 'node:assert'
import {
  deleteAllKittyImages,
  deleteKittyImage,
  getCapabilities,
  getCellDimensions,
  hyperlink,
  isImageLine,
  resetCapabilitiesCache,
  setCapabilities,
  setCellDimensions,
} from '../packages/cli/src/tui/piTerminalImageStub.ts'

const ENV_KEYS = [
  'TERM_PROGRAM',
  'TERMINAL_EMULATOR',
  'TERM',
  'COLORTERM',
  'TMUX',
  'KITTY_WINDOW_ID',
  'GHOSTTY_RESOURCES_DIR',
  'WEZTERM_PANE',
  'WARP_SESSION_ID',
  'WARP_TERMINAL_SESSION_UUID',
  'ITERM_SESSION_ID',
  'WT_SESSION',
] as const

function withEnv(env: Record<string, string>, fn: () => void) {
  const saved = new Map<string, string | undefined>()
  for (const key of ENV_KEYS) saved.set(key, process.env[key])
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  try {
    resetCapabilitiesCache()
    fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetCapabilitiesCache()
  }
}

function main() {
  withEnv({ WT_SESSION: 'test' }, () => {
    assert.deepEqual(getCapabilities(), {
      images: null,
      trueColor: true,
      hyperlinks: true,
    })
  })
  withEnv({ KITTY_WINDOW_ID: '1' }, () => {
    assert.equal(getCapabilities().images, 'kitty')
  })
  withEnv({ TERM_PROGRAM: 'iterm.app' }, () => {
    assert.equal(getCapabilities().images, 'iterm2')
  })
  withEnv({ TMUX: '1' }, () => {
    // 与原版差异：不 execSync 探测 tmux OSC 8 转发，保守关闭 hyperlink
    assert.deepEqual(getCapabilities(), {
      images: null,
      trueColor: false,
      hyperlinks: false,
    })
  })
  withEnv({}, () => {
    assert.deepEqual(getCapabilities(), {
      images: null,
      trueColor: false,
      hyperlinks: false,
    })
  })
  withEnv({ COLORTERM: 'truecolor' }, () => {
    assert.deepEqual(getCapabilities(), {
      images: null,
      trueColor: true,
      hyperlinks: false,
    })
  })
  // setCapabilities 覆盖缓存
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  assert.deepEqual(getCapabilities(), {
    images: null,
    trueColor: true,
    hyperlinks: true,
  })
  resetCapabilitiesCache()
  // cell 尺寸状态
  setCellDimensions({ widthPx: 10, heightPx: 20 })
  assert.deepEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 })
  // 图片行识别：快路径（行首）与慢路径（行内）
  assert.equal(isImageLine('\x1b_Ga=T...'), true)
  assert.equal(isImageLine('\x1b]1337;File=...'), true)
  assert.equal(isImageLine('plain text'), false)
  assert.equal(isImageLine('x\x1b_Ga=T'), true)
  // OSC 8 hyperlink 与 kitty 删除序列
  assert.equal(
    hyperlink('text', 'https://x.dev'),
    '\x1b]8;;https://x.dev\x1b\\text\x1b]8;;\x1b\\',
  )
  assert.equal(deleteKittyImage('7'), '\x1b_Ga=d,d=I,i=7,q=2\x1b\\')
  assert.equal(deleteAllKittyImages(), '\x1b_Ga=d,d=A,q=2\x1b\\')
  console.log('PASS: pi terminal-image stub')
}

main()
