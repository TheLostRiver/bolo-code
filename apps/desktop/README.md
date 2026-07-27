# Desktop (Electron)

> 可用壳：流式对话 · 权限弹窗 · 基础设置 · **多 provider（CX7）**。**无遥测。**  
> 产品逻辑在 `packages/*`；本目录只做 IPC 编排。

## 结构

```text
apps/desktop/
  src/main/index.mjs      # 主进程 · 会话宿主 · provider IPC
  src/preload/index.cjs   # 白名单 bridge
  src/renderer/           # chat · permission · settings · provider 下拉
  scripts/smoke-ipc.mjs
```

## 运行

```bash
cd apps/desktop
# 若 electron 二进制下载失败（TLS），用镜像再装：
#   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
#   node node_modules/electron/install.js
npm install
set BOLO_DESKTOP_MOCK=1
npm start            # 等价 electron . ；dev 脚本同 mock
```

> main 进程 `repoRoot` 解析自 `src/main` 上四级到仓库根，动态 import `packages/*`。

| 变量 | 含义 |
|------|------|
| `BOLO_DESKTOP_MOCK=0` | 使用真实 provider（默认可走 mock） |
| `BOLO_DESKTOP_CWD` | 初始工作目录 |
| `BOLO_API_KEY` / `OPENAI_API_KEY` 等 | 与 CLI 相同 |
| `ELECTRON_MIRROR` | 可选；Electron 二进制镜像 |

Provider / 多后端配置仍读 `~/.bolo` 与项目 `.bolo`（与 headless 同一套）。  
**CX7：** 顶栏与 Settings 可选 active backend、Add preset（只写 `apiKeyEnv`）；热切 tip 显示 dialect/choosable。关 mock 后才打真网。

## IPC（摘要）

| 通道 | 作用 |
|------|------|
| getStatus / submit / listMessages | 会话（status 含 providerId · effort） |
| getSettings / setSettings | mode · mock · cwd（可重建会话） |
| **listProviders** | providers 列表 + presets + effort tip |
| **useProvider** | 热切命名后端（`switchSessionProvider`） |
| **addProvider** | preset 写入 config（同 `/provider add`） |
| event | 流式事件 |
| permission_request / response | 权限 UI（可带 diff preview） |

## 测试

```bash
node --import tsx/esm apps/desktop/scripts/smoke-ipc.mjs
```

总进度与后置项见仓库根 [README.md](../../README.md) · [docs/ROADMAP.md](../../docs/ROADMAP.md) · [docs/PROVIDER_UX.md](../../docs/PROVIDER_UX.md)。
