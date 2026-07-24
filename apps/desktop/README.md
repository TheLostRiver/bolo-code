# Desktop (Electron) — M4 最小

> **状态：✅ 最小壳**（main + preload + renderer + IPC → `@bolo/core`）。  
> 无遥测。默认 **mock provider**（`BOLO_DESKTOP_MOCK=0` 用 workspace 配置）。

## 结构

```text
apps/desktop/
  src/main/index.mjs      # BrowserWindow + IPC + createSessionFromWorkspace
  src/preload/index.cjs   # contextBridge 白名单
  src/renderer/           # 会话 UI（HTML/CSS/JS）
  scripts/smoke-ipc.mjs   # 不启 GUI 的 IPC 契约冒烟
```

## 运行

```bash
# 根目录装依赖（含 workspaces）
pnpm install

# 桌面（需 electron 装到 apps/desktop）
cd apps/desktop && pnpm install && pnpm dev
```

环境：

| 变量 | 含义 |
|------|------|
| `BOLO_DESKTOP_MOCK=0` | 不用 mock，走 workspace provider |
| `BOLO_DESKTOP_CWD` | 会话 cwd（默认 process.cwd()） |
| `BOLO_PROVIDER=mock` | 强制 mock |

## IPC

| 通道 | 方向 | 作用 |
|------|------|------|
| `bolo:getStatus` | invoke | id/cwd/mode/model/msgs |
| `bolo:submit` | invoke | `submitUserInput` |
| `bolo:listMessages` | invoke | 消息列表 |
| `bolo:event` | push | SessionEvent 流 |

## 测试

```bash
node --import tsx/esm apps/desktop/scripts/smoke-ipc.mjs
```

## 边界

- Renderer **无** Node 集成；仅 preload bridge  
- 业务逻辑在 `packages/core`，不在 UI  
- 非完整产品级权限对话框 / 多窗口 / 自动更新