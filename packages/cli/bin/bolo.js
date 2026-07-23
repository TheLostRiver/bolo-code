#!/usr/bin/env node
/**
 * bolo 可执行入口：用 tsx 跑 TypeScript main。
 * 用法：bolo --resume [id]
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