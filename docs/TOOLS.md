# 内置工具契约（Agent 能力面）

> **真源。** 增删工具、改 schema、改权限分类，都必须先改本文档再写代码。
> 进度水位见 [ROADMAP.md](./ROADMAP.md) §0 与 §14。工具管道顺序见 [ENGINEERING_PRINCIPLES.md](./ENGINEERING_PRINCIPLES.md) §2.2。

---

## 0. 全集（13）

> `Agent` 由 subagent 层按策略注入，不在 `createBuiltinTools()` 里。

| 工具 | 权限 | 并发安全 | 只读 | interrupt |
|------|------|----------|------|-----------|
| `Bash` | ✅ 需门控 | ✗ | ✗ | cancel |
| `BashOutput` | ✗ | ✅ | ✅ | cancel |
| `KillShell` | ✗ | ✗ | ✗ | block |
| `Read` | ✗ | ✅ | ✅ | cancel |
| `Write` | ✅ | ✗ | ✗ | block |
| `Edit` | ✅ | ✗ | ✗ | block |
| `apply_patch` | ✅ | ✗ | ✗ | block |
| `Glob` | ✗ | ✅ | ✅ | cancel |
| `Grep` | ✗ | ✅ | ✅ | cancel |
| `Skill` | ✗ | ✅ | ✅ | cancel |
| `WebFetch` | ✅ 网络出站 | ✅ | ✅ | cancel |
| `TodoWrite` | ✗ | ✗ | ✗ | cancel |
| `ExitPlanMode` | ✅ 需用户批准 | ✗ | ✗ | cancel |
| `Agent` | 按 policy | — | ✗ | — |

权限判定统一在 **PermissionGate**，工具内不得自判 allow/deny。
`isConcurrencySafe` 决定 `StreamingToolExecutor` 能否与同批工具并行——**默认 fail-closed 为 `false`**。

---

## 1. TodoWrite（AR-T1）

### 1.1 为什么它值得一个工具

长任务里模型唯一的「跨步骤记忆」是上下文，而上下文正在被 compact 压缩。
待办表提供一个**不在消息历史里**的锚点：compact 改写 messages 时它不受影响。

### 1.2 契约

```ts
// packages/shared/src/todo.ts
type TodoStatus = 'pending' | 'in_progress' | 'completed'

type TodoItem = {
  content: string     // 祈使式 "Fix the auth bug"
  status: TodoStatus
  activeForm: string  // 现在进行式 "Fixing the auth bug"
}
```

输入 `{ todos: TodoItem[] }`，**整表替换**，不是增量 patch。

| 规则 | 行为 |
|------|------|
| `content` / `activeForm` 空白 | **拒绝**（`empty_content` / `empty_active_form`） |
| `status` 非法 | **拒绝**（`invalid_status`） |
| 非数组 / 元素非对象 | **拒绝**（`not_array` / `not_object`） |
| `in_progress` 不是恰好 1 个 | **通过但带 warning**，写进 tool_result 的 `NOTE:` |
| 全部 `completed` | 通过；**存储清空**，返回值仍是本次提交的表（供 UI 显示一次收尾态） |
| 空表 `[]` | 通过（用于主动清空计划） |

> `in_progress` 基数**故意不硬校验**：硬拒会让模型陷入「改一版→被拒→再改」的重试循环。
> 约束靠系统提示词 `# Task tracking` 段 + 工具结果里的 `NOTE:` 自纠。

### 1.3 状态存放与生命周期

```text
session.todos            ← 权威表（不进 messages）
  ↑ TodoWrite 工具经 ctx.extras.todoStore 写入（live getter/setter）
  ↓ session.onTodoWrite  → transcript `todo` 全量快照（append-only）
  ↓ resume               → projectTodosFromEntries 取最后一条快照
```

transcript 里的 `todo` entry 是**全量快照**而非增量：表很小（几行文本），
全量比增量更抗中断——半张待办表比没有更危险，坏快照整条丢弃。

### 1.4 再注入（模型如何看见它）

表不在 messages 里，所以模型默认看不见。core 在 **`before_provider` safe boundary** 按策略注入
一个 `<todo_reminder>` 包裹的 user 消息（与 `<background_task_result>` 同构）。

```text
if (待办表为空)                          → 永不注入
if (写锚点与提醒锚点同时消失)             → 立即注入一次   ← compact / resume 后
else 距上次 TodoWrite ≥ 10 assistant 轮
     且 距上次提醒     ≥ 10 assistant 轮 → 注入
```

锚点直接从 messages 反扫得出（找 `TodoWrite` tool_call 与 `<todo_reminder>` 消息），
**不额外持久化计数器**。compact / resume 之后锚点自然消失，正好等价于「模型已失去视野」，
因此快速路径不需要任何特殊 hook。注入的提醒本身成为新锚点，双阈值随即生效，不会连发。

### 1.5 渲染

`packages/core/src/todoCell.ts` 在 core 侧预渲染折叠/展开两态，
经既有 `tool_end.cellCollapsed / cellExpanded` 通道下发。**壳只打印，不重算状态。**

```text
折叠  Todos 1/3 · Building parser
展开  Todos 1/3 · Building parser
        ✔ scaffold project
        ▶ build parser
        ○ write tests
```

---

## 2. 后台 shell 三件套（AR-T2）

### 2.1 Bash `run_in_background`

```jsonc
{
  "command": "npm run dev",
  "run_in_background": true,
  "description": "dev server"   // 可选，状态行展示
}
```

后台分支**走完与前台完全相同的 policy / sandbox 门禁后才分流**。分流之后：

- **不套 timeout**（前台上限 600s；后台套上就失去意义）
- **不吃单轮 `ctx.signal`**（后台进程的价值就是跨 turn 存活）
- 沙箱临时文件**延后到进程退出**才清理（前台是 `finally` 清理，后台照搬会提前删掉）

返回 shell id，后续用 `BashOutput` / `KillShell` 操作。

### 2.2 BashOutput

`{ bash_id }` → 返回**自上次读取以来**的新输出 + 状态行。只读、免审批、并发安全。

游标按**实际读到的字节数**推进，允许越过 `bytesWritten`（stat 与 read 之间文件可能又长了），
这样才不会漏读。单次读取上限 200KB，超出时提示 `[more output available]`。

### 2.3 KillShell

`{ shell_id }` → 杀整棵进程树。

免审批的理由：它**只能作用于本会话注册过的 shell**，拿不到任意 pid，越权面为零。
对已结束的 shell 是安全 no-op，返回它此前的终态。

### 2.4 状态机

```text
running ──exit(0)────→ completed
        ──exit(≠0/null)→ failed
        ──kill────────→ killed
```

**terminal 幂等是硬要求**：kill 之后进程自然退出会再触发一次 exit，
那次必须被忽略，否则「用户杀掉的」会被记成「正常完成」。

参考实现另有 `backgrounded` 中间态（给「前台命令中途转后台」用）；
Bolo 本轮只支持显式 `run_in_background`，不需要该态。

### 2.5 进程树 kill（零依赖红线）

**`package.json` 的 `dependencies` 恒为空**，不得为此引入 `tree-kill` 之类的包。

| 平台 | 手段 |
|------|------|
| POSIX | `spawn(..., { detached: true })` 建独立进程组 → `process.kill(-pid, 'SIGTERM')` → 2s 后 `SIGKILL`；两级都失败时退回单 pid |
| Windows | `taskkill /pid <pid> /T /F`（`/T` 收整棵树） |

（与 codex `process_group(0)` + `terminate_process_group` → `kill_process_group` 同构。）

### 2.6 输出落盘与体积熔断

输出写到 `.bolo-tmp/shells/<sessionId>/<shellId>.log`，**不驻内存**——长跑命令的 stdout 可能是 GB 级。
累计字节超过 `DEFAULT_BACKGROUND_SHELL_OUTPUT_CAP_BYTES`（64MB）即熔断杀进程并标 `killedForSize`，
防止死循环 append 打满磁盘。

### 2.7 防僵尸

后台进程**跨 turn 存活，但绝不越过会话**：

```text
endSession → killAllBackgroundShells(session.backgroundShells)
           → cleanupShellOutputDir(cwd, sessionId)
```

`scripts/test-bash-background-runtime.ts` 用真实进程验证：kill 后 `isProcessAlive` 为假、
`killAll` 无残留、`endSession` 之后无僵尸。

---

## 3. Web search（AR-T3b）

### 3.0 为什么不自建搜索

三个参考实现全部让**模型 provider** 去搜，没人自己接搜索 API：
HelsincyCode 用 Anthropic 服务端 `web_search`；codex 发 OpenAI hosted ToolSpec
（文件名就叫 `hosted_spec.rs`）；opencode 两条都有，且把自调 Exa 的那份在源码注释里
称为 *"this compromise"* / *"legacy"*。

推论很关键：**provider-hosted 不引入新的第三方接收方**——对话本来就发给该 provider。
所以没有理由默认关闭。

### 3.1 方言表（真源：`packages/providers/src/webSearchDialect.ts`）

与 effort 轨同构：**会话只携带意图 `on|off|auto`，厂商 wire 片段全住表里**。
`ToolSpec` 不被任何厂商形状污染；加一家只改一行。

| dialect | 触发 | 发什么 | `auto` 默认 |
|---------|------|--------|------------|
| `anthropic-hosted` | kind=anthropic | tools 里加 `{type:'web_search_20250305', name, max_uses}` | **开** |
| `openai-responses-hosted` | kind=openai-responses | tools 里加 `{type:'web_search'}`（绕过 `toolsToResponses`） | **开** |
| `openrouter-plugin` | kind=openai-compatible ∧ baseUrl~openrouter.ai | `plugins:[{id:'web'}]` | **关**（新第三方 + 按次计费，官方文档明写「即使免费模型也另行收费」） |
| `mcp-external` | 任意 kind ∧ 配了搜索 MCP server | 无（带外走 MCP） | 配了即开 |
| `off` | 其余 | 无 | — |

`off` 表示**没有这个能力**，不是坏了。用户明确要开时，plan 带 `unsupportedReason` 供 CLI 解释。

### 3.2 三条不可违反的规则

**① 服务端块绝不能进本地工具通道。**
`anthropic.ts` 的 `flushTools()` 会把累加器里每一项发成 `tool_call`，语义是「Bolo 本地执行」。
服务端搜索块（`server_tool_use`）长得和客户端 `tool_use` 几乎一样——同样有 id/name、
同样用 `input_json_delta` 累加——**复用同一个 map 会让流末尝试执行一个不存在的本地工具**。
必须用独立的 `serverToolByIndex`（见 `anthropicStream.ts` 顶部不变量说明）。
Responses 侧按 `item.type` 分流即可，**永远不要按 id 前缀判断**。

**② 白名单必须有兜底。** 两个解析器都靠白名单防误执行，但没有 else 分支就等于静默丢弃。
不认识的块会发 `provider_notice` → CLI warning。缺了它，失败模式是
「搜索跑了 · 用户付了钱 · 屏幕上什么都没有」——报错能诊断，静默不能。

**③ hosted 条目必须在 cache 断点之前混入。** 否则落在缓存前缀之外，每轮重新计费。
同理 `max_uses` 是常量：被缓存的 tool 定义里放按调用变化的字段会击穿缓存。

### 3.3 ✅ 活体验证状态（2026-07）

**两条 hosted 线路均通过第三方中转实测**——比官方端点更严格，中转还得能正确代理服务端工具。

| 线路 | 状态 | 实测结果 |
|------|------|----------|
| `anthropic` | ✅ **活体验证** | `⌕ web search "..."` + `⌕ 7 result(s)` + 引用；**零告警** |
| `openai-responses` | ✅ **活体验证** | `⌕ web search "site:nodejs.org …"` + 引用；**零告警** |
| `openai-compatible`（普通端点） | ✅ **活体验证**（DeepSeek 官方 API） | 确认**无** hosted 搜索；不 400；降级措辞正确 |
| `openrouter-plugin` | ✅ **活体验证**（免费模型，零余额） | `plugins:[{id:'web'}]` 生效；引用正确解析 |
| `mcp-external` | ⚠️ **仅契约验证** | 未接真实搜索 MCP server 跑过 |

「零告警」是有意义的证据：未知块兜底一次都没触发，说明**没有任何块被静默丢弃**，
猜的块类型名全部命中。

**已证实的 wire format**（原调研标 UNCERTAIN，现已确认）：

- Anthropic：`web_search_20250305` · `server_tool_use` · `web_search_tool_result.content[]` · `citations_delta.citation.{url,title}` · `server_tool_use.web_search_requests`
- Responses：hosted 类型就是 **`web_search`**（不带 preview 后缀）· `web_search_call` · `action.query` · `url_citation` annotation
- OpenRouter：`plugins:[{id:'web',max_results}]` · 响应 `annotations[].url_citation.{url,title,content,start_index,end_index}`

**⚠️ 同名不同形：** Responses 的 annotation 是**扁平** `annotation.url`；
OpenRouter Chat Completions 是**嵌套** `annotations[].url_citation.url`。
两者都已活体验证，照搬任一方到另一方都会解析不出来。

**两条腿的能力差异（非 bug）：** Responses 没有独立的结果块，所以拿不到结果计数。
实现在这种情况下**不填、不伪造**——用户看到查询词与引用，而不是一个编出来的数字。

### 3.4 只有真跑才发现的两个问题

活体测试各抓到一个假流测不出来的缺陷：

| 问题 | 修复 |
|------|------|
| Anthropic **逐句**发引用 → 一次搜索 7 行引用只有 4 个不同 URL，一个连出 3 次 | 渲染层按 turn 去重；解析层如实反映 provider 发了什么 |
| 中转返回 `HTTP 503` 却包着 `{"code":"model_not_found"}` | 错误解释改为 **body 优先于 status**；否则会告诉用户「是上游问题不是你的配置」，把人往反方向指 |
| 状态提示写着 `run 'bolo search enable exa'`，而该命令**当时不存在** | 补 `searchCli.ts`，并加断言：**文案里承诺的命令必须真能跑** |

### 3.4b 端点行为差异（实测，决定了门控严格度）

DeepSeek 官方 API 实测出**不对称的失败模式**：

| 塞什么 | 结果 |
|--------|------|
| `tools:[{type:'web_search'}]` | **硬 400** `unknown variant, expected 'function'` |
| body 顶层未知字段 `plugins` | **静默忽略**，请求正常返回 |

所以 `openrouter-plugin` 必须**硬门控 baseUrl**：广撒这个字段不会报错，
只会让用户以为搜索开着、实际什么都没发生。**静默失败比报错危险。**

第二条是通用教训：**中转/网关经常把配置错误包在语义不符的状态码里。**

### 3.5 开关

```bash
/websearch            # 查看当前状态（经方言解析，反映这条线路实际会发生什么）
/websearch on|off|auto
```

`auto` 是会话缺省。注意 **provider 层缺省是关**：不传该选项等于关，
「默认开」必须由会话层显式传下来——否则直接调 `buildAnthropicRequestBody`
的既有代码会静默开启搜索并产生费用。

---

## 4. 门禁

```bash
npx tsx scripts/test-todo.ts                     # todo 纯契约
npx tsx scripts/test-todo-session.ts             # session/transcript/resume/注入
npx tsx scripts/test-bash-background.ts          # 后台 shell 纯契约
npx tsx scripts/test-bash-background-runtime.ts  # 真实进程 spawn/read/kill/teardown
```

四个都已进 `npm test` 默认门禁。

---

## 5. 尚未实现（AR-T3+ 候选）

| 候选 | 现状 |
|------|------|
| `WebSearch` | 无（只有 `WebFetch`，能取已知 URL 不能发现） |
| plan 工具流 | `PERMISSION_MODES` 已有 `'plan'`，但只 deny 编辑 + 一行提示；**缺 `ExitPlanMode`**，没有「提计划→批准→执行」闭环 |
| `AskUserQuestion` | 无（只能自由文本发问，拿不到结构化选择） |
| 前台命令自动后台化 | 无（参考实现有阻塞预算超时自动转后台；语义复杂，暂不做） |
| LSP | 无（体量大，归 AR4 证据门控） |

逐项独立准入，见 [ROADMAP.md](./ROADMAP.md) §14.3。
