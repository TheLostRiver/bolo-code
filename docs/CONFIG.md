# 配置目录 — 全局 `~/.bolo` 与项目 `.bolo`

> 对照 HelsincyCode：`CLAUDE_CONFIG_DIR` / `~/.claude` + 项目级配置分层。  
> Bolo：`BOLO_CONFIG_DIR` / `~/.bolo` + 项目 `.bolo/`。  
> **上手操作**（含 Agent 配置）：[USAGE.md](./USAGE.md) · **交接**：[AGENT_HANDOFF.md](./AGENT_HANDOFF.md)

## 1. 目录布局

### 全局（用户）

```
~/.bolo/                    # 或 $BOLO_CONFIG_DIR
  config.json               # JSONC（可用 // 注释）；provider / agents / permissionMode …
  mcp.json
  hooks.json
  skills/
    <id>/SKILL.md
  plugins/
    <plugin-id>/bolo.plugin.json
  sessions/
  rules/
  agents/                   # subagent 类型 *.md + README.md（字段说明）
    README.md
  memory/
    MEMORY.md
```

### 项目（仓库根下的 `.bolo/`）

与全局**同一套子目录名**，只是作用域是当前项目：

```
<repo>/.bolo/
  config.json               # JSONC；覆盖全局同名字段（含 agents）
  mcp.json
  hooks.json
  skills/
    <id>/SKILL.md
  plugins/
  sessions/
  rules/
  agents/                   # 项目 subagent；见 agents/README.md · SUBAGENT_SPEC.md
    README.md
```

对照 Claude Code：项目级常落在仓库的 `.claude/`；Bolo 固定用 **`.bolo/`**。

初始化项目布局：

```bash
npx tsx scripts/bolo-init.ts
# 或在代码里 ensureProjectLayout(cwd)
```

会写入**带注释**的默认 `config.json`（JSONC）与 `agents/README.md`（不覆盖已有文件）。

## 1.1 `config.json` 支持注释（JSONC）

标准 JSON 不能写注释；Bolo **加载时**会剥掉：

- `//` 行注释
- `/* … */` 块注释
- 尾逗号（可选）

因此初始化模板把 **subagent / provider 用法写在文件内注释**里，打开即看，不必先翻文档。

编辑器用 JSONC 高亮即可；严格 JSON 校验器可能报错——以 Bolo 加载为准。

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
- **Subagent 全局策略**（Spec v0）：`config.json` → `agents` 段（`enabled` / `maxConcurrent` / `defaultModel` / `defaultEffort` / `maxSpawnDepth` / `overflow`）；见 [SUBAGENT_SPEC.md](./SUBAGENT_SPEC.md)
- **SearXNG 直连**：`search.searxng` 子字段深合并；项目层可写 `enabled: false` 关闭用户层配置。畸形高优先级值不会回退启用低优先级 endpoint
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
  "agents": {
    "enabled": true,
    "maxConcurrent": 3,
    "defaultModel": "inherit",
    "defaultEffort": "medium",
    "maxSpawnDepth": 0,
    "overflow": "reject"
  },
  "search": {
    "searxng": {
      "enabled": false
    }
  },
  "extraSkillRoots": [],
  "foreignPluginRoots": []
}
```

`agents.overflow` 默认为 `"reject"`。设为 `"queue"` 后，并发 cap 满时任务会先 durable `admitted`，进入当前进程 FIFO，取得 slot 且 `running` 落盘成功后才启动。`/bg cancel <taskId>` 只取消 queued task；取消落盘失败会报告 warning，但任务仍从本进程可执行队列移除。重启不会恢复 executable queue：原 admitted/running task 只显示为 interrupted，绝不自动 replay。

`extraSkillRoots`（**S-PORT-2 / IMPORT-S1**，可选）：旁路 skill 根目录列表（每根：`<id>/SKILL.md`）。**默认省略或 `[]` = 不扫描**（不静默加载 `~/.agents/skills` 等）。支持 `~` 与相对项目 cwd 的路径；user + project 数组合并去重。位次：bundled → **extra** → user → project → plugin。

`foreignPluginRoots`（**IMPORT-P1**，可选）：外来插件目录列表（只读映射 **skills**）。识别 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` 等；**不**加载 hooks/commands；**不**接官方市场。失败与 unsupported contributes 记入 workspace `pluginMerge.errors` 警告。见 [PLUGINS.md](./PLUGINS.md)。

`provider.kind` 还可为：`openai-responses`（原生 Responses `/responses`）、`anthropic`、`mock`。详见 [PROVIDERS.md](./PROVIDERS.md)。

### SearXNG 直连搜索

只有显式配置才注册本地 `WebSearch` 工具：

```jsonc
{
  "search": {
    "searxng": {
      "baseUrl": "http://127.0.0.1:8888",
      "timeoutMs": 15000,
      "maxResults": 8,
      "language": "zh-CN",
      "safeSearch": 1
    }
  }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | 段存在即启用 | `false` 禁用，包括关闭继承配置 |
| `baseUrl` | 无 | 必填；自动追加 `/search` |
| `timeoutMs` | `15000` | 100–60000 毫秒 |
| `maxResults` | `8` | 1–20 |
| `language` | 省略 | 字母、数字、`_`、`-`，最长 32 |
| `safeSearch` | `0` | 0–2 |

公开 endpoint 必须 HTTPS；HTTP 只允许显式 loopback/LAN 主机。URL 不允许凭据、
query 或 fragment。错误配置会禁用工具并产生 CLI/Desktop warning。
`bolo search status` 可查看最终 endpoint 与同时配置的 hosted/MCP 线路。
完整部署、隐私和 fixture/live 边界见
[LOCAL_SEARCH_AND_FETCH.md](./LOCAL_SEARCH_AND_FETCH.md)。

### 多 Provider（**P 轨 · P0–P4 日用已闭环**）

日用：配置里同时登记多个后端，**运行中** `/provider use` 热切，无需改文件重启。完整契约见 [ROADMAP.md §9](./ROADMAP.md) · [PROVIDERS.md](./PROVIDERS.md)。

| 字段 | 说明 |
|------|------|
| `providers` | `Record<id, { kind, baseUrl?, model?, apiKeyEnv?, label?, … }>` |
| `defaultProvider` | 启动 active id |
| `provider`（旧） | 单后端；无 `providers` 时仍可用，合成 id=`default` |

```jsonc
{
  "defaultProvider": "work",
  "providers": {
    "work": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    "claude": {
      "kind": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    }
  }
}
```

**合并：** user/project 同 id 字段浅合并；`defaultProvider` 后写覆盖。  
**Key：** 优先 `apiKeyEnv` / 环境变量；不要把密钥提交进项目配置。  
**热切失败**（缺 key / 未知 id）→ 明确错误，**保留**当前 provider。  
**后置（P5）：** Desktop 设置下拉；resume 快照持久化 `providerId`。

### Effort 方言（**E 轨 · E0–E5 已落地**）

推理强度用 **dialect 表** 映射到请求体（非厂商 if）。

| 文档 | 角色 |
|------|------|
| [EFFORT.md](./EFFORT.md) | 实现契约 |
| [EFFORT_OPTIMIZATION.md](./EFFORT_OPTIMIZATION.md) | E6+ 可选档 / 门控 / TTY |

```jsonc
{
  "providers": {
    "sf": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.siliconflow.cn/v1",
      "model": "deepseek-ai/DeepSeek-V4-Flash",
      "apiKeyEnv": "SILICONFLOW_API_KEY",
      "effort": { "dialect": "deepseek-chat" }
    },
    "claude": {
      "kind": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "effort": { "dialect": "anthropic-output" }
    }
  }
}
```

| 命令 | 说明 |
|------|------|
| `/effort` | 显示意图 · 方言 · **将发成的 wire** |
| `/effort max` · `xhigh` · `ultra` … | 设会话意图；由方言折叠 |
| `/ultrathink [off\|tip\|turn]` | **CX8** 产品糖；默认 off。见 PROVIDER_UX |

未写 `effort` 时：DeepSeek / Anthropic / Responses 会 **detect**；其它兼容口默认旧 `max-tokens` 倍率。

| 字段 | 默认 | 说明 |
|------|------|------|
| `autoCompactEnabled` | `true` | 为 true 且会话有 `compactSummarizer` 时，queryLoop 的 `prepareMessages` 达 token 阈值会走 full compact（对照参考 autoCompactIfNeeded）。会话内 `/autocompact on\|off` 可改；环境变量 `BOLO_DISABLE_AUTO_COMPACT` / `BOLO_DISABLE_COMPACT` 熔断 auto（manual `/compact` 仍可用） |
| `ultrathink` | 省略/`off` | **CX8**：`off` \| `tip` \| `turn`。默认 off。`tip` 检测关键词只提示；`turn` 本轮 effective effort→high（不写 session）。env `BOLO_ULTRATHINK` 可覆盖；会话 `/ultrathink` 最高。见 [PROVIDER_UX.md](./PROVIDER_UX.md) |
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
