/**
 * HKP-2: Bash 命令级安全分析纯契约（auto 模式前置判定）。
 *
 * 目标：auto 模式对 Bash 工具做确定性命令级分析——提权/危险形态直接拒绝、
 * 包管理器白名单子命令直接放行、其余交给分类器/询问。
 * 词法级拆分，不做语义理解；无法解析（未闭合引号等）fail-closed 不自动放行。
 *
 * 危险形态（保守白名单之外的明确拒绝）：
 * - 提权命令头：sudo / su / doas / pkexec / runuser
 * - rg/grep 的 --pre（执行任意命令的预处理）
 * - 管道到 shell：`| sh|bash|zsh|fish|dash|powershell|pwsh`（网络管道注入面）
 * - 破坏性目标：`rm -rf /`、`dd of=/dev/*`、`mkfs.*`
 */
export type BashCommandSafetyVerdict = 'allow' | 'deny' | 'ask'

export type BashCommandSafetyResult = {
  verdict: BashCommandSafetyVerdict
  reason: string
}

/** 包管理器白名单：可自动放行的安全子命令（缺省走询问） */
const PACKAGE_MANAGER_ALLOW_SUBCOMMANDS = new Set([
  'install',
  'i',
  'uninstall',
  'remove',
  'rm',
  'update',
  'upgrade',
  'up',
  'run',
  'build',
  'test',
  'lint',
  'format',
  'add',
  'list',
  'ls',
  'search',
  'info',
  'view',
  'init',
  'create',
  'login',
  'logout',
  'publish',
  'pack',
  'version',
  'help',
  'outdated',
  'why',
  'tree',
  'audit',
  'mod',
  'get',
  'vet',
  'fmt',
  'work',
  'generate',
  'clean',
])

/** 命令名（含常见变体）→ 包管理器族 */
const PACKAGE_MANAGERS = new Map<string, string>([
  ['npm', 'npm'],
  ['pnpm', 'pnpm'],
  ['yarn', 'yarn'],
  ['bun', 'bun'],
  ['cargo', 'cargo'],
  ['pip', 'pip'],
  ['pip3', 'pip'],
  ['uv', 'uv'],
  ['go', 'go'],
  ['gradle', 'gradle'],
  ['mvn', 'maven'],
  ['composer', 'composer'],
])

/**
 * 可执行任意包/代码的命令名：npx/bunx 之类即使子命令看起来安全
 * 也走询问（无法静态确认被执行的包行为）。pnpm 仍是包管理器
 * （dlx/exec 不在白名单子命令，自然走询问）。
 */
const ARBITRARY_EXECUTORS = new Set(['npx', 'bunx'])

const PRIVILEGE_ESCALATION = new Set([
  'sudo',
  'su',
  'doas',
  'pkexec',
  'runuser',
])

const DESTRUCTIVE_TARGET = [
  /^rm\s+-rf\s+\/$/u,
  /^dd\s+.*\bof=\/dev\//u,
  /^mkfs\./u,
]

/**
 * 词法级命令拆分：处理单/双引号、反斜杠转义与空白。
 * 未闭合引号或无法解析返回 undefined（fail-closed）。
 */
export function tokenizeShellCommand(
  command: string,
): string[] | undefined {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  let hasToken = false
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index]!
    if (quote) {
      if (ch === quote) {
        quote = undefined
      } else if (ch === '\\' && quote === '"') {
        index += 1
        if (index >= command.length) return undefined
        current += command[index]
      } else if (ch === '\\' && quote === "'") {
        // 单引号内反斜杠是字面量
        current += ch
      } else {
        current += ch
      }
      hasToken = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasToken = true
      continue
    }
    if (ch === '\\') {
      index += 1
      if (index >= command.length) return undefined
      current += command[index]
      hasToken = true
      continue
    }
    if (/\s/u.test(ch)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (quote !== undefined) return undefined
  if (hasToken) tokens.push(current)
  return tokens
}

function hasPipeToShell(tokens: readonly string[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== '|') continue
    const next = tokens[index + 1]
    if (next && ['sh', 'bash', 'zsh', 'fish', 'dash', 'powershell', 'pwsh'].includes(next)) {
      return next
    }
  }
  return undefined
}

function hasPreFlag(tokens: readonly string[]): string | undefined {
  const prePosition = tokens.indexOf('--pre')
  if (prePosition <= 0) return undefined
  const cmd = tokens[prePosition - 1]
  if (cmd === 'rg' || cmd === 'grep' || cmd === 'ripgrep') {
    return `--pre on ${cmd}`
  }
  return undefined
}

/**
 * 命令级安全判定：deny（危险）/ allow（包管理器白名单）/ ask（其余）。
 * 无法解析的命令 fail-closed 返回 ask（不自动放行，也不武断拒绝）。
 */
export function classifyBashCommandSafety(
  command: string,
): BashCommandSafetyResult {
  const tokens = tokenizeShellCommand(command)
  if (!tokens || tokens.length === 0) {
    return {
      verdict: 'ask',
      reason: 'unparsable command; not auto-approved',
    }
  }
  const head = tokens[0]!.toLowerCase()
  if (ARBITRARY_EXECUTORS.has(head)) {
    return {
      verdict: 'ask',
      reason: `${head} can execute arbitrary packages; not auto-approved`,
    }
  }
  if (PRIVILEGE_ESCALATION.has(head)) {
    return {
      verdict: 'deny',
      reason: `privilege escalation command "${head}" is never auto-approved`,
    }
  }
  const pipeShell = hasPipeToShell(tokens)
  if (pipeShell) {
    return {
      verdict: 'deny',
      reason: `piping to shell (${pipeShell}) is never auto-approved`,
    }
  }
  const preFlag = hasPreFlag(tokens)
  if (preFlag) {
    return {
      verdict: 'deny',
      reason: `command preprocessor ${preFlag} is never auto-approved`,
    }
  }
  const joined = tokens.join(' ')
  for (const pattern of DESTRUCTIVE_TARGET) {
    if (pattern.test(joined)) {
      return {
        verdict: 'deny',
        reason: 'destructive target is never auto-approved',
      }
    }
  }
  const manager = PACKAGE_MANAGERS.get(head)
  if (manager) {
    const sub = tokens[1]?.toLowerCase()
    if (sub === undefined || PACKAGE_MANAGER_ALLOW_SUBCOMMANDS.has(sub)) {
      return {
        verdict: 'allow',
        reason: `${manager} ${sub ?? ''} is on the auto-approve allowlist`,
      }
    }
  }
  return { verdict: 'ask', reason: 'not covered by the command allowlist' }
}
