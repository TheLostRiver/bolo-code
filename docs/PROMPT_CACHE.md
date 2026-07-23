# Prompt Cache 友好布局

> 对照 HelsincyCode「静态段在前 / 动态段在后」（`DYNAMIC_BOUNDARY` 思路）。  
> Bolo：**无遥测**、无 GrowthBook、无全局 cache scope；只做 **前缀稳定布局**，让上游 API 的 prefix cache 更容易命中。

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

## 2. Bolo 分段

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

## 4. 什么会 cache-break（预期）

| 变更 | 影响 |
|------|------|
| 日期跨天 / `now()` 不同 | Environment 变 → 仅 volatile 变；**stable 前缀仍应相同** |
| permissionMode / model | Environment |
| 编辑 rules / BOLO.md | volatile 中对应段 |
| skill 增删 | catalog |
| 改 Identity/System 文案 | **stable 前缀** 变化（发版级） |
| tools 增删或改 schema | API tools 前缀变化 |
| user 消息 / tool 结果 | 对话尾部（不影响 system stable 前缀） |

## 5. 测试

```bash
npx tsx scripts/test-prompt-cache.ts
# 或
npm run test:prompt-cache
```

验收：

- 同一 cwd 两次组装，仅改「假时间」或 user message → `getCacheStablePrefix` **字节级相同**
- 乱序 tools 输入 → `toolsToOpenAI` 输出 name 序列稳定且有序

## 6. 有意不做

| 项 | 原因 |
|----|------|
| 遥测 / logEvent | 产品红线 |
| GrowthBook 门控长段 | 无 |
| 全局 `DYNAMIC_BOUNDARY` cache scope | 最小切片只做布局 |
| Provider cache 请求头（C5+） | 后置；见 ROADMAP M-Cost |

## 7. 相关文档

- `docs/SYSTEM_PROMPT.md` — 段语义与 BOLO.md  
- `docs/PROMPT_CATALOG.md` — 文案查阅  
- `docs/TODO.md` — C1–C4 勾选  
- `docs/ROADMAP.md` — M-Cost