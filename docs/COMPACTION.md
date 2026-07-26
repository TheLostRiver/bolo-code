# 上下文压缩（Compaction）设计

> **用户硬约束**：压缩是核心能力，**禁止瞎写**。  
> 本文对照 HelsincyCode（Claude Code 系）`services/compact/*` 的**语义与管道**，定义 Bolo 必须实现什么、分几期、禁止什么。  
> **不做遥测**（参考里的 `logEvent` / GrowthBook 一律忽略）。

## 0. 为什么 `slice(-4)` 是错误实现

| 错误做法 | 后果 |
|----------|------|
| 直接丢掉旧消息 | 丢失目标、决策、文件路径、错误与修复史 |
| 无 summary | 模型无法续作，只能“失忆” |
| 无 boundary | transcript/UI 无法区分“已压缩段”与“存活段” |
| 无 Pre/PostCompact | 用户/企业无法注入指令或审计 |
| 无 token 门槛 | auto 乱触发或从不触发 |

参考实现的本质是：

```
用「结构化摘要 + 可选保留尾部消息」替换「被压缩前缀」
而不是删除历史。
```

Bolo 仓库里若存在 `messages.slice(-N)` 式 compact，**必须删除**，不得作为 v1 行为。

---

## 1. 参考架构：多层压缩，不是一种

HelsincyCode 在 **query 主循环**里大致顺序（逻辑层）：

```
messages
  → snip（无 LLM，丢过旧前缀，保留尾部；达 token/条数门槛）
  → microcompact          // 轻量：清旧 tool_result 内容，尽量保缓存
  → autocompact 判断       // 达 token 阈值 → full compact
  → call model
  → 若 PTL：truncate 最旧 API 轮次 → 再 prepare → 重试（有限次）
```

| 层级 | 参考模块（逻辑名） | 作用 | Bolo 优先级 |
|------|-------------------|------|-------------|
| **Snip** | `snipCompactIfNeeded` | 无 LLM，裁掉过旧前缀，插 `History snipped` 边界 | **P1 最小 ✅** |
| **Full compact** | `compactConversation` | LLM 写长摘要，重建会话前缀 | **P0 必做对** |
| **Microcompact** | `microcompactMessages` | 清可压缩 tool 的旧结果正文 | P1 |
| **Auto compact** | `autoCompactIfNeeded` | 阈值 + 熔断 + 调 full | P0 策略 / P1 接主循环 |
| **Session memory compact** | `sessionMemoryCompact` | 用会话记忆代替再调 LLM（实验） | P2 不做 |
| **Cached / API microcompact** | cache edits | 依赖特定 API 缓存编辑 | P2 不做 |
| **Partial compact** | 按索引部分摘要 | 高级 | P2 |

Bolo **snip 最小 + Full compact + auto + microcompact 已接线**；SnipTool / UUID 链 / resume 回放 / cached micro / session memory 仍不做。

---

## 2. Full Compact 管道（必须对齐）

### 2.1 顺序（与参考一致）

```mermaid
sequenceDiagram
  participant Core
  participant Hooks
  participant Summarizer as CompactSummarizer
  participant Store as MessageStore

  Core->>Core: phase=compacting
  Core->>Core: preCompactTokenCount = estimate(messages)
  Core->>Hooks: PreCompact(trigger, custom_instructions?)
  Hooks-->>Core: newCustomInstructions? / block?
  alt blocked exit 2
    Core->>Core: abort, keep messages
  else continue
    Core->>Core: merge user + hook instructions
    Core->>Summarizer: messages + compactPrompt(instructions)
    Note over Summarizer: NO tools; text only; analysis+summary
    Summarizer-->>Core: raw summary text
    Core->>Core: formatCompactSummary (strip analysis)
    Core->>Core: buildPostCompactMessages
    Core->>Store: replace API-view messages
    Core->>Hooks: PostCompact(trigger, compact_summary)
    Core->>Core: post cleanup (no telemetry)
  end
```

### 2.2 `CompactionResult`（结果形状）

参考 `buildPostCompactMessages` **固定顺序**：

```
boundaryMarker
  + summaryMessages[]
  + messagesToKeep[]      // 可选：尾部原样保留
  + attachments[]         // 可选：文件等再注入
  + hookResults[]         // SessionStart(source=compact) 等
```

Bolo 类型（实现真源见 `packages/compact`）：

```ts
type CompactTrigger = 'manual' | 'auto'

type CompactionResult = {
  boundary: CompactBoundaryMessage   // 系统边界，含 metadata
  summaryMessages: ChatMessage[]     // 通常 1 条 user/system 包装的 summary
  messagesToKeep: ChatMessage[]      // 后缀保留，可为空
  attachments: ChatMessage[]         // v1 可空
  hookResults: ChatMessage[]         // v1 可空
  summaryText: string                // 纯摘要，给 PostCompact
  preCompactTokenCount: number
  postCompactTokenCount: number
  trigger: CompactTrigger
}
```

### 2.3 PreCompact / PostCompact Hook 语义

对照参考 `executePreCompactHooks` / `executePostCompactHooks`：

| 事件 | matcher | 输入关键字段 | 成功时用途 |
|------|---------|--------------|------------|
| **PreCompact** | `trigger` = `manual` \| `auto` | `custom_instructions` | exit 0 的 **stdout 拼进** summarizer 的 Additional Instructions；exit 2 **阻止** compact |
| **PostCompact** | 同上 | `compact_summary` | 展示/审计；不默认改写 messages |

注意：参考里 PreCompact **不是**简单 block 就完事，而是 **合并自定义指令**。Bolo HookBus 应对 PreCompact 收集 `injectText` / `newCustomInstructions`，与用户传入 `customInstructions` 合并：

```
finalInstructions = userInstructions + "\n\n" + hookInstructions
```

（任一侧为空则省略。）

### 2.4 Summarizer 调用约束（来自 compact prompt）

参考 `prompt.ts` 硬约束：

1. **禁止 tool**：摘要轮 `maxTurns=1` 且 prompt 写明 TEXT ONLY  
2. 输出结构：`<analysis>…</analysis>` + `<summary>…</summary>`  
3. **formatCompactSummary**：丢掉 analysis，只保留 summary 正文  
4. 摘要章节至少覆盖（产品要求，prompt 模板对齐）：
   - Primary Request and Intent  
   - Key Technical Concepts  
   - Files and Code Sections（路径、关键片段）  
   - Errors and fixes  
   - Problem Solving  
   - All user messages（非 tool result）  
   - Pending Tasks  
   - Current Work  
   - Optional Next Step（紧贴用户最近显式请求）  

5. 包装成续聊 system/user 文案（参考 `getCompactUserSummaryMessage`）：
   - 说明「会话从压缩点继续」  
   - 可选：完整 transcript 路径（若落盘）  
   - 若保留了 recent messages：注明 verbatim  
   - auto 场景可要求「不要寒暄、直接续作」

### 2.5 Prompt-too-long 重试（已实现）

对照 HC `truncateHeadForPTLRetry` / `MAX_PTL_RETRIES=3` / `isPromptTooLongMessage`。

**顺序（主循环）**：`microcompact` → `auto full compact` → `callModel` → **若 PTL** → 截断 session 最旧轮次 → **再 prepare** → 重试。  
不是先 PTL 截断再 compact；compact 仍优先由阈值触发。PTL 是 callModel / summarizer 失败后的有限次逃生舱。

**错误识别**（`isPromptTooLongError`，启发式，无遥测）：

| 规则 | 说明 |
|------|------|
| 字符串 | 小写匹配：`prompt is too long`、`context_length_exceeded`、`maximum context length`、`input is too long`、`request too large`、`too many tokens`、`context window`+exceed/over/limit、`exceed context limit` |
| status 413 | 一律 PTL |
| status 400 | 仅当正文也命中上述字符串 |
| 非 PTL | 纯输出 `max_tokens`、鉴权、429 等 |

**截断**（`truncateHeadForPtlRetry`）：

1. 剥掉上次合成的 `PTL_RETRY_MARKER`  
2. 保留 leading `role:system`（含 `Conversation compacted` boundary）  
3. 主体按 API 轮次分组（每条新 assistant 开一组）  
4. 丢最旧若干组：有 `tokenGap` 则累计到覆盖；否则约 20% 组（≥1）；至少留 1 组  
5. 若剩余以 assistant 开头 → 前插 marker user  

**次数**：`maxPtlRetries` 默认 **3**；`0` 关闭。会话 / config / `queryLoop` / `runFullCompact` 均可配。

**compact 路径**：`runFullCompact` 的 summarizer 抛 PTL 时，对 **summarizer 入参副本** 同样截断重试；失败仍 `messagesUnchanged`，不毁调用方原数组。

### 2.6 后缀保留（messagesToKeep）

参考支持「摘要前缀 + 最近消息原样」。**C1 已实现按 user 轮次：**

| 策略 | 说明 | 状态 |
|------|------|------|
| A. 全量摘要 | `keepRecentUserTurns: 0` | ✅ |
| B. 保留最近 K 个 **user 轮次** | `splitMessagesForCompactKeep`；默认智能 keep（短会话不 keep） | ✅ **C1** |
| C. keep 段 token 上限 | `keepMaxTokens` | ✅ 可选 |
| 兼容 | `keepRecentMessageCount`（按条，deprecated） | ✅ |

**禁止**：无摘要只保留最近 N 条。

**AR2A0b · 防重摘要（已接线，借鉴 Codex `SUMMARY_PREFIX` / `is_summary_message`）：**

- summary user-message 以稳定字面量开头：`COMPACT_SUMMARY_MARKER`（既有输出前缀，零变化）；`isCompactSummaryMessage` 可检测
- 二次 compact 时若旧 summary 落在**待摘要前缀**（keep 尾部不算），`runFullCompact` 经 instructions 通道注入 `COMPACT_MERGE_PRIOR_SUMMARY_HINT`（合并事实、勿重新叙述），并在 boundary `compactMetadata.mergedPriorSummary: true` 留本地可观测标记（非遥测）

### 2.6b 失败语义（两类失败必须对称）

compact 有两个会失败的阶段，此前待遇不对称，已改齐：

| 失败点 | 行为 |
|--------|------|
| 摘要生成 / PTL 重试耗尽 | 恢复 snapshot（保持同一数组引用，queryLoop 持有它）· `ok:false` |
| **transcript 写盘** | **同上**——恢复 snapshot · `ok:false` · reason 说明是写盘失败 |

原先写盘失败只 `emit error` 然后 `return { ok: true }`。后果是**内存与磁盘分叉**：
内存是压缩后的短链，磁盘还是压缩前的长历史且无 boundary。resume 会加载那份旧历史
——这次压缩等于没发生，上下文压力原样存在，于是立刻再次触发 auto compact 转圈，
而调用方全程拿到 `ok:true`。

> 写盘因此必须排在 **PostCompact hook 与 skill 再注入之前**：hook 一旦跑过就收不回来，
> 排在它后面就没法干净回退。

**durable 条目的保留不得静默失败。** 整份重写靠再读一次旧文件把
turn/control/task/resolution 与 title/notes 接到新文件；那次读取只把 **ENOENT**
当作「新文件」，其余错误一律中止整个 rewrite（`loadTranscriptForPreservation`）。

读不出旧文件就**不知道**里面有什么，此时继续覆盖等于销毁：
`loadTranscriptFile` 在 `st.size > 32MiB` 时直接抛，而长会话堆到 32MiB
并非极端情况（大 tool 输出很容易）。原先那个 `catch {}` 把「文件不存在」与
「文件在但读不出来」混为一谈，一次 compact 就能永久抹掉断点续跑所需的全部状态，
且不报任何错。

回归：`test-compact-write-failure.ts` · `test-transcript-rewrite-preserve.ts`。

### 2.7 AR2A1 · partial range / watermark 契约（纯函数，**尚未接线**）

真源：`packages/compact/src/range.ts` · 测试：`scripts/test-compact-range.ts`

§2.6 的模型是**单切点**：`[toSummarize | messagesToKeep]`，只能压前缀。
partial compact 要压任意区间，于是先把四个问题定成契约：

| 问题 | 函数 |
|------|------|
| 这个区间合法吗 | `validateCompactRange` |
| 哪些已经被摘要过了 | `deriveCompactWatermark` |
| 哪些绝不能被摘要 | `findAtomicBlocks` + `preserveTailCount` |
| 不合法时为什么 | `CompactRangeRejection` |

**watermark 是推导的，不是存储的。**

参考实现（HC）用 `lastSummarizedMessageId` 这类稳定 id 标记「已摘要到哪」。
Bolo 的 `ChatMessage` **没有 id 字段**，而 rewrite 会移动下标——存下标必然漂移。
但 compact 总会插入一条可判别的 summary 消息（`isCompactSummaryMessage`），
所以水位可以直接从消息表推导：**推导值不可能与实际历史不一致**。

> 代价：无法区分同一位置的两次不同摘要。可接受——契约只需回答
> 「这段是否已被某次摘要覆盖」，不需要溯源是哪一次。
> 多条 summary 时以**最新**的为准，旧 summary 不该压低水位。

**原子块（`findAtomicBlocks`）为什么单独成为一等概念：**
带 `tool_calls` 的 assistant 消息 + 紧随其后的全部 tool 结果不可拆分。
拆开会留下一条有 `tool_calls` 却没有对应结果的消息——多数 provider 直接 400。
这是 compact 改动里最容易造成**不可恢复损坏**的一处，所以不做成散落的边界判断。

**吸附必须如实上报（`snapped: true`）。**
静默返回一个与请求不同的区间，会让调用方以为压缩了 A 实际压缩了 B——
比直接拒绝危险得多。同理 `planPartialCompact` 在无内容可压时**明确拒绝**
（`nothing_to_compact`）而不是返回空区间：空区间是最容易被误当成「压成功了」的返回值。

**边界：** 本模块全是纯函数、不改入参（就地改历史会让回退失效）。
`resolution` / durable 控制项是 **transcript 条目**而非 `ChatMessage`，
不在本契约覆盖范围内——接线（AR2A2）时须单独保证其不丢。

---

## 3. Auto Compact 策略（对照 autoCompact.ts）

### 3.1 阈值（逻辑，数值可配置）

```
effectiveWindow = contextWindowTokens - reservedForSummaryOutput
autoThreshold   = max(1000, effectiveWindow - AUTOCOMPACT_BUFFER)

// Bolo 常量（packages/compact）
AUTOCOMPACT_BUFFER_TOKENS = 13_000
RESERVED_SUMMARY_TOKENS_CAP = 20_000
RESERVED_SUMMARY_FRACTION = 0.15   // reserved = min(cap, floor(window * 0.15))
WARNING_BUFFER_TOKENS = 20_000     // 仅 UI 压力，不强制 compact
DEFAULT_MAX_AUTOCOMPACT_FAILURES = 3
```

**压力档位**（`getContextPressure`，供 `/context`）：

| level | 条件 |
|-------|------|
| `ok` | 远低于 auto 阈值 |
| `warn` | 接近阈值（阈值−20k 与 80%阈值 取较大者） |
| `critical` | ≥ auto 阈值（auto 开启时下一 prepare 会试 full） |
| `over` | ≥ 配置 `contextWindowTokens` |

另有 warning/error buffer 仅用于 UI 提示，**无遥测**。

### 3.2 Token 估计（本地启发式，非计费）

| 片段 | 规则 |
|------|------|
| 普通正文 | ≈ `ceil(chars / 4)` |
| 密文 JSON / 高标点 | ≈ `ceil(chars / 2)`（`looksDenseTokenText`） |
| 每条消息 | + role 开销；`tool_calls` 计 name + arguments |
| system sections | `estimateSystemSectionsTokens`（`/context` 合计压力） |

与 `/context`、`shouldAutoCompact`、full compact boundary 元数据共用 `estimateTokens` 族。  
**不做** 真 tokenizer / 计费 API（是否引入 tokenizer registry 由 AR2B1 在 A0a 落地后重估）。

**AR2A0a · 混合 usage 锚定计数（已接线，借鉴 HC `tokenCountWithEstimation` 语义）：**

```
UsageAnchor = { anchorInputTokens, anchoredMessageCount, fingerprint? }
hybridTokenCount = anchor input（provider 真实 usage）
                 + estimateTokens(锚后追加的消息) × 4/3 保守垫
```

- 锚在 queryLoop 累计 provider 真实 usage 时记录：`lastCall.messageCountAtCall` + `messagePrefixFingerprint`（role+toolCall 形状指纹，**不含内容**）
- microcompact 只改正文 → 指纹不变，锚仍有效；snip / full compact 改写头部 → 指纹失配或长度收缩 → 锚失效，回退全量估算
- 修复的缺口：旧 C2 语义 `usageInputTokens ?? estimate` 会让 API 响应后新追加的 tool result 对阈值不可见 → auto compact 迟触发
- 消费方：`createAutoCompactPrepare.getUsageAnchor` · `tryMidTurnCompact` · `/context`（`pressure source: hybrid`，显示 anchor + tail 拆分）
- 估算 usage（无 provider usage 的 call）不建锚；旧会话无快照字段 → 回退 C2 路径，行为不变

### 3.3 熔断

参考：连续失败 ≥ 3 次则本会话停止 auto 尝试，避免死循环打 API。  
Bolo：`createAutoCompactPrepare` 内 `consecutiveFailures`；失败 **返回原 messages**，不拖垮 turn。

**环境熔断**（对照参考 `DISABLE_AUTO_COMPACT` / `DISABLE_COMPACT`）：

| 变量 | 效果 |
|------|------|
| `BOLO_DISABLE_AUTO_COMPACT` | 为真（`1`/`true`/`yes`/`on`）时 **不**触发 auto |
| `BOLO_DISABLE_COMPACT` | 同上（一键挡 auto；**不**挡 manual `/compact`） |

### 3.4 递归守卫

compact / session_memory 类 **子查询**不得再次触发 autocompact。  
Bolo：`querySource: 'compact' | 'session_memory' | 'main'`，`source==='compact'|'session_memory'` 时跳过 auto。

### 3.5 与 manual 关系

- manual `/compact`：始终可走 full compact（用户显式）；成功后报告前后 messages token  
- auto：受 `autoCompactEnabled` + 阈值 + 熔断 + **环境变量**约束  
- full compact **只改** `session.messages`；**不改** `systemPromptSections`（稳定 system 前缀）  
- 运行时：`/autocompact on|off` → `setSessionAutoCompact` 重挂 prepare  

### 3.6 默认策略

| 项 | 值 |
|----|-----|
| `DEFAULT_CONFIG.autoCompactEnabled` | **`true`**（对照参考全局 config 默认开） |
| `createSession` 未传 | **开**（`opts.autoCompactEnabled !== false`） |
| 生效条件 | 会话 on **且** 有 `compactSummarizer` **且** 未环境熔断 **且** 达阈值 **且** 熔断未满 |

---

## 4. Microcompact（已实现，勿与 full 混淆）

参考目标：在 **不跑完整 LLM 摘要** 的情况下，缩小上下文。

| 行为 | 说明 |
|------|------|
| 对象 | `role: tool` 消息正文（可选按 tool 名过滤） |
| 保留 | 最近 K 条 tool 结果全文；更早的替换为占位 |
| 占位 | `[Old tool result content cleared]`（对齐参考实现语义） |
| 字符预算 | 保留条仍可按 `maxToolResultChars` 截断 |
| 时机 | 每次主循环 `prepareMessages` → **callModel 前** |
| 与 full | **先 micro，再 auto full**；二者不互斥 |
| LLM | **不调用** summarizer |

### 4.1 主循环顺序（Bolo 真源）

```
queryLoop 每轮:
  prepareMessages:
    1) microcompactMessages   // 默认开；无 LLM
    2) auto full compact      // 仅 autoCompactEnabled + summarizer + 达阈值
  prepareModelMessages(system + conversation)
  callModel
```

实现：

| 符号 | 位置 |
|------|------|
| `microcompactMessages` | `packages/compact` |
| `createMicrocompactPrepare` | `packages/core/src/deps.ts` |
| `composePrepareMessages` | 串联 micro → auto |
| `productionDeps` | 默认 `prepareMessages = createMicrocompactPrepare()` |

### 4.2 配置

```ts
type MicrocompactOptions = {
  enabled?: boolean              // 默认 true
  keepRecentToolResults?: number // 默认 4，至少 1
  maxToolResultChars?: number    // 默认 50_000；0 = 不截断保留条
  compactableToolNames?: string[] // 可选白名单
}
```

- 会话：`createSession({ microcompact: false | MicrocompactOptions })`
- workspace：`config.microcompactEnabled`（默认 true）；细项用 `createSession` 传入
- **不写回** session.messages（`didCompact` 仅 full compact 为 true）；API 视图用 prepare 后的副本

### 4.3 结果形状

```ts
type MicrocompactResult = {
  messages: ChatMessage[]
  clearedToolUseIds: string[]
  truncatedToolUseIds: string[]
  tokensSavedEstimate: number  // 与 estimateTextTokens 一致
}
```

**不做**：cached cache_edits API、GrowthBook 开关、time-based 远程配置。

### 4.4 工具输出中段截断（AR2A0b · exec 边界 + micro 共用）

借鉴 Codex `truncate_middle` 语义：长输出**保头（60%）保尾**，中间一行标注原始规模——尾部常含真正的失败原因/结果，head-only 会丢掉。

```
truncateMiddle(text, { maxChars, headFraction=0.6 })
  → head + "…[truncated middle: original ~N tokens, M lines (C chars); head+tail kept; …]…" + tail
```

- **预算表驱动**（`toolOutputBudgetBytes`）：显式覆盖（`ctx.maxToolResultChars`）> per-tool 表（Bash 16k · Read 40k · Grep 12k · WebFetch 8k）> 默认 10k；禁止工具/厂商 if-else 散落
- **幂等**：已含标注的文本不再二次截断（exec → micro 两层不叠标注）
- **只在产出时应用一次**，绝不回溯改写历史消息（prompt cache 前缀稳定）
- spill 不变：完整输出仍写 `.bolo/sessions/tool-results/`，`[full result: path]` 指向完整数据
- 应用层：`toolExecution.truncateToolResultOutput`（exec 边界）与 microcompact `truncateToolContent` 共用同一 util；单测 `test-truncate-middle`

---

## 5. 与 Session / Transcript 的关系

| 概念 | 要求 |
|------|------|
| API 视图 | compact 后发给模型的 messages = `buildPostCompactMessages` |
| UI 滚动 | 可保留压缩前消息仅供展示（可选）；**权威 API 视图**必须是压缩后 |
| Transcript 落盘 | P1：压缩前写入文件，summary 中附路径 |
| SessionStart(compact) | 参考在 full compact 成功后跑 `source=compact` 的 SessionStart hooks |

---

## 6. Bolo 模块落点

```
packages/compact/          # 纯函数 + 管道，无 Electron、无遥测
  src/
    types.ts               # CompactionResult, trigger, boundary
    prompt.ts              # compact prompt 模板（自维护，语义对齐参考）
    formatSummary.ts       # strip analysis / extract summary
    buildPostCompact.ts    # 顺序拼接
    estimateTokens.ts      # 加权启发式（正文/4 · 密文/2 · tool_calls）；真 tokenizer 后置
    fullCompact.ts         # PreHook → summarize → PostHook → result
    autoPolicy.ts          # 阈值与熔断（纯函数）
    microCompact.ts        # P1
    index.ts

packages/core/
  仅调用 compact 模块；禁止在 core 里 slice 消息冒充 compact
```

### Summarizer 注入

```ts
type CompactSummarizer = (req: {
  messages: ChatMessage[]
  compactPrompt: string
  signal?: AbortSignal
}) => Promise<{ text: string; usage?: { input: number; output: number } }>
```

- 真 Provider：单独 completion，**tools: []**  
- 测试：注入固定 XML summary fixture  
- **无 Summarizer 时 compact 必须失败**，不得 silent truncate  

---

## 7. 验收标准

### P0（Full compact 语义）

- [ ] 无 `slice(-N)` 作为压缩实现  
- [ ] PreCompact(trigger) 可合并 instructions；exit 2 取消且 **messages 不变**  
- [ ] Summarizer 收到含 9 段要求的 prompt  
- [ ] `formatCompactSummary` 去掉 analysis  
- [ ] `buildPostCompactMessages` 顺序正确  
- [ ] PostCompact 收到完整 summary 文本  
- [ ] 失败路径不破坏原 messages  
- [ ] 单测：fixture messages → 固定 summarizer → 断言结果结构  

### P1

- [x] token 估计 + auto 阈值（`getAutoCompactThreshold` / `shouldAutoCompact`）  
- [x] 连续失败熔断（`createAutoCompactPrepare`）  
- [x] auto 挂 `prepareMessages` + `compactSession(trigger=auto)`（需 `autoCompactEnabled` + `compactSummarizer`）  
- [x] microcompact 清旧 tool_result（`microcompactMessages` + prepare 链）  
- [x] PTL 截断重试（`isPromptTooLongError` + `truncateHeadForPtlRetry` + queryLoop / full compact）  
- [x] 加权 token 启发式 + `getContextPressure` + `/context`·`/compact` 日用（CP* 最小）  
- [x] 默认开 auto + 环境熔断 + `/autocompact` 可见性（CP 余量小步）  
- [x] snip 最小：`snipMessagesIfNeeded` + prepare 链 snip→micro→auto；tool 配对安全切；`test-snip`  
- [ ] 任何 compaction 遥测 / 远程实验开关  

---

## 8. 实现分期

| 期 | 交付 |
|----|------|
| **现在** | 本文 + 删除伪实现 + `packages/compact` 类型/管道骨架 + 单测用 fake summarizer |
| **紧随 Core 稳定后** | 接真 Provider 的 no-tool summarizer；manual compact 命令/API |
| **已接线** | `createSession({ autoCompactEnabled, compactSummarizer })` → micro → auto full；`querySource=compact` 不递归 auto |
| **已接线** | microcompact 默认开；`test-microcompact` |
| **已接线** | PTL 截断重试；`test-ptl-retry` |
| **已接线** | 加权 token · pressure · richer `/context`·`/compact`；`test-context-slash` |
| **已接线** | 默认 `autoCompactEnabled: true`；`BOLO_DISABLE_*` 环境熔断；`/autocompact` 运行时开关；`test-auto-compact` |
| **已接线** | snip 最小：门槛 + 安全 cut + 边界 + prepare 写回；`test-snip` |
| **已接线** | `/context` section 角色标签 + memory 预算提示（CP-OBS）；**不做** cached MC |
| **已接线** | **F-CP-CACHED-MC** `cachedMicrocompactMessages`（content-clear + cacheFriendly 标记；无 API cache_edits） |
| **已接线** | **F-CP-SNIP-UUID** 边界 `snip_id=` 可解析（非完整 SnipTool 回放） |
| **C 轨（✅ C0–C5）** | keep 轮次 · usage 阈值 · mid-turn · catalog 再注入 · `/context` 诊断；日用 **~92–95%**；见 [ROADMAP.md §8](./ROADMAP.md) |
| **已接线（AR2A0a）** | 混合 usage 锚定计数：`UsageAnchor` · `hybridTokenCount` · `messageCountAtCall`/指纹 · `/context` hybrid 来源；`test-compact`/`test-auto-compact`/`test-context-slash` |
| **已接线（AR2A0b）** | 中段截断 `truncateMiddle` + per-tool 预算表 + `COMPACT_SUMMARY_MARKER` 防重摘要合并提示；`test-truncate-middle`/`test-tool-calling` |
| **OUT / 限制** | 完整 SnipTool UUID 链 · 厂商 cache_edits API · remote/session-memory；partial/watermark → AR2A1/A2 · tokenizer registry → AR2B（见 [ROADMAP.md §13.10.2](./ROADMAP.md)） |

### C 轨日用缺口（相对已接线主路径）

| 缺口 | 阶段 | 说明 |
|------|------|------|
| keep 按 **user 轮次**（非 raw 条数） | **C1 ✅** | `splitMessagesForCompactKeep`；tool 对不拆 |
| auto 计数 **优先 session usage** | **C2 ✅** | `usageInputTokens`；prepare 读 lastCall |
| tool 批后 **再判一次 auto** | **C3 ✅** | `tryMidTurnCompact`；每 outer turn ≤1 |
| post-compact **短段再注入** | **C4 ✅** | skill catalog；`postCompactReinjection` |
| `/context` 展示来源与策略 | **C5 ✅** | pressure source · keep · last compact |

**实施顺序：** C0→C1→C2→C3→C4→C5。禁止在 C 轨内用 `slice(-N)` 冒充 full。

---

## 9. 参考映射表（实现时打开对照）

| Bolo | 参考职责 |
|------|----------|
| `fullCompact()` | `compactConversation` |
| `buildPostCompactMessages` | 同名函数顺序 |
| `getCompactPrompt` / format | `services/compact/prompt.ts` |
| `mergeHookInstructions` | compact.ts 内合并 |
| Pre/PostCompact | `executePreCompactHooks` / `executePostCompactHooks` |
| `autoPolicy` | `autoCompact.ts` 阈值与熔断（无 logEvent） |
| `microCompact` | `microcompactMessages` 的「清 tool 结果」语义 |
| `snipMessagesIfNeeded` | `snipCompactIfNeeded`（无 LLM 裁前缀；Bolo 无 UUID/SnipTool） |

**原则重申**：先对照再写；压缩质量 = 摘要质量 + 管道正确性，不是删消息条数。
Full compact **禁止**用 `slice(-N)` 冒充；**snip** 是显式轻量层，有门槛、安全 cut 与边界，不得替代 full compact 摘要。