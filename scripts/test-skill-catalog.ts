/**
 * Skill 目录索引 + 按需加载 — 对照 HC skill_listing / SkillTool
 * 含 bundled skill-creator / plugin-creator 发现
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  formatSkillCatalog,
  findSkillById,
  formatSkillBodyForInjection,
  discoverSkills,
  getBundledSkillsDir,
  type LoadedSkill,
} from '../packages/skills/src/index.ts'
import { executeTool } from '../packages/tools/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

const skills: LoadedSkill[] = [
  {
    meta: {
      id: 'demo',
      name: 'Demo',
      description: 'A demo skill',
      whenToUse: 'when testing catalog',
      path: '/tmp/demo/SKILL.md',
    },
    source: 'user',
    body: 'FULL BODY SHOULD NOT BE IN CATALOG',
    frontmatter: {},
  },
  {
    meta: {
      id: 'secret',
      name: 'Secret',
      description: 'user only',
      path: '/tmp/secret/SKILL.md',
      disableModelInvocation: true,
    },
    source: 'user',
    body: 'secret body',
    frontmatter: {},
  },
]

const catalog = formatSkillCatalog(skills)
assert(catalog.includes('demo'), 'demo in catalog')
assert(catalog.includes('when testing'), 'whenToUse in catalog')
assert(!catalog.includes('FULL BODY'), 'no full body in catalog')
assert(!catalog.includes('secret'), 'disable-model-invocation omitted from model catalog')

const found = findSkillById(skills, 'demo')
assert(found, 'find demo')
const body = formatSkillBodyForInjection(found!)
assert(body.includes('FULL BODY'), 'body has full text')

const r = await executeTool('Skill', { skill: 'demo' }, { cwd: process.cwd(), skills })
assert(r.ok, 'Skill tool ok')
assert(r.output.includes('FULL BODY'), 'Skill tool returns body')

const bad = await executeTool('Skill', { skill: 'nope' }, { cwd: process.cwd(), skills })
assert(!bad.ok, 'unknown skill fails')

const blocked = await executeTool(
  'Skill',
  { skill: 'secret' },
  { cwd: process.cwd(), skills },
)
assert(!blocked.ok, 'disable-model-invocation blocks tool')

// ── bundled creators ──
const bundledDir = getBundledSkillsDir()
const discovered = await discoverSkills({
  cwd: process.cwd(),
  // 隔离 user/project：空临时目录
  userBoloDir: path.join(os.tmpdir(), `bolo-skill-test-user-${Date.now()}`),
})
const creator = findSkillById(discovered, 'skill-creator')
const pluginCreator = findSkillById(discovered, 'plugin-creator')
assert(creator, 'bundled skill-creator found')
assert(pluginCreator, 'bundled plugin-creator found')
assert(creator!.source === 'bundled', 'skill-creator source=bundled')
assert(pluginCreator!.source === 'bundled', 'plugin-creator source=bundled')
assert(
  creator!.meta.path.includes(path.join('skill-creator', 'SKILL.md')) ||
    creator!.meta.path.replace(/\\/g, '/').includes('skill-creator/SKILL.md'),
  'skill-creator path under bundled',
)
const cat = formatSkillCatalog(discovered)
assert(cat.includes('skill-creator'), 'skill-creator in catalog')
assert(cat.includes('plugin-creator'), 'plugin-creator in catalog')

// project 同 id 覆盖 bundled
const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-skill-proj-'))
const overrideDir = path.join(tmpProject, '.bolo', 'skills', 'skill-creator')
await fs.mkdir(overrideDir, { recursive: true })
await fs.writeFile(
  path.join(overrideDir, 'SKILL.md'),
  `---
name: skill-creator
id: skill-creator
description: project override
---
OVERRIDE BODY
`,
  'utf8',
)
const merged = await discoverSkills({
  cwd: tmpProject,
  userBoloDir: path.join(os.tmpdir(), `bolo-skill-test-user2-${Date.now()}`),
})
const overridden = findSkillById(merged, 'skill-creator')
assert(overridden, 'override still found')
assert(overridden!.source === 'project', 'project overrides bundled')
assert(overridden!.body.includes('OVERRIDE BODY'), 'override body')

// bundled dir 可定位
const st = await fs.stat(bundledDir)
assert(st.isDirectory(), 'bundled-skills dir exists')

console.log('SKILL CATALOG TESTS PASS')