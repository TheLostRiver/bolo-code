# Agent Loop — 对照 HelsincyCode 实现

> **原则**：站在巨人肩膀上。管道与职责对齐参考，**不抄**遥测 / GrowthBook / feature 迷宫。  
> 参考逻辑模块：`query.ts`（queryLoop）、`query/deps.ts`、`services/api/withRetry`、`services/tools/toolOrchestration.ts`、`services/tools/toolExecution.ts`。

## 1. 参考主循环（语义）

```
while true:
  messagesForQuery = project/compact 视图(messages)
  deps.prepareMessages:          // 默认
    microcompact                 // 清旧 tool_result（无 LLM）
    autocompact if needed        // 阈值 → full compact
  stream = deps.callModel(messagesForQuery, tools, …)
    // callModel 默认经 wrapCallModelWithRetry：
    //   429/5xx/timeout/network → 有限指数退避重试（默认 3）
    //   user_abort → 不重试
    //   PTL / 4xx 鉴权等 → 不退避（PTL 见下）
  if PTL error and attempts < maxPtlRetries:
    truncateHeadForPtlRetry(session.messages)  // 丢最旧 API 轮次
    re-prepare → retry callModel（不计额外 maxTurns）
  collect assistant text + tool_use blocks
  if no tool_use:
    Stop hooks → terminal completed
  else:
    runTools(tool_use blocks)             // 批：只读可并发 / 副作用串行
      每个 tool → runToolUse:
        find tool
        PreToolUse hooks
        permission (canUseTool / mode / hooks)
        execute（尊重 AbortSignal；Bash 支持 timeout）
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
| **错误分类** | withRetry / errors | `packages/core/src/errorClassify.ts`：`retryable` / `fatal` / `user_abort` |
| **模型退避重试** | `withRetry` | `wrapCallModelWithRetry`（默认 3 次、指数退避；`productionDeps` 默认包装） |
| **系统提示词** | `getSystemPrompt` + query 前缀 | **`systemPromptSections` + `prepareModelMessages`**（见 `docs/SYSTEM_PROMPT.md`） |
| 跑 tools | `runTools` | `toolOrchestration.ts`（**分区并发**：连续只读可并发，副作用串行） |
| 单 tool | `runToolUse` | `toolExecution.ts` |
| 结束 | stop hooks / terminal | Stop hooks + `Terminal` |
| micro compact | `microcompactMessages` | `createMicrocompactPrepare`（默认开） |
| auto compact | `autoCompactIfNeeded` | `createAutoCompactPrepare`（需开关+summarizer） |
| PTL 重试 | compact 内 `truncateHeadForPTLRetry` | `isPromptTooLongError` + `truncateHeadForPtlRetry`；`maxPtlRetries` 默认 3 |
| 遥测 logEvent | 遍地 | **不实现** |

## 2. 错误分类与两套重试（勿混）

| 路径 | 触发 | 行为 | 事件 |
|------|------|------|------|
| **Model retry** | 429 / 5xx / 408 / 超时 / 网络 | `wrapCallModelWithRetry` 整次重拉；默认最多 3 次退避 | `model_retry`（attempt / delayMs / reason） |
| **PTL retry** | 上下文过长（413 / prompt too long 等） | 分类为 **fatal**（不进 model 退避）；`queryLoop` 截断最旧轮次再 `prepare` + `callModel` | `ptl_retry` |
| **user_abort** | `AbortSignal` / AbortError | **不重试**；terminal `aborted` | — |
| **fatal** | 401/403/400 等 | 立即 `error` 终态 | `error` |

要点：

- PTL **故意**不走 HTTP 退避：需要改消息集合，不是同一请求重发。
- Model retry 仅在**尚未产出** text/tool 内容时生效，避免重复 tool_use。
- 可关：`createCallModelFromProvider(provider, false)` 或 `maxRetries: 0`。

## 3. 模块边界

```
submitPrompt / createSession     packages/core/index.ts   会话外壳
queryLoop                        packages/core/queryLoop.ts
errorClassify / modelRetry       packages/core/errorClassify.ts · modelRetry.ts
runTools (partition)             packages/core/toolOrchestration.ts
runToolUse                       packages/core/toolExecution.ts
QueryDeps                        packages/core/deps.ts
HookBus                          packages/hooks
executeTool                      packages/tools
LlmProvider                      packages/providers
```

**禁止**：在 tool 实现里做 permission；在 renderer 里跑 loop。

## 4. Terminal 原因（对齐参考完成态，简化）

```ts
type TerminalReason =
  | 'completed'           // 无 tool，正常结束
  | 'max_turns'           // 达 maxTurns
  | 'aborted'             // 用户 AbortSignal
  | 'user_prompt_blocked' // UserPromptSubmit exit 2
  | 'error'
```

## 5. 与旧 Bolo 代码差异

| 旧 | 新 |
|----|-----|
| `submitPrompt` 内联 for 循环 | 委托 `queryLoop` |
| `runOneTool` 塞在 index | 独立 `runToolUse`，顺序固定 |
| 无 deps | `productionDeps()` / 测试可注入 |
| 仅 PTL 截断重试 | + 统一错误分类 + model 退避重试 |
| 文档写「tool 全串行」 | 代码为**分区并发**（只读批并发） |
| compact 与 loop 混概念 | loop 内 `deps.prepareMessages`；manual compact 仍走 `compactSession` |

## 6. 验收

- `npx tsx scripts/smoke-turn.ts` 仍绿  
- `npx tsx scripts/test-model-retry.ts`：429→成功、abort 不重试、PTL 不进 model retry  
- `npx tsx scripts/test-ptl-retry.ts` 仍绿  
- 代码路径可读：queryLoop →（retry 包装）callModel → runTools → runToolUse  
- 文档本表与实现一致  

## 7. 明确不做（本切片 / 后置）

- StreamingToolExecutor（流式边下发边跑 tool）  
- 遥测 / GrowthBook / 无限 unattended 429  
- reactive compact / context collapse / snip  
- 完整 Message 类型系统（assistant content blocks 数组）— v1 仍用简化 ChatMessage  

后续 **Tool+Permission 日用** 加深时，优先改 `runToolUse` 内 permission 段与常用工具契约，不改 loop 骨架。