/**
 * .bolo/rules 装载 + system 注入（不联网）
 * 运行：npx tsx scripts/test-rules.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadBoloRules,
  parseRuleFrontmatter,
  getSystemPrompt,
  assembleSessionSystemPrompt,
  createSession,
  dispatchSlashCommand,
  ensureProjectLayout,
} from '../packages/core/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-rules-'))
  const userDir = path.join(tmp, 'user-bolo')
  const projectRules = path.join(tmp, '.bolo', 'rules')
  const userRules = path.join(userDir, 'rules')
  await fs.mkdir(projectRules, { recursive: true })
  await fs.mkdir(path.join(projectRules, 'nested'), { recursive: true })
  await fs.mkdir(userRules, { recursive: true })

  await fs.writeFile(
    path.join(projectRules, 'style.md'),
    'Use tabs for indentation in this project.\n',
    'utf8',
  )
  await fs.writeFile(
    path.join(projectRules, 'nested', 'api.md'),
    '---\nalwaysApply: true\n---\nAPI handlers must return typed errors.\n',
    'utf8',
  )
  await fs.writeFile(
    path.join(projectRules, 'off.md'),
    '---\ndisabled: true\n---\nThis must never appear in the prompt.\n',
    'utf8',
  )
  await fs.writeFile(
    path.join(projectRules, 'path-only.md'),
    '---\nalwaysApply: false\n---\nPath-gated rule body should be skipped in v1.\n',
    'utf8',
  )
  await fs.writeFile(
    path.join(userRules, 'prefs.md'),
    'Prefer concise commit messages.\n',
    'utf8',
  )
  // node_modules 下应被跳过
  await fs.mkdir(path.join(projectRules, 'node_modules', 'x'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(projectRules, 'node_modules', 'x', 'evil.md'),
    'EVIL_SHOULD_NOT_LOAD\n',
    'utf8',
  )

  // frontmatter unit
  const fm = parseRuleFrontmatter(
    '---\ndisabled: true\nalwaysApply: false\n---\nbody here\n',
  )
  assert(fm.meta.disabled === true, 'fm disabled')
  assert(fm.meta.alwaysApply === false, 'fm alwaysApply false')
  assert(fm.body.includes('body here'), 'fm body')

  // loadBoloRules
  const loaded = await loadBoloRules({
    cwd: tmp,
    userConfigDir: userDir,
  })
  assert(loaded.sources.length === 3, `sources=3 got ${loaded.sources.length}`)
  assert(
    loaded.sources.some((s) => s.label.includes('prefs.md')),
    'user prefs',
  )
  assert(
    loaded.sources.some((s) => s.label.includes('style.md')),
    'project style',
  )
  assert(
    loaded.sources.some((s) => s.label.includes('nested/api.md')),
    'nested api',
  )
  assert(
    !loaded.sources.some((s) => s.label.includes('off.md')),
    'disabled skipped',
  )
  assert(
    !loaded.sources.some((s) => s.label.includes('path-only')),
    'alwaysApply false skipped',
  )
  assert(!loaded.text.includes('EVIL_SHOULD_NOT_LOAD'), 'skip node_modules')
  assert(!loaded.text.includes('never appear'), 'disabled body absent')
  assert(loaded.text.includes('# Project rules'), 'section title')
  assert(loaded.text.includes('Use tabs for indentation'), 'style body')
  assert(loaded.text.includes('typed errors'), 'api body')
  assert(loaded.text.includes('concise commit'), 'user body')

  // 稳定排序：用户 prefs 在项目 style 前；nested/api 在 style 后（路径排序）
  const labels = loaded.sources.map((s) => s.label)
  const iUser = labels.findIndex((l) => l.includes('prefs.md'))
  const iStyle = labels.findIndex((l) => l.includes('style.md'))
  const iApi = labels.findIndex((l) => l.includes('nested/api.md'))
  assert(iUser < iStyle, 'user before project')
  assert(iApi < iStyle || iStyle < iApi, 'project files ordered')
  // nested/api.md vs style.md: 'nested/...' < 'style.md'
  assert(iApi < iStyle, 'nested/api before style by path')

  // getSystemPrompt 注入
  const sections = await getSystemPrompt({
    cwd: tmp,
    userConfigDir: userDir,
    date: '2026-07-24',
    loadInstructions: false,
  })
  const joined = sections.join('\n\n')
  assert(joined.includes('# Project rules'), 'rules section in system')
  assert(joined.includes('Use tabs for indentation'), 'rules content in system')

  // 与 BOLO.md 并存：rules 段在 BOLO 前
  await fs.writeFile(path.join(tmp, 'BOLO.md'), '# Project BOLO\nBuild with pnpm.\n', 'utf8')
  const both = await assembleSessionSystemPrompt({
    cwd: tmp,
    userConfigDir: userDir,
    date: '2026-07-24',
  })
  const bothText = both.join('\n\n')
  assert(bothText.includes('Project rules'), 'rules present with BOLO')
  assert(bothText.includes('Project BOLO') || bothText.includes('Build with pnpm'), 'BOLO present')
  const ri = bothText.indexOf('# Project rules')
  const bi = bothText.indexOf('# Project & user instructions')
  assert(ri !== -1 && bi !== -1 && ri < bi, 'rules before BOLO.md section')

  // ensureProjectLayout 创建 rules/
  const layoutTmp = path.join(tmp, 'layout-proj')
  await fs.mkdir(layoutTmp, { recursive: true })
  const ensured = await ensureProjectLayout(layoutTmp, { writeDefaults: false })
  const rulesDir = path.join(layoutTmp, '.bolo', 'rules')
  const st = await fs.stat(rulesDir)
  assert(st.isDirectory(), 'ensureProjectLayout creates rules/')
  assert(ensured.layout.rulesDir === rulesDir, 'layout.rulesDir path')

  // /rules slash
  const session = await createSession({
    cwd: tmp,
    systemPrompt: { userConfigDir: userDir, date: '2026-07-24' },
  })
  const list = await dispatchSlashCommand(session, 'rules', '')
  assert(list.ok && list.message.includes('style.md'), '/rules list')
  const show = await dispatchSlashCommand(session, 'rules', 'show style')
  assert(show.ok && show.message.includes('tabs'), '/rules show')

  // BOLO_DISABLE_RULES
  process.env.BOLO_DISABLE_RULES = '1'
  const disabled = await loadBoloRules({ cwd: tmp, userConfigDir: userDir })
  assert(disabled.sources.length === 0, 'env disable')
  delete process.env.BOLO_DISABLE_RULES

  console.log('ok test-rules')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})