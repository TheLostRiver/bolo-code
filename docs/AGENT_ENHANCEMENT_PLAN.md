# Agent 面强化计划（本地优先）

> **定位：** Bolo 自研路线上的下一批能力切片——跨会话记忆、循环守卫、压缩深化、
> 终端健壮性、hooks/权限补强。全部任务遵循既有红线：零运行时依赖
> （`dependencies: {}`）、本地优先、无遥测、无官方市场、证据门控。
> **进度真源：** [ROADMAP.md](./ROADMAP.md) §0、§13.11。
> **任务按实现成本从低到高排序；从低难度任务开始，一次一个最小切片，先红灯后实现。**

---

## 0. 总览

| 任务 | 标题 | 成本 | 落点 | 状态 |
|------|------|------|------|------|
| ROB-1 | 工具调用重复检测（stationarity guard） | 低 | core queryLoop + shared 纯契约 | ✅ 本轮 |
| ROB-2 | 悬空 tool call 修复与结果去重 | 低 | session transcript/load | ✅ 本轮 |
| CMP-1 | 压缩专用模型与墙钟预算 | 低 | compact 配置/执行器 | ✅ 本轮 |
| ROB-3 | 后台任务 manifest 与重启恢复提醒 | 低 | backgroundShell 持久化 + `/bg` | ✅ 本轮 |
| TERM-1 | 终端能力探测（品牌特化） | 低 | CLI adapter | ✅ 本轮 |
| TERM-2 | 输入 CSI 分片重组 | 低 | CLI adapter/StdinBuffer | ✅ 本轮 |
| HKP-1 | hooks 事件面扩展与 fail-open 结果 | 低 | hooks 包 | ✅ 本轮 |
| HKP-2 | 权限 auto 模式命令级安全分析 | 低–中 | permissions auto 分类器 | ✅ 本轮 |
| HKP-3 | plan 模式与权限系统正交化 | 低 | core 权限接线 | ✅ 本轮 |
| REN-1 | markdown render-fidelity 自检 | 低 | markdown 渲染层 | ✅ 本轮 |
| MEM-1 | 跨会话记忆 MVP（Markdown 双层 + FTS 检索 + 压缩前 flush + 首轮注入） | 低–中 | 新 memory 模块 + core 注入 | ▶ NEXT |
| CMP-2 | 两遍预压缩（prefire pass1） | 中 | compact 执行器 | 📋 |
| MEM-2 | 记忆检索质量链（时间衰减/源权重/脚手架过滤） | 低 | memory 检索（MEM-1 之后） | 📋 |
| TERM-3 | 滚轮滚动规范化（分数累积 + cadence） | 低–中 | CLI 鼠标（OUT-4 之后） | 📋 |
| CBG-1 | 符号索引懒启动 + 门控 | 低–中 | 新 index 模块（最简版 `/symbol`） | 📋 |
| CMP-3 | 压缩 Segments 可检索模式 | 中 | compact 段存储 + read_file 指针 | 📋 |
| REN-2 | checkpoint 流式渲染（帧预算切片） | 中 | retained renderer | 📋 |
| REN-3 | 子进程隔离渲染不可信内容 | 中 | 渲染 worker | 📋 |
| EVT-1 | 文件事件总线分层（OS 事件 → 语义事件 → 扇出） | 中 | 新 events 模块 | 📋 |
| WT-1 | worktree 快照/GC/池化 | 高 | worktree 模块 | 📋 |
| HKP-4 | 变更归因（agent vs 外部） | 高 | 文件跟踪 | 📋 |

---

## 1. ROB-1 · 工具调用重复检测（stationarity guard）— 低成本 ✅ 本轮

**目标**：模型对同一工具以相同参数连续重复调用（如轮询式死循环、卡在同一修复步骤）
时，本地检测并逐步干预：达到轻阈值注入 reminder 提醒换策略，达到硬阈值中止该 turn，
避免 token 空转。

**设计**（已落地）：
- shared `toolRepetition.ts` 纯契约：`fingerprintToolCall`（工具名 + 参数稳定哈希，
  键序无关）、`advanceToolRepetition`（按轮推进，序列相同 +1 / 变化或无工具轮重置）、
  `toolRepetitionStage`（8 提醒 / 16 中止，阈值可配）、`formatToolRepetitionReminder`。
- core：queryLoop 每轮工具执行后推进计数；`before_provider` 边界判定——达到
  warn 阈值注入一次 reminder（user 消息 + warning 事件，复用既有渲染通道），
  达到 abort 阈值以 `tool_repetition` terminal reason 中止并跑 Stop hooks。
- 计数为 turn 级；用户中断不计数；参数变化立即重置。

**验收**：专项覆盖指纹键序无关/参数变化/工具名变化/不可解析参数、状态机递增/
重置/阈值边界、reminder 文本、queryLoop 连续同参提醒+中止、换策略不触发、
无工具轮重置；typecheck、相关回归（ptl/model-retry/todo-session/cli-events/
reasoning-forward）与完整 `npm test` 通过。

## 2. ROB-2 · 悬空 tool call 修复与结果去重 — 低成本 ✅ 本轮

**目标**：崩溃/中断遗留的半截 tool_call（有调用无结果、有结果无调用）在恢复时自动
修复，重复的 tool result 去重，避免 resume 后模型看到残缺或重复的工具消息。

**设计**（已落地）：
- shared `messageRepair.ts` 纯契约 `repairToolMessagePairs`：悬空声明移除（消息只剩
  调用则整条删除，否则降为纯文本）、孤儿结果丢弃、重复声明保留第一次、重复结果
  保留第一条；全部 fail-closed；幂等。
- `loadSessionPair` 三处返回（双文件/JSON/仅 transcript）统一 finalize，覆盖
  resumeSession 与 resumeSessionFromWorkspace 的所有消息来源。

**验收**：专项覆盖悬空/降级/部分悬空/孤儿/重复结果/重复声明/健康对/幂等，以及
JSON 快照恢复集成；typecheck、resume/migration/persist/rewrite/first-run 回归与
完整 `npm test` 通过。

## 3. CMP-1 · 压缩专用模型与墙钟预算 — 低成本 ✅ 本轮

**目标**：压缩摘要允许配置独立模型（如更小/更便宜的模型），并给压缩生成过程
（含 reasoning）设置墙钟硬预算，防止压缩本身 runaway 卡住会话。

**设计**（已落地）：
- config 顶层新增 `compactModel`（压缩专用模型名）与 `compactTimeoutMs`（墙钟
  预算毫秒），可被会话创建选项覆盖；`CreateSessionFromWorkspaceOptions` 透传。
- `createCompactSummarizerFromProvider(provider, { model })`：有模型覆盖时走
  `completeStream(req, { disableTools, model })`，无覆盖保持 `completeText`
  优先原语义；provider 热切重建 summarizer 同样应用模型覆盖。
- `runFullCompact` 新增 `summarizeTimeoutMs`：每次 summarizer 调用（含 PTL
  重试）套 `Promise.race` 墙钟预算，超时按失败回退（messages 不变）且 reason
  点名超时时长；缺省不设限，旧行为不变。

**验收**：专项覆盖挂起 summarizer 超时回退、快速成功、无预算原行为、模型覆盖
（completeStream 收到 model / completeText 不被调用 / 无覆盖走 completeText /
无 completeText 无 model 键）与 config→session 装配；typecheck、compact/
auto-compact/config/ptl 回归与完整 `npm test` 通过。

## 4. ROB-3 · 后台任务 manifest 与重启恢复提醒 — 低成本 ✅ 本轮

**目标**：后台任务（run_in_background）元数据持久化为 manifest；进程重启后
`/bg` 能显示「上次会话遗留的后台任务」及输出位置，提醒用户处置，不静默丢状态。

**设计**（已落地）：
- shared 状态机新增 `interrupted`（终态）：resume 投影遗留任务用；
  `markShellInterrupted`（running→interrupted，终态 no-op）；
  `serializeBackgroundShellManifest` / `parseBackgroundShellManifest`
  （fail-closed：任何字段非法整体拒绝）。
- manifest 文件 = transcript 同目录 `<id>.background-shells.json`：会话保存点
  （submitPrompt 的 maybeAutoSaveSession 成功后）落盘；resume 时把 running
  投影为 interrupted（无法跨进程证明死活，不宣称 killed/completed）；正常
  endSession（收尸+清理输出后）删除 manifest；不自动重启任务。
- `/bg` 追加 background shells 段：interrupted 记录显示 `[leftover]`、输出
  路径与处置提示。

**验收**：专项覆盖 interrupted 投影/终态守卫、manifest roundtrip 与六类损坏
拒绝、真实 spawn → 落盘 → resume 投影 → 清理全链路；typecheck、bash-
background/runtime/stream-error 与 slash 回归及完整 `npm test` 通过。

## 5. TERM-1 · 终端能力探测（品牌特化）— 低成本 ✅ 本轮

**目标**：启动时探测终端身份与能力（DA2 报告、tmux 嵌套、Windows 平台），按品牌
特化行为提供数据源；能力不足时走保守默认，不阻塞启动。

**设计**（已落地）：
- shared `terminalProbe.ts` 纯契约：`parseDa2Response` / `isDa2Response`、
  厂商→品牌映射（Windows Terminal 7721 / xterm 1 / iTerm2 0 / kitty 61 等）、
  env 推断（WT_SESSION / TERM_PROGRAM / TERM / TMUX）、`resolveTerminalCapabilities`
  优先级 da2 > env > 保守默认，含 `insideTmux` / `isWindows` / `source`。
- adapter：raw input 获取时非阻塞发送 `CSI > c` 查询（`TERM=dumb` 不发）；
  响应在 StdinBuffer data 回调里**拦截**（不泄漏进输入处理），到达即更新缓存；
  300ms 超时后保持 env 推断（迟到响应仍会被拦截更新）；release/stop 清理 timer。
- controller 透出 `getTerminalCapabilities()`。

**验收**：专项覆盖 DA2 解析/畸形拒绝、厂商映射、env 推断、解析优先级、查询发送/
响应拦截不泄漏/普通按键不受影响/超时 env 回退/dumb 不发查询；typecheck、TUI
retained/cleanup/ownership/mouse 回归与完整 `npm test` 通过。后续消费方（TERM-3
滚轮特化、粘贴差异）以本数据源为准。

## 6. TERM-2 · 输入 CSI 分片重组 — 低成本 ✅ 本轮

**目标**：输入流中跨 chunk 拆分的 CSI 报告（如鼠标/焦点/终端响应）重组后再分发，
防止被当成普通按键序列；未知不完整序列 fail-closed 丢弃。

**设计**（已落地）：
- shared `csiReassembly.ts` 纯逻辑：`isCompleteCsiSequence`（CSI 以 0x40-0x7e
  终结，SGR mouse 特例）、`isCsiContinuation`（参数/中间字节/终结符续段，
  非 ASCII 与控制字符不算）、`CsiReassembler` 状态机（pending 缓冲/拼接/
  新 `\x1b` 或非续段打断/超时 tick 丢弃/reset），无 timer 纯逻辑可单测。
- adapter：data 回调前接入重组器；拼完整的序列走既有拦截/转发；pending 时
  设 55ms flush timer 触发 tick；release/stop/acquire-catch 清理。
  取代 TERM-1 的 DA2 窗口吞（更通用：DA2 碎片同样被缓冲丢弃）。
- 误拼窗口说明：终结符字节（0x40-0x7e）是合法续段（分片响应可能单独切出
  终结符），重组优先；用户首字符被误拼仅限 pending 未超时的 50ms 窗口。

**验收**：专项覆盖完整性/续段/重组/超时丢弃/新序列打断/控制字符打断/reset，
adapter 集成（分片鼠标重组为单事件、未知序列超时丢弃、之后输入恢复）；
TERM-1/mouse/TUI 回归与完整 `npm test` 通过。TERM-1 的尾段泄漏限制由本轨
收口（`;1;0c` 现作为续段拼回 pending）。

## 7. HKP-1 · hooks 事件面扩展与 fail-open 结果 — 低成本 ✅ 本轮

**目标**：hooks 事件面补齐 `PermissionDenied` / `PostToolUseFailure`（`UserPromptSubmit`
已有，不重复）；hook 执行结果结构化（ok/failed/timeout/aborted）供展示与诊断，
失败不静默吞掉也不无谓阻断（fail-open）。

**设计**（已落地）：
- shared：`HOOK_EVENTS` 加 `PermissionDenied`（纯观察，含 reason）与
  `PostToolUseFailure`（含 error/tool_response，exit 2 反馈给模型）；两者按
  tool_name 匹配（不进 WITHOUT_MATCHER）。
- hooks：`HookRunResult.status` 派生字段（aborted > timeout > exit 0 ok >
  failed；与 blocked 正交）；PostToolUseFailure exit 2 并入 continuation。
- core：权限拒绝（deny 各路径）经 `endResult` 统一 fire-and-forget
  `PermissionDenied`（不阻塞拒绝路径，hook 自身失败被吞且仅此）；工具执行
  失败（isError）时在 PostToolUse 之后 await `PostToolUseFailure`（同 emit/
hookDiag/exit-2 反馈路径）。
- 威胁模型：PermissionDenied 是纯观察事件，hook 输出不参与任何决策；
  fire-and-forget 意味着进程退出可能截断该观察（fail-open 语义内）。

**验收**：专项覆盖事件注册、tool_name 匹配、status 四态派生（ok/failed/
timeout/预 abort 不执行）、deny 触发写标记、失败触发写标记、exit 2 反馈；
typecheck、hooks-htrack/ptl/subagent/cli-events 回归与完整 `npm test` 通过。

## 8. HKP-2 · 权限 auto 模式命令级安全分析 — 低–中成本 ✅ 本轮

**目标**：auto 模式的 Bash 审批做命令级安全分析：提权/危险形态永不自批、
包管理器白名单子命令自动放行、其余走询问。

**设计**（已落地）：
- shared `commandSafety.ts` 纯契约：`tokenizeShellCommand`（词法级，单/双引号与
  转义，未闭合 fail-closed；**引号外 shell 元字符——`;`/`&&`/`||`/`|`/`$()`/
  反引号/换行/CRLF/重定向/通配——一律 fail-closed 为 ask**，词法级无法静态
  验证链式附加命令）+ `classifyBashCommandSafety`——
  deny：提权命令头（sudo/su/doas/pkexec/runuser）、rg/grep `--pre`、破坏性
  目标（rm -rf /、dd of=/dev/*、mkfs）；
  ask：npx/bunx（可执行任意包）与未覆盖命令；
  allow：包管理器（npm/pnpm/yarn/bun/cargo/pip/pip3/uv/go/gradle/mvn/composer）
  白名单子命令（install/uninstall/update/upgrade/list/search/info/view/outdated/
  why/tree/audit/help/version 等；run/build/test/add/get/mod/init/create 等
  执行脚本/下载代码的一律询问）。
  威胁模型：install/update/upgrade 会执行生命周期脚本（postinstall/setup.py/
  远程构建）——这是**有意保留**的供应链信任（与分类器允许同类工具同级），
  边界以「是否包管理核心操作」为准。双引号内命令替换（$()/反引号）与引号外
  元字符/换行一样 fail-closed（ask）。
- toolExecution：auto 分支先于分类器做确定性判定——deny 直接拒绝（不调分类器、
  不执行）、allow 直接放行（跳过分类器，且**受 toolRequestedAsk 保护**：工具
  checkPermissions 显式 ask 时不被命令级 allow 覆盖）、ask 走原分类器/UI 路径；
  audit stage=command-safety、permission_decision 事件完整。

**验收**：专项覆盖 tokenizer（引号/转义/未闭合）、危险拒绝（13 例含 reason）、
白名单放行（10 例）、任意执行器与未覆盖命令询问、fail-closed、auto 接线
（classifier spy 断言 deny/allow 均不调分类器）；permissions/auto-permissions/
permission-panel/exit-plan-mode 回归与完整 `npm test` 通过。

## 9. HKP-3 · plan 模式与权限系统正交化 — 低成本 ✅ 本轮

**目标**：plan 模式在任何权限模式下（含 bypassPermissions）都强制只读，ExitPlanMode
批准后才恢复；plan 状态独立于权限模式声明。

**设计**（已落地）：
- session 新增 `planMode` 正交开关：`/plan` 只置位开关（permissionMode 保持原值，
  不再被覆盖）；`setPermissionMode` 切到其它模式时清开关。
- toolExecution 的 gate 合成：`ctx.planMode ? 'plan' : ctx.permissionMode`——
  规划态任何权限模式（含 bypassPermissions）下都走 plan 只读 gate（read allow、
  ExitPlanMode ask、其余 deny）。
- ExitPlanMode 升级：plan 激活判定 = planMode 开关或旧路径
  （permissionMode==='plan' 兼容）；正交路径批准后**恢复原权限模式**（不再
  降级到 default），旧路径仍落到 default。
- status line：planMode 激活时显示 `mode=plan`。

**验收**：专项覆盖组合矩阵（default/acceptEdits/bypassPermissions/auto ×
plan 开关：plan 时 Write deny、Read allow；plan 关时 bypass allow、default ask）、
ExitPlanMode 正交路径恢复原模式、/plan 语义、status line；exit-plan-mode 与
slash 回归更新；typecheck 与完整 `npm test` 通过。

## 10. REN-1 · markdown render-fidelity 自检 — 低成本 ✅ 本轮

**目标**：渲染层检测「意图做了结构（表格/列表/代码块）但实际没渲染出来」的
fidelity 失败，作为 warning 信号（不静默吞掉）。

**设计**（已落地）：
- shared `markdownFidelity.ts` 纯契约：`detectMarkdownIntent`（表格=表头+`|---`
  分隔行、列表=行首 `- ` `* ` `+ ` `\d+. `、代码块=成对围栏）、
  `detectMarkdownRenderedStructures`（盒线边框/回退原始语法、列表符号、围栏）、
  `checkMarkdownFidelity`（仅意图 >0 且产物完全缺失才报；回退渲染不算失败；
  正常零误报）。
- retainedTranscript：markdown 块（user/assistant/reasoning）渲染后按 source
  缓存做检测（width 变化不重检——表格窄宽度回退仍保留原始语法）；
  RetainedRoot 汇总。
- controller flush：新问题以 warning 事件上报（blockId:kind 去重），CLI 展示。

**验收**：专项覆盖意图/产物/表格列表代码块丢失检测/回退不算失败/零误报，
集成（正常渲染零 warning）；transcript/retained/folding 回归与完整 `npm test`
通过。

## 11. MEM-1 · 跨会话记忆 MVP — 低–中成本（收益最高）✅ 本轮

**目标**：本地跨会话记忆：项目级与用户级 Markdown 记忆文件（人可读可编辑）+
全文检索索引（FTS，向量为可选增强）；会话内总结 flush（压缩前/手动触发），
会话首轮自动检索 top-N 注入系统消息（注入过则跳过，保护 prompt cache）。

**设计**（已落地；存量基础：core `memory.ts` 双层 MEMORY.md + topic 扫描 +
确定性相关挑选 + system 段注入，本次补齐 MVP 缺口）：
- **压缩前 flush**：`compactSession` 成功后总结压缩前最近消息（复用会话
  CompactSummarizer）追加到 user memory daily log（`<memory>/daily/<date>.md`）；
  会话内指纹锚点（`memoryFlushedHash`）去重——消息未实质新增则跳过；
  纯 fail-open（总结/写盘失败不拖垮压缩，锚点不更新下次重试）；`/compact`、
  auto compact、mid-turn 同路径。
- **手动写入**：`/memory remember <line>` 追加一行到 user daily log。
- **首轮相关性检索**：`createSession({ memoryRelevanceQuery })` →
  `assembleSessionSystemPrompt` → `getSystemPrompt` 透传
  `buildMemorySystemSection(relevanceQuery)`，首轮注入相关 topic top-N；
  注入一次性由 systemPromptSections 创建时定稿保证（后续轮不重检索，
  稳定前缀保护 prompt cache）。
- **降级**：检索/扫描 fail-open（读盘失败回退 MEMORY.md 全文注入，存量行为）；
  环境 `BOLO_DISABLE_MEMORY` 熔断保留。

**验收**（全部通过）：专项覆盖 flush 追加/指纹去重/失败 fail-open/过滤
system-tool 消息/空消息、compactSession 接线（warning + 锚点）、`/memory
remember`（含无参拒绝）、relevanceQuery 透传（有/无查询对比）；test-memory
（存量）顺带注册进默认 `npm test`；typecheck、slash/system-prompt/compact
回归及完整 `npm test` 通过。

**边界（后续项）**：FTS 索引（现为词频相关性，MEM-2 质量链）、外部编辑 watcher
标脏（新会话生效，当前会话沿用首轮注入）、resume 会话沿用快照记忆段不重检索。

## 12. CMP-2 · 两遍预压缩（prefire pass1）— 中成本 ✅ 本轮

**目标**：接近压缩阈值时后台先总结历史前缀（pass1 预热），真正压缩时只做增量
第二遍，缩短压缩停顿。

**设计**（已落地）：
- `packages/core/src/precompact.ts` 预热状态机：
  - 触发区间 = `[autoThreshold - 8_000, autoThreshold)`（auto 阈值本身 ≈
    effectiveWindow - 13_000 buffer，约 75% 窗口；预热取阈值前 8k token
    窄带，不与 auto compact 抢触发）。
  - pass1 用与真正压缩**相同**的 split/keep（`resolveCompactKeepOpts` 从
    runFullCompact 抽出共用）总结历史前缀；结果落 `session.precompact`
    （count + 前缀指纹 + summaryText）。
  - fire-and-forget（不阻塞主线程）；压缩开始时清空状态，晚到结果经
    commit 引用检查丢弃；压缩时用「前 N 条指纹」验证预热仍覆盖旧前缀，
    不匹配回退全量（功能正确，仅预热失效）；预热失败静默，下次再触发。
- 压缩合并：预热有效 → `buildPrecompactMessages` 产出
  `[合成 summary user 消息] + 新增消息` 短链喂 runFullCompact——
  summarizer 只吃新增（合成消息命中 isCompactSummaryMessage → 自动注入
  COMPACT_MERGE_PRIOR_SUMMARY_HINT 合并提示）。
- 触发点：`tryMidTurnCompact` 未达标分支（每轮查询循环检查）；
  `session.precompactEnabled === false` 可关。

**验收**（全部通过）：专项覆盖阈值带、预热启动/跳过、commit 引用检查
（晚到结果不覆盖新状态）、buildPrecompactMessages 命中/未命中/前缀篡改、
compactSession 集成（预热后压缩 summarizer 只吃新增 ≤15 条 vs 全量 96）、
预热失败静默、开关关闭；compact/auto-compact/write-failure/usage-anchor/
autocompact-system-tokens 回归及完整 `npm test` 通过。

## 13. MEM-2 · 记忆检索质量链 — 低成本（依赖 MEM-1）✅ 本轮

**目标**：检索排序加入时间衰减（会话来源按半衰期衰减、项目/全局免衰减）、
空/脚手架 chunk 过滤、源权重与访问频率 boost、多样性重排。

**设计**（已落地；全部纯函数、可配置常量、无外部依赖）：
- **时间衰减**：user 层 topic 按半衰期衰减（`MEMORY_HALF_LIFE_DAYS = 30`，
  每 30 天权重减半）；project 层免衰减（项目事实长期有效）。
- **空/脚手架过滤**：`scanMemoryTopics` 记录 `hasBody`（frontmatter 后
  无正文 → false；无 frontmatter 保守视为有正文），select 阶段过滤。
- **description 缺失降权**：无 description 的 topic 扣 2 分（脚手架感降排）。
- **多样性重排**：标题/文件名 token Jaccard 相似（`.md` 后缀与下划线归一）
  超过 `MEMORY_DIVERSITY_SIMILARITY = 0.5` 的重复内容只保留最高分者。
- **源权重**：既有 project +1 boost 保留（source 权重项）。
- 访问频率 boost 无数据源（无访问计数），文档注明为后续项。
- FTS 索引仍为 MEM-2 后置（现有词频相关性 + 质量链已可用）。

**验收**（全部通过）：专项覆盖新旧记忆排序（半衰期减半验证）、project
免衰减、空/脚手架过滤（含真实文件系统 scan 集成）、description 缺失降权、
相似内容去重保留高分者；test-memory（存量相关性断言）与 system-prompt
回归兼容；完整 `npm test` 通过。

## 14. TERM-3 · 滚轮滚动规范化 — 低–中成本（依赖 OUT-4 鼠标）✅ 本轮

**目标**：鼠标滚轮事件规范化：wheel/trackpad 启发式、分数累积、16ms cadence、
加速度分带，避免逐格滚动抖动与事件风暴。

**设计**（已落地）：
- shared `wheelNormalizer.ts` 纯状态机：SGR 1006 每序列仅 1 格——规范化为
  **增量滚动行数**；16ms cadence 帧合并（同帧密集事件合并为一帧量，
  抑制 trackpad 事件风暴）+ 加速度分带（帧内 1-2 事件 1×、3-4 事件 2×、
  5+ 事件 3×，快速滚动自然加速）+ 帧事件上限（`WHEEL_MAX_EVENTS_PER_FRAME=6`
  单帧封顶）+ 方向变化开新帧（反向滚动立即生效不丢首格）。
- 接入：retainedTui 鼠标监听 wheel 分支 → normalizer → `overlay.scrollPager`
  （正数向下/负数向上；滚轮停在边界不触发键盘的 quit 语义）；无 active
  pager 时 wheel 被消费不泄漏为输入。
- 每次 push 返回**增量**（消费者累加即得帧量）；时间戳可注入（测试用）。

**验收**（全部通过）：专项覆盖逐格滚动（间隔 > 帧窗口每事件 1 格）、
16ms 帧合并与分带增量（4 事件帧 = 8 格）、高速带封顶（6 事件 × 3× =
18 格）、方向反转开新帧、flush 后新帧；TUI 集成（真实 headless TUI）：
点击打开 pager → 密集 wheel down 翻页 → wheel up 翻回 → 关闭后 wheel
不泄漏不重开；OUT-4 鼠标回归兼容；完整 `npm test` 通过。真人手感仍属
OI-H3（参数可调）。

## 15. CBG-1 · 符号索引懒启动 + 门控 — 低–中成本 ✅ 本轮

**目标**：仓库符号索引（定义/引用）按需懒构建，仅 git 仓库 + 显式请求时激活；
缓存放用户目录不污染项目；查询版本戳驱动自动重建。最简版先交付 `/symbol` 命令
（纯正则扫描，不依赖 LSP/ripgrep——零运行时依赖）。

**设计**（已落地）：
- `packages/core/src/symbolIndex.ts`：懒构建符号索引——源文件扩展名白名单
  （ts/js/rs/go/py/java/cs/cpp/kt/swift 等）+ 目录黑名单（node_modules/
  .git/dist/build/target 等）+ 行级定义正则（多语言：export function/
  class/interface/type/const、pub fn/struct/enum、func、def/class、Java/C#
  class 等）→ `{ name, kind, file, line }` 符号表。
- **四道门控**：git 仓库（.git 目录/文件检测）、`BOLO_DISABLE_SYMBOLS` 开关、
  显式请求（仅 `/symbol` 触发——懒启动）、能力（本地文件可读）。
- **缓存**：`~/.bolo/indexes/<repoKey>.json`（BOLO_CONFIG_DIR 可重定向）；
  版本戳 = HEAD commit（12 位）+ 最新源文件 mtime——源文件变化自动重建。
- **并发锁**：`<cache>.lock`（内容 = 写锁时刻时间戳）；新鲜锁拒绝并发构建
  （查询返回「构建中」提示）、陈旧锁（>30s）强制清理。
- `/symbol <query>` slash 命令：名称包含匹配（大小写不敏感），输出
  `file:line kind name` 列表；不注入模型上下文（命令专用）。

**验收**（全部通过）：专项覆盖懒启动（无调用不建缓存）、门控（开关/git
检测）、多语言定义提取（ts/rs/go/py 全量）、缓存命中与版本戳重建（源文件
修改 → 重建）、并发锁（新鲜拒绝/陈旧清理）、`/symbol` 命令（命中/无匹配/
非 git/开关关闭）；slash 相关回归兼容；完整 `npm test` 通过。

**边界**：引用索引（refs）与 LSP 能力为后续项（当前为定义索引 + 名称匹配）；
超 1MB 文件与 5000 文件上限跳过（有界扫描）。

## 16. CMP-3 · 压缩 Segments 可检索模式 — 中成本 ✅ 本轮

**目标**：压缩产物可选「摘要 + 逐段 markdown 存储」：段文件落盘（有界大小），
模型通过 read_file/grep 可检索细节，而非只依赖摘要。

**设计**（已落地）：
- compact 包：`splitMessagesIntoSegments`（turn 原子块切分 + 文本化——
  `**user**`/`**assistant**`/`**tool** (name)` 标注；段消息数 ≤
  `SEGMENT_MAX_MESSAGES=25`，超限在 turn 边界切段，turn 原子性优先可略超）；
  `runFullCompact` 选项 `segments?: boolean`——true 时 `CompactionResult.segments`
  携带 toSummarize 前缀的段文本（摘要生成不变；缺省 false → undefined，
  **默认模式零行为变化**）。
- core：`session.compactSegments`（默认关）——compactSession 传 segments；
  成功后段文件落盘 `<sessionsDir>/<sessionId>/segments/<ts>.segments.md`
  （原子写）+ `index.md` 索引（段文件清单 + 摘要字符数）同批写入；
  摘要消息追加 `[compact segments]` 指针（路径 + 段数 + read_file/grep 提示，
  同对象引用同步进 session.messages）；fail-open（无 sessionsDir → warning
  且摘要保持；写盘失败 → warning 不回滚压缩）。
- **检索链路**：模型用既有 read_file/grep 检索段文件细节（零新代码）。

**验收**（全部通过）：专项覆盖段切分（合并/上限/turn 原子/空输入）、
runFullCompact 开关（on → segments / off → undefined）、compactSession 集成
（段文件 + index + 指针 + 可检索重读）、默认关闭无文件无指针、fail-open
（无 sessionsDir warning 且摘要保持）；compact/auto-compact/write-failure
回归兼容；完整 `npm test` 通过。

**边界**：段文件为压缩前缀的文本转录（含工具输出原文——权限由会话
transcript 同级保护）；LSP 检索与段级语义索引为后续项。

## 17. REN-2 · checkpoint 流式渲染 — 中成本 ✅ 本轮

**目标**：长消息/长 transcript 渲染按帧预算分片，不冻结事件循环；渲染期间
新事件可继续入队。

**设计**（已落地）：
- RetainedTranscript 分片渲染：`renderAllBlocks` 按**渲染单元预算**
  （`renderBlockBudget=16`/帧）渲染新块并缓存行（`unitCache`）；超出预算
  → 标记 `renderIncomplete` + 输出截断尾注（`… rendering…`）；进度
  （`renderProgress`）记录已渲染单元数——续帧从进度继续，已渲染块复用
  缓存行（每帧只重渲染预算内新块）。
- **续帧驱动**：controller flush 内 `while (renderIncomplete)` 循环——
  每帧 `setImmediate` 让路（输入事件优先处理）后继续渲染直到完成——
  **flush 语义保持**（返回 = 渲染完整；调用方/测试不感知分片）。
- **内容变化**：setState 重建 renderUnits（新引用）→ 缓存自动失效 → 进度
  重置从头渲染；**宽度变化** → 缓存清空 + 进度重置（全量重渲，含 tailWindow
  切换）。
- 尾窗口模式（大 transcript 行预算）不受影响（其自身有界）。

**验收**（全部通过）：专项覆盖小内容一次完成（无尾注）、40 块分片 flush
返回完整（最后块可见）、20 块最终一致（无尾注 + 全块可见）、resize 全量
（宽度变化后最终一致）、输入可达（分片期间输入不丢）；TUI 回归兼容
（retained/cleanup/transcript/mouse/folding/reliability——reliability 的
burst 合并断言适配为「有界渲染帧」：burst 不随事件数增长，大 transcript
分片产生固定续帧数）；完整 `npm test` 通过。

**边界**：分片预算按单元数（16/帧）而非墙钟——纯字符串渲染成本稳定，
单元数预算可测且可注入；真人手感与超大（数千块）transcript 的帧数上限
属 OI-H3（参数可调）。

## 18. REN-3 · 子进程隔离渲染不可信内容 — 中成本 ✅ 本轮

**目标**：渲染模型输出的不可信内容（如图表 DSL）时，用独立子进程 + 墙钟超时
隔离崩溃，主进程不因渲染 panic 退出。

**设计**（已落地）：
- `packages/cli/src/renderWorker.ts`：
  - **worker 主逻辑**（`runRenderWorker`）：stdin 单行 JSON 请求
    `{text, mode: terminal|markdown, width}` → 渲染（wrapTerminalText）→
    stdout 单行 JSON `{ok, lines}` / `{ok:false, error}`；输入 2MB 上限
    （防恶意超大输入拖垮 worker）；渲染 try/catch（渲染器异常 → ok:false
    不崩 worker）。
  - **主进程调用方**（`renderTextInWorker`）：spawn worker → 墙钟超时
    （2s 默认）→ 直接 SIGKILL（worker 为渲染进程无清理状态，不可捕获
    立即回收）→ 降级（ok:false + timed out/exited 信息）；EPIPE/EOF
    无害化；失败/超时主进程不崩。
  - **轻量独立入口**（`renderWorkerCli.ts`——不加载 main.ts 全树，
    dev 下 tsx 冷启动 ~200ms）；main.ts 加 `render-worker` 子命令分支
    （dist 单文件同样可执行）。
- **隔离语义**：worker 崩溃/挂起/渲染异常均不影响主进程（进程级隔离）；
  成功路径渲染结果与主进程 wrapTerminalText 一致（测试断言）。
- **接入**：基础设施先行——`renderTextInWorker` 公开 API + 显式调用点
  （大/高风险内容渲染由未来 DSL 渲染器接入）；当前渲染（纯字符串）仍
  主进程（零回归），worker 作为防御性隔离层。

**验收**（全部通过）：专项覆盖正常渲染（与主进程 wrapTerminalText 逐行
一致）、恶意输入（50KB 长文本/ANSI 转义/控制序列不崩且内容保留）、超时
kill（假 sleep worker 300ms 超时 → 回收 + 降级消息）、worker 非零退出
（→ 降级 + 退出码说明）、输入过大拒绝（2.5MB → too large）；CLI 回归
兼容；完整 `npm test` 通过（含 dist build——render-worker 分支进单文件）。

**边界**：markdown 模式当前为纯文本降级（与主进程简易 markdown 等价）；
未来原生 DSL 渲染器（图表等）接入 worker 协议即可复用隔离；子进程成本
（~200ms dev / 快 dist）仅显式调用时产生（高频路径不 worker 化）。

## 19. EVT-1 · 文件事件总线分层 — 中成本

**目标**：把 OS 文件事件规范化为语义事件（文件变更/git 变更/操作完成），单源
广播给多个订阅者（TUI 刷新、索引、变更跟踪），避免各功能各自 watch 与事件风暴。

**设计**：新 events 模块：单 watcher + 事件合并（path last-writer-wins）+ 语义化
（git 目录过滤、操作完成延迟上报）；订阅者注册/退订。

**验收**：事件合并/过滤/扇出/退订；TUI 与索引两个消费方接入。

## 20. WT-1 · worktree 快照/GC/池化 — 高成本

**目标**：会话/子代理 worktree 隔离增强：快照为 git ref（可整树回滚/重水合）、
自动 GC 按年龄清理、预创建池；元数据库展示。

**设计**：worktree 模块扩展（复用现有 git worktree 能力）；GC 策略配置；
快照 ref 命名与清理规则；失败保留现场。

**验收**：快照/回滚/GC/池化/展示；既有 worktree-safety 回归。

## 21. HKP-4 · 变更归因（agent vs 外部）— 高成本

**目标**：文件变更行级归因：区分「agent 自己改的」与「外部工具/进程改的」，
用于 diff 审查与回滚提示。

**设计**：文件事件 + 写路径记录交叉比对；先做文件级「external change」标记，
行级归因后置；证据门控：有真实误判案例再深化。

**验收**：外部变更标记、误报率门禁、与 /diff 集成。

---

## 实施规则

1. 一次一个最小切片；先写失败测试再实现；新测试同时注册独立 npm script 与默认
   `npm test`。
2. packages-first：先 shared/core 契约，再接 CLI/Desktop。
3. 每项按「代码/测试批 + 文档批」两个中文提交推送。
4. 依赖项（MEM-2 依赖 MEM-1、TERM-3 依赖 OUT-4、CMP-3 默认关闭）在对应任务标注。
5. 真人观感（终端手感、渲染流畅度）不得用自动化冒充验收，仍归 OI-H3。
