# Progress Log

## Session: P0-a RS1–RS6 实现

- `listProjectSessions`：扫项目 `.bolo/sessions/*.json`，updatedAt 降序，preview/消息数
- `parseArgs`：`--resume` / `-r` 无 value → picker（`resume: true`）
- CLI：TTY 编号选择；非 TTY 列表 + exit 2；空列表提示 `bolo` + exit 1
- 测试：`scripts/test-session-list.ts` + 扩展 `test-cli-resume`
- 文档：`TODO.md` RS1–RS6 ✅、`SESSIONS.md` 标明已实现

## 默认下一刀

P0-b：斜杠命令总线（`docs/TODO.md` SL0–SL3）