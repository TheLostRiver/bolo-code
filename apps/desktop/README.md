# Desktop (Electron)

> 可用壳：流式对话 · 权限弹窗 · 基础设置 · **多 provider（CX7）** ·
> **runtime v1 生产 IPC/client** · **durable composer controls**。**无遥测。**
> 产品逻辑在 `packages/*`；本目录只做 IPC 编排。

## 结构

```text
apps/desktop/
  src/main/index.ts       # 主进程 · 会话宿主 · runtime/provider IPC
  src/preload/index.cjs   # 白名单 bridge
  src/renderer/           # chat · permission · settings · provider · runtime 状态
  dist/                   # main bundle + browser runtime client + 静态 renderer
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

`npm start` 先执行 `scripts/build-desktop.ts`：main 的 `packages/*` 静态导入被打进
自包含 bundle，共享 `RuntimeClient` 单独打成 browser ESM。运行时不依赖仓库
`repoRoot` 布局，也不需要 `tsx`。

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
| **runtimeHello / runtimeQuery / runtimeCommand** | runtime v1 协商、当前 snapshot、expected-state 安全动作 |
| getStatus / submit / listMessages | 会话（status 含 providerId · effort） |
| **getComposerActions / composerControl** | packages 计算 Send/Queue/Steer/Interrupt 可用性；durable control admission |
| getTimeline / listSessions / selectSession | 结构化 timeline、会话列表与 fail-closed 切换/resume |
| getSettings / setSettings | mode · mock · cwd（可重建会话） |
| **listProviders** | providers 列表 + presets + effort tip |
| **useProvider** | 热切命名后端（`switchSessionProvider`） |
| **addProvider** | preset 写入 config（同 `/provider add`） |
| event | 流式事件 |
| permission_request / response | 权限 UI（可带 diff preview） |

## 测试

以下专项门禁从仓库根目录执行（若仍在 `apps/desktop`，先运行 `cd ../..`）：

```bash
npm run test:runtime-core-transport
npm run test:session-selection
npm run test:desktop-session-selection
npm run test:desktop-ipc-contract
npm run test:composer-runtime
npm run test:desktop-composer
npm run test:desktop-bundle
```

最后一项会真实启动 Electron，并要求 renderer 的 RuntimeClient 完成 hello/query
握手到 `ready`，再自动点击 session row 并恢复目标会话。composer 契约与接线由
专项门禁覆盖；窗口视觉与真人点击仍未因此自动验收。

总进度与后置项见仓库根 [README.md](../../README.md) · [docs/ROADMAP.md](../../docs/ROADMAP.md) · [docs/PROVIDER_UX.md](../../docs/PROVIDER_UX.md)。
