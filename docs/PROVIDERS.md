# Provider 配置

> **便利层（接通 / 少 400 / resume 粘性 / 错误解释）：** 见 **[PROVIDER_UX.md](./PROVIDER_UX.md)**（CX 轨规格）。  
> **Effort 方言：** [EFFORT.md](./EFFORT.md) · [EFFORT_OPTIMIZATION.md](./EFFORT_OPTIMIZATION.md)（E0–E9 已落地）。

同时支持的协议：

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
    "contextWindowTokens": 200000,
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
    "model": "gpt-4o-mini",
    "contextWindowTokens": 128000,
    "maxTokens": 16384
  }
}
```

**Key 建议用环境变量**，不要提交进项目配置。

## 模型上下文元数据

provider 可以定义 `contextWindowTokens` / `maxTokens` 默认值，并用 `models` 对完整
model id 做逐字段覆盖。user/project 合并时，provider 普通字段后写覆盖，`models`
则按 model id 和字段深合并：

```jsonc
{
  "providers": {
    "work": {
      "kind": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o",
      "contextWindowTokens": 128000,
      "maxTokens": 8192,
      "models": {
        "gpt-4o": {
          "contextWindowTokens": 128000,
          "maxTokens": 16384
        },
        "proxy-200k": {
          "contextWindowTokens": 200000,
          "maxTokens": 32768
        }
      }
    }
  }
}
```

解析按字段独立进行：exact model override → provider default → built-in catalog →
legacy/session fallback → 128k/8k fallback。legacy 顶层 `contextWindowTokens` 只适用于
context；session snapshot 仅在 provider/model identity 匹配且当前配置/catalog 没有
该字段时使用。非法值被忽略并产生 warning，`maxTokens` 不能超过有效 context。

`/context`、`/doctor`、`/model`、`/provider list/use`、CLI dashboard 与 Desktop
使用同一共享 view。输出会把来源标为 `model override`、`provider default`、
`built-in catalog`、`legacy config`、`session snapshot` 或 `fallback`。未知模型不会
被猜成已知模型；未显式配置时仍可运行，但会清楚显示 `WARNING` 和 fallback 原因。

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
- 流式：`content_block_start` / `content_block_delta`（`text_delta` / `thinking_delta` / `input_json_delta`）/ `message_stop`
- tool 结果：下一条 `user` 的 `tool_result` blocks
- 实现：`anthropic.ts` + `promptCache.ts`；`buildAnthropicRequestBody`

### 思考链 / Reasoning（流式显示）

对照 HC（thinking / redacted_thinking / thinking_delta）与 OpenCode openai-compatible 的 `reasoning_content`：**只解析与展示，不伪造**。

| 来源 | SSE / 字段 | Provider 事件 | SessionEvent | CLI |
|------|------------|---------------|--------------|-----|
| OpenAI-compatible（DeepSeek 等） | `delta.reasoning_content` | `reasoning_delta` | `reasoning` | dim + 前缀 `thinking` |
| Anthropic | `content_block` type `thinking` + `thinking_delta` | `reasoning_delta`（可选 `reasoning_end`） | 同上 | 同上 |
| Anthropic | `redacted_thinking` | 单次占位 `[redacted thinking]` | 同上 | 同上 |
| openai-responses | `response.reasoning.delta` / `reasoning_text` / `reasoning_summary_text` 等 | `reasoning_delta`（切到正文时 `reasoning_end`） | 同上 | 同上 |
| 无字段 / 不支持 | — | **不发** | **不发** | 零输出 |

- 内部类型：`ProviderStreamEvent` 含 `reasoning_delta` | `reasoning_end`
- 显示：`session.showThinking` + `/thinking on|off`（默认 **on**）；**off 时仍解析并转发事件，CLI 不渲染**
- **可选回灌（RC3）：** `/thinking persist on` → 本轮 reasoning 写入 `assistant.reasoning_content`；`toOpenAIMessages` 回灌 openai-compatible（DeepSeek 等）。默认 **off**。**勿**用于 Anthropic 签名 thinking 块。
- **请求侧 Anthropic thinking（RC3 最小）：** `CompleteStreamOptions.anthropicThinking` → `thinking: { type:'enabled', budget_tokens }`（budget < max_tokens）；未接 slash 时可由 env/provider 配置后置
- openai-responses：HTTP SSE 已解析 reasoning 相关 delta；WS：**后置**

### Prompt cache 字段（C5）

| Provider | 字段 | 默认 |
|----------|------|------|
| Anthropic | `cache_control` on system / tools / last message | 开；`enablePromptCaching: false` 关 |
| OpenAI Chat Completions | `prompt_cache_key` | 由 model + system 稳定前缀派生 |
| OpenAI Responses | `prompt_cache_key` | 同上 |
| 兼容网关 | 可能忽略 key | 仍靠 core 前缀稳定 |

详见 `docs/PROMPT_CACHE.md`。

内部统一为 Bolo `ProviderStreamEvent`（`text_delta` | `reasoning_delta` | `reasoning_end` | `tool_call` | `usage` | `done` | `error`），agent loop 无需关心协议。

### Usage 事件（若 API 有）

- OpenAI-compatible：请求带 `stream_options.include_usage`；SSE 末包 `usage.prompt_tokens` / `completion_tokens` → `yield { type:'usage' }`；可选 `prompt_tokens_details.cached_tokens` → `cacheReadInputTokens`；无则 queryLoop 用 chars/4 估算。
- Anthropic：`message_start` / `message_delta` 的 `usage` 合并后 yield；解析 `cache_read_input_tokens` / `cache_creation_input_tokens`。
- OpenAI Responses：`usage.input_tokens_details.cached_tokens` → `cacheReadInputTokens`。
- 会话侧：`session.usage` 累加总量 + cache + **by model**；`/cost` 本地展示（Usage+）；**无遥测**。

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

## 路线：OpenAI Responses 直连（协议 · 已收口）

| ID | 切片 | 状态 |
|----|------|------|
| OR0 | 文档/契约（本文 + TODO） | ✅ |
| OR1 | `openaiResponses.ts`：request 映射 + SSE 解析 → `ProviderStreamEvent` | ✅ |
| OR2 | tools / function_call 往返 | ✅ |
| OR3 | usage + effort→max_output_tokens | ✅ |
| OR4 | `fromEnv` / config `kind: openai-responses` | ✅ |
| OR5 | 单测（fixture SSE，无真 key） | ✅ |
| OR6 | Responses WebSocket | ⬜ 后置 |

## 路线：多 Provider 并存 + 运行时热切（**P 轨 · P0–P4 日用已闭环**）

> 总规划见 [ROADMAP.md §9](./ROADMAP.md)。**痛点：** 旧仅单 `provider`；`/model` 只改模型名。  
> **现状：** `providers` 表 + `/provider use` 热切；旧 `provider` 仍兼容。

| ID | 切片 | 状态 |
|----|------|------|
| **P0** | 规格（ROADMAP §9 + 本文） | ✅ |
| **P1** | `providers` + `defaultProvider` 加载；旧 `provider` 兼容 | ✅ |
| **P2** | `switchSessionProvider` + `/provider` list/use | ✅ |
| **P3** | `/model` 增强 · cache-break · `/doctor` | ✅ |
| **P4** | 单测 · CLI 摘要 · 缺 key 错误 | ✅ |
| **P4.1** | TTY `/provider` 箭头选择器热切（不必记 id） | ✅ |
| **P5 / CX7** | Desktop 选 active · list/add/use IPC | ✅ |

配置示例：

```jsonc
{
  "defaultProvider": "work",
  "providers": {
    "work": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini",
      "apiKeyEnv": "OPENAI_API_KEY",
      "contextWindowTokens": 128000,
      "maxTokens": 16384
    },
    "deepseek": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-chat",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "contextWindowTokens": 128000,
      "maxTokens": 8192
    }
  }
}
```

**Slash：**

| 命令 | 行为 |
|------|------|
| `/provider` | **TTY**：箭头列表选后端并热切（不必记 id）；非 TTY / `BOLO_PROVIDER_PANEL=0`：文本列表 |
| `/provider list` | 仅文本列表（不开 picker）；每项显示 ctx/out 与来源 |
| `/provider use <id> [model]` | 精确热切；成功结果显示新 ctx/out 与来源；缺 key **拒绝**并保留旧后端 |
| `/provider add <preset> [as <id>]` | **CX1**：写入 `config.providers`（仅 `apiKeyEnv`，无明文 key）；`add list` 列 preset |
| `/model` | 显示 model + providerId + kind + ctx/out 与来源 |
| `/model <name>` | 仅改当前后端 model（本地 cache-break），同时重新解析并显示 metadata |
| `/model <id>/<name>` | 切后端并设 model |

**CLI 环境：**

| 变量 | 说明 |
|------|------|
| `BOLO_PROVIDER_PANEL=0` | 禁用 `/provider` 交互选择器 |
| `BOLO_EFFORT_PANEL=0` | 禁用 `/effort` 交互选择器 |
| `BOLO_ARROW_PICKER=0` | 禁用全部箭头 picker |
| `BOLO_EFFORT_LOOSE=1` | `/effort` 允许 fold 别名（非 choosable 严格模式） |
| `BOLO_EFFORT_ALLOW_MAX=1` | 放开 Anthropic max 模型门控 |

**实现入口：**

| 模块 | 职责 |
|------|------|
| `packages/config/src/providerRegistry.ts` | 归一化 `providers` / 旧 `provider` |
| `packages/config/src/providerPresets.ts` | **CX1** 内置 preset 表 |
| `packages/config/src/addProviderProfile.ts` | **CX1** 写入 config.json |
| `packages/providers/src/fromEnv.ts` | `createProviderFromProfile` · `apiKeyEnv` |
| `packages/providers/src/providerErrors.ts` | **CX3** `explainProviderError` |
| `packages/core/src/sessionProvider.ts` | `switchSessionProvider` · picker items · **effort clamp** |
| `packages/core/src/effortClamp.ts` | **CX6** `clampEffortForSession` |
| `packages/core/src/slash.ts` | `/provider` · add · `interactiveProvider` 信号 |
| `packages/cli` `arrowPicker` + `resumeCli` | TTY 选择 → 热切 |

**不做：** 官方市场、密钥入库、遥测、默认同 turn 自动 failover。  
**测试：** `scripts/test-multi-provider.ts`。

## 路线：推理强度 · Effort 方言（**E 轨 · E0–E9 日用已闭环**）

> 实现契约 [EFFORT.md](./EFFORT.md) · 优化 [EFFORT_OPTIMIZATION.md](./EFFORT_OPTIMIZATION.md) · 便利层 [PROVIDER_UX.md](./PROVIDER_UX.md) · [ROADMAP.md §10–§11](./ROADMAP.md)。

| 现状 | 目标 |
|------|------|
| `/effort` + **方言表** 写入 API | ✅ 引擎 + builtins（含 Anthropic） |
| 厂商 if 不可扩展 | ✅ 有限 wire shape + 用户可配方言 |
| 按方言限制可选档 / TTY / doctor | ✅ E6–E9 |
| 按模型轻表 · preset · resume 粘性 | 📋 **CX** 见 [PROVIDER_UX.md](./PROVIDER_UX.md) |

| ID | 切片 | 状态 |
|----|------|------|
| **E0** | 规格（EFFORT.md） | ✅ |
| **E1** | resolve 引擎 + body patch | ✅ |
| **E2** | `deepseek-chat`：`reasoning_effort` | ✅ |
| **E3** | `openai-responses`：`reasoning.effort` | ✅ |
| **E4** | `providers.*.effort.dialect` | ✅ |
| **E5** | anthropic-output：`output_config.effort` + beta | ✅ |
| **E6–E9** | choosable · max 门控 · TTY · doctor | ✅ |
| **CX** | preset · caps · resume · 错误 · tip · model 建议 | ✅ CX1–6 · 📋 CX7 [PROVIDER_UX.md](./PROVIDER_UX.md) |

```jsonc
{
  "providers": {
    "sf": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.siliconflow.cn/v1",
      "model": "deepseek-ai/DeepSeek-V4-Flash",
      "effort": { "dialect": "deepseek-chat" }
    }
  }
}
```

实现：`packages/providers/src/effortDialect.ts` · 测试 `scripts/test-effort-dialect.ts`。  
DeepSeek：`reasoning_effort` ∈ {high,max}；low/medium→high；xhigh/ultra→max；agent auto→max。  
未配置时：baseUrl/model 含 deepseek 会 **detect** 为 `deepseek-chat`；否则 `max-tokens` 兼容旧行为。
