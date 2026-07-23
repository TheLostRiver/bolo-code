# 项目级 Bolo 配置（`.bolo/`）

本目录与全局 `~/.bolo/` **结构对称**，仅作用域是当前仓库。

```
.bolo/
  config.json      # 覆盖全局 provider / permissionMode 等
  mcp.json
  hooks.json
  skills/
    <id>/SKILL.md  # 项目 skill（同 id 覆盖 ~/.bolo/skills）
  plugins/
  sessions/        # 本地会话（默认 gitignore）
```

## Skills

- 路径：`.bolo/skills/<skill-id>/SKILL.md`
- 与全局合并：先加载 `~/.bolo/skills`，再加载项目 skills，**同 id 以项目为准**
- 上下文只注入**目录索引**；全文由模型调用 `Skill` 工具按需加载（见 `docs/SKILLS.md`）

## 初始化

```bash
npx tsx scripts/bolo-init.ts
```

会在全局与当前项目创建缺省目录与默认 JSON（不覆盖已有文件）。

## 密钥

API Key 优先用环境变量；不要把密钥提交进本目录的 `config.json`。