# Bolo Code 整体路线图

> 更新：对照仓库现状重排。  
> 原则：先借鉴 HelsincyCode / pi / Codex 语义，再实现；**无遥测**；不瞎写。  
> 详细设计见各专项文档，本文件只回答 **做到哪 / 下一刀 / 验收**。

## 0. 产品目标（不变）

| 目标 | 说明 |
|------|------|
| 跨平台 GUI | Electron（一致性优先） |
| Headless Core | 可 CLI / GUI / 自动化复用 |
| 扩展面 | Skill · MCP · Hook · 子代理 · 插件 |
| 工程纪律 | 对照参考再写；文档无本机路径 |

**优先级（硬）：**

```
契约与文档
  → Agent loop + Hook + Permission（可测）
  → Compact / 真 Provider
  → Skills / MCP / Plugins / Subagent（真能力，非 mock 冒充完成）
  → Electron GUI（只订阅 core）
  → 持久化 · 打包 · 体验
```

---

## 1. 当前水位（已完成）

### M0 — 仓库与契约 ✅

| 交付 | 位置 |
|------|------|
| monorepo 骨架 | `packages/*` · `apps/desktop` 占位 |
| 架构 / 原则 / 参考 | `docs/ARCHITECTURE.md` · `ENGINEERING_PRINCIPLES.md` · `REFERENCES.md` · `DEEP_ANALYSIS.md` |
| Hook 契约（≥10 事件） | `docs/HOOKS.md` · `packages/shared` · `packages/hooks` |
| Agent loop 对照说明 | `docs/AGENT_LOOP.md` |
| Compact 设计（禁止 slice） | `docs/COMPACTION.md` · `packages/compact` |
| 权限四档对照说明 | `docs/PERMISSIONS.md` · `packages/permissions` |
| 远程仓库 | `bolo-code` · main |

### M1 — Headless Core 窄链路 ✅

| 交付 | 位置 / 验收 |
|------|-------------|
| QueryDeps + queryLoop | `packages/core/src/{deps,queryLoop}.ts` |
| runTools 串行 + runToolUse | Pre → **PermissionGate** → hooks/UI → exec → Post |
| Session 外壳 | `createSession` / `submitPrompt` / `compactSession` |
| 内置工具 | Bash / Read / Write / apply_patch… · `packages/tools` |
| Mock Provider | `packages/providers` |
| HookBus command | exit 2 block · PreCompact inject 等 |
| 权限模式 v1 | `default` / `acceptEdits` / `plan` / `bypassPermissions` |
| 测试 | `test-compact` · `test-permissions` · `smoke-turn` **曾绿** |

**窄链路验收（已达）：**

```
SessionStart → UserPromptSubmit → callModel
  → PreToolUse → gate(mode) → PermissionRequest? → tool → PostToolUse
  → Stop → Terminal(completed)
```

### 明确「有骨架、未完成」

| 模块 | 状态 | 完成定义（未达） |
|------|------|------------------|
| Skills | 发现/加载草稿 | 进 system 上下文并在真实 turn 生效 |
| MCP | 命名 + mock invoke | **stdio 真连接** listTools/callTool |
| Plugins | contributes 合并草稿 | 项目插件目录热加载验收 |
| Subagent | Start/Stop stub | 独立 loop + 工具裁剪 + 结果回写 |
| Compact | full 管道 + fake summarizer | **真模型 no-tool summarizer** + auto 挂 prepareMessages |
| Providers | 仅 mock | OpenAI 兼容 / Anthropic 真流式 |
| Electron | README 占位 | 可开窗完成一轮会话 |

---

## 2. 下一阶段（建议顺序）

### M2 — Core 变「真能干活」（优先）

对照 HelsincyCode，**不扩 GUI**。

| # | 切片 | 借鉴焦点 | 验收 |
|---|------|----------|------|
| 2.1 | **真 Provider** | 流式 text + tool_call 解析 | 配置 API 后 `submitPrompt` 真模型一轮 |
| 2.2 | **Compact 接真模型** | `compactConversation` + prompt 约束 | manual compact 产生可用摘要；失败不毁 messages |
| 2.3 | **auto compact 挂点** | `autoCompact` 阈值 + 熔断 | `prepareMessages` 达阈值触发；`querySource=compact` 不递归 |
| 2.4 | **权限加深（可选）** | 规则 allow/deny 持久化 | Always allow 会话级；仍无遥测 |
| 2.5 | **Tool 契约收紧** | Tool 注册/校验形状 | 未知 tool 明确错误；输入 schema 最小校验 |

**M2 完成标准：** 无 Electron，仅 CLI/smoke 脚本，能对真实仓库「提问 → 读改文件/Bash（按模式）→ 压缩 → 续聊」。

### M3 — 扩展面（每项先写 findings 借鉴清单）

| # | 切片 | 完成标准（禁止 mock 冒充） |
|---|------|---------------------------|
| 3.1 | **Skills** | `.bolo/skills/*/SKILL.md` 注入；可 `/skill` 或自动发现 |
| 3.2 | **MCP stdio** | 配置 → spawn → listTools → `mcp__server__tool` → call |
| 3.3 | **Plugins** | `bolo.plugin.json` contributes 合并进 session |
| 3.4 | **Subagent** | explore/general：独立 messages + SubagentStart/Stop + 结果回主会话 |

**M3 完成标准：** 只改项目配置/目录即可扩展行为，不改 core 业务代码。

### M4 — Electron GUI

| # | 切片 | 说明 |
|---|------|------|
| 4.1 | 主进程托管 Runtime | IPC 白名单；renderer 无 node 执行 |
| 4.2 | 会话 UI | 流式文本、工具卡片、事件时间线 |
| 4.3 | 权限对话框 | Allow / Deny / Always（会话）· 模式切换 UI |
| 4.4 | 设置 | 模型、MCP、Hooks、Skills、权限模式 |
| 4.5 | Windows 打包 | 可安装/便携跑通 mock 或真模型一轮 |

**M4 完成标准：** GUI **只编排 core 事件**，无第二套业务逻辑。

### M5 — 生产化

| # | 切片 |
|---|------|
| 5.1 | 会话持久化 / resume / transcript |
| 5.2 | CLI 入口复用 core |
| 5.3 | macOS / Linux 构建 |
| 5.4 | microcompact（清旧 tool_result） |
| 5.5 | apply_patch 真 diff + UI |
| 5.6 | 本地结构化 trace（**不上报**） |

### M6 — 体验与生态（后置）

- 插件本地安装 UX  
- 更多内置子代理类型  
- 企业策略（hooks 打包、权限策略模板）  
- **不做**：远程遥测、GrowthBook、phone-home  

---

## 3. 里程碑一览

```mermaid
flowchart LR
  M0[M0 契约 ✅]
  M1[M1 Core 窄链路 ✅]
  M2[M2 真 Provider + Compact]
  M3[M3 Skills MCP Plugin Subagent]
  M4[M4 Electron GUI]
  M5[M5 生产化]
  M6[M6 体验]
  M0 --> M1 --> M2 --> M3 --> M4 --> M5 --> M6
```

| 里程碑 | 状态 | 一句话 |
|--------|------|--------|
| **M0** | ✅ | 文档与 monorepo |
| **M1** | ✅ | 可测 headless loop + 四档权限 + compact 管道 |
| **M2** | ⬜ 进行中 | 真 Provider ✅ 骨架；真压缩接 Provider ✅；auto 挂点待验证 |
| **M3** | ⬜ | 扩展面真能力 |
| **M4** | ⬜ | Electron 产品壳 |
| **M5** | ⬜ | 持久化 / 多平台 / CLI |
| **M6** | ⬜ | 体验打磨 |

---

## 4. 包职责与演进（避免乱长）

| 包 | 现状 | 下一演进 |
|----|------|----------|
| `shared` | Hook/消息类型 | Provider/会话持久化类型 |
| `hooks` | command HookBus | 配置加载路径 |
| `permissions` | 四档表驱动 | 会话规则表 |
| `tools` | 最小内置 | schema + 更安全 Bash |
| `providers` | mock | OpenAI 兼容 + Anthropic |
| `compact` | full + 测试 | 真 summarizer + micro |
| `core` | queryLoop 管道 | prepareMessages 挂 auto |
| `skills` / `mcp` / `plugins` | 骨架 | M3 真实现 |
| `apps/desktop` | 占位 | M4 |

---

## 5. 每刀工作方式（强制）

1. 在参考项目定位入口与数据流  
2. `findings.md` 写「功能: …」借鉴清单  
3. 只实现映射到的最小切片  
4. 测试/smoke 绿  
5. 更新本 ROADMAP 勾选  

未完成清单 → **不允许**开写大段新模块。

---

## 6. 风险与红线

| 风险 | 缓解 |
|------|------|
| GUI 先于 core | M4 不得早于 M2 基本可用 |
| MCP mock 冒充完成 | M3.2 完成定义 = 真 stdio |
| Compact 再退化成 truncate | 无 summarizer 必须失败 |
| 权限默认过松 | 默认 `askPermission=deny`；bypass 需显式 |
| 范围膨胀抄 50 万行 | 只抄管道与语义 |
| 遥测 | 全阶段禁止 |

---

## 7. 建议的「下一刀」默认选项

若用户不指定，默认推进：

**M2.1 真 Provider（OpenAI 兼容流式）**  
→ 立刻能验证 loop/权限/工具是否在真实模型下成立。

备选：

- **M2.2** Compact 接同一 Provider 的 no-tool 摘要轮  
- **M3.2** MCP stdio（扩展价值高，但依赖配置环境）  
- **M4.1** 仅当 M2 基本可用再开 Electron  

---

## 8. 文档地图

| 文档 | 用途 |
|------|------|
| **本文件** | 整体路线与水位 |
| `ARCHITECTURE.md` | 分层边界 |
| `AGENT_LOOP.md` | loop 对照 |
| `PERMISSIONS.md` | 权限四档 |
| `COMPACTION.md` | 压缩 |
| `HOOKS.md` | Hook 契约 |
| `ENGINEERING_PRINCIPLES.md` | 工程纪律 |
| `task_plan.md` | 会话内短计划（可清空重开切片） |

---

**一句话现状：**  
**M0–M1 已落地（可测 headless agent + 四档权限 + compact 管道）；整体下一主线是 M2 真模型与真压缩，然后扩展面，最后 Electron。**