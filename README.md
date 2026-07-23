# Bolo Code

跨平台图形化 AI Coding Agent（Electron + 核心 Runtime 解耦）。

## 目标

- **GUI 优先**：Electron 桌面端，Windows / macOS / Linux 一致体验
- **Agent 核心独立**：不绑定 UI，可被 CLI / GUI / 自动化复用
- **扩展面完整**：Skill / MCP / Hook / 子代理 / 插件 一等公民

## 文档

| 文档 | 说明 |
|------|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 总体架构、模块边界、数据流 |
| [docs/HOOKS.md](docs/HOOKS.md) | 至少 10 个 Hook 事件规范 |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | **权限四档对照 HelsincyCode** |
| [docs/AGENT_LOOP.md](docs/AGENT_LOOP.md) | **Agent loop 对照 HelsincyCode query/tool 管道** |
| [docs/COMPACTION.md](docs/COMPACTION.md) | **上下文压缩（对照参考，禁止截断冒充）** |
| [docs/ENGINEERING_PRINCIPLES.md](docs/ENGINEERING_PRINCIPLES.md) | **先借鉴再实现；禁止遥测** |
| [docs/DEEP_ANALYSIS.md](docs/DEEP_ANALYSIS.md) | 深度分析：状态机、风险、验收门禁 |
| [docs/SKILLS.md](docs/SKILLS.md) | **全局 skills 目录 + 按需 Skill 工具** |
| [docs/CONFIG.md](docs/CONFIG.md) | **全局 ~/.bolo 与项目 .bolo 配置** |
| [docs/SESSIONS.md](docs/SESSIONS.md) | **会话 JSON 落盘与 `bolo --resume`** |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | OpenAI 兼容 Provider 与环境变量 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 分阶段实施路线 |
| [docs/REFERENCES.md](docs/REFERENCES.md) | 参考项目与取舍 |
| [task_plan.md](task_plan.md) | 会话工作计划（planning-with-files） |

## 仓库

- GitHub: https://github.com/TheLostRiver/bolo-code.git

## 状态

- **M0–M1 已完成**：文档契约 + headless `queryLoop` + 权限四档 + compact 管道（smoke/单测）
- **当前主线**：**M2** 真 Provider + 真压缩（见 [docs/ROADMAP.md](docs/ROADMAP.md)）
- **未做**：MCP 真连接、Electron 产品壳、完整 TUI

## 快速命令

```bash
npx tsx scripts/bolo-init.ts              # 初始化 ~/.bolo 与项目 .bolo
npx bolo --resume <sessionId>             # 恢复会话（见 docs/SESSIONS.md）
npx tsx scripts/test-session-persist.ts
npx tsx scripts/test-cli-resume.ts
npx tsx scripts/test-config.ts
npx tsx scripts/test-permissions.ts
npx tsx scripts/test-compact.ts
npx tsx scripts/test-provider-unit.ts
npx tsx scripts/smoke-turn.ts
npx tsx scripts/smoke-live.ts             # 需 API key
```