/**
 * AR3E · secret 不得越过 IPC 边界
 *
 * ROADMAP 对 AR3E 的验收原文之一：**secret 不回传 renderer/transcript**。
 *
 * 现状是对的：provider 列表只回 `hasKeyConfig: boolean` 与 `apiKeyEnv`
 * （**变量名不是密钥**），`desktopSettings` 里也只有 cwd/useMock/permissionMode。
 *
 * 但对的方式很脆：两处用的是 `{ ...desktopSettings }` 这种**无边界展开**。
 * 日后有人往那个对象里加一个字段，它会自动跟着过界，而**没有任何东西会报警**。
 * 这与本项目一路在防的静默失败同类——不是「现在错了」，是「错了不会被发现」。
 *
 * 所以这里守两层：
 *
 * **① 纯函数层**：`redactSecrets` 必须在**任意嵌套深度**上抹掉密钥形状的值，
 *    且保留 `apiKeyEnv` 这类**名字**（抹掉它会让用户看不到该设哪个环境变量，
 *    那是把可诊断性也一起抹了）。
 *
 * **② 源码层**：主进程返回给 renderer 的载荷里不得出现取自环境变量的原始密钥。
 *
 * 运行：npx tsx scripts/test-desktop-secret-boundary.ts
 */
import { promises as fs } from 'node:fs'

/**
 * 文件读不到时给出**可诊断**的失败，而不是让 ENOENT 冒出来。
 * 这些测试按路径读源码，一旦文件被改名/移动，ENOENT 只会说
 * 「没这个文件」，不会说「契约测试失去了它要守的对象」——
 * 后者才是真正发生的事。（本刀就踩到了：index.mjs → index.ts。）
 */
async function readOrExplain(file: string, why: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    console.error(
      `FAIL: cannot read ${file} — ${why}. ` +
        'If the file moved, update this test rather than deleting the check.',
    )
    process.exit(1)
  }
}
import path from 'node:path'
import { redactSecretsDeep } from '../packages/shared/src/secretBoundary.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function main() {
  // ── 1) 顶层密钥被抹 ──
  {
    const out = redactSecretsDeep({
      apiKey: 'sk-abcdef0123456789abcdef',
      cwd: '/w',
    }) as Record<string, unknown>
    assert(out.apiKey !== 'sk-abcdef0123456789abcdef', 'the raw key does not survive')
    assert(
      typeof out.apiKey === 'string' && out.apiKey.includes('redacted'),
      `it is visibly redacted rather than deleted — a missing field reads as "not configured": ${String(out.apiKey)}`,
    )
    assert(out.cwd === '/w', 'unrelated fields are untouched')
  }

  // ── 2) 嵌套任意深度 ──
  // 一层深的检查挡不住 providers[].auth.token 这种形状。
  {
    const out = redactSecretsDeep({
      providers: [
        { id: 'a', headers: { Authorization: 'Bearer sk-deadbeefdeadbeef' } },
        { id: 'b', nested: { deep: { token: 'ghp_0123456789abcdefghij' } } },
      ],
    })
    const json = JSON.stringify(out)
    assert(!json.includes('sk-deadbeefdeadbeef'), 'a key nested in headers is redacted')
    assert(!json.includes('ghp_0123456789abcdefghij'), 'a key nested three levels deep is redacted')
    assert(json.includes('"id":"a"'), 'harmless fields survive')
  }

  // ── 3) **名字**必须留着 ──
  // apiKeyEnv 是「该设哪个环境变量」的提示，抹掉它等于把可诊断性也抹了。
  {
    const out = redactSecretsDeep({
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      hasKeyConfig: true,
    }) as Record<string, unknown>
    assert(
      out.apiKeyEnv === 'ANTHROPIC_API_KEY',
      `the env var name is not a secret and must survive: ${String(out.apiKeyEnv)}`,
    )
    assert(out.hasKeyConfig === true, 'the boolean survives')

    // 上面那条曾经是**空的**：'ANTHROPIC_API_KEY' 太短，本来就不会被通用规则命中，
    // 所以即使去掉白名单它也照样通过。用一个长到会触发通用规则的名字，
    // 才能真正验证「字段名白名单」在起作用。
    const longName = 'BOLO_VERY_LONG_PROVIDER_API_KEY_ENV_VARIABLE_NAME'
    assert(
      longName.length >= 40,
      'sanity: the probe name is long enough to trip the generic secret pattern',
    )
    const out2 = redactSecretsDeep({ apiKeyEnv: longName }) as Record<string, unknown>
    assert(
      out2.apiKeyEnv === longName,
      `a long env var name must still survive — it is a hint, not a secret: ${String(out2.apiKeyEnv)}`,
    )
  }

  // ── 4) 值看起来像密钥就抹，即使字段名无辜 ──
  // 真实泄漏往往发生在 `detail` / `message` 这类字段里（上游把 key 回显进错误文本）。
  {
    const out = redactSecretsDeep({
      detail: 'request failed with key sk-live-0123456789abcdefgh',
    }) as Record<string, unknown>
    assert(
      !String(out.detail).includes('sk-live-0123456789abcdefgh'),
      `a key echoed inside an innocent-looking field is still redacted: ${String(out.detail)}`,
    )
    assert(
      String(out.detail).includes('request failed'),
      'the surrounding message survives so the error stays diagnosable',
    )
  }

  // ── 5) 不误伤：短字符串与普通路径不该被当成密钥 ──
  // 过度抹除会让界面变成一片 <redacted>，那同样是不可用。
  {
    const out = redactSecretsDeep({
      model: 'claude-opus-4-6',
      cwd: 'E:/DEV/HelsincyAgent',
      note: 'token count is 1234',
    }) as Record<string, unknown>
    assert(out.model === 'claude-opus-4-6', `model name survives: ${String(out.model)}`)
    assert(out.cwd === 'E:/DEV/HelsincyAgent', `path survives: ${String(out.cwd)}`)
    assert(
      String(out.note).includes('1234'),
      `the word "token" alone is not a secret: ${String(out.note)}`,
    )
  }

  // ── 6) 循环引用不炸 ──
  {
    const cyclic: Record<string, unknown> = { id: 'x' }
    cyclic.self = cyclic
    const out = redactSecretsDeep(cyclic) as Record<string, unknown>
    assert(out.id === 'x', 'a cyclic object is handled rather than throwing')
  }

  // ── 7) 纯函数：不改入参 ──
  {
    const input = { apiKey: 'sk-abcdef0123456789abcdef' }
    redactSecretsDeep(input)
    assert(
      input.apiKey === 'sk-abcdef0123456789abcdef',
      'redaction returns a copy — mutating the caller would corrupt the real config',
    )
  }
}

async function sourceCheck() {
  // ── 8) 主进程不得把环境变量里的原始密钥放进 IPC 返回体 ──
  const src = await readOrExplain(
    path.join('apps', 'desktop', 'src', 'main', 'index.ts'),
    'the main process payloads being checked for secrets',
  )
  const leaks = [...src.matchAll(/\b(apiKey|token|secret)\s*:\s*([^\n,}]+)/gi)]
    .map((m) => `${m[1]}: ${m[2]!.trim()}`)
    // 只报「疑似把真值放进去」的写法；布尔/名字类字段是安全的
    .filter((s) => !/^(apiKeyEnv|hasKeyConfig)/i.test(s))
    .filter((s) => /process\.env|apiKey\b(?!Env)/i.test(s))
  assert(
    leaks.length === 0,
    `main process appears to put a raw secret into an IPC payload: ${leaks.join(' | ')}`,
  )

  // 抽取器自检：这个正则要真能在本文件上匹配到东西，否则上面永真
  const anyMatch = [...src.matchAll(/\b(apiKeyEnv|hasKeyConfig)\s*:/g)]
  assert(
    anyMatch.length > 0,
    'sanity: the scanner really does find key-ish fields in this file',
  )
}

async function run() {
  main()
  await sourceCheck()
  console.log('PASS: desktop secret boundary')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
