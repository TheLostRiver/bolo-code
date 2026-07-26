# Desktop 设计方案（AR3）

> 目标风格：**Codex App**。本文是 AR3A–F 动手前的方案，先定信息架构、交互与视觉，
> 再写代码。ROADMAP §13.10.2 AR3 · 看板第 18 位。

## 0. 证据说明（先说清楚哪些是看到的、哪些是推断的）

Codex App 的一手资料**没拿到**：OpenAI 官方发布页 WebFetch 返回 403。
本文的结构性描述来自二手评测互证 + OpenAI GitHub issue tracker
（后者对**行为**是权威的，因为那是用户报的真实缺陷）。

**读到的是文字描述，不是亲眼看截图。** 因此下面凡涉及具体像素、间距、
组件样式的部分一律标为「待验」，不当作既定事实写进实现。

反面教材那一节的可信度最高——它们是 issue 编号可查的真实抱怨。

## 1. 现状（实测，非推断）

| 项 | 事实 |
|---|---|
| 规模 | ~1295 行；`main/index.mjs` 417 · `renderer/app.js` 425 · `styles.css` 239 · `index.html` 86 |
| IPC 面 | **11 个通道**（9 invoke + 2 send），不是我最初以为的 2 个 |
| 分层 | ✅ **已达标**：renderer 无业务状态机，不重算权限、不重算 diff，只消费 core 预算好的 cell/preview |
| 事件覆盖 | ❌ core 发 **17 种**事件，renderer 只处理 **4 种** |
| 流式 | ❌ **曾经是假的**——事件名 `text_delta` 与 core 的 `text` 对不上，分支从未执行（已修 `d32d4cd`，并加契约测试守住） |
| 历史回看 | ❌ `listMessages` 把消息拍平成 `slice(0,4000)` 字符串，工具调用/diff/reasoning 一律丢失 |
| 会话 | ❌ 主进程 `let session = null` **单例**，无多会话/resume（core 侧 sessionPersist + session-list 已有，未接） |
| 布局 | ❌ 单窗三行栅格（header / log / 单行 input），**纯暗色硬编码**，无侧栏 |
| 打包 | ❌ **完全没有**。且生产运行还靠 `tsx` 直读 TS 源码 + 四级相对路径——打包后必然失效 |

**结论：分层是对的，要重写的是「视图与数据模型」和「外壳」，不是架构。**

## 2. 从 Codex App 借什么（借语义，不抄实现）

### 2.1 三栏骨架

```
┌──────────┬─────────────────────────┬──────────────┐
│ 会话/任务 │  当前会话时间线          │ 上下文产物    │
│ 列表      │  （消息 · 工具 · diff）  │ diff/终端/文件 │
│          │                         │ ← 按需 toggle │
├──────────┴─────────────────────────┴──────────────┤
│ composer（运行中不锁）                              │
└───────────────────────────────────────────────────┘
```

右栏**按需 toggle 而非常驻**——常驻会把中间对话挤窄，而对话才是主体。

### 2.2 列表项承载两层元信息

每个会话项要能不点进去就扫读：**类型徽标**（本地 / worktree）+ **状态徽标**
（运行中 / **等待审批** / 已完成）。「等待审批」必须是独立状态，
否则并行多会话时用户不知道哪个卡在等自己。

### 2.3 审批走「状态 + 集中队列 + 内联 diff」，不用阻塞式弹窗

多会话并行时，弹窗会互相阻塞。Bolo 现在的 `currentPermId` 是**单个**
（`app.js:332`），一次只能挂一个审批——这在单会话下够用，多会话下必须改成队列。

### 2.4 composer 的 queue 与 steer 必须是**两个显式动作**

这是从它的**缺陷**里学的（下节）。

## 3. 明确不重复的反面教材（issue 可查）

| 它的问题 | 证据 | Bolo 的对策 |
|---|---|---|
| 工具调用/步骤**默认全部折叠**，即使开到最详也要反复手点展开，「很难实时监督并 steer」 | [issue #16415](https://github.com/openai/codex/issues/16415) | **正在运行的当前 step 默认展开，历史 step 折叠**；另给持久的「详审模式」开关。折叠省空间但杀掉实时监督感 |
| 桌面端 queue 与 steer **不能在同一会话共存**，且 steer 有时表现得像 queue（turn 跑完才生效） | [#10469](https://github.com/openai/codex/issues/10469) | 每条待发消息上**直接给「排队 / 立即打断」两个显式选择**，不靠全局默认态让用户猜。Bolo 的 core 侧已有 steer/queue 的 durable 语义与安全边界，语义本就是确定的，别在 UI 层弄糊 |
| Windows 端大量透明/白屏/主题混合渲染 bug | [#25236](https://github.com/openai/codex/issues/25236) · [#26790](https://github.com/openai/codex/issues/26790) · [#23947](https://github.com/openai/codex/issues/23947) | **不用透明窗口/亚克力效果**；主题切换与 maximize 后的渲染要在 Windows 上实测（本项目主力平台就是 Windows） |
| 「在编辑器打开文件」约 80% 失效；模型选择器混乱 | 评测 | 边界交接要么做稳要么不做；不做假入口 |

## 4. 视觉方向

调研称其设计语言为**高对比单色 + 默认浅色 + 无渐变无阴影 + 大留白**，
强调色几乎只用黑色。这与「多数 AI agent 深色优先」相反。

**采用其原则，不照搬其 token：**

- 单色系为主，彩色**只留给语义**（错误、等待审批）
- 排版与留白撑结构，不用阴影和渐变
- **light / dark 双主题从第一天就做扎实**——它的浅色是一等公民、深色定制欠缺，
  而 Bolo 现在恰好相反（`styles.css` 硬编码 `color-scheme: dark`）。两边都别偏废
- 等宽字体用于代码与元数据

> 具体字号阶梯与间距**待验**：调研拿到的 token 来自第三方整理的设计 skill 页面，
> 是否 1:1 等于桌面 app 实际 chrome 无法确认（该页二次直读被 429 限流）。
> 实现时以自己的可读性测试为准，不照抄数值。

## 5. 数据模型：两套读路径，都要用

调研确认 Bolo 侧的现状：

| | 现状 |
|---|---|
| `packages/shared` 的 runtime 协议契约 | ✅ **完整就绪**：版本常量、snapshot/query/command 形状、fail-closed 解析器、版本协商函数，均有测试 |
| client / transport / store 抽象 | ❌ **不存在**。CLI 是唯一消费者，且是**进程内直连** core |
| mock adapter | ❌ 无 |
| 版本协商函数 | ⚠️ 已实现但**生产代码零调用者** |
| Desktop 当前消费 | 只走 `SessionEvent` 推流，**完全不碰 runtime 协议** |

**`SessionEvent`（推）与 runtime query（拉）是两套系统，Desktop 两套都要用：**

- **推**：实时增量——文本、工具进度、phase、审批请求
- **拉**：可回看的结构化状态——会话列表、turn timeline、diff、usage

现在桌面端只有推，且推的那条还坏过（§1）。**历史回看必须换成拉 `sessionTranscript`
的结构化数据**，而不是继续用 `listMessages` 的截断字符串。

## 6. 切片顺序（对齐 ROADMAP AR3A–F）

| 切片 | 交付 | 先决 |
|---|---|---|
| **A** | protocol client/store：传输接口 + **mock 与 core 双 adapter 同接口** + normalized store；接上零调用者的版本协商 | 契约已就绪，净新增 client 层 |
| **B** | 会话列表 + turn timeline + 中断恢复视图（主进程从单例改多会话管理器） | A |
| **C** | 内容卡片：消息 / 工具 / diff / 审批 / 错误。**view-model 继续来自 packages**，renderer 不重算 | A · B |
| **D** | composer：queue / steer 显式化 · 运行中可输入 · 打断 | A |
| **E** | 设置：provider / model / effort / 能力可解释。**secret 不回传 renderer/transcript** | A |
| **F** | 打包：esbuild + electron-builder + Windows NSIS | 全部 |

**每片都先落 packages / IPC fixture，再改 `apps/desktop`。**

## 7. 已知风险与未决问题

1. **打包是唯一必须从零搭的板块。** 现在靠 `tsx` 直读源码 + 四级相对路径，
   打包后必然失效。是否复用 CLI 的 `scripts/build-dist.ts` 那条 esbuild 链，
   还是 desktop 独立一条——**未决**。
2. **多会话归属未决**：主进程改多会话管理器算 desktop 范围还是 core 范围？
   core 侧 `sessionPersist` + session-list 已有，倾向 desktop 只做接线。
3. **electron-builder 会引入构建期依赖**。红线是**产物**零运行时依赖，
   构建工具进 `devDependencies` 不违规（同 esbuild 的先例），但要确认
   打出的 asar 里不混入 dev 依赖。
4. Codex App 消息流里「模型文本 / 工具调用 / 错误」的具体视觉区分方式**未找到证据**，
   diff 是否有并排视图也未找到。这两点自己定，不假装是借鉴。

## 8. 不做

- **不做遥测**（红线）
- 不做透明窗口 / 亚克力（Windows 渲染雷区，见 §3）
- 不在 renderer 重算权限或 diff（薄壳纪律，现状已达标，不要退步）
- 不做「打开外部编辑器」这类交接功能，除非能做稳——它在 Codex App 那边约 80% 失效
