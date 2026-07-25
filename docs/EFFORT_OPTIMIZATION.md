# Effort 优化方案（E6+ · 设计）

> **状态：** 📋 设计稿（在 E0–E5 日用闭环之上）  
> **前置：** [EFFORT.md](./EFFORT.md)（方言引擎真源）· [ROADMAP.md](./ROADMAP.md) §10  
> **对照来源（语义，不抄实现/遥测）：** HelsincyCode · Codex · OpenCode · Pi（earendil-works/pi）  
> **原则：** 继续 **表驱动方言**，不引入 AI SDK 全家桶；无遥测；密钥不进 log。

---

## 0. 一句话

```text
E0–E5：能把 /effort 意图写成各家真·推理字段（DS / OAI Responses / Anthropic）
E6+：  按「当前模型真正支持的档」约束 UI 与校验，少 400、少心智负担
       同时保持方言可配置扩展（学 Pi / OpenCode，不学 HC 单栈）
```

**优化目标不是**「再抄一家 transform 巨表」，而是：

| 要 | 不要 |
|----|------|
| 当前方言 **可选档白名单** 进 UI/校验 | 全球假装都有 xhigh/ultra |
| 轻量 **模型门控**（尤其 Anthropic max） | 完整 HC GrowthBook / 每模型 allowlist 迷宫 |
| dialect 数据可声明 **hidden / levels** | 为每个品牌永久 `if` |
| thinking 与 effort **关系写清** | 把 thinking budget 和 effort 糊成一个旋钮 |
| `/effort` 与 `/provider` 体验一致 | 引入 OpenCode 级 npm 分支 |

---

## 1. 业界对照（压缩版）

完整分析过程见会话结论；此处只留设计输入。

| 项目 | 用户抽象 | 谁决定有几档 | 怎么写 API | 多后端 |
|------|----------|--------------|------------|--------|
| **HC** | `/effort` 固定 low–max + auto | **产品写死** + **模型门控** | `output_config.effort` + beta | 弱（Claude 1P） |
| **Codex** | `model_reasoning_effort` | **模型 catalog** `supported_reasoning_efforts` | Responses `reasoning` | 偏 OpenAI |
| **OpenCode** | 会话 **variant** / effort 选项 | 模型 `reasoning_options` | **按 SDK/npm 变换**成 options | **最强** |
| **Pi** | 统一 **thinking level** | 每模型 `thinkingLevelMap`（string / null） | api 类型 + `compat` | **强且可配置** |
| **Bolo E5** | `/effort` 超集意图 | **EffortDialect**（内置 + config） | 有限 shape → body/header patch | 中强（3 主方言） |

### 1.1 可借鉴 / 不可照搬

| 借鉴 | 来源 | Bolo 落点 |
|------|------|-----------|
| 统一意图 + 每模型 map 挖洞 | Pi `thinkingLevelMap` | dialect.`levels` + `map`；可选 `null`=隐藏 |
| 选 id → 变成请求碎片 | OpenCode variants | 已有 resolve → patches（保持轻量） |
| catalog 只展示支持档 | Codex | `/effort` 无参与 TTY 只列 `dialect.levels` |
| max 模型门控 | HC | E6 轻量 gate，非全矩阵 |
| ultra→max 上线折叠 | Codex / DS | 已有 aliases/map |
| compat 关字段 | Pi `supportsReasoningEffort` | dialect `off` / 空 wire + config |
| **不**搬 | OpenCode AI SDK 巨 switch | 禁止 core 依赖 |
| **不**搬 | HC ultrathink 遥测/feature flag | 可选纯本地关键词糖 |

### 1.2 架构定位（定调）

```text
Bolo = Pi 的「统一 level + 每模型 map」清晰度
     + OpenCode 的「意图 → options」思想（简化为 dialect patch）
     + HC/Codex 的「按能力约束 UI」
     − OpenCode 的 SDK 绑定
     − HC 的单厂商封闭
```

---

## 2. 现状水位（E5 后 · 诚实）

### 2.1 已闭环

| 能力 | 状态 |
|------|------|
| 方言引擎 `resolveEffortWire` / `applyBodyPatches` | ✅ |
| `deepseek-chat` → `reasoning_effort` | ✅ |
| `openai-responses` → `reasoning.effort` | ✅ |
| `anthropic-output` → `output_config.effort` + beta | ✅ |
| config `providers.*.effort.dialect` | ✅ |
| detect（deepseek / responses / anthropic） | ✅ |
| `/effort` 超集 + wire 预览 | ✅ |
| `max-tokens` 旧行为 fallback | ✅ |

### 2.2 已知缺口（优化输入）

| ID | 缺口 | 用户体感 | 严重度 |
|----|------|----------|--------|
| **G1** | `/effort` 接受超集，但 **未按 dialect.levels 限制可选** | 对 DS 设 `minimal` 仍「成功」，实际 fold；对不支持档易 400 | P0 |
| **G2** | Anthropic **max** 无模型门控 | 非 Opus 类设 max 可能 400 | P0 |
| **G3** | OpenAI **按模型裁 none/xhigh** 未做 | 老模型可能 400（OpenCode 用 release_date 裁） | P1 |
| **G4** | thinking 与 effort 文档/产品仍易混 | 用户以为 `/effort` 会开 thinking | P1 |
| **G5** | 无 TTY **effort 选择器**（仅有 provider picker） | 仍要记档位名 | P1 |
| **G6** | dialect 不能表达 Pi 式 **null=隐藏** 的一等字段 | 只能靠 levels 省略 | P2 |
| **G7** | 热切 provider 后 effort 预览依赖 profile，**doctor 不够醒目** | 不知当前 wire | P2 |
| **G8** | 多 op variant（reasoningSummary 等）未支持 | 高级 OAI 场景弱于 OpenCode | P2 后置 |
| **G9** | 上游忽略字段时无探测 | 只保证「已发送」 | 接受 / 后置 |

**粗估：** 日用真·wire **~88–92%**；「少踩坑 / 按模型可选档」体验 **~55–65%** → 本优化目标 **~90%+ 体验**（仍不设 OpenCode 100%）。

---

## 3. 目标架构（在现有引擎上增强，不重写）

### 3.1 保持不变

```text
session.effortLevel（意图）
  → resolveEffortWire(dialect, level, ctx)
  → patches + requestHeaders
  → provider apply
```

### 3.2 增强：能力视图 CapabilityView

在 dialect 之上增加 **只读视图**（纯函数，供 slash / TUI / doctor）：

```ts
type EffortCapabilityView = {
  dialectId?: string
  /** UI / 校验允许选择的意图（已展开 aliases 前的用户可选集） */
  choosable: string[]  // 通常 ⊂ canonical，且 ⊆ 能 resolve 成功的意图
  /** 原生 wire levels（API 真值） */
  wireLevels: string[]
  /** 当前意图预览 */
  preview: { intent: string; display: string; resolvedWire: string | null }
  /** 警告：如 max 可能不被此 model 接受 */
  warnings: string[]
  gates?: {
    maxAllowed?: boolean
    notes?: string
  }
}
```

```text
listChoosableEfforts(dialect, ctx?) 
  = 对候选意图跑 resolve，ok 且（可选）过 model gate 的留下
  默认候选 = CANONICAL_EFFORT_LEVELS 去掉 auto 的展示集 + auto
```

学 **Codex/OpenCode**：UI 只展示能选的；学 **Pi**：map/levels 决定洞。

### 3.3 增强：轻量 ModelGate（可选插件，不是巨表）

```ts
type EffortModelGate = {
  /** 返回 false 则从 choosable 剔除并进 warnings */
  allow?: (intent: string, model: string, dialectId?: string) => boolean
}
```

内置最小规则（E6）：

| 方言 | 规则 |
|------|------|
| `anthropic-output` | `max` / 折叠到 max 的 xhigh·ultra：仅当 model 匹配 `opus-4-6` / `opus-4.6` 等 **或** `BOLO_EFFORT_ALLOW_MAX=1` |
| 其它 | 默认全放行（由 dialect.levels + API 裁决） |

**禁止** E6 引入 HC 级 3P override / GrowthBook。

### 3.4 增强：dialect 数据可选字段

| 字段 | 含义 | 对照 |
|------|------|------|
| `levels` | 已有：原生 wire 白名单 | — |
| `map` | 已有 | Pi map |
| `choosable?` | 显式 UI 意图列表；缺省从 map keys ∩ 可 resolve 推导 | OpenCode variants keys |
| `hide?` | 意图列表永不展示（即使 map 有 fold） | Pi `null` |
| `gates?` | 声明引用内置 gate id：`anthropic-max` | HC 门控的数据化 |

### 3.5 thinking 与 effort 关系（产品契约）

| 轴 | 命令/配置 | 作用 |
|----|-----------|------|
| **Effort** | `/effort` | 推理/努力强度 → 各家 effort 字段 |
| **Thinking 显示** | `/thinking on\|off` | CLI 是否渲染 reasoning 流 |
| **Thinking 请求** | `anthropicThinking` / 后置 `/thinking budget` | Anthropic `thinking` 块 |
| **Thinking 回灌** | `/thinking persist` | openai-compatible `reasoning_content` |

**明确文案：** `/effort` **不会**自动 `thinking.enabled`；需要 thinking 块另开。  
（HC 两轴分离；Pi 把 UI 叫 thinking level 但底层仍分 format——Bolo 保持两轴命名更清晰。）

---

## 4. 优化阶段（E6–E9）

| 阶段 | 交付 | 对标 | 优先级 | 状态 |
|------|------|------|--------|------|
| **E6** | `EffortCapabilityView` · `/effort` **只接受 choosable** · 无参列出可选档与警告 | Codex/OpenCode 选档 · Pi 挖洞 | P0 | 📋 |
| **E7** | Anthropic **max 轻门控** + env 逃生阀 · 预览 warnings | HC `modelSupportsMaxEffort` | P0 | 📋 |
| **E8** | TTY **`/effort` 箭头选择器**（复用 arrowPicker · 信号 `interactiveEffort`） | Provider picker · OpenCode effort UI | P1 | 📋 |
| **E9** | doctor 一行：`effort intent → wire (dialect)` · 文档/水位 · 回归 | 可观测 | P1 | 📋 |
| 后置 | OpenAI 按 model 裁 none/xhigh；多字段 variant op；adaptive thinking 联动；Desktop | OpenCode/Pi 深水 | — | 🚫 |

**顺序硬约束：**

```text
E6 能力视图+校验 → E7 Anthropic max 门控 → E8 TTY 选择器 → E9 doctor/文档
```

**禁止：** 未做 E6 就做「全球 ultrathink」；未做能力视图就堆 OpenCode 式 npm transform。

---

## 5. E6 详细设计

### 5.1 校验策略

| 模式 | 行为 |
|------|------|
| **strict（默认）** | `/effort <x>` 仅当 `x` ∈ choosable 或 `auto` |
| **fold-ok** | 允许 map 能成功折叠的意图（即使不在 wire levels）——**现状接近此**；E6 改为 strict，避免「设了 low 却不知道变成 high」除非预览 |

推荐默认 **strict + 无参强预览**：

- 想用 fold：用户直接设 **wire 档**（DS 上设 `high`/`max`），或看预览后设  
- 高级：`BOLO_EFFORT_LOOSE=1` 恢复「任意 canonical，能 resolve 就收」

### 5.2 `/effort` 无参输出（目标形态）

```text
effort: high
dialect: anthropic-output
wire: high
api value: high
choosable: auto, low, medium, high
warnings: (none)
note: Anthropic/HC: output_config.effort ...
```

DS 示例：

```text
dialect: deepseek-chat
choosable: auto, high, max
# low/medium 不在 choosable；文档说明官方会把 low 映射为 high——若 loose 模式才收
```

### 5.3 API

```ts
// packages/providers/src/effortDialect.ts（或 effortCapability.ts）
function listEffortChoosable(dialect, ctx?): string[]
function describeEffortCapability(dialect, level, ctx?): EffortCapabilityView
function assertEffortChoosable(dialect, level, ctx?): { ok: true } | { ok: false; reason: string }
```

core `/effort` 只调上述 API，**不**解析 Anthropic 字符串。

---

## 6. E7 详细设计（Anthropic max）

```ts
function anthropicMaxAllowed(model: string): boolean {
  if (envTruthy('BOLO_EFFORT_ALLOW_MAX')) return true
  const m = model.toLowerCase()
  return /opus-4-6|opus-4\.6|opus-4-7|opus-4\.7/.test(m) // 可配置扩展，保持短
}
```

- 意图 `max` / 折叠目标为 `max` 的 xhigh·ultra：gate 失败 → **不写入 session**，提示换 high 或开 env  
- `auto` 不强制 max（与 E5 agentDefault=null 一致）  
- **不**实现数值 `effort_override`

---

## 7. E8 TTY 选择器

对齐 `/provider`：

| 项 | 行为 |
|----|------|
| 无参 + TTY | `interactiveEffort: { mode: 'pick' }` |
| 列表 | `choosable` 每项 label = 意图 + 若 fold 则 `→ wire` |
| Enter | `session.effortLevel = id`（auto 则 clear） |
| `BOLO_EFFORT_PANEL=0` | 仅文本 |
| 非 TTY | 文本 capability 视图 |

---

## 8. 配置与扩展（保持灵活）

### 8.1 用户扩展路径（不变）

```jsonc
{
  "providers": {
    "my-proxy": {
      "kind": "openai-compatible",
      "effort": {
        "dialect": {
          "id": "my-proxy-effort",
          "levels": ["high", "max"],
          "map": { "high": "high", "max": "max", "low": "high" },
          "wire": [{ "shape": "body_field", "field": "reasoning_effort", "valueFrom": "resolved" }],
          "choosable": ["auto", "high", "max"]
        }
      }
    }
  }
}
```

### 8.2 与 Pi / OpenCode 配置对照

| Pi | OpenCode | Bolo |
|----|----------|------|
| `thinkingLevelMap` | model variants | dialect `map` + `choosable` |
| `compat.supportsReasoningEffort: false` | 无 variants | dialect `off` / 空 wire |
| `forceAdaptiveThinking` | anthropic adaptive options | **后置**（E5 未做联动） |
| models.json 热更 | provider 模型目录 | config 热切 provider 已支持；dialect 随 profile |

**结论：** 新厂商继续 **加数据不改 core**；优化轨只补 **选择面与门控**。

---

## 9. 明确不做（本优化方案内）

| 项 | 原因 |
|----|------|
| 引入 Vercel AI SDK / OpenCode ProviderTransform 全量 | 体积与栈绑定 |
| 远程拉取「官方模型努力档目录」 | 无遥测/市场原则；可后置本地 json |
| HC ultrathink 遥测与 feature flag | 产品糖可后置纯本地 |
| 自动扫描未知 API 字段名 | 不可靠 |
| 把完整 request body 打进 transcript | 隐私 |
| 同 turn 多 provider failover 因 effort 400 | 范围外 |

---

## 10. 验收（优化完成后）

1. DS 方言下 `/effort low` **默认拒绝**或仅 loose 接受，且无参 **不把 low 标成推荐档**  
2. Anthropic + 非 opus 模型 `/effort max` → **明确失败**（可 env 放开）  
3. `/effort` 无参展示 choosable ⊆ 当前方言真实可设  
4. TTY `/effort` 箭头选档成功写入 session（E8）  
5. `/doctor` 可见 effort 预览一行（E9）  
6. 单测：capability · gate · slash；回归 effort-dialect / provider-unit / slash  
7. 文档：EFFORT 状态、本优化阶段勾选、ROADMAP 水位  

---

## 11. 实施顺序与提交

```text
docs: 本文（设计） ✅ 本提交
E6: feat capability view + strict choosable on /effort
E7: feat anthropic max gate
E8: feat TTY /effort picker
E9: docs+doctor waterline
```

只 stage 本轨；**勿提交 `.bolo-tmp/`**；**勿提交真实 apiKey**。

---

## 12. 风险

| 风险 | 缓解 |
|------|------|
| strict 破坏习惯用 low→high fold 的用户 | `BOLO_EFFORT_LOOSE=1`；无参说明 DS 官方兼容映射 |
| max 门控正则过严/过松 | env 逃生；文档列出匹配规则 |
| 中转忽略 output_config | 已发送 ≠ 生效；doctor 不撒谎 |
| 选择器与 REPL raw mode 冲突 | 复用 provider picker pause/resume |

---

## 13. 文档入口

| 文档 | 角色 |
|------|------|
| **本文** | E6+ **优化设计真源** |
| [EFFORT.md](./EFFORT.md) | E0–E5 实现契约 |
| [ROADMAP.md](./ROADMAP.md) §10 | 总水位 |
| [REFERENCES.md](./REFERENCES.md) | 参考项目（含 effort 对照摘要） |
| [PROVIDERS.md](./PROVIDERS.md) / [CONFIG.md](./CONFIG.md) | 配置 |

**与 EFFORT.md 分工：** EFFORT = 已实现方言引擎说明；本文 = **下一阶段体验与门控优化**，避免把未做项写进「已落地」验收。