# Progress Log

## Session: OpenAI Responses native provider

- `packages/providers/src/openaiResponses.ts`：HTTP SSE 直连 `/responses`
- toResponsesPayload / toolsToResponses / processResponsesSseJson
- fromEnv：`openai-responses` | `responses`；config kind 扩展
- test-provider-unit：Responses 映射 + SSE fixture PASS
- 对照 Codex 仅 responses 事件名；未通读全仓

## Prior

docs plan `70854f3`；usage/effort/fork/always-allow 等已在 main