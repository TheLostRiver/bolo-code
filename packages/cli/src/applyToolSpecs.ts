/**
 * 把 `--allowed-tools` / `--disallowed-tools` 并入一个已建好的会话
 *
 * 为什么在会话**建好之后**并、而不是在创建时传：
 *
 * `--resume` 会从快照里恢复上次的 always-allow 规则（用户按过的「总是允许」）。
 * 若在创建时传入，命令行这一份会替掉快照那一份，用户会发现自己上次点的允许
 * 无故失效。并到已建好的会话上，两份**叠加**——这也是 `parseToolSpecs`
 * 收 `base` 的原因。
 *
 * 解析失败此处仍然抛：`main.ts` 已在开会话前先验过一遍（好错误信息、
 * 早退出），这里是第二道，防的是将来有人绕开 main 直接调 CLI 入口。
 */
import {
  parseToolSpecs,
  type ParseToolSpecsResult,
} from '../../permissions/src/toolSpec.ts'
import type { SessionPermissionRules } from '../../permissions/src/index.ts'

export type ToolSpecCliArgs = {
  allowedTools?: readonly string[]
  disallowedTools?: readonly string[]
}

/** 命令行是否提到过工具规格（没提就一个字节都不该改） */
export function hasToolSpecs(args: ToolSpecCliArgs): boolean {
  return Boolean(args.allowedTools?.length || args.disallowedTools?.length)
}

/** 只校验、不落地：供 main.ts 在开会话之前 fail fast */
export function validateToolSpecs(args: ToolSpecCliArgs): ParseToolSpecsResult {
  return parseToolSpecs({
    ...(args.allowedTools ? { allow: args.allowedTools } : {}),
    ...(args.disallowedTools ? { deny: args.disallowedTools } : {}),
  })
}

/**
 * 并入会话的权限规则。解析失败抛错——**不能吞**：
 * 一条被悄悄丢掉的 `--disallowed-tools` 会让用户以为拦住了，实际没拦。
 */
export function applyToolSpecsToSession(
  session: { permissionRules: SessionPermissionRules },
  args: ToolSpecCliArgs,
): void {
  if (!hasToolSpecs(args)) return
  const r = parseToolSpecs({
    ...(args.allowedTools ? { allow: args.allowedTools } : {}),
    ...(args.disallowedTools ? { deny: args.disallowedTools } : {}),
    base: session.permissionRules,
  })
  if (!r.ok) throw new Error(r.reason)
  session.permissionRules = r.rules
}
