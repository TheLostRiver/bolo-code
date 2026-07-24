# Slash 命令契约（最小）

> 无遥测。对照 HelsincyCode 行首 `/` 语义再实现；不抄 Claude 商标。

## 解析

| 输入 | 结果 |
|------|------|
| 空白 | `empty` |
| 行首 `/` 且非 `//` | `command`：`name`（小写）+ `args`（余下 trim） |
| 行首 `//` 或其它 | `prompt`：整行原文交给 LLM |

入口：`parseSlashLine(text)` → `submitUserInput(session, text)`。

- 命令：本地执行，返回 `{ type: 'slash', message }`，**不**调用 `submitPrompt`。
- 普通输入：走现有 `submitPrompt` → `{ type: 'prompt', terminal }`。

## 内置命令（P0）

| 命令 | 行为 |
|------|------|
| `/help` | 列出命令 |
| `/clear` | 清空 `messages`；保留 id / cwd / config / `systemPromptSections` |
| `/compact [note]` | `compactSession`；无 summarizer 时返回错误文案 |
| `/context` | 消息数、字符粗算、permissionMode、model、effort、cwd、id、usage 一行 |
| `/doctor` · `/status` | 本地诊断：node/platform、cwd/id/**provider**/mode/model/effort、tools/skills/agent types、**mcp 连接数**、usage、autoCompact/maxPtlRetries、`getBoloHomeDir()` 是否存在；无遥测 |
| `/mcp` · `/mcp tools` | 列出已连接 MCP 服务器；`tools` 列出 `mcp__server__tool` 名 |
| `/cost` · `/usage` | 会话内本地 token 累计（`session.usage`）；无遥测、不上报 |
| `/model [name]` | 无参显示；有参设 `session.model` |
| `/effort [low\|medium\|high\|max\|auto]` | 会话字段 `effortLevel`；`auto` 清除覆盖；经 `mapEffort` 映射为 `max_tokens` |
| `/plan` | `permissionMode = plan` |
| `/permissions [mode]` | 无参列出四档；有参切换 |

REPL 额外：`/exit` `/quit` 由 CLI 处理（退出循环，不进总线）。

## 本地 usage（`/cost`）

- 字段：`session.usage?: { inputTokens, outputTokens, totalTokens, calls, estimated? }`
- 每轮 `callModel` 成功后累加：若 stream 有 `usage` 事件则用其；否则 `chars/4` 估算并标 `estimated`
- **仅会话内存**；不写遥测、不上传

## CLI

- resume 与新会话的 readline 均经 `runOnePrompt` → `submitUserInput`。
- 模块：`packages/core/src/slash.ts`；导出见 `@bolo/core`。

## 非目标（本切片）

- skill 回落 `/skills`、插件命令、远程/账号类命令
- effort → thinking / reasoning 强度（目前仅 max_tokens）
- 遥测 / 远程 cost 账单