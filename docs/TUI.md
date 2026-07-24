# CLI TUI（最小）

> 对照成熟 coding agent 的**布局语义**（欢迎区 → 会话 → 输入），原创实现。无遥测。品牌见 `docs/BRAND.md`。

## 启动线框（TTY 无参 `bolo`）

```text
┌──────────────────────────────────────────────┐
│  ____   ___  _      ___                      │
│ | __ ) / _ \| |    / _ \     ← ASCII BOLO    │
│ |  _ \| | | | |   | | | |                    │
│ | |_) | |_| | |___| |_| |                    │
│ |____/ \___/|_____|\___/                     │
│   (o)  Bolot · Bolo Code                     │
│   /|\  puffer · balloon fish                 │
│  v0.0.1  ·  <cwd>  ·  model <name?>          │
├──────────────────────────────────────────────┤
│  mode=… · model=… · effort=… · messages=N    │  ← T3 状态行
│  Interactive mode … /help                    │
│  bolo> _                                     │
└──────────────────────────────────────────────┘
```

## 模式

| 条件 | 行为 |
|------|------|
| TTY + 无参 | 全量 banner → `createSessionFromWorkspace` → readline（`submitUserInput`） |
| plain / `NO_COLOR` / `BOLO_PLAIN=1` | 单行 `BOLO · …`，无多行艺术字 |
| 非 TTY 无参 | 打印 help / 错误并退出，**不**挂起 |
| `--resume` 成功 | **缩略**一行 `BOLO · session <id>`（T7 轻量）+ 会话摘要 |

## 运行时行为（T3–T6）

### T3 状态行

- 每次 `bolo>` 前、banner/摘要后打印一行：  
  `mode=<permissionMode> · model=… · effort=… · messages=N`
- 实现：`packages/cli/src/tui/statusLine.ts`

### T4 流式 assistant + 工具简行

- Session `onEvent` 在 REPL / 单轮 `submitUserInput` 路径上打印：
  - **text**：按 delta 原样写出（无额外前缀）
  - **reasoning**（思考链）：弱样式（ANSI dim）+ 首段前缀 `thinking `；与正文换行分离；无事件则静默
  - **显示开关**：`session.showThinking`（默认 on）；`/thinking off` 时打印机跳过 reasoning（事件仍可能到达 `onSessionEvent` 钩子）
  - **tool_start** / **tool_end**：独立一行  
    `→ ToolName` / `✓ ToolName`（失败 `✗ ToolName`）
- 不打印 phase / hook 等噪声；已流式 text 时回合结束**不**再整段回放 assistant。
- 纯函数：`formatToolEventLine` / `createSessionEventPrinter`（`tui/formatSessionEvent.ts`；支持 `showThinking` 布尔或函数）

### T5 权限 ask（TTY）

- `createSession` / CLI 创建 session 时注入 `askPermission`（对接 gate → `PermissionRequest` hook → UI）。
- **TTY**：readline 问 `Allow <tool>? [y/a/N]`（默认 N；`y`/`yes` 为 allow；`a`/`always` 为本会话 always-allow 该工具名）。
- **非 TTY**：默认 **deny**（不挂起）；测试可注入 `readPermissionAnswer` 或 `nonTtyPermission`。
- REPL 内权限与 `bolo>` **共用同一 readline**，避免抢 stdin。
- 实现：`packages/cli/src/tui/askPermissionTty.ts`

### T6 斜杠

- REPL 输入走 `submitUserInput`（与 M-Slash 同一入口）。
- `/help` 等本地命令返回 `{ type: 'slash', message }`，在 TUI 内直接打印，不调模型。
- 见 `docs/SLASH_COMMANDS.md`。

## 模块

- `packages/cli/src/tui/banner.ts` — `renderWelcomeBanner`
- `packages/cli/src/tui/statusLine.ts` — 状态行
- `packages/cli/src/tui/formatSessionEvent.ts` — 事件格式化
- `packages/cli/src/tui/askPermissionTty.ts` — 权限 y/a/N
- `packages/cli/src/newSessionCli.ts` — 新会话入口
- `packages/cli/src/resumeCli.ts` — resume / REPL / `runOnePrompt`
- `packages/cli/src/main.ts` — 路由 bare / resume

## 后续（未做）

- 完整 Ink 布局 / 箭头键会话 picker 美化
- 主题、窄终端、吉祥物开关

## 验收

- plain 输出包含 `BOLO`
- 无参 TTY 路径可进 REPL；非 TTY 不阻塞
- 斜杠经总线；`/help` 可读
- `scripts/test-cli-events.ts`：工具行与权限解析
- 无遥测