# Bolo Code

跨平台 AI Coding Agent：**Headless 核心 + CLI + Electron 壳**。

- 核心与 UI 解耦，可被 CLI / GUI / 自动化复用  
- Skill · MCP · Hook · Subagent · Plugin 一等公民  
- **无遥测** · **不接** Claude/Codex 官方市场 API  

仓库：https://github.com/TheLostRiver/bolo-code.git  

---

## 文档入口（先读这里）

| 你是… | 先打开 |
|--------|--------|
| **新用户 / 要跑起来** | **[docs/USAGE.md](docs/USAGE.md)**（含 **如何配置 Agent/Subagent**） |
| **接手开发的 Agent / 同事** | **[docs/AGENT_HANDOFF.md](docs/AGENT_HANDOFF.md)**（架构 · 进度 · 改码规矩） |
| **查总进度与各轨** | **[docs/ROADMAP.md](docs/ROADMAP.md)**（进度真源） |
| **查 CLI TUI 重构** | **[docs/CLI_TUI_REFACTOR_PLAN.md](docs/CLI_TUI_REFACTOR_PLAN.md)**（OI-14 retained renderer · OI-15 slash lifecycle）· [选型证据](docs/CLI_TUI_RENDERER_DECISION.md) |
| **查分层边界** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |

---

## 现状（诚实水位）

| 层 | 粗估 | 说明 |
|----|------|------|
| Headless 核心 | ~82–90% | queryLoop · 权限 · tools · STE；partial stream fail-closed |
| **Agent 能力面（工具集）** | **~82–88%** | 15 个常驻/可选工具 + **Web search**（hosted、MCP、SearXNG 均已活体验证） |
| 会话 / CLI | ~92–97% | **零步骤首次启动** · 用户级 workspace JSONL · 旧项目会话兼容 · durable runtime · query/action CLI · TTY pager · pipe/JSON automation |
| **CLI TUI** | **~82–90%** | OI-14 retained 主体与 OI-15A–B display policy/单槽 command surface 已完成；OI-15C–F 继续迁移具体 panel/toast/overlay/history 生命周期；真人 Windows Terminal 观感仍未验 |
| 扩展面 | ~80–88% | MCP · Skills · Plugins |
| Subagent | ~89–95% | `config.agents` + `agents/*.md` · durable task/result · overflow FIFO/cancel · safe delivery · worktree 保全 |
| 文件 Diff 日用 | ~95%+ | D0–D7 · U0–U4 |
| Hooks 日用 | ~96–98% | H0–H5（含 SessionEnd） |
| Compact 日用 | ~93–96% | C0–C5 + AR2A0a/A0b（hybrid 计数 · 中段截断 · 防重摘要） |
| **多 Provider 热切** | **~92–96%** | P0–P4.1 + CX7 Desktop |
| **Effort 方言** | **~92–95%** | E0–E9 |
| **Provider UX** | **~95–98%** | CX0–CX8（ultrathink 默认 off） |
| Durable Runtime | DR0–DR4 ✅ | admission · recovery · 单 runner · durable control/task · FIFO/promotion · v1 protocol/resolution · crash/restart closeout |
| Electron GUI | ~80–88% | 壳 + 流式 + 权限 + runtime IPC/client + 会话切换/恢复 + composer controls + model/effort + control/tool progress 投影 + 多 provider；真人点击/视觉未验 |
| 相对 HC 全家桶 UI | 另计 | 不设 100% |

**已收口：** 日用改文件 · hooks · compact · 多后端热切 · effort · Provider UX
CX0–CX8 · CLI/Agent 可靠性 R0–R4 · Durable Runtime DR0–DR4 · Autonomous Road
AR1 · **AR-T1–T3+ Agent 能力面** · AR2 Compact depth · AR3 Desktop 产品接线 ·
AR4 evidence gate · AR5 release hardening · **OI-04 SearXNG 直连、OI-X1 真实实例
smoke、OI-07 上游诊断 / `search doctor` / 可选 Docker setup、OI-08B CLI 零步骤
首次启动、OI-14A 真实 VT/选型、OI-14B live view-state、OI-14C retained renderer
基座、OI-14D transcript/Markdown、OI-14E Composer/activity/footer、OI-14F
OverlayHost/交互面板、OI-14G 默认切换/可靠性/性能、OI-14H legacy 删除/发布审计、
OI-15A slash display policy、OI-15B retained single-slot command surface**。OI-09–OI-13 的
slash/context/paste/Thought/权限/welcome 局部能力仍然有效，但不再作为整个 TUI
renderer 稳定的证据。

**当前状态：OI-15C–F 是默认 agent 队列。** OI-15A 已在 core 建立
`history | panel | toast | overlay` display policy、运行时 fail-closed 校验和
35 个内建命令分类，并保持 plain `message` 不变。OI-15B `d6bd087` 已在
`packages/shared`/CLI 建立单 panel/toast、单调 generation、可注入 TTL effect、
Composer 下方有界组件以及 input/Esc/reset/restore/stop 清理。具体 slash handler
尚未映射到这些 primitive，所以当前普通 slash 结果仍通过
`appendCompatibilityOutput()` 永久拼在 transcript 与 Composer 之间，所以重复
`/context`、`/skills`、`/plugins`、`/doctor` 会挤满屏幕。OI-15C 起让
Context/Doctor 使用 Composer
下方单 panel，短反馈使用 footer toast，Skills/Plugins 和长内容复用 OverlayHost，
并用 TTL、输入清除、stable key 与 generation 防止累积和迟到结果覆盖。

OI-14 的单 retained renderer、常驻 Composer、Markdown、OverlayHost、物理终端门禁
与 plain/non-TTY fallback 保持不变；OI-15 不增加新 renderer 或其它 Agent 的运行时
依赖。OI-H3 真人 Windows Terminal 走查继续单列。方案与选型证据见
[docs/CLI_TUI_REFACTOR_PLAN.md](docs/CLI_TUI_REFACTOR_PLAN.md) 和
[docs/CLI_TUI_RENDERER_DECISION.md](docs/CLI_TUI_RENDERER_DECISION.md)。

普通 `bolo` 仍是唯一首次启动主路径：自动准备用户级 `~/.bolo`，不会仅因进入仓库
就在 cwd 创建 `.bolo/`；项目模板只由显式 `bolo init [--project]` 创建。SearXNG
doctor 与显式 Docker 管理也已落地，Docker 不是默认依赖。

**人工项：** retained 正文、常驻输入区和 overlays 的碎片、空洞、续行贴左、
cursor/raw-mode 与 owner 交接缺陷已由 OI-14 自动门禁关闭；slash 结果不消失/累积
属于 OI-15 自动任务，不归人工 blocker。真人仍需检查 Windows Terminal 的字体、
颜色、动画和按键/鼠标手感；Desktop 点击与视觉也仍需真人。SearXNG 已完成真实实例
live smoke。

进度真源：[docs/ROADMAP.md](docs/ROADMAP.md)

---

## 快速开始

**要求：** Node ≥ 22.19.0。**无独立运行时依赖**——装完就是一个自包含的单文件。

```bash
npm install -g bolo-code
bolo
```

或者不装，直接跑：

```bash
npx bolo-code
```

首次运行不需要 `init`。Bolo 会自动准备用户状态，但不会自动修改当前项目；只有明确需要
项目级配置模板时才运行：

```bash
bolo init               # 等同 --project，幂等且不覆盖已有文件
bolo init --user        # 显式补齐用户级模板
```

然后配 API key（二选一即可）：

```bash
export ANTHROPIC_API_KEY=...      # 或 OPENAI_API_KEY / BOLO_API_KEY
bolo "帮我看看这个仓库是干什么的"
```

想先空跑一遍、不消耗额度：

```bash
BOLO_PROVIDER=mock bolo -p "hello"
```

更细的配置（多后端、权限、Effort、Subagent、SearXNG 直连）→ 编辑
`~/.bolo/config.json` 或项目 `.bolo/config.json`（JSONC，可用 `//` 注释）。

### 从源码开发

```bash
git clone https://github.com/TheLostRiver/bolo-code.git
cd bolo-code
npm install
npm run dev           # 直接跑 TS 源（tsx）
npm run build         # 打出 dist/bolo.mjs
npm test              # 完整门禁
```

`npm run build` 用 esbuild 把 `packages/*` 打成单文件 `dist/bolo.mjs`。
esbuild 只是**构建期**工具（devDependency）——发布产物的 `dependencies` 恒为 `{}`。

**多后端（推荐）：**

```jsonc
{
  "version": 1,
  "defaultProvider": "work",
  "providers": {
    "work": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  },
  "agents": {
    "enabled": true,
    "maxConcurrent": 3,
    "defaultModel": "inherit",
    "defaultEffort": "medium",
    "maxSpawnDepth": 0
  }
}
```

Key 走环境变量（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / profile `apiKeyEnv`），**勿提交密钥**。

`kind: "openai-compatible"` = 自研 Chat Completions 客户端，**不是** npm `@ai-sdk/openai-compatible`。

**完整步骤、斜杠、权限、Effort、Subagent 配置：** → **[docs/USAGE.md](docs/USAGE.md)**

### 启动 CLI

装过之后命令就是 `bolo`；仓库内开发用 `npm run dev --`。

```bash
bolo
bolo init [--project]
bolo init --user
bolo -p "hello"
bolo --list
bolo --resume <id>
bolo runtime list --resume <id>
bolo runtime list task --continue --json
bolo runtime inspect turn <turnId> --resume <id>
bolo runtime discard turn <turnId> --resume <id> --json
bolo runtime retry-safe control <controlId> --continue --json
```

交互 REPL 先按终端宽度显示 Bolo Code 水晶工作台：宽屏把完整水晶与
workspace/model/session 状态分列，中/紧凑屏回到单列，超宽终端封顶 100 cells；
随后进入全宽输入框。
输入 `/` 会列出内置、CLI-local、Plugin 与 user-invocable Skill；继续输入实时按
精确/前缀过滤。菜单打开时 `↑/↓` 选择、Tab/Enter 补全、Esc 关闭，菜单关闭后
精确命令后的首个空格会显示弱化参数提示，例如 `/effort ` 展示当前
provider/model 真正可选的档位；开始输入实参后提示消失。菜单关闭后 `Enter` 发送、
`Ctrl+J` 换行、`↑/↓` 浏览本进程历史；支持 bracketed paste 的终端会把跨 chunk
多行粘贴聚合成一次插入并规范化 CRLF/CR，不会中途误提交。提交后的问题进入与
composer 同宽的灰色消息块，composer 在 Thinking/Running 期间仍保留；Agent 与
slash 正文按终端宽度保留稳定左侧 gutter。当前思考段显示动画和独立耗时，结束后
留下 `Thought for <duration>`；provider 直接进入正文时也不会吞掉这行。活动/历史
与 composer 之间由 idle/running 共享 gap 保留完整空行。底栏按宽度展示 model/mode、高亮快捷键与
`↓input ↑output` token。Bash 等非文件权限会显示关键参数，并用 `↑/↓` 或快捷键选择
allow once、always 或 deny；嵌入式 picker/diff 不再清除整屏历史。TTY `/context`
显示响应式使用率仪表盘，`/context details` 保留完整诊断；非 TTY 使用紧凑文本。
pipe、`-p`/`--print` 和 JSON 路径保持追加式输出，不发送动态光标控制。完整键位、
欢迎页宽度档位和回落开关见
[docs/TUI.md](docs/TUI.md)。

动态 TTY renderer 已在 OI-14H 收敛为 retained 单一路径：transcript/Markdown、常驻
Composer/activity/footer 与单一 OverlayHost 使用同一 component tree；
permission/question/provider/effort/diff/pager 不暂停 root 或转交 stdin/writer。
普通用户无需也不能选择第二套 engine。自动化或脚本场景继续使用非 TTY/`--print`
plain 路径；TTY 但 raw mode 不可用时自动回落 readline。需要显式关闭动态界面时使用
`BOLO_TUI_INPUT=0` 或 `BOLO_TUI_LAYOUT=0`。重构计划、预算与兼容边界见
[docs/CLI_TUI_REFACTOR_PLAN.md](docs/CLI_TUI_REFACTOR_PLAN.md)。

`runtime list|inspect` 的文本输出在 **stdin/stdout 都是 TTY** 且内容超过一页时自动分页：`n/j/↓/→` 下一页，`p/k/↑/←` 上一页，`q/Esc` 退出，`Ctrl-C` 返回 130。0/1 页不读键盘；pipe 与 `--json` 永不进入 pager、不会输出 ANSI/banner，也不会因为大列表挂起。

`--json` 成功时 stdout 是单个原始 `runtime.list|runtime.inspect` view；失败是单个 `{ "ok": false, "code": "...", "detail": "..." }`。usage / load / query failure 分别 exit 2 / 1 / 1。顶层 recovery command 成功仍输出 protocol `runtime.result`。

### 常用斜杠

| 命令 | 作用 |
|------|------|
| 输入 `/` · `/d` | 显示全部命令 · 实时过滤并补全 `/doctor` |
| `/help` | 命令列表 |
| `/provider` · `/provider add` · `/provider use` | 后端热切 / preset |
| `/model` · `/effort` · `/ultrathink` | 模型 · 推理强度 · CX8 糖 |
| `/agents` · `/bg` · `/bg cancel <taskId>` | Subagent 后台 FIFO/status；只取消 queued；resume 后含 interrupted 诊断 |
| `/turn status` · `/turn queue` · `/turn interrupt` | turn/control 状态与安全控制 |
| `/runtime list [entity]` · `/runtime inspect <entity> <id>` · `/runtime json` | 共用 query view + availableActions；顶层 `bolo runtime … --json` 为单 payload |
| `/runtime interrupt <turnId>` · `/runtime cancel <control\|task> <id>` | expected-state 安全动作；竞态 fail-closed |
| `/runtime edit <controlId> <prompt>` · `/runtime remove <controlId>` | 同进程 live queue 的 append-only 替换/删除；旧历史保留 |
| `/runtime discard <turn\|control\|task> <id>` · `/runtime retry-safe <turn\|control\|task> <id>` | interrupted 人工处置；只重排可证明未开始的输入 |
| `bolo runtime discard\|retry-safe … --resume\|--continue [--json]` | 顶层 recovery actions；稳定 requestId、单 payload、exit 0/1/2；retry-safe 不自动执行 |
| `/diff` · `/compact` · `/context [details]` · `/cost` | Diff · 压缩 · 上下文概览/诊断 · 费用 |
| `/permissions` · `/hooks` · `/doctor` | 权限 · Hooks · 诊断 |

### Desktop（可选）

```bash
cd apps/desktop
# 国内可：set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
set BOLO_DESKTOP_MOCK=1
npm start
```

见 [apps/desktop/README.md](apps/desktop/README.md)

---

## 内置工具

| 工具 | 说明 |
|------|------|
| `Bash` | 跑 shell；`run_in_background: true` 转后台（dev server / watcher / 长构建） |
| `BashOutput` | 读后台 shell 的**增量**输出（游标不重不漏） |
| `KillShell` | 停后台 shell；杀整棵进程树；对已结束的 shell 是安全 no-op |
| `Read` · `Write` · `Edit` · `apply_patch` | 文件读写与补丁 |
| `Glob` · `Grep` | 查找 |
| `TodoWrite` | 多步任务的待办表；**存在会话状态里而非消息历史**，因此 compact 后不丢，resume 可恢复 |
| `Skill` | 按 id 载入 skill 全文 |
| `WebFetch` | 取 http(s) 文本 |
| `ExitPlanMode` | 提交计划请用户批准，退出 plan 模式 |
| `AskUserQuestion` | 在交互会话中向用户展示结构化单选/多选/自由文本问题 |
| `Agent` | 拉起 subagent |

**Web search** 由你正在对话的 provider 服务端执行——不引入新的第三方接收方，
所以默认开启。`/websearch [on|off|auto]` 可切换。
Anthropic 与 OpenAI Responses 两条线路已实测；其它端点可配搜索 MCP server，
也可显式直连自己的 SearXNG。已有 Docker 的用户可运行
`bolo search searxng setup` 创建 Bolo 管理的 loopback 实例；
`bolo search status` 只看配置，`bolo search doctor [--json]` 才实际探活并要求
smoke 结果非空。

后台 shell **跨 turn 存活，但绝不越过会话**：`endSession` 统一收尸，不留僵尸进程。
实现无任何运行时依赖（进程树 kill 走 POSIX 进程组 / Windows `taskkill /T /F`）。

---

## 配置 Agent（摘要）

两层概念：

1. **主会话** — 当前 CLI/Desktop 的 agent loop（provider / 权限 / effort）  
2. **Subagent** — 主模型通过 **`Agent` 工具** 拉起的子任务  

**全局策略**（`config.json` → `agents`）：

```jsonc
"agents": {
  "enabled": true,
  "maxConcurrent": 3,
  "defaultModel": "inherit",
  "defaultEffort": "medium",
  "maxSpawnDepth": 0,   // 0 = 子默认不能再 spawn
  "overflow": "reject"  // 改为 queue：cap 满时 durable FIFO
}
```

**自定义类型：** `~/.bolo/agents/*.md` 与 `.bolo/agents/*.md`（后者覆盖同名）。

```markdown
---
name: reviewer
description: PR risk review
tools: Read, Glob, Grep
disallowedTools: Write, Edit, Bash, Agent
effort: high
---
You are a careful reviewer. Do not modify files.
```

内置：`explore` / `general` / `plan` / `fork`。CLI：`/agents`、`/agents status`、`/bg`、`/bg cancel <taskId>`；cancel 只接受尚未启动的 queued task。

**逐步说明与嵌套示例 → [docs/USAGE.md §5](docs/USAGE.md)** · 契约 [docs/SUBAGENT_SPEC.md](docs/SUBAGENT_SPEC.md)

---

## 仓库结构

```text
packages/
  core/        会话 · queryLoop · slash · subagent · diff · ultrathink
  providers/   compatible · responses · anthropic · effort 方言 · caps
  tools/       Bash（含后台）· BashOutput · KillShell · 读写 · apply_patch
               TodoWrite · textDiff · gitDiff
  config/      ~/.bolo · .bolo · providers · preset
  hooks/ compact/ skills/ mcp/ plugins/ permissions/ shared/ cli/
apps/
  desktop/     Electron 薄壳（IPC only）
docs/          契约 · 路线 · 使用 · 交接（真源）
scripts/       单测与 smoke
```

原则：先改 `packages/*` 契约，再接 `apps/desktop`。

---

## 文档索引

| 文档 | 说明 |
|------|------|
| **[docs/USAGE.md](docs/USAGE.md)** | **使用手册**（安装 · Provider · **Agent 配置** · 斜杠） |
| **[docs/AGENT_HANDOFF.md](docs/AGENT_HANDOFF.md)** | **交接手册**（架构 · 进度 · 入口 · 反模式） |
| [docs/ROADMAP.md](docs/ROADMAP.md) | **总进度与各轨水位** |
| [docs/ROADMAP_HISTORY.md](docs/ROADMAP_HISTORY.md) | 已完成轨存档（切片明细 · 落地契约） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层 · 模块边界 |
| [docs/CONFIG.md](docs/CONFIG.md) | 配置布局 · 合并规则 |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | 协议 · 多 provider · 热切 |
| [docs/PROVIDER_UX.md](docs/PROVIDER_UX.md) | CX 便利层（preset · caps · ultrathink…） |
| [docs/EFFORT.md](docs/EFFORT.md) | 推理强度方言 E0–E5 |
| [docs/EFFORT_OPTIMIZATION.md](docs/EFFORT_OPTIMIZATION.md) | E6+ 可选档 · 门控 · TTY |
| [docs/HOOKS.md](docs/HOOKS.md) | Hook 事件（含 SessionEnd） |
| [docs/COMPACTION.md](docs/COMPACTION.md) | 压缩管道 |
| [docs/FILE_DIFF_SPEC.md](docs/FILE_DIFF_SPEC.md) | 文件 Diff 日用 + UI |
| **[docs/TOOLS.md](docs/TOOLS.md)** | **内置工具契约**（TodoWrite · 后台 shell · 权限分类） |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | 权限四档 |
| [docs/AGENT_LOOP.md](docs/AGENT_LOOP.md) | Agent loop |
| [docs/SESSIONS.md](docs/SESSIONS.md) | 会话落盘 · resume |
| [docs/SLASH_COMMANDS.md](docs/SLASH_COMMANDS.md) | 斜杠命令 |
| [docs/TUI.md](docs/TUI.md) | CLI TUI · 环境变量 |
| [docs/CLI_TUI_REFACTOR_PLAN.md](docs/CLI_TUI_REFACTOR_PLAN.md) | OI-14 retained renderer · OI-15 slash surface/lifecycle · 参考审计 · 迁移/回滚/验收 |
| [docs/SKILLS.md](docs/SKILLS.md) · [MCP.md](docs/MCP.md) · [PLUGINS.md](docs/PLUGINS.md) | 扩展面 |
| [docs/SUBAGENT.md](docs/SUBAGENT.md) · [SUBAGENT_SPEC.md](docs/SUBAGENT_SPEC.md) | Subagent |
| [docs/PROMPT_CACHE.md](docs/PROMPT_CACHE.md) | Prompt cache 观测 |
| [docs/ENGINEERING_PRINCIPLES.md](docs/ENGINEERING_PRINCIPLES.md) | 先借鉴再实现 · **禁止遥测** |
| [docs/REFERENCES.md](docs/REFERENCES.md) | 参考项目取舍 |

项目级布局：[.bolo/README.md](.bolo/README.md)

---

## 开发与测试

```bash
npm test
npm run typecheck

npm run test:runtime-cli-renderer
npm run test:runtime-cli-pager
npm run test:runtime-cli-automation
npm run test:searxng-setup
npm run test:searxng-setup-cli
npx tsx scripts/test-todo.ts
npx tsx scripts/test-todo-session.ts
npx tsx scripts/test-bash-background.ts
npx tsx scripts/test-bash-background-runtime.ts
npx tsx scripts/test-multi-provider.ts
npx tsx scripts/test-provider-ux.ts
npx tsx scripts/test-ultrathink.ts
npx tsx scripts/test-effort-dialect.ts
npx tsx scripts/test-slash.ts
npx tsx scripts/test-config.ts
npx tsx scripts/test-file-diff.ts
npx tsx scripts/smoke-turn.ts
```

`npm test` 是默认总门禁，已包含 Durable Runtime、AR1
query/action/renderer/pager/automation、PTL 恢复与真实 Electron 启动专项；
未登记的新实验仍须显式运行对应 `scripts/test-*.ts`。

临时文件只写 **`.bolo-tmp/`**（已 gitignore，勿提交）。

接手开发请跟 [docs/AGENT_HANDOFF.md](docs/AGENT_HANDOFF.md) 的检查清单。

---

## 原则

1. **职责分明**的模块架构优先于炫技实现  
2. 先审计许可证与兼容性；允许复用成熟基础库或有归属的窄 fork，不复制未许可源码、不嵌入本机参考路径、不抄遥测
3. 密钥走环境变量 / `apiKeyEnv`；**不**写进 transcript  
4. TUI 必须由真实物理终端测试证明；不盲选框架，也不为“零依赖”重复手搓成熟 renderer — 见 OI-14/OI-15 方案

License：MIT
