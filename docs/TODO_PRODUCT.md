# 产品级执行轨（Product Track）

> **整盘 headless 后续的一截小轨（历史）** — zip/SA/doctor/窄 TUI。  
> **已圆满。** 整盘更大后续见 **`docs/TODO_FULL.md`**（含 T8/Ink、compact 深刀、worktree、OAuth、Y5+ 等；**Electron 仍后置**）。  
> 总览：`docs/ROADMAP.md` · 入口：`docs/TODO.md`。

---

## 0. 一句话

> **Product 小轨已圆满**（非整盘 ROADMAP 完成）。  
> 下一整盘真源：`docs/TODO_FULL.md`。

---

## 1. 执行结果

| 序 | ID | 状态 | 结果 |
|----|-----|------|------|
| 1 | **P-PL-ZIP** | ✅ | `installPluginFromZip` · `/plugins install path:\|zip:` |
| 2 | **P-PL-URL-ZIP** | ✅ | `installPluginFromUrl` · marketplace url zip · 非 zip 拒绝 |
| 3 | **P-SA-CAP** | ✅ | 默认并发 3 · `BOLO_MAX_BACKGROUND_AGENTS` · Agent 工具硬拦 |
| 4 | **P-SA-DOC2** | ✅ | SUBAGENT.md + ROADMAP 水位 |
| 5 | **P-DOC-HEALTH** | ✅ | `/doctor` memory 根 · plugins 警告 |
| 6 | **P-CTX-DOC** | ✅ | SLASH / COMPACTION / TUI 对齐 |
| 7 | **P-T9-NARROW** | ✅ | columns&lt;80 plain banner + 短状态行 |
| 8 | **P-T9-DOC** | ✅ | TUI.md：T8 Ink 仍 OUT |
| 9 | **P-SYNC** | ✅ | 本文 + TODO/ROADMAP |
| 10 | **P-SMOKE** | ✅ | `test-plugins-market` · `test-product-track` · subagent · memory |

---

## 2. OUT（本小轨当时不做 → 多数已迁入 TODO_FULL）

当时 OUT、现由 **`TODO_FULL`** 承接：T8 Ink · Y5+ · OAuth · worktree · cached MC · 自有市场深度。  
**仍后置：** Electron。  
**仍禁止：** 官方市场 API · 遥测。

---

## 3. 测试

```bash
node --import tsx/esm scripts/test-plugins-market.ts
node --import tsx/esm scripts/test-product-track.ts
node --import tsx/esm scripts/test-subagent.ts
node --import tsx/esm scripts/test-memory.ts
```

---

## 4. 圆满

Product 小轨 § 条件已满足。  
**整盘未完成** — 见 `docs/TODO_FULL.md`。

---

## 5. 一句话

> **TODO_PRODUCT 全 ✅（小轨）。** 整盘后续 → **`TODO_FULL`**；Electron 不急。