/**
 * 门槛 3a：配置文件写坏了必须说出来
 *
 * readJsonFile 用的是 `catch { return null }`，分不清「文件不存在」（正常）
 * 和「文件在但写坏了」（用户手误）。两者都退回默认值，于是用户改完 config
 * 跑起来，看到的是「没有 API key」——他会去查 key，而真正的问题是 JSON 少了个括号。
 *
 * 契约：
 * - 文件不存在 → 静默用默认值（正常路径，不该有噪音）
 * - 文件存在但解析失败 → **产生 warning**，指名文件与原因，仍用默认值继续
 * - 解析成功 → 无 warning
 * - warning 不阻断启动（配置坏掉不该让人连 CLI 都进不去）
 *
 * 运行：npx tsx scripts/test-config-parse-warning.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  loadConfigJsonWithWarnings,
  readJsonFileResult,
} from '../packages/config/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  const root = path.join(process.cwd(), '.bolo-tmp', 'config-warn-test')
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(root, { recursive: true })

  // ── 1) 缺文件与坏文件必须可区分 ──
  const missing = await readJsonFileResult(path.join(root, 'nope.json'))
  assert(missing.found === false, 'absent file reported as not found')

  const badPath = path.join(root, 'bad.json')
  await fs.writeFile(badPath, '{ "a": 1, ', 'utf8')
  const bad = await readJsonFileResult(badPath)
  assert(bad.found === true, 'malformed file is found')
  assert(bad.found === true && bad.ok === false, 'malformed file reports failure')
  assert(
    bad.found === true && bad.ok === false && bad.reason.length > 0,
    'failure carries a reason',
  )

  const goodPath = path.join(root, 'good.json')
  await fs.writeFile(goodPath, '{ "version": 1 }', 'utf8')
  const good = await readJsonFileResult<{ version: number }>(goodPath)
  assert(
    good.found === true && good.ok === true && good.value.version === 1,
    'valid file parses',
  )

  // JSONC 注释仍受支持（配置文档明说可用 //）
  const jsoncPath = path.join(root, 'jsonc.json')
  await fs.writeFile(jsoncPath, '{\n  // comment\n  "version": 1\n}', 'utf8')
  const jsonc = await readJsonFileResult<{ version: number }>(jsoncPath)
  assert(
    jsonc.found === true && jsonc.ok === true && jsonc.value.version === 1,
    'JSONC comments still parse',
  )

  // ── 2) loadConfigJson 层：坏配置产生 warning，且不抛 ──
  {
    const dir = path.join(root, 'layout-bad')
    await fs.mkdir(dir, { recursive: true })
    const configJson = path.join(dir, 'config.json')
    await fs.writeFile(
      configJson,
      '{ "version": 1, "defaultProvider": "work",\n  "providers": { broken\n',
      'utf8',
    )

    const r = await loadConfigJsonWithWarnings({ configJson } as never)
    assert(r.config !== undefined, 'still returns a usable config')
    assert(r.warnings.length === 1, `exactly one warning, got ${r.warnings.length}`)
    const w = r.warnings[0]!
    assert(w.includes(configJson), `warning names the file: ${w}`)
    assert(
      /pars|json|syntax|unexpected/i.test(w),
      `warning explains it is a parse failure: ${w}`,
    )
    assert(
      /default/i.test(w),
      `warning states the fallback so the user knows what is in effect: ${w}`,
    )
  }

  // ── 3) 缺文件 → 无 warning（正常路径不该有噪音） ──
  {
    const dir = path.join(root, 'layout-missing')
    await fs.mkdir(dir, { recursive: true })
    const r = await loadConfigJsonWithWarnings({
      configJson: path.join(dir, 'config.json'),
    } as never)
    assert(r.warnings.length === 0, 'absent config produces no warning')
    assert(r.config !== undefined, 'absent config still yields defaults')
  }

  // ── 4) 好文件 → 无 warning，且值真的生效 ──
  {
    const dir = path.join(root, 'layout-good')
    await fs.mkdir(dir, { recursive: true })
    const configJson = path.join(dir, 'config.json')
    await fs.writeFile(
      configJson,
      JSON.stringify({ version: 1, defaultProvider: 'work' }),
      'utf8',
    )
    const r = await loadConfigJsonWithWarnings({ configJson } as never)
    assert(r.warnings.length === 0, 'valid config produces no warning')
    assert(
      r.config.defaultProvider === 'work',
      'valid config values take effect',
    )
  }

  // ── 5) apiKeyEnv 字段语义校验：sk- 值 / 非法环境变量名 → warning ──
  {
    const dir = path.join(root, 'layout-keyfields')
    await fs.mkdir(dir, { recursive: true })
    const configJson = path.join(dir, 'config.json')
    await fs.writeFile(
      configJson,
      JSON.stringify({
        version: 1,
        providers: {
          good: {
            kind: 'openai-compatible',
            baseUrl: 'https://x',
            model: 'm',
            apiKeyEnv: 'MY_API_KEY',
          },
          leaked: {
            kind: 'openai-compatible',
            baseUrl: 'https://x',
            model: 'm',
            apiKeyEnv: 'sk-abc123',
          },
          spaced: {
            kind: 'openai-compatible',
            baseUrl: 'https://x',
            model: 'm',
            apiKeyEnv: 'MY KEY',
          },
        },
      }),
      'utf8',
    )
    const r = await loadConfigJsonWithWarnings({ configJson } as never)
    assert(r.warnings.length >= 2, 'sk- value and invalid name both warn')
    assert(
      r.warnings.some((w) => w.includes('leaked') && w.includes('apiKeyEnv')),
      'sk- value warning names the provider',
    )
    assert(
      r.warnings.some((w) => w.includes('spaced') && w.includes('not a valid')),
      'invalid env name warning names the provider',
    )
    assert(
      !r.warnings.some((w) => w.includes('good')),
      'valid apiKeyEnv name produces no warning',
    )
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  console.log('PASS: config parse failures are reported')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
