# Bolo Code 整体路线图（详细版）

> 更新：**ROADMAP 主路径里程碑收口**（代码行为 + 诚实限制）。  
> 执行真源历史：`TODO_FULL` / `TODO_PRODUCT` / `TODO_AUTORUN` 均已最小闭环。  
> **永不：** 遥测 · Claude/Codex **官方市场 API**。  
> 原则：状态按代码行为；「✅ 最小」≠ 无限制、≠ 相对 HC 100%。

---

## 0. 一句话进度

| 层 | 粗估 | 说明 |
|----|------|------|
| **Headless 核心** | **~70–80%** | loop/STE/权限/auto/snip/cached-MC 标记/cache TTL 检测 |
| 会话与 CLI | **~75–85%** | JSONL · resume/continue · slash · list/title/note |
| **扩展面** | **~70–80%** | MCP×3 · Skills · Plugin Spec · PL-MKT+zip · OAuth token 文件 · 远程 skill 根 |
| **Subagent** | **~65–75%** | 真 loop · 并发帽 · worktree 可选 · 工具白名单 |
| **Rules / Creators** | **~75–85%** | 日用齐 |
| **成本与缓存** | **~55–65%** | C1–C5 + TTL/前缀 break；真 tokenizer 仍限制 |
| **斜杠** | **~75–85%** | 日用 + polish |
| **CLI TUI** | **~60–70%** | T0–T9 + ink 等价布局 + 箭头 picker + 主题 |
| **Electron GUI** | **~25–35%** | **M4 最小壳** main/preload/renderer+IPC |
| **产品整体（相对 HC）** | **~60–75%** | 主路径+扩展+桌面壳；非 100% HC 密度 |

**口径：**

| 口径 | 含义 |
|------|------|
| **主路径** | createSession → queryLoop → tools → JSONL/CLI/**Desktop IPC** 可闭环 |
| **相对 HC** | 能力密度对照（诚实上限，不写 100%） |
| **auto 语义** | ~85–90% headless 行为 |

**主线（全部最小闭环）：**

1–24. ~~日用主路径 · PRODUCT/AUTORUN 小轨 · FULL 加深~~ ✅ 最小  
25. ~~**TODO_FULL**~~ ✅ 最小（限制见 `TODO_FULL.md` §3）  
26. ~~**M4 Electron 最小壳**~~ ✅（IPC + mock 默认可启；非完整产品 GUI）  
27. **永不：** 遥测 · 官方市场 API  

---

## 1. 产品目标与硬优先级

| 目标 | 状态 |
|------|------|
| Headless Core | ✅ 主路径 |
| CLI 可日用 | ✅ |
| 扩展 Skill/MCP/Plugin/Subagent | ✅ 最小 + FULL 加深 |
| Electron GUI | ✅ **最小壳**（可继续打磨） |
| 无遥测 | ✅ 红线 |

---

## 7–12. 专册与里程碑（摘要）

详见各 `docs/*.md`。里程碑总表：

| 里程碑 | 状态 | 一句话 |
|--------|------|--------|
| M0–M2 | ✅ | headless 主路径 |
| M-Loop 韧性 | ✅ 最小 | 分类 + 退避 + PTL |
| M-Tool+Permission | ✅ 最小 | 规则 + auto Y0–Y4；Y5 标记级 sandbox/policy |
| M-Compact | ✅ 最小 | auto/snip/cached-MC 标记/snip_id |
| M-Slash / Rules / Creators | ✅ | 日用 |
| M-Subagent | ✅ 最小 | worktree 可选 + 并发 + 白名单 |
| M-TUI | ✅ 最小 | ink 等价 + picker + 主题（非 React Ink 全家桶） |
| M-Cost | ✅ 最小 | C1–C5 + break 检测 |
| M3 扩展 | ✅ 最小 | 三 transport + 市场 zip + OAuth 文件 |
| M5 会话 | ✅ 最小 | JSONL 主路径 |
| Responses | ✅ 最小 | HTTP SSE 默认；WS 有真实握手路径/失败可观测 |
| **M4 Electron** | ✅ 最小 | desktop IPC 壳 |
| 官方市场 / 遥测 | 🚫 | 永不 |

---

## 13. 总览表（汇报用）

| 里程碑 | 状态 | 一句话 |
|--------|------|--------|
| M0–M2 | ✅ | headless 主路径可跑 |
| **M-Loop 韧性** | ✅ 最小 | 分类 + 429/5xx 退避；PTL |
| **M-Tool+Permission** | ✅ 最小 | 规则 + auto；policy/sandbox **标记** |
| **M-Compact 日用** | ✅ 最小 | auto · snip · cached-MC 标记 · snip_id |
| **M-Slash** | ✅ | 日用 + polish |
| **M-Rules** | ✅ | path-scoped + `/rules` |
| **M-Creators** | ✅ | bundled creators |
| **M-Subagent** | ✅ 最小 | S0–S8 · 并发 · worktree 可选 |
| **M-TUI** | ✅ 最小 | T0–T9 · 布局/picker/主题 |
| **M-Cost** | ✅ 最小 | C1–C5 · TTL/前缀 break |
| **M3** | ✅ 最小 | MCP×3 · PL2 · PL-MKT+zip · OAuth 文件 |
| **M5** | ✅ 最小 | JSONL · title/note/list |
| **Responses** | ✅ 最小 | HTTP SSE · WS 最小路径 |
| **M4 Electron** | ✅ 最小 | main/preload/renderer + core IPC |
| 官方市场 API · 遥测 | 🚫 | 永不做 |

**一句话：**  
**ROADMAP 主路径里程碑均已「✅ 最小」收口**（含 Electron 壳）。  
相对 HC 诚实 **~60–75%**，不是无限制的 100%。  
永不：遥测、Claude/Codex 官方市场。  
执行入口 → `docs/TODO.md` · 限制清单 → `docs/TODO_FULL.md` §3 · 桌面 → `apps/desktop/README.md`。

---

## 文档地图

| 文档 | 用途 |
|------|------|
| **本文件** | 里程碑 / 分层 % |
| `TODO.md` | 执行入口 |
| `TODO_FULL.md` | FULL 切片与限制 |
| `TODO_PRODUCT.md` / `TODO_AUTORUN.md` | 历史小轨 |
| `ARCHITECTURE.md` · `TUI.md` · `apps/desktop/README.md` | 架构与桌面 |