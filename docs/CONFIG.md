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
  sessions/                 # 会话 JSON 快照（见 docs/SESSIONS.md）
  rules/                    # 可选用户级 rules
  agents/                   # 可选用户级 subagent 定义（*.md）
  memory/                   # 跨会话长期记忆（MEMORY.md 索引；见 docs/MEMORY.md）
    MEMORY.md
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
  sessions/                 # 默认 scope=project 落盘处
  rules/                    # 项目 rules（见 RULES.md）
  agents/                   # 项目 subagent 定义（*.md；覆盖同名内置，见 SUBAGENT.md）
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
- **Skills 同 id**：bundled ← **extra**（可选）← user ← project ← plugin（见 [SKILLS.md](./SKILLS.md)）  
- **Subagent 类型同名**（S7）：内置 ← 用户 `agents/*.md` ← 项目 `.bolo/agents/*.md`（见 [SUBAGENT.md](./SUBAGENT.md)）  
- **Plugins（PL1+PL2）**：扫 user/project `plugins/<id>/bolo.plugin.json`；合并 skills（默认 `skills/`）、hooks、mcp、**commands**（默认 `commands/*.md`）；会话内 `/plugins reload` 热刷新；**无**市场/远程安装

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
  "autoCompactEnabled": true,
  "contextWindowTokens": 128000,
  "extraSkillRoots": [],
  "foreignPluginRoots": []
}
```

`extraSkillRoots`（**S-PORT-2 / IMPORT-S1**，可选）：旁路 skill 根目录列表（每根：`<id>/SKILL.md`）。**默认省略或 `[]` = 不扫描**（不静默加载 `~/.agents/skills` 等）。支持 `~` 与相对项目 cwd 的路径；user + project 数组合并去重。位次：bundled → **extra** → user → project → plugin。

`foreignPluginRoots`（**IMPORT-P1**，可选）：外来插件目录列表（只读映射 **skills**）。识别 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` 等；**不**加载 hooks/commands；**不**接官方市场。失败与 unsupported contributes 记入 workspace `pluginMerge.errors` 警告。见 [PLUGINS.md](./PLUGINS.md)。

`provider.kind` 还可为：`openai-responses`（原生 Responses `/responses`）、`anthropic`、`mock`。详见 [PROVIDERS.md](./PROVIDERS.md)。
| 字段 | 默认 | 说明 |
|------|------|------|
| `autoCompactEnabled` | `true` | 为 true 且会话有 `compactSummarizer` 时，queryLoop 的 `prepareMessages` 达 token 阈值会走 full compact（对照参考 autoCompactIfNeeded）。会话内 `/autocompact on\|off` 可改；环境变量 `BOLO_DISABLE_AUTO_COMPACT` / `BOLO_DISABLE_COMPACT` 熔断 auto（manual `/compact` 仍可用） |
| `contextWindowTokens` | `128000` | 用于 `getAutoCompactThreshold` / `getContextPressure`；token 估见 `estimateTokens`（加权启发式，非 tokenizer） |
| `microcompactEnabled` | `true` | 为 true 时 prepare 链先跑 microcompact（清旧 tool 正文，无 LLM）；`false` 关闭 |
| `maxPtlRetries` | `3` | callModel / compact summarizer 命中上下文过长时截断最旧轮次再试的次数；`0` 关闭 |
| `extraSkillRoots` | 省略/`[]` | **可选**旁路 skill 根；默认 **off**；见 SKILLS.md S-PORT-2 |
| `foreignPluginRoots` | 省略/`[]` | **可选**外来插件根（skills 只读）；默认 **off** |

`createSessionFromWorkspace` 会读上述字段；也可用 `createSession({ autoCompactEnabled, contextWindowTokens, compactSummarizer, microcompact, maxPtlRetries })` 直接开。未显式传 `autoCompactEnabled` 时默认 **开**。

**prepare / 失败恢复顺序**：`microcompact` → `auto full compact` → `callModel` →（PTL 则 truncate → 再 prepare → 重试）。见 `docs/COMPACTION.md` §2.5。

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

（真 stdio：见 [MCP.md](./MCP.md)；`createSessionFromWorkspace` 默认连接。）

## 5. 环境变量

| 变量 | 作用 |
|------|------|
| `BOLO_CONFIG_DIR` | 覆盖全局目录（对照 `CLAUDE_CONFIG_DIR`） |
| `BOLO_API_KEY` / `OPENAI_API_KEY` | 覆盖 config 中的 key |
| `BOLO_BASE_URL` / `OPENAI_BASE_URL` | 覆盖 baseUrl |
| `BOLO_MODEL` / `OPENAI_MODEL` | 覆盖 model |
| `BOLO_PROVIDER=mock` | 强制 mock |
| `BOLO_MEMORY_DIR` | 覆盖 memory 根目录（绝对路径；默认 `~/.bolo/memory`） |
| `BOLO_DISABLE_MEMORY` | `1`/`true`/`yes`/`on` 时不注入 auto memory 段 |

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
| `CLAUDE.md` / memory | **`BOLO.md`**（主品牌）+ 可选兼容 `CLAUDE.md` / `AGENTS.md`；跨会话 **`~/.bolo/memory/MEMORY.md`** 见 [MEMORY.md](./MEMORY.md) |
| 项目 rules | **`.bolo/rules/**/*.md`**（+ 可选 `~/.bolo/rules`）；见 **[RULES.md](./RULES.md)** |

## 8. 项目指令文件（BOLO.md）

推荐在仓库根或 `.bolo/` 放置 **`BOLO.md`**，写入项目约定（构建、风格、禁忌）。  
用户全局：`~/.bolo/BOLO.md`。

搜索顺序、截断预算、注入为 system 段：见 **[SYSTEM_PROMPT.md](./SYSTEM_PROMPT.md)**。

## 9. 会话持久化

`sessions/` 存放 **`<sessionId>.json`** 快照（messages + 配置切片）。  
API：`saveSession` / `loadSession` / `resumeSession`；可选 `createSession({ autoSave: true })`。  
详见 **[SESSIONS.md](./SESSIONS.md)**。

```
~/.bolo/BOLO.md          # 用户全局
{repo}/BOLO.md           # 项目根（优先品牌）
{repo}/.bolo/BOLO.md     # 项目配置目录
# 兼容（可选读取）：CLAUDE.md / AGENTS.md
```

关闭：`BOLO_DISABLE_BOLO_MD=1`。

## 9. Git 建议

项目 `.bolo/config.json` 可提交非密钥字段；密钥用 env。  
`BOLO.md` **适合提交**到仓库（团队共享约定）。  
可在项目 `.gitignore` 增加：

```
.bolo/sessions/
```

（按需 ignore 含密钥的本地 config。）

## 10. 命令

```bash
npx tsx scripts/bolo-init.ts          # 初始化全局 + 当前项目布局
npx tsx scripts/test-config.ts        # 配置单测
npx tsx scripts/test-system-prompt.ts # 系统提示词 + BOLO.md
npx tsx scripts/test-rules.ts         # .bolo/rules 装载 + 注入
```