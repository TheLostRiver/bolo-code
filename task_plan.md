# Task Plan: Bolo Code

## Goal
路线图纳入 CLI TUI：`bolo` 启动欢迎、大写 BOLO 字标、原创吉祥物、会话壳（贴 HC 布局语义）。

## Next Step（文档已钉 · 待开工）
1. M-TUI T0–T2（BRAND 定稿 + banner + 无参启动）
2. M-Slash P0 / M-Rules / M-Subagent / M-Cost / JSONL / MCP

## Current Phase
roadmap updated — M-TUI + mascot — docs only

## M-TUI 最小完成线
- [ ] T0 docs/TUI.md + BRAND.md（吉祥物择一）
- [ ] T1 renderWelcomeBanner：BOLO + mascot
- [ ] T2 `bolo` TTY 新会话 + banner
- [ ] T3–T6 状态行 / 流式 / 权限 / slash
- [ ] T8 Ink 可选升级

## Notes
- 不抄 Claude/第三方 IP；NO_COLOR / --plain 降级
- 第一刀可零依赖 ASCII，不强制 Ink