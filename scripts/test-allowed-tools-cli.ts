/**
 * AR-T3+ · `--allowed-tools` / `--disallowed-tools` 的接线
 *
 * 契约解析由 `test-tool-spec.ts` 把关；这里管**它是否真的改变了结果**。
 * 一个只测解析的实现可以全绿而 flag 根本没接上——那正是路线图里
 * 「参考实现有 `--allowedTools` 粒度」这条待办想要的东西没到手。
 *
 * 被验的链路：argv → parseArgs → validateToolSpecs（开会话前 fail fast）
 * → applyToolSpecsToSession → decidePermission → 工具真的跑没跑。
 *
 * 基线事实（`askPermissionTty.ts`）：非 TTY 时 `askPermission` 返回 `deny`。
 * 所以 headless 下 default 模式的 Bash 一定被拒——除非整档开
 * `bypassPermissions`。这一刀要证的就是「不用整档开也能放行这一个」。
 *
 * 运行：npx tsx scripts/test-allowed-tools-cli.ts
 */
import { parseArgs } from '../packages/cli/src/parseArgs.ts'
import {
  applyToolSpecsToSession,
  hasToolSpecs,
  validateToolSpecs,
} from '../packages/cli/src/applyToolSpecs.ts'
import {
  createEmptyPermissionRules,
  decidePermission,
  type SessionPermissionRules,
} from '../packages/permissions/src/index.ts'
import { parseToolSpecs } from '../packages/permissions/src/toolSpec.ts'
import { createSession, submitPrompt } from '../packages/core/src/index.ts'
import type { LlmProvider, ProviderStreamEvent } from '../packages/providers/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const MARKER = 'bolo-allowed-marker'
const COMMAND = `echo ${MARKER}`

/** 第一轮发一个 Bash 调用，第二轮把工具输出原样回吐 */
function bashCallingProvider(command: string): LlmProvider {
  return {
    id: 'mock-bash',
    async *completeStream(
      messages: ChatMessage[],
    ): AsyncIterable<ProviderStreamEvent> {
      const done = messages.some((m) => m.role === 'tool')
      if (!done) {
        yield {
          type: 'tool_call',
          id: 'call_bash_1',
          name: 'Bash',
          arguments: JSON.stringify({ command }),
        }
        yield { type: 'done' }
        return
      }
      const last = [...messages].reverse().find((m) => m.role === 'tool')
      yield { type: 'text_delta', text: `OUT>>${last?.content ?? ''}<<` }
      yield { type: 'done' }
    },
    async completeText() {
      return 'summary'
    },
  }
}

/** 跑一轮，返回 Bash 工具的实际输出（非 TTY，所以 askPermission 一律 deny） */
async function runTurn(
  specs: { allowedTools?: string[]; disallowedTools?: string[] },
  command = COMMAND,
): Promise<string> {
  let toolOutput = ''
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    permissionMode: 'default',
    provider: bashCallingProvider(command),
    // 非 TTY 的真实行为：没人可问 → 拒
    askPermission: async () => 'deny',
    onEvent: (e) => {
      if (e.type === 'tool_end' && e.name === 'Bash') toolOutput = e.output
    },
  })
  applyToolSpecsToSession(session, specs)
  await submitPrompt(session, 'run it')
  return toolOutput
}

async function main() {
  // ── 1) argv 解析：两种写法、可重复、逗号 ──
  {
    const a = parseArgs([
      '-p',
      'hi',
      '--allowed-tools',
      'Read,Grep',
      '--allowed-tools=mcp__ddg__search',
      '--disallowed-tools',
      'Bash(rm *)',
    ])
    assert(
      JSON.stringify(a.allowedTools) ===
        JSON.stringify(['Read,Grep', 'mcp__ddg__search']),
      `repeated --allowed-tools accumulate verbatim: ${JSON.stringify(a.allowedTools)}`,
    )
    assert(
      JSON.stringify(a.disallowedTools) === JSON.stringify(['Bash(rm *)']),
      'the deny list is collected separately',
    )
    assert(a.print === true && a.prompt === 'hi', 'and the rest of argv still parses')
  }

  // 未加参数时不得凭空造出规格——「没提」和「提了空的」是两回事
  {
    const a = parseArgs(['-p', 'hi'])
    assert(
      a.allowedTools === undefined && a.disallowedTools === undefined,
      'no flags means no specs at all',
    )
    assert(!hasToolSpecs(a), 'and hasToolSpecs agrees, so nothing gets touched')
  }

  // ── 2) 写错的规格必须在开会话之前就被挡下 ──
  {
    const bad = validateToolSpecs({ disallowedTools: ['Bash(rm'] })
    assert(!bad.ok, 'a malformed deny spec is rejected')
    assert(
      !bad.ok && bad.reason.includes('--disallowed-tools'),
      `the message names the flag the user typed: ${bad.ok ? '' : bad.reason}`,
    )
    const good = validateToolSpecs({ allowedTools: ['Read'] })
    assert(good.ok, 'a well-formed spec validates')
  }

  // ── 3) 基线：headless 下 Bash 确实过不去 ──
  // 没有这一条，后面的「放行生效」可能只是因为它本来就允许。
  const denied = await runTurn({})
  assert(
    denied.includes('permission denied'),
    `without any flag the tool is denied in headless mode — got: ${denied.slice(0, 120)}`,
  )

  // ── 4) 放行**这一个** → 真的跑起来了 ──
  {
    const out = await runTurn({ allowedTools: [`Bash(${COMMAND})`] })
    assert(
      out.includes(MARKER),
      `--allowed-tools ran the command instead of denying it — got: ${out.slice(0, 160)}`,
    )
    assert(
      !out.includes('permission denied'),
      'and it is not a denial that merely happens to contain the marker',
    )
  }

  // ── 5) 粒度：放行的是那一条命令，不是 Bash 整个工具 ──
  {
    const out = await runTurn(
      { allowedTools: [`Bash(${COMMAND})`] },
      'echo something-else-entirely',
    )
    assert(
      out.includes('permission denied'),
      `a different command is still denied — otherwise this is bypassPermissions ` +
        `wearing a narrower name. Got: ${out.slice(0, 160)}`,
    )
  }

  // 工具名粒度同理：放行一个 MCP 工具不得连累它的同伴
  {
    const r = parseToolSpecs({ allow: ['mcp__ddg__search'] })
    assert(r.ok, 'spec parses')
    const rules = r.ok ? r.rules : createEmptyPermissionRules()
    const one = decidePermission({
      cwd: process.cwd(),
      toolName: 'mcp__ddg__search',
      mode: 'default',
      toolInput: {},
      rules,
    })
    const other = decidePermission({
      cwd: process.cwd(),
      toolName: 'mcp__ddg__fetch',
      mode: 'default',
      toolInput: {},
      rules,
    })
    assert(one.behavior === 'allow', 'the named MCP tool is allowed by the gate')
    assert(
      other.behavior !== 'allow',
      'its sibling on the same server is not — this is the gap the flag exists to close',
    )
  }

  // ── 6) deny 压得住 bypassPermissions ──
  // 这是 --disallowed-tools 的全部意义：整档放开时还能钉死几个。
  {
    const r = parseToolSpecs({ deny: ['Bash(rm *)'] })
    assert(r.ok, 'deny spec parses')
    const rules = r.ok ? r.rules : createEmptyPermissionRules()
    const d = decidePermission({
      cwd: process.cwd(),
      toolName: 'Bash',
      mode: 'bypassPermissions',
      toolInput: { command: 'rm -rf /' },
      rules,
    })
    assert(
      d.behavior === 'deny',
      `always-deny outranks bypassPermissions — got ${d.behavior} (${d.reason})`,
    )
    // 裁判自检：同一模式下别的命令确实是放行的，否则上一条可能只是 bypass 没生效
    const ok = decidePermission({
      cwd: process.cwd(),
      toolName: 'Bash',
      mode: 'bypassPermissions',
      toolInput: { command: 'echo hi' },
      rules,
    })
    assert(
      ok.behavior === 'allow',
      'setup: bypassPermissions really does allow other commands, so the deny above is the rule at work',
    )
  }

  // ── 7) --resume：命令行规格**叠加**在快照恢复的规则之上 ──
  // 覆盖会让用户上次点的「总是允许」凭空失效。
  {
    const session = {
      permissionRules: {
        alwaysAllowToolNames: ['Read'],
      } as SessionPermissionRules,
    }
    applyToolSpecsToSession(session, { allowedTools: ['Write'] })
    assert(
      decidePermission({
        cwd: process.cwd(),
        toolName: 'Read',
        mode: 'default',
        toolInput: {},
        rules: session.permissionRules,
      }).behavior === 'allow',
      'the rule restored from the snapshot survives',
    )
    assert(
      decidePermission({
        cwd: process.cwd(),
        toolName: 'Write',
        mode: 'default',
        toolInput: {},
        rules: session.permissionRules,
      }).behavior === 'allow',
      'and the command-line rule is added on top',
    )
  }

  // ── 8) 应用阶段也不吞错（绕开 main 直接调 CLI 入口的将来路径） ──
  {
    let threw = false
    try {
      applyToolSpecsToSession(
        { permissionRules: createEmptyPermissionRules() },
        { allowedTools: ['Bash(oops'] },
      )
    } catch {
      threw = true
    }
    assert(threw, 'applying a malformed spec throws rather than silently dropping it')
  }

  // ── 9) 接缝：CLI 入口真的把 toolSpecs 用上了 ──
  // 上面每一半都测过，中间那一段（入口收到参数 → 并进会话）没有。
  // 半截都绿而接缝断掉，是这类改动最常见的落空方式。
  {
    const { runNewSessionCli } = await import('../packages/cli/src/newSessionCli.ts')
    const { promises: fsp } = await import('node:fs')
    const path = await import('node:path')
    // 会话会写用户级状态；测试仍使用隔离 cwd，避免与仓库配置互相影响
    const tmpCwd = path.join(process.cwd(), '.bolo-tmp', 'allowed-tools-seam')
    await fsp.rm(tmpCwd, { recursive: true, force: true }).catch(() => {})
    await fsp.mkdir(tmpCwd, { recursive: true })
    const { session } = await runNewSessionCli({
      cwd: tmpCwd,
      prompt: 'hello',
      print: true,
      isTty: false,
      forceMock: true,
      skipBanner: true,
      writeOut: () => {},
      writeErr: () => {},
      toolSpecs: { allowedTools: ['mcp__seam__probe'] },
    })
    assert(
      decidePermission({
        cwd: process.cwd(),
        toolName: 'mcp__seam__probe',
        mode: 'default',
        toolInput: {},
        rules: session.permissionRules,
      }).behavior === 'allow',
      'runNewSessionCli applied the specs it was handed — the entry point is wired, ' +
        'not just the helper it calls',
    )
    await fsp.rm(tmpCwd, { recursive: true, force: true }).catch(() => {})
  }

  // ── 10) main.ts 的 fail fast：写错的规格在开会话之前就退出 ──
  // 这一条走真进程，因为要验的正是「退出码与 stderr」这种只有进程边界才有的东西。
  {
    const { spawnSync } = await import('node:child_process')
    const { createRequire } = await import('node:module')
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
    const r = spawnSync(
      process.execPath,
      [
        tsxCli,
        'packages/cli/src/main.ts',
        '-p',
        'hello',
        '--disallowed-tools',
        'Bash(rm',
      ],
      { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, BOLO_PROVIDER: 'mock' } },
    )
    assert(
      r.status === 2,
      `a malformed spec exits with the usage code before any turn runs — got ${r.status}`,
    )
    assert(
      r.stderr.includes('--disallowed-tools'),
      `and says which flag was wrong: ${JSON.stringify(r.stderr.slice(0, 200))}`,
    )
    assert(
      !r.stdout.includes('OUT>>') && !/assistant/i.test(r.stdout),
      'and no turn was run before the check',
    )
  }

  console.log('PASS: allowed-tools CLI wiring')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
