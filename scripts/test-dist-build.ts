/**
 * AR5C-early：CLI 发布产物契约
 *
 * 断言的是「陌生人装上能跑」的必要条件，不是「代码好看」：
 * - 产物是单文件，且不依赖 tsx / node_modules
 * - package.json 的发布元数据允许真的 publish
 * - `dependencies` 仍为空（零运行时依赖红线）
 * - bundled-skills 资产随包发布
 *
 * 运行：npx tsx scripts/test-dist-build.ts
 */
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..')

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  const pkg = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as Record<string, unknown>

  // ── 1) 发布元数据：没有这些就根本 publish 不了 ──
  assert(pkg.private !== true, 'package.json must not be private to publish')
  assert(
    typeof pkg.name === 'string' && (pkg.name as string).length > 0,
    'package name set',
  )
  assert(typeof pkg.version === 'string', 'version set')
  assert(Array.isArray(pkg.files), 'files allowlist set (do not ship the repo)')

  const files = pkg.files as string[]
  assert(
    files.some((f) => f.startsWith('dist')),
    'files ships dist',
  )
  assert(
    !files.some(
      (f) =>
        f.includes('.bolo-tmp') ||
        f.includes('.planning') ||
        f.includes('.bolo/') ||
        f === '.',
    ),
    'files never ships scratch dirs or the whole repo',
  )
  assert(
    typeof (pkg.scripts as Record<string, string>).prepack === 'string',
    'prepack rebuilds so a tarball can never carry a stale artifact',
  )

  // ── 2) 仓库工具链与默认门禁不能靠文档约定 ──
  assert(
    pkg.packageManager === 'npm@11.17.0',
    `packageManager must match package-lock.json and the supported npm toolchain, got ${String(pkg.packageManager)}`,
  )
  assert(
    await exists(path.join(repoRoot, 'package-lock.json')),
    'npm packageManager has a package-lock.json',
  )
  assert(
    !(await exists(path.join(repoRoot, 'pnpm-lock.yaml'))),
    'the npm workspace must not carry a competing pnpm lockfile',
  )

  const scripts = (pkg.scripts ?? {}) as Record<string, string>
  const defaultGate = scripts.test ?? ''
  for (const required of [
    'scripts/test-ptl-retry.ts',
    'scripts/test-cli-tui-view-state.ts',
    'scripts/test-cli-tui-retained.ts',
    'scripts/test-cli-tui-vt-legacy.ts',
    'scripts/test-desktop-launch.ts',
    'scripts/test-runtime-core-transport.ts',
    'scripts/test-session-model-effort-settings.ts',
    'scripts/test-desktop-model-effort-settings.ts',
  ]) {
    assert(
      defaultGate.includes(required),
      `${required} stays in the default npm test gate`,
    )
  }

  // 发布资产复制失败必须让 prepack 失败，不能靠事后的测试碰运气。
  const buildSource = await fs.readFile(
    path.join(repoRoot, 'scripts', 'build-dist.ts'),
    'utf8',
  )
  const copyStart = buildSource.indexOf('await fs.cp(')
  const chmodStart = buildSource.indexOf('await fs.chmod(', copyStart)
  assert(copyStart >= 0 && chmodStart > copyStart, 'build copies bundled skills before chmod')
  assert(
    !buildSource.slice(copyStart, chmodStart).includes('.catch('),
    'bundled-skills copy errors must propagate out of the build',
  )

  // ── 3) 零运行时依赖红线 ──
  const deps = (pkg.dependencies ?? {}) as Record<string, string>
  assert(
    Object.keys(deps).length === 0,
    `dependencies must stay empty, found: ${Object.keys(deps).join(', ')}`,
  )
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>
  const engines = (pkg.engines ?? {}) as Record<string, string>
  assert('esbuild' in devDeps, 'esbuild is a devDependency')
  assert(
    engines.node === '>=22.19.0',
    `Node support must match the retained renderer baseline, got ${String(engines.node)}`,
  )
  assert(
    devDeps['@xterm/headless'] === '5.5.0',
    '@xterm/headless stays an exact test-only devDependency',
  )
  assert(
    devDeps['@earendil-works/pi-tui'] === '0.82.1',
    '@earendil-works/pi-tui stays an exact build-time dependency',
  )

  // ── 4) bin 指向产物，不再 spawn tsx ──
  const bin = pkg.bin as Record<string, string> | string
  const binPath = typeof bin === 'string' ? bin : Object.values(bin)[0]!
  assert(
    binPath.includes('dist'),
    `bin must point at the built artifact, got ${binPath}`,
  )

  // ── 5) 构建 ──
  await execFileAsync(
    process.execPath,
    [path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(repoRoot, 'scripts', 'build-dist.ts')],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  ).catch(async () => {
    // tsx 布局可能不同；退回 npm script
    await execFileAsync('npm', ['run', 'build'], {
      cwd: repoRoot,
      shell: true,
      maxBuffer: 16 * 1024 * 1024,
    })
  })

  const distEntry = path.join(repoRoot, 'dist', 'bolo.mjs')
  assert(await exists(distEntry), 'dist/bolo.mjs produced')

  const bundle = await fs.readFile(distEntry, 'utf8')
  assert(bundle.length > 50_000, `bundle looks too small (${bundle.length} bytes)`)

  // ── 6) 产物不得再依赖 tsx / TypeScript 源 ──
  assert(
    !/require\(["']tsx|from ["']tsx["']|tsx\/cli/.test(bundle),
    'bundle must not reference tsx at runtime',
  )
  assert(
    !/from ["'][^"']*\.ts["']/.test(bundle),
    'bundle must not import .ts sources at runtime',
  )
  assert(
    bundle.includes('──◆──') && !bundle.includes('context puffer'),
    'single-file bundle embeds the Bolo crystal identity without the legacy mascot',
  )
  assert(
    bundle.includes('@earendil-works/pi-tui/dist/tui.js'),
    'single-file bundle embeds the retained renderer',
  )
  for (const forbidden of [
    '@earendil-works/pi-tui/dist/components/editor.js',
    '@earendil-works/pi-tui/dist/components/markdown.js',
    '@earendil-works/pi-tui/dist/native-modifiers.js',
    '@earendil-works/pi-tui/dist/terminal.js',
  ]) {
    assert(
      !bundle.includes(forbidden),
      `retained base must not bundle unused Pi module: ${forbidden}`,
    )
  }

  // ── 7) 产物可执行 ──
  const { stdout } = await execFileAsync(process.execPath, [distEntry, '--help'], {
    cwd: repoRoot,
    maxBuffer: 8 * 1024 * 1024,
  })
  assert(/bolo/i.test(stdout), 'built CLI prints help')
  assert(/--resume/.test(stdout), 'help lists real commands')

  // ── 8) bin 就是产物本身：没有 wrapper，也就没有 wrapper 会走偏 ──
  const binAbs = path.join(repoRoot, binPath.replace(/^\.\//, ''))
  assert(await exists(binAbs), `bin file exists at ${binPath}`)
  assert(
    path.resolve(binAbs) === path.resolve(distEntry),
    'bin points at the built bundle itself',
  )
  assert(bundle.startsWith('#!'), 'bundle carries a shebang so it is directly executable')

  // ── 9) bundled-skills 资产随产物一起发（skills 双布局探测依赖它在 dist 下） ──
  const packagedSkill = path.join(
    repoRoot,
    'dist',
    'bundled-skills',
    'skill-creator',
    'SKILL.md',
  )
  assert(
    await exists(packagedSkill),
    'bundled-skills assets copied next to the bundle',
  )

  console.log('PASS: dist build contract')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
