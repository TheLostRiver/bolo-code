/**
 * Skill 目录索引 + frontmatter 契约（S-PORT-1）+ 按需加载
 * 对照 HC skill_listing / SkillTool / parseSkillFrontmatterFields
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
  parseSkillMarkdown,
  parseSkillFrontmatterFields,
  SKILL_FRONTMATTER_ALIASES,
  type LoadedSkill,
} from '../packages/skills/src/index.ts'
import { executeTool } from '../packages/tools/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

// ── S-PORT-1 frontmatter 契约 ──
const fmWhen = parseSkillFrontmatterFields(
  {
    name: 'Demo',
    whenToUse: 'camel when',
    description: 'd',
  },
  { fallbackId: 'demo' },
)
assert(fmWhen.whenToUse === 'camel when', 'whenToUse alias')
assert(fmWhen.id === 'demo', 'fallback id')

const fmWhenKebab = parseSkillFrontmatterFields({
  id: 'x',
  'when-to-use': 'kebab when',
})
assert(fmWhenKebab.whenToUse === 'kebab when', 'when-to-use alias')

const fmWhenSnake = parseSkillFrontmatterFields({
  id: 'x',
  when_to_use: 'snake when',
})
assert(fmWhenSnake.whenToUse === 'snake when', 'when_to_use canonical')

// 规范键赢过别名
const fmPrefer = parseSkillFrontmatterFields({
  id: 'x',
  when_to_use: 'canonical',
  whenToUse: 'alias-lose',
})
assert(fmPrefer.whenToUse === 'canonical', 'canonical when_to_use wins')

const fmDisable = parseSkillFrontmatterFields({
  id: 'x',
  disableModelInvocation: 'true',
})
assert(fmDisable.disableModelInvocation === true, 'disableModelInvocation alias')

const fmDisableSnake = parseSkillFrontmatterFields({
  id: 'x',
  disable_model_invocation: 'yes',
})
assert(fmDisableSnake.disableModelInvocation === true, 'disable_model_invocation yes')

const fmUser = parseSkillFrontmatterFields({
  id: 'x',
  userInvocable: 'false',
})
assert(fmUser.userInvocable === false, 'userInvocable alias false')

// 未知键不进 canonical
const fmUnknown = parseSkillFrontmatterFields({
  id: 'x',
  description: 'ok',
  weird_future_key: 'ignore-me',
})
assert(fmUnknown.description === 'ok', 'known field')
assert(
  fmUnknown.canonical.weird_future_key === undefined,
  'unknown not in canonical',
)
assert(fmUnknown.raw.weird_future_key === 'ignore-me', 'unknown kept in raw')

const md = parseSkillMarkdown(
  `---
name: "Quoted Name"
id: my-skill
description: Short
whenToUse: Use for tests
disable-model-invocation: false
user-invocable: true
custom: ignored
---

# Body here
FULL TEXT
`,
  { fallbackId: 'dir' },
)
assert(md.fields.id === 'my-skill', 'md id')
assert(md.fields.name === 'Quoted Name', 'md name unquoted')
assert(md.fields.whenToUse === 'Use for tests', 'md whenToUse')
assert(md.fields.disableModelInvocation === false, 'md disable false')
assert(md.fields.userInvocable === true, 'md user true')
assert(md.body.includes('FULL TEXT'), 'md body')
assert(md.fields.raw.custom === 'ignored', 'raw keeps custom')
assert(SKILL_FRONTMATTER_ALIASES.whenToUse === 'when_to_use', 'alias map')

// 坏文件：无 frontmatter 仍可用目录名
const bare = parseSkillMarkdown('# only body\n', { fallbackId: 'bare-skill' })
assert(bare.fields.id === 'bare-skill', 'bare fallback id')
assert(bare.body.includes('only body'), 'bare body')

// ── catalog + tool ──
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
      userInvocable: true,
    },
    source: 'user',
    body: 'secret body',
    frontmatter: {},
  },
  {
    meta: {
      id: 'nouser',
      name: 'NoUser',
      description: 'model only',
      path: '/tmp/nouser/SKILL.md',
      userInvocable: false,
    },
    source: 'user',
    body: 'no user body',
    frontmatter: {},
  },
]

const catalog = formatSkillCatalog(skills)
assert(catalog.includes('demo'), 'demo in catalog')
assert(catalog.includes('when testing'), 'whenToUse in catalog')
assert(!catalog.includes('FULL BODY'), 'no full body in catalog')
assert(!catalog.includes('secret'), 'disable-model-invocation omitted from model catalog')
assert(catalog.includes('nouser'), 'user-invocable false still in model catalog')

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

// ── 从磁盘加载 frontmatter 别名 ──
const tmpUser = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-skill-fm-'))
const aliasDir = path.join(tmpUser, 'skills', 'alias-skill')
await fs.mkdir(aliasDir, { recursive: true })
await fs.writeFile(
  path.join(aliasDir, 'SKILL.md'),
  `---
name: Alias Skill
description: from disk
whenToUse: camel from file
disableModelInvocation: false
userInvocable: true
---
DISK BODY
`,
  'utf8',
)
const fromDisk = await discoverSkills({
  cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-skill-empty-')),
  userBoloDir: tmpUser,
  bundledSkillsDir: false,
})
const aliasLoaded = findSkillById(fromDisk, 'alias-skill')
assert(aliasLoaded, 'alias skill discovered')
assert(aliasLoaded!.meta.whenToUse === 'camel from file', 'disk whenToUse')
assert(aliasLoaded!.body.includes('DISK BODY'), 'disk body')

// 坏 SKILL（空目录名兜底）— 无效 yaml 行不炸
const badDir = path.join(tmpUser, 'skills', 'tolerates-junk')
await fs.mkdir(badDir, { recursive: true })
await fs.writeFile(
  path.join(badDir, 'SKILL.md'),
  `---
name: junk
this line is not a key value pair
description: still works
---
ok
`,
  'utf8',
)
const junk = await discoverSkills({
  cwd: path.join(os.tmpdir(), 'no-project'),
  userBoloDir: tmpUser,
  bundledSkillsDir: false,
})
assert(findSkillById(junk, 'tolerates-junk'), 'junk frontmatter still loads')

// ── bundled creators ──
const bundledDir = getBundledSkillsDir()
const discovered = await discoverSkills({
  cwd: process.cwd(),
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

// catalog 预算省略
const many: LoadedSkill[] = Array.from({ length: 20 }, (_, i) => ({
  meta: {
    id: `s${i}`,
    name: `S${i}`,
    description: 'x'.repeat(80),
    path: `/tmp/s${i}/SKILL.md`,
  },
  source: 'user' as const,
  body: 'b',
  frontmatter: {},
}))
const tight = formatSkillCatalog(many, { maxChars: 400 })
assert(tight.includes('omitted'), 'budget omits with message')

const st = await fs.stat(bundledDir)
assert(st.isDirectory(), 'bundled-skills dir exists')

console.log('SKILL CATALOG TESTS PASS')