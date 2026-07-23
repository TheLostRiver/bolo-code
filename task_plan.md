# Task Plan: Bolo Code

## Goal
Tool calling 对齐 HC：buildTool / schema / partition / 真 Glob·Grep；provider schema 单源。

## Next Step
M2 compact auto-hooks + real summarizer；或 MCP 真连接；有 key 时 smoke-live。

## Current Phase
tool-calling align — complete

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
- [x] provider 转发 `providerSchema`（去掉双份 defaultToolParameters）
- [x] `scripts/test-tool-calling.ts` PASS
- **Status:** complete