# Provider 配置

同时支持两种协议：

| kind | 协议 | 默认 base |
|------|------|-----------|
| `openai-compatible` | OpenAI Chat Completions + SSE | `https://api.openai.com/v1` |
| `anthropic` | Anthropic Messages + SSE（对照 HelsincyCode 事件） | `https://api.anthropic.com` |
| `mock` | 本地假数据 | — |

## 环境变量

### 通用

| 变量 | 说明 |
|------|------|
| `BOLO_PROVIDER` | `mock` \| `openai-compatible` \| `openai` \| `anthropic` \| `claude` |
| `BOLO_API_KEY` | 通用 key（两协议都可回落用） |
| `BOLO_BASE_URL` | 通用 base |
| `BOLO_MODEL` | 通用 model |

### OpenAI 兼容

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | 优先于 BOLO_API_KEY（openai 模式） |
| `OPENAI_BASE_URL` | |
| `OPENAI_MODEL` | 默认 `gpt-4o-mini` |

### Anthropic 原生

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | 有则默认推断为 anthropic（若未设 BOLO_PROVIDER） |
| `ANTHROPIC_BASE_URL` | 默认 `https://api.anthropic.com`（代码会补 `/v1`） |
| `ANTHROPIC_MODEL` | 默认 `claude-sonnet-4-20250514` |

### 推断顺序

1. `BOLO_PROVIDER` 显式  
2. 有 `ANTHROPIC_API_KEY` → anthropic  
3. 有 `OPENAI_API_KEY` 或 `BOLO_API_KEY` → openai-compatible  
4. 否则 mock  

## `~/.bolo/config.json`

```json
{
  "version": 1,
  "provider": {
    "kind": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "maxTokens": 8192
  },
  "permissionMode": "default"
}
```

或 OpenAI：

```json
{
  "provider": {
    "kind": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  }
}
```

**Key 建议用环境变量**，不要提交进项目配置。

## 协议要点

### OpenAI 系：两条协议（现状 + 目标）

| 协议 | 端点（典型） | Bolo 现状 | 配置 kind（目标） |
|------|----------------|-----------|-------------------|
| **Chat Completions** | `POST {base}/chat/completions` | **已支持** | `openai-compatible` |
| **Responses API（原生）** | `POST {base}/responses`（SSE；可选 WS） | **已支持** HTTP SSE | `openai-responses` |

#### Chat Completions（现有）

- `Authorization: Bearer …`
- `tools` / `tool_calls` / role `tool`
- 流：`data: {choices[0].delta…}` + 可选 `stream_options.include_usage`
- 实现：`openaiCompatible.ts`

#### Responses API（HTTP SSE 直连）

- 实现：`openaiResponses.ts`；`POST {base}/responses`，`Authorization: Bearer`
- `system` → `instructions`；对话/tools → `input`（`function_call` / `function_call_output`）
- 流：`response.output_text.delta`、`response.output_item.done`（function_call）、`response.completed` / `failed`
- effort → `max_output_tokens`（同 `mapEffort`）
- 默认 `store: false`（会话自管 transcript）
- 环境：`BOLO_PROVIDER=openai-responses` 或 `responses`；key/base/model 与 Completions 共用 `OPENAI_*` / `BOLO_*`

```json
{
  "provider": {
    "kind": "openai-responses",
    "model": "gpt-4o",
    "baseUrl": "https://api.openai.com/v1"
  }
}
```

```bash
set BOLO_PROVIDER=openai-responses
set OPENAI_API_KEY=sk-...
npx tsx scripts/smoke-live.ts
```

#### Chat Completions（现有）

- 实现：`openaiCompatible.ts`（上文 OpenAI 系表）

### Anthropic（对照 HC 流式事件）

- `POST {base}/v1/messages`
- `x-api-key` + `anthropic-version: 2023-06-01`
- `system` 独立字段（**文本块数组**；稳定段带 `cache_control: { type: 'ephemeral' }`）
- tools：`input_schema`；可选 **末项** `cache_control`
- messages：可选 **最后一条** 末 content 块 `cache_control`（每请求一个消息级断点）
- 流式：`content_block_start` / `content_block_delta`（`text_delta` / `input_json_delta`）/ `message_stop`
- tool 结果：下一条 `user` 的 `tool_result` blocks
- 实现：`anthropic.ts` + `promptCache.ts`；`buildAnthropicRequestBody`

### Prompt cache 字段（C5）

| Provider | 字段 | 默认 |
|----------|------|------|
| Anthropic | `cache_control` on system / tools / last message | 开；`enablePromptCaching: false` 关 |
| OpenAI Chat Completions | `prompt_cache_key` | 由 model + system 稳定前缀派生 |
| OpenAI Responses | `prompt_cache_key` | 同上 |
| 兼容网关 | 可能忽略 key | 仍靠 core 前缀稳定 |

详见 `docs/PROMPT_CACHE.md`。

内部统一为 Bolo `ProviderStreamEvent`（`text_delta` | `tool_call` | `usage` | `done` | `error`），agent loop 无需关心协议。

### Usage 事件（若 API 有）

- OpenAI-compatible：请求带 `stream_options.include_usage`；SSE 末包 `usage.prompt_tokens` / `completion_tokens` → `yield { type:'usage' }`；无则 queryLoop 用 chars/4 估算。
- Anthropic：`message_start` / `message_delta` 的 `usage` 合并后 yield；无则同样回落估算。

### Effort → max_tokens

`session.effortLevel`（`/effort`）经 `callModel` → `completeStream({ effort })` → `mapEffort`：`low` 较小、`high`/`max` 较大、`auto`/缺省用配置默认 `maxTokens`（默认 8192）。仅映射输出上限，非 thinking budget。

## 代码

| 文件 | 职责 |
|------|------|
| `openaiCompatible.ts` | Chat Completions 流 + usage + `prompt_cache_key` |
| `openaiResponses.ts` | Responses HTTP SSE 直连 + `prompt_cache_key` |
| `anthropic.ts` | Anthropic Messages 流 + usage + `cache_control` |
| `promptCache.ts` | cache_control / system 分块 / key 派生 |
| `sseUsage.ts` | 解析/合并 SSE usage 片段 |
| `effort.ts` | `mapEffort` → maxTokens |
| `fromEnv.ts` | 装配 / 推断 |
| `compactSummarizer.ts` | 无 tools 摘要（各协议通用） |

## 参考 Codex？

**需要，但是定点参考，禁止通读全仓。**

Codex 树体量极大（Rust monorepo + TUI + sandbox…）。对 Bolo 有价值的是 **API 协议层**，不是 CLI/TUI/沙箱。

| 建议读的范围（示意路径） | 用途 |
|--------------------------|------|
| `codex-rs/codex-api/src/endpoint/responses.rs` | HTTP Responses 请求怎么发 |
| `codex-rs/codex-api/src/sse/responses.rs` | SSE 事件名与解析 |
| `codex-rs/codex-api/src/requests/responses*` / `common` 中的 `ResponsesApiRequest` | 请求体字段 |
| （可选）`endpoint/responses_websocket.rs` | 仅当以后做 WS；第一刀不做 |

**不必读：** TUI、exec sandbox、app-server 全量、marketplace、telemetry 全家桶。

**也可并列：** OpenAI 官方 Responses 文档 + 一份真实 SSE 抓包；Codex 用于「事件形状/边界情况」对照，不是唯一真源。

实现原则与 HC 相同：**对照协议模块 → 在 Bolo 用 TS/fetch 重写** → 输出仍进 `LlmProvider.completeStream`。

## 命令

```bash
npx tsx scripts/test-provider-unit.ts
npx tsx scripts/smoke-turn.ts

# OpenAI
set BOLO_PROVIDER=openai-compatible
set OPENAI_API_KEY=sk-...
npx tsx scripts/smoke-live.ts

# Anthropic
set BOLO_PROVIDER=anthropic
set ANTHROPIC_API_KEY=sk-ant-...
npx tsx scripts/smoke-live.ts
```

## 不做

- 遥测  
- 密钥入库  
- Anthropic SDK 依赖（纯 fetch，易控）  
- **把 Responses 伪装成 Chat Completions 再请求**（原生 Responses 供应商应走直连适配器）  
- 为兼容 Responses **通读** Codex 全仓库  

## 路线：OpenAI Responses 直连（P1 协议）

| ID | 切片 | 状态 |
|----|------|------|
| OR0 | 文档/契约（本文 + TODO） | ✅ |
| OR1 | `openaiResponses.ts`：request 映射 + SSE 解析 → `ProviderStreamEvent` | ✅ |
| OR2 | tools / function_call 往返 | ✅ |
| OR3 | usage + effort→max_output_tokens | ✅ |
| OR4 | `fromEnv` / config `kind: openai-responses` | ✅ |
| OR5 | 单测（fixture SSE，无真 key） | ✅ |
| OR6 | Responses WebSocket | ⬜ 后置 |