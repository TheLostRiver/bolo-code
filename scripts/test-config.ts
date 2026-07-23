/**
 * 配置目录单测 — 使用临时 BOLO_CONFIG_DIR，不污染真实 ~/.bolo
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ensureAllLayouts,
  getBoloHomeDir,
  getProjectBoloDir,
  loadWorkspace,
  mergeConfigs,
  writeJsonFile,
  type BoloConfigJson,
} from '../packages/config/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-config-'))
  const userRoot = path.join(tmp, 'user-bolo')
  const projectCwd = path.join(tmp, 'proj')
  await fs.mkdir(projectCwd, { recursive: true })

  process.env.BOLO_CONFIG_DIR = userRoot
  // 清掉可能影响 provider 的 key
  delete process.env.BOLO_API_KEY
  delete process.env.OPENAI_API_KEY
  process.env.BOLO_PROVIDER = 'mock'

  assert(getBoloHomeDir() === path.normalize(userRoot), 'home from env')

  const ensured = await ensureAllLayouts(projectCwd, { writeDefaults: true })
  assert(ensured.user.created.length >= 1, 'user defaults created')
  assert(ensured.project.created.length >= 1, 'project defaults created')

  // 用户 config 写 model
  const userConfig: BoloConfigJson = {
    version: 1,
    provider: { kind: 'openai-compatible', model: 'user-model', baseUrl: 'https://user.example/v1' },
    permissionMode: 'acceptEdits',
  }
  await writeJsonFile(path.join(userRoot, 'config.json'), userConfig)

  // 项目覆盖 model
  const projConfig: BoloConfigJson = {
    provider: { model: 'project-model' },
    permissionMode: 'plan',
  }
  await writeJsonFile(
    path.join(getProjectBoloDir(projectCwd), 'config.json'),
    projConfig,
  )

  // 用户 mcp
  await writeJsonFile(path.join(userRoot, 'mcp.json'), {
    mcpServers: {
      u: { command: 'echo', args: ['u'], tools: [{ name: 't1' }] },
    },
  })
  await writeJsonFile(path.join(getProjectBoloDir(projectCwd), 'mcp.json'), {
    mcpServers: {
      u: { command: 'echo', args: ['project-wins'], tools: [{ name: 't2' }] },
      p: { command: 'true', tools: [{ name: 'tp' }] },
    },
  })

  // skill 目录
  const skillDir = path.join(userRoot, 'skills', 'demo')
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: Demo\ndescription: d\n---\nHello skill\n',
    'utf8',
  )

  // 项目 plugin：bolo.plugin.json + skills/ → 进 workspace catalog（PL1）
  const pluginRoot = path.join(
    getProjectBoloDir(projectCwd),
    'plugins',
    'tmp-plugin',
  )
  await fs.mkdir(path.join(pluginRoot, 'skills', 'from-plugin'), {
    recursive: true,
  })
  await writeJsonFile(path.join(pluginRoot, 'bolo.plugin.json'), {
    id: 'tmp-plugin',
    name: 'Tmp Plugin',
    version: '0.0.1',
    contributes: { skills: ['skills'] },
  })
  await fs.writeFile(
    path.join(pluginRoot, 'skills', 'from-plugin', 'SKILL.md'),
    '---\nname: From Plugin\ndescription: plugin skill for catalog\n---\nPlugin body\n',
    'utf8',
  )

  const ws = await loadWorkspace({ cwd: projectCwd })
  assert(ws.config.provider?.model === 'project-model', 'project model wins')
  assert(ws.config.provider?.baseUrl === 'https://user.example/v1', 'user base kept')
  assert(ws.permissionMode === 'plan', 'project permissionMode')
  assert(ws.mcpServers.find((s) => s.name === 'u')?.args?.[0] === 'project-wins', 'mcp project wins')
  assert(ws.mcpServers.some((s) => s.name === 'p'), 'project mcp present')
  assert(ws.skills.some((s) => s.meta.id === 'demo'), 'user skill found')
  assert(
    ws.plugins.some((p) => p.manifest.id === 'tmp-plugin'),
    'project plugin discovered',
  )
  assert(
    ws.skills.some((s) => s.meta.id === 'from-plugin' && s.source === 'plugin'),
    'plugin skill merged into catalog',
  )
  assert(ws.providerKind === 'mock', 'no key → mock')

  const merged = mergeConfigs(
    { provider: { model: 'a' } },
    { provider: { model: 'b', baseUrl: 'x' } },
  )
  assert(merged.provider?.model === 'b', 'merge model')
  assert(merged.provider?.baseUrl === 'x', 'merge base')

  console.log('CONFIG TESTS PASS')
  console.log('  home', getBoloHomeDir())
  console.log('  project', getProjectBoloDir(projectCwd))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})