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
| **分发（CLI）** | **~87–93%** | `npm i -g` / `npx` 单文件产物 · **安装后直接 `bolo`，无需 init** · 零运行时依赖 · pack→install→run E2E 进门禁；见 §15 与 [RELEASE.md](./RELEASE.md) |
| **Agent 能力面（工具集）** | **~82–88%** | 15 个常驻/可选工具 + 显式 SearXNG `WebSearch`；六条搜索线路均有活体验证，SearXNG 另有可重复 fixture 与上游故障诊断：Bash（含 `run_in_background`）· BashOutput · KillShell · Read/Write/Edit/apply_patch · Glob/Grep · Skill · WebFetch · Agent · **TodoWrite** · **ExitPlanMode** · **AskUserQuestion**；见 §14 |
| 会话与 CLI | **~92–97%** | 用户级 workspace JSONL · 旧项目/用户会话兼容 · 零项目副作用首次启动 · new/resume 同构 runtime · durable controls/tasks · background FIFO/promotion · versioned runtime protocol · **`--allowed-tools` / `--disallowed-tools` 工具级放行** |
| **扩展面** | **~80–88%** | MCP×3 · Skills · Plugins · WebFetch · OAuth 本地 |
| **Subagent** | **~89–95%** | Spec v0；durable task/result · overflow FIFO/cancel · safe-boundary delivery · worktree fail-closed |
| **Rules / Creators** | **~75–85%** | 日用齐 |
| **成本与缓存** | **~94–97%** | /cost 日用近满 |
| **文件 Diff · 日用契约** | **~95%+** | **D0–D7 已收口**；见 [FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) |
| **文件 Diff · 交互 UI** | **~90–95%** | **U0–U4 已落地**；U5 真·Ink/IDE 可选（AR4 证据门控） |
| **斜杠** | **~87–93%** | OI-10 命令级发现/补全 + OI-12A argument hint 已完成；OI-15A–F 已建立完整 display policy/retained 单槽，并迁移 panel/pager/catalog/action-picker/diff/toast/history，normal slash 不再进入 compatibility bucket |
| **CLI TUI** | **~85–92%** | OI-14 retained renderer、OI-15A–F command surface/lifecycle 与 OI-16 Doctor pager viewport 已完成；只读状态使用有界 panel/text pager，扩展目录与动作选择使用稳定 overlay，短反馈使用 footer toast；OI-H3 真人 Windows Terminal 主观观感仍未验 |
| **Electron GUI** | **~80–88%** | 壳 + 流式 + 权限 + 多 provider（CX7）+ runtime v1 + **会话切换/恢复 + composer controls + model/effort 设置 + control/tool progress 投影** + AskUserQuestion；真人点击/视觉仍未验 |
| **Hooks · 日用契约** | **~96–98%** | **H0–H5 已落地**（SessionEnd · exit 语义 · updatedInput · `/hooks recent`） |
| **Compact · 日用管道** | **~96–98%** | **C0–C5 + AR2 全段已落地**（hybrid 计数 · 中段截断 · 防重摘要 · range/watermark 契约 · 切分不拆对穷举验证 · 写失败完整回退 · durable 条目不丢 · **估算按字符类别分档**（CJK 1.3 / 散文 4.5 / 其余 3.5；实测推翻了「密文 = token 密」的旧前提，最差高估 109% → 19.5%）· 管道基准）；中段压缩与远端压缩均**显式关闭**（§13.10.2 · [ADR](./ADR_COMPACT_REMOTE.md)） |
| **Provider · 多实例热切** | **~92–96%** | **P0–P4.1 + CX7 Desktop** |
| **Effort · 推理强度方言** | **~92–95%** | **E0–E9 已落地**；adaptive thinking 归 AR4 |
| **Provider UX · 便利层** | **~95–98%** | **CX0–CX8 已落地**（ultrathink 默认 off）· [PROVIDER_UX.md](./PROVIDER_UX.md) |
| **产品整体（相对 HC）** | **~68–82%** | Headless 日用高；CLI TUI 渲染可靠性按 OI-14 重新计入 |

**已闭环主线：** headless 日用 → Diff（D0–D7 / U0–U4）· Hooks（H0–H5）· Compact（C0–C5）· Provider（P0–P4.1）· Effort（E0–E9）· Provider UX（CX0–CX8）· 可靠性（R0–R4）· **Durable Runtime（DR0–DR4）** · **Autonomous Road AR1 CLI/TUI runtime UX** · **AR3 Desktop 产品接线** · **OI-07 SearXNG 上游诊断、`search doctor` 与可选 Docker setup** · **OI-08B CLI 零步骤首次启动** · **OI-14A–H retained renderer 重构** · **OI-15A–F slash command surface/lifecycle** · **OI-16 Doctor pager viewport**。OI-09–OI-13 的 slash/context/paste/Thought/权限/welcome 等局部切片保留为完成历史，但不再作为整个 renderer 稳定的独立证据。OI-H3 继续独立保持 `BLOCKED: HUMAN`。切片明细 → [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md)。

**OI-15A–F 与 OI-16 自动实现已关闭；当前没有已准入的 agent 可闭环队列。** OI-14 已建立
单 retained renderer/OverlayHost；OI-15 准入时普通 slash 结果仍可能通过
`appendCompatibilityOutput()` 持续拼接并固定在 transcript 与 Composer 之间。
OI-15A 已在 core 定义并运行时校验
`history | panel | toast | overlay` display policy，35 个内建命令均有显式分类，
Plugin/Skill/unknown 也有 fail-closed 兜底。OI-15B `d6bd087` 已接 retained
单 panel/toast state、generation/TTL/input-clear、Composer 下方有界 panel 与
footer toast primitive。OI-15C `26f796f` 已让 `/context`、`/doctor`、`/status`、
help/cost/memory/mcp/hooks 等只读结果消费 resolved policy：短内容进入单 panel，
长内容与 details 进入 CJK-safe text pager，单页 pager 也实际可见；迁移命令不再写
compatibility bucket，plain/non-TTY 字节保持不变。OI-15D `21ee1e2` / `87054df`
已完成 Skills/Plugins 与异步 stale guard 迁移，使用 core
pre-dispatch preview、结构化 catalog、loading→result 原位替换以及
`key/generation/session/cwd` stale guard，并为长目录提供有界分页和
`PgUp`/`PgDn`/`Home`/`End`。OI-15E `1d49d53` 已消费 toast/history policy：
20 次短动作复用 footer 单槽，可修正错误保持 error toast，插件 install/uninstall
执行失败显式进入 visual-only error history，reload notes 进入 warning toast；迁移结果
不写 compatibility/plain writer/session messages。OI-15F `d1e26bb` 已把
Provider/Effort/Diff 迁入统一结构化 action-picker/diff view，只读 list/help/git
进入 panel/pager、mutation 进入 toast；overlay 不可用或无内容时进入 visual-only
history，normal slash 输出不再命中 compatibility bucket。非 TTY、pipe、JSON、
`--print` 的 plain `message`
契约保持不变，不引入新 renderer 或其它 Agent 的运行时依赖。完整方案见
[CLI_TUI_REFACTOR_PLAN.md](./CLI_TUI_REFACTOR_PLAN.md) §14。

真人截图随后反证了 OI-15C 的 pager 物理高度门禁：48 行终端会把约 29 行 Doctor
补空到 45 个组件行，裁掉 footer 并挤压 Composer。OI-16 `5b22c15` 将 embedded
text pager 正文限制为 `min(18, rows - 6)`，短内容按实际行数渲染；24/48/80 行
Doctor、两页导航、`q`/`Esc` 恢复 Composer 与 plain 字节稳定均进入独立专项和默认
门禁。runtime pager、Diff、权限和其它 overlay 尺寸策略未改变。

**外部或人工阻塞项单列，不与 agent 队列混淆：**

| 待办 | 卡在哪 |
|------|--------|
| CLI TUI 真实 Windows Terminal 观感/按键 | OI-14G 已自动关闭物理布局/cursor/resize/cleanup 缺陷；OI-H3 仍需真人检查字体、颜色、动画主观流畅度与按键/鼠标手感 |
| 桌面窗口视觉 · AskUserQuestion 真人按键/点击 | 只能人工验，自动化覆盖不到 |
| LSP | 暂缓，触发条件已写死 → [ADR_AR4_EVIDENCE_GATE.md](./ADR_AR4_EVIDENCE_GATE.md) §6 |

> AR-T1/AR-T2/AR-T3a/AR-T3b/**AR-T3+ 全段** · **AR2 全段（A0a/A0b/A1/A2/B1/B2/C）** 与
> **AR5C-early 分发**（§15）已收口。

**已插队并收口：** **AR-T · Agent 能力面**（§14）。准入证据：基础设施深度（DR0–DR4 + AR1）已远超能力广度——彼时 agent 无法跨步骤记住计划，也无法启动任何活过一次工具调用的进程。AR2 压缩深化顺延，A0a/A0b 成果不受影响。

**agent 可闭环开放项：当前为空。** OI-H1/H2/H3 是明确真人项，LSP 继续由证据
门控。OI-15 已按真人走查和当前代码路径提供的准入证据关闭；后续可由 headless
terminal 复现的新缺陷也不得塞回 `BLOCKED: HUMAN`。没有新准入证据时不得为保持
自治而发明任务。CLI init
不再是默认安装步骤，SearXNG Docker 管理也只是显式可选能力。

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
| **OI-09 · CLI TUI 交互重构** | ✅ 建立响应式欢迎页、真实输入框、稳定即时活动态、结构化时间线、窄终端/非 TTY 契约；当时的 Bolot 欢迎页已由 OI-11G 替换 |
| **OI-10 · CLI 命令发现与 TUI 一致性** | ✅ 共享 frame、原子多帧动画、slash catalog/menu、CLI-local/Plugin/Skill 动态候选与键盘补全；真人 Windows Terminal 验收单列 |
| **OI-11 · CLI TUI 持久终端表面与可审计权限交互** | ✅ 常驻全宽 composer、时间线层级/usage、分段 Thinking、权限详情选择、viewport 稳定、Responses abort 诊断与水晶欢迎页均已进入默认门禁；真人项见 OI-H3 |
| **OI-12 · CLI TUI 信息架构与多行输入稳定性** | ✅ argument hint、context dashboard、统一内容 gutter、全宽用户块与 paste transaction 已进入默认门禁；真人项见 OI-H3 |
| **OI-13 · CLI TUI 垂直节奏与水晶工作台** | ✅ 局部切片完成；后续物理 wrap/cursor/layout 证据转入 OI-14，不再以本项门禁证明整个 renderer |
| **OI-14 · CLI TUI retained renderer 重构** | ⏸ A–H 自动实现已关闭：真实 VT/选型、live view-state、retained renderer/Markdown/Composer/OverlayHost、默认切换、可靠性/性能与 legacy 删除；只剩 OI-H3 真人核心场景 |
| **OI-15 · slash 命令 surface/lifecycle** | ✅ A core display policy（`d681734`）→ B retained 单 panel/toast slot（`d6bd087`）→ C context/doctor/status 与只读 panel/pager（`26f796f`）→ D Skills/Plugins stable-key overlay（`21ee1e2` / `87054df`）→ E toast/error policy（`1d49d53`）→ F compatibility cleanup（`d1e26bb`） |
| **AR-T3+ 能力面续刀**（WebSearch · plan 工具流 · AskUserQuestion） | ✅ 三项均已落地（AskUserQuestion 的真 TTY 交互未验，见 §14.5） |
| **AR2 Compact depth（A0a/A0b/A1/A2/B1/B2/C 全段）** | ✅ |
| AR3 Desktop shell | ✅ runtime 生产桥/会话切换恢复/视图模型/composer/model-effort/control-tool progress/NSIS 已收口；真人点击/视觉仍未验 |
| AR4 证据深水 · AR5 release hardening | ✅ |
| 无遥测 | ✅ 永不 |

---

## 5. 总览（汇报口径）

状态真源见 **§0**；里程碑逐项明细已并入 §0 与 [ROADMAP_HISTORY.md](./ROADMAP_HISTORY.md)。

**一句话：** Headless 核心主路径已收口；OI-14A–H 已完成 retained renderer 主体，
OI-15A–F 已按 packages-first 补齐 slash 的 panel/toast/overlay/history、
替换/清除/TTL/pager/stale guard 与 compatibility cleanup；外部资源与真人验收继续单列。

**最近关闭：** OI-15E `1d49d53` 已让 retained CLI 消费 toast/history：
短动作与可立即修正错误进入 footer 单槽，显式 durable error 进入 visual-only history。
20 次 `/plan` 只替换 toast；`ok: false` 不会自动持久化；插件 install/uninstall 执行
失败可审计，Usage error 仍是 error toast，reload merge notes 是 8 秒 warning toast。
迁移结果不写 compatibility/plain writer/session messages；plain/non-TTY fallback
保持原字节。OI-15F `d1e26bb` 已统一 action-picker/diff payload、关闭 normal slash
compatibility writer 并保留 plain fallback；完整 `npm test`、dist/install、预算与
Electron smoke 全绿且没有新增依赖。真人 Windows Terminal 验收仍单列，
不用自动门禁冒充主观观感。
中段压缩与远端压缩按证据门控**显式关闭**
（后者见 [ADR_COMPACT_REMOTE.md](./ADR_COMPACT_REMOTE.md)）。

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
| [DESKTOP_DESIGN.md](./DESKTOP_DESIGN.md) | **AR3 设计方案**（信息架构 · 交互 · 视觉 · 不做什么） |
| [CLI_TUI_REFACTOR_PLAN.md](./CLI_TUI_REFACTOR_PLAN.md) | **OI-14/OI-15 设计方案**（retained renderer · slash surface/lifecycle · 迁移/回滚/验收） |
| [CLI_TUI_RENDERER_DECISION.md](./CLI_TUI_RENDERER_DECISION.md) | **OI-14A 选型证据**（真实 VT · Node/Windows · 体积/资产 · 许可决定） |
| [ADR_COMPACT_REMOTE.md](./ADR_COMPACT_REMOTE.md) | **AR2C 决定**：compaction 保持 local-only（含重开条件） |
| [ADR_AR4_EVIDENCE_GATE.md](./ADR_AR4_EVIDENCE_GATE.md) | **AR4 决定**：六个候选逐条书面决定（含证据与重开条件） |
| [LOCAL_SEARCH_AND_FETCH.md](./LOCAL_SEARCH_AND_FETCH.md) | **本地搜索/抓取**：SearXNG compose + Bolo 直连配置 · 每条路径查询去哪 |
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
| **AR2A1 · range/watermark** ✅ | `packages/compact/src/range.ts`：`MessageRange` · `deriveCompactWatermark` · `findAtomicBlocks` · `validateCompactRange` · `planPartialCompact` + 结构化拒绝原因。**watermark 推导而非存储**（`ChatMessage` 无 id，存下标必漂移；summary 消息可判别故可推导） | `test-compact-range.ts` 固定 fixture：原子块、吸附上报、空/越界/倒置、幂等、重复 compact、保留尾部、不改入参。**未接 provider** | ✅ 契约可表达 tool pair 与 lifecycle（summary 消息）；**`resolution` 是 transcript 条目不是 ChatMessage**，明确划在契约外，由 A2 接线时单独保证 |
| **AR2A2 · safe rewrite** ✅**（安全面）**/ ⏸**（中段能力未启用）** | 四条验收全过：tool pair 不拆对（`test-compact-split-invariant.ts` 穷举 7736 切点 + 6820 split 组合，`findAtomicBlocks` 当裁判）· durable 条目不丢（`3e918ea`）· 旧 transcript 可读（含坏行与旧格式两例）· 写失败完整回退（`948061c`） | 两处修复均为**已复现**的真 bug 而非预防性改动 | ⏸ **`planPartialCompact` / `validateCompactRange` 产品代码零调用**——契约只作为验证者接线，未启用任意中段压缩。理由见下 |
| **AR2B1 · tokenizer registry** ✅ **不引入（改为修正启发式）** | 重估结论：真 tokenizer 要么联网、要么引入不可审计 native 依赖/大体积 BPE 表，**均撞零依赖红线**。改为用真实端点标定后修正字符类别分类 | 实测查出两个缺陷：① `looksDenseTokenText` **无 CJK 分支**导致中文低估 **53%**；② **「密文」类的前提是反的**——JSON 实测 4.18 字符/token，是非 CJK 里最**稀**的一类，标点最少的日志反而最密（3.31）。故删除密文类，改分**散文 4.5 / 其余 3.5**。交叉两家 tokenizer 取最密值定参 | ✅ 最差低估 −53% → **−5.3%**，最差高估 +109% → **+19.5%**（英文散文 +41% → +8.9%）。判别器 `looksProseText` 的三条护栏（标点密度 / 平均词长 / 字母占比）**逐条拆掉验证过红灯**——误判成散文是向低估偏 29%，是本改动唯一新增的风险面。`test-token-estimate-accuracy.ts` 进门禁；`live-token-calibration.ts` 供复测，不进门禁 |
| **AR2B2 · measurable budget** ✅ | `scripts/test-compact-benchmark.ts`（进门禁）：中英/tool/diff/长 JSON 混合语料 | 实测 20 轮 11047→859 tok ×12.9 · 80 轮 44607→859 ×51.9 · 均 2–3ms · heap +0.1MB · 4× 输入仅 1.2× 耗时 | ✅ 阈值分两档：确定性指标（不改入参 · 压缩比 · 不留孤儿 tool_calls）严格断言；时延/内存只设灾难阈（8s/320MB）——卡太紧只会制造假红灯 |
| **AR2C · remote decision** ✅ **不实施（closed）** | [ADR_COMPACT_REMOTE.md](./ADR_COMPACT_REMOTE.md) | 准入两条**均不成立**：压缩管道 2–3ms/0.1MB 无本地瓶颈；无真实跨会话需求 | ✅ 远端压缩要把**对话正文全部**发给新第三方接收方，比遥测更严重；且离线/兼容/失败回退四面皆为净负。已列重开条件，非永久挂起 |

AR2 提交顺序：**A0a → A0b → A1 契约/测试 → A2 接线 → B1 registry（重估后）→ B2 benchmark → C 决策文档**。每刀都必须能单独回滚到 C0–C5，不以"压缩率更高"交换 transcript 可恢复性。

##### 为什么 A2 不启用任意中段压缩（证据门控，2026-07 调研）

调研两个参考实现后的结论：

| | 中段压缩 | 写盘模型 |
|---|---|---|
| HC | partial 只有 `from`/`up_to`（前缀或后缀）；真中段是 `snip`（`removedUuids` 列表）**但其构建里是 no-op 桩 + feature flag 关闭** | append-only + load 时 prune |
| codex | **无**，只有前缀坍缩（`CompactedItem.replacement_history`） | append-only |
| Bolo | 契约已具备 | 整份重写 |

即：**任意中段压缩没有任何一家真正跑在线上。** 契约留着（纯函数、有测试、零成本），
但启用它属于净新增领域，需要先有证据证明前缀压缩不够用。当前没有这样的证据，
故按 AR4 的证据门控方式**显式不启用**，而不是留一个永久待办。

另记：Bolo 的读侧其实已是 append-only 语义（resume 取最后一个 `compact_boundary`
之后的 message；durable 条目由 `projectDurable*` 全量扫描、不受 boundary 位置影响），
所以写侧若日后改 append 与现有读侧兼容。但 append 会让文件只增不减、更易撞 32MiB 上限
（HC 用 load 时 prune 解决）。这是独立的架构决策，**不塞进 A2**。

##### AR3 · Codex App 风格 Desktop（薄 renderer）

> **动手前的方案见 [DESKTOP_DESIGN.md](./DESKTOP_DESIGN.md)**（含证据可信度说明、现状实测、
> 明确不重复的反面教材、以及未决问题）。下表是切片划分，设计判断以该文档为准。

| 切片 | packages-first / IPC 契约 | Codex App 风格人类结果 | 专项门禁 |
|------|---------------------------|------------------------|----------|
| **AR3A · client/store** ✅ | protocol negotiation、snapshot/query/command client、单一 normalized store；mock 与真 core adapter 同接口 | 启动后能看到 session 状态，断线/不兼容有明确空态 | protocol round-trip、unknown fields、stale command、IPC timeout/reconnect、真实 Electron 握手 |
| **AR3B · navigation/recovery** ✅ | session/turn/control/task selector 与 selection route 纯模型 | 左侧 session 导航、主区 turn timeline、诊断抽屉；interrupted 可 inspect/discard/retry-safe | 大会话、旧 transcript、missing target、crash/restart；默认不 replay |
| **AR3C · content cards** ✅ | markdown/tool/diff/approval view-model 继续来自 packages | 克制的信息密度：消息流、tool 状态、diff、approval、错误与复制 | unsafe HTML、超长输出、折叠、键盘/屏幕阅读；权限与 diff 不在 renderer 重算 |
| **AR3D · composer/runtime actions** ✅ | composer intent→queue/steer/interrupt/command；携带 expected state/requestId | active turn 时可排队、修正或中断；partial acceptance/warning 可恢复 | double submit、stale target、offline、cancel/replace race |
| **AR3E · settings** ✅ | provider/model/effort/capabilities/config schema 共用 packages | provider/model/effort 可搜索与切换，能力/缺 key 可解释 | secret 不回传 renderer/transcript；切换/持久化失败保留旧值 |
| **AR3F · hardening/package** ✅ | telemetry-free perf counters 仅本地测试；打包配置 | crash 后可重新打开并诊断；Windows 安装包可复现 | cold/warm start、10k events、内存、renderer crash、Windows package/smoke |

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
4. 对标 HC/Codex/OpenCode/Pi 时先审计许可证、运行模型与依赖成本；允许复用许可明确、
   spike 通过的成熟基础库或窄 fork，禁止盲搬重量级产品目录、未许可源码和本机路径。
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
| 15 | **AR-T3+ · 能力面续刀** | `bolo search enable` · OpenRouter plugin · AskUserQuestion（逐项） | 见 §14.5 | 每项独立红灯 + 全量门禁 | ✅（AskUserQuestion 真 TTY 交互未验） |
| 16 | **AR2A1–A2 · watermark/safe rewrite** | range/watermark 纯契约 ✅ · 契约作为验证者接线 ✅ | compact 安全面收口 | tool pairing + lifecycle 保留 | ✅ 四条验收全过（`3e918ea` · `948061c` · `b5c7112`）；**中段压缩按证据门控显式不启用**，理由见 §13.10.2 |
| 17 | **AR2B–C · tokenizer/benchmark/ADR** | 启发式修正 ✅ + 语料基准 ✅ + remote ADR ✅ | 可量化 token/cost | 偏差阈值 + fail-closed | ✅ B1 不引入 tokenizer（`661fc7d`）· B2 基准（`28f70fc`）· C 决定 local-only |
| 18 | **AR3A–F** | A ✅ client/store + core adapter + 生产 IPC · B/C ✅ 会话切换恢复/视图模型/薄壳 · D ✅ composer · E ✅ model/effort · F ✅ NSIS · OI-06 ✅ control/tool progress 投影 | Codex App 风格 Desktop（[设计方案](./DESKTOP_DESIGN.md)） | mock/core IPC + event projector + Windows package | ✅ `9f0f687` 收口。真实 Electron 已完成 runtime hello/query、自动化 session-row click/resume 与 model/effort IPC mutation。⚠️ 真人点击与窗口视觉仍未验 |
| 19 | **AR4** | 逐项 evidence gate | 有证据实施；无证据书面关闭 | 场景/基准/兼容证据 | ✅ **六条全部书面决定**（含重开条件）→ [ADR_AR4_EVIDENCE_GATE.md](./ADR_AR4_EVIDENCE_GATE.md) |
| 20 | **AR5A–D**（AR5C 已提前完成） | A ✅ 迁移幂等/失败不覆盖源 · B ✅ 故障注入 · D ✅ 发布门 | clean clone 安装、升级、恢复手册 | full test + cross-platform smoke + security audit | ✅ **看板走完**。发布门含 SBOM · 性能预算 · 安全自查 · **已知限制** · 恢复手册 · 可执行 checklist → [RELEASE.md](./RELEASE.md) §6 |
| 21 | **OI-04 · SearXNG 直连** | 显式配置 · fail-closed endpoint · 零依赖 JSON 工具 · 动态启用 | `bolo search status` · CLI/Desktop warning · 无第三方桥 | 本地 fixture + 真实 Docker/upstream smoke | ✅ `c058998`；OI-X1 于 2026-07-27 闭环 |
| 22 | **OI-07 · SearXNG 诊断/部署体验** | A ✅ `unresponsive_engines` 契约 · B ✅ `search doctor` · C ✅ 可选 Docker setup | 区分正常空结果/全故障/部分成功；一键只读诊断；显式 setup 不安装 Docker | fixture + 非空 smoke + rollback/端口预检/零依赖护栏 + 源码/dist live | ✅ A `7754525` · B `3e96573` · C `ef03f3d` / `f623ad9` |
| 23 | **OI-08B · CLI 零步骤首次启动** | 用户状态 materialize / 项目只读发现 · workspace session store · legacy discovery · 显式 init | 安装后直接 `bolo`；普通启动不创建项目 `.bolo`；旧会话可恢复 | first-run 真实 CLI + spill/subagent 路径 + 112 项完整门禁 | ✅ 代码 `22c0d0c`；文档已同步 |
| 24 | **OI-09 · CLI TUI 交互重构** | terminal width/input reducer/activity/timeline 纯契约 · raw/plain 双路径 · 原子 activity writer | 宽/中/紧凑欢迎页 · 真实输入框 · 提交即时回显 · 稳定 `✦ Thinking`/Running/elapsed · Markdown 与原位工具进度 | `test:cli-tui` + CLI 兼容轨 + typecheck + 113 脚本完整门禁 | ✅ 代码 `843f593` + `1413da3` + follow-up `10879ec`；旧 Bolot 身份已由 OI-11G 替换。⚠️ 真实 Windows Terminal 观感/按键仍需真人验 |
| 25 | **OI-10 · CLI 命令发现与 TUI 一致性** | A frame width helper · B activity frame · C slash candidate projection · D menu reducer/renderer · E CLI-local/Plugin/Skill 动态贡献 · F 门禁/文档 | `/` 全量、`/d` 过滤 `/doctor` · ↑↓/Tab/Enter/Esc · 上下框同宽 · Thinking 有动画且无空白帧 | `test:cli-tui` + `test:slash-completion` + typecheck + 114 脚本完整门禁 + dist smoke | ✅ 代码 `67421bb`；文档已同步。⚠️ 真实 Windows Terminal 观感/按键仍需真人验 |
| 26 | **OI-11 · CLI TUI 持久终端表面与可审计权限交互** | A terminal surface/composer · B timeline/status · C segment activity · D permission chooser/details · E viewport VT · F abort diagnosis · G crystal identity · H docs | turn 中输入区常驻全宽 · gutter/用户块/token/model/keys · 每段 Thought · command 可见三态权限 · 历史不被 clear · timeout 可行动 · Bolo 水晶欢迎页 | OI-11 专项 + 既有 TUI/provider/permission 回归 + typecheck + 121 项完整门禁 + dist smoke | ✅ A–H 已闭环；代码 `e9a32cf` / `59acdf6` / `b0feb0c` / `4fc3791` / `da0533c` / `b0fbb86` / `8088fbb`，真人观感移交 OI-H3 |
| 27 | **OI-12 · CLI TUI 信息架构与多行输入稳定性** | A argument hint · B context view-model/dashboard · C shared gutter · D dock-width user block · E paste transaction · F docs | `/effort ` 可见合法档位 · `/context` 图形概览/明细分层 · 正文不贴墙 · 用户块全宽 · 多行 paste 不误提交/滚屏 | OI-12 专项 + slash/TUI/compact/usage 回归 + typecheck + 123 项完整门禁 + dist smoke | ✅ A `1696127` · B `15b37ed` · C `40a5d41` · D `8d2a7a5` · E `7f76093` · F 本文档批；真人字体/鼠标粘贴/resize/按键仍归 OI-H3 |
| 28 | **OI-13 · CLI TUI 垂直节奏与水晶工作台** | A silent Thought completion · B running surface breathing row · B2 idle/running shared gap · C responsive crystal workbench · D docs | 直接正文前仍有本段 `Thought for` · activity/final answer 与 composer 间有稳定完整空行 · 欢迎页最大 100 cells、宽屏双列/中紧凑单列并保留水晶 | thinking/surface/owner-handoff VT/crystal/TUI 专项 + typecheck + 完整门禁 + dist smoke | ✅ A `fe2d39a` · B `bf25077` · B2 `2b9d008` · C `4c4fb08` · D 文档批 |
| 29 | **OI-14 · CLI TUI retained renderer 重构** | A 真实 VT/选型 ✅ · B live view-state ✅ · C retained 基座 ✅ · D transcript/Markdown ✅ · E Composer/activity/footer ✅ · F overlays ✅ · G 默认切换/可靠性/性能 ✅ · H legacy 删除/发布审计 ✅ | 正文不再碎裂或产生巨大空洞；物理续行 gutter 一致；user/agent/composer 有稳定间距；stream/resize/paste/permission 不破坏屏幕 | `@xterm/headless` auto-wrap/resize + chunk property + Markdown/Unicode/ANSI/OSC 8 + editor/overlay + perf + dist/pack/install + 真人 Windows Terminal | **✅ H 自动闭环 `39e66b4`–`d4eaed0` · follow-up `e6ec6cb` · ⚠️ OI-H3 BLOCKED: HUMAN**；A `1ae9f53` / `f04f8de`，B `269b39c`，C `1798a7c`，D `8b060e5`，E `d0fb822`，F `31384d4`，G `6f4764f`–`accc22c`；完整方案 [CLI_TUI_REFACTOR_PLAN.md](./CLI_TUI_REFACTOR_PLAN.md) |
| 30 | **OI-15 · slash 命令 surface/lifecycle** | A core display policy ✅ `d681734` · B retained panel/toast 单槽 ✅ `d6bd087` · C context/doctor/status 与只读 panel/pager ✅ `26f796f` · D Skills/Plugins overlay ✅ `21ee1e2` / `87054df` · E toast/error policy ✅ `1d49d53` · F compatibility cleanup ✅ `d1e26bb` | `/context` 位于 Composer 下方并自动清除；重复查询 replace；长内容 pager；短动作 toast；迟到结果不覆盖当前视图；normal slash 不写 compatibility | core exhaustive + 20×重复查询 + fake clock/generation + single/multi-page/resize/focus/reset + persistence/plain/JSON + full/dist/pack/install | ✅ A–F 已关闭；OI-H3 真人验收继续单列 |
| 31 | **OI-16 · Doctor pager viewport** | embedded text pager 18 行正文上限 · 短内容实际高度 · OverlayHost 生命周期专项 | `/doctor` 在高终端分成可导航页；footer 与 Composer 可见；`q`/`Esc` 后恢复输入 | 24/48/80 行真实 OverlayHost 物理高度 + page/footer/navigation/close + plain byte-stable + full/dist/install/预算/Electron smoke | ✅ `5b22c15`；真人截图准入、自动闭环 |

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

### 14.4 AR-T3b · Web search ✅（六条线路全部活体验证）

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

**活体验证（六条线路全绿）：** anthropic ✅ · openai-responses ✅（均经第三方中转，比官方端点更严格，两者**零告警**）·
openai-compatible ✅（DeepSeek 官方 API，确认**无** hosted 搜索且不 400）· openrouter-plugin ✅（免费模型零余额）·
`mcp-external` ✅（Exa 免密层：`enable → 连接 → 列工具 → 真调用 → CLI 端到端`，见 TOOLS.md §3.3b）。
原调研标 UNCERTAIN 的 wire format 全部证实。

**实测决定的门控：** DeepSeek 对 `tools[{type:'web_search'}]` **硬 400**，
但对 body 顶层未知字段 `plugins` **静默忽略** —— 后者更危险（用户以为开着实际没有），
故 OpenRouter 增强必须硬门控 baseUrl。

**只有真跑才发现的缺陷：** 引用逐句重复（渲染层按 turn 去重）；
中转 `HTTP 503` 包着 `model_not_found`（错误解释改为 **body 优先于 status**）；
MCP 工具失败只吐 `fetch failed`（补 `describeMcpCallError`：指名 server + 分类 + 可重试标注）；
启用「搜索」搭售远程抓取工具、模型拿它顶掉本地 `WebFetch`（补 `allowTools`/`excludeTools`）。

**信任边界与开源调研（2026-07）→ TOOLS.md §3.1b/§3.1c。** 结论两条：
① 第三方搜索的「开源」通常只到 **MCP 协议壳**（Exa 的壳是 MIT），**后端一律闭源**——
分不清这两层就等于误导用户；② 我们自己曾有一条**假隐私承诺**（searxng preset 声称
`Nothing leaves your network`，而 SearXNG 是元搜索代理，自托管只隐藏 IP 不隐藏查询）。
现已引入机器可读的 `SearchPreset.privacy` 字段并由测试守住散文与字段一致。
三个参考项目**都没有**提供自托管/开源搜索后端选项；Bolo 现在用显式
`search.searxng` 直连提供这条选择，不借第三方桥。

**活体脚本不进门禁：** `scripts/live-mcp-search.ts` 依赖公网与第三方可用性，
实测 3 跑挂 1（Exa 免密层按 IP 限速）。放进 `npm test` 会让 CI 因别人家限速变红，
继而所有人开始无视红灯——**比没有这个测试更糟**。契约面由
`test-search-cli.ts` / `test-mcp-tool-error.ts` 等门禁测试覆盖。

### 14.5 AR-T3+ · 续刀候选（已完成历史）

按 §13.10 固定规则「一次一个最小切片」，逐项独立准入：

| 候选 | 现状 | 备注 |
|------|------|------|
| **AskUserQuestion** | ✅ 已实现（**真 TTY 交互未验**） | 契约 + 工具 + 权限归类 + CLI 控件 + 端到端接线 + 系统提示，全部进门禁。详见 [TOOLS.md](./TOOLS.md) §5.1。**遗留**：控件测试注入 `readKey`，真人在真终端按键、以及 raw-mode 与 REPL 抢 stdin 的问题没验过 |
| **Desktop 侧 AskUserQuestion** | ✅ 已接线 | `apps/desktop/src/main/askUserQuestionBridge.ts`（**不 import electron**，故可离线驱动测试）+ `bolo:ask_user_question` push / `bolo:ask_user_question_response` invoke + renderer 对话框（含自由文本一栏——工具描述对模型承诺了「用户始终可以自己写」，UI 不提供就是假承诺）。**守的那条**：没答绝不能变成「答了」——超时→`cancelled`、没窗口→立刻 `unavailable`（挂着等表现为整轮卡死）、渲染进程发来的垃圾原样上交由 `projectAskUserQuestionAnswers` 拒（转成 `cancelled` 等于替用户说「我放弃了」，同样是编的）。六条护栏逐条拆红验过。**真人点击仍未验**（与 CLI 侧同属只能人工验的一类） |
| **headless 工具放行粒度** | ✅ 已实现 | `--allowed-tools` / `--disallowed-tools`：精确名 · `mcp__srv__*` 前缀 · `Bash(pattern)`。权限模型本身不缺东西（`SessionPermissionRules` 早就有 always-allow/deny），缺的只是命令行入口，故本刀是**纯解析 + 接线**，不碰匹配器。解析 **fail-closed**（exit 2）——静默丢弃一条 `--disallowed-tools` 会让用户以为拦住了而实际没拦。`--resume` 时与快照规则**叠加**不覆盖。刻意不支持 `Read(src/**)`：本仓 path glob 是全局的，翻过去会连 `Write` 一起放行。详见 [PERMISSIONS.md](./PERMISSIONS.md) §5 |
| **真·本地搜索路径** | ✅ OI-04 + OI-X1 + OI-07A | [LOCAL_SEARCH_AND_FETCH.md](./LOCAL_SEARCH_AND_FETCH.md)：SearXNG compose（默认只开 `html`，须显式加 `json`）+ `search.searxng` 配置 + endpoint/预算/隐私边界。Bolo 已删除虚构桥 preset，零依赖直连 JSON API；本地 fixture 覆盖协议，真实 Docker/upstream smoke 覆盖生产接线。OI-07A 已把 `unresponsive_engines` 变成模型可见诊断；默认引擎可能 429/CAPTCHA/timeout，仍必须以非空结果验收 |
| **本地抓取 preset** | ✅ **书面关闭（不做）** | 重估后前提不成立：**抓取本来就是本地的**——`WebFetch` 是 Bolo 自己的工具，直连目标站点；Exa preset 也已用 `allowTools` 把它的远程抓取工具挡在外面。真实缺口只剩「需要执行 JS 才出内容的页面」，而补它意味着 preset 里写一条 `npx -y <包>`，即**下载并执行远端代码**去解决一个信任问题。且 stdio 早就能用（`McpServerConfig.command`），用户手写进 mcp.json 即可——preset 省的只是打字，换来的是一次背书。代价见 [LOCAL_SEARCH_AND_FETCH.md](./LOCAL_SEARCH_AND_FETCH.md) §4。**重开条件**：出现权威且可审计的本地抓取实现，且有具体到「哪个页面拿不到内容」的需求 |
| **前台命令自动后台化** | ✅ **书面关闭（不做）** | 门控先量代价：超时时**部分输出本来就保留**，真实损失是「模型不知道下一步」——错误里从没提过 `run_in_background`。故缺口是**错误不可行动**，比自动转后台小得多。已修（只在超时时给出路，两个方向验红：`test-bash-timeout-guidance.ts`）。自动转后台的代价是凭空多一个模型没要求的后台任务、一个要追踪的 id、以及「这轮完没完」的歧义。详见 [ADR_AR4_EVIDENCE_GATE.md](./ADR_AR4_EVIDENCE_GATE.md) §5 |
| **LSP** | ⏸ **暂缓（有触发条件，非永久待办）** | 缺口属实（今天只有 Glob/Grep，符号级导航没有），但绕路都**成功了**，没记录到「文本搜索给错答案导致改错」的案例——而准入要的正是后者。且 LSP 意味着给每种语言起一个 server 进程，撞「不代跑第三方进程」。触发条件写死了两条（≥3 次可复现的错改案例，或出现不需额外进程的单语言方案）→ [ADR_AR4_EVIDENCE_GATE.md](./ADR_AR4_EVIDENCE_GATE.md) §6 |

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
| 构建 | `scripts/build-dist.ts`：esbuild bundle → `dist/bolo.mjs`（1,692,863 bytes / 195 模块，OI-14H + `e6ec6cb` + `6b7ff99`）+ 拷 `bundled-skills` |
| 发布元数据 | `private:false` · `name`/`version`/`files`/`keywords`/`homepage`/`bugs` · `bin → ./dist/bolo.mjs` · `prepack` |
| 资产路径 | `getBundledSkillsDir()` 改为**双布局存在性探测**（开发 / 发布产物） |
| 门禁 | `scripts/test-dist-build.ts`（产物契约）· `scripts/test-dist-install.ts`（真实 pack→install→run） |
| 文档 | **[RELEASE.md](./RELEASE.md)**（发布真源）· README 安装章节面向用户重写 |

### 15.2 语义要点

- **零运行时依赖是红线**：`dependencies` 显式写成 `{}`，并由测试断言。esbuild/tsx 只是构建期工具，产物里没有它们，用户也装不到。
- **bin 就是产物本身**，没有 wrapper —— 少一层就少一处会走偏的地方。
- **`prepack` 强制重建**，杜绝 tarball 里混进旧产物。
- **bundling 会压平模块路径**：任何 `import.meta.url` 自算路径的代码都必须做双布局兼容；任何非字面量的动态 `import()` 都会让 bundle 在运行时炸。改代码时注意这两条。
- tarball 清单被测试锁死：只有 `dist/` + `README.md` + `LICENSE` +
  `THIRD_PARTY_NOTICES.md` + `package.json`（当前合计 7 files），源码/`.bolo-tmp`/
  `.planning`/`.claude`/密钥一律不得进。

### 15.3 本轮不做

Electron 安装包（后置，先 CLI）· `@bolo/*` 子包独立发布（跨包用相对路径导入，workspace 包名目前是装饰性的）· 签名/公证 · 自动升级检查。
