/**
 * `--allowed-tools` / `--disallowed-tools` 的规格解析
 *
 * 解决的缺口（活体暴露，见 ROADMAP §14.5）：headless 下 `askPermission`
 * 在非 TTY 时一律返回 `deny`，于是任何走到 `ask` 的工具都过不去，
 * 想放行**一个** MCP 工具只能整档开 `bypassPermissions` ——
 * 为了一个工具把所有权限一起放开。
 *
 * 权限模型本身不缺东西：`SessionPermissionRules` 已有 always-allow /
 * always-deny，覆盖精确名、名字前缀、Bash 模式、路径 glob，匹配器也都在。
 * 缺的只是**命令行入口**。所以本模块只做翻译，不碰匹配语义——
 * Bash 模式原样交给既有的 `matchesBashPatternList`（`git `/`git:*`/`git *`）。
 *
 * ## 语法
 *
 * | 写法 | 含义 | 落到 |
 * |------|------|------|
 * | `Read` | 精确工具名 | `alwaysAllowToolNames` |
 * | `mcp__ddg__search` | 同上（MCP 工具就是个名字） | 同上 |
 * | `mcp__ddg__*` | 名字前缀 | `alwaysAllowPrefixes` |
 * | `Bash(git status)` | Bash 命令模式 | `alwaysAllowBashPrefixes` |
 *
 * 多条用逗号分隔，参数也可重复传。**括号内的逗号不是分隔符**——
 * `Bash(npm run a,b)` 是一条，不是两条。
 *
 * ## 刻意不支持：`Read(src/**)`
 *
 * 参考实现里有按路径限定某个工具的写法，Bolo 这里**明确拒绝**。
 * 原因是本仓的 `alwaysAllowPathGlobs` 是**全局**的、不绑工具：把
 * `Read(src/**)` 翻成一条全局 path glob，会连 `Write` 对 `src/**` 也一并放行——
 * 用户没要的放宽，出现在权限代码里。要真支持得先把规则模型改成按工具分域，
 * 那是另一刀，且动的是安全关键的匹配器。在那之前，拒绝并说清楚。
 *
 * ## fail-closed
 *
 * 看不懂的规格一律硬失败，绝不「跳过看不懂的」：`--disallowed-tools`
 * 写错被静默丢弃 = **用户以为拦住了、实际没拦**，而且他手里正握着一份
 * 「我明明写了」的命令行。
 */
import type { SessionPermissionRules } from './index.ts'

export type ParseToolSpecsResult =
  | { ok: true; rules: SessionPermissionRules }
  | { ok: false; reason: string }

export type ParseToolSpecsInput = {
  /** `--allowed-tools` 的原始值（可重复传，每个可含逗号） */
  allow?: readonly string[]
  /** `--disallowed-tools` 的原始值 */
  deny?: readonly string[]
  /** 已有规则；不就地修改，返回合并后的新对象 */
  base?: SessionPermissionRules | null
}

/** 工具名：字母开头，后续字母数字下划线连字符（`mcp__srv__tool` 即此形） */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/

/**
 * 是否含控制字符（换行、回车、NUL……）。
 *
 * 按码点判，不写正则字面量：转义序列穿过多层引用会被吃掉，真控制字符会
 * 直接落进源码——本仓已为此单设了 test-no-stray-control-bytes 门禁。
 */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 32 || code === 127) return true
  }
  return false
}

/**
 * 顶层逗号切分：括号内的逗号原样保留。
 *
 * 括号不配对时返回 `null`，由调用方报错——这里不做「尽力而为」的容错，
 * 因为一个被截断的 Bash 模式看起来仍然像条规则，只是含义变了。
 */
function splitTopLevel(spec: string): string[] | null {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i]!
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth < 0) return null
    } else if (c === ',' && depth === 0) {
      out.push(spec.slice(start, i))
      start = i + 1
    }
  }
  if (depth !== 0) return null
  out.push(spec.slice(start))
  return out
}

function push(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value)
}

function cloneRules(base?: SessionPermissionRules | null): SessionPermissionRules {
  return {
    alwaysAllowToolNames: [...(base?.alwaysAllowToolNames ?? [])],
    ...(base?.alwaysAllowPrefixes
      ? { alwaysAllowPrefixes: [...base.alwaysAllowPrefixes] }
      : {}),
    ...(base?.alwaysAllowPathGlobs
      ? { alwaysAllowPathGlobs: [...base.alwaysAllowPathGlobs] }
      : {}),
    ...(base?.alwaysAllowBashPrefixes
      ? { alwaysAllowBashPrefixes: [...base.alwaysAllowBashPrefixes] }
      : {}),
    ...(base?.alwaysDenyToolNames
      ? { alwaysDenyToolNames: [...base.alwaysDenyToolNames] }
      : {}),
    ...(base?.alwaysDenyPrefixes
      ? { alwaysDenyPrefixes: [...base.alwaysDenyPrefixes] }
      : {}),
    ...(base?.alwaysDenyPathGlobs
      ? { alwaysDenyPathGlobs: [...base.alwaysDenyPathGlobs] }
      : {}),
    ...(base?.alwaysDenyBashPrefixes
      ? { alwaysDenyBashPrefixes: [...base.alwaysDenyBashPrefixes] }
      : {}),
  }
}

type Side = 'allow' | 'deny'

const FLAG: Record<Side, string> = {
  allow: '--allowed-tools',
  deny: '--disallowed-tools',
}

/** 报错必须能让人在自己的命令行里**原样找到**那一段，故带上未转义的原文 */
function fail(side: Side, spec: string, item: string, detail: string): string {
  const where = item === spec ? '' : ` (in ${JSON.stringify(item)})`
  return `${FLAG[side]}: ${detail}${where} — offending value: ${spec}`
}

function applyOne(
  rules: SessionPermissionRules,
  side: Side,
  spec: string,
  raw: string,
): string | null {
  const item = raw.trim()
  if (!item) {
    return fail(side, spec, spec, 'empty tool spec')
  }

  const open = item.indexOf('(')
  if (open >= 0) {
    if (!item.endsWith(')')) {
      return fail(side, spec, item, 'unbalanced parentheses')
    }
    const name = item.slice(0, open).trim()
    const arg = item.slice(open + 1, -1).trim()
    if (name !== 'Bash') {
      return fail(
        side,
        spec,
        item,
        name
          ? `only Bash takes a pattern in parentheses; ${name}(...) would have to ` +
              `become a global path rule that also covers other tools, which is wider ` +
              `than what you asked for. Use a bare tool name instead`
          : 'missing tool name before the parenthesis',
      )
    }
    if (!arg) {
      return fail(side, spec, item, 'empty Bash pattern')
    }
    const key = side === 'allow' ? 'alwaysAllowBashPrefixes' : 'alwaysDenyBashPrefixes'
    rules[key] ??= []
    push(rules[key]!, arg)
    return null
  }

  if (item.endsWith('*')) {
    const prefix = item.slice(0, -1)
    if (!prefix || !TOOL_NAME.test(prefix)) {
      return fail(
        side,
        spec,
        item,
        prefix
          ? 'a wildcard is only allowed at the end of a tool name'
          : 'a bare wildcard would mean every tool; use bypassPermissions if that is ' +
              'really what you want, so that it is visible in the mode rather than ' +
              'hidden in a tool list',
      )
    }
    const key = side === 'allow' ? 'alwaysAllowPrefixes' : 'alwaysDenyPrefixes'
    rules[key] ??= []
    push(rules[key]!, prefix)
    return null
  }

  if (!TOOL_NAME.test(item)) {
    return fail(side, spec, item, 'not a valid tool name')
  }
  if (side === 'allow') {
    push(rules.alwaysAllowToolNames, item)
  } else {
    rules.alwaysDenyToolNames ??= []
    push(rules.alwaysDenyToolNames, item)
  }
  return null
}

function applySide(
  rules: SessionPermissionRules,
  side: Side,
  specs: readonly string[],
): string | null {
  for (const spec of specs) {
    if (hasControlChars(spec)) {
      return fail(side, spec, spec, 'contains control characters')
    }
    const items = splitTopLevel(spec)
    if (!items) {
      return fail(side, spec, spec, 'unbalanced parentheses')
    }
    if (items.length === 0 || items.every((s) => !s.trim())) {
      return fail(side, spec, spec, 'empty tool spec')
    }
    for (const item of items) {
      const err = applyOne(rules, side, spec, item)
      if (err) return err
    }
  }
  return null
}

/**
 * 把命令行规格翻成权限规则。
 *
 * 传入的 `base` 不会被就地修改——权限规则会被会话内的「always allow」按钮
 * 继续追加，调用方手里那一份的所有权必须是清楚的。
 */
export function parseToolSpecs(input: ParseToolSpecsInput): ParseToolSpecsResult {
  const rules = cloneRules(input.base)
  const err =
    applySide(rules, 'allow', input.allow ?? []) ??
    applySide(rules, 'deny', input.deny ?? [])
  if (err) return { ok: false, reason: err }
  return { ok: true, rules }
}
