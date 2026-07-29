# 开放问题清单

> 首次盘点锚点：`a17e840`（2026-07-27）；OI-14 补充锚点：
> `c2e6a98`（2026-07-28）；OI-14A 关闭锚点：`f04f8de`，OI-14B 关闭锚点：
> `269b39c`；OI-14C 关闭锚点：`1798a7c`，OI-14D 关闭锚点：
> `8b060e5`，OI-14E 关闭锚点：`d0fb822`（2026-07-28），OI-14F 关闭锚点：
> `31384d4`，OI-14G 关闭锚点：`accc22c`，OI-14H 代码关闭锚点：
> `d4eaed0`（2026-07-29）；OI-15 准入锚点：`85c5c48`（2026-07-29）。
> OI-15A core display policy 关闭锚点：`d681734`（2026-07-29）。
> OI-15B retained single-slot 关闭锚点：`d6bd087`（2026-07-29）。
> OI-15C read-only panel/pager migration 关闭锚点：`26f796f`（2026-07-29）。
> 本文只列当前仓库中有代码、测试、实测或互相矛盾文档支撑的问题。
> 历史 TODO、已关闭的候选和仅凭印象提出的功能不算开放问题。

## 0. 使用规则

- 每条问题必须有可复核证据和明确关闭条件。
- 状态只用：`OPEN`、`IN PROGRESS`、`BLOCKED: EXTERNAL`、
  `BLOCKED: HUMAN`、`CLOSED`。
- `BLOCKED` 不是“还没做”：它表示自动化无法替代外部端点或真人行为。
- 修复代码时先改 `packages/*` 契约和测试，再接 CLI/Desktop。
- 代码/测试与文档分批提交；文档同步完成前问题不算关闭。

## 1. Agent 可直接解决

当前默认 agent 可闭环队列为 **OI-15D → OI-15F**。OI-14 只剩明确的 OI-H3
真人走查；OI-09–OI-13 的局部关闭不再作为“整个 TUI renderer 已稳定”的证据。

### OI-15 · slash 命令临时结果与 Composer 空间治理

**状态：IN PROGRESS（OI-15A–C 已关闭；OI-15D 下一刀）**

完整方案：[CLI_TUI_REFACTOR_PLAN.md](./CLI_TUI_REFACTOR_PLAN.md) §14

准入证据：

- 真人走查确认 `/context`、`/skills`、`/plugins`、`/doctor` 等命令结果不会消失；
  重复执行会持续占用 Composer 上方空间，最终把可见屏幕挤满。
- 准入时 `SlashDispatchResult` 只有 `ok`、`message` 和少数
  `contextView`/`interactive*` payload，没有 surface、replacement key、TTL、
  dismiss、overflow 或 persistence policy。OI-15A 已在 core 补齐该契约，OI-15B
  已接入 retained 单槽 primitive。OI-15C 又迁移了 `/context`、`/doctor`、`/status`
  与只读 panel/pager consumer；当前剩余症状集中在 Skills/Plugins、toast/history
  与最终 compatibility cleanup。
- 准入时，`runOnePrompt()` 会把 slash 输入作为 typed user block 回显，所有普通
  slash 输出也会经 `writeSlashOutput()` 进入
  `RetainedRoot.appendCompatibilityOutput()`。该方法把文本持续拼入最多 65,536
  字符的单一 `Text` component；根布局把它固定在 transcript 与 activity/composer
  之间，没有任何 replace 或 clear action。OI-15C 已让迁移的只读命令绕开该路径，
  OI-15D–F 继续迁移剩余命令并删除 normal slash 的兼容入口。
- Pi 证明 keyed widget/status/overlay 应分通道；Codex 的 Plugins view 用稳定 ID
  原位替换 loading/result 并忽略迟到请求；OpenCode 的单 toast/dialog 不进入
  transcript；HC 的 notification queue 提供 TTL/key/priority/timer 清理。
  oh-my-pi 的 `/context` 虽是 typed panel，仍追加到 chatContainer，反证“只换样式”
  不能解决生命周期。
- HelsincyCode 当前普通 `/context` 也会进入 messages；用户观察到的“位于输入框
  下方并消失”可能含 viewport 行为。Bolo 不依赖这种隐式效果，必须用显式 state 和
  persistence policy 保证结果确实被替换/删除。

架构决定：

```text
packages/core SlashDisplayPolicy
  -> history | panel | toast | overlay
  -> retained commandSurface 单槽 state + generation
  -> Composer 下方 panel / footer toast / OverlayHost
  -> plain/non-TTY 继续使用 message
```

- `panel` 是 Composer 下方、footer 上方的单 replaceable slot，最多 10 行且不超过
  可用 rows 的 40%；新输入、`Esc`、session reset 或命令 TTL 清除。
- `toast` 是 footer 单行短反馈，默认 5 秒；新 toast 替换旧项并取消旧 timer。
- `overlay` 复用现有 OverlayHost，按 stable key replace，关闭后恢复 Composer
  value/cursor/focus。
- `history` 只留给显式需要审计的动作或不可恢复错误；`ok: false` 不自动永久追加。
- transient 永不进入模型消息、JSONL、compact 或 resume。slash 命令的灰色输入块
  可保留在视觉 transcript，但命令结果不再进入无界 compatibility bucket。
- `/context` 使用 12 秒 compact panel，`/context details` 使用 pager；`/skills`
  和 `/plugins` 使用 picker/pager；`/doctor` 使用有界摘要并在超长时升级 pager。

执行切片：

| 切片 | packages-first 交付 | 关闭证据 | 状态 |
|------|---------------------|----------|------|
| **OI-15A · display policy** | core discriminated union、默认策略、命令分类、红灯 | exhaustive/fail-closed；plain message byte-stable；测试进入独立 script + 默认门禁 | **CLOSED · `d681734`** |
| **OI-15B · single-slot state** | panel/toast reducer、generation、effect timer、Composer 下方组件 | 连续 20 次 replace 高度不增长；TTL/replace/timer race/resize/input/Esc/restore/stop | **CLOSED · `d6bd087`** |
| **OI-15C · context/doctor/status** | context compact/details、doctor/只读诊断映射 | footer/panel/pager 分层；20× replace；single/multi-page/resize；transient 不进 compatibility/plain writer/session messages | **CLOSED · `26f796f`** |
| **OI-15D · Skills/Plugins overlay** | picker/pager、loading→result replace、stale async guard | session/cwd/request 变化忽略迟到结果；focus/value/cursor 恢复 | OPEN |
| **OI-15E · toast/error policy** | action feedback、tone/priority、显式 durable error | 新 toast 取消旧 timer；短反馈不改变 transcript 高度 | OPEN |
| **OI-15F · compatibility cleanup** | normal slash 禁止 `appendCompatibilityOutput`；迁移旧 `interactive*` | VT/plain/JSON/full test/dist/pack/install/owner guard 全绿 | OPEN |

关闭条件：

1. 20 次重复 `/context`、`/skills`、`/plugins`、`/doctor` 不增加 Composer 上方
   retained 内容高度，且新输入/`Esc`/TTL 后真实 state 中不存在旧 panel。
2. panel 在 Composer 下方且高度有界；长内容走 pager，不截断成不可操作文本。
3. timer 与异步结果都由 `key + generation` 防止清错/覆盖当前视图。
4. dynamic TTY 保持单 stdin/writer/layout owner；plain/JSON 字节兼容。
5. normal slash 输出不再使用 compatibility bucket；transient 不进入持久化。
6. 定向、typecheck、完整 `npm test`、dist/pack/install 与 OI-H3 邻接场景通过；
   代码/测试和文档分批中文 commit/push。

### OI-14 · CLI TUI retained renderer 重构

**状态：BLOCKED: HUMAN（OI-14A–H 自动实现已关闭，只剩 OI-H3）**

完整方案：[CLI_TUI_REFACTOR_PLAN.md](./CLI_TUI_REFACTOR_PLAN.md) ·
OI-14A 实测决定：[CLI_TUI_RENDERER_DECISION.md](./CLI_TUI_RENDERER_DECISION.md)

准入证据：

- 2026-07-28 的后续真实 Windows Terminal 截图显示，Agent 正文会被拆成几个字一行，
  片段落在不同列，段间出现数十行空洞；同一段首行有 gutter，终端自动折出的续行却
  回到第 0 列。用户灰色块与 Agent/Thought 区域也仍缺少明确 section gap。
- 当前链路是 `createSessionEventPrinter` → tiny inline Markdown →
  `createTuiContentPrefixer` → `TerminalSurface/stdout`。prefixer 只识别逻辑换行；
  surface 只记录逻辑行数和 line-start 布尔值，不记录物理 column、终端 auto-wrap
  行数或 resize reflow。
- 当前 `TestTerminalScreen` 没有 cols/rows、auto-wrap、双宽 cell 或 resize；
  `answer chunk` 一类短行全绿不能证明长 URL/ANSI/Markdown 在真实终端正确。
- idle editor、running dock、activity、permission、picker 和 diff panel 分别拥有
  cursor/erase 生命周期。provider chunk 直接写 stdout，导致业务 event 与布局副作用
  耦合；继续补 spacer/prefix/cursor 分支无法建立唯一几何真源。
- Pi 的 MIT TUI 提供 `Component.render(width): string[]`、differential renderer、
  block Markdown、ANSI/OSC 8/CJK/emoji wrap、Editor 与 VirtualTerminal 测试；
  语言和产品形态最接近 Bolo。oh-my-pi、Codex、OpenCode 分别提供可靠性、验收与
  retained layout 对照。HelsincyCode 是用户自有私有仓库，可作为内部功能实现与
  复用来源，但不得向公开产物泄露私有源码、路径、品牌或未授权第三方内容。

架构决定：

```text
SessionEvent
  -> packages/shared CliTuiViewState 纯 reducer
  -> Bolo retained component tree
  -> width-aware physical lines
  -> 唯一 differential terminal writer
```

已选定 `@earendil-works/pi-tui@0.82.1` direct build-time dependency，Bolo
最低 Node 同步提升为 `>=22.19.0`。OI-14C/D 已复用 Pi renderer/Markdown 并保留
Bolo terminal adapter；OI-14E 复用 Pi keys、`StdinBuffer` 与光标协议，但因 Pi Editor
私有 autocomplete/render 无法保持 Bolo 全宽框、ghost hint 与 footer，最终采用
Bolo-owned `RetainedComposer`，不分发 `ProcessTerminal` 的动态 native helper。
Pi 路线没有实质失败，因此不启动 OpenTUI spike，也不维护 Node 20 fork。
禁止继续扩展当时的 `TerminalSurface + contentPrefixer + tiny Markdown`；H 已删除。

OI-14A 关闭证据：

- `@xterm/headless@5.5.0` 稳定捕获
  `wrapped-continuation-lost-gutter`、`dock-column-drift`、
  `chunk-boundary-changes-screen`、`resize-breaks-composer`。
- candidate 在 Windows Node 24 和真实 Node 20.18.3 均可运行；上游支持线仍是
  Node `>=22.19.0`，因此产品不宣称支持已 EOL 的 Node 20。
- candidate 单文件约 179 KB，当前 Bolo baseline 1,385,065 bytes；冷启动 p50
  145.8 ms，无遥测/联网/常态 `~/.pi` 副作用。
- 测试 `1ae9f53`、依赖与 Node 基线 `f04f8de` 均已独立提交并 push。

OI-14B 关闭证据：

- `packages/shared/src/cliTuiViewState.ts` 建立无 I/O 的有序 turn/block 状态、
  deterministic turn/segment id、composer/overlay mode 与 `set_block_elapsed` action；
  reducer 不 import Node I/O、Pi、terminal 或 legacy renderer。
- `CliTuiSessionEvent` 编译期兼容 core `SessionEvent`、`QueryLoopEvent` 与
  `ToolExecutionEvent`；assistant/reasoning 按 open segment 合并，tool 按 call id
  原位更新，hosted search citation 按 URL 去重。
- resume 通过同一 `begin_turn` / `session_event` / `end_turn` reducer replay；
  显式空 tool output、缺失 result 与 `<tool_use_error>` 分别恢复为
  complete、interrupted 与 error，不伪造 reasoning。
- `test-cli-tui-view-state.ts` 覆盖整段、逐字符、固定随机 chunk 深相等，以及
  segment/tool/search/error/abort/resume/composer/overlay；专项、typecheck 和两轮
  125 脚本完整 `npm test` 均通过，dist build/install 与 Electron launch 全绿。
- 代码 `269b39c` 已独立提交并 push；本切片没有接 terminal 或改变可见 legacy TUI。

OI-14C 关闭证据：

- `1798a7c` 建立 Bolo terminal adapter、稳定 retained root、theme/viewport/resize、
  水晶 welcome 与 session 级 `BOLO_TUI_ENGINE` 路由；renderer 直接消费 OI-14B
  `CliTuiViewState`，没有重建 event/tool/search/resume 状态机。
- retained 会话只有 adapter 写原始 stdout/cursor；Pi `CSI 3J` 被过滤，resize 保留
  scrollback；permission/question/slash/idle input 通过可 await suspend/resume 暂时
  交还 writer，结束后恢复同一 root。
- 24/38/56/80/120/160/220 列、resize、root identity、single-writer、plain byte
  snapshot、new/resume、dist clean install、Desktop bundle/Electron launch 与 126
  脚本完整门禁全绿；`dependencies` 仍为 `{}`，最终 bundle 1,518,187 bytes。
- retained 在 OI-14G 前仍只通过 `BOLO_TUI_ENGINE=retained` 显式启用；缺省、非法值、
  non-TTY 与 `--print` 均保持 legacy。本切片没有迁 transcript Markdown、Composer
  或 overlays，因此没有声称默认可见缺陷已修复。

OI-14D 关闭证据：

- `8b060e5` 新增 `retainedTranscript.ts`，按 OI-14B stable block id 缓存组件，
  assistant/reasoning/user/summary Markdown 通过 `setText()` 原位更新；tool/search/
  error/warning 从同一 view-state 做只读投影，没有第二套 event 状态机。
- transcript 父级先从 terminal width 扣 gutter，再给 Markdown 生成的每一条物理行
  加回 gutter，并统一插入 section gap；用户历史块在彩色主题下拥有整宽灰底。
- `test-cli-tui-transcript.ts` 先在 user transcript 不可见处红灯，转绿后覆盖 whole/
  character/fixed-random chunk、stable component identity、24/31/32/47/48/80/120/
  160/220 列、resize、resume、list/nested list/blockquote/code/table、URL、CJK/
  emoji、ANSI/OSC 8、Thought duration、tool/search/error/warning/summary 与 burst 合并。
- retained `didStreamText()` 只在当前轮确有非空 assistant stream 时置真；reasoning-only
  继续保留最终回答 fallback。OI-14C/legacy/plain/panel 邻接轨未回退。
- 完整 127 脚本门禁、dist build、7-file clean install、Desktop bundle 与 Electron
  launch 全绿；bundle 为 1,611,976 bytes / 189 modules，`dependencies` 仍为 `{}`。
  `marked@18.0.5` 首次进入 bundle，许可已写入 `THIRD_PARTY_NOTICES.md`。
- 本刀没有迁 Composer/activity/footer 或 overlays，retained 仍显式 opt-in；默认
  legacy 的缺陷与交互区迁移不能借 D 的正文证据冒充关闭。

OI-14E 关闭证据：

- `d0fb822` 新增稳定 `RetainedComposer` 与 `RetainedActivity`；Composer 复用
  `createTuiInputState` / `applyTuiInputKey` / `renderTuiInputBox`，保留 slash、
  argument hint、history、undo 与 footer 投影。Pi 只提供 retained tree、focus、
  `CURSOR_MARKER`、keys、`StdinBuffer` 与 differential writer。
- adapter 由 new/resume composition root 显式注入唯一 stdin；raw mode、mode 2004、
  data listener 与跨 chunk paste 具有同一 acquire/release 生命周期。预先 abort 不会
  获取 stdin，`setRawMode(true)` 抛错会销毁 staged buffer/listener 并保留原始错误；
  legacy panel suspend 后可恢复同一 pending value/focus。
- shared `finish_thinking_segment` 让 visible/silent reasoning 共用一个完成态 Thought
  block；retained activity 复用既有分段状态机和 250ms 动画，只更新 child state，
  不直接写 stdout。根布局按 transcript/compatibility/activity/composer/footer
  排列，Composer/Footer 永远位于底部且最终回答保留完整 gap。
- `test:cli-tui-composer` 使用真实 xterm buffer 覆盖 idle/running 同一组件、首 token
  前输入框、slash/hint/history/undo、硬件光标、silent Thought、动画、usage/footer、
  24–220 列、resize、跨 chunk paste、输入 p95、500-char burst、abort/raw rollback
  与 single writer；new/resume 真实 REPL 另证明普通输入不经过 legacy writer。
- 完整 128 脚本门禁、dist build/install、Desktop bundle 与 Electron launch 全绿；
  bundle 为 1,641,896 bytes / 192 modules，`dependencies` 仍为 `{}`。产物只新增 Pi
  `keys.js`/`stdin-buffer.js`，Editor、ProcessTerminal、terminal/native loader 未进入。
- retained 仍由 `BOLO_TUI_ENGINE=retained` 显式 opt-in；permission/question/provider/
  effort/diff/pager 继续走可 await suspend bridge，默认切换与 legacy 删除不借 E
  冒充关闭。

OI-14F 关闭证据：

- `31384d4` 建立唯一 `RetainedOverlayHost`；permission、AskUserQuestion、
  provider/effort、diff browse/approve 与 runtime pager 都复用既有 reducer 和 typed
  result，没有复制权限、问答、picker、diff 或分页业务状态机。
- overlay 打开时同一 Composer 继续挂载；value/cursor/history/undo/focus 在提交、
  Esc、Ctrl+C 与 abort 后恢复。retained 交互全程由同一 adapter 持有 raw stdin 与
  terminal writer，没有 external/concurrent writer。
- 文件审批与 `/diff` 已进入 controller overlay；resume 补齐 CLI asker 绑定。显式
  retained runtime pager 复用 shared pager reducer，在小终端支持 PgUp/PgDn、方向键、
  Ctrl+C/Ctrl+D/abort，且不发送 legacy `ESC[2J`。
- OI-14F 关闭时，`suspendForLegacyPanel()` 只剩兼容 API/历史测试，生产 retained
  交互调用点为零；删除 API 与 legacy surface 当时明确留给 OI-14H。
- 真实 xterm、new/resume、abort/resize、dist build/install、Desktop bundle 与
  Electron launch 连同 129 脚本完整门禁全绿。bundle 为
  1,686,424 bytes / 199 modules，较 E 增加 44,528 bytes（约 2.7%）；
  `dependencies` 仍为 `{}`。
- OI-14F 关闭时 retained 仍只由 `BOLO_TUI_ENGINE=retained` 显式 opt-in；该切片没有切换默认，
  不能借 overlays 关闭证据冒充 OI-14G 的长会话、可靠性或性能验收。

OI-14G 关闭证据：

- `6f4764f` 将双 TTY/raw-mode 缺省切到 retained；显式 legacy 保留短期回滚，非法
  非空值 fail-safe 到 legacy，non-TTY、pipe、JSON 与 `--print` 永远保持 plain。
- `4eedb0e`、`7567572`、`a9328ec` 用真实 xterm 覆盖 500 blocks/10,000 行、
  scrollback、24–220 列反复 resize、stream/tool/search、running paste 与 overlay
  往返；最终 input p95 `0.1ms`、resize p95 `50.8ms`。
- `21525c4` 固化 turn final/error/permission immediate flush；`ed7c804` 与
  `6125f3e` 覆盖部分启动、stdin/renderer/provider/tool failure、Abort/SIGINT/raw
  Ctrl+C 和进程退出 cleanup，所有步骤均尝试且保留主体/首个原始错误。
- `accc22c` 新增 `test-cli-tui-budget.ts` 并把默认门禁顺序固定为 dist build →
  budget → clean install；单文件 1,727,232 bytes / 200 modules，cold 相对 empty
  Node `+50.4ms`、CPU `422ms`、render heap `+21.0MB`、cleanup retained `+1.5MB`。
- 133 脚本完整 `npm test`、7-file clean install、Desktop bundle、Electron launch、
  renderer mount、session switch 与 model/effort mutation 全绿；根 `dependencies`
  仍为 `{}`。真人 Windows Terminal 观感仍未验，不以自动门禁冒充。

OI-14H 自动关闭证据：

- `39e66b4`–`d4eaed0` 按 ownership → compatibility bridge/pager/picker → text fallback →
  local panels → surface/raw editor/layout/tiny Markdown → engine selector 的依赖顺序，
  分 12 个中文提交删除旧 dynamic TTY 实现并逐刀 push。
- 双 TTY/raw-mode 现在只由 `BoloTerminalAdapter` + retained root 持有 stdin/raw mode
  和 terminal writer；non-TTY、pipe、JSON、`--print`、readline/raw-mode 不可用回落
  与 shared permission/diff/pager view-model 独立保留。
- ownership/absence guard 禁止 production 重新引用 compatibility API、旧 raw driver、
  surface/prefix/tiny Markdown 或 engine env/resolver；构建后的 `dist/bolo.mjs` 也不含
  这些符号。
- 134 脚本完整 `npm test`、7-file tarball/install、Desktop bundle、Electron launch
  全绿；当前单文件为 1,692,863 bytes / 195 modules，三次完整串 cold
  `+46.8–84.4ms`、CPU `328–672ms`、render heap `+21.0–21.1MB`、
  cleanup retained `+1.5MB`。根 `dependencies` 仍为 `{}`，
  `THIRD_PARTY_NOTICES.md` 与 lockfile 版本一致。
- `e6ec6cb` 关闭真人复测暴露的 post-interrupt 输入竞态：SIGINT handler 未 settle
  前不重新获取 Composer stdin；完成后恢复 focus/raw input 并验证可继续编辑。
- `6b7ff99` 关闭同一真人场景暴露的真实控制台链：turn 期间不释放 raw stdin，
  避免 Windows `npm.cmd`/父 shell 抢占 Ctrl+C；Pi TUI 全局 listener 以 `Esc`
  为主键、`Ctrl+C` 为兼容键中断，overlay 保留自己的 Esc，主动 abort 不显示
  durable turn id 或 warning。离线慢流 retained PTY 连续两轮中断并恢复输入通过。
- 自动化可判断的删除、owner、布局、cursor、resize、cleanup 与发布缺陷已关闭。
  字体、颜色、动画主观流畅度和真人按键/鼠标手感仍诚实保留在 OI-H3。

| 切片 | packages-first 交付 | 人类可见结果 | 自动关闭条件 | 状态 |
|------|---------------------|--------------|--------------|------|
| **OI-14A · 真实 VT 红灯与选型** | `@xterm/headless` physical terminal harness；Pi direct/fork 与 OpenTUI 备选的 Node/esbuild/Windows/体积/许可报告 | 暂无产品改动；先准确复现碎片、空洞、续行贴左和 cursor 漂移 | 长 URL + ANSI + 随机 chunk + running composer 在旧代码稳定红；选型表有实测数据 | **CLOSED · `1ae9f53` / `f04f8de`** |
| **OI-14B · live view-state** | `packages/shared` action/reducer、stable block id、stream merge、segment/composer/overlay state | 暂无产品接线；为 retained transcript 原位更新提供唯一状态真源 | 纯 reducer、随机 chunk property、tool/reasoning/error/abort/resume 全绿 | **CLOSED · `269b39c`** |
| **OI-14C · retained 基座** | 单 terminal writer、根 component tree、theme/width/resize、welcome 与 feature flag | 所有区域使用同一 viewport 和 cursor owner | 24–220 列、resize、plain byte-stable、无超宽物理行 | **CLOSED · `1798a7c`** |
| **OI-14D · transcript/Markdown** | User/Assistant/Thought/Tool/Search/Error/Warning/Summary blocks；成熟 Markdown/wrap；父级 spacing | retained 正文不碎裂、不空洞，列表/URL/代码块续行一致，user/agent 有稳定间距 | 真实 VT、CJK/emoji、ANSI/OSC 8、list/table/code、chunk/resize/resume invariant | **CLOSED · `8b060e5`** |
| **OI-14E · Composer/Activity/Footer** | 常驻 Bolo Composer、slash/hint/paste、分段 activity、usage/footer | 思考时输入框不消失；动画、Thought、model/token/快捷键稳定 | idle/running 同节点、burst backpressure、输入延迟与间距 VT | **CLOSED · `d0fb822`** |
| **OI-14F · overlays** | permission/question/provider/effort/diff/pager 迁入 OverlayHost | 权限显示完整 command/cwd/参数并用 once/always/deny 选择 | 默认 deny、focus/Esc/Ctrl+C 恢复、无第二 stdout owner | **CLOSED · `31384d4`** |
| **OI-14G · 默认切换** | retained 默认、scroll/resize/backpressure/perf、dist/pack/install | 长回答、resize、paste 与滚动不再破坏屏幕 | 完整门禁、性能预算、单文件产物与邻接轨全绿 | **CLOSED · `6f4764f`–`accc22c`** |
| **OI-14H · 删除与文档** | 删除旧 surface/prefixer/tiny Markdown/兼容桥/engine selector；NOTICE 与文档收口 | 不再存在两套 TTY renderer | 静态 stdout/stdin owner 与物理缺失 guard + 134 scripts + dist/pack/install/Desktop/Electron | **CLOSED · `39e66b4`–`d4eaed0`** |

实施顺序与边界：

1. OI-14A–H 自动实现已关闭：真实失败/选型、纯状态层、retained 基座、
   transcript/Markdown、Composer/activity/footer、overlays、默认切换、可靠性/性能与
   legacy 删除均分开提交。
2. dynamic TTY 只有 retained composition；非 TTY plain formatter 永久独立保留。
   禁止重新引入 engine selector、第二 stdin/writer owner 或旧字符串布局补丁。
3. 每个代码切片均已独立中文提交并 push；本批只同步正式文档。
4. OI-H3 只保留自动化无法判断的字体、颜色、动画和真人按键/鼠标手感；已知物理布局、
   cursor、resize 与 cleanup 故障已由 OI-14G 自动门禁关闭。

### OI-13 · CLI TUI 垂直节奏与水晶工作台

**状态：CLOSED（代码 `fe2d39a`、`bf25077`、`2b9d008`、`4c4fb08`；2026-07-28 文档同步）**

> **关闭范围修正：** 本条只证明 silent Thought、显式 spacer 与 welcome 三个局部
> 切片。后续真实截图已证伪“整个正文/surface 布局稳定”，系统性修复见 OI-14。

准入证据：

- 当时最新的真实 Windows Terminal 截图中，Agent 正文结束后下一视觉行立即进入
  composer 的 `Message` 标题边框；`TerminalSurface.composite()` 在该提交前只生成
  `[activity?, ...dock.lines]`，history、activity 与 dock 之间没有由 surface
  拥有的固定 spacer。这是可由 VT 序列测试证明的结构缺陷，不是字体偏好。
- `bf25077` 只修复了 turn 内 running composer。后续真实 Windows Terminal 截图
  仍显示最终回答的下一行就是 idle `Message` 顶边框：`runRepl()` 在 turn 结束后
  `surface.clearDock()`，下一轮当时改由 `readTuiInput()` 独立绘制，绕过了 surface
  spacer。旧测试只匹配输出字符串中的换行，没有执行 owner 交接后的屏幕行。
- 文档承诺每段思考结束后留下 `Thought for <duration>`，但截图中完全没有。
  `finishReasoningSegment()` 已取得 activity elapsed，随后却在
  `reasoningPrefixDone === false` 时直接返回；provider 没有发送可见 reasoning
  delta、等待后直接进入正文的真实路径因此必然丢失 summary。现有测试只覆盖
  `reasoning → reasoning_end`，没有覆盖 silent-thinking。
- 欢迎页当前把水晶、居中字标/headline、两条全宽 divider、workspace/model/session
  和 hint 全部纵向堆叠；每行又 pad 到 frame 全宽，信息高而松散。Pi、oh-my-pi、
  OpenCode、Codex 与 HelsincyCode 的相关实现共同表明，启动面应让品牌资产与运行
  状态形成一个受宽度约束、可响应式回落的组合，而不是元数据报表。
- OI-11G 曾按当时约定禁止宽屏双列 welcome。用户最新指示已经更新该产品约定：
  允许借鉴 Claude Code 的信息层级，但必须保留 Bolo 水晶吉祥物。新实现可以使用
  Bolo 自有双列工作台；不得复制 Claude 的品牌文案、配色、图标或 action card。

| 切片 | packages-first 交付 | 人类可见结果 | 自动关闭条件 | 状态 |
|------|---------------------|--------------|--------------|------|
| **OI-13A · silent thought completion** | formatter 将“活动段已结束”与“是否收到可见 reasoning 文本”解耦；每段只消费一次 elapsed | provider 直接进入正文前仍留下 `Thought for 4.2s`，不会重复或显示整轮累计时间 | 假时钟覆盖 silent-thinking、显式 reasoning_end、text/tool/error/warning 边界、重复 finish 与 activity-off | CLOSED `fe2d39a` |
| **OI-13B · running surface breathing row** | `TerminalSurface` composite 在 activity 与 running dock 之间保留 spacer；行数、擦除和 cursor offset 同源 | Thinking/Running 与常驻 composer 之间有完整空行，局部重绘不漂移 | 无/有 activity、append stdout/stderr、suspend/resume、增长/缩短 dock 的 VT 序列；无整屏 clear | CLOSED `bf25077` |
| **OI-13B2 · idle/running shared gap** | `composerSpacing` 纯契约同时接入 `TerminalSurface` 与 `readTuiInput`，gap 与 cursor 一起进入 owned rows | 最终 Agent 回答与 idle `Message` 顶边框之间也固定保留一整行；输入重绘不累加，退出不擦历史 | 最小 VT screen 执行 running → answer → endTurn → clearDock → idle 首帧/重绘/cleanup，按实际 row 断言 0→1 空行 | CLOSED `2b9d008` |
| **OI-13C · crystal workbench** | cell-aware welcome renderer：宽屏水晶+状态双列，中/紧凑屏单列，`<38` 纯文本 | 欢迎页更紧凑，水晶、品牌、Ready、workspace/model/session/mode 层级清楚；与 composer 节奏协调 | 38/46/56/76/96/120/160/220 列、CJK/emoji/长路径、Unicode/ASCII、NO_COLOR/mascot-off、每行精确宽度 | CLOSED `4c4fb08` |
| **OI-13D · 验收与文档** | 新专项进入默认门禁；README/TUI/USAGE/ROADMAP/OPEN_ISSUES/handoff/RELEASE 同步 | 源码、dist 与用户说明口径一致，旧 welcome 和 Thought 承诺不再虚假 | 专项、typecheck、完整 `npm test`、pack/install 与 Desktop/Electron 邻接轨全绿 | CLOSED（本文档批） |

实施顺序：

1. OI-13A 先关闭可复现的数据面缺口，确保每次模型等待都有永久完成反馈。
2. OI-13B 先把 running 垂直间距纳入 surface 所有权；B2 再关闭 turn 结束后
   idle editor 接管时绕过 spacer 的真实回归。
3. OI-13C 在运行期表面稳定后重排欢迎页；修改旧“双列禁止”测试时同时建立
   Bolo 品牌、响应式和 exact-width 正向护栏。
4. OI-13D 最后同步全部文档。A/B/B2/C 各自独立中文提交并推送，文档批另提。

自动/真人关闭边界：

- 假时钟、字符串 golden、cell-width 与真实 row 的 VT 序列可以关闭 A/B/B2/C 的代码缺陷；
  自动化不得把这些测试冒充真实 Windows Terminal 的字体、颜色、动画流畅度或观感。
- OI-H3 继续保留真人字体/颜色、鼠标粘贴、resize、组合键和长滚动走查，但不再承载
  已知可自动复现的 Thought、spacer 或 welcome 结构缺陷。

关闭证据：

- OI-13A 的 `test-cli-thinking-segments` 新增 `beginTurn → 4.2s → direct text`
  红/绿路径；完成行只取决于已结束 thinking segment 的 elapsed，不取决于可见
  reasoning delta，后续 chunk/endTurn 不会重复。
- OI-13B 的 `test-cli-terminal-surface` 覆盖 idle 与 activity 两种 paint：
  running composite 自己拥有空行，现有行数、cursor offset 与局部 erase 因而同源。
- OI-13B2 同一专项加入最小 VT screen：旧代码红在 `answer=4, composer=5`；共享
  top-gap 接线后变为相差 2。输入重绘后仍恰好一个空行、只有一个 `Message` 顶边框；
  cleanup 清除 composer/gap 且保留 Agent 历史。
- OI-13C 的 `test-cli-crystal-identity` 覆盖 38/46/56/76/96/120/160/220 列、
  CJK/emoji、ASCII/NO_COLOR、mascot-off 与精确 cell width；宽屏工作台封顶
  100 cells，普通 content frame 仍是 160，dock 继续跟随终端。
- 每个代码批均先红后绿、独立中文提交并推送；四批均运行 typecheck 与完整
  `npm.cmd test`。完整门禁继续覆盖 dist build、真实 pack/install、Desktop bundle
  与 Electron launch；根 `dependencies` 保持 `{}`。

### OI-12 · CLI TUI 信息架构与多行输入稳定性

**状态：CLOSED（代码 `1696127`、`7f76093`、`15b37ed`、`40a5d41`、`8d2a7a5`；
2026-07-28 文档同步）**

准入证据：

- 真实终端对照显示，成熟 CLI 在精确 slash 命令后的首个空格继续显示参数提示；
  Bolo 的 `isSlashCompletionContext()` 遇到任意 whitespace 就关闭 menu，因此
  `/effort ` 无法发现当前 provider/model 真正可选的推理档位。
- Bolo `/context` 把 pressure、window、policy、system sections、skills、memory、
  cache 和 prepare order 全部拼成无层级的 key/value 文本，并由 `resumeCli.ts`
  直接从第 0 内容列输出。现有数据足够形成概览，但缺少结构化 view-model 与 TTY
  renderer；`usage: (none)` 又要求界面明确标识 actual/estimated，不能伪造精确值。
- Agent timeline 的 gutter 被写死为 2 cells，普通 slash 输出完全绕过 gutter；
  真实截图确认长文本仍贴近终端左壁，阅读层级弱于用户消息、工具与 composer。
- composer 已使用 `resolveTuiDockWidth()`，普通用户历史块却仍使用封顶 160 列的
  `resolveTuiFrameWidth()`；在 220 列终端中二者被测试固定为 218 vs 160，直接造成
  灰色用户块无法横向铺满。
- Node `readline.emitKeypressEvents()` 实测 bracketed paste 会产生
  `paste-start → 字符/CR/LF → paste-end`。Bolo 没有 paste 状态，Windows CRLF 中的
  `return(\r)` 会在第一行后触发 submit；其余字符继续逐个 clear/redraw，解释了多行
  粘贴后 viewport 异常下拉。Pi、OpenCode、HelsincyCode 与 Codex 都为 paste 建了
  marker/buffer 或 burst 契约；这里只借鉴状态机和测试方法，不复制 UI。
- 用户给出的第四张参考图确认目标层级：页面保留外边距，Agent/tool 时间线进一步
  内缩，而用户历史块与 composer 在内容区内占满宽度；Bolo 使用自己的水晶与 theme，
  不复制参考产品品牌版式。

| 切片 | packages-first 交付 | 人类可见结果 | 自动关闭条件 | 状态 |
|------|---------------------|--------------|--------------|------|
| **OI-12A · slash argument hints** | candidate 增加 argument hint；`/effort` 从现有方言/模型真源投影可选档位 | 输入 `/effort ` 后仍看到弱化的合法参数；输入实参后提示消失 | exact command/首个 trailing space、动态 effort、Plugin/Skill/static usage、窄屏/CJK | CLOSED `1696127` |
| **OI-12B · context dashboard** | core `ContextUsageViewModel` + plain/detail formatter；CLI 响应式 renderer | `/context` 先显示使用率图、窗口/阈值、actual/estimated 来源和主要类别，详细诊断后置 | 24/38/80/160 列、0/估算/真实/hybrid usage、NO_COLOR、非 TTY、`details` 回归 | CLOSED `15b37ed` |
| **OI-12C · content gutter** | timeline/slash 共用内容留白契约；流式 chunk 只在真实行首加前缀 | Agent、thinking、tool 与 slash 正文不再贴左墙，层级稳定 | 多 chunk/换行/CR、error stream、ANSI/NO_COLOR、窄屏 | CLOSED `40a5d41` |
| **OI-12D · full-width user block** | 用户历史块使用 dock width，与 composer 共享可用宽度而非 content cap | 灰色用户块在内容区内横向铺满，多行仍等宽 | 24/38/80/160/220 列、CJK/emoji、NO_COLOR、composer 等宽 | CLOSED `8d2a7a5` |
| **OI-12E · paste transaction** | bracketed paste lifecycle、跨 chunk buffer、CRLF 规范化与单次 reducer insert/redraw | 多行粘贴不误提交、不反复滚屏，marker 不进入文本 | 单/多 chunk、Windows CR-only/CRLF、Unicode、一次 paint、abort/cleanup、非 paste 回归 | CLOSED `7f76093` |
| **OI-12F · 验收与文档** | 新专项进入默认门禁；README/TUI/USAGE/ROADMAP/handoff 同步 | 源码与 dist 口径一致，真人边界回到 OI-H3 | 专项、typecheck、完整 `npm test`、pack/install 与 Desktop 邻接轨全绿 | CLOSED（本文档批） |

实施顺序（已完成）：

1. OI-12A 先扩展候选契约，避免 CLI 硬编码 effort 列表。
2. OI-12E 优先关闭会误提交的输入稳定性缺陷。
3. OI-12B 建立 context view-model 与双 renderer，再做 OI-12C/D 的统一视觉节奏。
4. OI-12F 最后同步文档；每个代码切片独立中文提交并推送，文档批另提。

关闭证据：

- OI-12A–OI-12E 的代码/测试批均已推送；OI-12F 文档批独立提交，根
  `dependencies` 仍为 `{}`。
- 123 项完整门禁证明 reducer、view-model、逻辑 gutter/paste 序列、非 TTY、
  pack/install 与 Desktop/Electron 邻接行为；它没有 auto-wrap/resize 物理终端，
  后续缺口已转 OI-14。
- OI-H3 只在 OI-14 自动缺陷关闭后保留真实字体/颜色与真人输入手感。

### OI-11 · CLI TUI 持久终端表面与可审计权限交互

**状态：CLOSED（代码 `e9a32cf`、`59acdf6`、`b0feb0c`、`4fc3791`、`da0533c`、
`b0fbb86`、`8088fbb`；2026-07-28 文档同步）**

准入证据（登记时）：

- 真实 Windows Terminal 截图显示 Agent header 与正文从第 0 列开始；用户历史消息
  只有 `❯` 前缀，没有与 Agent 输出区分开的背景块。Claude Code、Grok CLI 与 Pi
  虽然框架不同，但都给时间线正文稳定 gutter，并把已提交用户消息做成独立视觉块。
- `inputBox.ts` 明确把 raw editor 定义为“只在 agent idle 时存在”；提交后
  `clearRendered()` 并释放 stdin，所以 Thinking、工具执行和权限等待期间 composer
  完全消失。`renderTuiInputBox()` 又与欢迎页共用 160 列 frame 上限，超宽终端右侧
  留出大块空白。
- `turnActivity.ts` 只有一个 `turnStartedAt`，工具和模型阶段只更换 label，不重置
  起点；截图中的 `Thinking · 135s/370s` 因而是整轮累计，不是当前思考段耗时。
- `AskPermissionRequest` 已带 `toolInput`，但非文件权限路径只读取
  `preview.summaryText`；Bash 因此退化成 `Allow Bash? [y/a/N]`，没有 command/cwd/
  timeout/background 等判断依据，也没有可导航的 once/always/deny 选项。
- `arrowPicker.ts` 与 `diffPane.ts` 使用 `ESC[2J ESC[H` 清整屏；审批结束也会再次
  清屏。截图复现了历史被擦出当前 viewport、整屏只剩顶部几行活动内容的问题。
- `openaiResponses.ts` 默认 120 秒定时器与父 signal 都调用裸
  `controller.abort()`，catch 后只保留 `This operation was aborted`；core 又把
  不含 timeout 字样的 `AbortError` 当作用户取消，导致真实 request timeout
  不重试、无可行动说明。错误末尾的 `dialect: max-tokens` 与 abort 没有因果关系。
- 用户提供的 `bolo-logo-tui.txt` 是竖向 Unicode 水晶标识；当前欢迎页仍是
  Claude 式左右等分信息卡和 Bolot 像素头像，需要形成 Bolo 自己的视觉结构。
- Pi 将 user/assistant/status/footer/editor 分组件并由同一交互模式编排；OpenCode
  为 thinking、prompt-submit race 和 permission stage 建独立测试；Codex 有
  `vt100_history`/`resize_reflow` 测试。参考范围仅限状态机、失败模式和测试方法，
  不复制品牌布局、代码或重量级依赖。

| 切片 | packages-first 交付 | 人类可见结果 | 自动关闭条件 | 状态 |
|------|---------------------|--------------|--------------|------|
| **OI-11A · terminal surface / persistent composer** | 终端临时区域所有权契约；历史 append 与底部 dock 分离；composer width 使用可用终端宽度 | Thinking/Running 时输入区不消失；输入框横向铺满；权限面板可临时接管 stdin | idle/running/permission 状态机；24/38/80/160/超宽；局部 clear 序列；非 TTY 回归 | CLOSED `59acdf6` |
| **OI-11B · timeline hierarchy / status** | 统一 timeline gutter；用户消息背景块；结构化 footer token（model/mode/keys/usage） | Agent 正文不贴边；已提交问题有灰色块；模型、快捷键和 `↓token` 清晰高亮 | ANSI/NO_COLOR、CJK/emoji、usage real/estimated、窄屏优先级与裁剪 golden | CLOSED `b0feb0c` |
| **OI-11C · segment activity** | model/tool/reasoning segment 生命周期与独立计时；活动帧继续原子写入 | 当前 `Thinking` 有动画；每段结束显示 `Thought for 4.2s`，不再把整轮时间冒充本段耗时 | 假时钟覆盖多段 model→tool→model、retry、warning、abort；每 tick 单 write | CLOSED `4fc3791` |
| **OI-11D · permission chooser/details** | `toolInput` 安全摘要器；通用 once/always/deny picker；文件 diff 继续复用现有 view-model | Bash 展示具体 command/cwd/关键参数；方向键/快捷键选择，不必盲输 `yes/no` | Bash/Write/WebFetch/MCP/未知 input；always 作用域文案；abort/非 TTY fail-closed | CLOSED `da0533c` |
| **OI-11E · viewport stability** | 可复用局部 region erase/repaint；移除嵌入式 picker/diff 的整屏 clear | 权限、diff、输入和活动更新不再把历史擦掉或把屏幕滚成只剩几行 | VT 输出序列 + 小 viewport/长历史/面板增长缩短/resize；无 `ESC[2J` 回归 | CLOSED `b0fbb86` |
| **OI-11F · Responses abort diagnosis** | timeout 与 parent/user abort 分源；retry 分类和 provider error context | 120 秒超时明确显示 endpoint/timeout/下一步；用户 Ctrl+C 仍是取消且不重试 | fake fetch/fake clock 覆盖 timeout、parent abort、成功清理、secret redaction | CLOSED `e9a32cf` |
| **OI-11G · crystal identity** | 水晶标识常量/资产与 cell-width renderer；宽/中/紧凑独立布局 | 欢迎页使用 Bolo 水晶标识，不再是 Claude 左右等分卡；窄屏有稳定降级 | 三档 golden、Unicode/ASCII、NO_COLOR、长 cwd/model 裁剪、dist 资产契约 | CLOSED `8088fbb` |
| **OI-11H · 验收与文档** | 新专项进入默认门禁；README/TUI/ROADMAP/handoff/USAGE 同步 | 源码与 dist 行为一致，用户文档不再承诺旧界面 | 专项、typecheck、完整 `npm test`、dist smoke 全绿；真人项移交 OI-H3 | CLOSED（本文档批） |

关闭证据：

- `test:provider-abort-diagnosis`、`test:cli-terminal-surface`、
  `test:cli-timeline-hierarchy`、`test:cli-thinking-segments`、
  `test:cli-permission-panel`、`test:cli-local-panels`、
  `test:cli-crystal-identity` 均进入默认门禁。
- 2026-07-28 完整 `npm.cmd test` 通过 121 个串联脚本；真实 npm pack/install、
  dist build、Desktop bundle/launch 全绿；根 `dependencies` 保持 `{}`。
- 自动化只关闭可由代码证明的缺陷；真实字体、颜色、resize 和真人按键仍保留在
  OI-H3，不以 PTY 或注入按键冒充。

实施顺序（已完成）：

1. OI-11F 先修可复现的数据面错误，避免后续长 TUI 验收被假 abort 打断。
2. OI-11A 建立共享终端表面，再依次落 OI-11B、OI-11C、OI-11D、OI-11E；
   禁止让新的 picker/activity 各自重新拥有 stdout。
3. OI-11G 在交互骨架稳定后重做欢迎页，避免视觉改动掩盖 cursor/scroll 回归。
4. OI-11H 最后同步文档。每个代码切片独立测试、中文提交并推送；文档批另提。

总关闭条件（已满足）：

- OI-11A–OI-11H 的代码/测试与文档批均已推送，根 `dependencies` 仍为 `{}`。
- 自动测试证明 reducer、简化 VT 序列、非 TTY 和 dist 行为；后续已确认该 VT 不含
  auto-wrap/双宽 cell/resize，物理布局缺口转 OI-14。
- OI-H3 只在 OI-14 自动缺陷关闭后保留真实字体/颜色与真人输入手感。

### OI-10 · CLI 命令发现与 TUI 一致性

**状态：CLOSED（代码 `67421bb`；文档同步批次）**

准入证据：

- 2026-07-28 的真实 Windows Terminal 截图中，欢迎框基本铺满终端，输入框却只占
  约四分之三；`inkLayout.ts` 的上限为 160 列，`inputBox.ts` 的上限为 120 列，
  两套 frame width 契约直接造成右边缘错位。
- `turnActivity.ts` 每 250ms 递增 `frame`，但 renderer 始终输出固定 `✦`，所以只有
  elapsed 在变化；此前的一闪一闪已由“每帧单次原子写入”修复，恢复动画不能退回
  erase-then-draw。
- `TuiInputState` 没有候选、选中项或菜单状态；↑/↓ 无条件浏览历史，Tab 被写成两个
  空格，Esc 没有菜单语义。输入 `/` 或 `/d` 时完全没有命令展示或补全。
- core 已有结构化 `SLASH_COMMANDS`，session 已有 `pluginCommands` 与 `skills`；
  执行层支持内置、Plugin command 和 `/<skill-id>`，但输入层没有把这些已有能力投影
  为统一候选。
- Pi、OpenCode、HelsincyCode 与 Codex 的相关实现虽框架不同，但都具备同一最低交互
  契约：`/` 展示、输入过滤、菜单态优先接管方向键、Tab/Enter 接受、Esc 关闭，以及
  动态命令与内置命令共享发现入口。

| 切片 | packages-first 交付 | 人类可见结果 | 自动关闭条件 | 状态 |
|------|---------------------|--------------|--------------|------|
| **OI-10A · frame width** | 欢迎页、输入框和用户消息共享终端 frame width helper | 宽屏时上下框同宽；窄屏不破框 | 24/38/56/96/超宽 golden + CJK/NO_COLOR | CLOSED |
| **OI-10B · activity animation** | 确定性 frame glyph 契约，继续每帧单次完整写入 | Thinking/Running 有平滑动画，elapsed 继续更新且无空白帧 | 多 frame 输出不同；每 tick 单 write；窄屏/NO_COLOR 回归 | CLOSED |
| **OI-10C · slash catalog** | 从 `SLASH_COMMANDS` 投影只读候选，提供前缀过滤与稳定排序 | `/` 显示命令，`/d` 首选 `/doctor` | hidden/alias/精确/前缀/无匹配/稳定顺序 | CLOSED |
| **OI-10D · input menu** | reducer/renderer 增加菜单显隐、选中索引、可视窗口和补全动作 | ↑/↓ 选择，Tab/Enter 补全，Esc 关闭且保留输入；菜单关闭后 ↑/↓ 仍是历史 | 编辑/删除/光标移动刷新；CJK/窄屏；raw listener/清理回归 | CLOSED |
| **OI-10E · 动态贡献** | Plugin command 与 user-invocable Skill 投影进同一 catalog，复用既有 precedence/conflict 结果 | 插件命令和 Skill 可从 `/` 菜单发现；reload 后下一次输入立即更新 | 来源标签、禁用 Skill、重名、reload/session projection | CLOSED |
| **OI-10F · 验收与文档** | 默认门禁注册新契约；ROADMAP/TUI/SLASH/USAGE/handoff 同步 | 源码与 dist 行为一致，非 TTY 无动态控制符 | 专项、typecheck、完整 `npm test`、dist smoke 全绿 | CLOSED |

关闭证据：

- `67421bb` 在 core 提供只读候选 projection/filter，在 CLI 提供本地
  `/exit`/`/quit` 适配层、共享 frame、菜单 reducer/renderer 与多帧 activity；
  欢迎页、输入框、用户消息不再维护互相冲突的宽度上限。
- 裸 `/` 隐藏 alias，明确前缀仍可发现；内置命令优先于 Plugin/Skill 重名项，
  `user-invocable: false` Skill 不进入菜单；每次 idle editor 重建候选，plugin reload
  后无需重启会话。
- Codex PTY 动态实测中裸 `/` 显示 36 个可见项，`/d` 首选 `/doctor` 并显示真实
  Plugin 来源；Down、Tab、Esc 与 `/exit` 两阶段提交均正常且未见残留行。
- `test:slash-completion`、扩展后的 `test:cli-tui`、typecheck、114 个脚本完整
  `npm test`、dist build/install 与 Electron launch 全部通过；根依赖仍为 `{}`。

已满足的关闭条件：

- 输入框只消费窄 `SlashCommandCandidate[]`，不依赖整个 session，也不复制第二份内置
  执行清单或执行器；CLI 仅单列自己拥有的 `/exit`/`/quit`。
- `/` 只在整行命令名上下文显示；出现参数、普通文本、`//` 或无匹配时正确关闭/显示
  空态，不把普通提示误判为命令。
- Tab/Enter 只接受候选并补成 `/<name> `；命令提交仍走现有
  `submitUserInput`，reducer 不执行副作用。
- 继续保持根 `dependencies: {}`；新测试有独立 npm script 并进入默认门禁。
- 自动验证与文档同步已完成，OI-10 已关闭；真实 Windows Terminal 字体、光标、
  resize、残影和真人按键观感仍属于 OI-H3，不能以快照或注入按键冒充。

### OI-01 · 状态真源与使用文档漂移

**状态：CLOSED（文档同步批次）**

关闭证据：

- ROADMAP §0/§13.11、handoff、README 与 autonomous prompt 使用同一队列，
  并在 OI-04 关闭后统一把 OI-06 标为当前，同时保留外部/人工阻塞标记。
- AR4 ADR 已按正文改为六个候选；RELEASE 与默认门禁现统一为 114 个脚本。
- USAGE 已补 `--allowed-tools`、`--disallowed-tools`、`AskUserQuestion`
  与 Web search 的最短入口。
- `test-dist-build.ts` 守住默认门禁条目和 package manager；
  `test-docs-config-snippets.ts` / `test-search-cli.ts` 守住配置片段与文案承诺的命令。

### OI-02 · 两个核心回归测试没有进入默认门禁

**状态：CLOSED（`5800f05`）**

证据：

- `scripts/test-ptl-retry.ts` 覆盖 PTL 识别、截断重试、query loop、
  session submit 与 full compact，但默认 `npm test` 不执行它。
- `scripts/test-desktop-launch.ts` 真正启动 Electron 并检查 renderer、preload
  与 CSS；命名脚本 `test:desktop-bundle` 会串联它，但默认门禁直接执行
  `test-desktop-bundle.ts` 文件，不会展开命名脚本。

关闭证据：

- 两项都已进入默认 `npm test`。
- `test-dist-build.ts` 会断言它们不能再次被移出。
- 完整门禁在 Windows 实际输出 `PASS: ptl-retry` 与
  `launched, renderer mounted ... PASS: desktop launch`，`EXIT=0`。

### OI-03 · 包管理器声明与仓库现实不一致

**状态：CLOSED（`5800f05`）**

证据：

- 根 `package.json` 声明 `pnpm@9.15.0`，仓库只有 `package-lock.json`，
  使用 npm workspaces，当前工具链为 npm 11.17.0。
- electron-builder 因根声明先选择 pnpm，失败后才回退 traversal。
- ARCHITECTURE、AGENT_HANDOFF、TUI、USAGE、README 等仍混用 pnpm 口径。

关闭证据：

- 根与 Desktop 均声明 `npm@11.17.0`，并保留唯一 `package-lock.json`。
- 发行契约断言 package manager、lockfile 与默认门禁。
- 开发文档已统一以 npm 为默认入口。
- NSIS 日志直接识别 `pm=npm config=npm@11.17.0` 并 exit 0；空生产依赖时的
  traversal 是 collector 的空树回退，不是包管理器误判。

### OI-04 · SearXNG 产品契约互相矛盾

**状态：CLOSED（`c058998`）**

证据：

- 关闭前 `packages/config/src/searchPresets.ts` 内置 `searxng` MCP preset，
  指向 `http://127.0.0.1:8080/mcp` 占位桥。
- `LOCAL_SEARCH_AND_FETCH.md` §3.1 明确说 Bolo 不内置任何 SearXNG 桥 preset。
- 同文 §3.3 声称“断网也应该能搜”，但 SearXNG 没有自有索引，查询仍需上游引擎。
- 文档 §5 已论证 Bolo 直连 SearXNG JSON API 可删除不受信任的桥，但尚未实现。

关闭条件：

- 删除误导性的第三方桥 preset。
- 提供零依赖、显式配置、fail-closed 的 SearXNG JSON 搜索工具。
- 本地 fixture 覆盖请求参数、响应解析、超时、错误与结果预算。
- 文档明确“本地服务”与“查询不出机器”不是一回事。

关闭证据：

- `search.searxng` 支持 user/project 深层合并与 `enabled: false`；畸形高优先级覆盖
  不会继续启用低优先级 endpoint。
- 内置 `WebSearch` 只接受显式配置的 endpoint；公开 HTTP、URL 凭据/query/fragment
  均 fail closed，并限制超时、响应体、结果字段和最终输出。
- `/websearch off` 会从模型请求移除 disabled schema；reload 保持唯一工具实例。
- `bolo search status` 同时列出 hosted、SearXNG direct 与 MCP 线路；配置 warning
  在 CLI 与 Desktop 都可见。
- `test-searxng-search.ts` 使用本地 HTTP fixture 覆盖请求、解析、错误、预算和生产
  接线，并已进入独立 script 与默认门禁；OI-X1 已另补真实实例证据。

### OI-05 · CLI 构建会吞掉 bundled skills 复制失败

**状态：CLOSED（`5800f05`）**

证据：

- `scripts/build-dist.ts` 对 `fs.cp(skillsSrc, skillsDst)` 使用
  `.catch(() => {})`。
- 发布 `prepack` 只跑 build；复制失败时可能 exit 0，随后发布缺技能资产的包。

关闭证据：

- `fs.cp` 错误会自然抛出并使 build 非零退出。
- 发行契约静态守住复制调用不能再挂空 catch。
- dist contract、真实 pack/install 与完整门禁全绿。

### OI-06 · Desktop 产品工作流接线

**状态：CLOSED（`74997ab` · `c76123e` · `c08254a` · `ce918ef` · `9f0f687`）**

证据：

- `packages/shared/src/runtimeClient.ts` 的 client/transport/store 已由 Desktop
  renderer 生产调用；core adapter 和 hello/query/command IPC 已接通。
- 会话侧栏已支持 click/Enter/Space resume；core active-session manager 串行化
  create/resume/recreate/close，忙态 fail-closed。
- composer 已显式提供 Send/Queue/Steer/Interrupt，并经 durable control 接入；
  queue terminal 后由 Desktop FIFO drain。
- 设置页已可修改 model/effort：model preset 只作建议且允许自定义名称，effort
  只显示当前 dialect/model 可选档；写盘失败恢复 model/effort/classifier/cache，
  renderer 保留原输入与错误提示。
- `projectSessionRuntimeEventView` 把 `control`、`tool_progress` 投成 renderer
  可直接显示的窄契约；renderer 事件覆盖从 6/17 提升到 8/17，不机械呈现全部事件。

关闭条件：

- packages 中先定义并测试 Desktop runtime transport/intent 契约。
- Desktop 接入 runtime client，能够切换/恢复会话并显示协议不兼容与读取失败。
- composer 明确区分 send、queue、steer、interrupt。
- model/effort 设置可用且 secret 不进入 renderer。
- control/tool progress 等 OI-06 关键运行态事件有稳定 packages 投影与 Desktop 呈现。
- 定向测试、IPC 契约、真实 Electron 启动与完整门禁全绿。

关闭证据：

- `createSessionRuntimeTransport` 统一协议 hello、当前 session snapshot、边界命令解析
  与 `executeRuntimeCommand`，没有另造 executor。
- Desktop 通过 19 request + 3 push IPC、browser ESM `RuntimeClient` 和单一 store
  显示 ready/incompatible/error；错误不会伪装成空会话。
- `test-session-selection.ts` 覆盖忙态、并发、load failure、candidate 清理与
  scoped approval id；旧 session 回包不能认领新实例。
- `composerIntentToControl` 为 queue 分配稳定的新 turn ID；core adapter 统一
  runner snapshot、意图翻译与 durable admission，拒绝未知 IPC action/text。
- `getSessionModelEffortSettings` 与 `updateSessionModelEffort` 统一 slash/Desktop
  suggestions、choosable、输入校验、即时持久化及失败回滚；secret 不进 snapshot。
- critical event projector 对无效事件 fail-closed，不把原始 steer prompt 字段传给
  renderer；tool progress 原位更新同一行，steer 只在 safe boundary 真正应用后呈现。
- 真实 Electron smoke 已返回 `runtime:"ready"`，自动点击 session row 恢复目标，
  并经真实 IPC 修改/回读 `desktop-smoke-model/high`；默认门禁 EXIT=0。
- `test:desktop-runtime-events`、typecheck、IPC/event 契约、dist install、Desktop
  bundle/launch 与完整 `npm test` 全绿。真人点击与视觉验收仍单列 OI-H2。

### OI-07 · SearXNG 诊断与部署体验

**状态：CLOSED（A `7754525` · B `3e96573` · C `ef03f3d` / `f623ad9`）**

准入证据：

- OI-X1 真实实例曾在 HTTP 200 下因 429/CAPTCHA/timeout 返回 0 条；旧
  `WebSearch` 只输出普通 “no valid results”，无法区分合法空结果与上游全故障。
- 同一实例也会出现“部分引擎返回结果、其余引擎失败”；诊断不能以丢弃有效结果为代价。
- `bolo search status` 只读解析后的配置，不访问 endpoint，也不验证 JSON、版本或
  非空结果；它不能承担健康检查。

#### OI-07A · 上游诊断契约

**状态：CLOSED（`7754525`）**

- packages-first 解析 SearXNG `unresponsive_engines` tuple；畸形条目忽略，
  有效条目去重并限制数量/字符预算。
- `results: []` 且没有有效故障诊断仍是成功的正常空结果。
- 没有有效结果但存在上游故障时返回
  `errorCode: "upstream_unavailable"`，并列出引擎与原因。
- 部分成功保持 `ok: true`、保留有效结果，在输出尾部追加简短 warning；即使结果
  很长，warning 也不会被 12,000 字符预算截掉。
- fixture 覆盖正常空结果、全故障、部分成功、去重、畸形诊断与长输出预算；
  专项、typecheck、默认门禁与真实实例全故障分支均已验证。

#### OI-07B · `bolo search doctor`

**状态：CLOSED（`3e96573`）**

关闭证据：

- `probeSearxng` 与生产 `WebSearch` 共享 HTTP、timeout、响应预算、JSON、结果与
  `unresponsive_engines` 解析原语；CLI 没有复制第二套协议客户端。
- `search status` 继续只读配置；`search doctor [--json]` 才访问 `/config` 和
  `/search`，报告版本、instance、JSON 能力、配置引擎数、有效结果、working 与
  unresponsive engines，不修改配置或启动服务。
- text/JSON 都从同一有界 report 渲染；JSON stdout 只有一个 payload、stderr 干净。
  成功/部分成功 exit 0，网络/JSON/空结果/全故障 exit 1，用法或未配置 exit 2。
- `test:search-doctor` 的本地 HTTP fixture 覆盖 config/search 两阶段 HTTP、timeout、
  非 JSON、坏 shape、正常非空、合法空结果、全故障、部分成功与真实 CLI 入口；
  已进入当前 113 项默认门禁，公网可用性不进入 `npm test`。
- 源码 CLI 与完整门禁产出的 `dist/bolo.mjs` 均已对真实
  `2026.7.26+b060c780d` 实例运行：8 条有效结果、working engines 与部分故障，
  `partial_success`、exit 0。

#### OI-07C · 可选 Docker setup

**状态：CLOSED（`ef03f3d` · `f623ad9`）**

- 新增 `bolo search searxng setup [--port N]`、`status [--json]`、
  `logs [--tail N]` 与 `stop`；Docker 必须由用户预先安装，只有显式 `setup` 才会
  创建 managed files 或启动容器。
- 使用固定镜像 digest，只绑定 loopback，随机生成 secret；settings 继承 SearXNG
  默认引擎，只启用 `html/json`，不强制 Bing 或任何单一引擎。
- fresh setup 在所有写入前预检 loopback 端口与 Docker/Compose，再写文件、启动容器、
  执行非空 doctor smoke，最后才以保留 JSONC 注释的方式原子合并 Bolo 配置。
- Docker up、smoke 或 config commit 失败会 compose down 并清理本次新建目录；既有
  managed setup 不被误删。无 manifest 的 `~/.bolo/searxng` 会 fail closed，避免覆盖
  用户文件。
- `status` 不做上游查询；`logs` 有输出预算；`stop` 保留 managed data、manifest 与
  Bolo config，之后可再次 `setup`。
- fake runner 专项已进入默认门禁；源码与 `dist/bolo.mjs` 均完成真实
  setup → status → doctor → logs → stop，且没有触碰 OI-X1 的 8888 实例。

### OI-08B · CLI 首次启动仍依赖手工初始化叙述

**状态：CLOSED（代码 `22c0d0c` · 文档同步批次）**

准入证据：

- USAGE、CONFIG 与 handoff 把 `npm run bolo:init` / `scripts/bolo-init.ts` 放在首次启动
  主路径，最终用户容易理解为 `bolo` 前必须手工初始化。
- 旧 `loadWorkspace.ensureDefaults` 同时 materialize 用户与项目布局；普通 `bolo` 会在
  任意 cwd 创建项目 `.bolo/`，只读 load 即使传 false 仍会创建空目录。
- 顶层没有真正的 `bolo init` 子命令；`bolo init` 会落入 prompt parser 并把 `init`
  发给模型。
- 新会话、默认 subagent 侧链与超长 tool-result spill 都写项目
  `.bolo/sessions`，因此只修文案仍会在正常工作中污染仓库。

关闭证据：

- `materializeUserState` 明确只准备用户布局，项目配置、rules、plugins、memory 始终
  只读发现；search/status/list 等只读路径不创建目录。
- 新会话、默认 subagent transcript 与 tool-result spill 统一写入用户级
  `sessions/workspaces/<workspace-hash>/`；workspace identity 对规范化 cwd 做哈希。
- `listWorkspaceSessions` 与纯 id resume 按新 workspace、旧项目、cwd 匹配的旧用户路径
  发现并去重；旧文件不迁移、不覆盖，显式 filePath 继续原位续写。
- `bolo init [--project] [--cwd <dir>]` 与 `bolo init --user` 已成为真实、幂等、
  不覆盖的 CLI 子命令；`init` 在通用 prompt parser 前分发，`/init project` 保留。
- `test-cli-first-run` 覆盖真实 CLI 子进程、fresh cwd 零项目副作用、existing `.bolo`
  读取、legacy list/resume、无效用户目录、init 幂等，以及 subagent/tool spill 路径。
- typecheck、专项、dist pack/install、Desktop bundle/真实 launch 与当前 113 项完整
  `npm test` 在 Windows EXIT=0。

## 2. 外部资源项（已关闭）

### OI-X1 · SearXNG 真实实例 live smoke

**状态：CLOSED（2026-07-27 真实实例）**

- 官方镜像 `SearXNG 2026.7.26-b060c780d`，digest
  `sha256:d0aaeb14880e6e92bde1518fcc7261e995783367d63d95203383607bef9c6516`，
  只绑定 `127.0.0.1:8888`，显式启用 JSON。
- 直接 JSON 搜索返回 20/26 条真实结果；生产 `bolo search status` 正确显示
  `/search` endpoint，session 注册 permission-gated `WebSearch`。
- 生产工具调用 2.32s 返回 5 条、6 个 URL，首条为
  `https://developers.openai.com/api/docs`，结果来自 Google CSE、DuckDuckGo、
  Bing；`/websearch off/on` 动态门控通过。
- 活体同时暴露默认引擎不稳定：Brave 429、Startpage CAPTCHA、DuckDuckGo /
  Google CSE / Wikipedia 超时曾令同一查询返回 0。启用当前网络可达的 Bing 后，
  默认 JSON 查询 1.94s 返回 37 条。部署验收必须要求**非空结果**，不能只看 200。
- `npm run test:searxng-search` 继续 EXIT=0；公网 live 不进入默认门禁。

## 3. 必须真人验证

### OI-H1 · CLI `AskUserQuestion` 真 TTY

**状态：BLOCKED: HUMAN**

自动测试注入 `readKey`，覆盖不到真人终端的 raw mode、方向键、多选、自由文本、
Ctrl-C/Esc 以及 REPL 是否抢占 stdin。需要人在真实终端按键确认。

### OI-H2 · Desktop 问答与视觉走查

**状态：BLOCKED: HUMAN**

自动化能确认窗口挂载、preload、CSS 和 IPC，但不能判断布局观感，也不能替代真人点击。
需要在真实窗口检查 AskUserQuestion、权限对话框、明暗主题、maximize、键盘导航、
长会话滚动与窄窗口文本溢出。

### OI-H3 · CLI TUI 真实 Windows Terminal 走查

**状态：BLOCKED: HUMAN（自动缺陷已关闭，等待真人走查）**

OI-09–OI-13 已自动覆盖 slash reducer/menu/argument hint、context view-model、
bracketed paste 状态机、silent Thought/分段计时、权限详情与非 TTY 回落等业务契约。
这些测试仍然有效，但旧 `TestTerminalScreen` 没有物理 auto-wrap、双宽 cell 或
resize，不能证明正文/surface 稳定。

2026-07-28 截图暴露的正文碎片、巨大空洞、物理续行贴左、user/agent 间距、
cursor/resize 与 cleanup 代码缺陷已由 OI-14G 的真实 xterm、故障注入和子进程门禁
关闭；OI-14H 又删除了全部旧 dynamic owner 与回滚入口；`e6ec6cb` 进一步关闭
durable SIGINT handler 与下一轮 Composer stdin 获取的竞态。本条只检查真实 Windows
Terminal 字体/颜色、动画主观流畅度、
鼠标/剪贴板手感、Ctrl+J/历史/删除组合键、权限面板真人切换，以及实际 terminal
host 的 resize/滚动体验；不得用本条掩盖任何可由 headless terminal 复现的问题。

## 4. 已核实但不列为开放问题

| 候选 | 结论 |
|---|---|
| Windows NSIS 打包 | 2026-07-27 已用 `electron-builder@26.15.3` 成功生成约 80 MB 安装包和 blockmap；根工具链与文档已同步 |
| LSP | 有意暂缓；当前没有满足 ADR 中的重开证据，不因“重量级 agent 都有”自动立项 |
| 任意中段 compact | 契约保留、产品显式不启用；参考实现也没有可靠先例 |
| 远端 compaction | ADR 明确不实施，符合隐私与可恢复性边界 |
| token 启发式剩余高估 | 最差 +19.5%，方向安全且受门禁约束；零运行时依赖下属于已知精度边界 |
| 前台命令自动后台化 | 已把真实缺口收窄为可行动的超时提示；没有证据支持引入自动迁移状态机 |

## 5. 扫描范围

本轮检查了：

- ROADMAP、RELEASE、AGENT_HANDOFF、USAGE、ARCHITECTURE、AR4 ADR、
  Desktop 与本地搜索专题文档；
- 根与 Desktop package metadata、113 项默认测试串及 148 个 `test-*.ts` 的注册差集；
- 历史 SearXNG preset、WebFetch、工具注册、权限分类、runtime client、Desktop IPC/renderer；
- 代码中的 TODO/FIXME、空 catch 与未实现标记；
- 当前完整门禁、electron-builder registry 版本与真实 NSIS 构建。

没有当前证据、已经关闭或只是历史 TODO 标题的条目没有进入开放问题。
