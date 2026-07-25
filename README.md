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
| **查分层边界** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |

---

## 现状（诚实水位）

| 层 | 粗估 | 说明 |
|----|------|------|
| Headless 核心 | ~80–88% | queryLoop · 权限 · tools · STE；partial stream fail-closed |
| 会话 / CLI | ~80–88% | JSONL · new/resume 同构 runtime · turn 取消 · Durable Turn DR0–DR1 |
| 扩展面 | ~80–88% | MCP · Skills · Plugins |
| Subagent | ~85–92% | `config.agents` + `agents/*.md` · worktree 成果保全 |
| 文件 Diff 日用 | ~95%+ | D0–D7 · U0–U4 |
| Hooks 日用 | ~96–98% | H0–H5（含 SessionEnd） |
| Compact 日用 | ~92–95% | C0–C5 |
| **多 Provider 热切** | **~92–96%** | P0–P4.1 + CX7 Desktop |
| **Effort 方言** | **~92–95%** | E0–E9 |
| **Provider UX** | **~95–98%** | CX0–CX8（ultrathink 默认 off） |
| Durable Turn | DR0–DR1 ✅ | admission · lifecycle · crash recovery projection |
| Electron GUI | ~65–75% | 壳 + 流式 + 权限 + Settings + 多 provider |
| 相对 HC 全家桶 UI | 另计 | 不设 100% |

**已收口：** 日用改文件 · hooks · compact · 多后端热切 · effort · Provider UX CX0–CX8 · CLI/Agent 可靠性 R0–R4 · Durable Turn DR0–DR1。

**当前主线：** Durable Turn DR2 coordinator；DR3 background/subagent、DR4 protocol 后续。

**非阻塞开放轨：** Compact §8.9 · U5 真·Ink/IDE · adaptive thinking · Desktop 体验打磨。

进度真源：[docs/ROADMAP.md](docs/ROADMAP.md)

---

## 快速开始

**要求：** Node ≥ 20 · 建议 pnpm 9+

```bash
pnpm install          # 或 npm install
pnpm bolo:init        # 或 npx tsx scripts/bolo-init.ts
```

配置 API（JSONC，可用 `//` 注释）→ 编辑 `~/.bolo/config.json` 或项目 `.bolo/config.json`。

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

```bash
npx bolo
npx bolo -p "hello"
npx bolo --list
npx bolo --resume <id>
```

### 常用斜杠

| 命令 | 作用 |
|------|------|
| `/help` | 命令列表 |
| `/provider` · `/provider add` · `/provider use` | 后端热切 / preset |
| `/model` · `/effort` · `/ultrathink` | 模型 · 推理强度 · CX8 糖 |
| `/agents` · `/bg` | Subagent 类型与后台 |
| `/diff` · `/compact` · `/context` · `/cost` | Diff · 压缩 · 费用 |
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
  "overflow": "reject"
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

内置：`explore` / `general` / `plan` / `fork`。CLI：`/agents`。  

**逐步说明与嵌套示例 → [docs/USAGE.md §5](docs/USAGE.md)** · 契约 [docs/SUBAGENT_SPEC.md](docs/SUBAGENT_SPEC.md)

---

## 仓库结构

```text
packages/
  core/        会话 · queryLoop · slash · subagent · diff · ultrathink
  providers/   compatible · responses · anthropic · effort 方言 · caps
  tools/       Bash · 读写 · apply_patch · textDiff · gitDiff
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
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层 · 模块边界 |
| [docs/CONFIG.md](docs/CONFIG.md) | 配置布局 · 合并规则 |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | 协议 · 多 provider · 热切 |
| [docs/PROVIDER_UX.md](docs/PROVIDER_UX.md) | CX 便利层（preset · caps · ultrathink…） |
| [docs/EFFORT.md](docs/EFFORT.md) | 推理强度方言 E0–E5 |
| [docs/EFFORT_OPTIMIZATION.md](docs/EFFORT_OPTIMIZATION.md) | E6+ 可选档 · 门控 · TTY |
| [docs/HOOKS.md](docs/HOOKS.md) | Hook 事件（含 SessionEnd） |
| [docs/COMPACTION.md](docs/COMPACTION.md) | 压缩管道 |
| [docs/FILE_DIFF_SPEC.md](docs/FILE_DIFF_SPEC.md) | 文件 Diff 日用 + UI |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | 权限四档 |
| [docs/AGENT_LOOP.md](docs/AGENT_LOOP.md) | Agent loop |
| [docs/SESSIONS.md](docs/SESSIONS.md) | 会话落盘 · resume |
| [docs/SLASH_COMMANDS.md](docs/SLASH_COMMANDS.md) | 斜杠命令 |
| [docs/TUI.md](docs/TUI.md) | CLI TUI · 环境变量 |
| [docs/SKILLS.md](docs/SKILLS.md) · [MCP.md](docs/MCP.md) · [PLUGINS.md](docs/PLUGINS.md) | 扩展面 |
| [docs/SUBAGENT.md](docs/SUBAGENT.md) · [SUBAGENT_SPEC.md](docs/SUBAGENT_SPEC.md) | Subagent |
| [docs/PROMPT_CACHE.md](docs/PROMPT_CACHE.md) | Prompt cache 观测 |
| [docs/ENGINEERING_PRINCIPLES.md](docs/ENGINEERING_PRINCIPLES.md) | 先借鉴再实现 · **禁止遥测** |
| [docs/REFERENCES.md](docs/REFERENCES.md) | 参考项目取舍 |

项目级布局：[.bolo/README.md](.bolo/README.md)

---

## 开发与测试

```bash
pnpm typecheck

npx tsx scripts/test-multi-provider.ts
npx tsx scripts/test-provider-ux.ts
npx tsx scripts/test-ultrathink.ts
npx tsx scripts/test-effort-dialect.ts
npx tsx scripts/test-slash.ts
npx tsx scripts/test-config.ts
npx tsx scripts/test-file-diff.ts
npx tsx scripts/smoke-turn.ts
```

`pnpm test` 跑 package.json 登记脚本（未覆盖全部轨；新轨以对应 `scripts/test-*.ts` 为准）。

临时文件只写 **`.bolo-tmp/`**（已 gitignore，勿提交）。

接手开发请跟 [docs/AGENT_HANDOFF.md](docs/AGENT_HANDOFF.md) 的检查清单。

---

## 原则

1. **职责分明**的模块架构优先于炫技实现  
2. 借鉴 HC / Codex **语义**，不嵌入其本地路径、不抄遥测  
3. 密钥走环境变量 / `apiKeyEnv`；**不**写进 transcript  
4. 日用 95%+ ≠ Ink/ratatui 全家桶 100% — 见 ROADMAP 双轨说明  

License：MIT
