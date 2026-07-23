# Task Plan: Bolo Code

## Goal
日用 CLI 主路径已齐；下一刀 T4–T6 / J-C+ / S7。

## Next Step（默认）
**T4–T6**（流式工具行 / 权限 y/n）或 **J-C+**（jsonl 优先 resume / RS7）或 **S7**（`.bolo/agents`）

## Current Phase
- P0-a RS1–RS6 + RS9 `--continue` — done
- P0-b SL0–SL5 — done
- P0-c T0–T3 / T7 — done（T4–T6 未做）
- P1 rules / cache / JSONL 双写 / creators / J-C 最小 — done
- P2 Subagent S0–S6 / MCP / plugins 最小 — done

## Priority snapshot
1. ~~P0-a resume 无 id 列表（HC）~~ ✅
2. ~~P0-b slash 总线~~ ✅
3. ~~P0-c BOLO 欢迎 + T3 状态行~~ ✅（T4–T6 ⬜）
4. ~~P1 rules / cache / JSONL 双写 / creators~~ ✅
5. ~~P2 subagent / MCP / plugins 最小~~ ✅
6. J-C+ jsonl 优先 · RS7 · S7 · T4–T6
7. P3 Electron

## Notes
- 执行勾选以 `docs/TODO.md` 为准
- 列表默认仅 `{cwd}/.bolo/sessions`
- 吉祥物定稿 **Bolot**（`docs/BRAND.md`）
- JSONL：双写 ✅；`loadTranscriptMessages` + JSON 缺失 resume 回退 ✅；优先 jsonl 未切