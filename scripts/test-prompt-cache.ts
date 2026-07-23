/**
 * Prompt cache 友好前缀：stable 字节级稳定 + tools 名排序
 * 运行：node --import tsx/esm scripts/test-prompt-cache.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getSystemPrompt,
  getSystemPromptPartition,
  getCacheStableSections,
  getCacheStablePrefix,
  prepareModelMessages,
} from '../packages/core/src/index.ts'
import { toolsToOpenAI } from '../packages/tools/src/providerSchema.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-cache-'))
  const userDir = path.join(tmp, 'user-bolo')
  await fs.mkdir(userDir, { recursive: true })
  await fs.writeFile(
    path.join(tmp, 'BOLO.md'),
    '# Project\nUse clear names.\n',
    'utf8',
  )

  // 1) 无参 / 内置 stable 非空且固定序
  const stable = getCacheStableSections()
  assert(stable.length === 4, `stable section count ${stable.length}`)
  assert(stable[0]!.startsWith('# Identity'), 'stable0 Identity')
  assert(stable[1]!.startsWith('# System'), 'stable1 System')
  assert(stable[2]!.startsWith('# Task style'), 'stable2 Task')
  assert(stable[3]!.startsWith('# Tools'), 'stable3 Tools')
  const prefixBuiltIn = getCacheStablePrefix()
  assert(prefixBuiltIn.includes('Bolo Code'), 'prefix identity')
  assert(!prefixBuiltIn.includes('# Environment'), 'stable has no Environment')

  // 2) 同一 cwd 两次组装，仅改假时间 → stable 前缀字节级相同
  const baseOpts = {
    cwd: tmp,
    userConfigDir: userDir,
    permissionMode: 'default' as const,
    model: 'test-model',
    loadInstructions: true,
    loadRules: false,
  }

  const partA = await getSystemPromptPartition({
    ...baseOpts,
    now: () => new Date('2026-01-01T12:00:00Z'),
  })
  const partB = await getSystemPromptPartition({
    ...baseOpts,
    now: () => new Date('2026-07-24T18:30:00Z'),
  })

  const prefixA = getCacheStablePrefix(partA)
  const prefixB = getCacheStablePrefix(partB)
  assert(prefixA === prefixB, 'stable prefix byte-identical across fake clocks')
  assert(
    Buffer.from(prefixA, 'utf8').equals(Buffer.from(prefixB, 'utf8')),
    'stable prefix Buffer equals',
  )

  // volatile 应含不同 Date
  const volA = partA.volatileSections.join('\n')
  const volB = partB.volatileSections.join('\n')
  assert(volA.includes('# Environment'), 'vol has Environment')
  assert(volA !== volB, 'volatile differs when date/now changes')
  assert(volA.includes('Date:'), 'volA has Date line')
  assert(volB.includes('Date:'), 'volB has Date line')

  // 完整 sections：stable 在前
  const full = await getSystemPrompt({
    ...baseOpts,
    date: '2026-07-24',
  })
  assert(full[0]!.startsWith('# Identity'), 'full starts Identity')
  const envIdx = full.findIndex((s) => s.startsWith('# Environment'))
  assert(envIdx > 0, 'Environment after stable')
  assert(
    getCacheStablePrefix(full) === prefixBuiltIn,
    'partition from full matches built-in prefix',
  )

  // 3) 仅改 user message → prepareModelMessages 的 system 前缀不变
  const sections = await getSystemPrompt({
    ...baseOpts,
    date: 'fixed-date-for-test',
  })
  const conv1: ChatMessage[] = [{ role: 'user', content: 'hello' }]
  const conv2: ChatMessage[] = [{ role: 'user', content: 'different user text' }]
  const m1 = prepareModelMessages({ systemSections: sections, conversation: conv1 })
  const m2 = prepareModelMessages({ systemSections: sections, conversation: conv2 })
  const sys1 = m1.filter((m) => m.role === 'system').map((m) => m.content)
  const sys2 = m2.filter((m) => m.role === 'system').map((m) => m.content)
  assert(
    JSON.stringify(sys1) === JSON.stringify(sys2),
    'system messages identical when only user text changes',
  )
  assert(m1[m1.length - 1]?.content === 'hello', 'user1 last')
  assert(m2[m2.length - 1]?.content === 'different user text', 'user2 last')
  assert(
    getCacheStablePrefix(sys1) === getCacheStablePrefix(sys2),
    'stable prefix from prepared system identical',
  )

  // 4) tools 名排序稳定（乱序输入 → 有序输出）
  const shuffled = [
    { name: 'Write', description: 'w' },
    { name: 'Bash', description: 'b' },
    { name: 'Read', description: 'r' },
    { name: 'Glob', description: 'g' },
  ]
  const oai1 = toolsToOpenAI(shuffled)
  const oai2 = toolsToOpenAI([...shuffled].reverse())
  const names1 = oai1.map((t) => t.function.name)
  const names2 = oai2.map((t) => t.function.name)
  assert(
    JSON.stringify(names1) === JSON.stringify(names2),
    'toolsToOpenAI order stable under input shuffle',
  )
  const sorted = [...names1].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base' }),
  )
  assert(
    JSON.stringify(names1) === JSON.stringify(sorted),
    'toolsToOpenAI names sorted by name',
  )

  console.log('PASS test-prompt-cache')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})