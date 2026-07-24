# 产品级执行轨（Product Track）

> **整盘 headless 后续执行真源**（非 Memory 窄轨）。  
> 总览：`docs/ROADMAP.md` · 入口：`docs/TODO.md`。  
> 历史：`docs/TODO_AUTORUN.md` 已收口。  
> **Electron / 企业 YOLO / 官方市场 / OAuth / worktree / cached MC / T8 Ink** 仍 **OUT**。

---

## 0. 一句话

> **产品轨已圆满：** zip 插件安装 · 后台并发帽 · doctor 健康面 · 窄终端 TUI · 文档收口。  
> 相对 HC 仍诚实 **~45–60%** 量级，不写 ~70%。

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

## 2. OUT（仍不做）

Electron · T8 完整 Ink · Y5+ 企业 YOLO · 官方市场 API · MCP OAuth · worktree · cached MC · 遥测。

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

§5 条件已满足。下一刀需用户点名 **OUT** 或新轨。

---

## 5. 一句话

> **TODO_PRODUCT 全 ✅。** 插件 zip、子代理帽、doctor、窄 TUI 已落地；GUI/企业层仍另令。