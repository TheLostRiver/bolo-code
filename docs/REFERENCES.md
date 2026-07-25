# 参考项目笔记

## HelsincyCode / Claude Code 系参考实现

体量：约 50 万行级、Claude Code 系 CLI（仅作架构参考，仓库内不嵌入外部源码路径）。

**值得抽的结构**

| 区域 | 模块印象 | 对我们的意义 |
|------|----------|--------------|
| Hook 事件全集 | entrypoints / SDK 中的 `HOOK_EVENTS` | 事件命名与扩展列表 |
| Hook 元数据 | hooks 配置管理（matcher、exit code） | matcher 字段、exit code 语义 |
| Hook schema | hooks 配置 schema | command/prompt/http/agent 配置形态 |
| Query 引擎 | Query / 主循环 | 主循环边界 |
| Tools | tools 注册与实现 | Tool 插件化注册 |
| MCP | MCP 服务层 | 连接与工具桥接 |
| Skills | skills 加载 | bundled + 目录加载 |
| Plugins | plugins 加载与合并 | 贡献点合并 |
| Agent/子代理 | Agent tool / 子代理 | 子代理生命周期 |

**不要搬**

- Ink TUI 全家桶（我们用 Electron）
- 遥测 / GrowthBook / 大量 feature flag 迷宫
- 与 Anthropic 产品强绑定的 OAuth/bridge

## pi（https://github.com/earendil-works/pi）

包拆分清晰：

- `pi-ai`：多 provider LLM
- `pi-agent-core`：agent loop + tool calling + state
- `pi-coding-agent`：产品 CLI
- `pi-tui`：终端 UI

**借鉴**：core 与 UI 分包；统一 LLM API。  
**注意**：权限默认弱，Bolo 必须自带 PermissionRequest 体系。

### 推理 / thinking（对 Bolo Effort 轨）

- 用户层统一 **thinking level**：`off|minimal|low|medium|high|xhigh|max`
- 每模型 **`thinkingLevelMap`**：string = 发给上游的值；`null` = 隐藏/不支持
- **`compat`**：`supportsReasoningEffort`、`thinkingFormat`、`forceAdaptiveThinking` 等
- 扩展自定义模型 ≈ 改 `models.json`，不是改 agent 核心

→ Bolo 的 **EffortDialect.map / levels** 与此同构；优化见 [EFFORT_OPTIMIZATION.md](./EFFORT_OPTIMIZATION.md)。

## Codex（https://github.com/openai/codex）

- 本地 coding agent 产品完整度高
- CLI + App/IDE 多入口
- 实现语言以 Rust 为主——**思想可借，栈不跟**

### 推理 effort（对 Bolo）

- 配置 / 线程：`model_reasoning_effort`
- 枚举很宽：`none|minimal|low|medium|high|xhigh|max|ultra|Custom`
- **模型 catalog** 声明 `supported_reasoning_efforts` + default；UI 只展示支持档
- 上线前可折叠（如部分路径 `Ultra → Max`）
- `/model` 与快捷键升/降 effort

→ 学 **「按模型暴露可选档」**，不学把 Rust catalog 整搬进 TS。

## OpenCode（本地参考树 / 产品）

- 会话 **variant**（effort 选项）来自模型 **`reasoning_options` / variants**
- **`ProviderTransform`**：同一 `high` 按 npm/SDK 变成 `reasoningEffort`、`reasoning.effort`、`effort`、`thinkingLevel`…
- 按模型 id / release_date **裁** OpenAI 的 `none`/`xhigh`，减少 400
- 多厂商变换最全，但与 **AI SDK 绑定**

→ 学 **「意图 → 请求碎片」**；Bolo 用轻量 dialect patch，**不**引入 AI SDK 巨表。

## HelsincyCode · Effort（补充）

- 产品档：`low|medium|high|max` + auto（**无**全球 xhigh）
- Wire：`output_config.effort` + beta `effort-2025-11-24`
- **`modelSupportsEffort` / `modelSupportsMaxEffort`**（max ≈ Opus 4.6）
- **`ultrathink`**：关键词抬 high，不是 API 字面量
- thinking 与 effort **两轴分离**

→ Bolo E5 已接 `output_config.effort`；**max 门控**进优化 E7。

## 综合决策（一句话）

> **HelsincyCode 的扩展与 Hook / Tool 管道语义 + pi 的包边界与 thinkingLevelMap 清晰度 + Codex 的「按模型选档」+ OpenCode 的「意图→options」思想（简化）+ Electron GUI；不做遥测；不绑 AI SDK。**

Effort 实现：[EFFORT.md](./EFFORT.md) · 优化设计：[EFFORT_OPTIMIZATION.md](./EFFORT_OPTIMIZATION.md)

## 工程纪律

详见 [ENGINEERING_PRINCIPLES.md](./ENGINEERING_PRINCIPLES.md)：先映射参考模块再写代码；禁止 analytics/phone-home。