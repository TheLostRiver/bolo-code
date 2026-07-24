# Bolo Code Hook 规范

对齐 Claude Code / HelsincyCode 的事件语义，作为 Bolo 的**最低契约**。  
实现可简化，**事件名与 matcher 语义不可随意改名**。

## 1. 最低 10 个事件

| Event | Matcher 字段 | Matcher 取值 / 说明 |
|-------|--------------|---------------------|
| **PermissionRequest** | `tool_name` | 含 Bash、`apply_patch*`、MCP tool 名等 |
| **PostToolUse** | `tool_name` | 见 Tool coverage |
| **PostCompact** | `trigger` | `manual` \| `auto` |
| **PreCompact** | `trigger` | `manual` \| `auto` |
| **PreToolUse** | `tool_name` | 见 Tool coverage |
| **SessionStart** | `source` | `startup` \| `resume` \| `clear` \| `compact` |
| **SubagentStart** | `subagent_type` / `agent_type` | 取决于启动的子代理类型 |
| **SubagentStop** | `subagent_type` / `agent_type` | 取决于结束的子代理类型 |
| **UserPromptSubmit** | *not supported* | 任意 matcher **忽略**，始终触发已配置 hooks |
| **Stop** | *not supported* | 任意 matcher **忽略**，始终触发已配置 hooks |

> 用户原文：`UserPromptSubmit` / `Stop` 的 matcher 不支持——配置了也会被忽略。Bolo **必须**遵守。

## 2. 配置形状（DSL）

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node ./hooks/audit-bash.js",
            "timeout": 30
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "echo prompt-received" }
        ]
      }
    ]
  }
}
```

字段：

- `matcher`：字符串；支持精确名或前缀/通配（实现阶段定：先精确 + `*` 后缀）
- `hooks[]`：同一 matcher 下可挂多个；顺序执行（除非 `async`）
- `type`：v1 仅 `command`；预留 `http` / `prompt` / `agent`

## 3. 公共输入（stdin JSON）

所有 hook 至少收到：

```ts
type HookBaseInput = {
  hook_event_name: HookEvent
  session_id: string
  cwd: string
  timestamp: string // ISO
}
```

### 3.1 PermissionRequest

```ts
type PermissionRequestInput = HookBaseInput & {
  hook_event_name: 'PermissionRequest'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
}
```

期望输出（stdout JSON，可选）：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": "allow" | "deny" | "ask"
  }
}
```

- exit 0：采用 hook 决策（若有）
- 其他：仅向用户展示 stderr，默认回落 UI 询问

### 3.2 PreToolUse

```ts
type PreToolUseInput = HookBaseInput & {
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
}
```

- exit 0：继续  
- exit 2：**阻止** tool，stderr 给模型  
- 其他：stderr 给用户，仍执行 tool  

可选：stdout 修改 `tool_input`（v1 可后置）。

### 3.3 PostToolUse

```ts
type PostToolUseInput = HookBaseInput & {
  hook_event_name: 'PostToolUse'
  tool_name: string
  tool_input: unknown
  tool_response: unknown
  tool_use_id: string
}
```

- exit 0：stdout 可进 transcript  
- exit 2：stderr 立即给模型  
- 其他：stderr 仅用户  

### 3.4 PreCompact / PostCompact

```ts
type CompactInput = HookBaseInput & {
  hook_event_name: 'PreCompact' | 'PostCompact'
  trigger: 'manual' | 'auto'
  // PostCompact 额外：summary?: string
}
```

**PreCompact**

- exit 0：stdout 可作为 compact 附加指令  
- exit 2：**阻止** compaction  
- 其他：提示用户但继续 compact  

**PostCompact**

- exit 0：stdout 给用户  
- 其他：stderr 给用户  

### 3.5 SessionStart

```ts
type SessionStartInput = HookBaseInput & {
  hook_event_name: 'SessionStart'
  source: 'startup' | 'resume' | 'clear' | 'compact'
}
```

- exit 0：stdout 可注入会话上下文  
- blocking error 可忽略（与 CC 一致：启动不被 hook 轻易打死）  
- 其他：stderr 用户可见  

### 3.6 SubagentStart / SubagentStop

```ts
type SubagentLifecycleInput = HookBaseInput & {
  hook_event_name: 'SubagentStart' | 'SubagentStop'
  agent_id: string
  agent_type: string // explore | shell | general | plugin-defined
  // SubagentStop 可含 agent_transcript_path?: string
}
```

**SubagentStart**

- exit 0：stdout 给子代理  
- blocking 忽略  
- 其他：stderr 用户  

**SubagentStop**

- exit 0：无展示  
- exit 2：stderr 给子代理并**继续跑**  
- 其他：stderr 用户  

### 3.7 UserPromptSubmit

```ts
type UserPromptSubmitInput = HookBaseInput & {
  hook_event_name: 'UserPromptSubmit'
  prompt: string
}
```

- **matcher 忽略**  
- exit 0：stdout 可附加给模型  
- exit 2：**阻止**处理，抹掉原 prompt，stderr 仅用户  
- 其他：stderr 用户  

### 3.8 Stop

```ts
type StopInput = HookBaseInput & {
  hook_event_name: 'Stop'
  // 可选：stop_reason, last_assistant_message
}
```

- **matcher 忽略**  
- exit 0：无展示  
- exit 2：stderr 给模型并**继续对话**  
- 其他：stderr 用户  

## 4. Tool coverage（matcher 用）

v0 内置建议名：

| tool_name | 说明 |
|-----------|------|
| `Bash` | shell |
| `Read` | 读文件 |
| `Write` | 写文件 |
| `Edit` / `apply_patch` | 补丁编辑（PermissionRequest 支持 `apply_patch*`） |
| `Glob` / `Grep` | 搜索 |
| `mcp__*` | 所有 MCP 工具 |

PermissionRequest 文档要求：**Bash、apply_patch\*、MCP 名**必须可匹配。

## 5. HookBus 伪代码

```ts
// packages/hooks — 纯调度，无 UI
type HookEvent =
  | 'PermissionRequest' | 'PostToolUse' | 'PostCompact' | 'PreCompact'
  | 'PreToolUse' | 'SessionStart' | 'SubagentStart' | 'SubagentStop'
  | 'UserPromptSubmit' | 'Stop'

const NO_MATCHER: ReadonlySet<HookEvent> = new Set([
  'UserPromptSubmit',
  'Stop',
])

async function runHooks(event: HookEvent, input: HookBaseInput, cfg: HooksConfig) {
  const groups = cfg[event] ?? []
  const matched = groups.filter(g =>
    NO_MATCHER.has(event) ? true : matcherHits(g.matcher, input)
  )
  // 顺序执行 command hooks；收集 exitCode / stdout / stderr / json
  return reduceHookResults(await mapSerial(matched.flatMap(g => g.hooks), runOne))
}
```

## 6. 与 Runtime 的挂载点

| 时机 | 调用 |
|------|------|
| 会话创建 / resume / clear / compact 后新开 | `SessionStart` |
| 用户提交输入 | `UserPromptSubmit` |
| 工具执行前 | `PreToolUse` → 若需权限 `PermissionRequest` |
| 工具执行后 | `PostToolUse` |
| compact 前后 | `PreCompact` / `PostCompact` |
| 子代理起停 | `SubagentStart` / `SubagentStop` |
| 一轮回复将结束 | `Stop` |

顺序硬约束：

```
PreToolUse → (PermissionRequest?) → tool body → PostToolUse
```

禁止：先执行 tool 再补 PreToolUse。

### 超时与取消（硬化）

| 项 | 行为 |
|----|------|
| `timeout` | command 秒数；默认 **30**；上限 **600**（`clampHookTimeoutSec`） |
| 超时 | kill 子进程；`exitCode=124`；stderr 含 `hook timeout`；`timedOut: true` |
| AbortSignal | `runHooks(..., { signal })`；取消 → `exitCode=130`、`aborted: true` |
| 接线 | Pre/Permission/Post Tool 与 Stop 传 signal；`submitPrompt({ signal })` 透传 |

对照 HC：hook timeout + parent abort；Bolo **无** async hook 注册表 / 遥测。

## 7. 后续可扩展事件（非 v0 必做）

参考 HelsincyCode：`PostToolUseFailure`、`SessionEnd`、`Notification`、`Elicitation` 等。  
**在 10 事件稳定前不扩散。**