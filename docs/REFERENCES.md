# 参考项目笔记

## HelsincyCode（本地 `D:\DEV\HelsincyCode`）

体量：约 50 万行级、Claude Code 系 CLI。

**值得抽的结构**

| 区域 | 路径印象 | 对我们的意义 |
|------|----------|--------------|
| Hook 事件全集 | `src/entrypoints/sdk/coreTypes.ts` `HOOK_EVENTS` | 事件命名与扩展列表 |
| Hook 元数据 | `src/utils/hooks/hooksConfigManager.ts` | matcher 字段、exit code 语义 |
| Hook schema | `src/schemas/hooks.ts` | command/prompt/http/agent 配置形态 |
| Query 引擎 | `src/QueryEngine.ts` / `src/query.ts` | 主循环边界 |
| Tools | `src/tools/*` | Tool 插件化注册 |
| MCP | `src/services/mcp/*` | 连接与工具桥接 |
| Skills | `src/skills/*` | bundled + 目录加载 |
| Plugins | `src/utils/plugins/*` | 贡献点合并 |
| Agent/子代理 | `src/tools/AgentTool/*` | 子代理生命周期 |

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

> **HelsincyCode 的扩展与 Hook 语义 + pi 的包边界 + Codex 的产品入口意识 + Electron GUI。**