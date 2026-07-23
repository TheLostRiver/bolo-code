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

## Codex（https://github.com/openai/codex）

- 本地 coding agent 产品完整度高
- CLI + App/IDE 多入口
- 实现语言以 Rust 为主——**思想可借，栈不跟**

## 综合决策（一句话）

> **HelsincyCode 的扩展与 Hook / Tool 管道语义 + pi 的包边界 + Codex 的产品入口意识 + Electron GUI；不做遥测。**

## 工程纪律

详见 [ENGINEERING_PRINCIPLES.md](./ENGINEERING_PRINCIPLES.md)：先映射参考模块再写代码；禁止 analytics/phone-home。