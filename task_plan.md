# Task Plan: Bolo Code

## Goal
系统提示词中心组装 + BOLO.md 加载；session/queryLoop 以 system 为一等公民。

## Next Step
M2 compact auto-hooks + real summarizer；或 MCP 真连接；有 key 时 smoke-live。

## Current Phase
system-prompt + BOLO.md — complete

## Phases

### Phase dual-provider [complete]
- [x] openai-compatible
- [x] anthropic Messages
- [x] fromEnv / config kind
- **Status:** complete

### Phase tool-calling [complete]
- [x] `buildTool` + fail-closed defaults
- [x] `inputJSONSchema` + validate
- [x] `runToolUse` 顺序对齐 HC
- [x] `partitionToolCalls` 只读并发 / 写串行
- [x] Glob/Grep 真实现（`**/` 匹配 0+ 层）
- [x] provider 转发 `providerSchema`
- [x] `scripts/test-tool-calling.ts` PASS
- **Status:** complete

### Phase system-prompt [complete]
- [x] `packages/core/src/systemPrompt.ts`：loadBoloMd / getSystemPrompt / buildEffective / prepareModelMessages
- [x] `session.systemPromptSections` + queryLoop 每轮前缀
- [x] createSessionFromWorkspace 统一组装（不再只 unshift catalog）
- [x] `docs/SYSTEM_PROMPT.md` + CONFIG / ROADMAP
- [x] `scripts/test-system-prompt.ts`
- **Status:** complete