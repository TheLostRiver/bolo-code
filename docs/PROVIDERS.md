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

### OpenAI

- `POST {base}/chat/completions`
- `Authorization: Bearer …`
- `tools` / `tool_calls` / role `tool`

### Anthropic（对照 HC 流式事件）

- `POST {base}/v1/messages`
- `x-api-key` + `anthropic-version: 2023-06-01`
- `system` 独立字段
- tools：`input_schema`
- 流式：`content_block_start` / `content_block_delta`（`text_delta` / `input_json_delta`）/ `message_stop`
- tool 结果：下一条 `user` 的 `tool_result` blocks

内部统一为 Bolo `ProviderStreamEvent`（`text_delta` | `tool_call` | `done` | `error`），agent loop 无需关心协议。

## 代码

| 文件 | 职责 |
|------|------|
| `openaiCompatible.ts` | OpenAI 流 |
| `anthropic.ts` | Anthropic Messages 流 |
| `fromEnv.ts` | 装配 / 推断 |
| `compactSummarizer.ts` | 无 tools 摘要（两协议通用） |

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