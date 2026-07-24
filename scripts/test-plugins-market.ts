/**
 * PL-MKT 最小插件市场
 * 运行：node --import tsx/esm scripts/test-plugins-market.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  registerMarketplace,
  searchMarketplacePlugins,
  installPluginFromMarketplace,
  uninstallPlugin,
  listInstalledPlugins,
  listKnownMarketplaces,
  parseMarketplaceCatalog,
} from '../packages/plugins/src/marketplace.ts'
import { discoverPlugins } from '../packages/plugins/src/index.ts'
import { writeJsonFile } from '../packages/config/src/index.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-mkt-'))
  const userRoot = path.join(tmp, 'user-bolo')
  const marketRoot = path.join(tmp, 'my-market')
  const pluginSrc = path.join(marketRoot, 'plugins', 'demo-plug')

  await fs.mkdir(pluginSrc, { recursive: true })
  await writeJsonFile(path.join(pluginSrc, 'bolo.plugin.json'), {
    id: 'demo-plug',
    name: 'Demo Plugin',
    version: '1.0.0',
    contributes: { skills: [], commands: ['commands'] },
  })
  await fs.mkdir(path.join(pluginSrc, 'commands'), { recursive: true })
  await fs.writeFile(
    path.join(pluginSrc, 'commands', 'hi.md'),
    '---\nname: hi\ndescription: demo hi\n---\nHello market.\n',
    'utf8',
  )
  await writeJsonFile(path.join(marketRoot, 'bolo.marketplace.json'), {
    name: 'local-demo',
    description: 'test market',
    plugins: [
      {
        id: 'demo-plug',
        version: '1.0.0',
        description: 'demo from market',
        source: { type: 'path', path: 'plugins/demo-plug' },
      },
    ],
  })

  // parse
  const cat = parseMarketplaceCatalog({
    name: 'x',
    plugins: [{ id: 'a', source: './a' }],
  })
  assert(cat.plugins[0]!.source.type === 'path', 'path source normalize')

  const reg = await registerMarketplace({
    source: marketRoot,
    boloRoot: userRoot,
  })
  assert(reg.known.name === 'local-demo', 'registered name')
  assert(reg.catalog.plugins.length === 1, 'one plugin')

  const known = await listKnownMarketplaces(userRoot)
  assert(known.some((k) => k.name === 'local-demo'), 'list known')

  const hits = await searchMarketplacePlugins({
    query: 'demo',
    boloRoot: userRoot,
  })
  assert(hits.length === 1 && hits[0]!.entry.id === 'demo-plug', 'search')

  const rec = await installPluginFromMarketplace({
    pluginId: 'demo-plug',
    marketplace: 'local-demo',
    scope: 'user',
    boloRoot: userRoot,
  })
  assert(rec.id === 'demo-plug', 'install id')
  const st = await fs.stat(path.join(rec.installPath, 'bolo.plugin.json'))
  assert(st.isFile(), 'installed manifest')

  const installed = await listInstalledPlugins(userRoot)
  assert(installed.some((p) => p.id === 'demo-plug'), 'installed list')

  // discover from user plugins dir
  const found = await discoverPlugins([
    { dir: path.join(userRoot, 'plugins'), scope: 'user' },
  ])
  assert(
    found.some((p) => p.manifest.id === 'demo-plug'),
    'discover after install',
  )

  await uninstallPlugin({
    id: 'demo-plug',
    scope: 'user',
    boloRoot: userRoot,
  })
  let gone = false
  try {
    await fs.access(rec.installPath)
  } catch {
    gone = true
  }
  assert(gone, 'uninstalled')

  // P-PL-ZIP：本地 zip 安装
  const { installPluginFromZip, looksLikeZipPath } = await import(
    '../packages/plugins/src/marketplace.ts'
  )
  assert(looksLikeZipPath('x.ZIP'), 'looksLikeZipPath')
  const zipPath = path.join(tmp, 'demo-plug.zip')
  // 用 tar 打 zip（Windows/mac/linux 常见）
  const { spawnSync } = await import('node:child_process')
  const pack = spawnSync(
    'tar',
    ['-a', '-cf', zipPath, '-C', path.dirname(pluginSrc), path.basename(pluginSrc)],
    { encoding: 'utf8' },
  )
  if (pack.status !== 0) {
    // 回落：powershell Compress-Archive
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${pluginSrc.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
      ],
      { encoding: 'utf8' },
    )
    assert(ps.status === 0, `zip pack failed: ${ps.stderr || pack.stderr}`)
  }
  const zrec = await installPluginFromZip({
    zipPath,
    scope: 'user',
    boloRoot: userRoot,
  })
  assert(zrec.id === 'demo-plug', 'zip install id')
  assert(
    (await fs.stat(path.join(zrec.installPath, 'bolo.plugin.json'))).isFile(),
    'zip installed manifest',
  )

  // P-PL-URL-ZIP：mock fetch
  const { installPluginFromUrl } = await import(
    '../packages/plugins/src/marketplace.ts'
  )
  const zipBuf = await fs.readFile(zipPath)
  const urec = await installPluginFromUrl({
    url: 'https://example.test/plugins/demo-plug.zip',
    scope: 'user',
    boloRoot: userRoot,
    fetchImpl: async () =>
      new Response(zipBuf, {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      }),
  })
  assert(urec.id === 'demo-plug', 'url zip install')

  // 非 zip URL 应失败
  let urlFail = false
  try {
    await installPluginFromUrl({
      url: 'https://example.test/not-a-plugin',
      boloRoot: userRoot,
      fetchImpl: async () =>
        new Response('hello', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    })
  } catch {
    urlFail = true
  }
  assert(urlFail, 'non-zip url rejected')

  console.log('ok: test-plugins-market')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})