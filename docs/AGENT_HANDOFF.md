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
| 2 | [ROADMAP.md](./ROADMAP.md) | **进度真源** · 各轨水位 · 开放项（已完成轨详情 → [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md)） |
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
| Headless 核心 | ~82–90% | queryLoop · STE · 权限 · tools；partial stream fail-closed |
| **Agent 能力面（工具集）** | **~82–88%** | 15 个常驻/可选工具 + 显式 SearXNG `WebSearch`（ROADMAP §14 · [TOOLS.md](./TOOLS.md)） |
| **分发（CLI）** | **~87–93%** | `npm i -g` / `npx` 单文件产物；安装后直接 `bolo`，无需 init；零运行时依赖（ROADMAP §15 · [RELEASE.md](./RELEASE.md)） |
| 会话 / CLI | ~92–97% | 用户级 workspace JSONL · 旧项目/用户会话兼容 · 零项目副作用首次启动 · new/resume 同构 runtime · durable controls/tasks |
| **CLI TUI** | **~88–93%** | OI-09/OI-10：响应式品牌欢迎页/Bolot · 共享 frame · slash 菜单/补全 · CLI-local/Plugin/Skill 动态候选 · 原子多帧 Thinking/Running · 即时回显/结构化时间线 · 非 TTY 回落；真人 Windows Terminal 未验 |
| 扩展面 | ~80–88% | MCP · Skills · Plugins |
| Subagent | ~89–95% | Spec v0；durable task/result · overflow FIFO/cancel · safe-boundary delivery · worktree 成果保全 |
| 文件 Diff 日用 | ~95%+ | **D0–D7** |
| 文件 Diff UI | ~90–95% | **U0–U4**；U5 真 Ink/IDE 可选 |
| Hooks 日用 | ~96–98% | **H0–H5**（含 SessionEnd） |
| Compact 日用 | ~93–96% | **C0–C5 + AR2 全段**（hybrid 计数 · 中段截断 · 防重摘要 · range/watermark 契约）；任意中段 rewrite 按证据门控不启用 |
| 多 Provider 热切 | ~92–96% | **P0–P4.1 + CX7 Desktop** |
| Effort 方言 | ~92–95% | **E0–E9** |
| Provider UX | ~95–98% | **CX0–CX8**（ultrathink 默认 off） |
| Durable Runtime | DR0–DR4 ✅ | 输入先落盘 · recovery · 单 runner · durable control/task · FIFO/promotion · v1 protocol/resolution · crash/restart closeout |
| Electron GUI | ~80–88% | runtime IPC/client、会话切换/恢复、composer controls、model/effort 与 control/tool progress 已真接并经 Electron 自动化；真人点击/视觉未验 |
| 产品相对 HC 全家桶 | ~74–88% | 日用高；UI 密度另计 |

**已闭环：** Diff · Hooks · Compact（含 AR2 全段）· Provider · Effort · Provider UX CX0–CX8 · **CLI/Agent 可靠性 R0–R4** · **Durable Runtime DR0–DR4** · **Autonomous Road AR1 CLI/TUI runtime UX** · **AR-T1–T3+ Agent 能力面** · **AR3/OI-06 Desktop 产品接线** · **AR4 evidence gate** · **AR5 release hardening** · **OI-04 SearXNG 直连、OI-X1 真实实例 smoke、OI-07 上游诊断 / doctor / 可选 Docker setup、OI-08B CLI 零步骤首次启动、OI-09 CLI TUI 交互重构、OI-10 CLI 命令发现与 TUI 一致性**。

**当前主线：** 默认 agent 可闭环队列为空。OI-10 已以 `67421bb` 落地：
`packages/core/src/slash.ts` 投影内置、Plugin command 与 user-invocable Skill；
CLI 追加 `/exit`/`/quit` 并在每个 idle 周期重新生成候选；raw editor 支持 `/` 全量、
精确/前缀过滤、↑↓/Tab/Enter/Esc 与空匹配。欢迎页/输入框/用户消息共用 frame helper，
activity 在单次完整写入基础上恢复确定性多帧动画，根 `dependencies` 仍为 `{}`。

OI-X1 已在 SearXNG `2026.7.26-b060c780d` 真实 Docker 实例完成：JSON API、
生产配置/status、permission-gated `WebSearch` 与真实上游 URL 全链通过；默认引擎
会出现 429/CAPTCHA/timeout。OI-07A 现把全故障收口为 `upstream_unavailable`、
把部分故障追加为 warning；部署仍必须以非空结果验收并配置当前网络可用的引擎。

**其它开放轨（非阻塞）：**

| 项 | 说明 |
|----|------|
| OI-07 | ✅ A `7754525` · B `3e96573` · C `ef03f3d` / `f623ad9`：诊断、doctor 与可选 Docker 管理均关闭 |
| OI-H1 | `AskUserQuestion` 真 TTY 按键；自动化未覆盖真人终端 |
| OI-H2 | Desktop 点击、键盘与视觉走查；自动化只证明窗口与 IPC 可用 |
| OI-H3 | CLI TUI 真实 Windows Terminal 的光标、重绘、resize 与按键观感；自动化只证明三档欢迎 renderer、Bolot/NO_COLOR、共享 frame、slash reducer/raw driver、原子多帧活动行/ANSI/首 token gate，Codex PTY 实测不能替代真人终端 |
| LSP / remote compact / 任意中段 rewrite | 已按证据门控关闭；满足专题 ADR 的重开条件前不立项 |

Durable Runtime 与 Autonomous Road 的长期执行顺序以 [ROADMAP.md](./ROADMAP.md) §13.10–§13.11 为准（已完成切片详情存档于 [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md)）：

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
→ DR4B2 discard/retry-safe ✅
→ DR4C closeout ✅
→ AR1A runtime query ✅
→ AR1B1 safe action discovery ✅
→ AR1B2 queue remove/edit ✅
→ AR1B3 command closeout ✅
→ AR1C1 text/pager ✅
→ AR1C2 automation closeout ✅
→ AR2A0a 混合 token 计数 ✅
→ AR2A0b 中段截断 + 防重摘要 ✅
→ AR-T1 TodoWrite ✅
→ AR-T2 Bash background ✅
→ AR5C-early CLI 分发 ✅
→ AR-T3+ 能力面续刀 ✅
→ AR2A1–C Compact depth ✅
→ AR3 Codex App 风格 Desktop ✅
→ AR4 证据驱动深水项 ✅
→ AR5 release hardening ✅
→ OI-04 SearXNG 契约收口 ✅
→ OI-06 Desktop 生产接线 ✅
→ OI-07A SearXNG 上游诊断 ✅
→ OI-07B search doctor ✅
→ OI-07C 可选 Docker setup/status/logs/stop ✅
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
| §13 | Durable Runtime（DR0–DR4）+ Autonomous Road（AR1–AR5 · §13.10–§13.11） |

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
| **待办表（TodoWrite）** | `packages/shared/src/todo.ts`（契约）· `packages/tools/src/todoWrite.ts`（工具）· `packages/core/src/sessionTodo.ts`（store/注入）· `todoCell.ts`（渲染） |
| **后台 shell** | `packages/shared/src/backgroundShell.ts`（契约）· `packages/tools/src/backgroundShellRuntime.ts`（spawn/kill/游标）· `backgroundShellTools.ts`（BashOutput/KillShell） |
| **构建 / 发布产物** | `scripts/build-dist.ts`（esbuild → `dist/bolo.mjs`）· `package.json` 的 `files`/`bin`/`prepack` |
| CLI 打印 / picker | `packages/cli/src/**` |
| Desktop IPC | `apps/desktop/src/main/index.ts` · `preload/index.cjs` · `renderer/*` |
| 单测 | `scripts/test-*.ts` · `scripts/smoke-*.ts` |

**Desktop 注意：** main 静态导入 `packages/*` 并由 esbuild 打成自包含 bundle；
renderer 壳原样复制，共享 `RuntimeClient` 单独打成 browser ESM。不要恢复运行时
`repoRoot` 推算或 TS 动态导入。

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
| **内置工具 / 待办表 / 后台 shell** | **[TOOLS.md](./TOOLS.md)** |
| **构建 / 打包 / 发布** | **[RELEASE.md](./RELEASE.md)** |
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
npm run test:runtime-cli-renderer
npm run test:runtime-cli-pager
npm run test:runtime-cli-automation
npm run test:searxng-setup
npm run test:searxng-setup-cli
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
npx tsx scripts/test-todo.ts
npx tsx scripts/test-todo-session.ts
npx tsx scripts/test-bash-background.ts
npx tsx scripts/test-bash-background-runtime.ts
npx tsx scripts/test-dist-build.ts
npx tsx scripts/test-dist-install.ts
npx tsx scripts/test-compact-c-track.ts
npx tsx scripts/test-file-diff.ts
npx tsx scripts/test-config.ts
```

`npm test` 已覆盖 R0–R4、Durable Runtime DR0–DR4 与完整 AR1：query/actions/queue/command、text renderer、TTY pager、automation golden、参数排列/help 和真实 bin/pipe。其它新轨仍以对应 `test-*` 脚本为准。

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
- 为后台进程管理引入 `tree-kill` 之类运行时依赖（**Bolo `dependencies` 恒为空**）
- 新增「相对自己文件找资源」的代码却不做双布局兼容（bundling 会压平模块路径）
- 用变量做 `import()` 的 specifier（bundle 运行时会炸）
- 把 provider **服务端**工具块存进客户端工具累加器（`flushTools` 会把它发成本地 `tool_call` 去执行一个不存在的工具）
- 解析器只留白名单不留兜底（未知块静默丢弃 = 用户付了钱看不到结果）
- 错误解释只看 HTTP status 不看 body（中转常把配置错误包在 5xx 里）
- 把 todo 表写进 `messages`（会被 compact 吞掉，白做）

---

## 8. 环境与运行速记

```bash
npm install
# 配置 ~/.bolo/config.json + API key env
npm run dev --

# 可选：只有需要项目模板时
npm run dev -- init [--project]

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
| DR4B2 | append-only `resolution` · admitted/queue-only retry-safe · 新 turn/control id · `/runtime discard/retry-safe` · accepted+warning failure window |
| DR4C | 真实 CLI crash/restart E2E · replacement 单次消费/重启不 replay · 旧 v1/JSONL 兼容 · 坏 resolution 引用 fail-closed |
| AR1A | shared list/inspect query view-model · 顶层 `runtime` 子命令 · resume/continue · 单 payload JSON · `/runtime` 共用 selector |
| AR1B1 | snapshot-only available-actions 矩阵 · action target 含 expectedState · CLI/slash text+JSON · DR4C 顶层 inspect 兼容 |
| AR1B2 | `control.replace` · cancel+replacement append-only edit · requestId 稳定 ID/FIFO 尾插 · `/runtime edit\|remove` · partial accepted warning |
| AR1B3 | 顶层 `runtime discard\|retry-safe` · 稳定/显式 requestId · text/JSON envelope · exit 0/1/2 · restart non-executable warning |
| AR1C1 | 共享纯 text renderer · 窄屏/NO_COLOR · 双 TTY 多页 pager · next/previous/q/Esc/Ctrl-C/EOF · raw-mode 恢复 |
| AR1C2 | pipe/JSON 永不读 stdin · query success 原始 view · failure 单 payload · usage exit 2 · automation/help/参数排列默认回归 |
| AR2A0a | `UsageAnchor`/`hybridTokenCount` 混合 usage 锚定计数 · `messageCountAtCall`/形状指纹 · deps/mid-turn/`/context` hybrid 接线 · 旧路径不变 |
| AR2A0b | `truncateMiddle` 中段截断（幂等 + 原始规模标注）· per-tool 预算表 · exec/micro 共用 · `COMPACT_SUMMARY_MARKER` 防重摘要合并提示 |
| **AR-T1** | `TodoWrite` 工具 · todo 存 session 不进 messages（免疫 compact）· transcript `todo` 快照 + resume 投影 · `# Task tracking` cache-stable 段 · 双阈值 + 锚点丢失快速路径的提醒注入 · core 预渲染 cell |
| **AR-T2** | `Bash.run_in_background` + `BashOutput` + `KillShell` · 输出落盘 + 增量游标 · **零依赖原生进程树 kill**（POSIX 进程组两级升级 / Windows `taskkill /T /F`）· 体积熔断 · `endSession` 收尸防僵尸 |
| **AR-T2 修复** | 落盘 sink 失败（ENOSPC / write-after-end）曾是**未捕获异常 → 整进程崩溃**；接住之后还必须连带收进程树，否则留下 `KillShell` 也杀不掉的孤儿 |
| **AR-T3a** | `ExitPlanMode`：plan 模式补出口；权限层 deny→**ask**（非 allow），批准落 `default` 而非 acceptEdits |
| **AR-T3b** | Web search 方言表（意图↔wire 分离）· anthropic/responses hosted 两条腿**已活体验证零告警** · compatible 走既有 MCP · 未知块兜底防「搜了没结果」 |
| **OI-07** | SearXNG `unresponsive_engines` 诊断 · 只读 `search doctor` · 固定 digest/loopback/secret/rollback 的显式 Docker setup/status/logs/stop · 源码/dist 真实 smoke |
| **OI-08B** | 安装后直接 `bolo` · 用户级 workspace sessions · 旧项目/用户会话兼容 · 显式 `bolo init` · 普通启动零项目副作用 |
| **OI-09** | 响应式 Bolot 欢迎页 · 真实输入框 · 原子活动行 · 结构化时间线 · 非 TTY 回落；真人 Windows Terminal 验收见 OI-H3 |
| **OI-10** | 共享 frame · slash catalog/menu · CLI-local/Plugin/Skill 动态候选 · ↑↓/Tab/Enter/Esc · 原子多帧 Thinking；代码 `67421bb`，真人观感仍见 OI-H3 |
| **AR5C-early** | esbuild 单文件产物 · 发布元数据 · `getBundledSkillsDir()` 双布局 · pack→install→run E2E 进门禁 · [RELEASE.md](./RELEASE.md) |

最新 commit 以 `git log` 为准。

---

## 10. 给下一位 agent 的开工检查清单

- [ ] 已读本文 §0–§3 与 ROADMAP §0  
- [ ] 知道改动落在哪个 package，不把业务写进 Electron renderer  
- [ ] 确认目标轨在 ROADMAP 是 📋 还是已 ✅（避免重复）  
- [ ] 单测或 smoke 路径已想好  
- [ ] 不提交 `.bolo-tmp`、密钥、无关脏改动  
- [ ] 文档水位与代码同一切片更新，但按规定分开 commit/push

**人类使用说明** → [USAGE.md](./USAGE.md)  
**进度真源** → [ROADMAP.md](./ROADMAP.md)  
**仓库入口** → [README.md](../README.md)
