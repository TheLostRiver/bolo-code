# Bolo Code 使用指南

> 给**使用者**（人类或自动化）：如何安装、配置、跑 CLI/Desktop、配置 **Agent / Subagent**。  
> 契约真源仍是各专题文档；本文是可操作的最短路径。  
> 相关：[CONFIG.md](./CONFIG.md) · [PROVIDERS.md](./PROVIDERS.md) · [SUBAGENT.md](./SUBAGENT.md) · [SUBAGENT_SPEC.md](./SUBAGENT_SPEC.md) · [SLASH_COMMANDS.md](./SLASH_COMMANDS.md)

---

## 1. 安装与首次启动

**要求：** Node ≥ 22.19.0 · npm 11（根 `packageManager` 锁定 11.17.0）

```bash
npm install -g bolo-code
bolo
# 或不安装
npx bolo-code
```

普通 `bolo` 是唯一首次启动主路径，不需要先运行 init。首次启动会按需创建用户级
`~/.bolo`（或 `$BOLO_CONFIG_DIR`）及默认模板；**不会**仅因为当前项目缺少 `.bolo/`
就修改仓库。新会话写入用户目录下按 workspace 分桶的 session store。

只有明确需要项目级模板时才显式初始化：

```bash
bolo init               # 等同 bolo init --project
bolo init --user        # 显式补齐用户级模板
```

两条命令都幂等且不覆盖已有文件。源码开发对应入口是
`npm run dev -- init [--project|--user]`；旧 `npm run bolo:init` 只是仓库开发辅助，
不是最终用户的启动前置步骤。

首次运行或显式初始化后，相关目录大致有：

```text
~/.bolo/
  config.json      # 用户级（JSONC，可写 // 注释）
  agents/          # 用户 subagent 类型 *.md
  skills/ hooks/ mcp.json memory/ rules/ plugins/ …
  sessions/
    workspaces/<hash>/   # 新会话、tool spill、subagent transcript

<repo>/.bolo/      # 仅已存在或显式 bolo init [--project] 时
  config.json      # 项目级（覆盖用户同名字段）
  agents/ skills/ …
  sessions/        # 旧项目会话兼容读取；新会话不再默认写这里
```

合并优先级：

```text
defaults < ~/.bolo < 项目 .bolo < 环境变量（Key / 部分熔断最高）
```

---

## 2. 配置 Provider（模型后端）

### 2.1 密钥

**不要把明文 key 提交进仓库。** 推荐 `apiKeyEnv` + 本机环境变量：

| 变量 | 用途 |
|------|------|
| `OPENAI_API_KEY` / `BOLO_API_KEY` | OpenAI 兼容 / 通用 |
| `ANTHROPIC_API_KEY` | Anthropic Messages |
| `DEEPSEEK_API_KEY` 等 | 与 preset / profile 的 `apiKeyEnv` 对齐 |
| `BOLO_PROVIDER=mock` | 强制 mock（无网调试） |

Windows PowerShell 示例：

```powershell
$env:OPENAI_API_KEY = "sk-..."
$env:SILICONFLOW_API_KEY = "..."
```

### 2.2 多后端（推荐）

`~/.bolo/config.json` 或 `.bolo/config.json`：

```jsonc
{
  "version": 1,
  "defaultProvider": "work",
  "permissionMode": "default",
  "providers": {
    "work": {
      "kind": "openai-compatible",   // Chat Completions /v1/chat/completions
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    "sf": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.siliconflow.cn/v1",
      "model": "deepseek-ai/DeepSeek-V4-Flash",
      "apiKeyEnv": "SILICONFLOW_API_KEY",
      "effort": { "dialect": "deepseek-chat" }
    },
    "claude": {
      "kind": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "effort": { "dialect": "anthropic-output" }
    }
  }
}
```

| `kind` | 含义 |
|--------|------|
| `openai-compatible` | 自研 Chat Completions 客户端（**不是** npm `@ai-sdk/openai-compatible`） |
| `openai-responses` | 原生 Responses `/responses` |
| `anthropic` | Anthropic Messages |
| `mock` | 本地假后端 |

**Preset 快速加后端（CLI）：**

```text
/provider add list
/provider add deepseek
/provider add anthropic as claude-work
/provider use deepseek
```

只写 `apiKeyEnv`，**不写**明文 key。详见 [PROVIDER_UX.md](./PROVIDER_UX.md) · [PROVIDERS.md](./PROVIDERS.md)。

### 2.3 单后端（旧字段，仍可用）

```jsonc
{
  "version": 1,
  "provider": {
    "kind": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  }
}
```

---

## 3. 启动

### 3.1 CLI

```bash
# REPL（TTY）
npx bolo
# 或
node packages/cli/bin/bolo.js

# 单轮
npx bolo -p "列出当前目录结构"

# headless 精确放行/拒绝；可重复传，逗号分隔
npx bolo -p "只读检查源码" --allowed-tools Read,Glob,Grep
npx bolo -p "检查但不要执行删除" --disallowed-tools "Bash(rm *)"

# 会话
npx bolo --list
npx bolo --resume <id>
npx bolo --continue

# AR1：查询/处置既有会话的 runtime，不隐式调用模型
npx bolo runtime list --resume <id>
npx bolo runtime list task --continue --json
npx bolo runtime inspect turn <turnId> --resume <id>
npx bolo runtime inspect turn <turnId> --resume <id> --json
npx bolo runtime discard turn <turnId> --resume <id> --json
npx bolo runtime retry-safe control <controlId> --continue --json
```

真实 TTY 中，REPL 会先显示 Bolo Code 水晶工作台：96 列以上把完整水晶置于左栏，
Ready/workspace/model/session/runtime state 置于右栏；56–95 列使用中型水晶单列，
38–55 列使用紧凑水晶单列。工作台在超宽终端封顶 100 cells，随后显示全宽输入框
而不是裸 `bolo>`：

```text
╭─ Message ─────────────────────────────────────────╮
│ ❯ /d                                              │
├─ Commands · 4 ────────────────────────────────────┤
│ ❯ /doctor        Local diagnostics                │
│   /diff          File changes                     │
╰───────────────────────────────────────────────────╯
  default · provider/model · effort high
  ↑↓ select · Tab/Enter complete · Esc close
```

输入 `/` 会显示内置、CLI-local、Plugin 与 user-invocable Skill，继续输入实时按
exact/prefix 过滤。菜单打开时 `↑/↓` 选择，Tab/Enter 只补成 `/<name> `，Esc 关闭并
保留文本；补全后的精确命令在首个尾随空格继续显示弱化参数提示，例如 `/effort `
展示当前 provider/model 真正可选的档位，开始输入实参后提示消失；再次 Enter 才
提交。菜单关闭后 `Enter` 发送、`Ctrl+J` 换行、`↑/↓` 浏览本进程历史；支持
`←/→`、`Home/End`、`Backspace/Delete` 和常见 Emacs 编辑键。支持 bracketed paste
的终端会把跨 chunk 多行粘贴合并为一次输入，规范化 CRLF/CR，粘贴中的换行不会误
提交。提交后用户消息立即进入与 composer 同宽的灰色时间线块；composer 在 provider
思考和工具执行期间仍保留在底部。provider 首 token 到达前显示
`✦ → ✧ → ✶ → ✧` Thinking、本段耗时和中断提示，工具运行时显示
`Running <tool>`；每段 reasoning 结束后留下 `Thought for <duration>`，不会把整轮
时间冒充单段思考；provider 没有发送可见 reasoning 文本而直接回答时也会保留该行。
历史/活动与 composer 之间有一行固定空白；running surface 和回合结束后的 idle
输入框共用同一间距契约，输入重绘、活动刷新或 owner 交接都不会吞掉或重复累加。
Agent/slash 正文按终端宽度保留稳定 gutter，底栏显示 model/mode、快捷键和
`↓input ↑output` token。完整键位见 [TUI.md](./TUI.md) §3。

活动行每次把完整内容与擦尾控制合成一次原位写入，不会先清空再绘制；glyph 与耗时
以 250ms 节奏刷新。需要授权时，Bash 面板会显示实际 command、cwd、前后台与 timeout，
再让用户用 `↑/↓` 或 `y/a/n` 选择 allow once、always 或 deny；Always 作用于本会话
后续同名工具。picker、Diff 和权限面板只重绘自己拥有的行，不会清除整屏历史。

`/context` 在 TTY 中显示响应式使用率仪表盘，明确区分 actual、estimated 与 hybrid
来源，并展示已用/可用窗口、阈值和主要分类；非 TTY 输出同一数据的紧凑文本。
`/context details`（或 `--details`）才输出 sections、skills、memory、cache 和
prepare/compact 的完整诊断。

OI-15C 起，retained TUI 的 `/context` 使用 Composer 下方 12 秒单 panel；重复执行只
替换同一槽，开始编辑、`Esc`、TTL 或 reset/restore 会清除。`details`、`detail`、
`--details` 与超出 panel 容量的 `/doctor`/`/status`、help/memory 等只读内容使用
text pager；`/mcp`、`/hooks` 直接进入 pager。迁移结果不会进入兼容输出区或会话消息。
OI-16 起，REPL 内嵌 text pager 的正文每页最多 18 行；高终端不会把短 Doctor
人为撑到近全屏，短于一页的内容只占实际行数。footer 始终显示页码与
`q/Esc close`；关闭后恢复 Composer。这个高度策略不改变顶层 runtime pager，
也不改变 pipe、`--print`、JSON 或非 TTY 的原始文本字节。
OI-15D 起，`/skills`、`/plugins`、commands、market/search 会先在唯一 OverlayHost
显示 loading，再用结构化目录原位替换；迟到或已取消的请求不会覆盖当前视图。长目录
支持 `PgUp`、`PgDn`、`Home`、`End`，终端 resize 后仍保持选中项可见；`Esc`/关闭后
恢复输入内容、光标与焦点。OI-15E 起，短动作、警告和可立即修正错误使用 footer
单 toast 槽，重复动作只替换旧项；只有显式需要审计的不可恢复错误才进入 visual-only
history。插件 install/uninstall 执行失败可审计，reload merge notes 使用 warning
toast；Usage 错误仍是短 error toast。[ROADMAP.md](./ROADMAP.md) 的 OI-15F
`d1e26bb` 起，Provider/Effort/Diff 使用统一的结构化 overlay payload；只读
list/help/git 进入 panel/pager，mutation 进入 toast，overlay 关闭、不可用或无内容时
回落 visual-only history。normal slash 结果不再进入 compatibility writer。
pipe、`--print`、JSON 与非 TTY 的 plain 文本契约不会因此改变。

`BOLO_MASCOT=0` 可隐藏水晶；`BOLO_ASCII=1` 使用 ASCII 水晶；`NO_COLOR` 只去颜色并
保留欢迎页结构，显式 `BOLO_THEME=plain` / `BOLO_PLAIN=1` 才简化欢迎页。

OI-14H 起，双 TTY/raw-mode 会话只使用 retained renderer：transcript/Markdown、
常驻 Composer、Thinking/Running activity、model/effort/usage footer 与唯一
OverlayHost 位于同一 component tree；slash/hint/history/undo、多行 paste、首 token
前输入框、每段 `Thought for`、new/resume、permission/question/provider/effort/diff/
pager 均有真实 VT 门禁。面板期间 Composer 不卸载，输入状态、focus、raw stdin 与
writer 不转交给第二 owner；runtime pager 也不发送整屏 `ESC[2J`。普通用户无需设置
engine，也没有第二套 dynamic renderer 可选。

retained REPL 中，模型或工具正在运行时按 `Esc` 会针对 coordinator 当前 active
turn 请求 interrupt 并返回输入框；`Ctrl-C` 保留为运行态兼容键，空闲输入框下才
退出 REPL。权限问答、选择器、diff 和 pager 打开时，`Esc` 先交给当前 overlay
取消/返回，不会被 turn 全局中断抢走；plain/readline 回落仍使用 `Ctrl-C` 中断。
用户主动取消不会在时间线显示 durable turn id 或 `turn ended with aborted` warning。

动态 TUI 只在 stdin/stdout 双 TTY 且 stdin 支持 raw mode 时启用。pipe、`-p`、
`--print`、JSON 或不支持 raw mode 的宿主会自动回落追加式输出，不发送动态 activity/
清行/光标移动。`NO_COLOR` 关闭颜色但不关闭输入；需要彻底回落时设
`BOLO_TUI_INPUT=0` 或 `BOLO_TUI_LAYOUT=0`。pipe、`--print`、JSON 与非 raw-mode
宿主始终走独立 plain/追加式路径。

`bolo runtime list|inspect` 必须显式给 `--resume <id|path>` 或 `--continue`，不会进入 picker、创建新会话或调用 provider。每个 item 的 `availableActions` 由当前 snapshot 纯推导，并携带执行所需 expected state；空数组表示当前不应尝试动作。

文本模式只有在 **stdin 与 stdout 都是 TTY** 且结果超过一页时才启用 retained OverlayHost pager。`n/j/↓/→` 下一页，`p/k/↑/←` 上一页，`q/Esc` 正常退出；`Ctrl-C` 返回 130，EOF 正常退出。分页复用 shared reducer，不做整屏 clear。空结果/单页、pipe 或 `--json` 都不会读取 stdin；pipe/JSON 一次性输出完整结果，不带 ANSI、clear-screen、banner 或 summary。`NO_COLOR` 会禁用 renderer 颜色，但不改变分页和退出语义。

`--json` 成功时 stdout 只有一个原始 `runtime.list|runtime.inspect` view payload；load/not-found 等查询失败只有一个 `{ "ok": false, "code": "...", "detail": "..." }` payload。JSON 参数错误同样只向 stdout 写一个 failure payload、stderr 为空并 exit 2；成功 exit 0，查询/加载失败 exit 1。非 JSON 参数错误仍向 stderr 输出诊断/help 并 exit 2。

顶层 `runtime discard|retry-safe` 使用同一 resume/continue 隔离路径，只执行恢复后仍有明确语义的 append-only action。command JSON 是一个 protocol `runtime.result`；accepted（含 warning）exit 0，rejected/load failure exit 1，usage exit 2。requestId 默认按 session/action/target 稳定派生，也可用 `--request-id <id>` 覆盖。顶层 retry-safe 只 admission、不调用模型；命令退出后 replacement 在再次 resume 时是 interrupted diagnostic，不会自动执行。

`--allowed-tools` 接受工具名、工具名前缀和 `Bash(pattern)`；它只放行命中的
工具，不会把整档权限切成 `bypassPermissions`。`--disallowed-tools` 是硬拒绝，
优先于 bypass，也会在 `--resume` 时叠加到已恢复规则上。规格写错会在 turn 开始前
exit 2，不会静默忽略。完整语法见 [TOOLS.md](./TOOLS.md) §3.3。

**Web search 最短入口：**

```text
/websearch on              # 启用显式配置的本地工具或 provider 线路
/websearch                 # 看当前线路与 on/off/auto 意图
/websearch auto            # provider 支持时按模型需要启用
/websearch off             # 本会话禁用；SearXNG 工具 schema 不再发给模型
```

已有 Docker 且希望让 Bolo 管理本机 SearXNG 时，使用显式子命令：

```bash
bolo search searxng setup             # 默认只绑定 127.0.0.1:8888
bolo search searxng setup --port 8889 # 自选可用端口
bolo search searxng status --json     # 只看容器状态，不查询上游
bolo search searxng logs --tail 200
bolo search searxng stop              # 停容器；保留数据、manifest 与 Bolo 配置
```

Docker 必须预先安装；Bolo 不会安装它。只有 `setup` 会创建 managed files 或启动容器。
fresh setup 会先预检端口与 Docker/Compose，启动后要求 doctor smoke 返回非空结果，
成功后才原子合并用户 `config.json`；失败会回滚本次新建的容器与目录。

Anthropic、OpenAI Responses 等 hosted 线路不需要本地工具；其它 provider 可先运行
`bolo search status` 查看状态，再用 `bolo search enable exa` 配置内置的 MCP
搜索 preset。SearXNG 不使用 preset 或 MCP 桥；若使用已有或手工部署的实例，在
用户/项目 `config.json` 显式配置：

```jsonc
{
  "search": {
    "searxng": {
      "baseUrl": "http://127.0.0.1:8888",
      "maxResults": 8,
      "safeSearch": 1
    }
  }
}
```

SearXNG 必须启用 JSON format；部署、HTTPS/LAN 限制、隐私去向与验证边界以
[LOCAL_SEARCH_AND_FETCH.md](./LOCAL_SEARCH_AND_FETCH.md) 为准。仓库 fixture
持续覆盖协议；真实 Docker 实例与上游引擎 live smoke 也已完成。`WebSearch`
会区分三种情况：正常空结果仍成功；空结果且有 `unresponsive_engines` 时返回
`upstream_unavailable`；有结果但部分引擎失败时保留结果并追加 `Warning:`。
按 warning 调整当前网络可达的引擎；仅 HTTP 200 不算搜索配置成功。

`bolo search status` 只展示解析后的配置与 endpoint，**不会发起探活查询**；
因此 status 为 on 不等于上游可用。部署或排障时运行：

```bash
bolo search doctor
bolo search doctor --json
```

doctor 会只读访问 SearXNG `/config` 与 `/search`：检查版本、JSON 能力并执行非空
smoke query，列出有效结果、可工作与不可用引擎。部分引擎故障但仍有结果时
`partial_success` / exit 0；网络、JSON、空结果或全故障 exit 1；未配置、配置无效
或用法错误 exit 2。`--json` 的 stdout 只有一个 JSON payload，适合脚本解析。

`AskUserQuestion` 不是斜杠命令：在 `npx bolo` 的真实 TTY 会话里，模型遇到会
实质改变结果的歧义时会调用它并显示选择面板。`-p`、pipe 等非交互会话会立即返回
`unavailable`，agent 应说明假设并继续，不能等待不存在的回答。自动化已经覆盖协议和
picker；真人终端的 raw mode/按键仍需人工验收，见
[OPEN_ISSUES.md](./OPEN_ISSUES.md) OI-H1。主输入框的真实 Windows Terminal
光标/重绘/组合键另见 OI-H3。

### 3.2 Desktop（Electron）

```bash
cd apps/desktop
# 若二进制下载 TLS 失败：
#   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
#   node node_modules/electron/install.js
npm install
set BOLO_DESKTOP_MOCK=1    # 先 mock；真网则 =0 并配好 key
npm start
```

左侧会话列表支持鼠标点击，也支持聚焦后按 `Enter` / `Space`，会从当前 workspace
的用户级 session 分桶以及旧项目/旧用户兼容路径中恢复所选会话。当前会话仍在
running、compacting、等待审批或 stopping 时会拒绝切换；先完成/中断当前工作再切换。
恢复只加载历史与 durable 诊断，**不会自动 replay interrupted work**。

composer 在空闲时使用 **Send**。turn 运行中仍可输入，并显式选择 **Queue**
（当前 turn 结束后 FIFO 执行）、**Steer**（下一个安全边界注入）或
**Interrupt**（不需要输入文本）。这些动作携带当前 turn 的 expected state；
目标已变化时会拒绝，不会误打到下一轮。

Settings 中的 **Model** 输入会列出当前 provider 的内置建议，但不是白名单，
自定义兼容端点可直接填写自己的 model 名。**Effort** 只列出当前 dialect/model
可选档，`auto` 清除会话 override。Save 会把 model/effort 立即写入当前 durable
session；校验或写盘失败时设置窗口保持打开、原输入不丢，并显示错误。密钥仍只从
环境变量/`apiKeyEnv` 读取，不进入 renderer snapshot。

工具运行时，`tool_progress` 会在同一条工具行原位更新，不会每个 tick 刷一条消息。
Steer 的提示只在请求已到达安全边界并真正注入后显示为 applied；它不是“已排队”的
提前回执。两类文案都由 packages 投影，renderer 不自行猜 safe-boundary 状态。

见 [apps/desktop/README.md](../apps/desktop/README.md)。

---

## 4. 常用斜杠（日用）

空输入时先键入 `/` 可浏览所有可执行项；例如 `/d` 会优先选中 `/doctor`。Plugin
command 与 user-invocable Skill 使用同一列表并显示来源。菜单是会话输入补全，不是
PowerShell/Bash 外壳补全。

| 命令 | 作用 |
|------|------|
| `/exit` · `/quit` | 关闭交互 REPL；`/quit` 是只在明确前缀时显示的隐藏别名 |
| `/help` | 命令列表 |
| `/provider` · `/provider use <id>` · `/provider add …` | 后端列表 / 热切 / preset |
| `/model` · `/model name` · `/model id/name` | 模型 |
| `/effort` · `/effort high` | 推理强度（方言 wire；输入 `/effort ` 可见当前合法档位） |
| `/ultrathink [off\|tip\|turn]` | CX8 糖；**默认 off** |
| `/agents` · `/bg` · `/bg cancel <taskId>` | subagent 后台 FIFO/status；只取消 queued；resume 后显示 interrupted 诊断 |
| `/turn status` | 当前 active turn 与 queue/steer/interrupt control 状态 |
| `/turn steer <text>` · `/turn interrupt` | 在安全边界修正或取消当前 active turn |
| `/turn queue <text>` · `/turn cancel <controlId>` | FIFO 排队下一轮；执行前取消 pending/ready control |
| `/runtime list [turn\|control\|task]` · `/runtime inspect <turn\|control\|task> <id>` · `/runtime json` | protocol v1 共用 query selector；`json` 保留原始 snapshot |
| `/runtime interrupt <turnId>` · `/runtime cancel <control\|task> <id>` | expected-state 安全动作；target/state 变化时拒绝 |
| `/runtime edit <controlId> <prompt>` · `/runtime remove <controlId>` | 替换或删除当前进程尚未开始的 queue；edit 保留旧历史并在 FIFO 尾部追加 replacement |
| `/runtime discard <turn\|control\|task> <id>` | 对 interrupted 记录追加人工确认；不删除原历史 |
| `/runtime retry-safe <turn\|control\|task> <id>` | 只为 admitted-only turn 或未启动 queue 建立新 FIFO turn；其它类型拒绝 |
| `/diff` · `/diff last` · `/diff git` | 本会话文件改动 |
| `/compact` · `/context [details]` · `/cost` | 压缩 · 上下文概览/完整诊断 · 本地 token |
| `/permissions` · `/plan` · `/allow` · `/deny` | 权限 |
| `/hooks` · `/hooks recent` | Hooks |
| `/doctor` | 本地诊断 |
| `/thinking on\|off` | 是否渲染思考链 |
| `/websearch [on\|off\|auto]` | 查看或切换本会话 Web search 意图 |

完整表：[SLASH_COMMANDS.md](./SLASH_COMMANDS.md)。

可选关面板：

| 变量 | 作用 |
|------|------|
| `BOLO_PROVIDER_PANEL=0` | `/provider` 仅文本 |
| `BOLO_DIFF_PANEL=0` | `/diff` 仅文本 |
| `BOLO_ARROW_PICKER=0` | 禁用箭头 picker |
| `BOLO_TUI_INPUT=0` | 关闭真实输入框、activity 与结构化时间线，回落 readline |
| `BOLO_TUI_LAYOUT=0` | 关闭 TUI layout/dynamic path |
| `NO_COLOR` | 保留输入能力，只关闭颜色 |
| `BOLO_ASCII=1` | 欢迎页使用 ASCII 水晶和 ASCII 分隔符 |
| `BOLO_THEME=plain` / `BOLO_PLAIN=1` | 保留输入能力，关闭颜色并简化欢迎区 |
| `BOLO_MASCOT=0` | 隐藏欢迎页水晶，保留品牌字标和 workspace/model/session 信息 |

---

## 5. 如何配置 Agent（Subagent）

Bolo 里有两层「agent」概念，别混：

| 概念 | 是什么 | 配置在哪 |
|------|--------|----------|
| **主会话 agent** | 当前 REPL/Desktop 的 queryLoop（工具环） | `provider` / 权限 / effort / skills… |
| **Subagent** | 主模型通过 **`Agent` 工具** spawn 的子 loop | `config.agents` + `agents/*.md` |

完整契约：[SUBAGENT_SPEC.md](./SUBAGENT_SPEC.md) · 日用说明：[SUBAGENT.md](./SUBAGENT.md)。

### 5.1 全局策略 — `config.json` → `agents`

用户或项目 `config.json`：

```jsonc
{
  "agents": {
    "enabled": true,           // false = 主会话不挂 Agent 工具
    "maxConcurrent": 3,        // 后台并发上限
    "defaultModel": "inherit", // 子默认模型；inherit = 父会话 model
    "defaultEffort": "medium", // 子默认 effort
    "maxSpawnDepth": 0,        // 0 = 子不能再 spawn（默认防递归）
    "overflow": "reject"       // 超额 reject；改 queue = durable FIFO
  }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 关则主工具表无 `Agent` |
| `maxConcurrent` | `3` | 也可 `BOLO_MAX_BACKGROUND_AGENTS` |
| `defaultModel` | `inherit` | 也可 `BOLO_SUBAGENT_MODEL` 强制 |
| `defaultEffort` | medium / 继承 | 也可 `BOLO_SUBAGENT_EFFORT` |
| `maxSpawnDepth` | **`0`** | 全局：子默认不能再开 Agent |
| `overflow` | `reject` | `BOLO_BACKGROUND_OVERFLOW`；`queue` 先 admitted，slot 可用后 running；`/bg cancel` 只取消 queued |

其它常用 env：

| Env | 作用 |
|-----|------|
| `BOLO_AGENTS_ENABLED=0` | 禁用 Agent 工具 |
| `BOLO_SUBAGENT_MAX_SPAWN_DEPTH` | 覆盖全局 maxSpawnDepth |
| `BOLO_SUBAGENT_WORKTREE=1` | 请求 git worktree 隔离；创建失败则子任务失败，不回落父 cwd |

### 5.2 自定义类型 — `agents/*.md`

合并顺序（**后者覆盖同名**）：

```text
builtin: explore / general / plan / fork
  ← ~/.bolo/agents/*.md
  ← <cwd>/.bolo/agents/*.md
```

`bolo init [--project]` / `bolo init --user` 会在对应作用域创建空 `agents/` 与说明；
普通启动只准备用户级目录，不会自动创建项目 `.bolo/`。

**最小自定义示例** — `.bolo/agents/reviewer.md`：

```markdown
---
name: reviewer
description: PR risk review — correctness, security, tests
model: inherit
effort: high
tools: Read, Glob, Grep
disallowedTools: Write, Edit, Bash, Agent
maxTurns: 12
maxSpawnDepth: 0
---

You are a careful code reviewer. Report risks and suggested tests.
Do not modify files.
```

| frontmatter | 说明 |
|-------------|------|
| `name` / `agentType` / `id` | 类型 id；缺省=文件名 |
| `description` | 主模型选型 + `/agents` 列表 |
| body | **system 正文** |
| `model` | `inherit` 或具体 model |
| `effort` | `low\|medium\|high\|max\|inherit` 等 |
| `tools` | `*` 或逗号列表 |
| `disallowedTools` | 二次剔除；嵌套常禁 `Agent` |
| `permissionMode` | 不得比父更宽 |
| `maxTurns` | 定义级上限；工具参数可覆盖 |
| `maxSpawnDepth` | 本类型作为「父」时能否再 spawn |
| `isolation` | `none` \| `worktree` |
| `background` | 定义级默认后台 |
| `sandbox: read-only` | 语法糖 → 只读工具集 |

**允许子再开一层 explore：**

```markdown
---
name: lead_research
description: Coordinates read-only explores
tools: "*"
maxSpawnDepth: 1
model: inherit
effort: medium
---

You may spawn explore subagents only. Wait for summaries; do not edit files.
```

### 5.3 内置类型速查

| `subagent_type` | 工具倾向 | 用途 |
|-----------------|----------|------|
| `explore` | Read / Glob / Grep | 只调研，不改文件 |
| `general` | 可写集 − Agent | 执行子任务并回报 |
| `plan` | 只读 + plan 权限 | 出计划 |
| `fork` | 父工具 − Agent | 继承父消息浅拷贝 + 新任务 |

CLI：

```text
/agents          # 活跃类型与来源
/agents status   # 后台计数
/bg              # queued/running/terminal 状态
/bg cancel <id>  # 只取消尚未启动的 queued task
```

主模型通过 **Agent 工具** 传 `prompt` + 可选 `subagent_type` / `fork` / `run_in_background` / `model` / `effort`。

### 5.4 权限与安全要点

- 子 agent **权限不得比父更宽**  
- 默认 `maxSpawnDepth: 0` → 子工具表通常 **无 Agent**（防无限递归）  
- auto 模式下危险 always-allow 会被清洗；Agent 常强制分类  
- worktree 只在 clean 时自动删除；modified/untracked/ignored、复用目录或清理失败会保留并返回绝对路径
- **无遥测**；密钥不进 transcript  

---

## 6. 权限模式

| 模式 | 含义 |
|------|------|
| `default` | 敏感工具 ask |
| `acceptEdits` | 编辑类更松 |
| `plan` | 偏只读规划 |
| `auto` | 分类器 + 熔断（见 PERMISSIONS） |
| `bypassPermissions` | 尽量不拦（危险；仅信任环境） |

```text
/permissions
/permissions acceptEdits
/plan
/allow Write
/deny bash:rm
```

---

## 7. Effort 与 ultrathink

```text
/effort              # 能力视图 + 可选 TTY 选档
/effort high
/effort auto
```

在输入框中补全 `/effort` 并键入首个尾随空格时，会显示当前方言的合法档位提示；
提示不是输入内容，继续键入档位后自动消失。

方言由 provider `effort.dialect` 或 detect 决定（DeepSeek / Responses / Anthropic / max-tokens…）。见 [EFFORT.md](./EFFORT.md)。

**ultrathink（CX8，默认 off）：**

```text
/ultrathink tip      # 检出关键词只提示 /effort high
/ultrathink turn     # 仅本轮 effective → high，不写 session.effortLevel
/ultrathink off
```

或 `config.ultrathink` / `BOLO_ULTRATHINK=tip|turn`。

---

## 8. Hooks / Skills / MCP（最短）

| 扩展 | 配置 | 文档 |
|------|------|------|
| Hooks | `hooks.json` 或 config 合并 | [HOOKS.md](./HOOKS.md) |
| Skills | `~/.bolo/skills/<id>/SKILL.md` · `.bolo/skills` | [SKILLS.md](./SKILLS.md) |
| MCP | `mcp.json` | [MCP.md](./MCP.md) |
| Plugins | `plugins/` · 可选 `foreignPluginRoots` | [PLUGINS.md](./PLUGINS.md) |
| Rules | `.bolo/rules` | [RULES.md](./RULES.md) |

可选旁路 skill 根（默认 **不**扫 `~/.agents/skills`）：

```jsonc
{
  "extraSkillRoots": ["~/.agents/skills"]
}
```

---

## 9. 会话与 resume

- 新会话默认落盘：`~/.bolo/sessions/workspaces/<workspace-hash>/`；旧
  `<cwd>/.bolo/sessions` 与旧用户 sessions 继续只读发现、list/resume，不自动迁移
  （见 [SESSIONS.md](./SESSIONS.md)）
- resume 会尝试恢复 **`providerId` + model + effort**，并与新会话共用当前 workspace 的 hooks / skills / plugins / agent / MCP 装配（缺 key 降级 + 警告）
- `/diff` 摘要可经 transcript `file_diff` 恢复（无全文 hunk）  
- 持久化 CLI turn 会在调用模型前写入 `admitted/running`；完成、错误或取消后写 terminal。若进程中断，resume 将未完成 turn 识别为 `interrupted`，但不会自动重放可能已有副作用的工作。
- 同一进程若有两个调用方同时提交相同 `sessionId`，core 会立即拒绝后到者（`session runner busy`），不会把它写入消息或调用模型；不同 session 可并行。CLI REPL 本身仍按 turn 串行。
- `/turn queue` 在 active turn 后建立 ready 输入；REPL 会在再次询问人工输入前 FIFO 执行，并沿用已分配的 durable `turnId`。
- 持久化会话会把 request/cancel/promote/take/release control lifecycle 追加到 JSONL；写失败时 queue/steer 不执行，interrupt 若已生效会显示 persistence warning。
- 重启后 pending/ready control 只恢复为 `interrupted` 诊断记录，不自动重新排队或重放；当前进程的 `/turn status` 仍只展示 live coordinator。
- background `Agent` 使用独立 task lifecycle：worker 启动前写 admitted/running，完成时先写 result 再写 terminal；result/terminal 写失败不会伪造 completed。
- resume 会把未完成 background task 显示为 `/bg` 的 interrupted 诊断，并恢复已完成摘要；不会重启 worker，也不会自动把 result 注入父消息或重放工具副作用。
- `agents.overflow: "queue"` 会在 cap 满时建立 durable FIFO；queued 可用 `/bg cancel <taskId>` 取消。取消落盘失败会 warning，但任务仍从本进程 executable queue 移除。
- background result 仅在主 queryLoop 安全边界进入 `<background_task_result>`；父 turn 已结束时等下一 turn。重启后只供 `/bg` 检查，不自动重复注入。
- 开发者可通过 `buildRuntimeSnapshot(session)` 取得 protocol v1 纯数据 view-model，并用 `executeRuntimeCommand` 走与 `/runtime` 相同的 expected-state 安全动作；不存在后台 daemon 或自动 replay。
- AR1A 的 `queryRuntimeSnapshot(snapshot, query)` 是 CLI 与 `/runtime list|inspect` 的共享纯 selector；返回记录与输入 snapshot 脱离，consumer 不读取 coordinator/provider 私有对象。
- AR1B1–B2 在 query item 上追加 `availableActions`。active running turn 才显示 interrupt，pending/ready control 与 queued task 才显示 cancel；pending/ready queue 另显示 `control.replace` 与 `requiredInput=["prompt"]`，steer 不显示 replace。interrupted 默认只显示 discard，且仅 idle session 的 admitted-only turn / 未启动 queue 额外显示 retry-safe。resolved/terminal 项不显示动作。
- `/runtime edit <controlId> <prompt>` 不会原地改旧 prompt：它先 cancel 旧 control，再用稳定新 control/turn ID 把 replacement 追加到 FIFO 尾部；`/runtime remove` 复用同一 durable cancel。running/promoted/interrupted 或 stale expected state 均拒绝。
- edit 若已取消旧项但新 admission 失败，会返回 accepted + warning 且不带 replacement；不要换 requestId 重试。完整成功后的同 requestId 可安全取得同一 replacement。
- edit/remove 只针对当前进程仍 executable 的 live queue。顶层 `bolo runtime list|inspect --resume …` 是只读查询；重启后原 pending/ready queue 已投影为 interrupted，不存在可跨进程原地编辑的 live queue。
- 顶层 `bolo runtime discard|retry-safe ... --resume|--continue` 只执行恢复 actions。默认稳定 requestId 让 accepted-with-warning 后的重试复用同一 replacement；换用不同 ID 会 state-conflict。`--request-id` 只用于显式幂等控制。
- 顶层 retry-safe result 会明确 warning：它不调用 provider，也不消费新 queue；进程退出后 replacement 只供 inspect/再次显式处置。要在同进程执行 queue，使用交互 REPL 的 `/runtime retry-safe`，让 REPL 在下一轮 FIFO drain。
- interrupted turn/control/task 可用 `/runtime inspect` 查看、用 `/runtime discard` 追加确认。discard 不删除 lifecycle，只把 resolution 嵌入后续 snapshot。
- `/runtime retry-safe` 仅接受崩溃前还在 admitted 的 turn，或 pending/ready queue control；它会创建新的 durable turn/control 并进入 FIFO，不复活旧 ID。running turn、steer 与 background task 都返回 `not_retry_safe`。
- retry-safe 只表示“重新排队”，不会在命令内调用模型。若返回 accepted + warning，说明新 queue 可能已生效，不要换 requestId 重试；同 requestId 可安全补齐缺失的 resolution 审计。
- 若 retry-safe 后尚未消费就再次重启，replacement 只显示为 interrupted 诊断，不会自动重建 executable queue；可分别 `/runtime inspect` 原记录与 replacement，再决定是否对 replacement 发起新的显式 retry-safe。
- 旧 JSONL 中未知、orphan、跨 session、类型错配或指向非 interrupted 实体的 resolution 会被忽略，其它合法 lifecycle 与 `/runtime` 诊断仍可使用。

```bash
npx bolo --list
npx bolo --resume <id>
npx bolo runtime list --resume <id> --json
```

---

## 10. 故障速查

| 现象 | 处理 |
|------|------|
| 缺 key / 401 | 查 `apiKeyEnv` 与环境变量；`/doctor` |
| effort 400 | `/effort list` 看 choosable；或 `BOLO_EFFORT_LOOSE`（慎用） |
| 热切失败 | `/provider list`；保留旧后端 |
| Desktop 起不来 | 先跑 `npm run build:desktop` / `npm run test:desktop-launch`；再查 Electron 二进制与镜像下载 |
| Agent 工具没有 | `agents.enabled` / `BOLO_AGENTS_ENABLED` |
| 子又开子失败 | 预期：`maxSpawnDepth: 0`；需要时再抬 |
| SearXNG setup 报端口不可用 | 换 `--port`；Windows 的 excluded port range 即使没有监听进程也会返回 EACCES |
| SearXNG 容器在跑但搜不到 | 运行 `bolo search doctor`；查看 working / unresponsive engines，HTTP 200 不代表上游可用 |

---

## 11. 测试与开发者入口

```bash
npm test
npm run typecheck
npx tsx scripts/smoke-turn.ts          # mock 一轮
npx tsx scripts/test-model-retry.ts
npx tsx scripts/test-cli-events.ts
npx tsx scripts/test-worktree-safety.ts
npm run test:runtime-protocol
npm run test:runtime-closeout
npm run test:runtime-cli-query
npm run test:runtime-queue-edit
npm run test:runtime-cli-command
npm run test:runtime-cli-renderer
npm run test:runtime-cli-pager
npm run test:runtime-cli-automation
npm run test:cli-doctor-pager-viewport
npm run test:session-settings
npm run test:desktop-session-settings
npm run test:searxng-setup
npm run test:searxng-setup-cli
npm run test:slash
npm run test:slash-completion
npm run test:slash-display-policy
npm run test:cli-command-surface
npm run test:cli-tui
npx tsx scripts/test-multi-provider.ts
npx tsx scripts/test-ultrathink.ts
```

临时文件只写 **`.bolo-tmp/`**（勿提交）。

交接 / 架构进度 → [AGENT_HANDOFF.md](./AGENT_HANDOFF.md) · [ROADMAP.md](./ROADMAP.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)。
