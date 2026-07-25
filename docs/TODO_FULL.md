# 整盘后续执行轨（历史 · 已并入 ROADMAP 收口）

> 本文件记录 FULL 轨切片；**主路径已全部 ✅**。  
> **永不：** 官方市场 API · 遥测。

## 状态

| 口径 | 现状 |
|------|------|
| FULL + M4 + polish | ✅ |
| 相对 HC | ~70–85% |
| Electron | ✅ 设置/权限/流式 |

## 本阶段加深（相对早期「标记级」）

| 项 | 行为 |
|----|------|
| OS sandbox | Linux `bwrap` / macOS `sandbox-exec` 包装 Bash；Windows 诚实降级 |
| OAuth | 本地 `127.0.0.1` 回调 + token 落盘 + header 注入 |
| Desktop | Settings：mode / mock / cwd |
| WebFetch | 内置 + SSRF 基础拦 |

## 测试

```bash
node --import tsx/esm scripts/test-roadmap-polish.ts
node --import tsx/esm scripts/test-roadmap-closeout.ts
node --import tsx/esm apps/desktop/scripts/smoke-ipc.mjs
node --import tsx/esm scripts/test-full-track.ts
```

## 一句话

> **路线图圆满；限制见上表，非 HC 逐文件复刻。**