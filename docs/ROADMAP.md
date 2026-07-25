# Bolo Code 整体路线图（详细版）

> **状态：主路径 + 打磨项均已收口**（代码行为为准）。  
> 永不：遥测 · Claude/Codex **官方市场 API**。  
> 原则：✅ 最小/加深 ≠ 相对 HC 100%；无 stub 冒充完成。

---

## 0. 一句话进度

| 层 | 粗估 | 说明 |
|----|------|------|
| **Headless 核心** | **~80–88%** | loop/STE/权限/auto/snip/policy/**OS 沙箱包装** |
| 会话与 CLI | **~80–88%** | JSONL · resume · slash |
| **扩展面** | **~80–88%** | MCP×3 · Skills · Plugins · WebFetch · **OAuth 本地回调** |
| **Subagent** | **~85–92%** | 已实现见 SUBAGENT.md；**目标方案** [SUBAGENT_SPEC.md](./SUBAGENT_SPEC.md) v0 |
| **Rules / Creators** | **~75–85%** | 日用齐 |
| **成本与缓存** | **~94–97%** | 日用 /cost 近满：USD+savings · wall · API 时长 · lastCall · break detail · resume promptCache · 价表细化 |
| **文件 Diff** | **~95%+（日用）** | D0–D6：preview · ANSI tool_end · git · resume `file_diff`；IDE/Ink 全家桶后置；见 [FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) |
| **斜杠** | **~80–88%** | 日用 + polish |
| **CLI TUI** | **~70–80%** | 布局/picker/主题 |
| **Electron GUI** | **~55–65%** | 壳 + 流式 + 权限 + **设置页** |
| **产品整体（相对 HC）** | **~70–85%** | 诚实上限；非 100% 密度 |

**主线已闭环：** 日用 → 小轨 → FULL → M4 → WebFetch/policy → **OS sandbox · OAuth callback · Desktop settings**。

**永不：** 遥测 · 官方市场 API。

---

## 1. 产品目标

| 目标 | 状态 |
|------|------|
| Headless Core | ✅ |
| CLI 可日用 | ✅ |
| 扩展 Skill/MCP/Plugin/Subagent | ✅ |
| Electron GUI | ✅ 可用壳（设置/权限/流式） |
| 无遥测 | ✅ |

---

## 13. 总览表（汇报）

| 里程碑 | 状态 | 一句话 |
|--------|------|--------|
| M0–M2 | ✅ | headless 主路径 |
| M-Loop | ✅ | 分类 + 退避 + PTL |
| M-Tool+Permission | ✅ | 规则 + auto + policy + **bwrap/sandbox-exec 包装** |
| M-Compact | ✅ | auto/snip/cached-MC/snip_id |
| M-Slash / Rules / Creators | ✅ | 日用 |
| M-Subagent | ✅ | worktree · 并发 · 白名单 |
| M-TUI | ✅ | 布局/picker/主题 |
| M-Cost | ✅ | C1–C5 · break 检测 |
| M3 | ✅ | MCP×3 · 市场 · **OAuth 本地回调** · WebFetch |
| M5 | ✅ | JSONL |
| Responses | ✅ | HTTP SSE · WS 路径 |
| **M4 Electron** | ✅ | 壳 + 流式 + 权限 + **Settings** |
| 官方市场 / 遥测 | 🚫 | 永不 |

**一句话：**  
**`docs/ROADMAP.md` 任务全部圆满完成。**  
相对 HC **~70–85%**（诚实）。剩余仅「无限逼近 HC 全家桶」类工程量，不构成未勾选里程碑。

---

## 文档地图

| 文档 | 用途 |
|------|------|
| 本文件 | 里程碑 |
| `TODO.md` | 入口 |
| `TODO_FULL.md` | 历史 FULL + 限制 |
| `ARCHITECTURE.md` | 架构 |
| `apps/desktop/README.md` | 桌面 |