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

## 输入发现、补全与参数提示（OI-10/OI-12A）

- `getSlashCommandCandidates(session)` 从 `SLASH_COMMANDS`、Plugin command 与
  user-invocable Skill 投影只读展示对象；按真实 dispatch precedence 去重：
  built-in → Plugin → Skill。`user-invocable: false` Skill 不进入候选。
- CLI 通过 `getCliSlashCommandCandidates(session)` 追加自己拥有的 `/exit`、hidden
  `/quit` 与 retained-only `/tools`；输入框只消费 `SlashCommandCandidate[]`，不依赖
  整个 session 或执行函数。
- 裸 `/` 显示全部可见命令；继续输入使用大小写不敏感的 exact/prefix 过滤，精确命中
  优先。不做 substring/fuzzy；`//`、参数和普通文本关闭菜单。
- 菜单打开时 `↑/↓` 循环选择，Tab/Enter 只补为 `/<name> `，Esc 关闭并保留输入；
  菜单关闭后 ↑/↓ 才恢复历史。无匹配显示空态，Enter 仍可提交给未知命令诊断。
- 补全后菜单关闭；精确命令 + 首个尾随空格、光标在末尾且尚无实参时，输入框显示
  candidate 的 dim `argumentHint`。提示不写入输入 state/cursor；输入实参或第二个
  空格后消失。`/effort ` 从当前 provider/model 方言动态投影合法档位，其它内置、
  Plugin 与 Skill 可复用自己的 usage，不在 CLI 另写一份参数常量。
- `/plugins reload` 会原位刷新 `session.pluginCommands` 与 `session.skills`；每次进入
  idle editor 都重新生成候选，所以热加载后的下一次输入立即可发现新命令。

## 内置命令（P0）

| 命令 | 行为 |
|------|------|
| `/help` | **分组**列出命令（Session / Model & permissions / Extensions / Diagnostics）；隐藏别名行；提示 aliases 与 skill 调用 |
| `/clear` | 清空 `messages`；保留 id / cwd / config / `systemPromptSections` |
| `/title [text]` | 无参显示 jsonl 最后标题；有参 **append** `title` entry（last-wins；**不进**模型链；rewrite 时保留） |
| `/note [[kind:]text]` | 无参列出最近 system_note；有参 **append** `system_note`（**不进**模型链；rewrite 保留；可选 `kind:text`） |
| `/compact [note]` | `compactSession`；成功后报告 messages token 前后与节省量；无 summarizer 时错误文案 |
| `/autocompact [on\|off]` | 会话级 auto compact 开关；无参显示 on/off + summarizer + 环境熔断；重挂 prepare 链 |
| `/context [details\|--details]` | 默认建立 `ContextUsageViewModel`：TTY 显示响应式使用率图、window/threshold/pressure、actual/estimated/hybrid 来源与主要分类；非 TTY 输出紧凑文本。`details` 保留消息/system tokens、sections、skills、memory、cache、prepare/compact 等完整诊断 |
| `/turn status` | 显示当前进程 coordinator `idle/running`、active turn 与 live control 历史（pending/ready/promoted/cancelled） |
| `/turn steer <text>` · `/turn interrupt` | 自动携带 snapshot 的 expected active turn；stale/no-active 由 core fail-closed |
| `/turn queue <text>` · `/turn cancel <controlId>` | active 时 pending、idle 时 ready；REPL FIFO drain；pending/ready 可取消；durable 写成功后才交给执行器 |
| `/runtime list [turn\|control\|task]` · `/runtime inspect <turn\|control\|task> <id>` · `/runtime json` | list/inspect 共用 AR1A query selector；`json` 保留 protocol v1 原 snapshot |
| `/runtime interrupt <turnId>` · `/runtime cancel <control\|task> <id>` | 先核对 snapshot expected state，再调用 durable executor；stale target fail-closed |
| `/runtime edit <controlId> <prompt>` · `/runtime remove <controlId>` | 同进程 pending/ready queue 的 append-only 替换/删除；edit 新项追加 FIFO 尾部 |
| `/runtime discard <turn\|control\|task> <id>` | 为 interrupted entity 追加 resolution；保留原 lifecycle |
| `/runtime retry-safe <turn\|control\|task> <id>` | 仅 admitted-only turn / pending-ready queue 可重排为新 turn；其它工作拒绝 |
| `/agents` · `/agents status` | 列 subagent 类型/来源；`status` 显示后台 queued/running/done/error/aborted/interrupted 计数 |
| `/bg` · `/bg status` | 显示后台 taskId、状态、完成时间、usage/worktree 与持久化 warning |
| `/bg cancel <taskId>` | 只取消尚未启动的 queued task；running/terminal/未知 id 均 fail-closed |
| `/doctor` · `/status` | 本地诊断：node/platform、cwd/id/**provider**/mode/model/effort、messages/sections、tools/skills/agent types、**plugins(+warnings)**、**memory user/project 路径**、**mcp 连接数 + 失败摘要**、usage、autoCompact/maxPtlRetries、`getBoloHomeDir()`；无遥测；`/status` 为隐藏别名 |
| `/memory` · `/memory path` · `/memory topics` | 跨会话 **MEMORY.md**：user/project 路径、开关、预览、topic 列表（见 `docs/MEMORY.md`） |
| `/mcp` · `/mcp status` · `/mcp tools` | 已连接 MCP：**transport / status / live / caps / 脱敏 endpoint**；`status` 含 **failures + configWarnings**；`tools` 列 `mcp__server__tool` |
| `/plugins` · `/plugins commands` · `/plugins reload` | 列本地插件；插件 slash；热重载（PL2） |
| `/plugins market` · `search` · `install` · `uninstall` | **PL-MKT 最小市场**：注册清单 / 搜索 / 安装到 plugins 目录（见 `docs/PLUGINS.md`） |
| `/hooks` · `/hooks <Event>` | 列出已配置 hook 事件与命令数；指定事件打印 matcher/command |
| `/init` · `/init all\|user\|project` | 确保 `~/.bolo` / 项目 `.bolo` 布局（skills/plugins/sessions/rules/agents/memory + 默认 json） |
| `/cost` · `/usage` | 会话内本地 token 累计 + **cache + by-model breakdown**（`session.usage`）；无遥测、不上报；`/usage` 为隐藏别名 |
| `/model [name]` | 无参显示；有参设 `session.model` |
| `/effort [list \| auto\|low\|medium\|high\|…]` | **TTY 无参**：箭头选档；文本显示 **choosable** 与 wire 预览。仅允许当前方言可选档（`BOLO_EFFORT_LOOSE=1` 放宽）。Anthropic `max` 有模型门控。见 [EFFORT.md](./EFFORT.md) · [EFFORT_OPTIMIZATION.md](./EFFORT_OPTIMIZATION.md) |
| `/thinking [on\|off]` | 会话 `showThinking`（默认 **on**）：CLI 是否渲染思考链；off 仍解析不渲染 |
| `/thinking persist [on\|off]` | 会话 `persistReasoning`（默认 **off**）：是否写入 `assistant.reasoning_content` 供 openai-compatible 回灌 |
| `/plan` | `permissionMode = plan` |
| `/permissions [mode]` | 无参列出四档；有参切换；非法参数返回 **Usage** 文案 |
| `/allow [ToolName \| path:GLOB \| bash:PATTERN]` | 会话 always-allow：工具名 / 路径 glob / Bash 模式（前缀·通配·`:*`）；无参列出 |
| `/deny [ToolName \| path:GLOB \| bash:PATTERN \| prefix:PFX]` | 会话 **always-deny**（硬规则，赢过 bypass/allow）；无参列出 |

REPL 额外：`/exit` `/quit` 由 CLI 处理（退出循环，不进总线）；`/tools` 只在 retained
TTY 中打开最新工具优先的 picker；有效 ref 按需打开全文 pager，否则回退 bounded
preview；打开/翻页不新增 session 或 provider messages，
plain/non-TTY 保持原有 core unknown-command 行为。`/exit` 与 `/tools` 在裸 `/` 可见，
hidden `/quit` 只在明确输入 `/q…` 时出现。

## 体验打磨（SL-polish）

- **未知命令**：提示 `/help`、`/skills`；对相近内置名给出 `Did you mean: /x, /y?`（编辑距离 / 前缀）。
- **参数错误**：`/effort`、`/thinking`、`/permissions` 等返回明确 Usage，而非含糊 “unknown”。
- **别名**：`/status`→`/doctor`，`/usage`→`/cost`，`/quit`→`/exit`；hidden alias
  不占裸 `/` 菜单行，明确输入前缀时仍可发现。

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
- retained TTY 中 `Ctrl+O` 在 overlay 未激活时全局切换工具 summary/preview；
  `/tools` picker 的 Enter 对有效 `fullResult` 打开按需全文 pager，无有效 ref 或
  missing/corrupt 时明确回退 bounded preview；Esc 关闭后恢复 Composer
  draft/cursor/focus。resume 通过 `tool_presentation` side-channel 恢复有效 ref。
- Ctrl-C 优先向 coordinator active turn 提交 durable interrupt；REPL 在询问新输入前持久化 queue promotion，再透传原 `turnId/querySource`。
- 持久化写失败时 queue/steer fail-closed；已触发的 interrupt 会明确提示 persistence warning。重启不会自动重放 pending/ready control。
- `agents.overflow: "queue"` 是真实 durable FIFO：queued 先写 admitted，取得 slot 时写 running；`/bg cancel` 会先移除 executable closure，再尝试写 result→aborted。
- queued cancel 落盘失败会保留 warning，但任务不会在本进程启动；重启后 admitted/running 只恢复为 interrupted 诊断，不重建 queue。
- background result 只在 queryLoop 安全边界注入父消息；父 turn 已结束时延至下一 turn。同进程只 delivery 一次，resume 不自动重复注入。
- `/runtime` 是 DR4 protocol consumer，不维护第二套状态机；action 已生效但持久化/后置 snapshot 出现问题时显示 accepted + warning，避免错误重试。
- DR4B2 在同一 protocol executor 上增加 append-only discard/retry-safe；running turn、steer、background task 和副作用不明工作不允许 retry。
- AR1A 顶层 `bolo runtime list|inspect --resume … [--json]` 与斜杠共用 shared selector；顶层查询不调用 provider、不显示 banner，JSON stdout 只有一个 payload。
- AR1B1 的 list/inspect 结果含 snapshot-only `availableActions`；每个 action 带 expected-state target。斜杠 inspect 保留旧 record 顶层 JSON，只 additive 增加 actions。
- AR1B2 的 pending/ready queue actions 另含 `control.replace` 与 `requiredInput=["prompt"]`；steer 不可 replace。edit 使用稳定 replacement IDs、保留旧 control/prompt，并在 cancel 已生效而新 admission 失败时返回 accepted + warning。
- `/runtime edit|remove` 只操作当前进程 live queue；顶层 `list|inspect` 仍为只读 query，顶层 recovery command 也不会把重启后的 interrupted control 重建为可编辑 live queue。
- 顶层 `bolo runtime discard|retry-safe <entity> <id> --resume|--continue [--json]` 复用同一 executor；默认 requestId 稳定派生，`--request-id` 可显式覆盖。accepted/accepted-with-warning/rejected/usage 分别使用 exit 0/0/1/2。
- 顶层 retry-safe 不调用 provider或执行 queue；进程退出后 replacement 在下次 resume 只显示 interrupted diagnostic。交互式执行仍走同进程 `/runtime retry-safe` + REPL FIFO drain。
- 模块：`packages/core/src/slash.ts`（执行 + candidate projection）；
  `packages/cli/src/slashCandidates.ts`（CLI-local 合并）；导出见 `@bolo/core` /
  `@bolo/cli`。

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
