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

## 7b. 验证状态（如实标注）

| 面 | 状态 |
|---|---|
| 视图模型（会话列表 / timeline / 卡片） | ✅ 纯函数，门禁测试覆盖，关键语义均实证过会红 |
| IPC 两侧对齐 | ✅ `test-desktop-ipc-contract.ts`（请求与推送两个方向） |
| 事件名对齐 | ✅ `test-desktop-event-contract.ts` |
| renderer 不注入 HTML | ✅ `test-timeline-cards.ts` 含抽取器自检 |
| JS/HTML/CSS 语法 | ✅ `node --check` |
| 打包产物自包含 | ✅ `test-desktop-bundle.ts`（无 tsx/`.ts` 残留 · electron external · 资源齐全） |
| **应用真的能启动、renderer 真的挂上** | ✅ `test-desktop-launch.ts` —— **真跑一次 Electron** |
| **窗口里的视觉呈现** | ❌ **仍未验证** |
| **Windows 安装包（NSIS）** | ⛔ **受阻**——见 §7c |

`test-desktop-launch.ts` 关掉了「白屏」那一类：它启动真实 Electron，
在页面里确认三栏容器挂上、`window.bolo` 存在（**即 preload 路径没写错**）、
样式表真的加载了。实证过它抓得住——把 preload 指向一个不存在的文件，立刻变红，
而那正是静态断言**抓不到**的场景（路径写法合法、文件不存在）。

**仍然没验的是「好不好看、好不好用」**：布局的实际观感、Windows 上主题切换与
maximize 后的渲染稳定性、焦点环与键盘走查、长会话滚动性能。
自动化测不了这些，与 `AskUserQuestion` 的真 TTY 交互是同一类缺口。

> **不要在没有真正肉眼看过窗口的情况下把「视觉呈现」那一行改成 ✅。**

## 7c. NSIS 安装包受阻（记录，供接手者不必重走）

`electron-builder@26.15.3` 已进 devDependencies，配置已写
（`apps/desktop/electron-builder.yml`），`npm run package` 仍失败于：

```
⨯ No JSON content found in output   failedTask=build
  at PnpmNodeModulesCollector.extractJsonFromPollutedOutput
```

**已排除的（不必重试）：**

| 排查 | 结果 |
|---|---|
| electron 版本是范围而非固定值 | ✅ 已修：配置里写 `electronVersion: 33.4.11` |
| 根 `packageManager: pnpm@9.15.0` 与实际不符 | ✅ 已定位——**无 `pnpm-lock.yaml`、无 `pnpm-workspace.yaml`**，根用的是 npm 风格 `workspaces` 字段且有 `package-lock.json`。已在 `apps/desktop/package.json` 就近声明 `npm@11.17.0`（不动根声明，影响面超出本刀） |
| `npmRebuild` / `nodeGypRebuild` / `buildDependenciesFromSource` 关掉 | ❌ 无效，依赖收集是无条件跑的 |
| collector 实际执行的命令本身坏了 | ❌ 手动跑均正常：`npm prefix -w` 返回仓库根；`npm list -a --include prod --include optional --omit dev --json --long --silent --loglevel=error` 从 `apps/desktop` 与仓库根都输出干净 JSON（12.5 KB / 22 KB，首字符均为 `{`） |

**根因已查清（不再是假设）：上游与 Node/Windows 的不兼容。**

`which.sync('npm')` 在本机解析到 **`npm.CMD`**，而 electron-builder 直接 spawn 它。
现代 Node 出于安全加固（CVE-2024-27980）**拒绝不带 shell 直接 spawn `.CMD`/`.bat`**。
最小复现：

```js
spawnSync(whichSync('npm'), ['list', '--json'], { encoding: 'utf8' })
// → status=null · error=EINVAL · stdout 长度=0
```

空输出正是 `No JSON content found in output` 的来源。**与配置无关**——
手动执行同样的命令一切正常（22 KB 干净 JSON）。

**为什么绕不过去：**

| 尝试 | 结果 |
|---|---|
| 在 `apps/desktop` 声明 `packageManager: npm@…` | ❌ 仍失败：detection 会**从 workspace 根重新检测**，根的声明压过一切 |
| 声明 `packageManager: traversal@…`（该值在 PM 枚举里合法，走文件遍历、不 spawn） | ❌ 同上，被根重新检测覆盖 |
| 把**根**声明改成 `traversal` | 🚫 不做：那不是包管理器，写上去就是对人和工具撒谎 |
| 把**根**声明改成 `npm` | 🚫 无用：正好回到 `npm.CMD` 的 EINVAL |
| 升到 electron-builder 27 | 🚫 仅有 alpha（27.0.0-alpha.6）。不为打包把构建链压在 alpha 上 |

**建议的解法（需所有者决定，故未擅自实施）：** 让 `which` 解析到可直接 spawn 的
`npm` 而非 `npm.CMD`（例如 PATH 里提供一个 `npm.exe` 垫片），或等 electron-builder 27 稳定版。

> 顺带查明：根 `package.json` 的 `packageManager: pnpm@9.15.0` **与实际不符**——
> 无 `pnpm-lock.yaml`、无 `pnpm-workspace.yaml`，根用的是 npm 风格 `workspaces`
> 字段且有 `package-lock.json`。这是一处独立于打包的陈旧声明，**未擅自修改**
> （影响全仓，属所有者决定），但它确实是本次排查绕不过去的那道墙。

**已确认打包并未真正成功**：`release/win-unpacked/resources/` 是空的，
即只下载了 Electron 外壳，应用文件从未被拷入。失败产物已清理。

> 机器上 `~/.npmrc` 有 `allow-scripts=oh-my-codex` 策略。安装时确有
> 3 个包的 install script 被拦（electron / esbuild / electron-winstaller）。
> 这**可能**相关，但**未证实**——且放行第三方安装脚本属于机器级安全决定，
> 不应由自治流程替所有者做。

## 8. 不做

- **不做遥测**（红线）
- 不做透明窗口 / 亚克力（Windows 渲染雷区，见 §3）
- 不在 renderer 重算权限或 diff（薄壳纪律，现状已达标，不要退步）
- 不做「打开外部编辑器」这类交接功能，除非能做稳——它在 Codex App 那边约 80% 失效
