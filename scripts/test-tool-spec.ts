/**
 * AR-T3+ · `--allowed-tools` / `--disallowed-tools` 的规格解析（纯契约）
 *
 * 路线图 §14.5 记的缺口原文：**「`-p` 下想放行单个 MCP 工具，只能把**全部**
 * 权限一起放开」**。这是活体暴露的，不是推测——非 TTY 下 `askPermission`
 * 一律返回 `deny`（`askPermissionTty.ts`），所以任何走到 `ask` 的工具在
 * headless 里都过不去，唯一的出路是整档 `bypassPermissions`。
 *
 * 权限规则模型本身（`SessionPermissionRules`：always-allow / always-deny，
 * 名字 / 前缀 / Bash 模式 / 路径 glob）**早就够用**，缺的只是命令行入口。
 * 所以这一刀是**纯解析**：把一串规格文本翻成已有的规则结构，不碰匹配器。
 *
 * ## 为什么解析必须 fail-closed
 *
 * 两个方向的错法轻重不同，且**都不能靠「忽略看不懂的」糊过去**：
 *
 * - `--allowed-tools` 写错被静默丢弃 → 用户以为放行了，实际仍然 deny。
 *   烦人，但安全。
 * - `--disallowed-tools` 写错被静默丢弃 → **用户以为拦住了，实际没拦**。
 *   这是会出事的方向，而且出事时用户手里握着一份「我明明写了」的命令行。
 *
 * 所以看不懂的规格一律**硬失败**，不猜、不跳过。
 *
 * 运行：npx tsx scripts/test-tool-spec.ts
 */
import { parseToolSpecs } from '../packages/permissions/src/toolSpec.ts'
import {
  matchesAlwaysAllow,
  matchesAlwaysDeny,
  type SessionPermissionRules,
} from '../packages/permissions/src/index.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function ok(r: ReturnType<typeof parseToolSpecs>): SessionPermissionRules {
  assert(r.ok, `expected a successful parse, got: ${r.ok ? '' : r.reason}`)
  return r.rules
}

function main() {
  // ── 1) 裸工具名 → 精确名单 ──
  // 这条正是路线图记的那个缺口：放行**一个** MCP 工具。
  {
    const rules = ok(parseToolSpecs({ allow: ['mcp__ddg__search'] }))
    assert(
      matchesAlwaysAllow('mcp__ddg__search', rules),
      'the named MCP tool is allowed',
    )
    assert(
      !matchesAlwaysAllow('mcp__ddg__fetch', rules),
      'and its sibling on the same server is NOT — granularity is the whole point',
    )
    assert(!matchesAlwaysAllow('Bash', rules), 'nor is anything else')
  }

  // ── 2) 通配后缀 → 前缀规则 ──
  {
    const rules = ok(parseToolSpecs({ allow: ['mcp__ddg__*'] }))
    assert(matchesAlwaysAllow('mcp__ddg__search', rules), 'prefix matches a member')
    assert(matchesAlwaysAllow('mcp__ddg__fetch', rules), 'and another member')
    assert(
      !matchesAlwaysAllow('mcp__other__search', rules),
      'but not a different server',
    )
  }

  // ── 3) Bash(模式) → Bash 模式表（沿用既有语义，不新造） ──
  {
    const rules = ok(parseToolSpecs({ allow: ['Bash(git status)'] }))
    assert(
      matchesAlwaysAllow('Bash', rules, { toolInput: { command: 'git status' } }),
      'the exact command is allowed',
    )
    assert(
      !matchesAlwaysAllow('Bash', rules, { toolInput: { command: 'rm -rf /' } }),
      'an unrelated command is not',
    )
    assert(
      !matchesAlwaysAllow('Bash', rules, {}),
      'and a bare Bash with no command is not blanket-allowed',
    )
  }

  // ── 4) 顶层逗号分隔，但**括号内的逗号不算分隔符** ──
  // 朴素的 split(',') 会把 `Bash(npm run a,b)` 劈成两半，得到两条谁也看不懂的
  // 规格。若再配上「看不懂就跳过」，用户写的放行就凭空消失了。
  {
    const rules = ok(parseToolSpecs({ allow: ['Bash(npm run a,b),Read'] }))
    assert(
      matchesAlwaysAllow('Bash', rules, { toolInput: { command: 'npm run a,b' } }),
      'the comma inside parentheses stayed part of the pattern',
    )
    assert(matchesAlwaysAllow('Read', rules), 'and the second spec still parsed')
  }

  // ── 5) 重复传参与空白 ──
  {
    const rules = ok(parseToolSpecs({ allow: ['Read', ' Write , Glob '] }))
    for (const t of ['Read', 'Write', 'Glob']) {
      assert(matchesAlwaysAllow(t, rules), `${t} allowed across repeated flags`)
    }
  }

  // ── 6) deny 侧走硬规则（它优先于 bypass，是 deny 的意义所在） ──
  {
    const rules = ok(parseToolSpecs({ deny: ['Bash(rm *)', 'mcp__untrusted__*'] }))
    assert(
      matchesAlwaysDeny('Bash', rules, { toolInput: { command: 'rm -rf .' } }),
      'the denied bash pattern matches',
    )
    assert(
      matchesAlwaysDeny('mcp__untrusted__anything', rules),
      'the denied server prefix matches',
    )
    assert(
      !matchesAlwaysAllow('mcp__untrusted__anything', rules),
      'and nothing leaked into the allow side',
    )
  }

  // ── 7) 合并进已有规则：不覆盖、不重复 ──
  {
    const base: SessionPermissionRules = { alwaysAllowToolNames: ['Read', 'Grep'] }
    const rules = ok(parseToolSpecs({ allow: ['Read', 'Write'], base }))
    assert(matchesAlwaysAllow('Grep', rules), 'pre-existing entries survive')
    assert(matchesAlwaysAllow('Write', rules), 'new entries are added')
    assert(
      rules.alwaysAllowToolNames.filter((n) => n === 'Read').length === 1,
      'and a repeat does not accumulate duplicates',
    )
    assert(
      base.alwaysAllowToolNames.length === 2,
      'the caller-supplied base is not mutated in place',
    )
  }

  // ── 8) fail-closed：看不懂的一律硬失败 ──
  const bad: Array<[string, string]> = [
    ['', 'an empty spec'],
    ['   ', 'whitespace only'],
    [',', 'a lone separator'],
    ['Read,,Write', 'an empty item between separators'],
    ['Bash(git status', 'an unclosed parenthesis'],
    ['Bash git status)', 'a stray closing parenthesis'],
    ['Bash()', 'an empty pattern'],
    ['Bash(   )', 'a whitespace-only pattern'],
    ['Read Write', 'two names run together without a separator'],
    ['Read(src/**)', 'a path filter on a non-Bash tool'],
    ['*', 'a bare wildcard that would mean "everything"'],
    ['mcp__*__search', 'a wildcard in the middle rather than at the end'],
    ['Read\nWrite', 'an embedded newline'],
  ]
  for (const [spec, what] of bad) {
    const r = parseToolSpecs({ allow: [spec] })
    assert(
      !r.ok,
      `${what} (${JSON.stringify(spec)}) must be rejected outright — silently ` +
        `dropping it would make the user believe a rule is in force when it is not`,
    )
    assert(
      r.ok || (r.reason.length > 0 && r.reason.includes(spec.trim().slice(0, 12))),
      `and the error quotes the offending spec so it can be found: ${JSON.stringify(spec)}`,
    )
  }

  // deny 侧走的是同一个解析器，同样必须硬失败
  {
    const r = parseToolSpecs({ deny: ['Bash(rm'] })
    assert(!r.ok, 'a malformed deny spec fails just as loudly as a malformed allow')
  }

  // ── 9) 空输入是合法的「没提任何规格」，不是错误 ──
  {
    const r = parseToolSpecs({})
    assert(r.ok, 'passing no flags at all is not an error')
    assert(
      r.ok && r.rules.alwaysAllowToolNames.length === 0,
      'and it yields no rules rather than an implicit allow',
    )
  }

  // ── 10) 星号一律不得放宽成「全部」 ──
  // 这条单独测：`--allowed-tools` 的存在意义就是不整档放开，
  // 一个把 `*` 解释成「全放」的实现会把这刀的目的整个抵消掉。
  {
    for (const spec of ['*', '**', 'Bash(*)']) {
      const r = parseToolSpecs({ allow: [spec] })
      if (r.ok) {
        assert(
          !matchesAlwaysAllow('Read', r.rules) &&
            !matchesAlwaysAllow('mcp__anything__x', r.rules),
          `${spec} must never become a blanket allow — that is what bypassPermissions is for`,
        )
      }
    }
  }

  console.log('PASS: tool spec parsing')
}

main()
