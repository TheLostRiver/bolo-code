# CLI TUI retained renderer 重构方案

> **状态：** OI-14 `OPEN`（OI-14A/B/C/D 已关闭；当前 OI-14E）
> **方案锚点：** Bolo `c2e6a98`；Pi `c820aa26fe09`；oh-my-pi
> `d16c6168c86f`；Codex `f61b51ddd924`；OpenCode `66495a2a22cd`；
> HelsincyCode `e6dd86ef990e`。
> **OI-14A 交付：** `1ae9f53` · `f04f8de` ·
> [CLI_TUI_RENDERER_DECISION.md](./CLI_TUI_RENDERER_DECISION.md)。
> **OI-14B 交付：** `269b39c` ·
> `packages/shared/src/cliTuiViewState.ts`。
> **OI-14C 交付：** `1798a7c` · retained renderer 基座。
> **OI-14D 交付：** `8b060e5` · retained transcript/Markdown。
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
Markdown、width、Editor 和基础组件；Bolo 自己实现
SessionEvent adapter 与领域组件。

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

不得选择“继续修当前 `TerminalSurface`”作为长期方案。它可以在迁移期开 fallback，
但不再新增布局能力。

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
    +-- composer: value/cursor/menu/mode
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
- `ProcessTerminal` 或等价 adapter 是动态 TUI 中唯一允许写 stdout/cursor control 的层。

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
| editor value/cursor/undo/history/menu | 常驻 Composer/Editor |
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

## 7. 现有模块迁移

| 当前模块 | 去向 |
|----------|------|
| `formatSessionEvent.ts` | 保留 plain formatter；TTY direct printer 改为 state action adapter |
| `terminalSurface.ts` | retained renderer 默认后删除 |
| `contentLayout.ts` | 删除跨 chunk prefixer；gutter 迁入 layout component |
| `terminalMarkdown.ts` | 由成熟 block Markdown component 替代 |
| `terminalText.ts` | 仅保留确有 Bolo 专用的 plain/字段 helper；通用 width/wrap 不维护重复实现 |
| `composerSpacing.ts` | 删除；gap 由 transcript/composer parent layout 拥有 |
| `inputBox.ts` | 保留 Bolo slash/status view-model；编辑、wrap、cursor 迁到常驻 Editor |
| `turnActivity.ts` | 保留分段计时语义；输出改为 state action |
| `permissionPanel.ts` | 保留安全摘要/decision view-model；renderer 迁到 overlay component |
| `localPanel.ts` | picker/permission/diff 全部组件化后删除 |
| `contextDashboard.ts` | 保留 view-model；改为 width-aware component |
| `crystalLogo.ts` / welcome | 保留 Bolo 资产；包成普通 responsive component |
| `resumeCli.ts` | 每个交互会话只创建一个 `CliTuiController`，不再每轮重建 surface/editor |

迁移期允许一个明确的 `suspendForLegacyPanel()` 适配边界，但它只能由根 controller
调用，且必须有删除 issue；新功能不得继续接入 legacy panel。

---

## 8. 实施切片

每个代码切片先红灯、后实现，代码/测试与文档分批中文 commit/push。任何阶段失败都可
把 `BOLO_TUI_ENGINE=legacy` 作为短期回滚；非 TTY fallback 始终独立保留。

| 顺序 | 切片 | 交付 | 自动关闭条件 |
|------|------|------|--------------|
| **OI-14A ✅** | 真实终端红灯与依赖决策 | `@xterm/headless` 物理终端 harness；复现最新截图故障；Pi direct/fork 与 OpenTUI 备选 spike；许可证/Node/体积报告 | 四项 legacy 签名稳定；选型数据与 direct/Node 决定已固化 |
| **OI-14B ✅** | Live view-state | `packages/shared` 的 `CliTuiViewState`、action/reducer、stable block id、stream merge、segment 与 composer mode | reducer 无 I/O；随机 chunk property、resume projection、error/tool 边界全绿 |
| **OI-14C ✅** | Renderer 基座 | 单 terminal writer、根 component tree、theme/width/resize、welcome、legacy feature flag | 24/38/56/80/120/160/220 列无超宽物理行；resize 无残影；plain path byte-stable |
| **OI-14D ✅** | Transcript 与 Markdown | User/Assistant/Thought/Tool/Search/Error/Warning/Summary blocks；成熟 Markdown/wrap；父级 spacing | 真实 VT、列表 hanging indent、URL、CJK/emoji、ANSI/OSC 8、代码块、表格、chunk/resize/resume 全绿 |
| **OI-14E** | 常驻 Composer/Activity/Footer | Editor、slash menu/argument hint、paste、per-segment activity、usage/footer | idle/running 不卸载 editor；输入/最终回答间距稳定；burst stream 无闪烁或逐 token 全重绘 |
| **OI-14F** | Overlay 与交互面板 | permission/question/provider/effort/diff/pager 迁入 OverlayHost | 面板显示完整操作详情；默认 deny；Esc/Ctrl+C/focus 恢复；无第二 stdout owner |
| **OI-14G** | 默认切换与可靠性 | retained 成为默认；scroll/resize/backpressure/perf；dist/pack/install/Windows 邻接轨 | 完整门禁、单文件 dist、冷启动/输入延迟预算、长会话和 crash cleanup 全绿 |
| **OI-14H** | 删除 legacy 与文档收口 | 删除旧 surface/prefixer/tiny Markdown/兼容桥；更新 README/TUI/ROADMAP/handoff/release/NOTICE | 静态 guard 禁止活跃 TUI 绕过 terminal adapter；真人 Windows Terminal 核心场景通过 |

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

质量优先于体积。超过软预算可以接受，但必须有测量、原因和用户收益，不能用猜测或
“零依赖”口号决定。

### 9.4 真人 Windows Terminal

自动门禁全绿后，OI-14H 前必须真人检查：

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
| 双 renderer 竞争 | feature flag 只能二选一；controller 建立时锁定 engine |
| legacy 永久残留 | OI-14H 删除条件写入看板；新功能禁止接 legacy |
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
`git diff --check` 通过后立即 push。文档水位独立提交。迁移期回滚只切换
`BOLO_TUI_ENGINE=legacy`，不得回滚或破坏会话、transcript、配置和 non-TTY 数据。

---

## 13. 下一步

当前下一刀是 **OI-14E**：

1. 在 retained root 内建立常驻 Composer/Editor 节点；idle/running 只切 mode，不卸载
   节点，不丢 value/cursor/history/undo。
2. 把现有 slash catalog/argument hint、bracketed paste transaction 与提交意图接入
   Composer；输入能力继续复用既有业务契约，不重写 command/skill/plugin 状态。
3. 把 Thinking/Running activity 与 per-segment elapsed 迁入 retained tree；D 已保存
   完成态 `Thought for`，E 负责 running 动画和状态切换，不再另开 stdout writer。
4. 让根布局统一拥有 transcript/activity/composer/footer 的 gap；footer 按宽度展示
   model/mode、快捷键和 `↓input ↑output` usage，任何动态值不能推动固定区域跳动。
5. 用真实 VT 覆盖 idle/running 同一组件身份、首 token 前输入框常驻、字符 burst
   backpressure、paste、slash menu、24–220 列、resize 与输入 p95 预算。
6. 保持 `BOLO_TUI_ENGINE=retained` 显式 opt-in、legacy/plain byte contract 和当前
   async overlay bridge；permission/question/provider/effort/diff/pager 留给 OI-14F。

继续禁止对 `TerminalSurface`、`contentPrefixer`、tiny Markdown 或 composer spacer
添加新的布局补丁。
