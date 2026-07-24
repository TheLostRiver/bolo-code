/**
 * PL2：插件 commands 贡献 + 会话热加载（/plugins reload）
 * 使用临时 BOLO_CONFIG_DIR，不污染真实 ~/.bolo；无 MCP 子进程。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  discoverPlugins,
  mergePluginContributions,
  findPluginCommand,
  type PluginManifest,
} from '../packages/plugins/src/index.ts'
import {
  createSessionFromWorkspace,
  reloadSessionPlugins,
  dispatchSlashCommand,
  replaceSkillCatalogSection,
} from '../packages/core/src/index.ts'
import { writeJsonFile, getProjectBoloDir } from '../packages/config/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

async function writePlugin(
  root: string,
  manifest: PluginManifest,
  files: Record<string, string>,
) {
  await fs.mkdir(root, { recursive: true })
  await writeJsonFile(path.join(root, 'bolo.plugin.json'), manifest)
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, body, 'utf8')
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-pl2-'))
  const userRoot = path.join(tmp, 'user-bolo')
  const projectCwd = path.join(tmp, 'proj')
  await fs.mkdir(projectCwd, { recursive: true })

  process.env.BOLO_CONFIG_DIR = userRoot
  delete process.env.BOLO_API_KEY
  delete process.env.OPENAI_API_KEY
  process.env.BOLO_PROVIDER = 'mock'

  // ── unit: merge commands ──
  const unitPlugin = path.join(tmp, 'unit-plugin')
  await writePlugin(
    unitPlugin,
    {
      id: 'unit-plug',
      name: 'Unit',
      version: '0.1.0',
      contributes: { skills: ['skills'], commands: ['commands'] },
    },
    {
      'skills/unit-skill/SKILL.md':
        '---\nname: Unit Skill\nid: unit-skill\ndescription: from unit plugin\n---\nUnit skill body\n',
      'commands/hello.md':
        '---\nname: hello\ndescription: say hello\n---\nHello from plugin command.\n',
      'commands/note.md':
        '---\nid: note\ndescription: a note\n---\nNote body line.\n',
    },
  )
  const found = await discoverPlugins([
    { dir: path.dirname(unitPlugin), scope: 'project' },
  ])
  // discoverPlugins 扫 dir 的子目录；unit-plugin 的 parent 是 tmp，子项含 unit-plugin
  const plugins = found.filter((p) => p.manifest.id === 'unit-plug')
  assert(plugins.length === 1, 'discover unit plugin')
  const merge = await mergePluginContributions(plugins)
  assert(merge.skills.some((s) => s.meta.id === 'unit-skill'), 'skill merged')
  assert(merge.commands.length >= 2, 'commands discovered')
  const hello = findPluginCommand(merge.commands, 'unit-plug:hello')
  assert(hello?.body.includes('Hello from plugin'), 'hello body')
  assert(
    findPluginCommand(merge.commands, 'hello')?.name === 'unit-plug:hello',
    'find by short id',
  )

  // ── session: create empty → add plugin → reload ──
  const { session } = await createSessionFromWorkspace({
    cwd: projectCwd,
    connectMcp: false,
    ensureDefaults: true,
  })
  assert((session.plugins?.length ?? 0) === 0, 'start with no plugins')
  assert((session.pluginCommands?.length ?? 0) === 0, 'no plugin commands yet')

  const pluginRoot = path.join(
    getProjectBoloDir(projectCwd),
    'plugins',
    'demo-pl',
  )
  await writePlugin(
    pluginRoot,
    {
      id: 'demo-pl',
      name: 'Demo PL',
      version: '1.0.0',
      contributes: {
        skills: ['skills'],
        commands: ['commands'],
        hooks: 'hooks.json',
      },
    },
    {
      'skills/pl2-skill/SKILL.md':
        '---\nname: PL2 Skill\nid: pl2-skill\ndescription: hot skill\nuser-invocable: true\n---\nHot skill body\n',
      'commands/greet.md':
        '---\nname: greet\ndescription: greet user\n---\nGreetings from demo-pl.\n',
      'hooks.json': JSON.stringify({
        SessionStart: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo pl2-hook' }],
          },
        ],
      }),
    },
  )

  const r = await reloadSessionPlugins(session, { reconnectMcp: false })
  assert(r.pluginCount === 1, 'reload plugin count')
  assert(r.skillCount >= 1, 'reload skills')
  assert(r.commandCount >= 1, 'reload commands')
  assert(
    session.plugins?.some((p) => p.manifest.id === 'demo-pl'),
    'session.plugins updated',
  )
  assert(
    session.skills.some((s) => s.meta.id === 'pl2-skill'),
    'session.skills has pl2-skill',
  )
  assert(
    session.pluginCommands?.some((c) => c.name === 'demo-pl:greet'),
    'pluginCommands has greet',
  )
  assert(
    session.systemPromptSections.some((s) => s.includes('pl2-skill')),
    'skill catalog section refreshed',
  )
  assert(
    session.hooks?.SessionStart?.length,
    'hooks from plugin merged into session',
  )

  // slash: list / commands / invoke
  const list = await dispatchSlashCommand(session, 'plugins', '')
  assert(list.ok && list.message.includes('demo-pl'), '/plugins lists demo-pl')

  const cmds = await dispatchSlashCommand(session, 'plugins', 'commands')
  assert(cmds.ok && cmds.message.includes('demo-pl:greet'), '/plugins commands')

  const before = session.messages.length
  const inv = await dispatchSlashCommand(session, 'demo-pl:greet', '')
  assert(inv.ok, 'invoke plugin command ok')
  assert(session.messages.length === before + 1, 'user message injected')
  assert(
    session.messages[session.messages.length - 1]?.content.includes(
      'Greetings from demo-pl',
    ),
    'injected body',
  )

  const reloadSlash = await dispatchSlashCommand(session, 'plugins', 'reload')
  assert(reloadSlash.ok && reloadSlash.message.includes('Reloaded'), '/plugins reload')

  const alias = await dispatchSlashCommand(session, 'reload-plugins', '')
  assert(alias.ok && alias.message.includes('Reloaded'), '/reload-plugins alias')

  // replaceSkillCatalogSection unit
  const secs = replaceSkillCatalogSection(
    ['# Identity\nme', '# Environment\nhere'],
    '## Available Skills (catalog only — invoke via Skill tool to load full instructions)\n- a',
  )
  assert(secs.length === 3, 'catalog inserted')
  assert(secs.some((s) => s.includes('Available Skills')), 'catalog present')
  const cleared = replaceSkillCatalogSection(secs, '')
  assert(!cleared.some((s) => s.includes('Available Skills')), 'catalog removed')

  console.log('PL2 PLUGIN TESTS PASS')
  console.log('  plugins', r.pluginCount, 'commands', r.commandCount, 'skills', r.skillCount)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})