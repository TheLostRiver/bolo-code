# Bolo Code 使用指南

> 给**使用者**（人类或自动化）：如何安装、配置、跑 CLI/Desktop、配置 **Agent / Subagent**。  
> 契约真源仍是各专题文档；本文是可操作的最短路径。  
> 相关：[CONFIG.md](./CONFIG.md) · [PROVIDERS.md](./PROVIDERS.md) · [SUBAGENT.md](./SUBAGENT.md) · [SUBAGENT_SPEC.md](./SUBAGENT_SPEC.md) · [SLASH_COMMANDS.md](./SLASH_COMMANDS.md)

---

## 1. 安装与初始化

**要求：** Node ≥ 20 · 建议 pnpm 9+（npm 也可）

```bash
git clone https://github.com/TheLostRiver/bolo-code.git
cd bolo-code
pnpm install          # 或 npm install

# 创建全局 ~/.bolo 与项目 .bolo（不覆盖已有文件）
pnpm bolo:init
# 或
npx tsx scripts/bolo-init.ts
```

初始化后大致有：

```text
~/.bolo/
  config.json      # 用户级（JSONC，可写 // 注释）
  agents/          # 用户 subagent 类型 *.md
  skills/ hooks/ mcp.json sessions/ memory/ rules/ plugins/ …

<repo>/.bolo/
  config.json      # 项目级（覆盖用户同名字段）
  agents/ skills/ …
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

# 会话
npx bolo --list
npx bolo --resume <id>
npx bolo --continue

# AR1A：只查询既有会话的 runtime，不调用模型
npx bolo runtime list --resume <id>
npx bolo runtime list task --continue --json
npx bolo runtime inspect turn <turnId> --resume <id> --json
```

REPL 中，模型或工具正在运行时按 `Ctrl-C` 会针对 coordinator 当前 active turn 请求 interrupt 并返回提示符；空闲提示符下按 `Ctrl-C` 才退出。若取消发生在权限问答或 diff 审批面板，core 默认按拒绝处理。

`bolo runtime list|inspect` 必须显式给 `--resume <id|path>` 或 `--continue`，不会进入 picker、创建新会话或调用 provider。每个 item 的 `availableActions` 由当前 snapshot 纯推导，并携带执行所需 expected state；空数组表示当前不应尝试动作。`--json` 成功时 stdout 只有一个 view payload；load/not-found 等查询失败也只有一个 `{ "ok": false, "code": "...", "detail": "..." }` payload。成功 exit 0，查询/加载失败 exit 1，参数使用错误 exit 2。

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

见 [apps/desktop/README.md](../apps/desktop/README.md)。

---

## 4. 常用斜杠（日用）

| 命令 | 作用 |
|------|------|
| `/help` | 命令列表 |
| `/provider` · `/provider use <id>` · `/provider add …` | 后端列表 / 热切 / preset |
| `/model` · `/model name` · `/model id/name` | 模型 |
| `/effort` · `/effort high` | 推理强度（方言 wire） |
| `/ultrathink [off\|tip\|turn]` | CX8 糖；**默认 off** |
| `/agents` · `/bg` · `/bg cancel <taskId>` | subagent 后台 FIFO/status；只取消 queued；resume 后显示 interrupted 诊断 |
| `/turn status` | 当前 active turn 与 queue/steer/interrupt control 状态 |
| `/turn steer <text>` · `/turn interrupt` | 在安全边界修正或取消当前 active turn |
| `/turn queue <text>` · `/turn cancel <controlId>` | FIFO 排队下一轮；执行前取消 pending/ready control |
| `/runtime list [turn\|control\|task]` · `/runtime inspect <turn\|control\|task> <id>` · `/runtime json` | protocol v1 共用 query selector；`json` 保留原始 snapshot |
| `/runtime interrupt <turnId>` · `/runtime cancel <control\|task> <id>` | expected-state 安全动作；target/state 变化时拒绝 |
| `/runtime discard <turn\|control\|task> <id>` | 对 interrupted 记录追加人工确认；不删除原历史 |
| `/runtime retry-safe <turn\|control\|task> <id>` | 只为 admitted-only turn 或未启动 queue 建立新 FIFO turn；其它类型拒绝 |
| `/diff` · `/diff last` · `/diff git` | 本会话文件改动 |
| `/compact` · `/context` · `/cost` | 压缩 · 压力 · 本地 token |
| `/permissions` · `/plan` · `/allow` · `/deny` | 权限 |
| `/hooks` · `/hooks recent` | Hooks |
| `/doctor` | 本地诊断 |
| `/thinking on\|off` | 是否渲染思考链 |

完整表：[SLASH_COMMANDS.md](./SLASH_COMMANDS.md)。

可选关面板：

| 变量 | 作用 |
|------|------|
| `BOLO_PROVIDER_PANEL=0` | `/provider` 仅文本 |
| `BOLO_DIFF_PANEL=0` | `/diff` 仅文本 |
| `BOLO_ARROW_PICKER=0` | 禁用箭头 picker |

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

`bolo:init` / ensure layout 会建空 `agents/`；可参考项目内说明或下面模板。

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

- 落盘：`~/.bolo/sessions/` 或项目 sessions（见 [SESSIONS.md](./SESSIONS.md)）  
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
- AR1B1 在 query item 上追加 `availableActions`。active running turn 才显示 interrupt，pending/ready control 与 queued task 才显示 cancel；interrupted 默认只显示 discard，且仅 idle session 的 admitted-only turn / 未启动 queue 额外显示 retry-safe。resolved/terminal 项不显示动作。
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
| Desktop 起不来 | 检查 `repoRoot` 已修；electron dist；镜像下载 |
| Agent 工具没有 | `agents.enabled` / `BOLO_AGENTS_ENABLED` |
| 子又开子失败 | 预期：`maxSpawnDepth: 0`；需要时再抬 |

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
npx tsx scripts/test-slash.ts
npx tsx scripts/test-multi-provider.ts
npx tsx scripts/test-ultrathink.ts
```

临时文件只写 **`.bolo-tmp/`**（勿提交）。

交接 / 架构进度 → [AGENT_HANDOFF.md](./AGENT_HANDOFF.md) · [ROADMAP.md](./ROADMAP.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)。
