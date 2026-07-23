# Desktop (Electron)

Phase 3 实现。主进程托管 `@bolo/core`，渲染进程只做 UI。

规划入口：

- `src/main/` — BrowserWindow、IPC、Runtime 生命周期
- `src/preload/` — 白名单 bridge
- `src/renderer/` — 会话 / 权限 / 设置 UI