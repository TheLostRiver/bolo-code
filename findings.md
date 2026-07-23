# Findings & Decisions — Bolo Code

## Requirements

- 跨平台图形化 agent → Electron
- Skill / MCP / Hook / 子代理 / 插件
- 至少 10 个 Hook（见 docs/HOOKS.md）
- **新约束（用户）**：HelsincyCode 架构优秀，应参考；**不要遥测**；功能先看参考实现再自己写，禁止瞎写

## Research Findings

### HelsincyCode 架构精华（逻辑结构，无本机路径）

#### A. 主循环与 Tool 管道

| 逻辑模块 | 职责 |
|----------|------|
| query / QueryEngine | 一轮对话：调模型 → 收集 tool_use → 跑 tools → 回灌 |
| Tool 契约 | 统一 name / 校验 / 执行 / 权限相关元数据 |
| toolOrchestration | 多 tool：只读可并发、副作用串行（v1 可全串行） |
| toolExecution | **单 tool**：查找 → PreHook → permission → execute → PostHook |
| toolHooks | Pre/Post 与 permission 决策交叉 |

**Bolo 对齐点**：`packages/core` 只做编排；`packages/tools` 只做执行；`packages/hooks` 只做调度。  
**显式删除**：参考代码中的 analytics `logEvent` 链 —— 我们不实现。

#### B. 扩展面

| 能力 | 参考职责 | 正确借鉴方式 |
|------|----------|--------------|
| Hook | 事件名、matcher、exit code、stdin JSON | 以用户 10 事件为最小集；字段对照 hook 输入类型 |
| MCP | 连接管理、工具列表、call、命名 | 配置→连接→listTools→`mcp__server__tool`→call；无连接不算完成 |
| Skills | 目录发现、注入上下文 | SKILL.md + 发现路径；不做实验性 skill search |
| Plugins | contributes 合并 | manifest 贡献 skills/hooks/mcp/agents |
| Subagent | Agent tool + Start/Stop hook | 独立上下文 + 生命周期事件 |

#### C. 明确不借

- `services/analytics`、datadog、growthbook、first-party event logger
- Ink / 巨型 REPL UI
- 远程 managed settings / OAuth 产品链（除非日后单独立项）
- 大量 compile-time feature flag 迷宫

### pi / Codex（辅助）

- pi：包边界（ai / agent-core / 产品壳）值得对齐 monorepo
- Codex：多入口产品感；栈不跟 Rust

### 当前 Bolo 代码审计（相对「瞎写」）

| 项 | 判断 |
|----|------|
| Hook 事件与 matcher | 有依据（用户 + CC 语义） |
| Session + mock 模型 smoke | 合理的窄链路 |
| Bash/Read/Write | 合理最小工具 |
| MCP mock invoke 当完成 | **不当**；仅可作占位并文档标明 |
| **`messages.slice(-N)` 当 compact** | **错误**；已删除，见 COMPACTION.md + packages/compact |
| 无参考映射就堆 Phase 4–6 | **停止**；按 ENGINEERING_PRINCIPLES 清单推进 |

## Technical Decisions

| 决策 | 理由 |
|------|------|
| 工程纪律文档 | 用户明确要求先借鉴再实现 |
| 零遥测 | 用户明确；也减攻击面与噪音 |
| v1 tool 全串行 | 参考有并发，但正确性优先 |
| MCP 完成定义 = 真协议路径 | 避免假完成 |
| **Compact = LLM 摘要管道** | 对照 compactConversation；无 summarizer 则失败 |

## 借鉴清单（进行中）

### 功能: Agent loop（本回合）

- 参考模块: `query.ts` queryLoop、`query/deps.ts`、`toolOrchestration.runTools`、`toolExecution.runToolUse`
- 输入/输出: messages + deps → stream model → tool batches → continue / Terminal
- 状态/副作用: 仅 messages 追加与 tool 副作用；无 analytics
- 与 Hook/Permission 交叉: 单 tool 内 Pre → PermissionRequest → Exec → Post；turn 末 Stop
- Bolo 落点: packages/core/{deps,queryLoop,toolExecution,toolOrchestration,index}.ts
- 本切片不做: 只读并发、流式 tool、PermissionMode 表、microcompact 真实现
- 验收: smoke PASS + 代码路径与 AGENT_LOOP.md 一致

### 功能: 上下文压缩 Full compact

- 见 COMPACTION.md；已独立 packages/compact

### 功能: PermissionMode（未开工）

- 对照 PermissionMode.ts：default / acceptEdits / plan / bypassPermissions

### 功能: MCP（未开工）

- 须先读参考 mcp client 再写

## Resources

- docs/AGENT_LOOP.md
- docs/COMPACTION.md
- docs/ENGINEERING_PRINCIPLES.md

## Issues Encountered

| 问题 | 处理 |
|------|------|
| 旧 submitPrompt 内联 loop | 改为 queryLoop |
| 伪 compact slice | 已删 |
| 文档路径泄露 | 已脱敏 |