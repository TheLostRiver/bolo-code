# Slash 命令契约（最小）

> 无遥测。对照参考实现行首 `/` 语义再实现；不抄 Claude 商标。

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
| `/help` | **分组**列出命令（Session / Model & permissions / Extensions / Diagnostics）；隐藏别名行；提示 aliases 与 skill 调用 |
| `/clear` | 清空 `messages`；保留 id / cwd / config / `systemPromptSections` |
| `/title [text]` | 无参显示 jsonl 最后标题；有参 **append** `title` entry（last-wins；**不进**模型链；rewrite 时保留） |
| `/note [[kind:]text]` | 无参列出最近 system_note；有参 **append** `system_note`（**不进**模型链；rewrite 保留；可选 `kind:text`） |
| `/compact [note]` | `compactSession`；成功后报告 messages token 前后与节省量；无 summarizer 时错误文案 |
| `/autocompact [on\|off]` | 会话级 auto compact 开关；无参显示 on/off + summarizer + 环境熔断；重挂 prepare 链 |
| `/context` | 消息数、字符粗算、**tokens 分拆（messages + system）**、**window / auto threshold / pressure**、permissionMode、model、effort、cwd、id、**各 system section 标签·长度·token**、**cache + prepare 顺序**、usage 一行；提示 `/autocompact` |
| `/doctor` · `/status` | 本地诊断：node/platform、cwd/id/**provider**/mode/model/effort、messages/sections、tools/skills/agent types、**mcp 连接数 + 失败摘要**、usage、autoCompact/maxPtlRetries、`getBoloHomeDir()` 是否存在；无遥测；`/status` 为隐藏别名 |
| `/memory` · `/memory path` | 跨会话 **MEMORY.md** 路径 / 开关 / 是否存在 / 截断信息 / 预览（见 `docs/MEMORY.md`）；`path` 仅路径 |
| `/mcp` · `/mcp status` · `/mcp tools` | 已连接 MCP：**transport / status / live / caps / 脱敏 endpoint**；`status` 含 **failures + configWarnings**；`tools` 列 `mcp__server__tool` |
| `/plugins` · `/plugins commands` · `/plugins reload` | 列本地插件；插件 slash；热重载（PL2） |
| `/plugins market` · `search` · `install` · `uninstall` | **PL-MKT 最小市场**：注册清单 / 搜索 / 安装到 plugins 目录（见 `docs/PLUGINS.md`） |
| `/hooks` · `/hooks <Event>` | 列出已配置 hook 事件与命令数；指定事件打印 matcher/command |
| `/init` · `/init all\|user\|project` | 确保 `~/.bolo` / 项目 `.bolo` 布局（skills/plugins/sessions/rules/agents/memory + 默认 json） |
| `/cost` · `/usage` | 会话内本地 token 累计 + **cache + by-model breakdown**（`session.usage`）；无遥测、不上报；`/usage` 为隐藏别名 |
| `/model [name]` | 无参显示；有参设 `session.model` |
| `/effort [low\|medium\|high\|max\|auto]` | 会话字段 `effortLevel`；`auto` 清除覆盖；非法参数返回 **Usage** 文案 |
| `/thinking [on\|off]` | 会话 `showThinking`（默认 **on**）：CLI 是否渲染思考链；off 仍解析不渲染 |
| `/thinking persist [on\|off]` | 会话 `persistReasoning`（默认 **off**）：是否写入 `assistant.reasoning_content` 供 openai-compatible 回灌 |
| `/plan` | `permissionMode = plan` |
| `/permissions [mode]` | 无参列出四档；有参切换；非法参数返回 **Usage** 文案 |
| `/allow [ToolName \| path:GLOB \| bash:PATTERN]` | 会话 always-allow：工具名 / 路径 glob / Bash 模式（前缀·通配·`:*`）；无参列出 |
| `/deny [ToolName \| path:GLOB \| bash:PATTERN \| prefix:PFX]` | 会话 **always-deny**（硬规则，赢过 bypass/allow）；无参列出 |

REPL 额外：`/exit` `/quit` 由 CLI 处理（退出循环，不进总线）。

## 体验打磨（SL-polish）

- **未知命令**：提示 `/help`、`/skills`；对相近内置名给出 `Did you mean: /x, /y?`（编辑距离 / 前缀）。
- **参数错误**：`/effort`、`/thinking`、`/permissions` 等返回明确 Usage，而非含糊 “unknown”。
- **别名**：`/status`→`/doctor`，`/usage`→`/cost`；`/help` 不单独占行，脚注说明。

## 思考链显示（`/thinking`）— RC2 + RC3

- 默认 **on**；`session.showThinking !== false` 时 CLI 打印机渲染 `SessionEvent.reasoning`（dim + `thinking ` 前缀）。
- `/thinking off`：打印机跳过 reasoning；provider **仍解析**并转发事件。
- `/thinking persist on`：写入 `assistant.reasoning_content`（openai-compatible 回灌）；**默认 off**；**勿**用于 Anthropic 签名块。
- Anthropic 请求侧：`anthropicThinking` → `budget_tokens`（最小）；adaptive 后置。
- 快照 / JSONL meta：`showThinking: false` / `persistReasoning: true` 显式落盘。

## 本地 usage（`/cost`）— Usage+

- 字段：`session.usage?: { inputTokens, outputTokens, totalTokens, calls, estimated?, cacheReadInputTokens?, cacheCreationInputTokens?, byModel? }`
- 每轮 `callModel` 成功后累加：若 stream 有 `usage` 事件则用其（含 cache 字段）；否则 `chars/4` 估算并标 `estimated`
- **by model**：按 `session.model` 分桶（`byModel[model]`）
- **cache**：解析 Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`；OpenAI `prompt_tokens_details.cached_tokens` / Responses `input_tokens_details.cached_tokens`
- `/cost` · `/usage`：总量 + cacheRead/cacheWrite + by model 行；`/context` · `/doctor` 一行摘要含 cache
- 快照 / JSONL meta 持久化上述字段；**仅本地**；不写遥测、不上传、不做远程账单 USD

## CLI

- resume 与新会话的 readline 均经 `runOnePrompt` → `submitUserInput`。
- 模块：`packages/core/src/slash.ts`；导出见 `@bolo/core`。

## 插件 slash（PL2 最小）

- 插件 `commands/*.md`（或 `contributes.commands`）→ 名默认 `plugin-id:basename`
- 调用：`/plugin-id:cmd` → 将 markdown body **注入**为一条 user 消息（不立刻调 LLM）
- 内置 slash 优先于插件命令；再回落 skill id
- 热加载：`/plugins reload` 重扫磁盘并刷新 `session.skills` / hooks / pluginCommands / skill catalog；默认重连 MCP

## 非目标（本切片）

- 插件市场、远程安装、账号类命令
- 插件 command 参数替换 / 完整 prompt 模板引擎
- effort → thinking / reasoning 强度（目前仅 max_tokens；Anthropic budget 后置）
- 思考链安全回灌进 ChatMessage / 伪造不支持模型的假思考
- 遥测 / 远程 cost 账单 / 按价目表强制 USD