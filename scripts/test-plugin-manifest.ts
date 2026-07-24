/**
 * PL-SPEC-1/2：bolo.plugin.json 校验 + 坏插件隔离
 * 运行：node --import tsx/esm scripts/test-plugin-manifest.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parsePluginManifest,
  isValidPluginId,
  discoverPluginsDetailed,
  loadPluginFromDir,
  mergePluginContributions,
  BOLO_PLUGIN_MANIFEST_FILE,
} from '../packages/plugins/src/index.ts'
import { writeJsonFile } from '../packages/config/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

// id validation
assert(isValidPluginId('my-plugin'), 'kebab ok')
assert(isValidPluginId('a'), 'single segment')
assert(!isValidPluginId('MyPlugin'), 'reject Pascal')
assert(!isValidPluginId('-bad'), 'reject leading dash')

// parse ok
const ok = parsePluginManifest({
  id: 'demo-plug',
  name: 'Demo',
  version: '1.0.0',
  contributes: {
    skills: ['skills'],
    commands: ['commands'],
    hooks: 'hooks.json',
    mcpServers: 'mcp.json',
  },
})
assert(ok.ok, 'parse ok')
if (ok.ok) {
  assert(ok.manifest.id === 'demo-plug', 'id')
  assert(ok.manifest.contributes?.skills?.[0] === 'skills', 'skills')
}

// missing id
const noId = parsePluginManifest({ name: 'x' })
assert(!noId.ok, 'no id fails')

// bad contributes type
const badC = parsePluginManifest({
  id: 'x',
  contributes: 'nope',
})
assert(!badC.ok, 'contributes must be object')

// skills must be array
const badSkills = parsePluginManifest({
  id: 'x',
  contributes: { skills: 'skills' },
})
assert(!badSkills.ok, 'skills type')

// unknown contributes key → warning but ok
const unk = parsePluginManifest({
  id: 'ok-plug',
  contributes: { skills: [], futureThing: true },
})
assert(unk.ok, 'unknown key still ok')
if (unk.ok) {
  assert(
    unk.warnings.some((w) => w.path.includes('futureThing')),
    'unknown key warn',
  )
}

// non-kebab id → warning
const warnId = parsePluginManifest({ id: 'Not_Kebab', version: '1' })
assert(warnId.ok, 'loads with warn')
if (warnId.ok) {
  assert(warnId.warnings.some((w) => w.path === 'id'), 'id warn')
}

// discover skips bad plugin, loads good
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-plspec-'))
const pluginsRoot = path.join(tmp, 'plugins')
await fs.mkdir(pluginsRoot, { recursive: true })

const goodDir = path.join(pluginsRoot, 'good-plug')
await fs.mkdir(goodDir, { recursive: true })
await writeJsonFile(path.join(goodDir, BOLO_PLUGIN_MANIFEST_FILE), {
  id: 'good-plug',
  name: 'Good',
  version: '0.1.0',
  contributes: { skills: ['skills'], commands: ['commands'] },
})
await fs.mkdir(path.join(goodDir, 'skills', 'g'), { recursive: true })
await fs.writeFile(
  path.join(goodDir, 'skills', 'g', 'SKILL.md'),
  '---\nname: G\nid: g\ndescription: d\n---\nbody\n',
  'utf8',
)
await fs.mkdir(path.join(goodDir, 'commands'), { recursive: true })
await fs.writeFile(
  path.join(goodDir, 'commands', 'hi.md'),
  '---\nname: hi\n---\nHi\n',
  'utf8',
)

const badDir = path.join(pluginsRoot, 'broken')
await fs.mkdir(badDir, { recursive: true })
await fs.writeFile(
  path.join(badDir, BOLO_PLUGIN_MANIFEST_FILE),
  '{ not json',
  'utf8',
)

const noIdDir = path.join(pluginsRoot, 'noid')
await fs.mkdir(noIdDir, { recursive: true })
await writeJsonFile(path.join(noIdDir, BOLO_PLUGIN_MANIFEST_FILE), {
  name: 'no id',
})

const detailed = await discoverPluginsDetailed([
  { dir: pluginsRoot, scope: 'project' },
])
assert(
  detailed.plugins.some((p) => p.manifest.id === 'good-plug'),
  'good loaded',
)
assert(
  !detailed.plugins.some((p) => p.root.includes('broken')),
  'broken skipped',
)
assert(
  !detailed.plugins.some((p) => p.root.includes('noid')),
  'no-id skipped',
)
assert(detailed.errors.length >= 2, `errors recorded: ${detailed.errors.join('; ')}`)

const loaded = await loadPluginFromDir(goodDir, 'project')
assert(loaded.ok, 'loadPluginFromDir ok')

const merge = await mergePluginContributions(detailed.plugins)
assert(merge.skills.some((s) => s.meta.id === 'g'), 'skills default merge')
assert(merge.commands.some((c) => c.name.includes('hi')), 'commands merge')

// empty plugins root
const empty = await discoverPluginsDetailed([
  { dir: path.join(tmp, 'missing'), scope: 'user' },
])
assert(empty.plugins.length === 0 && empty.errors.length === 0, 'missing dir ok')

console.log('PLUGIN MANIFEST TESTS PASS')