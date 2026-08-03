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
| HKP-3 | plan 模式与权限系统正交化 | 低 | core 权限接线 | ▶ NEXT |
| REN-1 | markdown render-fidelity 自检 | 低 | markdown 渲染层 | 📋 |
| MEM-1 | 跨会话记忆 MVP（Markdown 双层 + FTS 检索 + 压缩前 flush + 首轮注入） | 低–中 | 新 memory 模块 + core 注入 | 📋 |
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
  惰性子命令（install/uninstall/update/upgrade/list/search/info/view/outdated/
  why/tree/audit/help/version 等；run/build/test/add/get/mod/init/create 等
  执行脚本/下载代码的一律询问）。
- toolExecution：auto 分支先于分类器做确定性判定——deny 直接拒绝（不调分类器、
  不执行）、allow 直接放行（跳过分类器，且**受 toolRequestedAsk 保护**：工具
  checkPermissions 显式 ask 时不被命令级 allow 覆盖）、ask 走原分类器/UI 路径；
  audit stage=command-safety、permission_decision 事件完整。

**验收**：专项覆盖 tokenizer（引号/转义/未闭合）、危险拒绝（13 例含 reason）、
白名单放行（10 例）、任意执行器与未覆盖命令询问、fail-closed、auto 接线
（classifier spy 断言 deny/allow 均不调分类器）；permissions/auto-permissions/
permission-panel/exit-plan-mode 回归与完整 `npm test` 通过。

## 9. HKP-3 · plan 模式与权限系统正交化 — 低成本

**目标**：plan 模式在任何权限模式下（含 bypassPermissions）都强制只读，
ExitPlanMode 批准后才恢复；plan 状态独立于权限模式声明。

**设计**：core 权限接线把 plan 作为正交开关，工具执行前检查「plan 且非只读 →
拒绝（可走 ExitPlanMode）」；不改变现有 permissionMode 语义。

**验收**：各权限模式 × plan 组合矩阵；ExitPlanMode 恢复；既有 AR-T3a 回归。

## 10. REN-1 · markdown render-fidelity 自检 — 低成本

**目标**：渲染层检测「意图做了结构（列表/表格/代码块）但实际没渲染出来」的
fidelity 失败，作为模型反馈信号（warning 注入或 /context 展示），不静默吞掉。

**设计**：markdown 渲染器输出结构化结构清单（检测到的块类型），与源文本意图
对比；不一致时产生 warning 事件。纯函数可单测。

**验收**：表格/列表/代码块各失败模式检测；正常渲染零误报。

## 11. MEM-1 · 跨会话记忆 MVP — 低–中成本（收益最高）

**目标**：本地跨会话记忆：项目级与用户级 Markdown 记忆文件（人可读可编辑）+
全文检索索引（FTS，向量为可选增强）；会话内总结 flush（压缩前/定时/手动触发），
会话首轮自动检索 top-N 注入系统消息（注入过则跳过，保护 prompt cache）。

**设计**：
- 新 `packages/memory`（或 core 子模块）：`MEMORY.md` 双层布局、
  Markdown 结构感知分块、FTS 索引（无外部服务）、检索排序（时间衰减/源权重）。
- 与既有 compact 衔接：压缩前 flush 最近消息总结（复用已有 LLM 调用）。
- 首轮注入：检索 top-N 拼 memory-context 块，一次性标志防重复注入。
- 全部本地；索引失败降级为「直接读 MEMORY.md 全文注入」。

**验收**：写入/总结/检索/注入/降级/外部编辑同步（watcher 标脏）；resume 与
子代理继承；跨会话可用性。

## 12. CMP-2 · 两遍预压缩（prefire pass1）— 中成本

**目标**：接近压缩阈值时后台先总结历史前缀（pass1 预热），真正压缩时只做增量
第二遍，缩短压缩停顿。

**设计**：compact 执行器增加预压缩状态机：阈值 80% 触发 pass1（低优先级、可取消），
到阈值时若有 pass1 结果直接做第二遍合并；并发安全（压缩期间新消息不丢）。

**验收**：预压缩命中/未命中/取消/并发各场景；完整门禁。

## 13. MEM-2 · 记忆检索质量链 — 低成本（依赖 MEM-1）

**目标**：检索排序加入时间衰减（会话来源按半衰期衰减、项目/全局免衰减）、
空/脚手架 chunk 过滤、源权重与访问频率 boost、多样性重排。

**设计**：纯函数排序链（无外部依赖），阈值与权重可配置；MEM-1 的 FTS 结果接入。

**验收**：排序质量场景（新旧记忆、脚手架污染、重复内容）。

## 14. TERM-3 · 滚轮滚动规范化 — 低–中成本（依赖 OUT-4 鼠标）

**目标**：鼠标滚轮事件规范化：wheel/trackpad 启发式、分数累积、16ms cadence、
加速度分带，避免逐格滚动抖动与事件风暴。

**设计**：在 OUT-4 的 SGR mouse 解析后加滚轮累积器（纯函数）；pager 翻页消费。

**验收**：模拟滚轮序列断言翻页节奏与去抖；真人手感仍属 OI-H3。

## 15. CBG-1 · 符号索引懒启动 + 门控 — 低–中成本

**目标**：仓库符号索引（定义/引用）按需懒构建，仅 git 仓库 + 显式请求时激活；
缓存放用户目录不污染项目；查询版本戳驱动自动重建。最简版先交付 `/symbol` 命令
（读现有索引或走 LSP/grep 兜底）。

**设计**：新 index 模块（worker 队列 + 事件合并 + 锁文件防并发重建）；
四道门控（git 仓库/开关/显式请求/能力）；缓存目录 `~/.bolo/indexes/`。

**验收**：懒启动、门控、重建、并发锁、兜底路径；不注入模型上下文（编辑器/命令
专用）。

## 16. CMP-3 · 压缩 Segments 可检索模式 — 中成本

**目标**：压缩产物可选「摘要 + 逐段 markdown 存储」：段文件落盘（有界大小），
模型通过 read_file/grep 可检索细节，而非只依赖摘要。

**设计**：compact 增加 `mode: summary | segments`（默认 summary 不变）；
segments 段文件按原子块切分、索引文件与摘要同批写入；模型消息只加指针提示；
证据门控：默认关闭，配置显式开启。

**验收**：段存储/指针/检索链路；默认模式零行为变化。

## 17. REN-2 · checkpoint 流式渲染 — 中成本

**目标**：长消息/长 transcript 渲染按帧预算（如 8ms）分时间片切片，不冻结事件
循环；渲染期间新事件可继续入队。

**设计**：retained renderer 增加分片渲染调度（一次 render 只处理预算内的行，
剩余排入下帧）；resize 时强制全量。

**验收**：超长内容渲染不阻塞输入；渲染完整性（最终帧一致）。

## 18. REN-3 · 子进程隔离渲染不可信内容 — 中成本

**目标**：渲染模型输出的不可信内容（如图表 DSL）时，用独立子进程 + 墙钟超时
隔离崩溃，主进程不因渲染 panic 退出。

**设计**：渲染 worker 子命令（self re-exec）+ 超时 kill + 结果回传；
失败时显示明确降级提示。

**验收**：恶意/损坏输入不崩主进程；超时回收；成功路径零回归。

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
