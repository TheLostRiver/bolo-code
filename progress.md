# Progress Log

## Session: M-Subagent S0–S6（真 subagent loop）

- `docs/SUBAGENT.md`：类型、工具策略、禁递归、完成定义
- `packages/core/src/subagent.ts`：
  - `AgentDefinition` + 内置 `explore` / `general`
  - `resolveAgentTools`（始终排除 Agent）
  - `runSubagent`：SubagentStart → 独立 messages + queryLoop → 摘要 → SubagentStop
  - `createAgentTool` / `createDefaultTools`（builtins + Agent）
  - `spawnSubagentStub` → 真 `spawnSubagent`（兼容别名）
- `submitPrompt` 注入 `createDefaultTools()`；tool 执行经 `extras.subagentParent` 传父上下文
- `scripts/test-subagent.ts` mock 父子两轮
- smoke-turn 移除 stub 假完成
- 测试：test-subagent / smoke-turn / test-tool-calling 全绿
- TODO / ROADMAP 勾选 S0–S6

## 默认下一刀

P2-b MCP stdio，或 S7 `.bolo/agents` 目录定义