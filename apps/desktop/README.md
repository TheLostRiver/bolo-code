# Desktop (Electron) — M4

> **✅ 最小可用壳**（非完整产品 GUI）。无遥测。

## 结构

```text
apps/desktop/
  src/main/index.mjs      # BrowserWindow + IPC + core 会话 + 权限桥
  src/preload/index.cjs   # contextBridge
  src/renderer/           # 会话 UI · 流式 text · 权限对话框
  scripts/smoke-ipc.mjs   # 无 GUI 冒烟
```

## 运行

```bash
cd apps/desktop && pnpm install && pnpm dev
# 默认 mock；真实模型：BOLO_DESKTOP_MOCK=0
```

## IPC

| 通道 | 作用 |
|------|------|
| `bolo:getStatus` / `submit` / `listMessages` | 会话 |
| `bolo:event` | 流式 SessionEvent（text_delta 等） |
| `bolo:permission_request` / `permission_response` | 权限对话框 |

## 测试

```bash
node --import tsx/esm apps/desktop/scripts/smoke-ipc.mjs
node --import tsx/esm scripts/test-roadmap-closeout.ts
```

## 限制

- 非多窗/自动更新/完整设置页  
- 权限 UI 为最小三按钮（allow / always / deny）  
- 业务逻辑在 `packages/core`，不在 renderer