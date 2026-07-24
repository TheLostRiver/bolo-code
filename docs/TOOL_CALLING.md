# Tool Calling — 对照 HelsincyCode

> 目标：站在 HC `Tool.ts` / `toolExecution` / `toolOrchestration` 肩膀上。  
> **不抄**遥测 / logEvent。

## 1. 已对齐

| HC | Bolo |
|----|------|
| `buildTool` + 安全默认 | `packages/tools/src/types.ts` `buildTool` |
| `inputSchema` / JSON Schema | `inputJSONSchema` + `validateAgainstJsonSchema` |
| `isConcurrencySafe` / `isReadOnly` | 每工具声明；默认 fail-closed |
| `checkPermissions` 工具级 | 有默认 + 可覆盖 |
| `runToolUse` 顺序 | find → schema → validate → Pre → Gate → call → Post |
| 未知工具 / 校验错误 | `<tool_use_error>…</tool_use_error>` |
| `partitionToolCalls` | 只读批并发、写串行 |
| Glob / Grep 真实现 | `createGlobTool` / `createGrepTool` |
| Skill 按需 | `Skill` 工具 + catalog |
| apply_patch | 真补丁：`*** Begin Patch` / Add|Update|Delete File，或简易 unified diff；`resolveSafe` 不逃出 cwd |

## 2. 管道

```
tool_use block
  → findToolByName (else tool_use_error)
  → validateAgainstJsonSchema
  → validateInput?
  → PreToolUse hooks
  → decidePermission(mode) + tool.checkPermissions
  → PermissionRequest hooks / UI if ask
  → tool.call
  → PostToolUse hooks
  → role:tool message
```

## 3. 并发策略

```
Read, Glob, Grep, Skill  → isConcurrencySafe true  → 连续批 Promise.all
Bash, Write, apply_patch → false → 串行
```

## 4. 仍未对齐（有意后置）

- 完整 zod 与复杂 schema  
- StreamingToolExecutor（边流边跑）  
- maxResultSizeChars 落盘预览  
- MCP 真 call 注册进同一 Tools 列表  
- UI renderToolResult  

## 5. 测试

```bash
npx tsx scripts/test-tool-calling.ts
npx tsx scripts/smoke-turn.ts
```

## 6. 扩展新工具

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