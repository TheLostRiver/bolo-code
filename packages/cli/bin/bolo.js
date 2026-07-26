#!/usr/bin/env node
/**
 * **仓库内**可执行入口：用 tsx 直接跑 TypeScript 源。
 *
 * 这不是发布产物的入口。发布出去的 bin 是 `dist/bolo.mjs`（esbuild 单文件、
 * 零运行时依赖），见 docs/RELEASE.md —— 用户装到的包里没有 tsx，也没有本文件。
 *
 * 保留本文件的原因：改源码即时生效，且 scripts/test-runtime-cli-*.ts 用它做
 * 「真实 bin」E2E。删掉会同时打断开发回路与那三个测试。
 *
 * 用法：node packages/cli/bin/bolo.js --resume [id]   （或 npm run dev --）
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const entry = path.resolve(__dirname, '../src/main.ts')
const root = path.resolve(__dirname, '../../..')

function resolveTsxCli() {
  try {
    return require.resolve('tsx/cli')
  } catch {
    return require.resolve('tsx/cli', { paths: [root] })
  }
}

const tsxCli = resolveTsxCli()
const result = spawnSync(
  process.execPath,
  [tsxCli, entry, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
  },
)

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)