/**
 * Skill 目录索引 + 按需加载 — 对照 HC skill_listing / SkillTool
 */
import {
  formatSkillCatalog,
  findSkillById,
  formatSkillBodyForInjection,
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

console.log('SKILL CATALOG TESTS PASS')