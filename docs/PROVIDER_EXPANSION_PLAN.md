# Provider 面追赶方案（P0 支持面 + P1 模型元数据）

> 状态：**P0/P1 已实施**（2026-07，见 §2.3/§3.4 验收）；P2 OAuth 暂缓；P3/P4/P5 排队。
> 实施偏差：P1 目录放 `packages/shared/src/modelCatalog.ts`（core 的 /cost 不依赖
> providers，放 shared 供 core/cli 共用，与 theme.ts 同模式）。
> 真源：本文件 + `docs/PROVIDERS.md` + `docs/PROVIDER_UX.md`。
> 对标：`E:\Tools\pi`（pi agent）的 `packages/ai` provider 层。
> 范围：**本轮实施 P0（支持面扩展）与 P1（模型元数据内置表）**；
> **P2 OAuth 暂缓**；P3（非兼容协议适配）、P4（Transport 优化）、动态模型刷新
> **保留为后续阶段**（§5 路线，按需求/证据排队），不砍不弃。
> **红线：不引入 pi 的依赖**（`packages/ai` / `coding-agent` 等业务包不进依赖树、
> 不 copy 代码）；思路/架构/模式可自由借鉴（pi 源码仅作只读参考）。

## 0. 一句话目标

把 Bolo 的 provider 支持面从「5 个 preset」扩到「30–40 家数据条目」、
把 `/cost` 与 context 占比从「估算」升级为「内置元数据精确值」；
**零新协议代码、零运行时依赖、不破 `dependencies: {}` 红线**。

## 1. 背景与差距（为什么做）

| 维度 | pi（packages/ai） | Bolo 现状 | 差距性质 |
|------|-------------------|-----------|----------|
| 支持面 | 80+ 家薄适配器 | 5 个 preset + 3 类协议 | **数据量不足**（绝大多数是 OpenAI 兼容端点，Bolo 的 `openaiCompatible.ts` 已能跑通任意兼容端点） |
| 模型元数据 | 内置模型清单：cost（含 tier）/ contextWindow / maxTokens / thinking 映射 + 动态刷新 + 离线回退 | `ResolvedModelMetadata` 有 contextWindow/limits，成本走 usage 估算 | **数据表缺失 + 刷新机制缺失** |
| OAuth | Claude Pro/Max 订阅登录（PKCE + credential store） | 无 | 大工程，**本方案不做** |
| Transport | sse / websocket / websocket-cached / auto | SSE + WS（`openaiResponsesWs.ts`） | 已接近，按需再补 |

关键判断：Bolo 走**数据驱动 preset**（与 pi 的**代码注册**相反），
支持面扩展的边际成本是「写一条数据」，不是「写一个适配器」。

## 2. P0 · 支持面扩展（preset 扩容 5 → 30–40）

### 2.1 结构（现有 `ProviderPreset` 不变）

```ts
export type ProviderPreset = {
  id: string          // 'deepseek' 等，写入 config.providers.<id>
  label: string
  kind: ProviderKindName        // openai-compatible / openai-responses / anthropic
  baseUrl?: string
  model?: string                // 默认模型
  apiKeyEnv?: string            // 建议 env 名；永不写明文 key
  effortDialect?: string        // 缺省由 detect（E 轨）
  models?: string[]             // /model 建议列表
  notes?: string
}
```

- **不加字段**（除非 P1 需要 `defaultContextWindow` 等，见 §3.2）
- `effortDialect` 未知时**必须**标注 `notes`，由 detect 兜底，不得猜
- 新增 preset 必须进 `docs/PROVIDER_UX.md` 的 preset 表（文档与数据同步）

### 2.2 扩容清单（首批 ~30 家，按地域/用途分组）

| 组 | preset id | 说明 |
|----|-----------|------|
| 既有 | openai / openai-responses / anthropic / deepseek / siliconflow | 保留不动 |
| 国际兼容 | openrouter / groq / together / mistral / xai / nvidia / fireworks / cerebras / huggingface / vercel-ai-gateway / cloudflare-ai-gateway | OpenAI 兼容，`kind: openai-compatible`，各自 baseUrl/apiKeyEnv/模型清单 |
| 国内兼容 | moonshot / kimi-coding / minimax / minimax-cn / qwen / qwen-token-plan / zai / zai-coding-cn / xiaomi / xiaomi-token-plan-cn / doubao(volcengine) / baidu / zhipu(glm) / baichuan | 同上；`effortDialect` 不明确的一律留空走 detect |
| 特殊协议 | google(vertex/generative) / bedrock / mistral-conversations | 属 **P3 后续阶段**（§5 排队），本轮先以「中转兼容端点」方式覆盖 |

> 每家 1 条数据 ≈ 10–15 行；总增量 ~400 行纯数据。
> 模型清单只列**已验证可用**的模型 id（宁缺毋滥，避免给用户错误建议）。

### 2.3 验收（P0）

1. `listProviderPresets()` 返回 ≥ 30 家；每家 `id` 唯一、`apiKeyEnv` 非空、`kind` 合法。
2. `bolo provider add <preset>` 对**每一家**都能写出合法 config（`test-provider-presets` 扩展）。
3. 抽样 3–5 家真实 `provider add` + 会话切换（`/provider use`）E2E。
4. `test-dist-build` 断言 bundle 体积增量 < 100 KB（纯数据膨胀可控）。
5. `dependencies` 仍为 `{}`；`npm pack --dry-run` 清单不变。

### 2.4 切片

- **P0A**：国际兼容 15 家（数据 + 测试扩展 + 文档表）
- **P0B**：国内兼容 10–15 家（同上）
- 每刀独立：红（测试断言家数）→ 数据 → 定向测试 → typecheck → 完整 `npm test` → 文档提交

## 3. P1 · 模型元数据内置表

### 3.1 现状

- `ResolvedModelMetadata`（CTX-1..3）已提供 contextWindow / limits / source，由
  `packages/providers/src/modelCapability.ts` + `packages/config/src/modelMetadata.ts` 解析。
- **缺口**：无 cost 表（`/cost` 走 `ModelCostRates` 估算）、无内置常用模型清单（preset 的
  `models` 只是字符串建议，不含窗口/价格）。

### 3.2 方案

新建 `packages/shared/src/modelCatalog.ts`（纯数据，不发网；实施位置见顶部偏差记录）：

```ts
export type ModelCatalogEntry = {
  id: string                 // 模型 id，如 'gpt-4o' / 'deepseek-chat'
  provider: string           // preset id
  contextWindow: number
  maxOutput?: number
  cost?: {
    inputPerM: number        // $/M tokens
    outputPerM: number
    cacheReadPerM?: number
    cacheWritePerM?: number
  }
  /** effort dialect 缺省由 provider detect；此处可覆盖 */
  effortDialect?: string
}
```

- **合并优先级**（与 CTX-1 的 config 覆盖一致）：
  `config 显式覆盖 > modelCatalog 内置 > provider 默认 > 估算`
- `/cost` 与 context 占比 badge 消费同一入口：`resolveModelCatalogEntry(modelId, providerId)`
- **不做动态刷新**（pi 的 `models.generated` + 在线拉取）：先内置静态表；
  重开条件：≥ 2 次「模型元数据过期导致误报成本/窗口」的真实反馈（证据门控）

### 3.3 首批数据范围

- 只覆盖 **P0 扩容后的主流模型**（每 preset 的默认模型 + 常用 2–3 个），约 60–80 条
- 数据源：官方定价页/模型卡（人工核对，测试锁定已录入条目的数值）

### 3.4 验收（P1）

1. 内置表每条：id/provider/contextWindow 必填；cost 缺失允许（回落估算）。
2. `resolveModelCatalogEntry` 命中时 `/cost` 输出精确 cost；未命中回落现状（字节不回归）。
3. context 占比 badge 使用内置 contextWindow（如 preset models 表提供）。
4. 定向测试：命中/未命中/覆盖优先级/数据完整性（无重复 id、无空 provider）。

## 4. 实施顺序与依赖

```
P0A（国际 preset） → P0B（国内 preset） → P1（元数据表 + 消费接线）
```

- P0 不依赖 P1；P1 的 provider 字段依赖 P0 的 preset id 稳定（先 P0 后 P1）
- 每刀遵守项目 checkpoint：红灯测试 → 实现 → 定向 → typecheck → 完整 `npm test` → 文档分批提交

## 5. 阶段路线与暂缓项（不砍不弃，按序排队）

| 阶段 | 内容 | 状态 | 启动条件 |
|------|------|------|----------|
| **P0A** | 国际兼容 preset 扩容（15 家） | 本轮 | 方案确认后开工 |
| **P0B** | 国内兼容 preset 扩容（10–15 家） | 本轮 | P0A 完成 |
| **P1** | 模型元数据内置表 + `/cost`/context 接线 | 本轮 | P0 完成 |
| **P2** | OAuth（Anthropic 订阅登录：PKCE + 存储 + 刷新） | **暂缓**（用户指示） | 用户重新要求；或 API key 之外的登录成为主流诉求 |
| **P3** | 非兼容协议适配：Gemini / Bedrock / mistral-conversations | 排队 | ≥ 1 个真实用户场景（证据门控） |
| **P4** | Transport 优化：websocket-cached / auto 协商 | 排队 | 真实性能痛点（延迟/吞吐实测） |
| **P5** | 动态模型刷新（在线拉取 + 缓存 + 离线回退，参考 pi `models.generated`） | 排队 | ≥ 2 次元数据过期误报反馈 |

**明确不做**（真正砍掉的，仅此一项）：

| 项 | 不做理由 |
|----|----------|
| 为追平 pi 的数字而堆 80+ 全量厂商 | 长尾厂商无真实需求；按 P0A/P0B 的预设数据驱动模式按需扩展即可 |

## 6. 参考

- pi：`E:\Tools\pi\packages\ai\src\providers\*.ts`（80+ 薄适配器模式）·
  `models.generated.ts`（自动生成模型清单）
- Bolo 现有：`packages/config/src/providerPresets.ts` · `packages/providers/src/modelCapability.ts` ·
  `packages/config/src/modelMetadata.ts` · `docs/PROVIDER_UX.md` · `docs/PROVIDERS.md`
- 预算参考：P0 ≈ 1–2 个切片轮；P1 ≈ 1–2 个切片轮（纯数据 + 接线，无架构改动）
