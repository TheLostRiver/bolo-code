/**
 * AR5C-early：真实 npm pack → 安装 → 运行
 *
 * 这是「陌生人能装上并跑起来」的最终证据。前面的 test-dist-build 只证明
 * 产物在**仓库里**能跑；这里证明它**离开仓库、不带 dev 依赖**也能跑。
 *
 * 覆盖三类会让发布当场翻车的问题：
 * - tarball 里混进临时目录 / 密钥 / 整个仓库
 * - 安装后缺 tsx / esbuild 之类构建期依赖就起不来
 * - bin 没被 npm 链接，或链接到不存在的路径
 *
 * 运行：npx tsx scripts/test-dist-install.ts
 */
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

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

/**
 * 跑 npm，并剥掉继承来的 npm 环境变量。
 *
 * 本脚本通常经 `npx tsx` 启动，而 npx 会把用户 npmrc 的每一条都注入成
 * `npm_config_*` 环境变量（本机实测 12 条，其中 `npm_config_allow_scripts`
 * 会让子 npm 的 project-scoped install 直接报 EALLOWSCRIPTS）。
 * 不剥的话，这个测试的成败取决于开发者个人的 npm 配置——正反两个方向都不该。
 *
 * staging 目录放仓库 .bolo-tmp/ 而非 os.tmpdir()：Windows 上后者位于
 * C:\Users\<user>\AppData\Local\Temp，是家目录子目录，npm 会把 ~/.npmrc
 * 当成 **project** 配置读进来。
 */
function cleanNpmEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^npm_(config|package|lifecycle)_/i.test(k)) continue
    env[k] = v
  }
  env.npm_config_audit = 'false'
  env.npm_config_fund = 'false'
  return env
}

async function npm(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('npm', args, {
    cwd,
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
    env: cleanNpmEnv(),
  })
  return stdout
}

async function main() {
  const pkg = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as { name: string; version: string }

  const stageRoot = path.join(repoRoot, '.bolo-tmp')
  await fs.mkdir(stageRoot, { recursive: true })
  const stage = await fs.mkdtemp(path.join(stageRoot, 'pack-'))

  // ── 1) npm pack（prepack 会先重建产物） ──
  const packOut = await npm(['pack', '--pack-destination', stage], repoRoot)
  const tarballName = packOut
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.tgz'))
    .pop()!
  const tarball = path.join(stage, tarballName)
  assert(await exists(tarball), `tarball produced: ${tarballName}`)

  // ── 2) tarball 内容清单：只该有产物与文档 ──
  // 生命周期脚本可能也往 stdout 写东西，从第一个 '[' 起截 JSON
  const listing = await npm(['pack', '--dry-run', '--json'], repoRoot)
  const jsonStart = listing.indexOf('[')
  assert(jsonStart >= 0, 'npm pack --json produced a JSON array')
  const meta = JSON.parse(listing.slice(jsonStart)) as Array<{
    files: Array<{ path: string }>
    entryCount: number
  }>
  const entries = meta[0]!.files.map((f) => f.path.replace(/\\/g, '/'))

  assert(
    entries.includes('dist/bolo.mjs'),
    'tarball contains the built CLI',
  )
  assert(
    entries.some((e) => e.startsWith('dist/bundled-skills/')),
    'tarball contains bundled-skills assets',
  )
  assert(entries.includes('package.json'), 'tarball contains package.json')

  const forbidden = entries.filter(
    (e) =>
      e.startsWith('.bolo-tmp/') ||
      e.startsWith('.planning/') ||
      e.startsWith('.claude/') ||
      e.startsWith('.bolo/') ||
      e.startsWith('node_modules/') ||
      e.startsWith('scripts/') ||
      e.startsWith('packages/') ||
      e.startsWith('apps/') ||
      e.startsWith('docs/') ||
      /\.env$|\.key$|\.pem$/.test(e),
  )
  assert(
    forbidden.length === 0,
    `tarball must not ship scratch/source/secret paths, found: ${forbidden.join(', ')}`,
  )

  // ── 3) 装进一个干净项目，模拟真实用户（不带 dev 依赖） ──
  const consumer = path.join(stage, 'consumer')
  await fs.mkdir(consumer, { recursive: true })
  await fs.writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'bolo-consumer', version: '1.0.0', private: true }, null, 2),
    'utf8',
  )
  // 不传 --ignore-scripts：在配了 allow-scripts 的 npm 环境里，
  // 这个 flag 会被拒（EALLOWSCRIPTS）。发布包本就没有安装期脚本，
  // 传不传都一样，别为难用户的 npm 配置。
  await npm(['install', tarball, '--omit=dev', '--no-audit', '--no-fund'], consumer)

  const installedRoot = path.join(consumer, 'node_modules', pkg.name)
  assert(await exists(installedRoot), `package installed at node_modules/${pkg.name}`)

  const installedEntry = path.join(installedRoot, 'dist', 'bolo.mjs')
  assert(await exists(installedEntry), 'installed package contains dist/bolo.mjs')
  assert(
    await exists(
      path.join(installedRoot, 'dist', 'bundled-skills', 'skill-creator', 'SKILL.md'),
    ),
    'installed package contains bundled-skills',
  )

  // ── 4) 关键：安装结果不得依赖任何构建期工具 ──
  const consumerModules = path.join(consumer, 'node_modules')
  for (const buildOnly of ['tsx', 'typescript', 'esbuild']) {
    assert(
      !(await exists(path.join(consumerModules, buildOnly))),
      `${buildOnly} must not be pulled into a production install`,
    )
  }
  const installedPkg = JSON.parse(
    await fs.readFile(path.join(installedRoot, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> }
  assert(
    Object.keys(installedPkg.dependencies ?? {}).length === 0,
    'published package declares zero runtime dependencies',
  )

  // ── 5) bin 被 npm 链接 ──
  const binDir = path.join(consumerModules, '.bin')
  const binNames = await fs.readdir(binDir).catch(() => [] as string[])
  assert(
    binNames.some((n) => n === 'bolo' || n.startsWith('bolo.')),
    `npm linked the bolo bin, found: ${binNames.join(', ') || '(none)'}`,
  )

  // ── 6) 装完真的能跑 ──
  const { stdout: help } = await execFileAsync(
    process.execPath,
    [installedEntry, '--help'],
    { cwd: consumer, maxBuffer: 8 * 1024 * 1024 },
  )
  assert(/bolo/i.test(help), 'installed CLI prints help')
  assert(/--resume/.test(help), 'installed CLI exposes real commands')

  // ── 7) 端到端一轮（mock provider，不触网、不需要密钥） ──
  const { stdout: turn } = await execFileAsync(
    process.execPath,
    [installedEntry, '-p', 'hello'],
    {
      cwd: consumer,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        BOLO_PROVIDER: 'mock',
        BOLO_CONFIG_DIR: path.join(stage, 'cfg'),
      },
    },
  )
  assert(turn.length > 0, 'installed CLI completes a turn against the mock provider')

  await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
  console.log(
    `PASS: dist install (${tarballName}, ${meta[0]!.entryCount} files in tarball)`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
