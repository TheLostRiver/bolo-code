# 整盘后续执行轨（Full Track · 非 Electron）

> **当前整盘执行真源**（相对 HC 未完成能力，**不是** `TODO_PRODUCT` 那 10 刀窄轨）。  
> 总览水位：`docs/ROADMAP.md` · 全局入口：`docs/TODO.md`。  
> 历史窄轨：`TODO_AUTORUN.md` ✅ · `TODO_PRODUCT.md` ✅（zip/SA/doctor/窄 TUI，**子集**）。  
> **用户定调（2026）：除 Electron 外，下列缺口都要做。Electron / M4 明确后置、不急。**  
> 原则：无遥测；对照 HC **语义**；状态按代码行为；每波测绿 → 路径 commit → push。

---

## 0. 一句话

> 在 headless 主路径可日用（~45–60%）之上，按 **TUI → Compact/Cache → Subagent → 扩展/协议 → 权限企业层 → 会话/杂项** 抬到相对 HC 更满的水位。  
> **Electron 不进本轨。** 官方 Claude/Codex **市场 API** 仍禁止；**自有**市场深度可做。

---

## 1. 已齐（勿当缺口）

| 块 | 状态 |
|----|------|
| Loop / Tools / STE / 规则权限 / auto Y0–Y4+Y3.6 | ✅ 最小 |
| Compact 日用 + snip + auto | ✅ 最小 |
| JSONL / Slash / Rules / Creators | ✅ |
| MCP 三 transport / Skills / PL Spec / PL-MKT 最小 + **zip 安装** | ✅ 最小 |
| Subagent 真 loop + 并发帽 + S8 | ✅ 最小 |
| Memory MEM-0…7 + IMPORT 只读 | ✅ 最小 |
| TUI T0–T7 + **窄终端 P-T9** | ✅ 最小 |
| Responses HTTP SSE | ✅ 最小 |

**口径：** 主路径可跑 ≠ 相对 HC 完成。多数域仍是 **🟡 最小**。

---

## 2. 范围

### 2.1 本轨要做（IN）

| 波次 | 主题 | 代表 ID |
|------|------|---------|
| **F1** | CLI TUI 加深 | T8 Ink · T9 主题/吉祥物 |
| **F2** | Compact / Cache 深刀 | CP-CACHE-MC · CP-SNIP-UUID · C6 TTL/break |
| **F3** | Subagent 架构 | SA-WORKTREE · SA-PAR2 · S8+ |
| **F4** | 扩展与协议 | MCP-OAuth · PL-MKT-DEPTH · Skills+ · OR6 WS |
| **F5** | 权限企业层 | Y5+ sandbox / 策略（无遥测、无抄官方店） |
| **F6** | Memory / 会话余量 | MEM-8 · J-D 分叉链（若仍缺） |
| **F7** | 收口 | 文档水位 · 回归 · 诚实完成度 |

### 2.2 本轨明确后置（OUT · 另令）

| 项 | 原因 |
|----|------|
| **M4 Electron / apps/desktop 真做** | 用户：**不急** |
| **Claude/Codex 官方市场 API / 商标店** | 版权/ToS；**永不**当源 |
| **遥测 / GrowthBook** | 产品红线 |

> 注：OAuth、worktree、cached MC、T8 Ink、Y5+ **已从「永久 OUT」改为本轨 IN**（用户要求都要做）。

---

## 3. 执行序（严格按波次；波内可按表序）

### 波次 F1 — CLI TUI（优先 · 你强调过 TUI）

| 序 | ID | 任务 | 验收 | 专册 |
|----|-----|------|------|------|
| 1 | **F-T8-INK** | 完整 Ink（或等价）TUI 骨架：欢迎区/消息流/输入；**可** plain 回退 | 可 `bolo` TTY 切换；测或手工清单 | `TUI.md` |
| 2 | **F-T8-PICKER** | 会话列表 **箭头键 picker**（resume）；非 TTY 仍表格式 | resume 路径 | `TUI.md` · `SESSIONS.md` |
| 3 | **F-T9-THEME** | 主题 · 窄终端已有则兼容 · **吉祥物开关**（env/config） | 配置项 + 文档 | `TUI.md` · `BRAND.md` |
| 4 | **F-TUI-DOC** | TUI/ROADMAP M-TUI 水位上修；标明 Electron 仍后置 | 文档 | |

**F1 出口：** M-TUI 从 ~40–50% 抬到「日用 Ink 可用」量级；**仍非** Electron。

---

### 波次 F2 — Compact / Cache 深刀

| 序 | ID | 任务 | 验收 | 专册 |
|----|-----|------|------|------|
| 5 | **F-CP-CACHED-MC** | cached / API microcompact 语义最小（对照 HC；**无**遥测开关） | 测 + COMPACTION | `COMPACTION.md` |
| 6 | **F-CP-SNIP-UUID** | SnipTool / UUID 链或可回放边界（能复现则文档化限制） | 测 | 同上 |
| 7 | **F-C6-TTL** | prompt cache **1h TTL / break detection** 最小可观测 | 测或 provider 测 | `PROMPT_CACHE.md` |
| 8 | **F-CP-DOC** | 真 tokenizer 若仍不做则显式 ⬜；完成度诚实 | 文档 | |

**F2 出口：** Compact/Cost 🟡→更深；高风险切片允许「最小可用 + 限制说明」。

---

### 波次 F3 — Subagent 加深

| 序 | ID | 任务 | 验收 | 专册 |
|----|-----|------|------|------|
| 9 | **F-SA-WORKTREE** | worktree 隔离最小（可开可关；失败可回落同 cwd） | 测 + SUBAGENT | `SUBAGENT.md` |
| 10 | **F-SA-PAR2** | 并行策略/队列（在并发帽之上：排队 vs 拒绝可配置） | 测 | 同上 |
| 11 | **F-S8-PLUS** | 子权限细化（工具白名单与父 mode 矩阵文档+代码） | 测 | 同上 · PERMISSIONS |
| 12 | **F-SA-DOC** | ROADMAP Subagent 水位；swarm/teammate 若未做保持 ⬜ | 文档 | |

**F3 出口：** worktree 最小可用；无限递归仍禁止。

---

### 波次 F4 — 扩展与协议

| 序 | ID | 任务 | 验收 | 专册 |
|----|-----|------|------|------|
| 13 | **F-MCP-OAUTH** | MCP OAuth / headersHelper **最小**（本地回调或 device flow 文档化；失败可诊） | 测 fixture 或 mock；`MCP.md` | `TODO_SKILL_MCP_PLUGIN` M-GEN-7 |
| 14 | **F-PL-DEPTH** | **自有**市场加深：git/zip 缓存、版本、更新提示（**非**官方店） | 测 · PLUGINS | |
| 15 | **F-SKILLS-PLUS** | 远程 skill / 动态 discovery **可选**预取（默认 off；有预算） | 测 · SKILLS | |
| 16 | **F-OR6-WS** | Responses **WebSocket** 最小（HTTP SSE 仍默认） | 测 · PROVIDERS | |
| 17 | **F-EXT-DOC** | 扩展面水位；禁止写成「兼容 Claude 官方市场」 | 文档 | |

**F4 出口：** OAuth/WS/自有市场深度有最小路径；红线文档醒目。

---

### 波次 F5 — 权限企业层（Y5+）

| 序 | ID | 任务 | 验收 | 专册 |
|----|-----|------|------|------|
| 18 | **F-Y5-SANDBOX** | 本地 sandbox / 命令隔离 **最小**（能关；Windows/POSIX 差异写清） | 测 · PERMISSIONS | `TODO_AUTO_PERMISSIONS` |
| 19 | **F-Y5-POLICY** | 会话/项目级策略文件（allow/deny 扩展；**无**远程 GrowthBook） | 测 · CONFIG | |
| 20 | **F-Y5-DOC** | 与 Y0–Y4 边界；相对 HC auto 语义口径更新 | 文档 | |

**F5 出口：** 企业向可控，仍无遥测、无官方店绑定。

---

### 波次 F6 — Memory / 会话余量

| 序 | ID | 任务 | 验收 | 专册 |
|----|-----|------|------|------|
| 21 | **F-MEM-8** | team / daily log **最小**（可默认 off；无云同步） | 测 · MEMORY | `TODO_MEMORY` |
| 22 | **F-JD-FORK** | JSONL 分叉链 / parentUuid **若产品需要**则最小；否则文档永久 ⬜ | 专册勾选 | `TODO_SESSION_JSONL` |
| 23 | **F-MISC-DOC** | model 目录/多模态等：清单化 ⬜ 或最小 stub 政策 | ROADMAP | |

---

### 波次 F7 — 整盘收口

| 序 | ID | 任务 | 验收 |
|----|-----|------|------|
| 24 | **F-SYNC** | TODO/ROADMAP/本文件状态一致；分层 % 诚实上修（仍避免无依据 ~90%） | |
| 25 | **F-SMOKE** | 本轨相关 `scripts/test-*.ts` 全绿 + 关键 smoke | |
| 26 | **F-ELECTRON-HANDOFF** | **仅文档**：Electron 启动条件/包边界，**不实现** | `ARCHITECTURE` · desktop README |

---

## 4. 纪律

1. **一次主切片一个 ID**；文档可并行。  
2. 先契约 `packages/*`，再 CLI；**不**提前做 Electron。  
3. 测绿 → 勾选 → 路径 commit → push。  
4. 触碰 §2.2 OUT（Electron/官方店/遥测）→ 停。  
5. 用户「停下」→ 停。  
6. 高风险刀（cached MC / worktree / OAuth）允许 **最小 + 限制说明**，禁止 stub 勾满 ✅。

---

## 5. 圆满条件（本轨）

- F1–F7 表内 ID 均为 ✅ 或显式 **延期说明**（须用户同意）  
- Electron 仍 ⬜ 且文档写「后置」  
- 相对 HC 完成度有依据上修，**不**宣称产品 100%  
- `TODO.md` §8 指向「Full Track 收口；Electron 另令」

---

## 6. 状态总表

| ID | 状态 |
|----|------|
| F-T8-INK | ⬜ |
| F-T8-PICKER | ⬜ |
| F-T9-THEME | ⬜ |
| F-TUI-DOC | ⬜ |
| F-CP-CACHED-MC | ⬜ |
| F-CP-SNIP-UUID | ⬜ |
| F-C6-TTL | ⬜ |
| F-CP-DOC | ⬜ |
| F-SA-WORKTREE | ⬜ |
| F-SA-PAR2 | ⬜ |
| F-S8-PLUS | ⬜ |
| F-SA-DOC | ⬜ |
| F-MCP-OAUTH | ⬜ |
| F-PL-DEPTH | ⬜ |
| F-SKILLS-PLUS | ⬜ |
| F-OR6-WS | ⬜ |
| F-EXT-DOC | ⬜ |
| F-Y5-SANDBOX | ⬜ |
| F-Y5-POLICY | ⬜ |
| F-Y5-DOC | ⬜ |
| F-MEM-8 | ⬜ |
| F-JD-FORK | ⬜ |
| F-MISC-DOC | ⬜ |
| F-SYNC | ⬜ |
| F-SMOKE | ⬜ |
| F-ELECTRON-HANDOFF | ⬜ |

**当前下一刀：`F-T8-INK`。**

---

## 7. 启动令

```text
按 TODO_FULL 执行
```

```text
开始整盘后续轨，直到圆满（不做 Electron）
```

---

## 8. 与旧文档关系

| 文档 | 关系 |
|------|------|
| **本文** | **整盘后续唯一执行序** |
| `TODO_PRODUCT.md` | 历史产品小轨 ✅ |
| `TODO_AUTORUN.md` | 历史余量小轨 ✅ |
| `TODO_AUTO_PERMISSIONS.md` | F5 细节 |
| `TODO_SKILL_MCP_PLUGIN.md` | F4 细节 |
| `TODO_MEMORY.md` | F6 MEM-8 |
| `COMPACTION.md` / `TUI.md` / `SUBAGENT.md` | 契约 |

---

## 9. 一句话

> **除 Electron 外的大缺口都进本轨：先 TUI(Ink)，再 compact/cache，再 worktree，再 OAuth/自有市场/WS，再企业权限，再 memory/会话余量，最后收口。**  
> **官方店与遥测永不做。**