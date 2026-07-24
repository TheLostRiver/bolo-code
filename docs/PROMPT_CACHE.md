# Prompt Cache 友好布局与 API 接线

> 对照 HelsincyCode：`getCacheControl` / `buildSystemPromptBlocks` / `addCacheBreakpoints`，以及「静态段在前 / 动态段在后」。  
> Bolo：**无遥测**、无 GrowthBook、无全局 cache scope / 1h TTL；**布局 + 最小 API 标记**，让上游 prefix cache 更容易命中。

## 1. 为何布局影响 API prompt cache

多数兼容 OpenAI / Anthropic 的供应商对 **请求前缀**（messages 与 tools 的前部字节）做缓存：

- **前缀字节级不变** → 可复用已算好的 KV / 计费折扣（视厂商而定）
- **前缀任意字节变化** → cache miss，整段重算

因此：

| 放前缀（少变） | 放尾部（易变） |
|----------------|----------------|
| 身份、系统规则、任务风格、工具使用说明 | Environment（date / mode / cwd） |
| 工具 schema 列表（名称顺序固定） | `.bolo/rules`、BOLO.md、skill catalog |
| | 用户消息、工具结果、compact 摘要 |

**规则：** 同一会话内应尽量保证「稳定前缀」字符串不变；只把会变的内容接在后面。

## 2. Bolo 分段（core）

实现：`packages/core/src/systemPrompt.ts`。

### 2.1 `cacheStableSections`（少变）

固定文案，**不**依赖 cwd、时钟、permissionMode、磁盘上的 rules/BOLO/skills：

1. **Identity** — Bolo Code 身份  
2. **System** — 权限四档摘要、hooks、注入风险等  
3. **Task style** — 简洁、用工具、可逆修改  
4. **Tools** — 调用约定（非具体 tool JSON schema；schema 在 API `tools` 字段）

导出：

- `getCacheStableSections()`
- `getCacheStablePrefix(sections | { cacheStableSections })` — 稳定前缀拼接字符串，便于字节级对比测试

### 2.2 `volatileSections`（易变）

按固定顺序追加：

1. **Environment** — cwd、**Date**、platform、shell、**当前 permissionMode 行为**、model  
2. **Rules** — `.bolo/rules`（可能编辑）  
3. **BOLO.md** — 用户/项目指令  
4. **Skill catalog** — 技能目录（集合变化）  
5. **MCP 占位**（可选）

导出：`getVolatileSections(opts)`、`getSystemPromptPartition(opts)`。

### 2.3 组装顺序（固定）

```text
getSystemPrompt =
  [...cacheStableSections, ...volatileSections]

prepareModelMessages =
  [system(stable…volatile…extraSystem…), …conversation user/assistant/tool…]
```

- **先 stable 后 volatile**，顺序不可打乱。  
- `extraSystem`（如 hook 注入）接在 volatile **之后**，会 cache-break（预期）。  
- 对话消息永远在全部 system 之后，**不**插入 stable 中间。

对照 HC：静态段 / 边界前内容尽量共享；动态边界后可变。Bolo **不做** `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 全局缓存与遥测。

## 3. Tools 数组顺序

`toolsToOpenAI` / `toolsToAnthropic`（`packages/tools/src/providerSchema.ts`）对工具 **按 name 稳定排序**，避免注册/Map 迭代序导致 schema 数组扰动前缀缓存。

## 4. API 真·cache 标记（providers，C5）

实现：`packages/providers/src/promptCache.ts`，由各 provider 在组请求体时调用。

### 4.1 Anthropic Messages

| 断点 | 行为 |
|------|------|
| **system** | 在 `# Environment` 切开；**稳定段**文本块末尾 `cache_control: { type: 'ephemeral' }`；volatile 段接后、不单独再标 |
| **tools** | 若有 tools：仅 **最后一项** 带 `cache_control` |
| **messages** | 仅 **最后一条** 的最后一个 content 块带 `cache_control`（对照 HC「每请求一个消息级断点」） |

入口：`buildAnthropicRequestBody`（`anthropic.ts`）。  
关闭：`completeStream({ enablePromptCaching: false })`。

**有意不做（对照 HC 全量）：** `ttl: '1h'`、`scope: 'global'`、cached microcompact / `cache_edits`、prompt cache break detection、遥测。

### 4.2 OpenAI Chat Completions / Responses

| 字段 | 行为 |
|------|------|
| `prompt_cache_key` | 默认由 `model + system 稳定前缀` 派生（`bolo_<sha256 前 24 hex>`）；仅 user 文本变化时 **key 不变** |
| 覆盖 | `options.promptCacheKey`；`''` 或 `enablePromptCaching: false` 不写该字段 |

入口：`buildOpenAICompatibleRequestBody`、`buildResponsesRequest`。

多数兼容网关会 **忽略未知字段**；真正支持 key 路由的上游可命中；**不支持时仍靠前缀稳定**（C1–C4）获益。

### 4.3 core 接线说明

`prepareModelMessages` 仍输出 `role: system` 字符串（先 stable 后 volatile）。  
Provider 侧按 `# Environment` 再 partition 打标——**最小侵入**，无需改 queryLoop 消息类型。

## 5. 什么会 cache-break（预期）

| 变更 | 影响 |
|------|------|
| 日期跨天 / `now()` 不同 | Environment 变 → 仅 volatile 变；**stable 前缀仍应相同**；Anthropic 稳定段断点仍可复用 |
| permissionMode / model | Environment；OpenAI key 含 model，model 变则 key 变 |
| 编辑 rules / BOLO.md | volatile 中对应段 |
| skill 增删 | catalog |
| 改 Identity/System 文案 | **stable 前缀** 变化（发版级） |
| tools 增删或改 schema | API tools 前缀变化 |
| user 消息 / tool 结果 | 对话尾部；消息级断点随「最后一条」移动（预期） |

## 6. 测试

```bash
npx tsx scripts/test-prompt-cache.ts
npx tsx scripts/test-provider-unit.ts
# 或
npm run test:prompt-cache
npm run test:provider
```

验收：

- 同一 cwd 两次组装，仅改「假时间」或 user message → `getCacheStablePrefix` **字节级相同**
- 乱序 tools 输入 → `toolsToOpenAI` 输出 name 序列稳定且有序
- Anthropic 请求体：`system[0].cache_control.type === 'ephemeral'`；可选 tools/messages 末断点
- OpenAI / Responses：`prompt_cache_key` 存在且仅 user 变化时不变

## 7. 有意不做

| 项 | 原因 |
|----|------|
| 遥测 / logEvent | 产品红线 |
| GrowthBook 门控长段 / 1h TTL | 无订阅与远程配置 |
| 全局 `DYNAMIC_BOUNDARY` cache scope | 过重；文档保留对照 |
| cached microcompact / cache_edits | 后置；见 COMPACTION |
| prompt cache break detection | 后置；无 UI/遥测诉求 |
| 把 core system 改成结构化 blocks 贯穿 session | 当前 provider 侧 partition 足够 |

## 8. 相关文档

- `docs/SYSTEM_PROMPT.md` — 段语义与 BOLO.md  
- `docs/PROVIDERS.md` — 各协议 cache 字段  
- `docs/PROMPT_CATALOG.md` — 文案查阅  
- `docs/TODO.md` — C1–C5  
- `docs/ROADMAP.md` — M-Cost