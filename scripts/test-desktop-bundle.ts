/**
 * AR3F · Electron 主进程打包产物必须自包含
 *
 * 设计文档把打包列为「唯一必须从零搭的板块」。根因是主进程原先靠 `tsx`
 * 直读 TS 源码 + 四级相对路径去 import `packages/*`——打进 asar 后那条路径
 * 必然失效，而计算路径的动态 import 本来就无法被静态分析。
 *
 * **「能生成产物」不等于「产物能跑」。** CLI 那条链上已经吃过这个亏：
 * 打出来了，装上去却报 `Cannot find module 'tsx/cli'`。所以这里验的是
 * 产物**自身**的性质，而不是构建过程有没有报错：
 *
 * - 不得残留 `tsx` 引用：它是 devDependency，用户机器上不存在
 * - 不得残留 `.ts` 导入：打包后没有 TS 加载器
 * - 不得残留 `repoRoot` 那种向上四级的路径推算：asar 里没有仓库结构
 * - `electron` 必须是 external：它由运行时提供，打进去会在启动时炸
 * - preload 与 renderer 必须一并产出：只打主进程等于打了个跑不起来的壳
 *
 * 运行：npx tsx scripts/test-desktop-bundle.ts
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

const OUT_DIR = path.join('apps', 'desktop', 'dist')
const MAIN = path.join(OUT_DIR, 'main.mjs')

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  // 每次都重新构建：测的是「当前源码能否打出可用产物」，
  // 而不是「上次留下的产物长什么样」
  const built = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', path.join('scripts', 'build-desktop.ts')],
    { encoding: 'utf8' },
  )
  assert(
    built.status === 0,
    `the desktop bundler failed:\n${built.stderr || built.stdout}`,
  )

  assert(await exists(MAIN), `main bundle exists at ${MAIN}`)
  const src = await fs.readFile(MAIN, 'utf8')

  assert(
    src.length > 50_000,
    `bundle looks suspiciously small (${src.length} bytes) — packages probably were not bundled in`,
  )

  // ── 残留的构建期依赖 ──
  assert(
    !/\btsx\/(esm|cli)\b/.test(src),
    'bundle still references tsx — it is a devDependency and will not exist on a user machine',
  )
  assert(
    !/from\s+['"][^'"]+\.ts['"]/.test(src),
    'bundle still contains .ts imports — nothing will load them after packaging',
  )
  assert(
    !/\.\.\/\.\.\/\.\.\/\.\./.test(src),
    'bundle still climbs four levels to find the repo root — that structure does not exist inside an asar',
  )

  // ── electron 必须外置 ──
  assert(
    /from\s*["']electron["']/.test(src) || /require\(["']electron["']\)/.test(src),
    'bundle should import electron rather than inline it — it is provided by the runtime',
  )
  assert(
    !/BrowserWindow\s*=\s*class/.test(src),
    'electron internals must not be bundled in',
  )

  // ── 壳的其余部分要一并产出 ──
  for (const rel of [
    'preload.cjs',
    path.join('renderer', 'index.html'),
    path.join('renderer', 'app.js'),
    path.join('renderer', 'runtime-client.js'),
    path.join('renderer', 'styles.css'),
  ]) {
    assert(
      await exists(path.join(OUT_DIR, rel)),
      `${rel} is emitted — a main bundle alone is a shell that cannot start`,
    )
  }
  const runtimeClient = await fs.readFile(
    path.join(OUT_DIR, 'renderer', 'runtime-client.js'),
    'utf8',
  )
  assert(
    runtimeClient.includes('createRuntimeClient'),
    'the renderer runtime bundle contains the shared RuntimeClient implementation',
  )
  assert(
    !/from\s+['"][^'"]+\.ts['"]/.test(runtimeClient),
    'the browser runtime client has no TypeScript imports left for Electron to resolve',
  )

  // ── 产物里引用的资源路径必须真的存在 ──
  //
  // 源码布局是 src/{main,preload,renderer}，产物布局是
  // dist/{main.mjs, preload.cjs, renderer/}。主进程若按源码布局算相对路径
  // （`../preload/index.cjs`），打包后就会指向一个不存在的位置——
  // **而这不会在构建时报错，只会在窗口打开那一刻白屏**。
  {
    // 不按变量名匹配：esbuild 会把 `path` 重命名成 `path26` 之类。
    // 只断言**语义**——产物里得引用到这两个资源名。
    assert(
      src.includes('preload.cjs'),
      'the bundle wires a preload file — if this stops matching, fix the check rather than dropping it',
    )
    assert(
      src.includes('index.html'),
      'the bundle wires the renderer entry',
    )
    assert(
      !/\.\.\/preload/.test(src),
      'the bundle references ../preload — that is the source layout, not the emitted one',
    )
    assert(
      !/\.\.\/renderer/.test(src),
      'the bundle references ../renderer — that is the source layout, not the emitted one',
    )
  }

  // ── 产物语法必须有效 ──
  const check = spawnSync(process.execPath, ['--check', MAIN], {
    encoding: 'utf8',
  })
  assert(
    check.status === 0,
    `the emitted bundle is not valid JS:\n${check.stderr}`,
  )

  // ── 零运行时依赖红线 ──
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as {
    dependencies?: Record<string, unknown>
  }
  assert(
    Object.keys(pkg.dependencies ?? {}).length === 0,
    `dependencies must stay empty: ${JSON.stringify(pkg.dependencies)}`,
  )

  console.log(
    `  main.mjs ${(src.length / 1024).toFixed(0)} KB · preload + renderer/runtime client emitted · electron external`,
  )
  console.log('PASS: desktop bundle')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
