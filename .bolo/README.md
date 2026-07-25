# 项目级 Bolo 配置（`.bolo/`）

本目录与全局 `~/.bolo/` **结构对称**，作用域是当前仓库。

```text
.bolo/
  config.json      # JSONC（可用 // 注释）— 覆盖全局 provider / providers / agents …
  mcp.json
  hooks.json
  skills/
    <id>/SKILL.md  # 项目 skill（同 id 覆盖 ~/.bolo/skills）
  agents/
    README.md      # subagent frontmatter 字段说明
    *.md           # 自定义 subagent 类型
  plugins/
  rules/           # 可选 path-scoped rules
  sessions/        # 本地会话（默认应 gitignore）
  memory/          # 可选项目 memory
```

## config.json

`bolo-init` / `ensure*Layout` 会生成**带注释**的默认模板（**不覆盖**已有文件）。

常用字段：

| 字段 | 说明 |
|------|------|
| `provider` | 旧：单后端；无 `providers` 时合成 id=`default` |
| `providers` | 命名后端表；运行中 `/provider` 热切 |
| `defaultProvider` | 启动 active id |
| `permissionMode` | default · acceptEdits · plan · auto · bypassPermissions |
| `agents` | subagent 全局策略（enabled · maxConcurrent · maxSpawnDepth …） |
| `autoCompactEnabled` 等 | 见 [docs/CONFIG.md](../docs/CONFIG.md) |

**多后端示例：**

```jsonc
{
  "defaultProvider": "work",
  "providers": {
    "work": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  }
}
```

加载器支持 JSONC（`//`、`/* */`）。**勿把 API Key 写进仓库。**

## agents/

- 路径：`.bolo/agents/<name>.md`
- 字段说明见同目录初始化写入的说明；契约：`docs/SUBAGENT_SPEC.md`
- **操作步骤（含全局 `agents` 段）：** [docs/USAGE.md §5](../docs/USAGE.md)

## Skills

- 路径：`.bolo/skills/<skill-id>/SKILL.md`
- 合并：`~/.bolo/skills` ← 项目 skills（同 id 项目赢）
- 上下文只注入**目录索引**；全文由 `Skill` 工具按需加载（`docs/SKILLS.md`）

## 初始化

```bash
npx tsx scripts/bolo-init.ts
```

在全局与当前项目创建缺省目录与默认文件。

## 密钥与 sessions

- Key：环境变量或 `apiKeyEnv`；不要提交 `config.json` 里的明文 key  
- 建议 ignore：`.bolo/sessions/`、含密钥的本地覆盖  

| 文档 | 说明 |
|------|------|
| [docs/USAGE.md](../docs/USAGE.md) | 使用手册 |
| [docs/AGENT_HANDOFF.md](../docs/AGENT_HANDOFF.md) | 开发交接 |
| [docs/CONFIG.md](../docs/CONFIG.md) | 配置合并规则 |
| [docs/PROVIDERS.md](../docs/PROVIDERS.md) | Provider |
| [docs/ROADMAP.md](../docs/ROADMAP.md) | 进度 |