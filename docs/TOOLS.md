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

### 3.1b 开源边界与「查询去哪」（2026-07 调研，20 条主张过对抗验证，0 条被证伪）

用户会问「这些第三方是不是开源的」。答案必须**分两层**说，否则等于误导：

| 层 | Exa 的情况 |
|----|-----------|
| **MCP 协议壳**（`exa-labs/exa-mcp-server`） | ✅ 开源 **MIT** |
| **搜索/抓取后端**（`api.exa.ai`） | ❌ **闭源商业服务** |

开源的那层是**一个转发壳**——`web_fetch_exa` 的实现就是 `exa.request('/contents','POST',…)`，
没有任何本地抓取或索引。所以「Exa MCP 开源」字面成立，但**不解决信任问题**。

两条实测要点：

- **`web_fetch_exa` 的抓取发生在 Exa 服务器上**，不在本地。你读哪个 URL，Exa 知道。
- Exa 隐私政策原文：*"Query Data is used to improve our products and technology,
  **including by training and fine-tuning models** that power our Services."*
  未区分免密层与付费层，也未给留存期限。免密 ≠ 匿名，只是限流的免费额度。

**同行都是这样**：Tavily / Brave / Serper / Perplexity / DuckDuckGo 的搜索后端**全部闭源**，无一例外。
Jina Reader（Apache-2.0）与 Firecrawl（AGPL-3.0）有自托管版，但它们是**抓取工具不是搜索引擎**，
且都不与云版功能对等。

**真想「查询不出本机」的实际选项：**

| 方案 | license | 查询实际去哪 |
|------|---------|-------------|
| SearXNG + MCP 桥 | AGPL-3.0 / 桥多为 MIT | ⚠️ **仍到 Google/Bing 等**，只隐藏你的 IP 与 cookie |
| YaCy（intranet 模式） | GPL-2.0 | ✅ 自建索引，**真的不出本机** · 代价：结果质量与资源开销 |
| 自建 Marginalia | AGPL-3.0 | ✅ 本地 · 代价：索引数据量巨大 |

抓取侧反而容易做到全本地：`jae-jae/fetcher-mcp`(MIT)、官方 `mcp-server-fetch`、
`zcaceres/fetch-mcp`(MIT) 都在**你本地**抓取，只连目标站点，无第三方 API、无遥测。

**参考项目对照：** HC 走 Anthropic 服务端工具（无第三方、无单独 key）；codex 走 OpenAI 自家
`alpha/search`，默认 `Cached` 不出网；opencode 是唯一在客户端直连第三方 SaaS 的，
源码注释自称 *"this compromise"*。**三家都没有提供自托管/开源后端选项。**

### 3.1c preset 必须声明「查询去哪」——一条假承诺的教训

`SearchPreset.privacy` 是**机器可读**字段（`vendor` | `upstream-engines` | `local-only`），
不是散文。它的由来是一条真实的假承诺：searxng preset 的 notes 曾写着

> ~~`Nothing leaves your network if you run SearXNG yourself.`~~ ← **错的**

SearXNG **自己没有索引**，它是元搜索代理：自托管后查询字符串仍由你的服务器转发给
Google / Bing / DuckDuckGo / Brave。自托管隐藏的是**你的 IP 与 cookie，不是查询内容**。

这类错误比功能 bug 严重——**有人会因为这句话把本不该外发的查询发出去**，而且它不会以任何形式报错。
所以现在由 `test-search-preset-privacy.ts` 守住：privacy 不是 `local-only` 的 preset，
其面向用户文案里**不得出现**「nothing leaves」这类绝对措辞。

同一条 preset 还有第二个坑：**SearXNG 原生不讲 MCP 协议**，直接指向它的端口永远连不上，
必须在前面架一个桥（如 `ihor-sokoliuk/mcp-searxng`，MIT）。文案已改为明说这一点。

> Bolo **不附带也不代跑**任何第三方桥接进程——那等于替用户引入供应链风险，
> 与零运行时依赖红线相悖。preset 只负责把配置写对、把去向说清。

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

### 3.3 ✅ 活体验证状态（2026-07）· 五条线路全绿

**两条 hosted 线路均通过第三方中转实测**——比官方端点更严格，中转还得能正确代理服务端工具。

| 线路 | 状态 | 实测结果 |
|------|------|----------|
| `anthropic` | ✅ **活体验证** | `⌕ web search "..."` + `⌕ 7 result(s)` + 引用；**零告警** |
| `openai-responses` | ✅ **活体验证** | `⌕ web search "site:nodejs.org …"` + 引用；**零告警** |
| `openai-compatible`（普通端点） | ✅ **活体验证**（DeepSeek 官方 API） | 确认**无** hosted 搜索；不 400；降级措辞正确 |
| `openrouter-plugin` | ✅ **活体验证**（免费模型，零余额） | `plugins:[{id:'web'}]` 生效；引用正确解析 |
| `mcp-external` | ✅ **活体验证**（Exa 免密层） | 见 §3.3b —— 连接 → 列工具 → 真调用 → 端到端 |

「零告警」是有意义的证据：未知块兜底一次都没触发，说明**没有任何块被静默丢弃**，
猜的块类型名全部命中。

### 3.3b `mcp-external` 活体验证（Exa · `scripts/live-mcp-search.ts`）

这条腿是给**没有 hosted 搜索的端点**补搜索用的，所以验证从用户真会敲的那条命令开始，
一路走到模型真的把结果用上。

| 步骤 | 实测结果 |
|------|----------|
| `bolo search enable exa` | 写出 `mcp.json`；产品加载器读回**零告警** |
| 连接 | `transport=http`（Streamable HTTP），免密，2.3–14s |
| `tools/list` | `web_search_exa` · `web_fetch_exa` |
| 注册名 | `mcp__exa-search__web_search_exa`，`requiresPermission=true` |
| `tools/call` | 真实结果，正文含真 URL（`nodejs.org/en/download` 等） |
| 模型侧路径 | 入参过 schema 校验 → `tool.call()` → 同样拿到真 URL |
| 坏参数 | 返回 `isError=true`，连接**仍可用** |
| CLI 端到端 | 模型自行调用该工具并给出带引用的答案 |

**为什么这个脚本不进 `npm test`：** 它依赖公网 + 第三方可用性。
实测 3 次跑挂 1 次（Exa 免密层按 IP 限速，正是 preset 注释里警告的那条）。
把它放进门禁，会让 CI 因为别人家的限速变红，然后所有人开始无视红灯——
**那比没有这个测试更糟。**

**端到端要在 headless 下真跑通，得显式放宽权限。** MCP 工具一律
`requiresPermission=true`，而非交互模式下 `askPermission` 默认 `'deny'`（fail-closed，
无人可问就不放行——设计如此）。在 `-p` 下需要项目级 `.bolo/config.json` 里配
`"permissionMode": "bypassPermissions"`。

> 踩坑记录：起初把它写进 `BOLO_CONFIG_DIR` 指向的**用户级**配置，不生效。
> 优先级是 `defaults < ~/.bolo/config.json < .bolo/config.json < 环境变量`，
> 而脚手架生成的项目级配置里带着显式 `"permissionMode": "default"`，压过了用户级。
> **这不是 bug，是优先级正确工作**——但足够反直觉，值得记一笔。

**已证实的 wire format**（原调研标 UNCERTAIN，现已确认）：

- Anthropic：`web_search_20250305` · `server_tool_use` · `web_search_tool_result.content[]` · `citations_delta.citation.{url,title}` · `server_tool_use.web_search_requests`
- Responses：hosted 类型就是 **`web_search`**（不带 preview 后缀）· `web_search_call` · `action.query` · `url_citation` annotation
- OpenRouter：`plugins:[{id:'web',max_results}]` · 响应 `annotations[].url_citation.{url,title,content,start_index,end_index}`

**⚠️ 同名不同形：** Responses 的 annotation 是**扁平** `annotation.url`；
OpenRouter Chat Completions 是**嵌套** `annotations[].url_citation.url`。
两者都已活体验证，照搬任一方到另一方都会解析不出来。

**两条腿的能力差异（非 bug）：** Responses 没有独立的结果块，所以拿不到结果计数。
实现在这种情况下**不填、不伪造**——用户看到查询词与引用，而不是一个编出来的数字。

### 3.4 只有真跑才发现的问题

每条线路的活体测试都抓到了假流测不出来的缺陷：

| 问题 | 修复 |
|------|------|
| Anthropic **逐句**发引用 → 一次搜索 7 行引用只有 4 个不同 URL，一个连出 3 次 | 渲染层按 turn 去重；解析层如实反映 provider 发了什么 |
| 中转返回 `HTTP 503` 却包着 `{"code":"model_not_found"}` | 错误解释改为 **body 优先于 status**；否则会告诉用户「是上游问题不是你的配置」，把人往反方向指 |
| 状态提示写着 `run 'bolo search enable exa'`，而该命令**当时不存在** | 补 `searchCli.ts`，并加断言：**文案里承诺的命令必须真能跑** |
| MCP 工具失败时只吐两个词 `fetch failed` | `describeMcpCallError()`：指名 server、分类网络/超时、标注可重试；**原文一律保留**（`test-mcp-tool-error.ts`） |
| 启用「搜索」搭售了一个**远程抓取**工具，模型拿它顶掉了本地 `WebFetch` | `McpServerConfig.allowTools` / `excludeTools`；exa preset 只注册 `web_search_exa`（`test-mcp-tool-filter.ts`） |

倒数第二条同样是端到端跑出来的：`bolo search enable exa` 会一次带进
`web_search_exa` **和** `web_fetch_exa`，而实测中模型**选了后者**——于是用户的
**抓取**也一并出了机器，他并没要求这个。过滤落在 `listTools()` 之后那**一个**咽喉点，
并存进 `ConnectedMcpServer.toolFilter`：只在 connect 处过滤的话，`list_changed`
重列时被排除的工具会悄悄复活（该回归已由测试第 8 步实证，摘掉过滤即变红）。

`allowTools` 最危险的失败模式是**打错名字**——白名单一个字母错 → 零工具注册 →
模型完全不知道有这个能力 → 用户以为「配了但没用」，而哪里都不报错。
所以名字对不上时必须告警并列出 server 实际提供了什么；`excludeTools` 打错则相反
（你以为排掉了其实没有），同样告警。

最后一条是端到端跑出来的，值得展开——它同时坑了人和模型：

- 会话可以挂**多个** MCP server，`fetch failed` 不说是哪个坏了，用户无从修。
- **模型也在读这条错误**，据此决定重试、换工具还是放弃。实测它拿到无信息的错误后
  接连去试 `WebFetch`、`Bash`，把整轮 turn 预算烧光才放弃。
- provider 侧同类错误早有 `explainProviderError` 给可行动提示，MCP 侧却什么都没有——
  同一类失败两套待遇。

分类不确定时**不贴网络叙事**：把人指向错误方向比不给提示更糟（同 §3.4b 的教训）。

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

## 5. 能力面现状（AR-T3+）

**已实现：**

| 能力 | 落点 |
|------|------|
| plan 工具流 | `ExitPlanMode`（`packages/tools/src/exitPlanMode.ts`）：提计划 → 用户批准 → 落回 `default` 继续逐项审批。plan 模式下 gate 特批它为 `ask`，否则规划态会把自己的出口也 deny 掉 |
| `AskUserQuestion` | 见 §5.1 |
| 网页搜索 | 五条线路，见 §3 |

**尚未实现：**

| 候选 | 现状 |
|------|------|
| `WebSearch`（本地发现） | 无（只有 `WebFetch`，能取已知 URL 不能发现）。搜索目前全部经 provider 或 MCP，见 §3 |
| 前台命令自动后台化 | 无（参考实现有阻塞预算超时自动转后台；语义复杂，暂不做） |
| LSP | 无（体量大，归 AR4 证据门控） |

逐项独立准入，见 [ROADMAP.md](./ROADMAP.md) §14.5。

### 5.1 `AskUserQuestion`

模型遇到歧义时，此前只能猜、或用自由文本发问再自己解析回答。这个工具把它变成结构化的一问一答。

| 层 | 文件 |
|----|------|
| 契约（校验 · 投影 · 渲染） | `packages/shared/src/askUserQuestion.ts` |
| 工具壳 | `packages/tools/src/askUserQuestion.ts` |
| CLI 选择控件 | `packages/cli/src/tui/questionPicker.ts` |
| CLI 句柄 | `packages/cli/src/tui/askUserQuestionTty.ts` |

约束：1–4 问，每问 2–4 个选项，选项 label 在同一问内唯一。`multiSelect` 决定单选/多选。**「Other（用自己的话回答）」由 UI 提供**，不占选项额度，模型不该自己写进 `options`。

**这个工具与其它工具有一处根本不同：结果不是算出来的，是人给的。** 所以契约层的核心职责不是生成答案，而是**挡住不是人给的答案**：

- 输入不合样子 → 先拒绝，**不打扰用户**
- UI 交回的答案对不上号（数量不符 · 选了没提供过的选项 · 单选给两个 · 空选择）→ **整条拒绝**

为什么这么严：会话里若出现一条「用户选择了 X」而用户根本没选过，后续每一轮都会把它当既定事实，**且永远不会报错**——静默失败里最难查的一种。

**没人可问时**（非交互 / 未注入句柄）返回 `errorCode:'unavailable'`，让模型带着显式假设继续，**不挂死、不编答案**。挂死比编答案更糟：编答案至少还能往下跑。

> `session.askUserQuestion` **没有** fail-closed 的默认实现，缺省就是 `undefined`。
> 这与 `askPermission` 有意不同——权限的默认 `deny` 是一个有意义的答复（不许），
> 而「问题」没有对应的默认答复，编一个就等于替用户表态。

**权限归类**：`classifyTool` 把它归进 `read`（`SIDE_EFFECT_FREE_TOOLS`）。这不是优化而是必需——落到 `unknown` 的话 **plan 模式会直接 deny 它**，而「规划时先问清需求」正是它的主场景；`acceptEdits` / `auto` 两档则会先弹一次权限审批，等于问问题之前先问一句「要不要问问题」。五档模式现在都断言为 `allow`。

**验证状态**：契约 / 工具 / 权限 / 控件逻辑 / 端到端接线均有门禁测试（`test-ask-user-question*.ts` · `test-question-picker.ts`）。接线测试已实证非空断言——摘掉六处穿线中任一处即变红。
**⚠️ 真人在真终端按键的交互尚未验证**：控件测试注入 `readKey`，覆盖不到真实 raw-mode 与 REPL 抢 stdin 的问题。
