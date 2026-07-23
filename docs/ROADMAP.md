# Bolo Code 路线图

## Phase 0 — 仓库与契约（当前）

- [x] 仓库骨架 monorepo
- [x] 架构 / Hook / 参考文档
- [ ] git remote → `https://github.com/TheLostRiver/bolo-code.git`
- [ ] 共享类型：`HookEvent`、Message、Session、ToolSpec

## Phase 1 — Headless Core 骨架

- [ ] Session 状态机（idle → running → awaiting_permission → …）
- [ ] HookBus：10 事件 + command 执行器
- [ ] 假 Provider（固定脚本回复 / 录制回放）做端到端
- [ ] 内置工具最小集：Read / Write / Bash（沙箱可后置）
- [ ] PermissionGate + 内存审批回调

**完成标准**：无 UI 下，Node 脚本能跑完一轮「提问 → tool → 结束」，hooks 可拦截 Bash。

## Phase 2 — 扩展面

- [ ] Skills 加载（user + project）
- [ ] MCP client（stdio）→ 工具注册为 `mcp__*`
- [ ] 插件清单 `bolo.plugin.json` + contributes 合并
- [ ] 子代理：explore / general，SubagentStart/Stop

**完成标准**：项目目录放 skill + mcp.json + hook 即可生效，无需改 core 代码。

## Phase 3 — Electron GUI

- [ ] `apps/desktop`：会话列表、流式消息、工具卡片
- [ ] PermissionRequest 对话框（Allow / Deny / Always）
- [ ] Settings：模型、MCP、Hooks、Skills
- [ ] 主进程托管 Runtime，渲染进程只订阅事件

**完成标准**：Windows 上可打包启动，完成一次真实（或 mock）编码会话。

## Phase 4 — 生产可用

- [ ] 多 Provider（OpenAI 兼容 + Anthropic）
- [ ] Compaction（manual/auto）+ Pre/PostCompact
- [ ] 会话持久化与 resume
- [ ] 基础安全：命令审批策略、路径白名单
- [ ] CLI 入口复用 core
- [ ] macOS / Linux 构建

## Phase 5 — 体验与生态

- [ ] 插件市场/本地安装 UX
- [ ] 更丰富内置子代理
- [ ] 可观测：结构化 trace（本地）
- [ ] apply_patch 高级 diff UI

## 里程碑优先级

```
契约与 Hook  >  Core 循环  >  扩展加载  >  GUI  >  多模型与持久化
```

GUI 很重要，但**没有稳定 core 的 GUI 会变成第二套业务逻辑**——禁止。