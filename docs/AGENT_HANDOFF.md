# Bolo Code — Agent 交接手册

> **读者：** 接手本仓库的 AI agent / 人类开发者。  
> **目标：** 15 分钟内建立正确心智模型，避免重做已完成轨、违反硬约束、改错模块。  
> **更新水位时：** 先改 [ROADMAP.md](./ROADMAP.md)，再同步本文件 §3 与 [README.md](../README.md)。

---

## 0. 30 秒必读

```text
Bolo Code = Headless Agent Runtime (packages/*)
          + CLI (packages/cli)
          + 薄 Electron 壳 (apps/desktop)
```

| 硬规则 | 说明 |
|--------|------|
| **无遥测** | 不实现 / 不预留 phone-home、GrowthBook、官方分析 |
| **无官方市场 API** | 不接 Claude/Codex 官方插件市场 |
| **先契约后壳** | 改 `packages/*` 契约，再接 CLI / Desktop |
| **借鉴语义不抄路径** | 可对标 HC / Codex / OpenCode / Pi；**禁止**把本机 HC/Codex 路径写进产品文档 |
| **日用 ≠ UI 全家桶** | 95%+ 日用契约 ≠ Ink/ratatui 100% 密度 |
| **临时文件** | 只写 `.bolo-tmp/`；**永不提交** |
| **密钥** | env / `apiKeyEnv`；不进 transcript / 仓库 |

仓库：https://github.com/TheLostRiver/bolo-code.git · 默认分支 `main`

---

## 1. 先读哪几份（顺序）

| 顺序 | 文档 | 用途 |
|------|------|------|
| 1 | **本文** | 心智模型 + 进度 + 改码规矩 |
| 2 | [ROADMAP.md](./ROADMAP.md) | **进度真源** · 各轨水位 · 开放项 |
| 3 | [ARCHITECTURE.md](./ARCHITECTURE.md) | 分层 · 模块禁止项 |
| 4 | [ENGINEERING_PRINCIPLES.md](./ENGINEERING_PRINCIPLES.md) | 先借鉴再实现 · tool 管道顺序 |
| 5 | [USAGE.md](./USAGE.md) | 人类用法 · **含 Agent/Subagent 配置** |
| 6 | 按任务专题 | 见 §6 文档地图 |

**不要**从 `docs/TODO*.md` 当现行真源（多为历史轨，只读）。

---

## 2. 架构心智模型

### 2.1 分层

```text
apps/desktop          Electron：IPC 编排 only，无重业务
packages/cli          REPL / resume / TTY 面板 / 事件打印
packages/core         Session · queryLoop · slash · subagent · diff log · ultrathink
packages/providers    协议适配 + effort 方言 + caps + 错误解释
packages/tools        Bash / 读写 / apply_patch / textDiff / gitDiff（不自判 allow）
packages/permissions  四档模式 · always allow/deny · auto 分类
packages/config       ~/.bolo · .bolo · providers 归一 · preset
packages/hooks        HookBus
packages/compact      full / snip / micro / auto / PTL
packages/skills|mcp|plugins|shared
```

### 2.2 主数据流（单 turn）

```text
UserPromptSubmit hooks
  → messages.push(user)
  → [CX8 ultrathink 可改本轮 effort，不写 session.effortLevel]
  → queryLoop:
       prepareMessages (snip → micro → auto compact)
       → callModel (stream + tools)
       → 每个 tool:
            PreToolUse → PermissionGate → execute → PostToolUse
       → mid-turn compact 可选
  → Stop / done
```

权限判断在 **PermissionGate**，不在各个 tool 内私自 allow/deny。

### 2.3 配置合并

```text
defaults < ~/.bolo < 项目 .bolo < 环境变量（Key / 熔断）
```

- 多后端：`config.providers` + `defaultProvider`  
- 会话热切：`/provider use` → `switchSessionProvider`（rebuild provider，effort clamp）  
- Subagent：`config.agents` + `agents/*.md`（见 USAGE §5）

### 2.4 关键类型别混

| 名 | 含义 |
|----|------|
| **主会话** | CLI/Desktop 的 BoloSession + queryLoop |
| **Subagent** | `Agent` 工具 spawn 的子 loop（`runSubagent`） |
| **provider kind** | 协议：`openai-compatible` / `openai-responses` / `anthropic` / `mock` |
| **providerId** | 配置表 key（如 `work`），≠ kind |
| **effort 意图** | `session.effortLevel`；wire 由 dialect 表生成 |
| **ultrathink** | 产品糖（默认 off）；不是 API 字面量 `ultra` |

---

## 3. 整体进度（诚实水位 · 与 ROADMAP 对齐）

> 数字是**日用可用度粗估**，不是代码覆盖率。

| 层 | 粗估 | 状态摘要 |
|----|------|----------|
| Headless 核心 | ~80–88% | queryLoop · STE · 权限 · tools；partial stream fail-closed |
| 会话 / CLI | ~90–96% | JSONL · new/resume 同构 runtime · durable controls/tasks · background FIFO/promotion · versioned runtime protocol |
| 扩展面 | ~80–88% | MCP · Skills · Plugins |
| Subagent | ~89–95% | Spec v0；durable task/result · overflow FIFO/cancel · safe-boundary delivery · worktree 成果保全 |
| 文件 Diff 日用 | ~95%+ | **D0–D7** |
| 文件 Diff UI | ~90–95% | **U0–U4**；U5 真 Ink/IDE 可选 |
| Hooks 日用 | ~96–98% | **H0–H5**（含 SessionEnd） |
| Compact 日用 | ~92–95% | **C0–C5**；§8.9 后置 |
| 多 Provider 热切 | ~92–96% | **P0–P4.1 + CX7 Desktop** |
| Effort 方言 | ~92–95% | **E0–E9** |
| Provider UX | ~95–98% | **CX0–CX8**（ultrathink 默认 off） |
| Durable Runtime | DR0–DR4A ✅ | 输入先落盘 · recovery · 单 runner · durable control/task · FIFO/promotion · v1 protocol |
| Electron GUI | ~65–75% | 薄壳；非 HC 级 IDE |
| 产品相对 HC 全家桶 | ~74–88% | 日用高；UI 密度另计 |

**已闭环：** Diff · Hooks · Compact · Provider · Effort · Provider UX CX0–CX8 · **CLI/Agent 可靠性 R0–R4** · **Durable Runtime DR0–DR4A**。

**当前主线：** Durable Runtime **DR4B2 interrupted discard/retry-safe**；DR4B1 protocol executor + `/runtime` diagnostics 已落地，DR4C 后续。

**其它开放轨（非阻塞）：**

| 项 | 说明 |
|----|------|
| Compact §8.9 | partial / remote / 真 tokenizer 等 |
| U5 | 真 React Ink / IDE diff 推送（可选） |
| adaptive thinking | 与 effort 深联动 |
| Desktop 打磨 | effort UI · session list · markdown/tool cards 等 |
| Durable Runtime DR4 | runtime protocol · CLI diagnostics · closeout |

Durable Runtime 的长期执行顺序以 [ROADMAP.md](./ROADMAP.md) §13.4–§13.10 为准：

```text
DR2A 单 session runner ✅
→ DR2B1 control intent ✅
→ DR2B2 queryLoop safe-boundary wiring ✅
→ DR2B3 permission/diff ask + CLI races ✅
→ DR2C1 control schema/projection ✅
→ DR2C2 lifecycle persistence wiring ✅
→ DR2C3 crash/failure closeout ✅
→ DR3A durable background task ✅
→ DR3B queue + parent-boundary promotion ✅
→ DR4A runtime protocol ✅
→ DR4B1 executor + CLI diagnostics ✅
→ DR4B2 discard/retry-safe（当前）
→ DR4C closeout
→ AR1 CLI/TUI runtime UX
→ AR2 Compact depth
→ AR3 Codex App 风格 Desktop
→ AR4 证据驱动深水项
→ AR5 release hardening
```

每刀都必须先改 `packages/*` 契约和失败测试，再接 CLI/Desktop；定向测试、typecheck、完整 `npm test`、scoped `diff --check` 全绿后，代码与文档分批 commit/push。遇到需要数据库/daemon/RPC、用户脏文件冲突、数据丢失或副作用自动重放风险时停止扩张。

**永不：** 遥测 · 官方市场 API。

---

## 4. 路线图怎么读

[ROADMAP.md](./ROADMAP.md) 结构要点：

| 章节 | 内容 |
|------|------|
| §0 | 一句话进度表 |
| §1 | **双轨**：日用契约 vs UI 密度 |
| §2–3 | Diff D 轨 / U 轨 |
| §4–5 | 产品目标 · 里程碑总表 |
| §6 | 文档地图 |
| §7–8 | Hooks · Compact |
| §9 | Provider 多实例 |
| §10 | Effort |
| §11 | Provider UX（CX） |
| §12 | CLI / Agent 可靠性（R0–R4） |
| §13 | Durable Turn（DR0–DR4） |

历史切片命名（实现时仍会在 commit/message 出现）：

| 前缀 | 轨 |
|------|-----|
| D* | File diff 契约 |
| U* | Diff 交互 UI |
| H* | Hooks |
| C* | Compact |
| P* | Multi-provider |
| E* | Effort dialect |
| CX* | Provider UX 便利层 |

---

## 5. 关键代码入口（改功能从这找）

| 意图 | 优先路径 |
|------|----------|
| 主循环 / 会话 | `packages/core/src/queryLoop.ts` · `index.ts`（createSession / submitPrompt） |
| 斜杠命令 | `packages/core/src/slash.ts` |
| Tool 执行 / 权限 ask | `packages/core/src/toolExecution.ts` · `toolOrchestration.ts` |
| Subagent | `packages/core/src/subagent.ts` · tools 内 `Agent` |
| Provider 热切 | `packages/core/src/sessionProvider.ts` |
| Effort clamp / ultrathink | `effortClamp.ts` · `ultrathink.ts` |
| 协议 HTTP | `packages/providers/src/openaiCompatible.ts` · `openaiResponses.ts` · `anthropic.ts` |
| Effort 方言表 | `packages/providers/src/effortDialect.ts` |
| Model caps | `packages/providers/src/modelCapability.ts` |
| 配置 / preset | `packages/config/src/*` |
| 内置工具 | `packages/tools/src/builtins.ts` · `textDiff.ts` · `gitDiff.ts` |
| CLI 打印 / picker | `packages/cli/src/**` |
| Desktop IPC | `apps/desktop/src/main/index.mjs` · `renderer/*` |
| 单测 | `scripts/test-*.ts` · `scripts/smoke-*.ts` |

**Desktop 注意：** `main` 里 `repoRoot` 从 `src/main` **上四级**到仓库根，再动态 import `packages/*`。

---

## 6. 文档地图（按任务）

| 任务 | 文档 |
|------|------|
| 安装 / 配置 / Agent | [USAGE.md](./USAGE.md) · [CONFIG.md](./CONFIG.md) |
| Provider / 热切 | [PROVIDERS.md](./PROVIDERS.md) · [PROVIDER_UX.md](./PROVIDER_UX.md) |
| Effort | [EFFORT.md](./EFFORT.md) · [EFFORT_OPTIMIZATION.md](./EFFORT_OPTIMIZATION.md) |
| Diff | [FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) · [TUI.md](./TUI.md) |
| Hooks | [HOOKS.md](./HOOKS.md) |
| Compact | [COMPACTION.md](./COMPACTION.md) |
| Subagent | [SUBAGENT.md](./SUBAGENT.md) · [SUBAGENT_SPEC.md](./SUBAGENT_SPEC.md) |
| 权限 | [PERMISSIONS.md](./PERMISSIONS.md) |
| 会话 JSONL | [SESSIONS.md](./SESSIONS.md) |
| Skills / MCP / Plugins | [SKILLS.md](./SKILLS.md) · [MCP.md](./MCP.md) · [PLUGINS.md](./PLUGINS.md) |
| 斜杠 | [SLASH_COMMANDS.md](./SLASH_COMMANDS.md) |
| 工程原则 | [ENGINEERING_PRINCIPLES.md](./ENGINEERING_PRINCIPLES.md) |
| 参考取舍 | [REFERENCES.md](./REFERENCES.md) |

---

## 7. 开发与验收规矩

### 7.1 工作流

```text
1) 在 ROADMAP / 专题 spec 定位阶段是否已 ✅
2) 读参考语义（HC/Codex…）→ 写最小切片
3) 实现 packages 契约 → CLI → Desktop（若需要）
4) scripts/test-*.ts 或 smoke 绿
5) 更新 ROADMAP / 专题文档水位
6) path-scoped commit；不 stage 无关脏文件；不提交 .bolo-tmp / secrets
```

### 7.2 常用测试

```bash
npm test
npm run typecheck
npx tsx scripts/smoke-turn.ts
npx tsx scripts/test-model-retry.ts
npx tsx scripts/test-cli-events.ts
npx tsx scripts/test-worktree-safety.ts
npx tsx scripts/test-slash.ts
npx tsx scripts/test-multi-provider.ts
npx tsx scripts/test-provider-ux.ts
npx tsx scripts/test-ultrathink.ts
npx tsx scripts/test-effort-dialect.ts
npx tsx scripts/test-hooks-htrack.ts   # 若存在
npx tsx scripts/test-compact-c-track.ts
npx tsx scripts/test-file-diff.ts
npx tsx scripts/test-config.ts
```

`npm test` 已覆盖 R0–R4 与 Durable Runtime DR0–DR4A 的关键回归；其它新轨仍以对应 `test-*` 脚本为准。

### 7.3 Git

- 默认 `main`；用户要求时再 commit/push  
- **不要** `git reset --hard` / 回滚他人未提交改动  
- **不要** amend 非本人、已 push 的 commit（除非用户明确要求）  
- 工作区常有无关脏文件：只 stage 本任务路径  

### 7.4 反模式（禁止）

- 厂商 `if (deepseek) … else if (openai)` 永久膨胀 → 用 **dialect / 表驱动**  
- 把完整 diff hunk 灌进模型 message  
- Desktop/renderer 维护第二份 effort/provider map  
- 未完成 wire 就宣称「支持 ultra API」  
- ultrathink 默认 on 或写 session.effortLevel  
- stub MCP/假 hook 冒充完成  
- 引入遥测「先打点以后再用」  

---

## 8. 环境与运行速记

```bash
pnpm install
pnpm bolo:init
# 配置 ~/.bolo/config.json + API key env
npx bolo

# Desktop
cd apps/desktop && npm install && set BOLO_DESKTOP_MOCK=1 && npm start
```

关键 env（完整见 USAGE / CONFIG）：

| 变量 | 作用 |
|------|------|
| `BOLO_CONFIG_DIR` | 覆盖 `~/.bolo` |
| `BOLO_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | 密钥 |
| `BOLO_PROVIDER=mock` | mock |
| `BOLO_ULTRATHINK` | off\|tip\|turn |
| `BOLO_AGENTS_ENABLED=0` | 关 Agent 工具 |
| `BOLO_MAX_BACKGROUND_AGENTS` | 后台并发 |
| `BOLO_DISABLE_AUTO_COMPACT` | 熔断 auto compact |
| `ELECTRON_MIRROR` | Electron 二进制镜像（国内） |

---

## 9. 近期已落地（便于避免重复劳动）

| 提交主题（示意） | 内容 |
|------------------|------|
| P0–P4.1 | 多 provider 配置 · `/provider` · TTY picker |
| E0–E9 | effort 方言引擎 · choosable · max 门控 · doctor |
| CX0–CX8 | preset · caps · errors · resume providerId · Desktop · **ultrathink** |
| D0–D7 / U0–U4 | 文件 diff 日用 + 交互主路径 |
| H0–H5 / C0–C5 | Hooks · Compact 日用 |
| Desktop repoRoot fix | `apps/desktop` 正确加载 `packages/*` |
| R0–R4 | provider partial-error fail-closed · new/resume 同构 · Ctrl-C 取消链 · worktree 保全 · 默认门禁 |
| DR0–DR1 | 输入先 admission · turn lifecycle · duplicate fail-closed · crash recovery projection |
| DR2A | 进程级 `SessionCoordinator` · 同 session 单 runner · 跨 session 并行 · lease fail-closed/release |
| DR2B1 | control intent · expected active turn · 幂等 id · FIFO queue · steer promotion whitelist · interrupt signal |
| DR2B2 | linked AbortSignal · queryLoop safe-boundary callback · final/tool steer · structured control event |
| DR2B3 | ask abort race · permission/diff exit boundary · `/turn` control · queued REPL drain · coordinator Ctrl-C |
| DR2C1 | `control` transcript schema · fail-closed recovery projection · compact rewrite preservation |
| DR2C2 | session durable wrappers · release barrier · request/promote/take fail-closed · resume durableControls |
| DR2C3 | transcript write barrier · append/rewrite race closeout · partial-tail/duplicate/EIO recovery |
| DR3A | `task` / `task_result` · result-before-terminal · parentTurnId · resume interrupted diagnostics · background no async parent write |
| DR3B | real overflow FIFO · `/bg cancel` · cancel/start race closeout · safe-boundary single delivery · next-turn terminal race |
| DR4A | protocol v1 · feature negotiation · pure snapshot builder · strict command/result parser · no runtime object leakage |
| DR4B1 | expected-state executor · `/runtime` list/inspect/json/interrupt/cancel · warning/竞态 fail-closed |

最新 commit 以 `git log` 为准。

---

## 10. 给下一位 agent 的开工检查清单

- [ ] 已读本文 §0–§3 与 ROADMAP §0  
- [ ] 知道改动落在哪个 package，不把业务写进 Electron renderer  
- [ ] 确认目标轨在 ROADMAP 是 📋 还是已 ✅（避免重复）  
- [ ] 单测或 smoke 路径已想好  
- [ ] 不提交 `.bolo-tmp`、密钥、无关脏改动  
- [ ] 文档水位与代码同批更新  

**人类使用说明** → [USAGE.md](./USAGE.md)  
**进度真源** → [ROADMAP.md](./ROADMAP.md)  
**仓库入口** → [README.md](../README.md)
