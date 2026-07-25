# Desktop (Electron)

> 可用壳：流式对话 · 权限弹窗 · 基础设置。**无遥测。**  
> 产品逻辑在 `packages/*`；本目录只做 IPC 编排。

## 结构

```text
apps/desktop/
  src/main/index.mjs      # 主进程 · 会话宿主
  src/preload/index.cjs   # 白名单 bridge
  src/renderer/           # chat · permission · settings
  scripts/smoke-ipc.mjs
```

## 运行

```bash
cd apps/desktop
pnpm install
pnpm dev
```

| 变量 | 含义 |
|------|------|
| `BOLO_DESKTOP_MOCK=0` | 使用真实 provider（默认可走 mock） |
| `BOLO_DESKTOP_CWD` | 初始工作目录 |
| `BOLO_API_KEY` / `OPENAI_API_KEY` 等 | 与 CLI 相同 |

Provider / 多后端配置仍读 `~/.bolo` 与项目 `.bolo`（与 headless 同一套）。  
**P5 前** Desktop 设置里可能还没有多 provider 下拉；可用 CLI `/provider` 热切，或改 config 后重建会话。

## IPC（摘要）

| 通道 | 作用 |
|------|------|
| getStatus / submit / listMessages | 会话 |
| getSettings / setSettings | mode · mock · cwd（可重建会话） |
| event | 流式事件 |
| permission_request / response | 权限 UI（可带 diff preview） |

## 测试

```bash
node --import tsx/esm apps/desktop/scripts/smoke-ipc.mjs
```

总进度与后置项见仓库根 [README.md](../../README.md) · [docs/ROADMAP.md](../../docs/ROADMAP.md)。