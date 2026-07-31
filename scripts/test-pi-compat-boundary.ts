/**
 * piCompat 收口门禁：全仓库源码（packages / apps / scripts）只有
 * packages/cli/src/tui/piCompat.ts 允许直连 @earendil-works/pi-tui。
 * 守住"升级 / 替换 / fork pi-tui 只改一个文件"的治理边界，
 * 防止未来新增 deep import 重新把 import 面散落各处。
 */
import { strict as assert } from 'node:assert'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'release',
  '.git',
  '.bolo',
  '.bolo-tmp',
  '.planning',
  '.claude',
  '.codex',
  '.cursor',
  '.reasonix',
])

const PI_TUI_DIRECT =
  /from\s+['"]@earendil-works\/pi-tui|import\s*\(\s*['"]@earendil-works\/pi-tui|require\(\s*['"]@earendil-works\/pi-tui|^\s*import\s+['"]@earendil-works\/pi-tui/m

async function collectSources(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectSources(full)))
    } else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

async function main(): Promise<void> {
  const sources = await collectSources(repoRoot)
  assert.ok(
    sources.length > 100,
    `scan breadth sanity: expected >100 source files, got ${sources.length}`,
  )
  const piCompat = path.join(repoRoot, 'packages', 'cli', 'src', 'tui', 'piCompat.ts')
  const offenders: string[] = []
  let compatCount = 0
  for (const file of sources) {
    const text = await fs.readFile(file, 'utf8')
    if (!PI_TUI_DIRECT.test(text)) continue
    if (path.resolve(file) === path.resolve(piCompat)) {
      compatCount += 1
    } else {
      offenders.push(path.relative(repoRoot, file))
    }
  }
  assert.equal(
    compatCount,
    1,
    `piCompat.ts must be the single compat module (found ${compatCount})`,
  )
  assert.deepEqual(
    offenders,
    [],
    `only piCompat.ts may import @earendil-works/pi-tui; offenders: ${offenders.join(', ')}`,
  )
  const compatText = await fs.readFile(piCompat, 'utf8')
  assert.ok(
    compatText.includes('@earendil-works/pi-tui/dist/tui.js'),
    'piCompat must re-export the retained renderer',
  )
  console.log(
    `PASS: pi-tui direct imports confined to piCompat.ts (${sources.length} source files scanned)`,
  )
}

await main()
