# Progress Log

## Session: T3 状态行 + JSONL load（J-C 起步）

- **文档同步**
  - `docs/TODO.md`：J-A/B ✅（19f7594）、RS9 ✅、T3 ✅；下一刀 → T4–T6 / J-C+ / S7
  - `docs/SESSIONS.md`：`loadTranscriptMessages` + JSON 缺失 resume 回退
  - `docs/TODO_SESSION_JSONL.md`：Phase C1/C2/C5 勾选；C3 部分
  - `task_plan.md` / 本文件对齐 main 水位（plugins / continue / MCP / subagent 已在 main）

- **T3 轻量状态行**
  - `packages/cli/src/tui/statusLine.ts`：`formatSessionStatusLine`
  - REPL 每次 `bolo>` 前打印；新会话 banner 后、resume 摘要后各一行
  - 格式：`mode=… · model=… · effort=… · messages=N`

- **J-C 最小**
  - `loadTranscriptFile` / `loadTranscriptMessages`（`sessionTranscript.ts`）
  - `resumeSession`：`loadSession` 成功不改；JSON 缺失或路径为 `.jsonl` 时回退
  - 测试：`scripts/test-transcript-load.ts`

## 默认下一刀

T4–T6（流式工具行 / 权限 y/n）或 J-C+（jsonl 优先）或 S7（`.bolo/agents`）