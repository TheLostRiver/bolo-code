/**
 * AR3F：把 Electron 主进程打成单文件产物
 *
 * 设计文档把打包列为「唯一必须从零搭的板块」，根因是主进程原先靠
 * `tsx` 直读 TS 源码 + 四级相对路径 `path.resolve(__dirname, '../../../..')`
 * 去 import `packages/*`。打进 asar 之后那条路径必然失效，
 * 而且计算路径的动态 import 本来就**无法被静态分析**，打包器看不见它们。
 *
 * 已把主进程改成静态导入，于是这里就是一次普通的 bundle。
 *
 * ## 与 CLI 那条链的关系（设计文档 §7 的未决问题之一）
 *
 * **复用做法，不复用脚本。** 两者的 esbuild 配置有三处硬性不同：
 *
 * - `electron` 必须 **external**：它由 Electron 运行时提供，打进去会炸
 * - 产物格式与入口不同（CLI 是带 shebang 的 node bin）
 * - 输出位置不同（desktop 要落在 app 目录里以便进 asar）
 *
 * 硬塞进一个脚本只会变成一堆分支。共享的是「esbuild 只进 devDependencies、
 * 产物零运行时依赖」这条原则，那条已经由 `dependencies: {}` 门禁守着。
 *
 * 运行：npx tsx scripts/build-desktop.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const appDir = path.join(repoRoot, 'apps', 'desktop')
const outDir = path.join(appDir, 'dist')
const outFile = path.join(outDir, 'main.mjs')

async function main() {
  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })

  const result = await build({
    entryPoints: [path.join(appDir, 'src', 'main', 'index.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    // electron 由运行时提供；打进产物会在启动时炸。
    // 其余一律打进去 —— 列成 external 就等于引入运行时依赖。
    external: ['electron'],
    packages: 'bundle',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  })

  const bytes = (await fs.stat(outFile)).size
  const moduleCount = Object.keys(result.metafile?.inputs ?? {}).length

  // preload 是 CommonJS 且只用 electron API，不需要打包，原样拷贝。
  // 它是 renderer 唯一的入口，保持可审计的纯文本反而更好。
  await fs.copyFile(
    path.join(appDir, 'src', 'preload', 'index.cjs'),
    path.join(outDir, 'preload.cjs'),
  )

  // renderer 壳仍是原生 JS/CSS/HTML，原样拷贝；共享 RuntimeClient 是
  // TypeScript，需要单独打成浏览器 ESM，避免在 app.js 复制协议状态机。
  const rendererOut = path.join(outDir, 'renderer')
  await fs.mkdir(rendererOut, { recursive: true })
  await build({
    entryPoints: [
      path.join(repoRoot, 'packages', 'shared', 'src', 'runtimeClient.ts'),
    ],
    outfile: path.join(rendererOut, 'runtime-client.js'),
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  })
  for (const name of ['index.html', 'app.js', 'styles.css']) {
    await fs.copyFile(
      path.join(appDir, 'src', 'renderer', name),
      path.join(rendererOut, name),
    )
  }

  // 日志走 stderr：stdout 留给可能的 --json 消费方
  process.stderr.write(
    `desktop main bundled: ${(bytes / 1024).toFixed(0)} KB from ${moduleCount} modules\n` +
      `  ${path.relative(repoRoot, outFile)}\n`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
