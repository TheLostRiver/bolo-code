# Bolo Code 整体路线图（详细版）

> **状态：主路径里程碑全部 ✅ 最小收口**（`462acc7` + 本刀加深）。  
> 永不：遥测 · Claude/Codex **官方市场 API**。  
> 原则：状态按**代码行为**；✅ 最小 ≠ 无限制、≠ 相对 HC 100%。

---

## 0. 一句话进度

| 层 | 粗估 | 说明 |
|----|------|------|
| **Headless 核心** | **~75–85%** | loop/STE/权限/auto/snip/cached-MC/policy 接线 |
| 会话与 CLI | **~75–85%** | JSONL · resume · slash |
| **扩展面** | **~75–85%** | MCP×3 · Skills · Plugins · **WebFetch** · OAuth 文件 |
| **Subagent** | **~70–80%** | worktree · 并发 · 白名单 |
| **Rules / Creators** | **~75–85%** | 日用齐 |
| **成本与缓存** | **~55–65%** | C1–C5 + TTL/break；无真 tokenizer |
| **斜杠** | **~75–85%** | 日用 + polish |
| **CLI TUI** | **~65–75%** | 布局/picker/主题（非 React Ink 全家桶） |
| **Electron GUI** | **~40–50%** | M4 壳 + **流式 text + 权限对话框** |
| **产品整体（相对 HC）** | **~65–80%** | 主路径+桌面+扩展加深；诚实上限 |

**主线：** 日用 → PRODUCT/AUTORUN → FULL → **M4 壳** → **本刀：policy/Bash 接线 · WebFetch · Desktop 权限 UI** — 均已 ✅ 最小。

**永不：** 遥测 · 官方市场 API。

---

## 1. 产品目标

| 目标 | 状态 |
|------|------|
| Headless Core | ✅ |
| CLI 可日用 | ✅ |
| 扩展 Skill/MCP/Plugin/Subagent | ✅ 最小+加深 |
| Electron GUI | ✅ **最小可用**（IPC + 权限 UI + 流式） |
| 无遥测 | ✅ |

---

## 13. 总览表（汇报）

| 里程碑 | 状态 | 一句话 |
|--------|------|--------|
| M0–M2 | ✅ | headless 主路径 |
| M-Loop | ✅ 最小 | 分类 + 退避 + PTL |
| M-Tool+Permission | ✅ 最小 | 规则 + auto + **policy 接线 Bash** + sandbox 标记 |
| M-Compact | ✅ 最小 | auto/snip/cached-MC/snip_id |
| M-Slash / Rules / Creators | ✅ | 日用 |
| M-Subagent | ✅ 最小 | worktree · 并发 · 白名单 |
| M-TUI | ✅ 最小 | 布局/picker/主题 |
| M-Cost | ✅ 最小 | C1–C5 · break 检测 |
| M3 | ✅ 最小 | MCP×3 · 市场 · OAuth 文件 · **WebFetch** |
| M5 | ✅ 最小 | JSONL |
| Responses | ✅ 最小 | HTTP SSE · WS 握手路径 |
| **M4 Electron** | ✅ 最小 | 壳 + **流式 + 权限对话框** |
| 官方市场 / 遥测 | 🚫 | 永不 |

**一句话：**  
**`docs/ROADMAP.md` 主路径任务全部圆满（✅ 最小）。**  
相对 HC **~65–80%**，不是无限制 100%。  
可继续打磨：真 OS sandbox、React Ink、浏览器 OAuth、完整 WS 协议、Electron 多窗/设置——**不阻断主路径收口**。

---

## 文档地图

| 文档 | 用途 |
|------|------|
| 本文件 | 里程碑 |
| `TODO.md` | 入口 |
| `TODO_FULL.md` | FULL 限制 |
| `apps/desktop/README.md` | 桌面 |
| 各契约 `docs/*.md` | 真源 |