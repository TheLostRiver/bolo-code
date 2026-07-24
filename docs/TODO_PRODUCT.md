# 产品级执行轨（Product Track）

> **整盘 headless 后续的唯一执行真源**（用户选 B：按产品域推进，**不是** Memory 窄轨）。  
> 总览水位：`docs/ROADMAP.md` · 全局勾选入口：`docs/TODO.md`。  
> 历史窄轨：`docs/TODO_AUTORUN.md`（MEM/IMPORT/可观测）**已圆满**，只是产品子集，**不得**再当「整体路线图」。  
> **原则：** 无遥测；对照 HC **语义**；状态按**代码行为**；每刀测绿 → 路径范围 commit → push。

---

## 0. 产品定位（整盘，不是单域）

```text
已齐（主路径可日用）：
  Loop / Tools / Permission / auto Y0–Y4 / Compact+snip / JSONL / Slash
  MCP 三 transport / Skills / Plugins Spec+PL-MKT 最小 / Subagent 最小
  Memory MEM-0…7 / IMPORT 只读 / context·agents 可观测小步

本轨要抬（headless 产品面）：
  自有插件 zip 安装 → 子代理并发可靠 → doctor 健康面 → 窄终端 TUI → 文档收口

本轨不做（OUT，需用户另令）：
  Electron · 完整 Ink TUI · 企业 YOLO/sandbox · 官方市场 API
  MCP OAuth 浏览器流 · worktree/swarm · cached MC · Responses WS · MEM-8 team
```

| 口径 | 现状（诚实） |
|------|----------------|
| 主路径 | 可 CLI/脚本闭环 |
| 相对 HC headless | **~42–58%**（本轨收口后可微调至 ~45–60%，**不**写 ~70%） |
| auto 语义 | ~85–90%（非企业/UI） |
| Electron | ~5% 占位 · **OUT** |

---

## 1. 文档角色

| 文档 | 角色 |
|------|------|
| **`TODO_PRODUCT.md`（本文）** | **当前整盘执行序**；无人值守只认本文 ID 顺序 |
| `TODO.md` | 全局已交付表 + §8 指向本文 |
| `ROADMAP.md` | 分层 % · 里程碑 · 验收矩阵 |
| `TODO_AUTORUN.md` | **历史**小轨（已 ✅） |
| 各专册 | 单域契约（MEMORY / PLUGINS / SUBAGENT / TUI…） |

---

## 2. OUT（本轨禁止开刀）

| 项 | 原因 |
|----|------|
| **M4 Electron / apps/desktop 真做** | 用户：先不急 |
| **T8 完整 Ink**（箭头 picker / 全屏 TUI） | 大交互；本轨仅 P-T9 窄终端小步 |
| **Y5+ 企业 YOLO / sandbox / 远程策略** | 需协调 |
| **Claude/Codex 官方市场 API** | 版权/ToS |
| **M-GEN-7 OAuth 浏览器登录** | 人机交互 |
| **OR6 Responses WebSocket** | HTTP SSE 已够用 |
| **S14 worktree / swarm** | 架构大刀 |
| **C6+ cached MC · SnipTool/UUID · 真 tokenizer** | 高风险另轨 |
| **MEM-8 team / daily / dream** | 多用户调度 |
| **遥测 / GrowthBook** | 红线 |

触碰 OUT → **停**，在本文写「阻塞」节，等用户。

---

## 3. 执行序（严格按序 · 未完成不得跳）

### 波次 P1 — 扩展安装加深（自有市场，非官方）

| 序 | ID | 任务 | 验收 | 模块提示 |
|----|-----|------|------|----------|
| 1 | **P-PL-ZIP** | 本地 `.zip` 安装：解压临时目录 → 校验 `bolo.plugin.json` → 装入 user/project `plugins/`；支持 `/plugins install` zip 路径或 `path:`/`zip:` 前缀 | API + slash；`scripts/test-plugins-market.ts`（或新测）绿；失败面清晰 | `packages/plugins` marketplace |
| 2 | **P-PL-URL-ZIP** | marketplace / 直链：**仅**可解析为 zip 的 https（或本地 mock server）；非 zip **明确报错**；无 OAuth | fixture 测；文档 PLUGINS | 同上 |

### 波次 P2 — 子代理产品可靠

| 序 | ID | 任务 | 验收 | 模块提示 |
|----|-----|------|------|----------|
| 3 | **P-SA-CAP** | 后台 agent **并发上限**（默认 3；`BOLO_MAX_BACKGROUND_AGENTS` 或 config 可覆）；超额 **拒绝**并提示 `/agents status` | 单测 + SUBAGENT.md | `packages/core` subagent |
| 4 | **P-SA-DOC2** | ROADMAP Subagent 水位句 + SUBAGENT 与代码一致（无 worktree 吹牛） | 文档 | docs |

### 波次 P3 — CLI / 诊断产品面

| 序 | ID | 任务 | 验收 | 模块提示 |
|----|-----|------|------|----------|
| 5 | **P-DOC-HEALTH** | `/doctor` 补齐摘要：memory 根存在否、plugins 数、import/plugin 警告条数、autoCompact、permissionMode（缺啥补啥） | 断言或脚本 | `slash.ts` |
| 6 | **P-CTX-DOC** | SLASH_COMMANDS / COMPACTION / doctor·context 描述一致 | 文档 | docs |

### 波次 P4 — TUI 小步（非完整 Ink）

| 序 | ID | 任务 | 验收 | 模块提示 |
|----|-----|------|------|----------|
| 7 | **P-T9-NARROW** | 窄终端（如 columns &lt; 80）→ plain/缩短 banner 与状态行；**不做** Ink 箭头 picker | 纯函数测或 CLI 测 | `packages/cli` |
| 8 | **P-T9-DOC** | TUI.md：T8 Ink 仍 OUT；窄终端行为已述 | 文档 | docs |

### 波次 P5 — 收口

| 序 | ID | 任务 | 验收 |
|----|-----|------|------|
| 9 | **P-SYNC** | 本文全 ✅；`TODO.md` §1/§7/§8、`ROADMAP.md` §0/§13 一致；完成度诚实微调 | 三处无「进行中产品轨」残留 |
| 10 | **P-SMOKE** | 本轨相关 `scripts/test-*.ts` 全绿 | commit 或本文记一句 |

---

## 4. 单刀 Definition of Done

- [ ] 行为符合该 ID 验收  
- [ ] 相关测试绿  
- [ ] 专册 + 本文状态 ⬜→✅  
- [ ] 无遥测、docs 无本机绝对路径  
- [ ] **路径范围** commit + `git push origin HEAD`  
- [ ] 未把 OUT 勾成完成  
- [ ] **立即**进入下一未完成 ID（用户未说停下则不停）

---

## 5. 圆满完成（停止条件 · 成功）

同时满足：

1. **P-PL-ZIP … P-SMOKE** 全部 ✅  
2. §2 OUT 仍为不做  
3. `TODO.md` §8 写明：**产品轨已收口**；下一刀需用户点名 OUT 或新轨  
4. `ROADMAP.md` 主线写明产品轨 ✅  

**允许暂停（须写阻塞）：** 同一切片无法测绿且已最小回退；或必须密钥/交互。

**用户停止令：** `停下` / `stop` / `暂停路线图` → 立即停，保留进度勾选。

---

## 6. 启动令（用户侧）

任选其一即开跑（从第一个 ⬜ 连续到圆满）：

```text
按 TODO_PRODUCT 执行
```

```text
开始产品轨，直到圆满
```

```text
按路线图执行（产品轨）
```

---

## 7. 状态总表

| ID | 状态 |
|----|------|
| P-PL-ZIP | ⬜ |
| P-PL-URL-ZIP | ⬜ |
| P-SA-CAP | ⬜ |
| P-SA-DOC2 | ⬜ |
| P-DOC-HEALTH | ⬜ |
| P-CTX-DOC | ⬜ |
| P-T9-NARROW | ⬜ |
| P-T9-DOC | ⬜ |
| P-SYNC | ⬜ |
| P-SMOKE | ⬜ |

**当前下一刀：`P-PL-ZIP`。**

---

## 8. 与 ROADMAP 里程碑映射

| 本轨 | 抬哪块 |
|------|--------|
| P-PL-* | M3 扩展 / PL-MKT 加深（自有 zip，非官方店） |
| P-SA-* | M-Subagent 可靠 |
| P-DOC-HEALTH / P-CTX | M-Slash / 可观测 |
| P-T9-* | M-TUI 小步（非 T8） |
| P-SYNC/SMOKE | 文档与回归 |

---

## 9. 一句话

> **整盘 headless 产品轨：zip 插件安装 → 子代理并发帽 → doctor → 窄 TUI → 收口。**  
> **未圆满不得停。** Electron 与企业层仍 OUT。