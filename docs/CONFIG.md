# 配置目录 — 全局 `~/.bolo` 与项目 `.bolo`

> 对照 HelsincyCode：`CLAUDE_CONFIG_DIR` / `~/.claude` + 项目级配置分层。  
> Bolo：`BOLO_CONFIG_DIR` / `~/.bolo` + 项目 `.bolo/`。

## 1. 目录布局

### 全局（用户）

```
~/.bolo/                    # 或 $BOLO_CONFIG_DIR
  config.json               # provider / permissionMode / autoCompact …
  mcp.json                  # MCP servers
  hooks.json                # Runtime hooks（10 事件契约）
  skills/
    <id>/SKILL.md
  plugins/
    <plugin-id>/bolo.plugin.json
  sessions/                 # 会话持久化（后续）
```

### 项目（仓库根下的 `.bolo/`）

与全局**同一套子目录名**，只是作用域是当前项目：

```
<repo>/.bolo/
  config.json               # 覆盖全局同名字段
  mcp.json
  hooks.json
  skills/
    <id>/SKILL.md           # 项目 skill（同 id 覆盖 ~/.bolo/skills）
  plugins/
    <plugin-id>/bolo.plugin.json
  sessions/
```

对照 Claude Code：项目级常落在仓库的 `.claude/`；Bolo 固定用 **`.bolo/`**。

初始化项目布局：

```bash
npx tsx scripts/bolo-init.ts
# 或在代码里 ensureProjectLayout(cwd)
```

## 2. 合并优先级

```
defaults
  < user (~/.bolo)
  < project (.bolo)
  < 环境变量（API Key / BASE_URL / MODEL / PROVIDER 最高）
```

- **MCP server 同名**：项目覆盖用户  
- **Hooks**：数组合并（用户 + 项目 + 插件 contributes）  
- **Skills 同 id**：项目覆盖用户；插件 contributes 再覆盖  
- **Plugins**：先用户目录，再项目目录  

## 3. `config.json` 示例

```json
{
  "version": 1,
  "provider": {
    "kind": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  },
  "permissionMode": "default",
  "autoCompactEnabled": false,
  "contextWindowTokens": 128000
}
```

**API Key 建议**：用环境变量 `BOLO_API_KEY` / `OPENAI_API_KEY`，不要把密钥提交进项目 `.bolo/config.json`。  
全局 `~/.bolo/config.json` 可写 `provider.apiKey`（本机私有，勿同步公开仓库）。

## 4. `mcp.json` 示例

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

（真 stdio 连接仍在 M3；此处负责**配置落盘与加载**。）

## 5. 环境变量

| 变量 | 作用 |
|------|------|
| `BOLO_CONFIG_DIR` | 覆盖全局目录（对照 `CLAUDE_CONFIG_DIR`） |
| `BOLO_API_KEY` / `OPENAI_API_KEY` | 覆盖 config 中的 key |
| `BOLO_BASE_URL` / `OPENAI_BASE_URL` | 覆盖 baseUrl |
| `BOLO_MODEL` / `OPENAI_MODEL` | 覆盖 model |
| `BOLO_PROVIDER=mock` | 强制 mock |

## 6. 代码

| API | 说明 |
|-----|------|
| `getBoloHomeDir()` | 全局根 |
| `getProjectBoloDir(cwd)` | 项目根 |
| `ensureUserLayout()` / `ensureProjectLayout(cwd)` | 创建目录与默认 JSON |
| `loadWorkspace({ cwd })` | 一次解析全部 |

```ts
import { loadWorkspace, ensureUserLayout } from '@bolo/config'
// 或相对路径 packages/config/src/index.ts

await ensureUserLayout()
const ws = await loadWorkspace({ cwd: process.cwd() })
// ws.provider / ws.permissionMode / ws.skills / ws.mcpServers / ws.hooks
```

## 7. 与 Claude Code 对照

| Claude | Bolo |
|--------|------|
| `~/.claude` | `~/.bolo` |
| `CLAUDE_CONFIG_DIR` | `BOLO_CONFIG_DIR` |
| settings / mcp 等 | `config.json` + `mcp.json` + `hooks.json` |
| 用户 skills | `~/.bolo/skills` |
| 项目配置 | `.bolo/`（不进 git 可自行 ignore secrets） |

## 8. Git 建议

项目 `.bolo/config.json` 可提交非密钥字段；密钥用 env。  
可在项目 `.gitignore` 增加：

```
.bolo/sessions/
```

（按需 ignore 含密钥的本地 config。）

## 9. 命令

```bash
npx tsx scripts/bolo-init.ts          # 初始化全局 + 当前项目布局
npx tsx scripts/test-config.ts        # 单测
```