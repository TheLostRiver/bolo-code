/**
 * AR5C-early：把 CLI 打成单文件发布产物
 *
 * 为什么是 bundle 而不是 tsc：
 * 全仓 491 处相对导入带显式 `.ts` 扩展名，而 TS 的 `allowImportingTsExtensions`
 * 强制 `noEmit`。要用 tsc 出 JS 就得改动全部导入——风险远高于收益。
 * esbuild 只做构建期工具（devDependency），产物零运行时依赖，
 * `dependencies` 保持 `{}`。
 *
 * 运行：npx tsx scripts/build-dist.ts  （或 npm run build）
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const outDir = path.join(repoRoot, 'dist')
const outFile = path.join(outDir, 'bolo.mjs')

async function main() {
  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })

  const pkg = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as { version?: string }

  const result = await build({
    entryPoints: [path.join(repoRoot, 'packages', 'cli', 'src', 'main.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    // Node 内置模块保持 external；其余全部打进产物。
    // 不列第三方 external —— 列了就等于引入运行时依赖。
    packages: 'bundle',
    banner: {
      js: '#!/usr/bin/env node',
    },
    define: {
      'process.env.BOLO_BUILD_VERSION': JSON.stringify(pkg.version ?? '0.0.0'),
    },
    // 保留可读栈，便于用户报 bug；体积不是首要矛盾
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  })

  // bundled-skills 是数据资产，随产物一起发；路径解析见 skills/getBundledSkillsDir
  const skillsSrc = path.join(repoRoot, 'packages', 'bundled-skills')
  const skillsDst = path.join(outDir, 'bundled-skills')
  await fs.cp(skillsSrc, skillsDst, { recursive: true })

  await fs.chmod(outFile, 0o755).catch(() => {})

  const stat = await fs.stat(outFile)
  const inputs = Object.keys(result.metafile?.inputs ?? {}).length
  // 写 stderr：build 常被 prepack 调用，stdout 归 `npm pack --json` 之类的消费者
  console.error(
    `built dist/bolo.mjs — ${(stat.size / 1024).toFixed(0)} KB from ${inputs} modules`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
