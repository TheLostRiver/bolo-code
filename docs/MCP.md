# MCP（Model Context Protocol）

Bolo 以 **stdio JSON-RPC** 连接外部 MCP server，把远端 tools 注册进会话工具表。无遥测。

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
2. 对每个 server：`spawn(command, args)` → `initialize` → `notifications/initialized`
3. `tools/list` → 注册 `BoloTool`，名：`mcp__<server>__<tool>`
4. 模型 `tools/call` 经会话工具表 → JSON-RPC `tools/call`

单 server 失败只 **warn**（`console.warn` + session event `warning`），不中断会话。

关闭：`closeSessionMcp(session)` 或进程退出时杀子进程。

## 命名与权限

| 项 | 约定 |
|----|------|
| 工具名 | `mcp__server__tool` |
| Permission 类 | `mcp`（`mcp__*`） |
| Hook matcher | 可匹配完整名或 `mcp__*` |

## API（`@bolo/mcp`）

| API | 作用 |
|-----|------|
| `loadMcpConfigFile` | 读 mcp.json |
| `McpStdioClient` | 单 server stdio 客户端 |
| `connectMcpServers` | 批量连接 + 产出 `BoloTool[]` |
| `mcpToolName` / `parseMcpToolName` | 命名 |

## 测试

```bash
npx tsx scripts/test-mcp-stdio.ts
```

使用本地 fixture：`scripts/fixtures/mcp-echo-server.mjs`（initialize / list / echo call）。

## 未做（后续）

- SSE / HTTP transport
- resources / prompts
- 插件热重载 MCP

> `/mcp` 斜杠状态：已落地（见 `packages/core/src/slash.ts`）。