# MCP（Model Context Protocol）

Bolo 以 **stdio JSON-RPC**、**Streamable HTTP** 与 **经典 SSE 长连接** 连接外部 MCP server，把远端 tools / resources / prompts 接入会话。无遥测。

## 配置

用户与项目分层（项目覆盖同名 server）：

- `~/.bolo/mcp.json`（或 `BOLO_CONFIG_DIR/mcp.json`）
- `.bolo/mcp.json`

### stdio（本地进程）

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

字段：`command`（stdio 必填）、`args`、`env`。可选 `type: "stdio"`。

### http（Streamable HTTP 远程）

```json
{
  "mcpServers": {
    "remote": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

### sse（经典 SSE 长连接）

```json
{
  "mcpServers": {
    "legacy": {
      "type": "sse",
      "url": "http://127.0.0.1:3200/sse",
      "headers": {
        "Authorization": "Bearer <token>"
      },
      "reconnectAttempts": 3,
      "reconnectDelayMs": 1000
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `type` | `stdio` \| `http` \| `sse` |
| `url` | http/sse endpoint；无 `type` 时有 `url` 即推断为 `http`（**不会**自动推断为 sse） |
| `headers` | 静态请求头（鉴权等）；无 OAuth 全家桶 |
| `reconnectAttempts` | **仅 sse**：流意外断开后自动重连次数（0–10，默认 **0**） |
| `reconnectDelayMs` | **仅 sse**：重连基础延迟 ms（默认 1000；× attempt 指数） |
| `command` / `args` / `env` | 仅 stdio |

推断规则：显式 `type` 优先 → 有 `url` → `http` → 有 `command` → `stdio`。

可选声明式 `tools` 仅作文档/回退，**真连接以 `tools/list` 为准**。

`loadWorkspace` 合并 user + project + 插件贡献的 mcp servers。

## 连接流程

1. `createSessionFromWorkspace`（默认 `connectMcp: true`）
2. 按 transport 建 client：
   - **stdio**：`spawn(command, args)` → Content-Length JSON-RPC
   - **http**：`POST url` JSON-RPC；读 `Mcp-Session-Id`；响应可为 `application/json` 或 `text/event-stream`（SSE 帧内嵌 JSON-RPC）
   - **sse**：`GET url` 长连接（`Accept: text/event-stream`）→ 等 `event:endpoint` 得 POST 消息 URL → 之后 `POST` JSON-RPC，结果/通知经 SSE `event:message` 回推
3. `initialize`（读 `capabilities`）→ `notifications/initialized`
4. `tools/list` → 注册 `BoloTool`，名：`mcp__<server>__<tool>`
5. 若 `capabilities.resources`：`resources/list` 缓存；meta `ListMcpResources` / `ReadMcpResource`
6. 若 `capabilities.prompts`：`prompts/list` 缓存；meta `GetMcpPrompt`
7. 挂 `notifications/{tools,resources,prompts}/list_changed`（stdio / **经典 SSE 长连接** 可推；http 若响应 SSE 内含通知也会分发）→ 再 list → `mergeSessionToolsWithMcp`
8. 模型 `tools/call` → JSON-RPC `tools/call`

**错误隔离：** 单 server 连接/list 失败只 **warn**（`console.warn` + session event `warning`），不中断其它 server 与会话。

关闭：`closeSessionMcp(session)`（stdio 杀子进程；http 尽力 `DELETE` + 丢弃 session id；sse 中止 GET 流并拒绝 pending）。

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
| `/mcp` | 各 server：**transport** · **status** · tools/resources/prompts 计数 + capability |
| `/mcp tools` | 列出 `mcp__server__tool` |
| `/mcp resources` | 列出 URI（连接时 list 缓存） |
| `/mcp prompts` | 列出 prompt 名与参数 |

## API（`@bolo/mcp`）

| API | 作用 |
|-----|------|
| `loadMcpConfigFile` | 读 mcp.json |
| `resolveMcpTransport` | 配置 → stdio/http/sse |
| `McpClient` | 共用接口（listTools/call · resources · prompts · onNotification） |
| `McpStdioClient` | stdio 实现 |
| `McpHttpClient` | Streamable HTTP 实现 |
| `McpSseClient` | 经典 SSE 长连接实现 |
| `connectMcpServers` | 批量连接 + `BoloTool[]` + list_changed |
| `attachMcpListChangedHandlers` / `mergeSessionToolsWithMcp` | 热刷新 |
| `createMcpMetaTools` | List/Read resource · Get prompt |
| `mcpToolName` / `parseMcpToolName` | 命名 |
| `consumeSseEvents` / `resolveSseMessageUrl` | SSE 帧解析与 endpoint URL 解析（测试/复用） |

## 测试

```bash
npx tsx scripts/test-mcp-stdio.ts
npx tsx scripts/test-mcp-http.ts
npx tsx scripts/test-mcp-sse.ts
```

Fixtures：

- `scripts/fixtures/mcp-echo-server.mjs` — stdio（含 list_changed）
- `scripts/fixtures/mcp-http-echo-server.mjs` — 本地 mock Streamable HTTP（JSON + 可选 SSE）
- `scripts/fixtures/mcp-sse-echo-server.mjs` — 本地 mock 经典 SSE（GET `/sse` + POST `/message`）

## 已做 / 未做

| 项 | 状态 |
|----|------|
| stdio tools list/call | ✅ MCP1 |
| capabilities 门控 + resources/prompts + meta | ✅ MCP2 |
| `/mcp` + list_changed 热刷新 | ✅ |
| **Transport 抽象 `McpClient`** | ✅ |
| **Streamable HTTP（`type: http`）** | ✅ 最小 |
| **经典 SSE 长连接（`type: sse`）** | ✅ 最小 |
| 错误隔离（远程挂不影响 stdio） | ✅ |
| `/mcp` 显示 transport + status | ✅ |
| OAuth / headersHelper | ⬜ |
| 自动重连 / 断线重试预算 | ⬜（关连接后由上层重开） |
| 插件热重载 MCP | 🟡 最小（`/plugins reload` 默认重连 workspace MCP，含插件 contributes） |

> 语义对照参考实现 MCP 多 transport（stdio / sse / http）、session/endpoint、错误隔离；**重新实现**，非 SDK 大段复制。