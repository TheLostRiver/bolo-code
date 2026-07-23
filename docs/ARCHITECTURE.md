# Bolo Code 架构规划

> 状态：v0 规划稿。目标是**可实现、可演进**，不是一次抄 50 万行。

## 1. 产品定位

**Bolo Code** = 跨平台图形化 AI Coding Agent。

| 维度 | 决策 |
|------|------|
| 桌面壳 | **Electron**（跨平台 UI 一致性优先） |
| 核心 | **Headless Agent Runtime**（与 UI 解耦） |
| 扩展 | Skill / MCP / Hook / 子代理 / 插件 一等公民 |
| 语言 | TypeScript（全栈一致，Electron 天然友好） |
| 包管理 | pnpm workspaces monorepo |

### 明确不做（v0）

- 不 fork HelsincyCode / Claude Code 全量源码当基座（体量与许可证/维护成本不可控）
- 不把 UI 逻辑写进 Runtime
- 不把权限判断散落在各个 Tool 实现里

## 2. 参考项目取舍

| 来源 | 借鉴 | 不借鉴 |
|------|------|--------|
| HelsincyCode / Claude Code 系实现 | Hook 事件模型、Tool 注册、Permission 流、Skill/Plugin/MCP 分层、Query 循环 | 巨型 CLI/Ink 栈、遥测、GrowthBook、50 万行历史包袱 |
| [earendil-works/pi](https://github.com/earendil-works/pi) | 包拆分：`ai` / `agent-core` / coding-agent；多 provider LLM 统一层；agent loop 清晰 | 默认弱权限模型；TUI 为主 |
| [openai/codex](https://github.com/openai/codex) | 本地 agent 产品感、会话/审批 UX、CLI+App 并存思路 | Rust 主栈（我们选 TS+Electron） |

**原则**：只抽「职责边界 + 事件语义 + 数据流」，不复制实现细节。

## 3. 分层架构

```
┌─────────────────────────────────────────────────────────┐
│  apps/desktop (Electron)                                │
│  - main: 窗口、OS 集成、安全边界、IPC 宿主                │
│  - preload: 白名单 bridge                               │
│  - renderer: 会话 UI、权限对话框、工具轨迹、设置         │
└───────────────────────────┬─────────────────────────────┘
                            │ IPC / Event Bus
┌───────────────────────────▼─────────────────────────────┐
│  packages/core  Agent Runtime（无 UI）                   │
│  Session → Prompt → Model → ToolLoop → Compact → Stop   │
│  + HookBus + PermissionGate + SubagentScheduler         │
└─┬─────────┬─────────┬─────────┬─────────┬───────────────┘
  │         │         │         │         │
  ▼         ▼         ▼         ▼         ▼
skills   mcp-host  plugins   tools    providers
```

### 模块职责（第一优先级）

| 包 | 职责 | 禁止 |
|----|------|------|
| `packages/core` | 会话状态机、query 循环、hook 调度、子代理编排、compaction | 直接操作 DOM / Electron API |
| `packages/tools` | 内置工具：Bash、读改写文件、apply_patch、搜索等 | 自己决定 allow/deny（必须走 PermissionGate） |
| `packages/hooks` | Hook 类型、matcher、执行器、退出码语义 | 业务 tool 实现 |
| `packages/skills` | Skill 发现、加载、注入 prompt/tools | 网络协议 |
| `packages/mcp` | MCP client、tools/resources 映射 | UI |
| `packages/plugins` | 插件清单、激活、贡献点合并 | 绕过 hook/permission |
| `packages/providers` | 多模型 API 适配（OpenAI / Anthropic / 兼容端点） | 会话策略 |
| `packages/shared` | 事件、消息、配置 schema、错误类型 | 副作用 |
| `apps/desktop` | Electron GUI | 重业务逻辑（只编排 core） |
| `apps/cli`（后期） | 无头/终端入口，复用 core | 复制一套 runtime |

## 4. 核心数据流

### 4.1 主循环（单会话）

```
SessionStart(source)
  → UserPromptSubmit(prompt)
  → [Model stream]
  → 每个 tool_call:
        PreToolUse(tool)
        → PermissionRequest(tool)   // 若需审批
        → execute tool
        → PostToolUse(tool)
  → 可选 PreCompact / PostCompact
  → Stop
```

### 4.2 子代理

```
主会话决定 spawn
  → SubagentStart(type)
  → 子会话独立 transcript + 受限 tool 集
  → SubagentStop(type)
  → 结果回写主会话
```

### 4.3 扩展贡献合并顺序

```
defaults
  → builtin plugins
  → user plugins
  → project plugins
  → project local overrides
  → session runtime overrides
```

冲突策略：后写覆盖前写；同名 tool 必须显式 namespace（`mcp__server__tool`）。

## 5. 状态机（Session）

```
idle
  → starting (SessionStart)
  → ready
  → running (UserPromptSubmit 后)
  → awaiting_permission (PermissionRequest 挂起)
  → compacting (PreCompact → … → PostCompact)
  → stopping (Stop)
  → ended
```

子状态：`streaming_model` / `executing_tools` / `spawning_subagent`。

## 6. 必备能力面

### 6.1 Skills

- 目录约定：`~/.bolo/skills/`、`.bolo/skills/`、插件内 `skills/`
- 每个 skill：`SKILL.md`（frontmatter + 指令）+ 可选 scripts
- 运行时：发现 → 索引 → 按触发/显式 `/skill` 注入上下文

### 6.2 MCP

- 传输：stdio / SSE（后续 HTTP）
- 能力：tools、resources、prompts（按优先级落地 tools）
- 命名：`mcp__<server>__<tool>`，PermissionRequest / PreToolUse matcher 可匹配

### 6.3 Hooks（详见 [HOOKS.md](./HOOKS.md)）

最低 10 事件：

1. PermissionRequest  
2. PostToolUse  
3. PostCompact  
4. PreCompact  
5. PreToolUse  
6. SessionStart  
7. SubagentStart  
8. SubagentStop  
9. UserPromptSubmit  
10. Stop  

执行类型（v1）：`command`（shell）→ 后续 `http` / `prompt`。

### 6.4 子代理

- 类型：至少 `explore` / `shell` / `general`（可配置扩展）
- 隔离：独立 session id、独立 hook 上下文、可裁剪 tools
- 生命周期事件：SubagentStart / SubagentStop

### 6.5 插件

- 清单：`bolo.plugin.json`（id、version、contributes）
- 可贡献：skills、hooks、mcp servers、agents、commands、tools
- 激活范围：user / project / session

## 7. Electron 边界

```
Renderer  ──IPC──►  Main  ──invoke──►  Core Runtime
   ▲                  │
   └── events ◄───────┘  (stream tokens, tool progress, permission ask)
```

安全：

- `contextIsolation: true`，无 `nodeIntegration`
- preload 仅暴露白名单 API
- 危险 tool 默认需 PermissionRequest
- 密钥只存 main / OS keychain，不进 renderer 明文日志

## 8. 配置布局（规划）

```
~/.bolo/
  config.json
  skills/
  plugins/
  mcp.json
  hooks.json          # 或并入 config
  sessions/

.project/
  .bolo/
    config.json
    skills/
    hooks.json
```

## 9. 实现顺序（与 ROADMAP 对齐）

1. monorepo + shared types + HookBus 契约  
2. core session 状态机 + 假 model（回放）  
3. 内置 tools + PermissionGate  
4. Skills / MCP / Plugins 加载器  
5. 子代理  
6. Electron 最小聊天 + 权限弹窗  
7. 真 model provider + compaction  

## 10. 架构红线

1. **职责分明 > 优雅代码 > 功能堆砌**  
2. UI 不得直接执行 shell/MCP；一律经 core  
3. Hook 是横切能力，禁止在 tool 内 if-else 复制 hook 逻辑  
4. 复杂度扩散（参数爆炸、数据流回溯）时先拆模块，不先加 flag  
5. Functional + DSL 风格优先（配置即数据、pipeline 可组合）