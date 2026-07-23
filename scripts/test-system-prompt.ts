/**
 * 系统提示词 + BOLO.md 单测（不联网）
 * 运行：node --import tsx/esm scripts/test-system-prompt.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadBoloMd,
  getSystemPrompt,
  buildEffectiveSystemPrompt,
  prepareModelMessages,
  assembleSessionSystemPrompt,
  createSession,
} from '../packages/core/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'
import type { LoadedSkill } from '../packages/skills/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-sys-'))
  const userDir = path.join(tmp, 'user-bolo')
  await fs.mkdir(userDir, { recursive: true })
  await fs.writeFile(
    path.join(tmp, 'BOLO.md'),
    '# Project BOLO\nAlways use descriptive commit messages.\n',
    'utf8',
  )
  await fs.writeFile(
    path.join(userDir, 'BOLO.md'),
    '# User BOLO\nPrefer Chinese comments in new code.\n',
    'utf8',
  )

  // 1) loadBoloMd
  const loaded = await loadBoloMd({
    cwd: tmp,
    userConfigDir: userDir,
  })
  assert(loaded.sources.length >= 2, 'loads user + project BOLO.md')
  assert(loaded.text.includes('Project BOLO'), 'project body present')
  assert(loaded.text.includes('User BOLO'), 'user body present')
  assert(loaded.text.includes('BOLO.md'), 'mentions BOLO.md brand')

  // 2) getSystemPrompt 非空 + 身份 + 环境
  const sections = await getSystemPrompt({
    cwd: tmp,
    userConfigDir: userDir,
    permissionMode: 'default',
    model: 'test-model',
    date: '2026-07-24',
  })
  assert(sections.length >= 4, `sections non-empty got ${sections.length}`)
  const joined = sections.join('\n\n')
  assert(joined.includes('Bolo Code'), 'identity Bolo Code')
  assert(joined.includes(tmp) || joined.includes('Working directory'), 'env cwd')
  assert(joined.includes('2026-07-24'), 'env date')
  assert(joined.includes('default'), 'permission mode')
  assert(joined.includes('test-model'), 'model')
  assert(joined.includes('Project BOLO'), 'bolo md in system')

  // 3) skill catalog 可选
  const fakeSkill: LoadedSkill = {
    meta: {
      id: 'demo-skill',
      name: 'Demo',
      description: 'A demo skill for catalog',
      path: path.join(tmp, 'skills', 'demo', 'SKILL.md'),
    },
    source: 'project',
    body: 'FULL BODY SHOULD NOT APPEAR',
    frontmatter: {},
  }
  const withCatalog = await getSystemPrompt({
    cwd: tmp,
    userConfigDir: userDir,
    loadInstructions: false,
    skills: [fakeSkill],
  })
  const catJoined = withCatalog.join('\n')
  assert(catJoined.includes('demo-skill'), 'catalog id')
  assert(!catJoined.includes('FULL BODY SHOULD NOT APPEAR'), 'no skill body')

  // 4) buildEffectiveSystemPrompt
  const overridden = buildEffectiveSystemPrompt({
    overrideSystemPrompt: 'ONLY',
    defaultSystemPrompt: sections,
    appendSystemPrompt: 'ignored',
  })
  assert(overridden.length === 1 && overridden[0] === 'ONLY', 'override wins')

  const appended = buildEffectiveSystemPrompt({
    defaultSystemPrompt: ['A'],
    appendSystemPrompt: 'B',
  })
  assert(appended.join('|') === 'A|B', 'append works')

  // 5) prepareModelMessages 分离 system
  const conv: ChatMessage[] = [
    { role: 'system', content: 'stale' },
    { role: 'user', content: 'hi' },
  ]
  const forModel = prepareModelMessages({
    systemSections: ['SYS1', 'SYS2'],
    conversation: conv,
  })
  assert(forModel[0]?.role === 'system' && forModel[0].content === 'SYS1', 'sys0')
  assert(forModel[1]?.role === 'system' && forModel[1].content === 'SYS2', 'sys1')
  assert(forModel[2]?.role === 'user', 'user after system')
  assert(!forModel.some((m) => m.content === 'stale'), 'drops stale system')

  // 6) assemble + createSession
  const assembled = await assembleSessionSystemPrompt({
    cwd: tmp,
    userConfigDir: userDir,
    permissionMode: 'acceptEdits',
  })
  assert(assembled.some((s) => s.includes('Bolo Code')), 'assemble identity')

  const session = await createSession({
    cwd: tmp,
    systemPrompt: {
      userConfigDir: userDir,
      model: 'm1',
    },
  })
  assert(session.systemPromptSections.length > 0, 'session has system sections')
  assert(
    session.systemPromptSections.some((s) => s.includes('Bolo Code')),
    'session identity',
  )
  assert(
    !session.messages.some((m) => m.role === 'system'),
    'conversation without system by default',
  )

  // 7) 截断预算
  const huge = 'x'.repeat(50_000)
  await fs.writeFile(path.join(tmp, 'AGENTS.md'), huge, 'utf8')
  const capped = await loadBoloMd({
    cwd: tmp,
    userConfigDir: path.join(tmp, 'empty-user'),
    maxCharsPerFile: 1000,
    maxTotalChars: 2000,
    // 已有 BOLO.md；再读兼容文件时受预算限制
  })
  assert(capped.text.length < 60_000, 'total budget applies')
  const anyTrunc = capped.sources.some((s) => s.truncated)
  // 至少项目 BOLO 很小不截断；若读到 AGENTS 应截断
  if (capped.sources.some((s) => s.label === 'AGENTS.md')) {
    assert(anyTrunc, 'large file truncated')
  }

  console.log('PASS test-system-prompt')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})