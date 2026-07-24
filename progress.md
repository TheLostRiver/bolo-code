# Progress Log

## Session: OpenAI Responses 决策

- 确认现状：仅 Chat Completions（`openai-compatible`），无 Responses
- 产品目标：增加 **Responses 原生直连** 适配器（不伪装成 Completions）
- Codex（本地树）：**定点**读 `codex-rs/codex-api` 的 responses HTTP+SSE；禁止通读全仓
- 文档：`PROVIDERS.md` OR0–OR6；`TODO.md` 下一刀指向 OR*

## Prior main tip

见 git log（usage/effort/fork/always-allow 等已在 main）