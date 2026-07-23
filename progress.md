# Progress Log

## Session: P0-b + P0-c（slash + BOLO banner）

- `packages/core/src/slash.ts`：parseSlashLine、注册表、dispatch、submitUserInput
- 命令：/help /clear /compact /context /model /effort /plan /permissions
- `BoloSession.effortLevel` 会话字段
- CLI REPL / 单轮走 submitUserInput（resume + 新会话）
- `packages/cli/src/tui/banner.ts`：BOLO + Bolot ASCII；plain/NO_COLOR 单行
- `main.ts`：无参 TTY → 新会话 + banner + REPL；非 TTY 不挂起
- resume 成功后缩略 `BOLO · session <id>`（T7）
- 文档：SLASH_COMMANDS.md、BRAND.md（Bolot）、TUI.md；TODO 勾选 SL* / T0–T2 / T7
- 测试：`scripts/test-slash.ts`

## 默认下一刀

P1-a：`.bolo/rules` 发现 + 注入