# 整盘后续执行轨（Full Track · 非 Electron）

> **整盘后续真源**（相对 HC 加深；**不是** PRODUCT 小轨）。  
> Electron / M4 **后置不实现**（仅 F-ELECTRON-HANDOFF 文档）。  
> **永不：** 官方市场 API · 遥测。  
> 原则：最小可验收 + 限制说明；禁止 stub 勾满。

---

## 0. 状态

| 口径 | 现状 |
|------|------|
| TODO_FULL 本轨 | **✅ 圆满**（2026 本刀） |
| 相对 HC headless | **~55–70%**（诚实上修；仍非 100%） |
| Electron | **✅ 最小壳**（`apps/desktop`；非完整产品 GUI） |

---

## 1. 切片总表

| ID | 状态 | 交付摘要 |
|----|------|----------|
| F-T8-INK | ✅ | `renderInkLayout` 框式布局；`BOLO_TUI_LAYOUT=0` 回退 |
| F-T8-PICKER | ✅ | `arrowPicker` + resume 优先箭头；编号回落 |
| F-T9-THEME | ✅ | `BOLO_THEME` / `BOLO_MASCOT` |
| F-TUI-DOC | ✅ | TUI.md |
| F-CP-CACHED-MC | ✅ | `cachedMicrocompactMessages` |
| F-CP-SNIP-UUID | ✅ | `snip_id=` 边界 · `parseSnipBoundaryId` |
| F-C6-TTL | ✅ | `shouldBreakPromptCache` 1h TTL + 前缀变化 |
| F-CP-DOC | ✅ | COMPACTION / PROMPT_CACHE 限制说明 |
| F-SA-WORKTREE | ✅ | `BOLO_SUBAGENT_WORKTREE=1` · git worktree |
| F-SA-PAR2 | ✅ | `BOLO_BACKGROUND_OVERFLOW=queue\|reject` |
| F-S8-PLUS | ✅ | `filterToolsBySubagentAllowlist` |
| F-SA-DOC | ✅ | SUBAGENT.md |
| F-MCP-OAUTH | ✅ | token 文件 → Bearer（无浏览器自动化） |
| F-PL-DEPTH | ✅ | `installPluginFromGitPath` · update hint |
| F-SKILLS-PLUS | ✅ | `BOLO_REMOTE_SKILL_ROOTS` |
| F-OR6-WS | ✅ | WS provider **显式未实现**错误（HTTP SSE 默认） |
| F-EXT-DOC | ✅ | 扩展文档 |
| F-Y5-SANDBOX | ✅ | 标记级 sandbox env |
| F-Y5-POLICY | ✅ | `.bolo/policy.json` / `BOLO_POLICY_FILE` |
| F-Y5-DOC | ✅ | PERMISSIONS |
| F-MEM-8 | ✅ | daily log + `memory/team/` |
| F-JD-FORK | ✅ | `parentUuid?` 字段（线性主路径） |
| F-MISC-DOC | ✅ | 多模态等仍 ⬜ 清单 |
| F-SYNC | ✅ | 本文 + TODO/ROADMAP |
| F-SMOKE | ✅ | `scripts/test-full-track.ts` |
| F-ELECTRON-HANDOFF | ✅ | desktop README 启动条件（**不实现壳**） |

---

## 2. 测试

```bash
node --import tsx/esm scripts/test-full-track.ts
node --import tsx/esm scripts/test-product-track.ts
node --import tsx/esm scripts/test-memory.ts
node --import tsx/esm scripts/test-subagent.ts
```

---

## 3. 限制（诚实）

- Ink = **等价文本布局**，非 React Ink 依赖  
- Sandbox = **环境标记**，非 OS namespace  
- OAuth = **用户自备 token 文件**，无浏览器登录流  
- Responses WS = **明确报错**，默认 HTTP SSE  
- Worktree = 需 git + `BOLO_SUBAGENT_WORKTREE=1`  
- Electron = **M4 最小壳已落地**（IPC + mock；非完整 UX）

---

## 4. 一句话

> **FULL + M4 + policy/WebFetch 接线已齐。** 相对 HC ~65–80%，非 100%。