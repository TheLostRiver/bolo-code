# Bolo Code 总任务清单（TODO）

> **执行入口**：勾选与优先级以本文为准；里程碑见 `docs/ROADMAP.md`。  
> 更新：**整盘后续真源 `docs/TODO_FULL.md`**（除 Electron 外大缺口均 IN）。  
> 历史小轨：`TODO_AUTORUN` ✅ · `TODO_PRODUCT` ✅（**不是**整盘完成）。  
> 原则：无遥测；对照参考语义；状态按代码行为；**主路径可日用 ≠ 相对 HC 完成**。

---

## 0. 怎么用

| 文档 | 角色 |
|------|------|
| **本文 `TODO.md`** | **P0→P3 总序**、已交付表、**本周默认下一刀** |
| `ROADMAP.md` | 里程碑、分层 %、验收矩阵 |
| **`TODO_FULL.md`** | **整盘后续执行轨（当前真源；无 Electron）** |
| `TODO_PRODUCT.md` | 历史小轨（zip/SA/doctor/窄 TUI）✅ |
| `TODO_AUTORUN.md` | 历史余量小轨（MEM/IMPORT/可观测）✅ |
| `TODO_AUTO_PERMISSIONS.md` | Auto/YOLO；F5 企业层细节 |
| `TODO_SKILL_MCP_PLUGIN.md` | Skill/MCP/Plugin；F4 细节 |
| `TODO_MEMORY.md` | Memory；F6 MEM-8 |
| `TODO_SESSION_JSONL.md` | JSONL；分叉链余量 |
| `TUI.md` · `COMPACTION.md` · `SUBAGENT.md` · `MCP.md` · `PLUGINS.md` · `PERMISSIONS.md` | 契约 |
| 其它 `docs/*.md` | 契约真源 |

**规则：** 一次只推进 **一条主切片**；整盘序以 `TODO_FULL` 为准。

---

## 1. 一句话现状

```text
主路径可跑（脚本/CLI）— 相对 HC headless ~55–70%（勿写 ~70% / 勿写「路线图完成」）。

已齐（最小）：
  Loop/STE/权限/auto Y0–Y4 · Compact+snip · JSONL · Slash · Rules · Creators
  MCP×3 · Skills · Plugin Spec · PL-MKT+zip · Subagent+并发帽 · Memory+IMPORT
  TUI T0–T7+窄终端 · Responses HTTP SSE

未齐（进 TODO_FULL，除 Electron）：
  T8 Ink + picker + 主题/吉祥物
  cached MC · Snip UUID · C6 TTL/break
  worktree · 子权限细化 · 并行策略
  MCP OAuth · 自有市场深度 · Skills+ · Responses WS
  Y5+ sandbox/策略
  MEM-8 · JSONL 分叉（按需）

后置：
  Electron / M4（用户：不急）
永不：
  遥测 · Claude/Codex 官方市场 API
```

| 优先级 | 含义（当前） |
|--------|----------------|
| **P0** | 主路径/日用最小已 🟡✅ |
| **P1** | **`TODO_FULL` 波次 F1–F4**（TUI → Compact → Subagent → 扩展） |
| **P2** | **F5–F6**（企业权限 · Memory/会话余量） |
| **P3** | **Electron**（后置）· 打磨 |

粗估相对 HC：**~55–70%**。`TODO_PRODUCT` 收口 **≠** 整盘完成。

---

## 2. 已交付（摘要 · 勿当缺口）

会话/CLI · 斜杠/Rules/Cache 标记 · 扩展最小 · Loop/TP/CP 日用 · auto Y0–Y4 · PL-MKT+zip · Memory MEM-0…7 · IMPORT · 窄 TUI · doctor 健康 — 详见历史提交与各专册 ✅。

---

## 3–6. P0 / 余量 / 后置（与 FULL 对齐）

| 区 | 状态 | 去向 |
|----|------|------|
| P0 日用最小 | ✅ 最小 | 维持 |
| C6+ / cached MC / Snip UUID | ⬜ | **TODO_FULL F2** |
| T8 Ink / T9 主题 | ⬜ / 窄终端✅ | **TODO_FULL F1** |
| S8+ / worktree | ⬜ | **TODO_FULL F3** |
| OAuth / OR6 / Skills+ / 自有市场深 | ⬜ | **TODO_FULL F4** |
| Y5+ 企业层 | ⬜ | **TODO_FULL F5** |
| MEM-8 | ⬜ | **TODO_FULL F6** |
| **Electron M4** | ⬜ | **后置 · 不进 FULL 实现** |
| 官方市场 API · 遥测 | 🚫 | 永不 |

---

## 7. 推荐执行顺序（当前）

```text
已完成：
  主路径最小 · AUTORUN 小轨 · PRODUCT 小轨（zip/SA/doctor/窄 TUI）

进行中（整盘）：
  docs/TODO_FULL.md
    F1 TUI(Ink) → F2 Compact/Cache → F3 Subagent/worktree
    → F4 OAuth/市场深/WS → F5 Y5+ → F6 MEM-8 → F7 收口

后置：
  Electron
```

---

## 8. 本周默认「下一刀」

若只开一刀：

> **docs/TODO_FULL.md 已圆满收口（最小可验收）。**  
> - Electron **仍后置**；官方市场 API / 遥测 **永不**  
> - 相对 HC ~55–70%（诚实）；非 100% 产品完成  
> - 下一刀仅：Electron 真做，或用户点名加深某限制项  

---

## 9. 与 ROADMAP 映射

| TODO | ROADMAP |
|------|---------|
| FULL F1 | M-TUI |
| FULL F2 | M-Compact / M-Cost |
| FULL F3 | M-Subagent |
| FULL F4 | M3 扩展 / Responses |
| FULL F5 | M-Tool+Permission 企业层 |
| FULL F6 | Memory / M5 余量 |
| Electron | M4 后置 |

---

## 10. 检查清单（开 PR 前）

- [ ] 无遥测  
- [ ] 文档无本机绝对路径  
- [ ] 相关 `scripts/test-*.ts` 绿  
- [ ] stub 未勾满 ✅  
- [ ] 完成度区分 **主路径** vs **相对 HC** vs **小轨收口**  
- [ ] 未把 Electron 当本轨完成  

---

**一句话：**  
主路径可日用；**TODO_FULL 最小出口 ✅**；相对 HC **~55–70%**。  
**Electron 不急。** 官方店/遥测永不做。
