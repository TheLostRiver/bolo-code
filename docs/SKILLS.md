# Skills — 全局目录与按需调用

> 对照 HelsincyCode：`~/.claude/skills` + `SkillTool` + `skill_listing` 目录预算。

## 1. 目录结构（有）

### 全局

```
~/.bolo/skills/<id>/SKILL.md     # 或 $BOLO_CONFIG_DIR/skills
```

### 项目（与全局对称）

```
<repo>/.bolo/
  config.json
  mcp.json
  hooks.json
  skills/
    <id>/SKILL.md                 # 项目 skill
  plugins/
  sessions/
```

`bolo-init` / `ensureProjectLayout(cwd)` 会创建项目 `.bolo/skills/`。

### 合并

| 来源 | 路径 |
|------|------|
| user | `~/.bolo/skills` |
| project | `.bolo/skills`（**同 id 覆盖 user**） |
| plugin | 插件内 `skills/`（再覆盖） |

发现代码：`discoverSkills()` 先 user 再 project。

`SKILL.md` 示例：

```markdown
---
name: my-skill
description: Short summary for the catalog
when_to_use: Use when the user asks about X. Examples: "do X", "help with X"
disable-model-invocation: false
user-invocable: true
---

# Full instructions only loaded when invoked

...
```

| frontmatter | 含义 |
|-------------|------|
| `description` | 目录短描述 |
| `when_to_use` | 模型何时该调（对照 HC `whenToUse`） |
| `disable-model-invocation: true` | 模型不能用 Skill 工具调，仅用户 `/skill`（后置） |
| `user-invocable` | 用户是否可 slash 调用（默认 true） |

## 2. HelsincyCode 怎么避免 token 爆炸

| 层 | 行为 |
|----|------|
| **发现** | 扫 `~/.claude/skills` 等，解析 frontmatter |
| **进上下文** | 只塞 **skill_listing**：name + description/whenToUse，有 **字符预算**（约上下文 1%） |
| **全文** | **不**默认进 prompt；模型调 **Skill 工具** 时再加载 body |
| **注释** | HC 写明：full content only loaded on invocation |

你的记忆正确：**全局 skill 不是全部塞进上下文，而是由 agent（模型）决定是否调用 Skill 工具。**

## 3. Bolo 当前策略（已对齐）

| 错误做法（已改） | 正确做法（现在） |
|------------------|------------------|
| `skillsToSystemPrompt` 拼全文 | `formatSkillCatalog` 只索引 |
| 无 Skill 工具 | 内置工具 **`Skill`** `{ skill: "<id>" }` 返回全文 |

流程：

```
loadWorkspace → 发现 skills 全文表挂到 session.skills
createSessionFromWorkspace
  → system 注入 formatSkillCatalog(...)   // 目录 only
  → 模型若需要 → tool Skill → formatSkillBodyForInjection
```

## 4. 代码位置

| 模块 | 职责 |
|------|------|
| `packages/skills` | 发现、catalog、findById、format body |
| `packages/tools` Skill | 按 id 加载 |
| `packages/core` | session.skills + 注入 catalog |
| `docs/CONFIG.md` | 目录布局 |

## 5. 测试

```bash
npx tsx scripts/test-skill-catalog.ts
```

## 6. 仍未做

- 用户 slash `/skill-name` UI  
- 远程 skill / MCP skill  
- 与 HC 完全一致的动态 skill_discovery 预取  

---

**一句话：** 有 `~/.bolo/skills`；全局 skill **进目录、不进全文**；全文靠模型调 **Skill** 工具按需加载，避免 token 爆炸。