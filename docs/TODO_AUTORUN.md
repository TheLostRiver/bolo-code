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

| 波次 | ID 前缀 | 目标 |
|------|---------|------|
| **A** | MEM-6 · MEM-7 | Memory 加深（topic 扫描 + project 作用域） |
| **B** | IMPORT-S1 · IMPORT-P1 · IMPORT-X | 只读旁路 skill / 外来插件 **skills 映射**（非官方市场） |
| **C** | SA-PAR · SA-DOC | Subagent 并行/可见性小步（**无** worktree） |
| **D** | CP-OBS · CP-DOC | Compact/context 可观测小步（**无** cached MC / 真 tokenizer） |
| **E** | DOC-SYNC | ROADMAP/TODO/专册水位与完成度收口 |

### 1.2 本轨明确不做（OUT）

| 项 | 原因 |
|----|------|
| **Electron / M4** | 用户：先不急 |
| **T8 完整 Ink TUI** | 大交互面，易拖垮无人值守节奏；另开刀 |
| **Y5+ 企业 YOLO / sandbox / 远程策略** | 需协调；Y0–Y4 已够 headless |
| **Claude/Codex 官方市场 API** | 版权/ToS；永不做 |
| **M-GEN-7 OAuth / 浏览器登录** | 需人机交互 |
| **OR6 Responses WebSocket** | HTTP SSE 已够用 |
| **MEM-8 team / daily / dream** | 多用户与调度；另轨 |
| **C6+ cached MC · SnipTool/UUID · 真 tokenizer** | 高复杂/高风险，另轨 |
| **S14 worktree / swarm** | 另轨 |
| **遥测 / GrowthBook** | 产品红线 |

### 1.3 执行纪律（每刀）

1. 读本轨当前 **最低编号未完成** 切片（一次只推进一条主切片）。  
2. 对照 HC 相关模块 **语义**（不嵌本地绝对路径进文档）。  
3. 改 `packages/*` 契约优先；补 `scripts/test-*.ts`。  
4. 测绿 → 更新专册状态 + `TODO.md`/`ROADMAP.md` 相关行。  
5. **路径范围** `git add` → commit（message 与 tree 一致）→ `git push origin HEAD`。  
6. 立即进入下一未完成切片；**不要**停下来等用户，除非：  
   - 触碰 §1.2 OUT；或  
   - 无法在无密钥/无交互下验证的外部依赖；或  
   - 用户消息要求停下。  
7. 工作区若有**无关脏文件**，不回退、不顺手 commit。

---

## 2. 执行序（严格按序）

### 波次 A — Memory 加深

| 序 | ID | 任务 | 验收 | 专册 |
|----|----|------|------|------|
| A1 | **MEM-6** | topic `*.md` 扫描（排除 `MEMORY.md`）；头信息/描述列表；**确定性**相关挑选（关键词/标题重叠，**不**强制 side-query LLM）；可选注入相关正文片段（有总字节预算） | API + `/memory topics` 或 status 含 topics；`test-memory` 扩绿；无遥测 | `TODO_MEMORY.md` · `MEMORY.md` |
| A2 | **MEM-7** | project-scoped：`.bolo/memory/`（或项目 layout `memoryDir`）与用户 `~/.bolo/memory` **分层**；注入合并规则写清（项目优先或并列，文档+代码一致） | 双根路径 ensure；注入含两源或可配置；测绿 | 同上 |

**A 出口：** MEM-6+7 ✅；MEM-8 仍 ⬜（OUT）。

### 波次 B — 只读导入（非官方市场）

| 序 | ID | 任务 | 验收 | 专册 |
|----|----|------|------|------|
| B1 | **IMPORT-S1** | 配置旁路 skill 根（扩展/对齐 `extraSkillRoots`）；开关默认 off；不改对方文件 | 配置项 + 发现合并 + 测 | `TODO_SKILL_MCP_PLUGIN.md` · `SKILLS.md` · `CONFIG.md` |
| B2 | **IMPORT-P1** | 识别 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json`（或等价清单）→ **仅映射 skills**（+ 可选 mcp 路径提示）；hooks **不保证** | 发现/warn；测 fixture | 同上 · `PLUGINS.md` |
| B3 | **IMPORT-X** | 失败面文档：不支持的 contributes → 显式 warn；禁止写成「完全兼容」 | 文档 + 必要时 warn 测 | 同上 |

**B 出口：** IMPORT-S1/P1/X ✅；未接任何官方 market API。

### 波次 C — Subagent 小步

| 序 | ID | 任务 | 验收 | 专册 |
|----|----|------|------|------|
| C1 | **SA-PAR** | 并行/队列可见性：`/agents`·`/bg` 展示更清晰（状态、完成、失败）；禁止无限递归已有则回归 | slash 文案/字段；相关测绿 | `SUBAGENT.md` |
| C2 | **SA-DOC** | 文档对齐真实行为（fork/async/S8 不升级）；ROADMAP Subagent 水位句更新 | 文档无吹牛 | `ROADMAP.md` |

**C 出口：** 无 worktree；行为可观测。

### 波次 D — Compact 可观测（非算法深挖）

| 序 | ID | 任务 | 验收 | 专册 |
|----|----|------|------|------|
| D1 | **CP-OBS** | `/context` 或 doctor 对 snip/auto/memory 段占用更可读（标签/顺序/预算提示） | 不破坏 cache 稳定前缀；测或脚本断言 | `COMPACTION.md` · `SLASH_COMMANDS.md` |
| D2 | **CP-DOC** | COMPACTION/TODO 标明 cached MC 仍 OUT | 文档 | 同上 |

**D 出口：** 日用可观测提升；**不做** cached microcompact。

### 波次 E — 收口

| 序 | ID | 任务 | 验收 |
|----|----|------|------|
| E1 | **DOC-SYNC** | `TODO.md` §1/§7/§8、`ROADMAP.md` §0/§13、本文件全部切片标 ✅；完成度粗估微调（诚实，不抬到 ~70% 除非证据） | 三处下一刀指向「本轨圆满」或「仅 OUT 残留」 |
| E2 | **SMOKE** | 跑本轨相关 `scripts/test-memory.ts` 及本轨新增/改动测试；记录于 commit 或 docs 一句 | 全绿 |

---

## 3. 单刀 Definition of Done

- [ ] 行为符合验收表  
- [ ] 相关测试绿  
- [ ] 专册状态 ⬜→✅  
- [ ] 无遥测、无本机绝对路径进 docs  
- [ ] 路径范围 commit + push  
- [ ] 未把 OUT 项勾成完成  

---

## 4. 圆满完成（停止条件 · 成功）

同时满足：

1. **A1–A2 · B1–B3 · C1–C2 · D1–D2 · E1–E2** 均为 ✅  
2. §1.2 OUT 仍为 ⬜/不做（允许保持不做）  
3. `TODO_AUTORUN.md` 本文勾选完毕  
4. `TODO.md` / `ROADMAP.md` 写明：**Autorun 轨已收口**；后续需用户新指令才开 OUT 项  

**失败/暂停（允许停，但须写清阻塞）：**

- 连续同一切片无法测绿且已尝试最小回退  
- 必须用户密钥/交互才能继续（写入 `docs/TODO_AUTORUN.md` 阻塞节后停）  

---

## 5. 与其它文档关系

| 文档 | 关系 |
|------|------|
| **本文** | 无人值守**唯一执行序** |
| `TODO.md` | 全局勾选；§8 指向本文 |
| `ROADMAP.md` | 里程碑与分层 % |
| `TODO_MEMORY.md` | A 波次细节 |
| `TODO_SKILL_MCP_PLUGIN.md` | B 波次细节 |
| `TODO_AUTO_PERMISSIONS.md` | **不**在本轨继续 Y5+ |

---

## 6. 启动指令（用户侧）

用户只需发送类似：

```text
按 TODO_AUTORUN 执行
```

或：

```text
开始无人值守，直到路线图完成
```

代理即从 **第一个 ⬜ 切片**连续执行至 §4。

**停止指令：** `停下` / `stop autorun` / `暂停路线图`。

---

## 7. 切片状态总表

| ID | 状态 |
|----|------|
| MEM-6 | ⬜ |
| MEM-7 | ⬜ |
| IMPORT-S1 | ⬜ |
| IMPORT-P1 | ⬜ |
| IMPORT-X | ⬜ |
| SA-PAR | ⬜ |
| SA-DOC | ⬜ |
| CP-OBS | ⬜ |
| CP-DOC | ⬜ |
| DOC-SYNC | ⬜ |
| SMOKE | ⬜ |

**当前下一刀（启动后第一刀）：`MEM-6`。**

---

## 8. 一句话

> **不碰 Electron 与企业 YOLO；把 Memory、只读导入、子代理可见性、compact 可观测按序做完并收口文档，即本轨圆满。**