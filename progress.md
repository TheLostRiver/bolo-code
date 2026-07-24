# Progress Log

## Session: T4–T6 流式工具行 + TTY 权限 + slash 确认

- **T4** `formatSessionEvent` / `createSessionEventPrinter`：REPL 与单轮路径打印 text delta + `→/✓/✗ Tool`
- **T5** `createTtyAskPermission`：TTY `Allow <tool>? [y/N]`；非 TTY deny；接 PermissionRequest 链
- **T6** REPL 已走 `submitUserInput`；`/help` 本地打印
- 测试：`scripts/test-cli-events.ts`；文档 `TUI.md` / `TODO.md` 勾选

## 默认下一刀

J-C+（jsonl 优先 resume / RS7）或 S7（`.bolo/agents`）或 T8 Ink