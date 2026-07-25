# Desktop (Electron) — M4

> **✅ 可用壳**（流式 · 权限 · 设置）。无遥测。

## 结构

```text
apps/desktop/
  src/main/index.mjs
  src/preload/index.cjs
  src/renderer/   # chat + permission + settings
  scripts/smoke-ipc.mjs
```

## 运行

```bash
cd apps/desktop && pnpm install && pnpm dev
```

| 变量 | 含义 |
|------|------|
| `BOLO_DESKTOP_MOCK=0` | 真实 provider |
| `BOLO_DESKTOP_CWD` | 初始 cwd |

## IPC

| 通道 | 作用 |
|------|------|
| getStatus / submit / listMessages | 会话 |
| getSettings / setSettings | mode · mock · cwd（可重建会话） |
| event | 流式 |
| permission_request / response | 权限 UI |

## 测试

```bash
node --import tsx/esm apps/desktop/scripts/smoke-ipc.mjs
node --import tsx/esm scripts/test-roadmap-polish.ts
```