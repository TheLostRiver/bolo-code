# Desktop 设计方案（AR3）

> 目标风格：**Codex App**。本文是 AR3A–F 动手前的方案，先定信息架构、交互与视觉，
> 再写代码。ROADMAP §13.10.2 AR3 · 看板第 18 位。
>
> 实现状态持续同步：AR3A 生产桥、B/C 视图模型与薄壳、F 打包/NSIS 已落地；
> 会话切换、composer controls 与 model/effort 设置仍在 OI-06。

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
| 规模 | main/renderer 仍是单文件薄壳；协议、状态、view-model 与安全判断均在 `packages/*` |
| IPC 面 | **15 request + 3 push**；`test-desktop-ipc-contract.ts` 双向守住 |
| 分层 | ✅ **已达标**：renderer 无业务状态机，不重算权限、不重算 diff，只消费 core 预算好的 cell/preview |
| 事件覆盖 | ⏳ core 发 **17 种**事件，renderer 处理 **5 种**；phase/tool progress 等仍待投影 |
| 流式 | ❌ **曾经是假的**——事件名 `text_delta` 与 core 的 `text` 对不上，分支从未执行（已修 `d32d4cd`，并加契约测试守住） |
| 历史回看 | ✅ `getTimeline` 返回 packages 生成的结构化卡片；旧 `listMessages` 只作失败回退 |
| 会话 | ❌ 主进程 `let session = null` **单例**，无多会话/resume（core 侧 sessionPersist + session-list 已有，未接） |
| 布局 | ✅ 三栏骨架、按需右栏、light/dark 主题已落地；视觉仍未真人验收 |
| 打包 | ✅ main 自包含 bundle + browser RuntimeClient bundle + Electron smoke + Windows NSIS |

**结论：基础架构与生产协议桥已成立，剩余工作是把会话导航和控制工作流接完整。**

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

多会话并行时，弹窗会互相阻塞。Bolo 现在的 `currentPermId` 仍是**单个**，
一次只能挂一个审批——这在单会话下够用，多会话下必须改成队列。

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
- **light / dark 双主题都要做扎实**——实现已具备双主题，真人主题切换与
  maximize 视觉仍不得伪称验收
- 等宽字体用于代码与元数据

> 具体字号阶梯与间距**待验**：调研拿到的 token 来自第三方整理的设计 skill 页面，
> 是否 1:1 等于桌面 app 实际 chrome 无法确认（该页二次直读被 429 限流）。
> 实现时以自己的可读性测试为准，不照抄数值。

## 5. 数据模型：两套读路径，都要用

调研确认 Bolo 侧的现状：

| | 现状 |
|---|---|
| `packages/shared` 的 runtime 协议契约 | ✅ **完整就绪**：版本常量、snapshot/query/command 形状、fail-closed 解析器、版本协商函数，均有测试 |
| client / transport / store 抽象 | ✅ `packages/shared/src/runtimeClient.ts`；单一 normalized store |
| mock / core adapter | ✅ mock 与 `createSessionRuntimeTransport` 共用 `RuntimeTransport` |
| 版本协商函数 | ✅ Desktop renderer 生产调用；真实 Electron smoke 握手为 `ready` |
| Desktop 当前消费 | ✅ `SessionEvent` 推流 + runtime hello/query/command；会话 selection 尚未接 |

**`SessionEvent`（推）与 runtime query（拉）是两套系统，Desktop 两套都要用：**

- **推**：实时增量——文本、工具进度、phase、审批请求
- **拉**：可回看的结构化状态——会话列表、turn timeline、diff、usage

现在桌面端两套都已接：实时内容走推，启动/runtime 状态和结构化 timeline 走拉。
下一缺口不是再造读路径，而是让左侧 selection 真正切换/resume session，并继续保持
`listMessages` 只作兼容回退。

## 6. 切片顺序（对齐 ROADMAP AR3A–F）

| 切片 | 交付 | 先决 |
|---|---|---|
| **A ✅** | protocol client/store：传输接口 + **mock 与 core 双 adapter 同接口** + normalized store；生产 IPC 与真实握手 | 契约已就绪，净新增 client 层 |
| **B ⏳** | 会话列表 + turn timeline 已有；切换/resume 与中断恢复动作待接 | A |
| **C ✅** | 内容卡片：消息 / 工具 / diff / 审批 / 错误。**view-model 继续来自 packages**，renderer 不重算 | A · B |
| **D ⏳** | composer：queue / steer 显式化 · 运行中可输入 · 打断 | A |
| **E ⏳** | 设置：provider / model / effort / 能力可解释。**secret 不回传 renderer/transcript** | A |
| **F ✅** | main/browser bundle + electron-builder + Windows NSIS | 全部 |

**每片都先落 packages / IPC fixture，再改 `apps/desktop`。**

## 7. 已知风险与未决问题

1. **多会话归属仍待收口**：core 已有 resume/session-list，Desktop 应只做
   session manager 与 IPC 接线，不复制持久化或恢复规则。
2. **审批仍是单 pending id**：会话切换前必须决定如何按 session 排队，不能让
   一个会话的响应错误认领另一个会话的审批。
3. **composer/settings 仍未接生产动作**：queue/steer/interrupt 必须携带
   expected state/requestId；model/effort 切换失败必须保留旧值。
4. Codex App 消息流里「模型文本 / 工具调用 / 错误」的具体视觉区分方式**未找到证据**，
   diff 是否有并排视图也未找到。这两点自己定，不假装是借鉴。

## 7b. 验证状态（如实标注）

| 面 | 状态 |
|---|---|
| runtime 生产桥 | ✅ core adapter + 15 request/3 push IPC + browser client；真实 Electron hello/query 为 `ready` |
| 视图模型（会话列表 / timeline / 卡片） | ✅ 纯函数，门禁测试覆盖，关键语义均实证过会红 |
| IPC 两侧对齐 | ✅ `test-desktop-ipc-contract.ts`（请求与推送两个方向） |
| 事件名对齐 | ✅ `test-desktop-event-contract.ts` |
| renderer 不注入 HTML | ✅ `test-timeline-cards.ts` 含抽取器自检 |
| JS/HTML/CSS 语法 | ✅ `node --check` |
| 打包产物自包含 | ✅ `test-desktop-bundle.ts`（无 tsx/`.ts` 残留 · electron external · 资源齐全） |
| **应用真的能启动、renderer 真的挂上** | ✅ `test-desktop-launch.ts` —— **真跑一次 Electron** |
| **窗口里的视觉呈现** | ❌ **仍未验证** |
| **Windows 安装包（NSIS）** | ✅ **构建已验证**——见 §7c |

`test-desktop-launch.ts` 关掉了「白屏」那一类：它启动真实 Electron，
在页面里确认三栏容器挂上、`window.bolo` 存在（**即 preload 路径没写错**）、
样式表真的加载，并等待 RuntimeClient 完成真实 hello/query 握手。实证过它抓得住——
把 preload 指向一个不存在的文件或移除 runtime client 产物都会立刻变红，而这些正是
静态断言**抓不到**的场景。

**仍然没验的是「好不好看、好不好用」**：布局的实际观感、Windows 上主题切换与
maximize 后的渲染稳定性、焦点环与键盘走查、长会话滚动性能。
自动化测不了这些，与 `AskUserQuestion` 的真 TTY 交互是同一类缺口。

> **不要在没有真正肉眼看过窗口的情况下把「视觉呈现」那一行改成 ✅。**

## 7c. NSIS 安装包（已解除阻塞）

2026-07-27 在以下环境真实执行：

```text
Node 24.15.0
npm 11.17.0
electron-builder 26.15.3
Electron 33.4.11
```

命令与结果：

```bash
npm --prefix apps/desktop run package
# → apps/desktop/release/Bolo Code-0.0.1-x64.exe
# → apps/desktop/release/Bolo Code-0.0.1-x64.exe.blockmap
```

安装包约 80 MB，electron-builder 完成 Electron 展开、asar integrity、uninstaller、
NSIS 和 blockmap，命令明确 exit 0。

**为什么旧记录会判断成受阻：**

- 根 `packageManager` 当时误写成 `pnpm@9.15.0`，collector 因而选错包管理器。
- 旧排查把 Node 对 `.CMD` 的 CVE-2024-27980 限制当作仍未修的上游问题。
- 实际发布的 `app-builder-lib@26.15.3` 已通过
  `powershell.exe -EncodedCommand` 包装 Windows 包管理器调用，不再直接 spawn
  `npm.CMD`；registry tarball 与本地安装代码一致。

根声明现已改为 `npm@11.17.0`，与 `package-lock.json` 和 Desktop 声明一致。
打包日志会直接显示：

```text
detected workspace root ... pm=npm config=npm@11.17.0
```

空生产依赖时 collector 仍可能回退到 traversal；这是空依赖树的处理，不是打包失败。

**仍然没有代码签名证书。** electron-builder 的签名步骤能完成资源处理，
但发行给用户时 Windows SmartScreen 仍可能警告。没有证书就不能把这一项写成“已签名”。

## 8. 不做

- **不做遥测**（红线）
- 不做透明窗口 / 亚克力（Windows 渲染雷区，见 §3）
- 不在 renderer 重算权限或 diff（薄壳纪律，现状已达标，不要退步）
- 不做「打开外部编辑器」这类交接功能，除非能做稳——它在 Codex App 那边约 80% 失效
