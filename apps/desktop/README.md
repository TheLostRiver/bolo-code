# Desktop (Electron)

> **状态：后置（F-ELECTRON-HANDOFF）** — 用户定调「不急」。  
> Headless 能力在 `packages/*` + `packages/cli`；本目录仅为未来 GUI 壳。

## 启动条件（何时再开）

1. `docs/TODO_FULL.md` headless 加深已收口（当前 ✅ 最小）  
2. 用户明确要求实现 Electron  
3. 不阻塞 CLI 日用路径  

## 包边界（规划）

| 路径 | 职责 |
|------|------|
| `src/main/` | BrowserWindow、IPC、托管 `@bolo/core` 会话生命周期 |
| `src/preload/` | 白名单 bridge（禁止直曝 Node 全能） |
| `src/renderer/` | 会话 / 权限 / 设置 UI |

## 禁止

- 在未授权前把 desktop 勾成「完成」  
- 遥测 / 官方商店绑定  

## 当前

占位 README + `package.json` stub；**无**可运行 GUI。