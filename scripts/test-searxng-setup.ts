/**
 * OI-07C1: SearXNG managed setup files and configuration transaction.
 *
 * This gate is filesystem-only. It must never require Docker or public
 * upstream availability.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  SEARXNG_DOCKER_IMAGE,
  commitSearxngSearchConfig,
  createSearxngSetupPlan,
  parseJsonc,
  patchSearxngConfigJsonc,
  type BoloConfigJson,
} from '../packages/config/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('FAIL: ' + message)
}

function expectThrows(fn: () => unknown, pattern: RegExp, message: string) {
  try {
    fn()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    assert(pattern.test(detail), message + ': ' + detail)
    return
  }
  throw new Error('FAIL: ' + message + ': did not throw')
}

async function main() {
  const root = path.join(process.cwd(), '.bolo-tmp', 'searxng-setup-test')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(root, { recursive: true })

  try {
    const plan = createSearxngSetupPlan({
      layoutRoot: path.join(root, 'user-layout'),
      port: 8891,
      secretKey: 'A'.repeat(43),
    })

    assert(
      SEARXNG_DOCKER_IMAGE.includes('@sha256:') &&
        !SEARXNG_DOCKER_IMAGE.endsWith(':latest'),
      'the managed image is pinned by digest',
    )
    assert(
      plan.paths.root === path.join(root, 'user-layout', 'searxng'),
      'managed files stay under the user Bolo layout',
    )
    assert(
      plan.paths.composeFile.endsWith(path.join('searxng', 'compose.yaml')) &&
        plan.paths.settingsFile.endsWith(
          path.join('searxng', 'config', 'settings.yml'),
        ) &&
        plan.paths.dataDir.endsWith(path.join('searxng', 'data')),
      'plan exposes stable compose/config/data paths',
    )
    assert(
      plan.composeYaml.includes(SEARXNG_DOCKER_IMAGE),
      'compose uses the pinned image',
    )
    assert(
      plan.composeYaml.includes('127.0.0.1:8891:8080') &&
        !plan.composeYaml.includes('0.0.0.0:8891'),
      'the host port is loopback-only',
    )
    assert(
      !plan.composeYaml.includes('container_name:'),
      'compose relies on an isolated project name instead of a global container name',
    )
    assert(
      plan.settingsYaml.includes('secret_key: "AAAAAAAA') &&
        plan.settingsYaml.includes('- json') &&
        !plan.settingsYaml.includes('engines:'),
      'settings enable JSON with a generated secret and do not force an engine',
    )
    const manifest = JSON.parse(plan.manifestJson) as {
      version?: number
      port?: number
      image?: string
      baseUrl?: string
      secretKey?: string
    }
    assert(
      manifest.version === 1 &&
        manifest.port === 8891 &&
        manifest.image === SEARXNG_DOCKER_IMAGE &&
        manifest.baseUrl === 'http://127.0.0.1:8891',
      'manifest records the non-secret management contract',
    )
    assert(
      manifest.secretKey === undefined &&
        !plan.manifestJson.includes('AAAAAAAA'),
      'the secret never enters the manifest',
    )
    expectThrows(
      () =>
        createSearxngSetupPlan({
          layoutRoot: root,
          port: 0,
          secretKey: 'A'.repeat(43),
        }),
      /port/i,
      'invalid ports fail closed',
    )
    expectThrows(
      () =>
        createSearxngSetupPlan({
          layoutRoot: root,
          port: 8891,
          secretKey: 'short',
        }),
      /secret/i,
      'unsafe secrets fail closed',
    )

    const existingJsonc = [
      '{',
      '  // preserve this user note',
      '  "version": 1,',
      '  "provider": { "kind": "mock" },',
      '  "search": {',
      '    "otherBackend": { "enabled": true },',
      '    "searxng": { "language": "zh-CN", "safeSearch": 2 },',
      '  },',
      '}',
      '',
    ].join('\n')
    const patched = patchSearxngConfigJsonc(existingJsonc, {
      enabled: true,
      baseUrl: plan.baseUrl,
    })
    const parsed = parseJsonc<BoloConfigJson>(patched)
    assert(
      patched.includes('// preserve this user note'),
      'patching search preserves unrelated JSONC comments',
    )
    assert(
      parsed.provider?.kind === 'mock' &&
        (parsed.search as Record<string, unknown> | undefined)?.otherBackend !==
          undefined,
      'patching preserves unrelated root and search fields',
    )
    assert(
      parsed.search?.searxng?.baseUrl === plan.baseUrl &&
        parsed.search?.searxng?.language === 'zh-CN' &&
        parsed.search?.searxng?.safeSearch === 2,
      'patching merges the managed endpoint without deleting user search preferences',
    )

    const inserted = patchSearxngConfigJsonc(
      ['{', '  // trailing comma remains valid', '  "version": 1,', '}', ''].join(
        '\n',
      ),
      { enabled: true, baseUrl: plan.baseUrl },
    )
    assert(
      inserted.includes('// trailing comma remains valid') &&
        parseJsonc<BoloConfigJson>(inserted).search?.searxng?.baseUrl ===
          plan.baseUrl,
      'patching inserts search into a JSONC object with a trailing comma',
    )
    const insertedWithoutTrailingComma = patchSearxngConfigJsonc(
      ['{', '  "version": 1', '}', ''].join('\n'),
      { enabled: true, baseUrl: plan.baseUrl },
    )
    assert(
      insertedWithoutTrailingComma.includes('"version": 1,') &&
        !insertedWithoutTrailingComma.includes('\n,\n'),
      'insertion places a missing comma after the prior value, not on a stray line',
    )
    expectThrows(
      () =>
        patchSearxngConfigJsonc(
          '{"search":"broken"}\n',
          { enabled: true, baseUrl: plan.baseUrl },
        ),
      /search.*object/i,
      'an invalid existing search section is never overwritten',
    )

    const configPath = path.join(root, 'commit', 'config.json')
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, existingJsonc, 'utf8')
    const committed = await commitSearxngSearchConfig({
      configPath,
      searxng: { enabled: true, baseUrl: plan.baseUrl },
    })
    assert(committed.ok, 'valid JSONC commits successfully')
    const committedText = await fs.readFile(configPath, 'utf8')
    assert(
      committedText.includes('// preserve this user note') &&
        parseJsonc<BoloConfigJson>(committedText).search?.searxng?.baseUrl ===
          plan.baseUrl,
      'commit preserves comments and writes the managed endpoint',
    )
    const leftovers = (await fs.readdir(path.dirname(configPath))).filter(
      (name) => name.includes('.tmp-'),
    )
    assert(leftovers.length === 0, 'successful atomic commit leaves no temp file')

    const invalidPath = path.join(root, 'invalid', 'config.json')
    await fs.mkdir(path.dirname(invalidPath), { recursive: true })
    const invalidBefore = '{not valid jsonc\n'
    await fs.writeFile(invalidPath, invalidBefore, 'utf8')
    const refused = await commitSearxngSearchConfig({
      configPath: invalidPath,
      searxng: { enabled: true, baseUrl: plan.baseUrl },
    })
    assert(!refused.ok && /parse|json/i.test(refused.reason), 'invalid config is refused')
    assert(
      (await fs.readFile(invalidPath, 'utf8')) === invalidBefore,
      'refusing an invalid config never overwrites it',
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }

  console.log('PASS: searxng setup contract')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
