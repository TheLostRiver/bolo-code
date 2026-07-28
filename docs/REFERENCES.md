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

- 未确认许可证的 snapshot 源码、品牌文案和产品细节；CLI TUI 只能观察信息架构
- 遥测 / GrowthBook / 大量 feature flag 迷宫
- 与 Anthropic 产品强绑定的 OAuth/bridge

## pi（https://github.com/earendil-works/pi）

包拆分清晰：

- `pi-ai`：多 provider LLM
- `pi-agent-core`：agent loop + tool calling + state
- `pi-coding-agent`：产品 CLI
- `pi-tui`：终端 UI

**借鉴/复用**：core 与 UI 分包；统一 LLM API。OI-14 首选复用 Pi TUI 的
retained renderer、Markdown、cell-width wrap、Editor 与 VirtualTerminal 测试；
不依赖整个 pi-coding-agent。当前 TUI package 声明 Node `>=22.19.0`，必须先完成
Bolo Node/esbuild/Windows/资产 spike，再决定 direct bundle、Node 升级或最小 MIT fork。
**注意**：权限默认弱，Bolo 必须自带 PermissionRequest 体系。

## oh-my-pi

- 在 Pi retained renderer 基础上加入 native scrollback、render backpressure、
  terminal capability、tmux/Ghostty、scroll view 与更广 VirtualTerminal 回归。
- TUI package 声明 Bun，并依赖 native/utils/cache；首次迁移不直接接入。
- 用作 OI-14G 的可靠性清单，不把整套产品依赖带入 Bolo。

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
- TUI 的 raw Markdown source、history cell、stream controller、transcript reflow、
  bottom pane 与 VT100 snapshot 是 OI-14 的架构/验收基准；不复制 Rust 实现

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
- TUI 使用 OpenTUI + Solid retained tree，`box` 拥有 gap/padding/flex，
  `scrollbox` 拥有 sticky viewport；当前栈依赖 Bun/Effect/workspace

→ 学 **「意图 → 请求碎片」**；Bolo 用轻量 dialect patch，**不**引入 AI SDK 巨表。
TUI 方面只作为 Pi 路线失败后的有时限备选 spike，必须证明 Node/esbuild/Windows
可行后才能采用。

## HelsincyCode · Effort（补充）

- 产品档：`low|medium|high|max` + auto（**无**全球 xhigh）
- Wire：`output_config.effort` + beta `effort-2025-11-24`
- **`modelSupportsEffort` / `modelSupportsMaxEffort`**（max ≈ Opus 4.6）
- **`ultrathink`**：关键词抬 high，不是 API 字面量
- thinking 与 effort **两轴分离**

→ Bolo E5 已接 `output_config.effort`；**max 门控** E7 已落地；按模型轻表归 **CX2**。

## 综合决策（一句话）

> **HelsincyCode 的扩展与 Hook / Tool 管道语义 + pi 的包边界与 thinkingLevelMap 清晰度 + Codex 的「按模型选档」+ OpenCode 的「意图→options」思想（简化）+ Electron GUI；不做遥测；不绑 AI SDK。**

| 文档 | 角色 |
|------|------|
| [EFFORT.md](./EFFORT.md) | E0–E5 wire 契约 |
| [EFFORT_OPTIMIZATION.md](./EFFORT_OPTIMIZATION.md) | E6–E9 能力视图 |
| [PROVIDER_UX.md](./PROVIDER_UX.md) | **CX 便利层**（preset · caps · resume · 错误 · ultrathink 默认 off · tip/turn） |
| [PROVIDERS.md](./PROVIDERS.md) | 协议与多实例 |
| [CLI_TUI_REFACTOR_PLAN.md](./CLI_TUI_REFACTOR_PLAN.md) | OI-14 参考审计、选型、迁移与验收 |

## 工程纪律

详见 [ENGINEERING_PRINCIPLES.md](./ENGINEERING_PRINCIPLES.md)：先映射参考模块再写代码；禁止 analytics/phone-home。
