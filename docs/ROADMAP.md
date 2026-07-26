# Bolo Code 整体路线图

> **原则：** 日用主路径已收口 ≠ 相对 HC/Codex UI 密度 100%。无 stub 冒充完成。
> **永不：** 遥测 · Claude/Codex **官方市场 API**。
> **进度真源：** 本文 **§0（唯一状态表）** + §13.11 看板。已完成轨的切片明细与落地契约 → [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md)（只读存档）。
> **使用手册：** [USAGE.md](./USAGE.md) · **Agent 交接：** [AGENT_HANDOFF.md](./AGENT_HANDOFF.md) · 仓库入口 [README.md](../README.md)

---

## 0. 一句话进度（唯一状态真源）

| 层 | 粗估 | 说明 |
|----|------|------|
| **Headless 核心** | **~82–90%** | loop/STE/权限/auto/snip/policy/OS sandbox；partial stream fail-closed |
| **分发（CLI）** | **~85–92%** | `npm i -g` / `npx` 单文件产物 · 零运行时依赖 · pack→install→run E2E 进门禁；见 §15 与 [RELEASE.md](./RELEASE.md) |
| **Agent 能力面（工具集）** | **~78–85%** | 13 工具 + **Web search**（anthropic / openai-responses 已活体验证）：Bash（含 `run_in_background`）· BashOutput · KillShell · Read/Write/Edit/apply_patch · Glob/Grep · Skill · WebFetch · Agent · **TodoWrite**；见 §14 |
| 会话与 CLI | **~90–96%** | JSONL · new/resume 同构 runtime · durable controls/tasks · background FIFO/promotion · versioned runtime protocol |
| **扩展面** | **~80–88%** | MCP×3 · Skills · Plugins · WebFetch · OAuth 本地 |
| **Subagent** | **~89–95%** | Spec v0；durable task/result · overflow FIFO/cancel · safe-boundary delivery · worktree fail-closed |
| **Rules / Creators** | **~75–85%** | 日用齐 |
| **成本与缓存** | **~94–97%** | /cost 日用近满 |
| **文件 Diff · 日用契约** | **~95%+** | **D0–D7 已收口**；见 [FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) |
| **文件 Diff · 交互 UI** | **~90–95%** | **U0–U4 已落地**；U5 真·Ink/IDE 可选（AR4 证据门控） |
| **斜杠** | **~80–88%** | 日用 + polish |
| **CLI TUI（壳）** | **~70–80%** | 文本框布局/picker/主题；active Ctrl-C 取消本轮；**非**真 React Ink |
| **Electron GUI** | **~65–75%** | 壳 + 流式 + 权限 + 设置 + 多 provider（CX7） |
| **Hooks · 日用契约** | **~96–98%** | **H0–H5 已落地**（SessionEnd · exit 语义 · updatedInput · `/hooks recent`） |
| **Compact · 日用管道** | **~93–96%** | **C0–C5 + AR2A0a/A0b 已落地**（hybrid 计数 · 中段截断 · 防重摘要）；AR2A1 watermark → A2 safe rewrite **顺延**（§13.10.2） |
| **Provider · 多实例热切** | **~92–96%** | **P0–P4.1 + CX7 Desktop** |
| **Effort · 推理强度方言** | **~92–95%** | **E0–E9 已落地**；adaptive thinking 归 AR4 |
| **Provider UX · 便利层** | **~95–98%** | **CX0–CX8 已落地**（ultrathink 默认 off）· [PROVIDER_UX.md](./PROVIDER_UX.md) |
| **产品整体（相对 HC）** | **~74–88%** | 日用高；UI 全家桶另计 |

**已闭环主线：** headless 日用 → Diff（D0–D7 / U0–U4）· Hooks（H0–H5）· Compact（C0–C5）· Provider（P0–P4.1）· Effort（E0–E9）· Provider UX（CX0–CX8）· 可靠性（R0–R4）· **Durable Runtime（DR0–DR4）** · **Autonomous Road AR1 CLI/TUI runtime UX**。切片明细 → [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md)。

**当前主线：** **AR-T3 · 能力面续刀**（§14）。AR-T1/AR-T2/AR-T3a/AR-T3b 与 **AR5C-early 分发**（§15）已收口。

**已插队并收口：** **AR-T · Agent 能力面**（§14）。准入证据：基础设施深度（DR0–DR4 + AR1）已远超能力广度——彼时 agent 无法跨步骤记住计划，也无法启动任何活过一次工具调用的进程。AR2 压缩深化顺延，A0a/A0b 成果不受影响。

**非阻塞开放项：** AR2A1 watermark · U5 真·Ink/IDE · adaptive thinking · Desktop 打磨（均按 AR3/AR4 排期与证据门控）。

---

## 1. 双轨模型（务必分清）

```text
轨 A · 日用契约（已完成 ~95%+）
  textDiff · meta · preview · fileDiffLog · /diff · git · resume · ANSI 摘要
  → 模型链干净；CLI/Desktop 能看懂改了啥

轨 B · 交互 UI 密度（U0–U4 ✅ · U5 可选）
  可滚动 Diff 面板 · 权限内嵌 structured 预览 · 写后历史 cell
  → 对齐 HC DiffDialog / FileEditToolDiff · Codex diff_render 语义
```

| | 轨 A 日用 | 轨 B UI |
|--|-----------|---------|
| 目标 | 工作流正确、可查、可 resume | 浏览体验接近 HC/Codex |
| 现状 | D0–D7 ✅ | U0–U4 ✅；U5 真·Ink / IDE 可选 |
| 不做 | — | 遥测 · 官方市场 · 必抄 React/Rust |

---

## 2. 文件 Diff · 轨 A（已完成）

| 阶段 | 交付 | 状态 |
|------|------|------|
| D0–D2 | textDiff · Edit/Write/apply_patch meta · fileDiffLog · `/diff` | ✅ |
| D3–D4 | 写前 preview · tool_end ANSI | ✅ |
| D5–D6 | git · transcript `file_diff` resume | ✅ |
| D7 | `createDiffSummary` · 默认短 unified · 更密 ask | ✅ |

详情：[FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) §0–§6。

---

## 3. 文件 Diff · 轨 B（U0–U4 ✅ · U5 可选）

| 阶段 | 交付 | 状态 |
|------|------|------|
| U0 | 规格 + `DiffViewModel` | ✅ |
| U1 | 终端 Diff 面板（`/diff` 可滚列表） | ✅ |
| U2 | 权限预览面板（ask 多文件 + hunk 可滚） | ✅ |
| U3 | 写后 History cell；Desktop `<details>` 复用 | ✅ |
| U4 | 行号 · 主题色 · 轻量语法高亮 | ✅ |
| U5 | 可选真·Ink / IDE / merge-base | 📋 AR4 证据门控 |

对标、架构、选型与验收细节 → [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md) §H1 · 契约真源 [FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) · UI 挂载 [TUI.md](./TUI.md)。

---

## 4. 产品目标（主线）

| 目标 | 状态 |
|------|------|
| Headless Core · CLI 可日用 · Skill/MCP/Plugin/Subagent · Electron 壳 | ✅ |
| Diff 日用 D0–D7 · 交互 UI U0–U4 | ✅ |
| Hooks H0–H5 · Compact C0–C5 · Provider P0–P4.1 · Effort E0–E9 · Provider UX CX0–CX8 | ✅ |
| CLI / Agent 可靠性 R0–R4 · Durable Runtime DR0–DR4 · AR1 runtime UX | ✅ |
| **AR-T1 TodoWrite · AR-T2 Bash background**（§14） | ✅ |
| **AR-T3a ExitPlanMode · AR-T3b Web search**（§14） | ✅ |
| **AR5C-early · CLI 可分发**（§15） | ✅ |
| **AR-T3+ 能力面续刀**（WebSearch · plan 工具流 · AskUserQuestion） | 🔄 当前 |
| AR2 Compact depth（A0a/A0b ✅ → A1/A2 → B → C） | 📋 顺延 |
| AR3 Desktop shell · AR4 证据深水 · AR5 release hardening | 📋 |
| 无遥测 | ✅ 永不 |

---

## 5. 总览（汇报口径）

状态真源见 **§0**；里程碑逐项明细已并入 §0 与 [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md)。

**一句话：** 主路径、Diff、Hooks、Compact、多 Provider、Effort、Provider UX、可靠性 R0–R4、Durable Runtime DR0–DR4、AR1 runtime UX、**AR-T1/AR-T2 能力面**已收口。

**下一刀（当前主线）：** **AR-T3+ 能力面续刀**（§14.5），逐项独立准入。AR2A1 range/watermark 顺延（§13.10.2）。

---

## 6. 文档地图

| 文档 | 用途 |
|------|------|
| 本文件 | **进度真源** · 总路线 + 各轨水位 |
| [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md) | **已完成轨存档**（切片明细 · 落地契约） |
| [USAGE.md](./USAGE.md) | **使用手册**（安装 · Provider · **Agent 配置**） |
| [AGENT_HANDOFF.md](./AGENT_HANDOFF.md) | **交接手册**（架构 · 入口 · 反模式） |
| [PROVIDERS.md](./PROVIDERS.md) | Provider 协议与多实例 |
| [PROVIDER_UX.md](./PROVIDER_UX.md) | CX 便利层（preset · caps · ultrathink） |
| [EFFORT.md](./EFFORT.md) / [EFFORT_OPTIMIZATION.md](./EFFORT_OPTIMIZATION.md) | Effort 方言 |
| [COMPACTION.md](./COMPACTION.md) | Compact **实现真源** |
| [TOOLS.md](./TOOLS.md) | **内置工具契约**（TodoWrite · 后台 shell） |
| [RELEASE.md](./RELEASE.md) | **发布契约**（构建 · tarball · 门禁 · 发布流程） |
| [HOOKS.md](./HOOKS.md) | Hook 契约 |
| [FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) | Diff 契约与阶段 |
| [TUI.md](./TUI.md) | CLI TUI 壳与 U 挂载 |
| [CONFIG.md](./CONFIG.md) | 配置布局 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构 |
| [SUBAGENT_SPEC.md](./SUBAGENT_SPEC.md) | Subagent 契约 |
| [ENGINEERING_PRINCIPLES.md](./ENGINEERING_PRINCIPLES.md) | 工程原则 · 禁止遥测 |
| `apps/desktop/README.md` | 桌面 |
| 本文 §14 | **AR-T Agent 能力面**（TodoWrite · Bash background · 续刀候选） |
| `TODO*.md` | 历史轨（**只读**，非现行真源） |

---

## 7. Hooks 轨（H0–H5 ✅ 已收口）

日用 **~96–98%**：11 事件（Codex 口径原 10 + SessionEnd）· Stop/SubagentStop/PostToolUse exit 2 语义 · SubagentStart 注入 · PreToolUse `updatedInput` · `/hooks recent` 诊断。trust/managed/TUI 菜单后置（不对齐日用口径）。

- 切片明细与契约草案 → [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md) §H2
- **实现真源：[HOOKS.md](./HOOKS.md)**（扩事件须先改此文档）

---

## 8. Compact 轨（C0–C5 ✅ · 深化中 → AR2）

日用 **~92–95%**：full/snip/micro/auto/PTL 管道 · keep 按 user 轮次（C1）· usage 阈值（C2）· mid-turn ≤1（C3）· post-compact 再注入（C4）· `/context` 诊断（C5）· `compact_boundary` JSONL/resume。

- 切片明细、契约草案与验收 → [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md) §H3
- **实现真源：[COMPACTION.md](./COMPACTION.md)**

### 8.9 后置项去向（已移交 / 明确不做）

> C0–C5 无欠债。原"后置清单"已全部归位如下，**不要**在本节重复排期。

| 项 | 去向 |
|----|------|
| 混合 token 计数（usage 锚定 + 尾部估算） | ✅ **AR2A0a 已落地** |
| 工具输出中段截断 · 防重摘要标记 | ✅ **AR2A0b 已落地** |
| partial compact / watermark | → **AR2A1 / AR2A2** |
| 真 tokenizer / budget | → **AR2B1 / AR2B2**（A0a 落地后重估必要性） |
| remote compaction / session-memory | → **AR2C** ADR（默认不实施） |
| cache_edits API（HC cached MC） | 🚫 不做；本地 content-clear 即可 |
| path-rules 再注入 · mid-turn 共享 consecutiveFailures · `/compact --keep-turns N` | 可选小步 polish；不排期、不阻塞 |

---

## 9. Provider 轨（P0–P4.1 + CX7 ✅ 已收口）

多后端热切 **~92–96%**：`providers` 表 + `defaultProvider` · `/provider` list/use/TTY picker · `switchSessionProvider` 热切不重启 · 缺 key fail-closed · resume `providerId` + effort clamp（CX6）· Desktop 多后端（CX7）。

- 切片明细、配置形状与合并规则存档 → [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md) §H4
- **配置/协议真源：[PROVIDERS.md](./PROVIDERS.md) · [CONFIG.md](./CONFIG.md)**
- 明确不做：遥测上报 · 官方市场拉模型 · 同 turn 自动 failover · apiKey 入 transcript

---

## 10. Effort 轨（E0–E9 ✅ 已收口）

方言引擎 **~92–95%**：`resolveEffortWire` 表驱动 · deepseek / openai-responses / anthropic-output 真 wire · `providers.*.effort.dialect` 配置 · choosable/门控（E6–E7）· TTY 选择器（E8）· doctor（E9）。原则：**表驱动，禁止每品牌永久 TS 适配器**。

- 切片明细 → [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md) §H5
- **契约真源：[EFFORT.md](./EFFORT.md) · [EFFORT_OPTIMIZATION.md](./EFFORT_OPTIMIZATION.md)**
- 后置：adaptive thinking（AR4 证据门控）

---

## 11. Provider UX 轨（CX0–CX8 ✅ 已收口）

**~95–98%**：preset（CX1）· ModelCapability 轻表（CX2）· `explainProviderError`（CX3）· 状态行/tip（CX4）· `/model` 建议（CX5）· resume clamp（CX6）· Desktop（CX7）· ultrathink tip/turn 默认 off（CX8）。

**真源：[PROVIDER_UX.md](./PROVIDER_UX.md)**。

---

## 12. CLI / Agent 可靠性轨（R0–R4 ✅ 已收口）

| 阶段 | 交付 | 状态 |
|------|------|------|
| R0 | provider partial-output 报错 → terminal `error`；不持久化截断历史；闭流后才调度工具 | ✅ |
| R1 | new/resume 共用 workspace runtime 装配；`apiKeyEnv` 不被 env 探测覆盖 | ✅ |
| R2 | AbortSignal 贯通 submit→queryLoop；active Ctrl-C 取消本轮；ask/diff 取消 fail-closed | ✅ |
| R3 | subagent worktree 从 repo root 创建；dirty/untracked 成果保全，绝对路径可见 | ✅ |
| R4 | strict typecheck；model-retry/cli-events/subagent/worktree-safety 入默认门禁 | ✅ |

回归入口：`npm test` · `npm run typecheck` · `scripts/test-model-retry|cli-events|cli-resume|worktree-safety.ts`。

---

## 13. Durable Runtime（DR0–DR4 ✅）与 Autonomous Road（AR · 进行中）

> **目标：** 把"turn 结束后保存 transcript"升级为"输入先 admission、执行有生命周期、崩溃后可识别未完成工作"。
> **边界：** 复用 append-only JSONL；不上 SQLite / daemon / RPC；未知工具副作用绝不自动重放。
> **依赖方向：** 先改 `packages/*` 契约，再让 CLI/Desktop 消费；前端不得维护第二套 turn 状态。

| 阶段 | 交付 | 状态 |
|------|------|------|
| **DR0–DR1** | 稳定 `turnId` + lifecycle schema · admission 先于 provider · resume 识别 interrupted | ✅ |
| **DR2** | `SessionCoordinator` 单 runner · safe-boundary queue/steer/interrupt · control 持久化/恢复/crash 收口 | ✅ DR2A–DR2C3 |
| **DR3** | durable task/result · overflow FIFO · 父 turn 安全边界 promotion | ✅ DR3A–DR3B |
| **DR4** | runtime protocol v1 · CLI 诊断/恢复（discard/retry-safe）· closeout | ✅ DR4A–DR4C |

各切片落地契约详情 → [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md) §H6。

### 13.5 Safe boundary（现行语义，AR 各轨继续遵守）

```text
idle → submit(turnId) → admitted → running
                         ├─ boundary: promote queued control
                         ├─ boundary: provider/tool/ask handoff
                         └─ terminal → completed | error | aborted
```

Safe boundary 只承诺：provider 调用前/完整响应归约后 · 每个 tool 的 PreToolUse 前 / PostToolUse 后 · ask/diff 返回或取消后 · compact 完成/失败/跳过后 · terminal 落盘前。不得把 token chunk、半个 tool call、正在写文件当成 safe boundary。

### 13.8 固定质量门禁与自治规则

每个切片都必须满足：

1. 先提交失败测试与 `packages/*` 契约，再接 CLI/Desktop。
2. 定向回归、`npm run typecheck`、完整 `npm test` 全绿。
3. crash、duplicate、abort、持久化失败至少覆盖与本切片相关的组合。
4. 运行 scoped `git diff --check`，只 stage 本切片路径。
5. 代码/测试与文档分批 commit；push 后确认远端 commit。
6. ROADMAP、专题文档、AGENT_HANDOFF 与人类可见行为保持同一水位。

自主迭代遇到以下情况必须停止扩张并保留可接手状态：同一根因三种方案仍失败 · 需要 SQLite/daemon/RPC/外部服务 · 必须覆盖无法确认归属的脏文件 · 发现数据丢失/权限放宽/自动副作用重放/worktree 成果丢失风险 · push 遇到认证或非快进冲突。

### 13.9 DR0–DR4 总体验收（已达成，回归由默认门禁维持）

同 session 至多一个 runner · 跨 session 并行不串状态 · control 只在 safe boundary promotion · crash 后可区分 completed/失败/取消/interrupted · duplicate 幂等 0 次 provider 调用 · background 结果不越父 turn 边界 · CLI 默认不 replay · 旧 JSONL 可读、rewrite 不擦 lifecycle。

### 13.10 Autonomous Road（AR1–AR5）

一次只推进一个可独立验收的切片；可靠性与可操作性优先，再做上下文效率和 UI 密度。

| 阶段 | 准入条件 | 交付切片 | 完成定义 |
|------|----------|----------|----------|
| **AR1 · CLI/TUI runtime UX** ✅ | DR4 protocol 稳定 | AR1A query · AR1B safe actions/queue edit · AR1C pager/automation | ✅ 全部收口；详情 → [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md) §H7 |
| **AR2 · Compact depth（顺延）** | Durable lifecycle 不再改写 transcript 基本形状 | **A0a/A0b 借鉴增强 → A1/A2 watermark → B tokenizer/budget → C remote ADR**（§13.10.2） | 旧 transcript 可读；tool pairing/lifecycle 不被 compact 擦除；token/cost 回归可量化；失败回退 C0–C5 |
| **AR3 · Desktop product shell** | DR4 view-model 被 CLI 稳定消费一个阶段 | AR3A client/store → AR3B 导航 → AR3C cards → AR3D composer → AR3E settings → AR3F hardening | Codex App 风格信息架构；renderer 不重算状态；mock + 真 core IPC 冒烟；Windows 打包可复现 |
| **AR4 · Evidence-driven depth** | AR1–AR3 暴露真实痛点或可测收益 | U5 Ink/IDE · adaptive thinking · hook trust UI · 远程模型列表——逐项 `implement / defer / reject` | 每项有场景/基准/兼容证据；无证据则书面关闭 |
| **AR5 · Release hardening** | 所有已选产品轨完成 | 迁移/兼容矩阵 · 故障注入 · 安装生命周期 · release gate | clean clone 可安装；默认门禁全绿；无密钥/遥测；恢复手册可独立执行 |

#### 13.10.2 AR2 · Compact depth（上下文正确性先于节省率）

**借鉴调研结论（2026-07 · HC = Claude Code 语义 · Codex = OpenAI Codex CLI 语义；只借鉴语义与失败模式，不抄路径/遥测）：**

- **HC：** `tokenCountWithEstimation` 锚定最近带真实 API usage 的消息、只估算其后增量（×4/3 保守垫）→ A0a。`lastSummarizedMessageId` watermark + partial compact `up_to`/`from` 双向 → A1/A2。摘要 9 段结构 + `<analysis>` 剥离（Bolo 已有）。PTL 重试 + 3 连败熔断（Bolo 已有）。cache_edits 微压缩 → 🚫 不做。
- **Codex：** 工具输出**中段截断**（保头保尾 + `original ~N tokens, M lines` 标注，默认 ~10k bytes）→ A0b。`SUMMARY_PREFIX` + `is_summary_message` 防重摘要 → A0b。`CompactedItem` 内嵌 replacement_history + window_number/UUIDv7 链 → A1 契约参考。软/硬双阈值 + fallback buffer → B2 参考。remote compaction → 🚫 不追。
- **Bolo 现状差距：** token 计数纯启发式（chars/4，dense/2），`usageInputTokens` 存在时整体替换估算 → API 响应后新追加 tool result 对阈值不可见，auto compact 迟触发；工具输出截断 head-only；二次 compact 会把旧 summary 当普通历史重新叙述。

| 切片 | 准入 / packages-first 交付 | 集成与验收 | 完成或停止门槛 |
|------|---------------------------|------------|----------------|
| **AR2A0a · 混合 token 计数** ✅ | `UsageAnchor` + `hybridTokenCount` 纯函数 · `shouldAutoCompact`/`resolveAutoCompactTokenCount` opt-in 扩展 | sessionUsage 记 `messageCountAtCall`/指纹；deps/queryLoop/mid-turn 传锚；`/context` `pressure source: hybrid`；锚失效回退全量估算 | ✅ 旧 usage/estimate 路径不变；micro 改写不毁锚 |
| **AR2A0b · 中段截断 + 防重摘要** ✅ | `truncateMiddle`（保头尾 + 原始规模标注 + 幂等）· per-tool 预算表 · `COMPACT_SUMMARY_MARKER` / merge 提示 | toolExecution exec 边界 + microcompact 共用；spill 全量落盘不动；boundary `mergedPriorSummary` | ✅ 截断只在产出时一次，不回溯改写历史 |
| **AR2A1 · range/watermark（顺延）** | 定义 partial range、stable watermark、保留区间与拒绝原因的纯类型/纯函数（参考 HC `lastSummarizedMessageId` 与 Codex window 链语义） | 仅用固定 message/transcript fixture 验证边界、幂等、空范围、重复 compact；尚不接 provider | 契约无法表达 tool pair、lifecycle 或 resolution 保留时停止集成，先修契约 |
| **AR2A2 · safe rewrite** | A1 全绿；把 range 接入现有 C0–C5 compact/rewrite barrier | tool call/result 不拆对；durable turn/control/task/resolution 不丢；旧 transcript 可读；写失败完整回退 | 任一 fixture 出现不可恢复丢失、半写或自动 replay，立即回退并停止本刀 |
| **AR2B1 · tokenizer registry** | A2 稳定；**先重估必要性**（A0a 已显著提升精度）；若仍需要：providers/shared 契约层 provider/model→tokenizer/budget，unknown 保守 fallback | renderer/core 不出现 provider 分支；mock 与至少两类方言 fixture；预算错误 fail-closed | 若必须联网或引入不可审计 native 依赖，只保留接口与 fallback，不引入实现 |
| **AR2B2 · measurable budget** | B1 可复现；固定中英文本、tool/diff、长 JSON 语料 | 记录 token 偏差、compact 后成本、延迟与峰值内存；设回归阈值 | 没有相对当前估算的稳定收益，不替换默认算法，只保留基准结论 |
| **AR2C · remote decision** | A/B 已证明本地瓶颈且有真实跨会话需求 | 写 ADR：local-only、remote/session-memory 之一；列隐私、离线、兼容与失败回退 | 需要新服务、遥测或不透明存储时默认"不实施"，关闭而非永久挂起 |

AR2 提交顺序：**A0a → A0b → A1 契约/测试 → A2 接线 → B1 registry（重估后）→ B2 benchmark → C 决策文档**。每刀都必须能单独回滚到 C0–C5，不以"压缩率更高"交换 transcript 可恢复性。

##### AR3 · Codex App 风格 Desktop（薄 renderer）

| 切片 | packages-first / IPC 契约 | Codex App 风格人类结果 | 专项门禁 |
|------|---------------------------|------------------------|----------|
| **AR3A · client/store** | protocol negotiation、snapshot/query/command client、单一 normalized store；mock 与真 core adapter 同接口 | 启动后能看到 session 状态，断线/不兼容有明确空态 | protocol round-trip、unknown fields、stale command、IPC timeout/reconnect |
| **AR3B · navigation/recovery** | session/turn/control/task selector 与 selection route 纯模型 | 左侧 session 导航、主区 turn timeline、诊断抽屉；interrupted 可 inspect/discard/retry-safe | 大会话、旧 transcript、missing target、crash/restart；默认不 replay |
| **AR3C · content cards** | markdown/tool/diff/approval view-model 继续来自 packages | 克制的信息密度：消息流、tool 状态、diff、approval、错误与复制 | unsafe HTML、超长输出、折叠、键盘/屏幕阅读；权限与 diff 不在 renderer 重算 |
| **AR3D · composer/runtime actions** | composer intent→queue/steer/interrupt/command；携带 expected state/requestId | active turn 时可排队、修正或中断；partial acceptance/warning 可恢复 | double submit、stale target、offline、cancel/replace race |
| **AR3E · settings** | provider/model/effort/capabilities/config schema 共用 packages | provider/model/effort 可搜索与切换，能力/缺 key 可解释 | secret 不回传 renderer/transcript；切换失败保留旧值 |
| **AR3F · hardening/package** | telemetry-free perf counters 仅本地测试；打包配置 | crash 后可重新打开并诊断；Windows 安装包可复现 | cold/warm start、10k events、内存、renderer crash、Windows package/smoke |

视觉原则：高对比、窄侧栏 + 单一主时间线 + 右侧按需诊断；先信息架构和状态正确性，再动效装饰。每切片先落 packages/IPC fixture，后改 `apps/desktop`。

##### AR4 · Evidence-driven depth（逐项准入，不设"大包"）

| 候选 | 最低证据 | 获准后最小交付 | 无证据时的关闭方式 |
|------|----------|----------------|--------------------|
| **U5 Ink / IDE bridge** | AR1 pager 的可复现能力缺口，或 IDE 跳转明显减少 diff 操作步骤 | 独立 spike + 依赖/启动/包体基准 | 记录现有 pane 已满足验收，标记"不实施" |
| **Adaptive thinking** | 固定语料显示静态 effort 有稳定劣势 | provider-neutral policy + 可关闭配置 + 回归 corpus | 证据不稳定或 provider 专有时不进入默认 |
| **Hook trust UI** | 多 workspace 信任切换需求且 CLI 文本无法安全表达 | trust 契约、来源展示、最小 UI、fail-closed | 继续用现有配置/文档 |
| **远程模型列表** | 静态模型表造成真实兼容故障且 provider API 稳定 | 可缓存 adapter、离线 fallback、超时/鉴权测试 | API 不稳定或需遥测/官方市场则关闭 |

每个候选独立形成 `implement / defer / reject` 决策，带证据、风险、回滚和重开条件。

##### AR5 · Release hardening（冻结后只修可靠性）

| 切片 | 核心交付 | 完成定义 |
|------|----------|----------|
| **AR5A · migration/compat** | session/config/protocol 版本矩阵、旧版读取、migration dry-run 与备份 | 旧数据可读或无损导出；迁移幂等，失败不覆盖源 |
| **AR5B · fault injection** | append/rewrite/config/cache 故障注入（磁盘满、EACCES、部分写、崩溃、并发 resume） | 不伪造成功、不丢原文件、不自动 replay；错误含可操作恢复信息 |
| **AR5C · install lifecycle** | clean clone、install/build/package、upgrade/uninstall | 安装/升级/卸载可复现；产物不含密钥/临时文件 |
| **AR5D · release gate** | 性能预算、安全审计、SBOM、已知限制、恢复手册、checklist | 门禁与 release smoke 全绿；文档可由未参与者独立执行 |

固定选择规则：

1. 每次从最前面的未完成阶段选一个最小切片；不同时铺 CLI、Compact、Desktop 三个大工程。
2. 先更新 `packages/*` schema/view-model 与失败测试，再接 CLI/Desktop；renderer 不持有第二状态机。
3. 每切片代码/测试与文档分批 commit/push；ROADMAP 水位只在验收全绿后前移。
4. 对标 HC/Codex/OpenCode/Pi 只借鉴语义、失败模式和测试；不复制重量级目录、依赖或本机路径。
5. AR4 属条件触发项：缺少真实需求必须书面关闭，而不是留永久"待办"。
6. 每切片开始把准入证据和预计触碰路径写入 PWF；结束记录专项、typecheck、完整测试、scoped diff 和远端 commit。
7. 一个代码提交只承载一个可描述的行为变化；文档水位独立提交。commit 后立即 push 并核对 `HEAD == origin/main`。
8. 若用户既有脏文件与切片重叠，优先新增模块/窄补丁/依赖倒置避让；无法证明归属时触发 §13.8 停止条件。

### 13.11 无人值守执行看板

> "下一刀怎么选"的执行索引；状态真源仍是 §0 与本节阶段表。每个切片只有代码/测试批与文档批都 push 后才可标 ✅。

| 顺序 | 切片 | packages-first 交付 | 消费层 / 人类结果 | 必过专项门禁 | 状态 |
|------|------|---------------------|-------------------|--------------|------|
| 1–6 | **DR2C3–DR4C** | durable runtime 收口 | `/turn` `/bg` `/runtime` 全链 | crash/竞态/E2E | ✅ 存档 §H6 |
| 7–9 | **AR1A–AR1C2** | runtime query/action/renderer/pager/automation | CLI 全链 | golden + 真实 bin | ✅ 存档 §H7 |
| 10 | **AR2A0a · 混合 token 计数** | `UsageAnchor` + `hybridTokenCount` + opt-in 阈值 | `/context` hybrid 来源；auto compact 不再迟触发 | 锚失效回退 + 旧路径回归 | ✅ |
| 11 | **AR2A0b · 中段截断/防重摘要** | `truncateMiddle` + 预算表 + summary marker | 工具长输出保头尾；re-compact 不重新叙述 | 幂等 + spill 完整 + cache 稳定 | ✅ |
| 12 | **AR-T1 · TodoWrite** | `packages/shared` todo 契约 + 工具 + session/transcript 接线 | 多步任务可跨 compact/resume 追踪 | compact 存活 + resume 投影 + 提醒双阈值 | ✅ |
| 13 | **AR-T2 · Bash background** | `BackgroundShell` 契约 + 原生进程树 kill + BashOutput/KillShell | dev server / 长构建不再阻塞 turn | 真实进程 kill + endSession 无僵尸 + 前台回归 | ✅ |
| 14 | **AR5C-early · CLI 分发** | esbuild 单文件 + 发布元数据 + 双布局资产 | `npm i -g bolo-code` 可用 | pack→install→run E2E + 零依赖 + tarball 清单 | ✅ |
| 15 | **AR-T3+ · 能力面续刀** | `bolo search enable` · OpenRouter plugin · AskUserQuestion（逐项） | 见 §14.5 | 每项独立红灯 + 全量门禁 | **当前** |
| 16 | **AR2A1–A2 · watermark/safe rewrite** | range/watermark 纯契约 → rewrite 接线 | partial compact 主路径 | tool pairing + lifecycle 保留 | 📋 顺延 |
| 17 | **AR2B–C · tokenizer/benchmark/ADR** | registry（重估）+ 语料基准 + remote 决策 | 可量化 token/cost | 偏差阈值 + fail-closed | 📋 |
| 18 | **AR3A–F** | protocol client/store；无 renderer 状态机 | Codex App 风格 Desktop | mock/core IPC + crash/restart + Windows package | 📋 |
| 19 | **AR4** | 逐项 evidence gate | 有证据实施；无证据书面关闭 | 场景/基准/兼容证据 | 📋 |
| 20 | **AR5A–D**（AR5C 已提前完成） | compatibility/security/release contracts | clean clone 安装、升级、恢复手册 | full test + cross-platform smoke + security audit | 📋 |

固定 checkpoint：

1. 红灯测试/契约 → 实现 → 定向测试 → typecheck → 完整 `npm test` → scoped `diff --check`。
2. 代码与测试单独 commit/push；再同步 ROADMAP、专题文档、AGENT_HANDOFF、USAGE/README 并 commit/push。
3. push 后核对 `HEAD == origin/main`；只从看板最前面的未完成安全切片继续。
4. 触发 §13.8 停止条件时，更新本看板 blocker、保留可恢复工作区，不扩大权限或架构范围。

---

## 14. AR-T · Agent 能力面（Capability Surface）

> **准入证据（2026-07-26 实测）：** DR0–DR4 + AR1 投入了 7+ 个切片构建「长时、可中断、崩溃可恢复的自主工作」基础设施，
> 但驱动它的模型当时只有 10 个工具：**记不住跨步骤的计划，也起不了任何活过一次工具调用的进程**。
> 判据：`docs/*.md` 全文检索 `TodoWrite` / `background bash` / `WebSearch` / plan 工具流 —— **零命中**；
> 而 `cache_edits`、`remote compaction` 等都有明确 🚫 决策记录。**说明这是盲区，不是取舍。**
>
> 因此在 AR2 压缩深化（当时已 93–96%）之前插入本轨。AR2A0a/A0b 成果不受影响，A1 顺延。

### 14.1 AR-T1 · TodoWrite ✅

模型可持久追踪多步计划。**关键设计：表存在 session 上，不进 messages** —— 因此 compact 改写历史时不会被摘要吞掉。

| 面 | 落点 |
|----|------|
| 契约 | `packages/shared/src/todo.ts`：`TodoItem{content,status,activeForm}` · `validateTodoList` · `applyTodoWrite` · `summarizeTodoList` · `shouldRemindTodos` · `formatTodoReminder` |
| 工具 | `packages/tools/src/todoWrite.ts`：免审批 · 非并发安全 · 整表替换 · 无 store 时显式失败 |
| 接线 | `packages/core/src/sessionTodo.ts`（live store + 锚点）· `queryLoop` `before_provider` 注入 · `sessionTranscript` `todo` entry · `sessionPersist.appendSessionTodos` · resume 投影 |
| 提示词 | `systemPrompt` 新增 cache-stable `# Task tracking` 段 |
| UI | `packages/core/src/todoCell.ts` core 预渲染，壳只打印（不重算状态） |
| 门禁 | `scripts/test-todo.ts` · `scripts/test-todo-session.ts` |

**语义要点：**

- `in_progress` 基数是 **warning 不是拒绝** —— 硬拒会让模型陷入重试循环
- 全部 `completed` → 存储清空，下一段工作从干净状态开始
- 提醒策略双阈值（距上次写 ≥N assistant 轮 **且** 距上次提醒 ≥N 轮），**外加锚点丢失快速路径**：
  compact / resume 之后两个锚点同时消失 ⇒ 模型已失去视野 ⇒ 立即重注入一次

### 14.2 AR-T2 · Bash background ✅

`Bash.run_in_background` + `BashOutput` + `KillShell`。dev server / watcher / 长构建不再阻塞 turn。

| 面 | 落点 |
|----|------|
| 契约 | `packages/shared/src/backgroundShell.ts`：4 档状态机 `running\|completed\|failed\|killed` · 注册表 · 游标 · 体积熔断 |
| 运行时 | `packages/tools/src/backgroundShellRuntime.ts`：spawn · 输出落盘 · 增量游标读 · **原生进程树 kill** |
| 工具 | `packages/tools/src/backgroundShellTools.ts`：`BashOutput`（只读免审批）· `KillShell`（只作用于本会话注册的 shell，越权面为零） |
| 接线 | `Bash` 后台分支走完**同一套** policy/sandbox 门禁后才分流；`session.backgroundShells`；`endSession` 收尸 + 日志目录清理 |
| 门禁 | `scripts/test-bash-background.ts` · `scripts/test-bash-background-runtime.ts`（真实进程） |

**语义要点：**

- **零运行时依赖红线**：不引入 `tree-kill`。POSIX 用 `detached` 建独立进程组 → `kill(-pid)` SIGTERM→SIGKILL 两级升级；Windows 用 `taskkill /T /F`
- 后台进程**跨 turn 存活**（不吃单轮 abort、不套 timeout），但**绝不越过会话**：`endSession` 统一收尸
- 输出落盘不驻内存；超过体积上限熔断杀进程，防止死循环 append 打满磁盘
- 沙箱临时文件延后到进程退出才清理（前台是 `finally` 清理，后台不能照搬）
- terminal 状态幂等：kill 之后进程自然退出的那次 exit 必须被忽略，否则「用户杀掉的」会被记成「正常完成」

### 14.3 AR-T3a · plan 模式出口 ✅

`/plan` 有入口没出口——踩了 README「无 stub 冒充完成」。`ExitPlanMode` 补上闭环。

安全形状是重点：plan 模式必须给自己的出口开口子（否则全面 deny 会吃掉退出路径），
但开的是 **deny → ask，不是 deny → allow**；批准后落 `default` 而非 `acceptEdits`/`bypass`——
用户批准的是**这一份计划**，不是随便写的权限。`permissions` 自己声明工具名，不反向依赖 `tools`。

### 14.4 AR-T3b · Web search ✅（两条 hosted 线路已活体验证）

**契约与实现真源 → [TOOLS.md](./TOOLS.md) §3。**

调研结论：三个参考实现**全部让 provider 去搜**，没人自建搜索引擎
（HC 用 Anthropic 服务端工具；codex 发 hosted ToolSpec；opencode 把自调 Exa 那份注释为 "this compromise"）。
因此 hosted 不引入新的第三方接收方 → **默认可开**。

| 面 | 落点 |
|----|------|
| 方言表 | `packages/providers/src/webSearchDialect.ts`（意图 ↔ wire 分离，同 effort 轨） |
| Anthropic | 发送侧混入 cache 断点前；解析抽到 `anthropicStream.ts` + `anthropicEvents.ts` |
| Responses | 绕过 `toolsToResponses`；`web_search_call` 只观测不执行；`url_citation` 浮出 |
| compatible | 走**既有 MCP host**（`searchPresets.ts`），零 provider 代码、零新依赖 |
| 开关 | `/websearch [on\|off\|auto]`；会话缺省 auto，**provider 层缺省 off** |
| 兜底 | 未知块 → `provider_notice` → CLI warning（防「搜了、付费了、屏幕空白」） |

**活体验证（第三方中转，比官方端点更严格）：** anthropic ✅ · openai-responses ✅ · 两者**零告警**，
原调研标 UNCERTAIN 的 wire format 全部证实。compatible/MCP 仍仅契约验证。

**只有真跑才发现的两个缺陷：** 引用逐句重复（渲染层按 turn 去重）；
中转 `HTTP 503` 包着 `model_not_found`（错误解释改为 **body 优先于 status**）。

### 14.5 AR-T3+ · 续刀候选（当前）

按 §13.10 固定规则「一次一个最小切片」，逐项独立准入：

| 候选 | 现状 | 备注 |
|------|------|------|
| **`bolo search enable`** | preset 逻辑已就位，CLI 子命令未接 | 见 TOOLS.md §3 |
| **OpenRouter plugin** | 方言表有行，`openaiCompatible.ts` 未接 `bodyPatch` | 需 baseUrl 硬门控 |
| **AskUserQuestion** | 无 | 结构化澄清；与 CLI picker / Desktop 对话框对接 |
| **前台命令自动后台化** | 无 | 参考实现有阻塞预算超时自动转后台；语义复杂，暂不做 |
| **LSP** | 无 | 体量大，归 AR4 证据门控 |

---

## 15. AR5C-early · CLI 可分发性 ✅

> **为什么提前。** 原排期把 install lifecycle 放在看板最后（AR5C），那个顺序假设「最后才发布」。
> 一旦产品目标包含「网友能用」，分发就不是终点而是**闸门**。
>
> **准入证据（clean clone 实测）：** 仓库 clone + `npm install` 后 CLI 能跑，
> 但陌生人拿不到它——`private: true` 让 `npm publish` 直接拒绝；
> `bin` 在运行时 spawn `tsx` 而 `tsx` 是 devDependency（实测报 `Cannot find module 'tsx/cli'`）；
> 且 `allowImportingTsExtensions` + 491 处 `.ts` 导入使 `tsc` **结构上无法**产出 JS。
> 现状不是「打磨不足」，是**分发 = 0**。

### 15.1 交付

| 面 | 落点 |
|----|------|
| 构建 | `scripts/build-dist.ts`：esbuild bundle → `dist/bolo.mjs`（~1.1 MB / 125 模块）+ 拷 `bundled-skills` |
| 发布元数据 | `private:false` · `name`/`version`/`files`/`keywords`/`homepage`/`bugs` · `bin → ./dist/bolo.mjs` · `prepack` |
| 资产路径 | `getBundledSkillsDir()` 改为**双布局存在性探测**（开发 / 发布产物） |
| 门禁 | `scripts/test-dist-build.ts`（产物契约）· `scripts/test-dist-install.ts`（真实 pack→install→run） |
| 文档 | **[RELEASE.md](./RELEASE.md)**（发布真源）· README 安装章节面向用户重写 |

### 15.2 语义要点

- **零运行时依赖是红线**：`dependencies` 显式写成 `{}`，并由测试断言。esbuild/tsx 只是构建期工具，产物里没有它们，用户也装不到。
- **bin 就是产物本身**，没有 wrapper —— 少一层就少一处会走偏的地方。
- **`prepack` 强制重建**，杜绝 tarball 里混进旧产物。
- **bundling 会压平模块路径**：任何 `import.meta.url` 自算路径的代码都必须做双布局兼容；任何非字面量的动态 `import()` 都会让 bundle 在运行时炸。改代码时注意这两条。
- tarball 清单被测试锁死：只有 `dist/` + `README.md` + `LICENSE` + `package.json`，源码/`.bolo-tmp`/`.planning`/`.claude`/密钥一律不得进。

### 15.3 本轮不做

Electron 安装包（后置，先 CLI）· `@bolo/*` 子包独立发布（跨包用相对路径导入，workspace 包名目前是装饰性的）· 签名/公证 · 自动升级检查。
