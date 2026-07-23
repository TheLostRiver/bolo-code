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

## 模块

- `packages/cli/src/tui/banner.ts` — `renderWelcomeBanner`
- `packages/cli/src/newSessionCli.ts` — 新会话入口
- `packages/cli/src/main.ts` — 路由 bare / resume

## 后续（未做）

- T3–T6：状态行、流式工具行、权限 y/n UI、完整 Ink
- 箭头键会话 picker 美化

## 验收（本切片）

- plain 输出包含 `BOLO`
- 无参 TTY 路径可进 REPL；非 TTY 不阻塞
- 斜杠经总线（见 `SLASH_COMMANDS.md`）