# Tool Calling — 对照参考实现语义

> 目标：对齐 Tool / toolExecution / toolOrchestration 语义。  
> **不抄**遥测 / logEvent。

## 1. 已对齐

| 语义 | Bolo |
|------|------|
| `buildTool` + 安全默认 | `packages/tools/src/types.ts` `buildTool` |
| `inputSchema` / JSON Schema | `inputJSONSchema` + `validateAgainstJsonSchema` |
| `isConcurrencySafe` / `isReadOnly` | 每工具声明；默认 fail-closed |
| `checkPermissions` 工具级 | 有默认 + 可覆盖 |
| `runToolUse` 顺序 | find → schema → validate → Pre → Gate → call → **truncate** → Post |
| 未知工具 / 校验错误 | `<tool_use_error>…</tool_use_error>`（对模型友好） |
| `partitionToolCalls` | 只读批并发、写串行 |
| Glob / Grep 真实现 | `createGlobTool` / `createGrepTool` |
| Skill 按需 | `Skill` 工具 + catalog |
| **Edit** | `old_string` / `new_string`；默认**唯一**匹配；`replace_all` 可选；清晰错误 |
| Write | 全文写入；`resolveSafe` 不逃出 cwd |
| apply_patch | `*** Begin Patch` / Add\|Update\|Delete，或简易 unified diff |
| AbortSignal | Bash / Read / Write / Edit / apply_patch 尊重中段 abort → `Error: tool cancelled` |
| tool_result 字符预算 | 默认 50_000；截断 + 可选 spill |

## 2. 管道

```
tool_use block
  → findToolByName (else tool_use_error)
  → validateAgainstJsonSchema
  → validateInput?
  → PreToolUse hooks
  → decidePermission(mode, rules?, input, cwd) + tool.checkPermissions
  → PermissionRequest hooks / UI if ask（a = session always-allow 工具名）
  → tool.call(signal?)
  → truncate tool_result if over maxToolResultChars
  → PostToolUse hooks
  → role:tool message
```

## 3. 并发策略

```
Read, Glob, Grep, Skill           → isConcurrencySafe true  → 连续批 Promise.all
Bash, Write, Edit, apply_patch    → false → 串行
```

## 4. 编辑类工具怎么选

| 工具 | 场景 |
|------|------|
| **Edit** | 小范围精确替换（唯一 old_string；或 `replace_all`） |
| **Write** | 整文件重写 / 新建 |
| **apply_patch** | 多文件 / 多 hunk 补丁 |

Edit 失败形态（示例）：

- `old_string not found`  
- `matched N times … expected unique match`  
- `file not found` / `path escapes cwd`  

## 5. 仍未对齐（有意后置）

- 完整 zod 与复杂 schema  
- StreamingToolExecutor（边流边跑）  
- 完整 permission 分类器  
- UI renderToolResult  

## 6. 测试

```bash
npx tsx scripts/test-tool-calling.ts
npx tsx scripts/test-permissions.ts
npx tsx scripts/smoke-turn.ts
```

## 7. 扩展新工具

```ts
import { buildTool } from '@bolo/tools'

export const MyTool = buildTool({
  name: 'MyTool',
  description: '...',
  requiresPermission: true,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  inputJSONSchema: {
    type: 'object',
    properties: { x: { type: 'string' } },
    required: ['x'],
  },
  async call(input, ctx) {
    return { ok: true, output: String(input.x) }
  },
})
```

把工具加入 `createBuiltinTools()` 或会话 `tools` 覆盖列表即可。