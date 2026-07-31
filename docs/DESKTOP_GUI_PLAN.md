# Desktop GUI 重写方案（对标 Codex App）

> 状态：方案稿（v0，待实施）。真源：本文件 + `docs/DESKTOP_DESIGN.md`（旧版，被本方案取代）+ `docs/ARCHITECTURE.md`。
> 目标：**推翻现有 renderer（当前仅测试用），按 OpenAI Codex 桌面版的视觉与功能重写**。
> 红线：不引入 pi 依赖；renderer 保持零新运行时依赖（原生 Web 技术，无框架）；复用全部既有 runtime/IPC 接线。

## 0. 一句话目标

把 `apps/desktop` 的 renderer 从「三栏测试骨架」重写为 **Codex 级桌面体验**：
深色为主的现代视觉、左侧会话栏、流式消息流（markdown + 代码块）、底部多功能 composer
（多行 + @引用 + 模型/推理强度选择）、可折叠工具调用卡片、内联权限确认、完整设置面板。
**main/preload/IPC/RuntimeClient 全部不动**，只重写渲染层。

## 1. 现状与推翻点

| 现状（apps/desktop/src/renderer/） | 问题 |
|------------------------------------|------|
| `index.html` 三栏骨架 + `styles.css`（10 KB） | 测试原型观感：裸按钮、无设计 token、light 默认主题无质感 |
| `app.js`（34 KB）单文件逻辑 | 无组件划分，消息是 `#log` 的追加文本流（textarea 式），无气泡/代码块/流式光标 |
| composer 是**单行 input** + 四个裸按钮 | 无多行、无 @ 引用、无模型/effort 内联选择器 |
| 权限/询问/设置 = 半透明遮罩 + 居中卡片 | 可用但粗糙，与 Codex 的内联/原生对话框差距大 |

**保留不动（已验证的资产）**：main 进程（窗口/安全边界/IPC 宿主，30 KB）、preload bridge、
runtime 协议（19 request + 3 push IPC）、`RuntimeClient`/store、会话选择/恢复、
composer controls（send/queue/steer/interrupt 的 durable 接线）、设置读写（model/effort/provider）、
`test-desktop-*` 全部自动化（它们驱动 IPC 层，与视觉无关）。

## 2. 目标形态（Codex App 对标）

### 2.1 视觉

| Codex App 特征 | Bolo 落地 |
|----------------|-----------|
| 深色近黑背景（#0d0d0d 系）、浅色主题可选 | CSS variables design token 双主题（dark 默认 / light），跟随系统 + 手动切换 |
| 左侧会话栏（窄、列表、当前高亮、新建按钮） | 重做 sidebar：会话条目（标题/时间/预览）、新建/删除、可折叠（快捷键） |
| 消息流：assistant 消息（名称 + 内容）、user 消息简洁、流式光标 | 按角色分块渲染；流式期间光标动画；`/` 命令灰块 |
| 代码块：深色底、圆角、无语法高亮起步 | 自写 DOM markdown 渲染器（代码块/粗体/行内码/链接/列表/引用），高亮后置 |
| 工具调用 = 可折叠卡片（icon + 名称 + 参数/输出） | 复用 `tool_progress`/`tool_end` 事件 → 卡片（折叠/展开，输出有界） |
| Composer：圆角输入框、多行、@ 提及、模型/effort 下拉、发送按钮 | 多行 textarea 自适应高度；@ 提及文件（现有工具链有 cwd）可后置；模型/effort 内联选择 |
| 顶栏：会话标题 + provider/状态 + 设置齿轮 | 重做 header：标题可编辑、状态胶囊（runtime/usage）、设置入口 |

### 2.2 功能（对标 Codex，按 Bolo 实际能力裁剪）

| 功能 | 本轮 | 说明 |
|------|------|------|
| 会话：新建/切换/恢复/删除 | ✅ | 删除会话为新增（spill cleanup 已在 OUT-3 备好 primitive） |
| 流式消息渲染（text/reasoning/tool） | ✅ | 复用 runtime 事件投影 |
| Markdown + 代码块 | ✅ | 自写 DOM 渲染器（~200 行），零依赖 |
| 工具调用卡片（折叠/展开/输出） | ✅ | 对应 CLI 的 ToolPresentation 思路 |
| 权限内联确认（allow/always/deny） | ✅ | 复用 AskPermissionRequest，做成 Codex 式内联卡片而非遮罩 |
| 多行 Composer + Send/Interrupt | ✅ | 复用 composerIntentToControl |
| 模型/推理强度选择 | ✅ | 复用 getSessionModelEffortSettings（含 metadata 显示） |
| @ 文件引用 / 图片粘贴 | ⏸ 后置 | 需文件 picker 与图片消息管线，证据门控 |
| 代码高亮 | ⏸ 后置 | 零依赖高亮成本高，先无高亮 |
| 主题切换（dark/light） | ✅ | 复用 CLI 主题色板思路（桌面用 CSS token） |

## 3. 技术方案

### 3.1 分层（复用 vs 重写）

```
apps/desktop/src/
  main/          ✅ 不动（窗口/安全/IPC 宿主）
  preload/       ✅ 不动（白名单 bridge）
  renderer/      ❌ 推翻重写：
    index.html       新骨架（单窗口布局）
    styles.css       design token（CSS variables）+ 组件样式
    app.js          入口（运行时接线）
    components/      原生 ES module 组件（每组件一个文件）
      Sidebar/MessageList/Message/Markdown/ToolCard/Composer/Header/SettingsDialog/PermissionCard
    lib/             markdown.ts（DOM 渲染器）· tokens.ts（主题）· dom.ts（工具）
```

- **零新运行时依赖**：原生 Web 技术（ES modules + CSS variables），不引入 React/Vue/框架；
  不进 CDN（CSP `default-src 'self'`）；npm 依赖不新增（`electron` 已是 devDep）
- 组件协议：`render(container, state) → cleanup` 或轻量 vdom 手写（评估后定，倾向 render 函数 + 显式 diff 点，与 CLI retained 思路同源）

### 3.2 数据流（不变）

runtime 事件 → `projectSessionRuntimeEventView` 窄投影 → store → 组件渲染。
新增：事件缓冲/节流（流式文本合并到当前消息块，DOM 增量 append）。

### 3.3 主题

- `tokens.ts` 定义两套 CSS variables（dark/light），色板参考 CLI 极光主题 + Codex 中性深灰
- 切换写 localStorage + 跟随系统（`prefers-color-scheme`）

## 4. 切片实施（每刀独立验收）

| 切片 | 交付 | 验收 |
|------|------|------|
| **S1 骨架与主题** | 新布局（sidebar/header/messages/composer 区域）+ design token + dark/light 切换 | 布局在各窗口尺寸无溢出；主题切换即时生效；既有 desktop bundle/launch smoke 绿 |
| **S2 会话栏** | 会话列表重设计（条目/高亮/新建/删除/折叠） | 切换/恢复/删除真实可用；IPC 契约测试不回归 |
| **S3 消息流** | 角色分块 + 流式渲染 + 自写 Markdown + 代码块 | 流式追加正确；markdown 用例（代码/列表/引用）目验；无 XSS（渲染纯文本转义） |
| **S4 Composer** | 多行自适应 + 发送/中断 + 模型/effort 内联选择 + 快捷键提示 | controls 契约测试不变；中断真实生效 |
| **S5 工具卡片与权限** | tool 卡片折叠 + 内联权限确认（替代遮罩） | 权限流（allow/always/deny）端到端；tool 输出有界 |
| **S6 设置与细节** | 设置面板重做 + 顶栏状态胶囊 + 空态/加载态 + 键盘导航 | 设置读写测试不变；Tab 焦点可达所有控件 |
| **S7 打磨（真人）** | 动画/微交互/无障碍/Codex 细节对照 | 真人走查清单（对应 OI-H2 升级版） |

每刀：packages 契约先行（如需要）→ renderer 实现 → 定向脚本/自动化 → typecheck → 完整 `npm test`（desktop bundle/launch 必绿）→ 文档/提交。

## 5. 验收总则

1. 自动化：`test:desktop-*`（bundle/launch/ipc/event/secret/ask/composer/settings/session-selection）全绿；
   `dependencies: {}` 红线不破；renderer 无 `innerHTML` 拼接不可信内容（XSS 门禁，见 S3）
2. 真人：Codex 对照走查清单（布局/配色/流式/权限/设置/键盘），截图存档到 docs/
3. 旧 renderer 删除（不再保留回退——`apps/desktop/src/renderer/` 全量替换）

## 6. 不做清单（带重开条件）

| 项 | 不做 | 重开条件 |
|----|------|----------|
| 遥测/账号/云同步 | Codex 有但我们明确不做（项目红线） | — |
| 框架引入（React/Vue） | 零依赖哲学 | 组件复杂度实测超出原生可维护性（≥3 个切片后评估） |
| @ 文件引用/图片粘贴 | 本轮后置 | 用户明确要求 |
| 代码语法高亮 | 零依赖高亮成本高 | 用户要求；或找到零依赖轻量方案 |
| 多窗口/分屏 | Codex 单窗口即可 | 用户要求 |

## 7. 参考

- Codex App（OpenAI）：视觉/交互对标（深色、侧栏、消息流、composer、工具卡片）
- 现有资产：`apps/desktop/src/main/index.ts` · `preload/index.cjs` · `renderer/`（被推翻）·
  `docs/DESKTOP_DESIGN.md`（旧版）· `docs/ARCHITECTURE.md` §3（分层）·
  `test-desktop-*`（自动化资产，保留）
- 预算：S1–S6 约 6–8 个切片轮；S7 真人打磨另计
