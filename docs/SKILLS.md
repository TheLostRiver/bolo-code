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
| **bundled** | 仓库 `packages/bundled-skills/`（发行内置，如 skill-creator / plugin-creator） |
| user | `~/.bolo/skills` |
| project | `.bolo/skills`（**同 id 覆盖 user / bundled**） |
| plugin | 插件内 `skills/`（再覆盖） |

发现代码：`discoverSkills()` 顺序 **bundled → user → project**（后者覆盖前者）；workspace 再合并 plugin。

`SKILL.md` 示例：

```markdown
---
name: my-skill
id: my-skill
description: Short summary for the catalog
when_to_use: Use when the user asks about X. Examples: "do X", "help with X"
disable-model-invocation: false
user-invocable: true
---

# Full instructions only loaded when invoked

...
```

### Frontmatter 契约（S-PORT-1）

规范字段（推荐作者只写这些）：

| 规范键 | 含义 | 默认 |
|--------|------|------|
| `id` | 稳定 id；缺省用**目录名** | 目录名 |
| `name` | 展示名 | `id` |
| `description` | 目录短描述 | — |
| `when_to_use` | 模型何时该调 | — |
| `disable-model-invocation` | `true` → **不进**模型 catalog；Skill 工具拒绝 | `false` |
| `user-invocable` | `false` → 用户 `/skill` 拒绝（模型仍可见于 catalog，除非同时 disable） | `true` |

**别名（解析时折叠到规范键；规范键优先）：**

| 别名 | → 规范 |
|------|--------|
| `whenToUse` · `when-to-use` | `when_to_use` |
| `disableModelInvocation` · `disable_model_invocation` | `disable-model-invocation` |
| `userInvocable` · `user_invocable` | `user-invocable` |

- 未知键：保留在 raw，**不进** `SkillMeta`  
- 实现：`packages/skills/src/frontmatter.ts`（对照 HC `parseSkillFrontmatterFields` 语义）  
- 布尔：接受 `true/false` · `yes/no` · `on/off` · `1/0`  

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
| `packages/skills` · `frontmatter.ts` | **S-PORT-1** 契约解析 · 别名折叠 |
| `packages/skills` · `index.ts` | 发现、catalog、findById、format body |
| `packages/tools` Skill | 按 id 加载；尊重 disable-model-invocation |
| `packages/core` | session.skills + 注入 catalog · `/skill` 尊重 user-invocable |
| `docs/CONFIG.md` | 目录布局 |
| `docs/TODO_SKILL_MCP_PLUGIN.md` | 可移植切片序 |

## 5. 测试

```bash
npx tsx scripts/test-skill-catalog.ts
```

## 6. 内置元技能（bundled）

| id | 作用 |
|----|------|
| `skill-creator` | 引导写出可用的 `SKILL.md` 目录 |
| `plugin-creator` | 引导脚手架 `bolo.plugin.json` + contributes |

路径：`packages/bundled-skills/<id>/SKILL.md`，由 `getBundledSkillsDir()`（`import.meta`）定位。  
Slash：`/skill-creator`、`/plugin-creator`、`/skill <id>`、`/skills`（未知内置命令时回落到同名 user-invocable skill）。

## 7. 仍未做 / 规划

- 远程 skill / MCP skill  
- 与 HC 完全一致的动态 skill_discovery 预取  
- ~~frontmatter 契约表~~ → **S-PORT-1 ✅**（别名 + 未知键忽略 + 测）  

**后续切片：** S-PORT-2 旁路根 · S-PORT-3/4 覆盖序与 disable 文档化钉死 · S-PORT-5 预算可观测 — 见 **`docs/TODO_SKILL_MCP_PLUGIN.md`**。

---

**一句话：** 有 bundled + `~/.bolo/skills`；skill **进目录、不进全文**；全文靠 **Skill** 工具或 slash `/<id>` 按需加载，避免 token 爆炸。