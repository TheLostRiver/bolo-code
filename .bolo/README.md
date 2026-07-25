# 项目级 Bolo 配置（`.bolo/`）

本目录与全局 `~/.bolo/` **结构对称**，仅作用域是当前仓库。

```
.bolo/
  config.json      # JSONC（可用 // 注释）— 覆盖全局 provider / agents …
  mcp.json
  hooks.json
  skills/
    <id>/SKILL.md  # 项目 skill（同 id 覆盖 ~/.bolo/skills）
  agents/
    README.md      # subagent frontmatter 字段说明
    *.md           # 自定义 subagent 类型
  plugins/
  sessions/        # 本地会话（默认 gitignore）
```

## config.json（带注释）

`bolo-init` / `ensure*Layout` 会生成**带中文注释**的默认模板，说明：

- `provider` / `permissionMode`
- **`agents`**：`enabled` · `maxConcurrent` · `defaultModel` · `defaultEffort` · **`maxSpawnDepth`** · `overflow`

加载器支持 JSONC（`//`、`/* */`）。勿把 API Key 写进仓库。

## agents/

- 路径：`.bolo/agents/<name>.md`
- 字段说明见同目录 **`README.md`**（初始化时写入）
- 完整契约：`docs/SUBAGENT_SPEC.md`

## Skills

- 路径：`.bolo/skills/<skill-id>/SKILL.md`
- 与全局合并：先加载 `~/.bolo/skills`，再加载项目 skills，**同 id 以项目为准**
- 上下文只注入**目录索引**；全文由模型调用 `Skill` 工具按需加载（见 `docs/SKILLS.md`）

## 初始化

```bash
npx tsx scripts/bolo-init.ts
```

会在全局与当前项目创建缺省目录与默认文件（**不覆盖已有** `config.json`）。

## 密钥

API Key 优先用环境变量；不要把密钥提交进本目录的 `config.json`。