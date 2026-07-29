# CLI TUI retained renderer 重构方案

> **状态：** OI-14 `BLOCKED: HUMAN`（OI-14A–H 自动实现已关闭；只剩 OI-H3）；
> OI-15 `IN PROGRESS`（OI-15A–C 已完成；OI-15D 下一刀）
> **方案锚点：** Bolo `c2e6a98`；Pi `c820aa26fe09`；oh-my-pi
> `d16c6168c86f`；Codex `f61b51ddd924`；OpenCode `66495a2a22cd`；
> HelsincyCode `e6dd86ef990e`。
> **OI-14A 交付：** `1ae9f53` · `f04f8de` ·
> [CLI_TUI_RENDERER_DECISION.md](./CLI_TUI_RENDERER_DECISION.md)。
> **OI-14B 交付：** `269b39c` ·
> `packages/shared/src/cliTuiViewState.ts`。
> **OI-14C 交付：** `1798a7c` · retained renderer 基座。
> **OI-14D 交付：** `8b060e5` · retained transcript/Markdown。
> **OI-14E 交付：** `d0fb822` · retained Composer/activity/footer。
> **OI-14F 交付：** `31384d4` · retained OverlayHost/交互面板。
> **OI-14G 交付：** `6f4764f`–`accc22c` · 默认切换、可靠性、cleanup 与性能预算。
> **OI-14H 交付：** `39e66b4`–`d4eaed0` · legacy 删除、单 owner guard 与发布审计。
> **可靠性 follow-up：** `e6ec6cb` · durable SIGINT handler/Composer 输入串行化。
> **OI-15A 交付：** `d681734` · core display policy、完整内建分类与 fail-closed。
> **OI-15B 交付：** `d6bd087` · retained 单 panel/toast、generation、timer effect、
> Composer 下方有界组件与 input/Esc/reset/restore/stop 生命周期。
> **OI-15C 交付：** `26f796f` · retained CLI 消费 panel/pager policy；`/context`
> compact panel/details text pager，doctor/status/help/memory 等按 viewport 升级 pager，
> mcp/hooks 直接进入 pager；单页可见、CJK/resize、20× replace、compatibility/persistence
> 隔离与 plain fallback 已进门禁。
> **范围：** 本文定义 CLI TTY 路径的重构方案。非 TTY、`--print`、pipe、JSON 和
> Desktop 的既有输出契约必须保持兼容。
> **结论先行：** 停止继续扩展自研 `TerminalSurface + 字符串 prefix + tiny
> Markdown`。采用成熟 retained-mode TUI 基座，让唯一 renderer 负责 block layout、
> cell-aware wrap、viewport、cursor、resize 和 diff；Bolo 只保留自己的会话状态、
> 权限、工具、slash、品牌与业务组件。

---

## 1. 为什么必须重构

2026-07-28 的真实 Windows Terminal 截图确认了四个产品级故障：

1. Agent 正文被拆成几个字一行，片段落在不同列，段间出现数十行空洞。
2. 同一段首行有 gutter，终端自动折出的续行却回到第 0 列。
3. 用户灰色消息块与后续 Agent/Thought 区域贴得过近，section 层级不清。
4. Markdown 长链接、列表、Thought、搜索摘要和普通正文没有统一内容宽度、续行缩进
   与 block spacing。

这些不是颜色、字体或个人审美问题。它们可由“超长物理行 + streaming + 常驻
composer + 局部擦除”自动复现，因此不能继续归入 OI-H3 的纯真人观感项。

当前 OI-09–OI-13 的局部功能仍有价值：slash 发现、argument hint、context
view-model、paste 事务、分段计时、权限详情、水晶品牌和非 TTY fallback 都应保留。
被否定的是渲染架构及其“已经稳定”的完成口径，不是这些业务能力。

---

## 2. 根因

### 2.1 当前数据流

```text
SessionEvent
  -> createSessionEventPrinter()
  -> createTerminalMarkdownStream()
  -> createTuiContentPrefixer()
  -> TerminalSurface.writeOutput()
  -> stdout
  -> 终端自行产生未记账的物理折行
```

同时，idle 输入、running dock、activity、permission、picker 和 diff panel 分别拥有
不同的 cursor/erase 生命周期：

```text
readTuiInput() 退出
  -> REPL 重建空的 running composer
  -> TerminalSurface 保存/恢复 cursor 并追加 provider chunk
  -> clearDock()
  -> 下一轮 readTuiInput() 再创建 idle composer
```

### 2.2 架构缺口

| 位置 | 当前契约 | 为什么必然失效 |
|------|----------|----------------|
| `contentLayout.ts` | 只在逻辑 `\n` 行首加静态空格 | 不知道 terminal cell width、自动折行、Markdown hanging indent 或 resize |
| `terminalMarkdown.ts` | 只处理 `**` 和反引号 | 不解析 paragraph/list/code/table/link 等 block Markdown |
| `terminalText.ts` | 剥 ANSI 后按 grapheme 硬切 | 丢 style/OSC 8，缺少 word boundary、列表语义和流式 source |
| `terminalSurface.ts` | 只记录逻辑行数与一个 line-start 布尔值 | 未记录终端自动 wrap 的物理行、当前 column 和 resize reflow |
| `formatSessionEvent.ts` | provider event 直接写 stdout | chunk 成为布局副作用，无法更新同一稳定 block |
| `readTuiInput()` | 每轮重新创建 editor | 输入区和 transcript 不是同一布局树，turn 交接时 cursor 所有权变化 |
| `localPanel.ts` 等 | 各自暂停/擦除/恢复 | 多个局部 surface 同时维护终端几何 |

现有 `TestTerminalScreen` 没有 cols/rows、auto-wrap、双宽 cell 或 resize。它把每个
code point 都当一列，所以即使字符串测试与简化 VT 行数全绿，也看不到真实终端生成的
额外物理行。

### 2.3 必须淘汰的模式

- TTY 模式下从 event formatter 直接写 stdout。
- 先加 gutter，再交给终端自动折行。
- 依靠内容字符串首尾的 `\n` 表达组件间距。
- provider 每个 chunk 创建或追加一个独立视觉 block。
- idle/running/permission 各自保存 cursor 并临时接管屏幕。
- 用“根 `dependencies` 为空”否决经过审计的成熟基础库。
- 用字符串包含、逻辑行数组或静态截图证明物理终端布局正确。

---

## 3. 成熟实现审计

| 项目 | 许可与技术栈 | 可复用能力 | 本项目结论 |
|------|--------------|------------|------------|
| **Pi TUI** | MIT；TypeScript/ESM；`marked`、`get-east-asian-width`；包声明 Node `>=22.19.0` | `Component.render(width): string[]`、TUI differential renderer、Markdown、ANSI/OSC 8/CJK/emoji wrap、Editor、Box/Spacer、VirtualTerminal 测试 | **首选基座**。只采用 TUI 公共 API 或有归属的最小 fork，不依赖整个 coding-agent |
| **oh-my-pi** | MIT；Bun；native/utils/cache 依赖 | native scrollback、render backpressure、terminal capability、tmux/Ghostty、scroll view、resize/DECCARA 回归 | 首次迁移不直接接入；作为 Pi 基座之后的可靠性清单 |
| **Codex** | Apache-2.0；Rust Ratatui/Crossterm | raw Markdown source、history cell、stream controller、transcript reflow、bottom pane、VT100 snapshots | 只借鉴契约与测试意图，不复制 Rust 实现 |
| **OpenCode** | 根 MIT；OpenTUI + Solid；Bun/Effect/workspace | retained component tree、box gap/padding/flex、sticky scrollbox、结构化 permission/prompt/reasoning/tool | 有时限的备选 spike；不能把 OpenCode 整体依赖带入 Bolo |
| **HelsincyCode** | 用户自有私有仓库；Ink 6 + React 19 | Messages、VirtualMessageList、Markdown、PromptInput 的功能实现与信息架构 | 可作内部功能复用来源；公开产物不得泄露私有源码/路径/品牌或未授权第三方内容，视觉目标不以 HC 为上限 |

共同结论与具体框架无关：

1. 原始消息/Markdown source 是真源，当前宽度下重新渲染。
2. 组件先生成宽度受控的完整物理行，普通组件不能绕过根 renderer 写 stdout。
3. stream 更新同一个有稳定 id 的 message block，然后请求重绘。
4. transcript、activity、composer、footer 和 overlay 属于同一 retained tree。
5. block spacing、wrap、viewport、cursor 和 resize 必须由布局系统统一计算。
6. 测试必须把最终 ANSI 写入真正的 headless terminal，再断言屏幕 cell。

---

## 4. 技术路线

### 4.1 主路线

采用精确版本 `@earendil-works/pi-tui@0.82.1` 的公共 API，复用其 renderer、
Markdown、width、focus、keys、`StdinBuffer`、光标协议和基础组件；Bolo 自己实现
SessionEvent adapter 与领域组件。OI-14E 实测没有直接采用 Pi Editor：其
autocomplete/render 状态私有，无法无损保持 Bolo 全宽框、argument ghost hint、
slash menu 与独立 footer；稳定 `RetainedComposer` 继续复用 Bolo 输入
reducer/renderer。

不采用 Pi coding-agent，不复制其 provider/session/tool 业务，也不引入 Pi 的产品
目录、配置或品牌。构造 TUI 时必须显式传入 Bolo 的日志目录，禁止回落到 `~/.pi`。

### 4.2 Phase 0 兼容决策（OI-14A 已完成）

OI-14A 开始时 Bolo 声明 Node `>=20`，Pi TUI 声明 Node `>=22.19.0`。隔离 spike
完成后的决定如下；完整数字和复现命令见
[CLI_TUI_RENDERER_DECISION.md](./CLI_TUI_RENDERER_DECISION.md)。

| 检查 | 实测结果 |
|------|----------|
| Node | Windows Node 24 通过；真实 Node 20.18.3 也能运行，但上游不支持，Bolo 已提升到 `>=22.19.0` |
| esbuild | 两个 `packages=bundle` 单文件入口均通过，无第三方 runtime import |
| Windows | renderer/components 通过；`ProcessTerminal` 依赖未嵌入的动态 native helper |
| 资产 | 首轮使用 Bolo terminal adapter，不引入动态 native 资产 |
| 副作用 | 无联网/遥测；正常 import/render 不创建 `~/.pi`；必须显式传 Bolo log dir |
| 体积/启动 | candidate 约 179 KB；冷启动 p50 145.8 ms，均低于软预算 |
| 许可 | Pi、marked、width 依赖均为 MIT；精确版本与 lockfile 已固定 |

最终采用 direct build-time dependency，并提升 Node 支持线；不为已 EOL 的 Node 20
维护 fork。首轮不采用 Pi `ProcessTerminal`；modifier 若出现真实回归，再单独评估
带 attribution 的 Windows native helper。Pi 路线没有实质失败，因此不启动
OpenTUI spike。

不得选择“继续修当时的 `TerminalSurface`”作为长期方案。它在迁移期可作 fallback，
但不再新增布局能力；OI-14H 已将其删除。

---

## 5. 目标架构

```text
                           非 TTY / --print / JSON
SessionEvent ------------------------------------------> plain formatter -> stream
    |
    v
packages/shared: reduceCliTuiState(state, action)
    |
    +-- transcript blocks: raw source + stable id + status
    +-- active segment: thinking/tool/search/retry + segment timer
    +-- composer: mode（value/cursor/history/undo/menu 由 CLI-local 常驻组件拥有）
    +-- overlay: permission/question/picker/diff
    +-- terminal: width/height/focus/scroll position
    |
    v
packages/cli: Bolo component tree
    |
    +-- WelcomeBlock
    +-- TranscriptViewport
    |     +-- UserBlock
    |     +-- ThoughtBlock
    |     +-- ToolBlock
    |     +-- AssistantMarkdownBlock
    |     +-- Error/Warning/SearchBlock
    +-- ActivityRow
    +-- Composer
    +-- StatusFooter
    +-- OverlayHost
    |
    v
retained renderer -> width-aware physical lines -> one differential terminal writer
```

### 5.1 状态边界

- `packages/shared` 的 reducer 是纯函数，不读 terminal、不写 stdout、不持有 timer。
- 现有 `turnTimeline.ts` / `timelineCards.ts` 的 stable id、tool status 与错误可见性语义
  继续复用；新增 live CLI view-state，不在 renderer 中重建第二状态机。
- transcript block 保存 raw Markdown/source 和业务状态，不保存已经折好的终端行。
- timer 产生 action；Thought 记录每个 segment 的独立耗时，不使用整轮累计时间。
- renderer 只消费 view-state、theme 与当前 viewport。
- Bolo terminal adapter 是动态 TUI 中唯一允许写 stdout/cursor control 的层；
  `ProcessTerminal` 不进入产物。

OI-14B 已按此边界完成：

- `CliTuiViewState` 保存有序 user/assistant/reasoning/tool/search/error/warning/summary
  block、turn 终态、composer/overlay mode 与 segment elapsed，不保存折行结果。
- assistant/reasoning 只合并当前 open segment；tool 以 call id、hosted search 以
  query cycle 原位更新，finalized block 不重新打开。
- `SessionEvent`、`QueryLoopEvent`、`ToolExecutionEvent` 结构兼容投影与
  `ChatMessage[]` resume 共用同一 reducer action 语义。
- 整段、逐字符与固定随机 chunk 的最终 state 深相等；缺失 tool result、显式空输出、
  persisted tool error、abort/error 均有不同终态。

### 5.2 组件所有权

| 能力 | 唯一 owner |
|------|------------|
| block 顺序、稳定 id、stream merge | `CliTuiViewState` reducer |
| paragraph/list/code/link wrap | Markdown/Text component |
| gutter、padding、block gap | 父级 layout component |
| cursor、erase、diff、resize | 根 renderer |
| editor value/cursor/undo/history/menu | CLI-local 常驻 `RetainedComposer` |
| thinking/tool elapsed | activity controller -> state action |
| permission 选择与详情 | OverlayHost + permission view-model |
| 非 TTY 文本 | plain formatter |

### 5.3 强制不变量

1. 每个组件 `render(width)` 返回的可见 cell 宽度不超过 `width`。
2. 任意 provider chunk 切分方式产生相同的最终 view-state 和最终屏幕。
3. 终端 resize 后从 raw source 重排，不复用旧宽度的物理行。
4. running 时 Composer 节点仍在树中，只改变 mode/光标可见性。
5. block 间距由父组件的 gap/Spacer 产生；正文字符串不承担 section margin。
6. 用户块与 composer 使用同一可用宽度；Agent 全部物理续行使用同一 gutter。
7. primary buffer 与原生 scrollback 默认保留，不使用 alternate screen 隐藏会话历史。
8. permission/picker/diff 作为 overlay 或 child component，不与根 renderer 争夺 stdout。

---

## 6. 布局与交互规范

| 场景 | 必须结果 |
|------|----------|
| 用户消息 | 内容区内全宽灰块；内边距固定；多行按 cell width 折行 |
| 用户块 -> Agent | 固定一整行 section gap，由 transcript parent 拥有 |
| Agent 正文 | 宽屏 4 cells、中屏 2 cells、极窄 0；所有物理续行一致 |
| Markdown 列表 | marker 与正文使用 hanging indent；嵌套列表保持层级 |
| 长 URL/长 token | 在可用 cell width 内安全折行；ANSI/OSC 8 状态跨行正确 |
| 段落/代码块/表格 | block renderer 决定内部间距，不把 stream chunk 当段落 |
| Thinking | 活动动画稳定；每段完成后最多一个 `Thought for <duration>` |
| Tool/Search/Retry | 结构化 block；progress 更新原 block，不刷永久重复行 |
| 最终回答 -> Composer | 固定一整行 gap；输入框不消失、不跳列 |
| Composer | 水平方向使用与用户块相同的可用宽度；running 时保留 |
| Footer | model/mode/effort、快捷键与 token 信息按优先级裁切，不互相覆盖 |
| Permission | 显示 tool、command/cwd/关键参数和 once/always/deny；默认 deny |
| Resize | transcript、overlay、composer 在新宽度同一帧重排，无旧行残影 |
| 多行 paste | 一次事务插入、一次合并重绘，不误提交、不拉乱 viewport |

欢迎页继续使用 Bolo Crystal，不复制 Claude、Grok 或其他产品的品牌文案、图标和配色。
它也必须成为普通 component；welcome、transcript 和 composer 不能各有一套宽度算法。

---

## 7. 模块迁移结果

| 当前模块 | 去向 |
|----------|------|
| `formatSessionEvent.ts` | 保留 plain formatter；TTY direct printer 改为 state action adapter |
| `terminalSurface.ts` | 已删除；dynamic TTY 只使用 retained root |
| `contentLayout.ts` | 跨 chunk prefixer 已删除；只保留 retained gutter 解析 |
| `terminalMarkdown.ts` | 已删除；由成熟 block Markdown component 替代 |
| `terminalText.ts` | 仅保留确有 Bolo 专用的 plain/字段 helper；通用 width/wrap 不维护重复实现 |
| `composerSpacing.ts` | 已删除；gap 由 transcript/composer parent layout 拥有 |
| `inputBox.ts` | 保留 Bolo input/slash/status reducer、纯 renderer、capability 与结果类型；raw driver 已删除 |
| `turnActivity.ts` | 保留分段计时语义；retained 通过 child state 消费 frame，不直接写 stdout |
| `permissionPanel.ts` | 保留安全摘要/decision view-model；renderer 迁到 overlay component |
| `localPanel.ts` | 已删除；picker/permission/diff 由 OverlayHost 或文本回落承载 |
| `contextDashboard.ts` | 保留 view-model；改为 width-aware component |
| `crystalLogo.ts` / welcome | 保留 Bolo 资产；包成普通 responsive component |
| `resumeCli.ts` | 每个交互会话只创建一个 `CliTuiController`，不再每轮重建 surface/editor |

OI-14H 已删除 `suspendForLegacyPanel()` compatibility API 与 legacy panel；
ownership guard 禁止新功能重新接入第二 terminal owner。

---

## 8. 实施切片

每个代码切片均按先红灯、后实现，代码/测试与文档分批中文 commit/push。OI-14G
迁移期曾以 legacy engine 作短期回滚；H 已删除该入口，非 TTY fallback 始终独立保留。

| 顺序 | 切片 | 交付 | 自动关闭条件 |
|------|------|------|--------------|
| **OI-14A ✅** | 真实终端红灯与依赖决策 | `@xterm/headless` 物理终端 harness；复现最新截图故障；Pi direct/fork 与 OpenTUI 备选 spike；许可证/Node/体积报告 | 四项 legacy 签名稳定；选型数据与 direct/Node 决定已固化 |
| **OI-14B ✅** | Live view-state | `packages/shared` 的 `CliTuiViewState`、action/reducer、stable block id、stream merge、segment 与 composer mode | reducer 无 I/O；随机 chunk property、resume projection、error/tool 边界全绿 |
| **OI-14C ✅** | Renderer 基座 | 单 terminal writer、根 component tree、theme/width/resize、welcome、legacy feature flag | 24/38/56/80/120/160/220 列无超宽物理行；resize 无残影；plain path byte-stable |
| **OI-14D ✅** | Transcript 与 Markdown | User/Assistant/Thought/Tool/Search/Error/Warning/Summary blocks；成熟 Markdown/wrap；父级 spacing | 真实 VT、列表 hanging indent、URL、CJK/emoji、ANSI/OSC 8、代码块、表格、chunk/resize/resume 全绿 |
| **OI-14E ✅** | 常驻 Composer/Activity/Footer | Bolo retained Composer、slash menu/argument hint、paste、per-segment activity、usage/footer | idle/running 不卸载 Composer；输入/最终回答间距稳定；burst stream 无闪烁或逐 token 全重绘 |
| **OI-14F ✅** | Overlay 与交互面板 | permission/question/provider/effort/diff/pager 迁入 OverlayHost | 面板显示完整操作详情；默认 deny；Esc/Ctrl+C/focus 恢复；无第二 stdout owner |
| **OI-14G ✅** | 默认切换与可靠性 | retained 成为默认；scroll/resize/backpressure/perf；dist/pack/install/Windows 邻接轨 | 完整门禁、单文件 dist、冷启动/输入延迟预算、长会话和 crash cleanup 全绿 |
| **OI-14H ✅ AUTO** | 删除 legacy 与文档收口 | 删除旧 surface/prefixer/tiny Markdown/兼容桥/engine selector；更新 README/TUI/ROADMAP/handoff/release/notices | 静态 guard 禁止活跃 TUI 绕过 terminal adapter；134 scripts 与发布邻接全绿。真人场景独立移交 OI-H3 |

### 8.1 切片停止条件

- 需要把业务状态机搬进第三方 renderer。
- direct dependency 要求运行时联网、遥测或未披露 native 资产。
- 许可证/NOTICE 不清楚。
- Node 支持范围、包体或启动成本发生产品级变化却没有记录。
- legacy 与 retained 同时处理同一个 input/event。
- 为赶截图效果再次新增 raw cursor patch、字符串 spacer 或 terminal auto-wrap 依赖。

---

## 9. 测试与质量门

### 9.1 物理终端红灯

新的 `test:cli-tui-vt` 必须使用有真实 `cols/rows/auto-wrap` 的 headless terminal。
首个 fixture 固定覆盖：

```text
220 列用户块
-> 一整行 section gap
-> Thought
-> 含 ANSI 与超长 Markdown URL 的 Agent 段落
-> 列表与 CJK/emoji
-> provider 以 1 字符、随机长度、整段三种 chunk 方式流式输入
-> running composer 持续重绘
-> resize 220 -> 38 -> 120
-> turn 完成并回到 idle composer
```

三种 chunk 方式的最终屏幕必须相同；每帧不得出现超出 viewport 的可见行；Agent
续行不得回到第 0 列；composer 前后只允许规范定义的一行 gap。

### 9.2 自动矩阵

| 层 | 覆盖 |
|----|------|
| reducer | stable id、stream merge、tool/reasoning/error 边界、per-segment timer、abort/resume |
| component | 24/38/56/80/120/160/220 列；Unicode/ASCII/NO_COLOR；padding/gap |
| Markdown | paragraph、标题、列表/嵌套列表、blockquote、code fence、table、长 URL/token、OSC 8 |
| editor | CJK/emoji cursor、undo/history、slash menu、argument hint、paste、multiline |
| VT | auto-wrap、cursor、erase、resize、scrollback、overlay、crash cleanup |
| compatibility | `TERM=dumb`、raw mode 不可用、pipe、`--print`、JSON、stderr |
| distribution | typecheck、full test、esbuild、pack/install/run、license/asset 清单 |

### 9.3 性能预算

Phase A 先记录 baseline，Phase G 固定门槛：

- streaming burst 合并重绘，默认不高于一帧一次，turn 完成立即 flush。
- 500 个 transcript blocks 与 10,000 行 Markdown fixture 下，输入 p95 不超过 50ms。
- resize 重排 p95 不超过 200ms。
- cold start 相对 baseline 增量目标不超过 100ms。
- 单文件未压缩产物增量目标不超过 1.5MB。
- 同一 500-block/10,000-line retained discard-writer fixture 的 CPU 不超过 3s。
- render heap 增量不超过 128MB；stop、丢弃引用并 GC 后 retained 增量不超过 64MB。

OI-14G 完整串实测：输入 p95 `0.1ms`、resize p95 `50.8ms`、cold 相对 empty Node
`+50.4ms`、单文件 1,727,232 bytes / 200 modules（相对 1,385,065B 基线
`+342,167B`）、CPU `422ms`、render heap `+21.0MB`、cleanup retained `+1.5MB`。
这些阈值已由 `test-cli-tui-budget.ts` 固化；超出时必须解释或修复，不能直接放宽。

### 9.4 真人 Windows Terminal

自动门禁全绿后，OI-H3 仍必须由真人检查：

1. 80/120/220 列启动与 Bolo Crystal。
2. 长 URL、Markdown 列表、代码块、中英混排与 emoji。
3. 流式回答时输入区持续存在，Thinking 动画与每段 Thought 正确。
4. 回答中 resize、滚动历史、输入多行 paste，不跳到只剩几行内容。
5. permission once/always/deny 显示完整 command/cwd/关键参数。
6. `/`、`/d`、`/effort `、`/context`、Plugin/Skill 候选和键盘导航。
7. Ctrl+C、异常退出和下一次 shell prompt 的 cursor/raw mode 恢复。

只有字体、颜色主观观感和真人按键手感留在 OI-H3；上述已知布局故障必须先由自动门禁
关闭，不能再用 `BLOCKED: HUMAN` 代替实现。

---

## 10. 完成定义

OI-14 只有同时满足以下条件才可 `CLOSED`：

- 最新截图中的碎片化、巨大空洞、续行贴左和 user/agent 贴近全部有红/绿 VT fixture。
- 活跃 TUI 只有一个 terminal writer；静态检查允许 adapter 写 stdout，禁止组件直写。
- 所有可见行由当前 width 生成，终端自动 wrap 不再参与正常布局。
- streaming chunk 边界不改变最终 state、physical lines 或 block spacing。
- composer 在 idle/running/permission 状态下保持同一节点和输入 state。
- Markdown/list/link/code/CJK/emoji/ANSI/OSC 8 与 resize 矩阵全绿。
- slash、context、permission、diff、paste 与 non-TTY 现有功能无回退。
- esbuild 单文件、pack/install/run、Desktop 邻接门禁和完整 `npm test` 全绿。
- 第三方版本、许可证、NOTICE、Node 支持范围、包体和启动成本已记录。
- legacy surface/prefixer/tiny Markdown 已删除，或有明确的最后删除 blocker 和期限。
- ROADMAP、OPEN_ISSUES、TUI、README、AGENT_HANDOFF、RELEASE 口径一致。

---

## 11. 风险与控制

| 风险 | 控制 |
|------|------|
| Pi Node engine 高于 Bolo 旧声明 | OI-14A 已把 Bolo 提升到 `>=22.19.0`，不宣称支持已 EOL 的 Node 20 |
| 第三方 renderer 带入产品副作用 | 只用公共 TUI API；显式 Bolo log dir；无遥测/运行时网络静态与动态检查 |
| fork 漂移 | 固定来源 commit、MIT attribution、差异清单、定期跑上游 width/Markdown 测试 |
| primary-buffer scrollback 与 resize 冲突 | xterm physical-screen + scrollback 测试；保留 raw source；不默认 alternate screen |
| 高频 token 导致 CPU/闪烁 | render coalescing/backpressure；final/error/permission 立即 flush |
| 长会话重排变慢 | component cache、stable id、可见窗口/已完成 block 策略；先测量再优化 |
| ANSI/OSC 污染布局或安全 | 使用成熟 parser/wrapper；未知控制序列过滤；宽度测试覆盖 hyperlink |
| 第二 renderer/writer 复活 | 无 engine flag/resolver；composition 与静态 owner guard 锁定单 adapter |
| legacy 重新引入 | OI-14H 已物理删除并加 owner/absence guard；新功能禁止重新接入 |
| 私有源码污染 | HC 可作内部功能复用来源，但公开产物不得泄露私有源码/路径/品牌或未授权第三方内容 |

---

## 12. 提交与回滚

建议中文提交顺序：

1. `test(tui): 用真实终端复现物理折行与光标错位`
2. `build(tui): 锁定 retained renderer 依赖与 Node 基线`
3. `feat(tui): 建立实时会话视图状态`
4. `feat(tui): 接入单一 retained 渲染表面`
5. `feat(tui): 迁移 Markdown 与会话时间线`
6. `feat(tui): 迁移常驻输入区和活动状态`
7. `feat(tui): 迁移权限与交互面板`
8. `perf(tui): 收口 resize 滚动与流式背压`
9. `refactor(tui): 删除旧终端表面与字符串布局`
10. `docs(tui): 同步 OI-14 完成证据与用户文档`

每个代码提交只承载一个行为切片；对应定向测试、typecheck、完整门禁与
`git diff --check` 通过后立即 push。文档水位独立提交。OI-14G 迁移期曾用
`BOLO_TUI_ENGINE=legacy` 作短期回滚；OI-14H 已删除该入口，同时保留会话、
transcript、配置和 non-TTY/plain 数据契约。

---

## 13. 完成状态与真人后置

OI-14H 自动部分已完成：

1. `39e66b4` 建立静态 owner 红灯，锁定 dynamic TTY 只能经
   `BoloTerminalAdapter` 持有 stdout/stdin/raw mode。
2. `b41b37c`–`faa97ad` 删除 compatibility bridge、legacy runtime pager/picker，
   并把非动态 permission/diff/question 回落收敛为明确文本。
3. `0ee318f`–`203a565` 删除 local panels、`TerminalSurface`、raw editor/spacer、
   跨 chunk prefixer 与 tiny Markdown；保留 shared reducers、retained components 和
   `formatSessionEvent.ts` plain formatter。
4. `d4eaed0` 删除 engine resolver、类型、环境变量成功契约与 fixture；双 TTY/raw-mode
   只走 retained，能力不足只走 plain/readline。
5. 134 脚本、预算、dist/pack/install、Desktop/Electron、第三方 notices 与静态 owner/
   absence guard 全绿；根 `dependencies` 为 `{}`，当前单文件 1,692,863 bytes /
   195 modules，三次完整串 cold `+46.8–84.4ms`、CPU `328–672ms`、render heap
   `+21.0–21.1MB`、cleanup retained `+1.5MB`。
6. `e6ec6cb` 用确定性挂起的 durable interrupt handler 证明并关闭下一轮 Composer
   提前获取 stdin 的竞态；恢复后可继续编辑，idle Ctrl+C 仍正常退出。
7. `6b7ff99` 让 retained turn 期间继续持有 raw stdin，并用 Pi TUI 全局 listener
   在 focus 分发前消费 `Esc` 主键 / `Ctrl+C` 兼容键；overlay 激活时不截获，
   主动 abort 不输出内部 turn id/warning。离线慢流 retained PTY 连续两轮中断、
   恢复输入与 `/exit` 通过。

只剩 §9.4 的真人 Windows Terminal 核心场景：记录字体、颜色、动画和按键/鼠标手感。
它由 [OPEN_ISSUES.md](./OPEN_ISSUES.md) OI-H3 保持 `BLOCKED: HUMAN`；任何能在
headless terminal 复现的缺陷仍必须回到自动队列，不能降级为人工 blocker。

继续禁止对 `TerminalSurface`、`contentPrefixer`、tiny Markdown 或 composer spacer
添加新的布局补丁，也禁止重新引入 engine selector 或第二 terminal owner。

---

## 14. OI-15 · slash 命令 surface 与生命周期

### 14.1 问题与根因

2026-07-29 的真人走查确认：`/context`、`/skills`、`/plugins`、`/doctor` 等本地
命令每执行一次，结果都会永久留在 Composer 上方；重复查询会把整个可见区域逐步
挤满。这不是 Context dashboard 的样式问题，而是 slash 结果没有显示生命周期。

当前数据流如下：

```text
SlashDispatchResult { ok, message, contextView? ... }
  -> runOnePrompt().writeSlashOutput()
  -> retained controller.writeOutput()
  -> RetainedRoot.appendCompatibilityOutput()
  -> outputText += text（最多 65,536 字符）
  -> welcome / transcript / compatibilityOutput / activity / composer / footer
```

`SlashDispatchResult` 能表达内容和少数交互意图，却不能表达：

- 结果应该进入 history、临时 panel、toast 还是 overlay；
- 同一个命令再次执行时替换、去重还是追加；
- 何时由新输入、`Esc`、TTL、session switch 或 reset 清除；
- 长内容何时升级为 pager；
- 异步结果是否仍属于当前 session/cwd/request；
- 是否允许进入模型消息、session persistence 或 resume。

slash 输入本身已通过 `beginTurn({ echoUser: true, activity: false })` 进入 typed
transcript，slash 输出却绕过 reducer，落入单一追加字符串桶。这种“一半 typed、
一半 compatibility string”的双路径是直接根因。

### 14.2 五个参考项目的可借鉴结论

| 项目 | 实际机制 | Bolo 借鉴 | 不照搬 |
|------|----------|-----------|--------|
| **Pi** | `notify`、keyed `setStatus`、keyed `setWidget`、focused overlay 分通道；widget 可放 editor 上/下，按 key 替换，`undefined` 清除，字符串最多 10 行 | surface primitive 分层、keyed replace、显式 clear、editor 邻接位置 | Pi 没有内建 `/context`；不复制其业务命令或整个 coding-agent |
| **oh-my-pi** | `/context` 是 typed `TranscriptBlock`，但 `presentCommandOutput()` 仍把它加入 `chatContainer`；连续 status 可原位替换 | typed panel、streaming 时延迟插入、status replace/append 按语义区分 | 漂亮面板仍会永久累积，不能作为 lifecycle 答案 |
| **HelsincyCode** | notification queue 有默认 8 秒 TTL、priority、key 去重/fold、invalidates、抢占和 timer 清理；local JSX 有独立 slot/focus restore | notification queue、临时 local view、focus restore | 普通空闲 `/context` 实际仍会进入 messages；视觉上移出视口不等于已删除 |
| **Codex** | history cell、bottom pane、overlay、composer、transient status 分开；`/skills` 用 selection view；`/plugins` 用稳定 view ID，把 loading 原位 replace 为结果，并忽略迟到请求 | stable view key、replace/dismiss、generation/request guard、失败单独进入 durable error | `/status` 本身仍可写 history；不复制 Rust/Ratatui 实现 |
| **OpenCode** | 单 current toast，默认 5 秒，新 toast 替换旧项并取消旧 timer；dialog `replace()` 清旧栈并恢复 focus；context usage 在 sidebar | toast/dialog/status 的用途映射、单 owner、绝对/底部 surface 不增加 transcript | 不引入 Solid/OpenTUI/Bun 依赖栈 |

共同原则是“先按命令意图选 surface，再决定 lifetime”，而不是给所有 slash 输出统一
增加 TTL。OI-15 只借鉴这些状态与 owner 边界，继续使用 Bolo 当前 Pi TUI retained
基座和 OverlayHost，不增加第三方运行时依赖。

### 14.3 四类输出与布局决定

| Surface | 用途 | 默认位置与高度 | 生命周期 | 持久化 |
|---------|------|----------------|----------|--------|
| `history` | 真正需要审计的动作、不可恢复错误、用户明确要求保留的报告 | typed transcript block | append；随 history 正常滚动 | 明确声明；默认不进模型消息 |
| `panel` | `/context`、`/doctor` 摘要、只读 status/help/memory/hooks 等当前状态 | **Composer 下方、footer 上方**的单 replaceable slot；最多 10 行且不超过可用 rows 的 40% | 新 panel 替换旧 panel；首个编辑输入、`Esc`、session switch/reset 清除；命令可声明 TTL | never |
| `toast` | reload/set/copy 等短成功、警告或可立即修正的失败 | footer 的单行辅助状态，不增加 transcript 或主布局高度 | 默认 5 秒；新 toast 替换旧 toast并取消旧 timer；输入可提前清除 | never |
| `overlay` | Skills/Plugins picker、长诊断、pager、需要焦点的交互 | 现有 OverlayHost | stable key replace；`Esc`/完成关闭并恢复 Composer focus | never |

约束：

1. 同一时刻最多一个 panel、一个 toast、一个 focused overlay；任何一类都不能用数组
   模拟 history。
2. panel 在 Composer 下方，不再占用“对话正文与 Composer 之间”的主工作区；出现时
   transcript viewport 可有界缩小，但连续调用不会继续缩小。
3. panel 内容超过上限时不得静默截断为不可读碎片：命令必须提供 compact view，
   或升级到 pager overlay。默认 `/context` 始终使用 compact panel，
   `/context details` 使用 pager。
4. slash 命令的灰色用户输入块可继续留在视觉 transcript，满足操作可追溯性；结果
   不得因此进入模型上下文或 session message persistence。
5. `ok: false` 不自动等于 durable history。语法错误、取消和可重试失败可用
   error toast/panel；只有命令显式声明的不可恢复/需审计错误才进入 typed history。

### 14.4 packages-first 类型契约

第一刀在 `packages/core` 定义与 renderer 无关的 discriminated union；`message`
继续作为 plain/non-TTY fallback，保证旧调用方与脚本输出可渐进迁移：

```ts
type SlashDisplayPolicy =
  | {
      surface: 'history'
      tone: 'info' | 'success' | 'warning' | 'error'
      persistence: 'visual-only'
    }
  | {
      surface: 'panel'
      key: string
      placement: 'below-composer'
      dismissOnInput: boolean
      dismissOnEscape: boolean
      ttlMs?: number
      overflow: 'compact' | 'pager'
    }
  | {
      surface: 'toast'
      key: string
      tone: 'info' | 'success' | 'warning' | 'error'
      ttlMs: number
    }
  | {
      surface: 'overlay'
      key: string
      view: 'picker' | 'pager' | 'diff'
    }

type SlashDispatchResult = {
  ok: boolean
  message: string
  // handler 可显式覆盖；中央 dispatch 负责补齐
  display?: SlashDisplayPolicy
  // 既有 contextView / interactive* payload 渐进迁移
}

type ResolvedSlashDispatchResult = SlashDispatchResult & {
  display: SlashDisplayPolicy
}
```

禁止把 Pi `Component`、terminal columns、timer handle 或 CLI callback 放进 core。
OI-15A 已让 `SlashCommandDef.display` 成为内建注册表必填字段，并在中央 dispatch
完成校验/归一化；35 个内建命令全部分类，未分类 Plugin/Skill 使用 visual-only
history，unknown/非法参数使用 error toast。OI-15B 已建立 retained consumer
primitive。OI-15C 已迁移 panel 与 pager policy：短查询进入单 panel，声明
`overflow: pager` 的长内容按真实 viewport 升级，显式 pager 即使单页也打开；迁移命令
不再进入 compatibility。Skills/Plugins、toast/history 仍留给 OI-15D–E，OI-15F
再用定向门禁禁止所有 normal slash result 调用 `appendCompatibilityOutput()`。

`packages/shared`/CLI retained state 新增单槽状态和纯 action：

```text
commandSurface
  panel?: { key, generation, content, policy }
  toast?: { key, generation, content, tone, ttlMs }
  nextGeneration: number

show/replace_panel · dismiss_panel
show/replace_toast · expire_toast
accepted_input · escape · reset
```

reducer 不持有 timer。CLI effect 层创建 timer，并在回调中携带
`key + generation`；过期 timer 不能清掉后来替换的新内容。每次 dispatch 生成
request generation，并记录 session id、cwd 和 command key；异步完成时若任一项已
变化则丢弃迟到结果。resize 只用现有 raw/typed content 重排，不改变 lifetime。

### 14.5 清除与按键优先级

1. focused overlay 独占输入；`Esc` 先关闭 overlay并恢复 Composer focus。
2. running turn 的 `Esc` 仍是 interrupt；运行中不得让旧 panel 抢键。
3. idle Composer 第一次产生 value mutation 时，先 dispatch `accepted_input` 清除
   panel/toast，再更新 slash menu；方向键浏览 history 不算新输入。
4. idle 且没有输入 mutation 时，`Esc` 依次关闭 slash menu、panel；没有可关闭项时
   保持现有 idle 语义。
5. TTL、同 key replace、不同 panel replace、session switch、`/clear` 与进程 stop
   都必须取消旧 timer；timer callback 只能按 generation 关闭自己的 surface。

### 14.6 命令迁移表

| 命令意图 | 目标 surface | 具体策略 |
|----------|--------------|----------|
| `/context` | panel | key `slash:context`；compact dashboard；12 秒、新输入或 `Esc` 清除；footer 始终只保留精简 token 百分比 |
| `/context details` | pager overlay | key `slash:context:details`；关闭后回到原 Composer value/focus |
| `/skills [filter]` | picker overlay | key `slash:skills`；同 key loading/result 原位替换；选择/取消后关闭 |
| `/plugins`、`/plugins market/search` | picker/pager overlay | key `slash:plugins:<mode>`；异步结果带 session/cwd/generation guard |
| `/plugins reload/install/uninstall` 等动作 | toast；失败可升级 history | 成功/可重试失败 5 秒；文件损坏、回滚失败等需审计错误进入 typed error |
| `/doctor` | panel | 结构化摘要；新输入/`Esc` 清除；内容超过上限升级 pager，不把 dump 截断塞入 panel |
| `/help`、`/mcp`、`/hooks`、`/memory`、`/cost`、只读 status | panel 或 pager | 每个逻辑视图 stable key；重复命令 replace；长列表走 pager |
| `/provider`、`/effort`、`/diff` | 现有 overlay | 迁入统一 display policy，删除并行 `interactiveProvider`/`interactiveEffort`/`interactiveDiff` 分支 |
| `/title`、设置开关、queue/interrupt 等短动作 | toast 或 history | 纯确认用 toast；影响 durable runtime 且需要追溯的动作保留 typed history |
| 未迁移 Plugin/Skill command | explicit fallback | Plugin API 后续允许声明 policy；声明前使用有界 history，不得进入无界 compatibility bucket |

### 14.7 实施切片

| 顺序 | 切片 | 交付 | 关闭条件 |
|------|------|------|----------|
| **OI-15A ✅ · `d681734`** | core display policy + 红灯 | discriminated union、运行时校验/归一化、35 个内建分类、Plugin/Skill/unknown fallback；独立 script + 默认门禁 | 非法 policy fail-closed；plain `message` byte-stable；完整 `npm test` 通过 |
| **OI-15B ✅ · `d6bd087`** | retained single-slot state | panel/toast state、generation、effect timer、Composer 下方组件、input/Esc/reset/restore/stop 清除 | 连续 20 次 replace 高度不增长；TTL/replace/timer race/resize 全绿 |
| **OI-15C ✅ · `26f796f`** | context/doctor/status 迁移 | context compact panel/details text pager；doctor/status/help/memory/mcp/hooks 等只读诊断映射 | 20× replace；单页/multi-page/resize/CJK；compatibility/plain writer 为 0；不进入 session messages |
| **OI-15D** | Skills/Plugins overlay | picker/pager、loading→result 原位 replace、focus restore、stale async guard | cwd/session/request 变化忽略迟到结果；取消后输入原值与光标恢复 |
| **OI-15E** | toast 与错误分级 | action feedback、priority/tone、durable error 显式策略 | 新 toast 取消旧 timer；短反馈不改变 transcript 高度；不可恢复错误可审计 |
| **OI-15F** | 清理兼容桶与发布收口 | normal slash 不再走 compatibilityOutput；旧 `interactive*` 字段迁移/删除；docs/dist 审计 | 真实 VT、plain/JSON、full test、pack/install、owner guard 全绿 |

每个代码切片先写红灯，再实现；代码/测试与文档分批使用中文 commit 并 push。
不在本阶段引入新 renderer、UI framework、状态库或其它 Agent 的运行时依赖。

### 14.8 自动门禁与真人验收

自动门禁至少覆盖：

- core policy 的 exhaustive switch、非法 TTL/key/placement、Plugin fallback；
- 24/38/80/160 列下 panel 位于 Composer 下方、最大高度和 pager upgrade；
- 连续执行 20 次 `/context`、`/doctor`、`/skills`、`/plugins`，主布局高度有界；
- 同 key/different key replace、TTL fake clock、旧 timer 与迟到 async result；
- 编辑输入清除、`Esc` 优先级、overlay focus/value/cursor restore；
- running/activity/permission 与 panel 不争抢 stdin、writer 或 layout owner；
- `/clear`、session switch、resume、resize、abort、crash cleanup；
- non-TTY、pipe、`--print`、JSON 输出无 ANSI、无 timer 副作用且文本兼容；
- transient 不进入 `ChatMessage[]`、JSONL、compact、resume 或模型输入；
- normal slash output 不再命中 `appendCompatibilityOutput()` 的静态 guard。

OI-H3 真人补充检查 panel 在 Composer 下方的阅读节奏、12 秒 Context 时长、动画/
输入手感和窄窗口可读性。若真人发现可由 xterm 复现的布局或按键缺陷，必须回到
OI-15 自动队列，不能只记为主观验收。

### 14.9 回滚边界

- `message` 始终保留为 plain fallback；回滚某个命令的 UI 映射时改回显式
  visual-only history policy，不回滚 core 命令行为、session 数据或 renderer。
- OI-15D–E 期间允许未分类命令走有界兼容 history，但已迁移命令不得双写
  history + panel/toast。
- 不恢复 OI-14 已删除的 `TerminalSurface`、engine selector、局部 raw input owner
  或第二 stdout writer。
- OI-15F 删除正常 slash 的 compatibility 路径前，必须有命令注册表 completeness
  测试；发现漏项时回滚该清理提交，而不是放宽 owner guard。
