# Task Plan: Bolo Code

## Goal
兼容 OpenAI **Responses API 原生直连**；保留 Chat Completions。

## Next Step
OR1–OR5：`openaiResponses.ts` + fromEnv kind + 单测（SSE fixture）。  
参考：OpenAI 文档 + Codex `codex-api/src/endpoint/responses.rs` + `sse/responses.rs`（仅此）。

## Current Phase
docs: Responses plan — implement next

## Notes
- Electron 后置
- 不通读 Codex 全仓
- 不把 Responses 请求转成 Chat Completions 再发