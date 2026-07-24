# 无人值守执行轨（Autorun Track）

> **用途：** 用户离开期间，下达「按路线图执行」后，代理**只按本文顺序**推进，直到 **§4 圆满完成** 或用户要求停下。  
> **总入口：** `docs/TODO.md`；里程碑：`docs/ROADMAP.md`。  
> **原则：** 无遥测；对照 HC **语义**重实现；状态按**代码行为**；每刀测绿 → 路径范围 commit → push；**不**开 Electron。

---

## 0. 一句话

> **Headless 日用水位加深：** Memory 可用加深 → 可选导入兼容 → 会话/子代理/紧凑余量 → 文档水位收口。  
> **Electron / 企业 YOLO / 官方市场 / OAuth 浏览器流** 不在本轨。

---

## 1. 范围

### 1.1 本轨要做（IN）

| 波次 | ID 前缀 | 目标 | 状态 |
|------|---------|------|------|
| **A** | MEM-6 · MEM-7 | Memory 加深（topic 扫描 + project 作用域） | ✅ |
| **B** | IMPORT-S1 · IMPORT-P1 · IMPORT-X | 只读旁路 skill / 外来插件 **skills 映射**（非官方市场） | ✅ |
| **C** | SA-PAR · SA-DOC | Subagent 并行/可见性小步（**无** worktree） | ✅ |
| **D** | CP-OBS · CP-DOC | Compact/context 可观测小步（**无** cached MC / 真 tokenizer） | ✅ |
| **E** | DOC-SYNC · SMOKE | ROADMAP/TODO/专册水位与完成度收口 | ✅ |

### 1.2 本轨明确不做（OUT）

| 项 | 原因 |
|----|------|
| **Electron / M4** | 用户：先不急 |
| **T8 完整 Ink TUI** | 大交互面；另开刀 |
| **Y5+ 企业 YOLO / sandbox / 远程策略** | 需协调；Y0–Y4 已够 headless |
| **Claude/Codex 官方市场 API** | 版权/ToS；永不做 |
| **M-GEN-7 OAuth / 浏览器登录** | 需人机交互 |
| **OR6 Responses WebSocket** | HTTP SSE 已够用 |
| **MEM-8 team / daily / dream** | 多用户与调度；另轨 |
| **C6+ cached MC · SnipTool/UUID · 真 tokenizer** | 高复杂/高风险，另轨 |
| **S14 worktree / swarm** | 另轨 |
| **遥测 / GrowthBook** | 产品红线 |

---

## 2. 执行结果摘要

| 序 | ID | 结果 |
|----|-----|------|
| A1 | MEM-6 | `scanMemoryTopics` · 确定性相关 · `/memory topics` |
| A2 | MEM-7 | user + project `.bolo/memory` 并列注入 |
| B1 | IMPORT-S1 | `extraSkillRoots`（既有 + 测） |
| B2 | IMPORT-P1 | `importForeignPluginSkills` · `foreignPluginRoots` |
| B3 | IMPORT-X | unsupported contributes → warn；PLUGINS.md |
| C1 | SA-PAR | `/agents status` 计数 RUNNING/DONE/ERROR |
| C2 | SA-DOC | SUBAGENT.md 对齐 |
| D1 | CP-OBS | `/context` section 角色 + memory 预算行 |
| D2 | CP-DOC | COMPACTION.md OUT 标明 cached MC |
| E1 | DOC-SYNC | 本文 + TODO/ROADMAP 收口 |
| E2 | SMOKE | `test-memory` · `test-import-compat` · `test-subagent` 绿 |

---

## 3. 切片状态总表

| ID | 状态 |
|----|------|
| MEM-6 | ✅ |
| MEM-7 | ✅ |
| IMPORT-S1 | ✅ |
| IMPORT-P1 | ✅ |
| IMPORT-X | ✅ |
| SA-PAR | ✅ |
| SA-DOC | ✅ |
| CP-OBS | ✅ |
| CP-DOC | ✅ |
| DOC-SYNC | ✅ |
| SMOKE | ✅ |

**本轨圆满：** §4 条件已满足。  
**下一动作：** 仅当用户新指令时开 OUT 项（Electron / OAuth / 企业 YOLO 等）。

---

## 4. 圆满完成（停止条件 · 成功）

同时满足：

1. ~~**A1–A2 · B1–B3 · C1–C2 · D1–D2 · E1–E2** 均为 ✅~~ **已满足**  
2. §1.2 OUT 仍为 ⬜/不做  
3. 本文勾选完毕  
4. `TODO.md` / `ROADMAP.md` 写明：**Autorun 轨已收口**

---

## 5. 启动 / 停止（历史）

- 启动：`按 TODO_AUTORUN 执行`  
- 停止：`停下` / `stop autorun`

---

## 6. 一句话

> **Autorun 轨已完成：Memory 加深、只读导入、子代理可见性、context 可观测均已落地；Electron 与企业 YOLO 仍 OUT。**