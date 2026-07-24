/**
 * IMPORT-S1 / IMPORT-P1 / IMPORT-X
 * 运行：node --import tsx/esm scripts/test-import-compat.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverSkills, resolveExtraSkillRoots } from '../packages/skills/src/index.ts'
import {
  detectForeignPluginDir,
  importForeignPluginSkills,
} from '../packages/plugins/src/importCompat.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-imp-'))

// IMPORT-S1：extraSkillRoots 旁路
const extraRoot = path.join(tmp, 'extra-skills')
const skillA = path.join(extraRoot, 'from-extra')
await fs.mkdir(skillA, { recursive: true })
await fs.writeFile(
  path.join(skillA, 'SKILL.md'),
  '---\nname: from-extra\ndescription: via extraSkillRoots\n---\n\n# Extra\n',
  'utf8',
)
const resolved = resolveExtraSkillRoots(['extra-skills'], { cwd: tmp })
assert(resolved.length === 1 && resolved[0].includes('extra-skills'), 'resolve extra')
const discovered = await discoverSkills({
  cwd: tmp,
  userBoloDir: path.join(tmp, 'empty-user'),
  bundledSkillsDir: false,
  extraSkillRoots: ['extra-skills'],
})
assert(
  discovered.some((s) => s.meta.id === 'from-extra'),
  'discover extra skill',
)

// IMPORT-P1：claude-like plugin
const claudeRoot = path.join(tmp, 'claude-plug')
await fs.mkdir(path.join(claudeRoot, '.claude-plugin'), { recursive: true })
await fs.mkdir(path.join(claudeRoot, 'skills', 'hello-skill'), {
  recursive: true,
})
await fs.writeFile(
  path.join(claudeRoot, '.claude-plugin', 'plugin.json'),
  JSON.stringify({
    name: 'demo',
    contributes: {
      skills: ['skills'],
      hooks: { Stop: [] },
      weirdFeature: true,
    },
  }),
  'utf8',
)
await fs.writeFile(
  path.join(claudeRoot, 'skills', 'hello-skill', 'SKILL.md'),
  '---\nname: hello-skill\ndescription: from foreign\n---\n\n# Hi\n',
  'utf8',
)

const det = await detectForeignPluginDir(claudeRoot)
assert(det.kind === 'claude', 'detect claude')
const imp = await importForeignPluginSkills(claudeRoot)
assert(imp.skills.some((s) => s.meta.id === 'hello-skill'), 'import skill')
assert(imp.unsupported.includes('hooks'), 'hooks unsupported')
assert(
  imp.unsupported.some((u) => u.includes('weirdFeature')),
  'unknown contribute warn',
)
assert(imp.warnings.some((w) => /hooks/i.test(w)), 'hooks warning text')

// codex-like
const codexRoot = path.join(tmp, 'codex-plug')
await fs.mkdir(path.join(codexRoot, '.codex-plugin'), { recursive: true })
await fs.mkdir(path.join(codexRoot, 'skills', 'cx'), { recursive: true })
await fs.writeFile(
  path.join(codexRoot, '.codex-plugin', 'plugin.json'),
  JSON.stringify({ skills: ['skills'] }),
  'utf8',
)
await fs.writeFile(
  path.join(codexRoot, 'skills', 'cx', 'SKILL.md'),
  '---\nname: cx\ndescription: codex skill\n---\n\n# Cx\n',
  'utf8',
)
const detCx = await detectForeignPluginDir(codexRoot)
assert(detCx.kind === 'codex', 'detect codex')
const impCx = await importForeignPluginSkills(codexRoot)
assert(impCx.skills.some((s) => s.meta.id === 'cx'), 'import codex skill')

// bolo 提示
const boloRoot = path.join(tmp, 'bolo-plug')
await fs.mkdir(boloRoot, { recursive: true })
await fs.writeFile(
  path.join(boloRoot, 'bolo.plugin.json'),
  JSON.stringify({ id: 'my-plug', name: 'My', version: '1.0.0' }),
  'utf8',
)
const detB = await detectForeignPluginDir(boloRoot)
assert(detB.kind === 'bolo', 'detect bolo')
const impB = await importForeignPluginSkills(boloRoot)
assert(impB.warnings.some((w) => /prefer Bolo discoverPlugins/i.test(w)), 'bolo warn')

console.log('IMPORT COMPAT TESTS PASS')