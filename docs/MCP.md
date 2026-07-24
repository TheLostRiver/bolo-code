# MCP（Model Context Protocol）

Bolo 以 **stdio JSON-RPC** 连接外部 MCP server，把远端 tools / resources / prompts 接入会话。无遥测。

## 配置

用户与项目分层（项目覆盖同名 server）：

- `~/.bolo/mcp.json`（或 `BOLO_CONFIG_DIR/mcp.json`）
- `.bolo/mcp.json`

```json
{
  "mcpServers": {
    "echo": {
      "command": "node",
      "args": ["scripts/fixtures/mcp-echo-server.mjs"],
      "env": {}
    }
  }
}
```

字段：`command`（必填）、`args`、`env`。可选声明式 `tools` 仅作文档/回退，**真连接以 `tools/list` 为准**。

`loadWorkspace` 合并 user + project + 插件贡献的 mcp servers。

## 连接流程

1. `createSessionFromWorkspace`（默认 `connectMcp: true`）
2. 对每个 server：`spawn(command, args)` → `initialize`（读 `capabilities`）→ `notifications/initialized`
3. `tools/list` → 注册 `BoloTool`，名：`mcp__<server>__<tool>`
4. 若 `capabilities.resources`：`resources/list` 缓存到连接；注册 meta 工具 `ListMcpResources` / `ReadMcpResource`
5. 若 `capabilities.prompts`：`prompts/list` 缓存；注册 meta 工具 `GetMcpPrompt`
6. 挂 `notifications/{tools,resources,prompts}/list_changed`：再 list → 更新连接缓存；会话层 `mergeSessionToolsWithMcp` 同步 `session.tools`，并发 `mcp_list_changed` 事件（无遥测）
7. 模型 `tools/call` 经会话工具表 → JSON-RPC `tools/call`；资源/提示词经 meta 工具 → `resources/*` / `prompts/get`

单 server 失败只 **warn**（`console.warn` + session event `warning`），不中断会话。

关闭：`closeSessionMcp(session)` 或进程退出时杀子进程。

## 命名与权限

| 项 | 约定 |
|----|------|
| 远端工具名 | `mcp__server__tool` |
| Meta 工具 | `ListMcpResources` · `ReadMcpResource` · `GetMcpPrompt`（全局，非 `mcp__` 前缀） |
| Permission 类 | `mcp`（`mcp__*`）；Read 资源默认只读；Read/Get 仍可 ask |
| Hook matcher | 可匹配完整名或 `mcp__*` |

## `/mcp` 斜杠

| 子命令 | 作用 |
|--------|------|
| `/mcp` | 各 server：tools/resources/prompts 计数 + capability 摘要 |
| `/mcp tools` | 列出 `mcp__server__tool` |
| `/mcp resources` | 列出 URI（连接时 list 缓存） |
| `/mcp prompts` | 列出 prompt 名与参数 |

## API（`@bolo/mcp`）

| API | 作用 |
|-----|------|
| `loadMcpConfigFile` | 读 mcp.json |
| `McpStdioClient` | 单 server stdio：tools / resources / prompts；`onNotification` |
| `connectMcpServers` | 批量连接 + 产出 `BoloTool[]`（含 meta）+ list_changed 挂接 |
| `attachMcpListChangedHandlers` / `mergeSessionToolsWithMcp` | 热刷新缓存与会话工具表 |
| `createMcpMetaTools` | List/Read resource · Get prompt |
| `mcpToolName` / `parseMcpToolName` | 命名 |

## 测试

```bash
npx tsx scripts/test-mcp-stdio.ts
```

本地 fixture：`scripts/fixtures/mcp-echo-server.mjs`（initialize · tools · resources · prompts · `mutate` + list_changed）。

## 已做 / 未做

| 项 | 状态 |
|----|------|
| stdio tools list/call | ✅ MCP1 |
| capabilities 门控 + resources list/read | ✅ MCP2 部分 |
| prompts list/get + GetMcpPrompt | ✅ MCP2 部分 |
| `/mcp` resources/prompts | ✅ |
| `list_changed` 热刷新（tools/resources/prompts → 缓存 + session.tools） | ✅ MCP2 部分 |
| SSE / HTTP transport | ⬜ |
| 插件热重载 MCP | ⬜（PL2） |

> 语义对照 HelsincyCode MCP client（capabilities 门控、List/Read resource meta 工具、list_changed 再 list），**重新实现**，非 SDK 大段复制。