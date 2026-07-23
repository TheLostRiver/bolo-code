# Agent Loop — 对照 HelsincyCode 实现

> **原则**：站在巨人肩膀上。管道与职责对齐参考，**不抄**遥测 / GrowthBook / feature 迷宫。  
> 参考逻辑模块：`query.ts`（queryLoop）、`query/deps.ts`、`services/tools/toolOrchestration.ts`、`services/tools/toolExecution.ts`。

## 1. 参考主循环（语义）

```
while true:
  messagesForQuery = project/compact 视图(messages)
  deps.microcompact(messagesForQuery)     // 可选，P1
  deps.autocompact(messagesForQuery)      // 阈值，P1 挂点
  stream = deps.callModel(messagesForQuery, tools, …)
  collect assistant text + tool_use blocks
  if no tool_use:
    Stop hooks → terminal completed
  else:
    runTools(tool_use blocks)             // 批：只读可并发 / 副作用串行
      每个 tool → runToolUse:
        find tool
        PreToolUse hooks
        permission (canUseTool / mode / hooks)
        execute
        PostToolUse hooks
        yield tool_result user message
    append results → messages
    continue loop (下一轮 callModel)
```

Bolo **P0** 对齐：

| 步骤 | 参考 | Bolo |
|------|------|------|
| 可注入 deps | `QueryDeps` | `packages/core/src/deps.ts` |
| 主 while 循环 | `queryLoop` | `packages/core/src/queryLoop.ts` |
| 调模型 | `deps.callModel` | `deps.callModel` ← provider.completeStream |
| 跑 tools | `runTools` | `toolOrchestration.ts`（v1 **全串行**） |
| 单 tool | `runToolUse` | `toolExecution.ts` |
| 结束 | stop hooks / terminal | Stop hooks + `Terminal` |
| micro/auto compact | deps | **挂点 no-op**，真逻辑见 COMPACTION.md |
| 遥测 logEvent | 遍地 | **不实现** |

## 2. 模块边界

```
submitPrompt / createSession     packages/core/index.ts   会话外壳
queryLoop                        packages/core/queryLoop.ts
runTools (serial)                packages/core/toolOrchestration.ts
runToolUse                       packages/core/toolExecution.ts
QueryDeps                        packages/core/deps.ts
HookBus                          packages/hooks
executeTool                      packages/tools
LlmProvider                      packages/providers
```

**禁止**：在 tool 实现里做 permission；在 renderer 里跑 loop。

## 3. Terminal 原因（对齐参考完成态，简化）

```ts
type TerminalReason =
  | 'completed'           // 无 tool，正常结束
  | 'max_turns'           // 达 maxTurns
  | 'aborted'             // 预留
  | 'user_prompt_blocked' // UserPromptSubmit exit 2
  | 'error'
```

## 4. 与旧 Bolo 代码差异

| 旧 | 新 |
|----|-----|
| `submitPrompt` 内联 for 循环 | 委托 `queryLoop` |
| `runOneTool` 塞在 index | 独立 `runToolUse`，顺序固定 |
| 无 deps | `productionDeps()` / 测试可注入 |
| compact 与 loop 混概念 | loop 内 `deps.prepareMessages` 预留；manual compact 仍走 `compactSession` |

## 5. 验收

- `npx tsx scripts/smoke-turn.ts` 仍绿  
- 代码路径可读：queryLoop → runTools → runToolUse  
- 文档本表与实现一致  

## 6. 明确不做（本切片）

- StreamingToolExecutor（流式边下发边跑 tool）  
- 只读 tool 并发批  
- reactive compact / context collapse / snip  
- logEvent / analytics  
- 完整 Message 类型系统（assistant content blocks 数组）— v1 仍用简化 ChatMessage  

后续接 PermissionMode 时，只改 `runToolUse` 内 permission 段，不改 loop 骨架。