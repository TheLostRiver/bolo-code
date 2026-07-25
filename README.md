# Bolo Code

跨平台 AI Coding Agent：**Headless 核心 + CLI + Electron 壳**。

- 核心与 UI 解耦，可被 CLI / GUI / 自动化复用  
- Skill · MCP · Hook · Subagent · Plugin 一等公民  
- **无遥测** · **不接** Claude/Codex 官方市场 API  

仓库：https://github.com/TheLostRiver/bolo-code.git  

---

## 现状（诚实水位）

| 层 | 粗估 | 说明 |
|----|------|------|
| Headless 核心 | ~80–88% | queryLoop · 权限 · tools · STE |
| 会话 / CLI | ~80–88% | JSONL · resume · slash · TTY 面板 |
| 扩展面 | ~80–88% | MCP · Skills · Plugins |
| Subagent | ~85–92% | 见 `docs/SUBAGENT_SPEC.md` |
| 文件 Diff 日用 | ~95%+ | D0–D7 · U0–U4 |
| Hooks 日用 | ~96–98% | H0–H5（含 SessionEnd） |
| Compact 日用 | ~92–95% | C0–C5 |
| **多 Provider 热切** | **~92–96%** | P0–P4.1：`providers` 表 + `/provider` 箭头选 |
| Electron GUI | ~55–65% | 可用壳，非 HC 级 IDE |
| 相对 HC 全家桶 UI | 另计 | 不设 100% |

**主线已收口：** 日用 agent 改文件 · hooks · compact · 多后端热切。  
**后置：** Desktop 多 provider UI（P5）· resume 持久化 `providerId` · U5 真·Ink/IDE。

进度真源：[docs/ROADMAP.md](docs/ROADMAP.md)

---

## 快速开始

**要求：** Node ≥ 20 · 建议 pnpm 9+

```bash
# 克隆后
pnpm install          # 或 npm install

# 初始化全局 ~/.bolo 与项目 .bolo（不覆盖已有 config）
npx tsx scripts/bolo-init.ts
# 或
pnpm bolo:init
```

### 配置 API

编辑 `~/.bolo/config.json` 或项目 `.bolo/config.json`（JSONC，可用 `//` 注释）。

**单后端（旧字段，仍支持）：**

```jsonc
{
  "version": 1,
  "provider": {
    "kind": "openai-compatible",   // 或 openai-responses | anthropic | mock
    "baseUrl": "https://api.siliconflow.cn/v1",
    "model": "deepseek-ai/DeepSeek-V4-Flash"
  },
  "permissionMode": "default"
}
```

**多后端（推荐 · 可运行中切换）：**

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
    },
    "sf": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.siliconflow.cn/v1",
      "model": "deepseek-ai/DeepSeek-V4-Flash",
      "apiKeyEnv": "SILICONFLOW_API_KEY"
    }
  }
}
```

**Key 用环境变量**（勿提交进仓库）：

| 变量 | 用途 |
|------|------|
| `BOLO_API_KEY` / `OPENAI_API_KEY` | 通用 / OpenAI 兼容 |
| `ANTHROPIC_API_KEY` | Anthropic |
| `BOLO_PROVIDER=mock` | 强制本地 mock |
| profile 的 `apiKeyEnv` | 指定该后端读哪个 env |

`kind: "openai-compatible"` = 自研 Chat Completions 客户端（`/v1/chat/completions`），兼容 OpenAI / DeepSeek / 硅基流动等；**不是** npm 包 `@ai-sdk/openai-compatible`。

详见 [docs/PROVIDERS.md](docs/PROVIDERS.md) · [docs/CONFIG.md](docs/CONFIG.md)

### 启动 CLI

```bash
# 新会话 REPL（TTY）
npx bolo
# 或
node packages/cli/bin/bolo.js

# 单轮
npx bolo -p "hello"

# 恢复
npx bolo --list
npx bolo --resume <id>
npx bolo --continue
```

### 常用斜杠

| 命令 | 作用 |
|------|------|
| `/help` | 命令列表 |
| `/provider` | **TTY：箭头选后端并热切**；非 TTY 文本列表 |
| `/provider list` | 仅文本 |
| `/provider use <id>` | 精确切换（脚本） |
| `/model` · `/model <name>` · `/model id/name` | 看/改模型 |
| `/diff` · `/diff last` · `/diff git` | 本会话文件改动 |
| `/compact` · `/context` · `/cost` | 压缩 · 压力 · 本地费用 |
| `/hooks` · `/hooks recent` | Hooks · 诊断 |
| `/permissions` · `/plan` · `/allow` | 权限 |
| `/doctor` | 本地诊断 |

更多：[docs/SLASH_COMMANDS.md](docs/SLASH_COMMANDS.md) · [docs/TUI.md](docs/TUI.md)

关闭交互面板（可选）：

| 变量 | 作用 |
|------|------|
| `BOLO_PROVIDER_PANEL=0` | `/provider` 只打文本 |
| `BOLO_DIFF_PANEL=0` | `/diff` 只打文本 |
| `BOLO_ARROW_PICKER=0` | 禁用箭头 picker |

### Desktop（可选）

```bash
cd apps/desktop && pnpm install && pnpm dev
```

见 [apps/desktop/README.md](apps/desktop/README.md)

---

## 仓库结构

```text
packages/
  core/        会话 · queryLoop · slash · subagent · diff log
  providers/   openai-compatible · responses · anthropic · mock
  tools/       Bash · 读写 · apply_patch · textDiff · gitDiff
  config/      ~/.bolo · .bolo · providers 归一化
  hooks/       HookBus
  compact/     full / snip / micro / auto / PTL
  skills/ mcp/ plugins/ permissions/ shared/ cli/
apps/
  desktop/     Electron 壳
docs/          契约与路线（真源）
scripts/       单测与 smoke
```

原则：先改 `packages/*` 契约，再接 `apps/desktop`。

---

## 文档索引

| 文档 | 说明 |
|------|------|
| [docs/ROADMAP.md](docs/ROADMAP.md) | **总进度与各轨水位** |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层 · 模块边界 |
| [docs/CONFIG.md](docs/CONFIG.md) | 配置布局 · 合并规则 |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | 协议 · 多 provider · 热切 |
| [docs/EFFORT.md](docs/EFFORT.md) | 推理强度方言（**E0–E5 实现**） |
| [docs/EFFORT_OPTIMIZATION.md](docs/EFFORT_OPTIMIZATION.md) | Effort **E6+ 优化设计**（可选档 · 门控 · TTY） |
| [docs/HOOKS.md](docs/HOOKS.md) | Hook 事件（含 SessionEnd） |
| [docs/COMPACTION.md](docs/COMPACTION.md) | 压缩管道 |
| [docs/FILE_DIFF_SPEC.md](docs/FILE_DIFF_SPEC.md) | 文件 Diff 日用 + UI |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | 权限四档 |
| [docs/AGENT_LOOP.md](docs/AGENT_LOOP.md) | Agent loop |
| [docs/SESSIONS.md](docs/SESSIONS.md) | 会话落盘 · resume |
| [docs/SLASH_COMMANDS.md](docs/SLASH_COMMANDS.md) | 斜杠命令 |
| [docs/TUI.md](docs/TUI.md) | CLI TUI · 环境变量 |
| [docs/SKILLS.md](docs/SKILLS.md) | Skills 目录与按需加载 |
| [docs/MCP.md](docs/MCP.md) | MCP |
| [docs/PLUGINS.md](docs/PLUGINS.md) | 插件 |
| [docs/SUBAGENT_SPEC.md](docs/SUBAGENT_SPEC.md) | Subagent 契约 |
| [docs/PROMPT_CACHE.md](docs/PROMPT_CACHE.md) | Prompt cache 观测 |
| [docs/ENGINEERING_PRINCIPLES.md](docs/ENGINEERING_PRINCIPLES.md) | 先借鉴再实现 · **禁止遥测** |
| [docs/REFERENCES.md](docs/REFERENCES.md) | 参考项目取舍 |

项目级布局说明：[.bolo/README.md](.bolo/README.md)

---

## 开发与测试

```bash
# 类型检查
pnpm typecheck

# 常用单测（节选）
npx tsx scripts/test-multi-provider.ts
npx tsx scripts/test-slash.ts
npx tsx scripts/test-config.ts
npx tsx scripts/test-provider-unit.ts
npx tsx scripts/test-hooks-htrack.ts
npx tsx scripts/test-compact-c-track.ts
npx tsx scripts/test-file-diff.ts
npx tsx scripts/test-diff-view.ts
npx tsx scripts/smoke-turn.ts          # mock 一轮
npx tsx scripts/smoke-live.ts          # 需 API key
```

`pnpm test` 会跑 package.json 里登记的一批脚本（未覆盖全部轨；新轨以对应 `scripts/test-*.ts` 为准）。

临时文件只写 **`.bolo-tmp/`**（已 gitignore，勿提交）。

---

## 原则

1. **职责分明**的模块架构优先于炫技实现  
2. 借鉴 HC / Codex **语义**，不嵌入其本地路径、不抄遥测  
3. 密钥走环境变量 / `apiKeyEnv`；**不**写进 transcript  
4. 日用 95%+ ≠ Ink/ratatui 全家桶 100% — 见 ROADMAP 双轨说明  

License：MIT