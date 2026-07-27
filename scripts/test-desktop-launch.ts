/**
 * AR3F · 真正启动一次 Electron，确认 renderer 挂得起来
 *
 * 前面那些桌面测试验的都是**字符串性质**：产物里没有 tsx 残留、路径不是源码布局、
 * IPC 两侧名字对齐。它们有用，但都绕不开一个事实——
 *
 * **preload / renderer 路径写错时构建不报错，只在窗口打开那一刻白屏。**
 *
 * 所以这里真跑一次：启动应用 → 等窗口加载完 → 在页面里检查四样东西 → 退出。
 *
 * 检查项刻意不止「DOM 挂上了」：
 * - `log` / `sidebar`：三栏骨架的两个关键容器真的在
 * - `bridge`：`window.bolo` 存在，即 **preload 路径没写错**（这是最容易错的一条）
 * - `sheets > 0`：样式表真的加载了，而不是 404 后裸奔
 *
 * 少查任何一项，都有一种白屏成因会漏过去。
 *
 * ## 关于跳过
 *
 * Electron 二进制体积大，某些环境（CI 设了 ELECTRON_SKIP_BINARY_DOWNLOAD）
 * 装不上。此时**跳过并大声说明**，而不是静默通过——静默跳过的测试比没有测试更糟，
 * 它会让人以为这块覆盖到了。
 *
 * 运行：npx tsx scripts/test-desktop-launch.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const APP_DIR = path.join('apps', 'desktop')
/**
 * 用 electron 模块导出的二进制路径，而不是 `node_modules/.bin` 里的包装脚本。
 * Windows 上那是个 `.CMD`，`spawnSync` 不带 shell 直接跑会拿到 `exit null`
 * 且没有任何输出——排查起来比真错误还费劲。
 */
async function electronBinary(): Promise<string | undefined> {
  try {
    const mod = await import('electron')
    const bin = (mod as unknown as { default?: unknown }).default ?? mod
    return typeof bin === 'string' ? bin : undefined
  } catch {
    return undefined
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  const bin = await electronBinary()
  if (!bin || !(await exists(bin))) {
    // 大声跳过：让覆盖的缺失可见，而不是伪装成通过
    console.log(
      'SKIPPED: electron binary not installed — the desktop launch check did NOT run.\n' +
        '  This is real lost coverage: path mistakes in preload/renderer only surface at launch.\n' +
        `  Install it (npm i) and re-run: npx tsx scripts/test-desktop-launch.ts`,
    )
    return
  }

  // 先构建：测的是「当前源码能否启动」，不是上次留下的产物
  const built = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', path.join('scripts', 'build-desktop.ts')],
    { encoding: 'utf8' },
  )
  assert(built.status === 0, `bundling failed:\n${built.stderr || built.stdout}`)

  const run = spawnSync(bin, ['.'], {
    cwd: APP_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      BOLO_DESKTOP_SMOKE: '1',
      // mock provider：启动检查不该依赖任何真实后端或密钥
      BOLO_DESKTOP_MOCK: '1',
    },
    timeout: 120_000,
  })

  const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  assert(
    run.status === 0,
    `the app did not start cleanly (exit ${run.status}):\n${out.slice(-1500)}`,
  )

  const line = /desktop smoke ok: (\{.*\})/.exec(out)
  assert(
    line,
    `the smoke marker never appeared — the window may not have finished loading:\n${out.slice(-1500)}`,
  )

  const report = JSON.parse(line![1]!) as Record<string, unknown>
  assert(report.log === true, 'the conversation container mounted')
  assert(report.sidebar === true, 'the session sidebar mounted (three-column shell)')
  assert(
    report.bridge === true,
    'window.bolo exists — this is what proves the preload path is correct',
  )
  assert(
    typeof report.sheets === 'number' && report.sheets > 0,
    `stylesheets actually loaded, got ${String(report.sheets)} — zero means a 404 and an unstyled window`,
  )
  assert(
    report.runtime === 'ready',
    `the renderer RuntimeClient completes a real hello/query handshake, got ${String(report.runtime)}`,
  )

  console.log(`  launched, renderer mounted: ${JSON.stringify(report)}`)
  console.log('PASS: desktop launch')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
