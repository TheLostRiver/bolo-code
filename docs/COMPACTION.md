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
  → [可选] snip / 其它裁剪
  → microcompact          // 轻量：清旧 tool_result 内容，尽量保缓存
  → autocompact 判断       // 达 token 阈值 → full compact
  → call model
```

| 层级 | 参考模块（逻辑名） | 作用 | Bolo 优先级 |
|------|-------------------|------|-------------|
| **Full compact** | `compactConversation` | LLM 写长摘要，重建会话前缀 | **P0 必做对** |
| **Microcompact** | `microcompactMessages` | 清可压缩 tool 的旧结果正文 | P1 |
| **Auto compact** | `autoCompactIfNeeded` | 阈值 + 熔断 + 调 full | P0 策略 / P1 接主循环 |
| **Session memory compact** | `sessionMemoryCompact` | 用会话记忆代替再调 LLM（实验） | P2 不做 |
| **Cached / API microcompact** | cache edits | 依赖特定 API 缓存编辑 | P2 不做 |
| **Partial compact** | 按索引部分摘要 | 高级 | P2 |

Bolo **第一期只把 Full compact 语义做对**；Microcompact 先定义接口与工具白名单，实现可第二期。

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

### 2.5 Prompt-too-long 重试（P1）

参考：compact 请求本身超长时，**截断最旧 API-round 组**再试，有限次数。  
Bolo P0：失败则返回明确错误，不破坏原 messages。  
B0 验收：原 messages 不变。

### 2.6 后缀保留（messagesToKeep）

参考支持「摘要前缀 + 最近消息原样」。  
Bolo P0 可选策略：

| 策略 | 说明 | 何时用 |
|------|------|--------|
| A. 全量摘要 | `messagesToKeep = []` | 实现最简单 |
| B. 保留最近 K 个 **user 轮次** | 按 turn 边界切，不是按 raw message 条数 | 推荐 P0.5 |
| C. 保留最近 N tokens | 需可靠 token 估计 | P1 |

**禁止**：无摘要只保留最近 N 条。

---

## 3. Auto Compact 策略（对照 autoCompact.ts）

### 3.1 阈值（逻辑，数值可配置）

```
effectiveWindow = contextWindow(model) - reservedForSummaryOutput
autoThreshold   = effectiveWindow - AUTOCOMPACT_BUFFER

// 参考量级（可配置，非魔法写死业务逻辑）
AUTOCOMPACT_BUFFER ≈ 13_000 tokens
reservedForSummaryOutput ≤ min(modelMaxOut, 20_000)
```

另有 warning/error buffer（约 20k）仅用于 UI 提示，**无遥测**。

### 3.2 熔断

参考：连续失败 ≥ 3 次则本会话停止 auto 尝试，避免死循环打 API。  
Bolo：`consecutiveFailures` 记在 session 内存即可。

### 3.3 递归守卫

compact / session_memory 类 **子查询**不得再次触发 autocompact。  
Bolo：`querySource: 'compact' | 'main'`，`source==='compact'` 时跳过 auto。

### 3.4 与 manual 关系

- manual `/compact`：始终可走 full compact（用户显式）  
- auto：受 `autoCompactEnabled` + 阈值 + 熔断约束  

---

## 4. Microcompact（P1 设计，勿与 full 混淆）

参考目标：在 **不跑完整 LLM 摘要** 的情况下，缩小上下文。

| 行为 | 说明 |
|------|------|
| 对象 | 指定 tool（Bash/Read 等）的 **旧 tool_result 正文** |
| 保留 | 最近 K 个可压缩 tool 结果完整；更早的替换为占位 |
| 时机 | 每次主循环 API 调用前 |
| 与 full | 可先 micro 再 auto full；二者不互斥 |

Bolo P1 接口草图：

```ts
type MicrocompactResult = {
  messages: ChatMessage[]
  clearedToolUseIds: string[]
  tokensSavedEstimate: number
}
```

**不做**：cached cache_edits API、GrowthBook 开关。

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
    estimateTokens.ts      # 粗估（字符/4 或 tiktoken 后置）
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
- [ ] microcompact 清旧 tool_result  
- [ ] PTL 截断重试  

### 明确不做

- [ ] 任何 compaction 遥测 / 远程实验开关  
- [ ] 未读参考就上的「智能压缩」黑盒  

---

## 8. 实现分期

| 期 | 交付 |
|----|------|
| **现在** | 本文 + 删除伪实现 + `packages/compact` 类型/管道骨架 + 单测用 fake summarizer |
| **紧随 Core 稳定后** | 接真 Provider 的 no-tool summarizer；manual compact 命令/API |
| **已接线** | `createSession({ autoCompactEnabled, compactSummarizer })` → `createAutoCompactPrepare` → `compactSession('auto')`；`querySource=compact` 不递归 |
| **下期** | microcompact；默认 config 是否开 auto（现默认 `autoCompactEnabled: false`） |
| **再后** | transcript 路径、partial compact |

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

**原则重申**：先对照再写；压缩质量 = 摘要质量 + 管道正确性，不是删消息条数。