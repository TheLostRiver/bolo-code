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
  mergeSkillsByPrecedence,
  resolveExtraSkillRoots,
  isSkillModelInvocable,
  isSkillUserInvocable,
  skillModelInvokeBlockReason,
  skillUserInvokeBlockReason,
  SKILL_SOURCE_PRECEDENCE,
  SKILL_FRONTMATTER_ALIASES,
  type LoadedSkill,
} from '../packages/skills/src/index.ts'
import { executeTool } from '../packages/tools/src/index.ts'
import { invokeSkillBySlash } from '../packages/core/src/slash.ts'

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

// ── S-PORT-3 覆盖序 ──
assert(
  SKILL_SOURCE_PRECEDENCE.join(',') === 'bundled,extra,user,project,plugin',
  'precedence list',
)
const layerLow: LoadedSkill = {
  meta: {
    id: 'shared',
    name: 'Low',
    description: 'from user',
    path: '/u/shared/SKILL.md',
  },
  source: 'user',
  body: 'USER BODY',
  frontmatter: {},
}
const layerHigh: LoadedSkill = {
  meta: {
    id: 'shared',
    name: 'High',
    description: 'from plugin',
    path: '/p/shared/SKILL.md',
  },
  source: 'plugin',
  body: 'PLUGIN BODY',
  frontmatter: {},
}
const onlyOther: LoadedSkill = {
  meta: { id: 'other', name: 'O', path: '/o/SKILL.md' },
  source: 'bundled',
  body: 'o',
  frontmatter: {},
}
const mergedPrec = mergeSkillsByPrecedence(
  [onlyOther, layerLow],
  [layerHigh],
)
assert(mergedPrec.length === 2, 'merge keeps distinct ids')
const shared = findSkillById(mergedPrec, 'shared')
assert(shared?.source === 'plugin', 'plugin wins over user')
assert(shared?.body.includes('PLUGIN'), 'plugin body wins')
assert(findSkillById(mergedPrec, 'other')?.source === 'bundled', 'other kept')

// 四层：bundled < user < project < plugin
const b: LoadedSkill = {
  meta: { id: 'x', name: 'b', path: '/b' },
  source: 'bundled',
  body: 'B',
  frontmatter: {},
}
const u: LoadedSkill = {
  meta: { id: 'x', name: 'u', path: '/u' },
  source: 'user',
  body: 'U',
  frontmatter: {},
}
const p: LoadedSkill = {
  meta: { id: 'x', name: 'p', path: '/p' },
  source: 'project',
  body: 'P',
  frontmatter: {},
}
const g: LoadedSkill = {
  meta: { id: 'x', name: 'g', path: '/g' },
  source: 'plugin',
  body: 'G',
  frontmatter: {},
}
assert(
  mergeSkillsByPrecedence([b], [u], [p], [g])[0]!.source === 'plugin',
  'full stack plugin wins',
)
assert(
  mergeSkillsByPrecedence([b], [u], [p])[0]!.source === 'project',
  'project wins without plugin',
)
assert(
  mergeSkillsByPrecedence([b], [u])[0]!.source === 'user',
  'user wins over bundled',
)

// ── S-PORT-4 调用矩阵 ──
const bothOk: LoadedSkill = {
  meta: {
    id: 'ok',
    name: 'ok',
    path: '/ok',
    disableModelInvocation: false,
    userInvocable: true,
  },
  source: 'user',
  body: 'ok body',
  frontmatter: {},
}
const modelOnly: LoadedSkill = {
  meta: {
    id: 'model-only',
    name: 'mo',
    path: '/mo',
    userInvocable: false,
  },
  source: 'user',
  body: 'model only body',
  frontmatter: {},
}
const userOnly: LoadedSkill = {
  meta: {
    id: 'user-only',
    name: 'uo',
    path: '/uo',
    disableModelInvocation: true,
    userInvocable: true,
  },
  source: 'user',
  body: 'user only body',
  frontmatter: {},
}
const neither: LoadedSkill = {
  meta: {
    id: 'neither',
    name: 'n',
    path: '/n',
    disableModelInvocation: true,
    userInvocable: false,
  },
  source: 'user',
  body: 'locked',
  frontmatter: {},
}

assert(isSkillModelInvocable(bothOk) && isSkillUserInvocable(bothOk), 'both ok')
assert(
  isSkillModelInvocable(modelOnly) && !isSkillUserInvocable(modelOnly),
  'model only flags',
)
assert(
  !isSkillModelInvocable(userOnly) && isSkillUserInvocable(userOnly),
  'user only flags',
)
assert(
  !isSkillModelInvocable(neither) && !isSkillUserInvocable(neither),
  'neither flags',
)
assert(skillModelInvokeBlockReason(userOnly), 'model block reason')
assert(skillUserInvokeBlockReason(modelOnly), 'user block reason')
assert(skillModelInvokeBlockReason(bothOk) === null, 'no model block')
assert(skillUserInvokeBlockReason(bothOk) === null, 'no user block')

const matrix = [bothOk, modelOnly, userOnly, neither]
const catMatrix = formatSkillCatalog(matrix)
assert(catMatrix.includes('ok'), 'catalog has model-ok')
assert(catMatrix.includes('model-only'), 'catalog has model-only')
assert(!catMatrix.includes('user-only'), 'catalog hides disable-model')
assert(!catMatrix.includes('neither'), 'catalog hides neither')

const toolMo = await executeTool(
  'Skill',
  { skill: 'model-only' },
  { cwd: process.cwd(), skills: matrix },
)
assert(toolMo.ok && toolMo.output.includes('model only'), 'model-only tool ok')

const toolUo = await executeTool(
  'Skill',
  { skill: 'user-only' },
  { cwd: process.cwd(), skills: matrix },
)
assert(!toolUo.ok, 'user-only tool blocked')

const toolN = await executeTool(
  'Skill',
  { skill: 'neither' },
  { cwd: process.cwd(), skills: matrix },
)
assert(!toolN.ok, 'neither tool blocked')

// slash：user-only 可装；model-only / neither 拒
const fakeSession = {
  messages: [] as { role: string; content: string }[],
  skills: matrix,
}
const slashUo = invokeSkillBySlash(fakeSession as never, 'user-only')
assert(slashUo.ok, 'slash user-only ok')
assert(
  fakeSession.messages.some((m) => m.content.includes('user only body')),
  'slash injects body',
)

const slashMo = invokeSkillBySlash(
  { messages: [], skills: matrix } as never,
  'model-only',
)
assert(!slashMo.ok, 'slash model-only blocked')
assert(
  String(slashMo.message).includes('user-invocable'),
  'slash model-only reason',
)

const slashN = invokeSkillBySlash(
  { messages: [], skills: matrix } as never,
  'neither',
)
assert(!slashN.ok, 'slash neither blocked')

// ── S-PORT-2 旁路 extra 根（默认 off）──
const resolvedEmpty = resolveExtraSkillRoots(undefined)
assert(resolvedEmpty.length === 0, 'no roots default empty')
assert(resolveExtraSkillRoots([]).length === 0, 'empty list')
const homeish = resolveExtraSkillRoots(['~/skills-x', '~/skills-x'], {
  homeDir: path.join(os.tmpdir(), 'fake-home'),
  cwd: os.tmpdir(),
})
assert(homeish.length === 1, 'dedupe ~ roots')
assert(homeish[0]!.includes('fake-home'), 'expand tilde')

const rel = resolveExtraSkillRoots(['./rel-skills'], {
  cwd: path.join(os.tmpdir(), 'proj-root'),
})
assert(rel[0]!.includes('proj-root'), 'relative to cwd')
assert(path.isAbsolute(rel[0]!), 'abs path')

// 默认 discover 不扫额外根
const emptyCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-no-extra-'))
const noExtra = await discoverSkills({
  cwd: emptyCwd,
  userBoloDir: path.join(os.tmpdir(), `bolo-empty-user-${Date.now()}`),
  bundledSkillsDir: false,
})
assert(
  !noExtra.some((s) => s.source === 'extra'),
  'default discover has no extra source',
)

// 显式 extra 根
const extraRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-extra-skills-'))
const extraSkillDir = path.join(extraRoot, 'from-extra')
await fs.mkdir(extraSkillDir, { recursive: true })
await fs.writeFile(
  path.join(extraSkillDir, 'SKILL.md'),
  `---
name: from-extra
description: bypass root
---
EXTRA BODY
`,
  'utf8',
)
const withExtra = await discoverSkills({
  cwd: emptyCwd,
  userBoloDir: path.join(os.tmpdir(), `bolo-empty-user2-${Date.now()}`),
  bundledSkillsDir: false,
  extraSkillRoots: [extraRoot],
})
const ex = findSkillById(withExtra, 'from-extra')
assert(ex, 'extra skill found')
assert(ex!.source === 'extra', 'source=extra')
assert(ex!.body.includes('EXTRA BODY'), 'extra body')

// user 盖过 extra（同 id）
const userRoot2 = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-user-over-'))
const userSkill = path.join(userRoot2, 'skills', 'from-extra')
await fs.mkdir(userSkill, { recursive: true })
await fs.writeFile(
  path.join(userSkill, 'SKILL.md'),
  `---
name: from-extra
description: user wins
---
USER WINS
`,
  'utf8',
)
const userOverExtra = await discoverSkills({
  cwd: emptyCwd,
  userBoloDir: userRoot2,
  bundledSkillsDir: false,
  extraSkillRoots: [extraRoot],
})
const won = findSkillById(userOverExtra, 'from-extra')
assert(won?.source === 'user', 'user overrides extra')
assert(won?.body.includes('USER WINS'), 'user body')

// extra 盖过 bundled
const bundledTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-bund-'))
const bSkill = path.join(bundledTmp, 'shared-id')
await fs.mkdir(bSkill, { recursive: true })
await fs.writeFile(
  path.join(bSkill, 'SKILL.md'),
  `---
name: shared-id
---
BUNDLED
`,
  'utf8',
)
const eRoot2 = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-ex2-'))
const eSkill2 = path.join(eRoot2, 'shared-id')
await fs.mkdir(eSkill2, { recursive: true })
await fs.writeFile(
  path.join(eSkill2, 'SKILL.md'),
  `---
name: shared-id
---
EXTRA WINS BUNDLED
`,
  'utf8',
)
const extraOverBundled = await discoverSkills({
  cwd: emptyCwd,
  userBoloDir: path.join(os.tmpdir(), `bolo-eu-${Date.now()}`),
  bundledSkillsDir: bundledTmp,
  extraSkillRoots: [eRoot2],
})
assert(
  findSkillById(extraOverBundled, 'shared-id')?.body.includes('EXTRA WINS'),
  'extra overrides bundled',
)

console.log('SKILL CATALOG TESTS PASS')