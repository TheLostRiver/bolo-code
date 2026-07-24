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

### 合并（S-PORT-3）

| 来源 | 路径 | 同 id |
|------|------|--------|
| **bundled** | `packages/bundled-skills/` | 最低 |
| **extra**（可选） | `config.extraSkillRoots[]` 各根下 `<id>/SKILL.md` | 盖 bundled；**默认不扫** |
| user | `~/.bolo/skills` | 盖 extra |
| project | `.bolo/skills` | 盖 user |
| plugin | 插件 `skills/` | **最高** |

API：`mergeSkillsByPrecedence(...layers)`（后层赢）；`discoverSkills` = bundled→extra→user→project；`loadWorkspace` 再 merge plugin。  
`resolveExtraSkillRoots`：`~` 展开、相对 **cwd**、去重；**未配置 = off**（不静默吃 `~/.agents/skills`）。  
`/skills` 每行显示 `[source]` 与 flags。

### 调用矩阵（S-PORT-4）

| | Skill 工具（模型） | `/skill` · `/<id>`（用户） | 进模型 catalog |
|--|-------------------|---------------------------|----------------|
| 默认 | ✅ | ✅ | ✅ |
| `disable-model-invocation: true` | ❌ | ✅（若 user-invocable） | ❌ |
| `user-invocable: false` | ✅ | ❌ | ✅ |
| 两者皆限制 | ❌ | ❌ | ❌ |

两字段**正交**。`isSkillModelInvocable` / `isSkillUserInvocable`。

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
  → system 注入 formatSkillCatalog(..., { contextWindowTokens })  // 目录 only + 预算
  → 模型若需要 → tool Skill → formatSkillBodyForInjection
```

### Catalog 预算可观测（S-PORT-5）

对照 HC `getCharBudget`（约 **1% 上下文 × 4 chars/token**；默认 ~8000；Bolo 上限 12000）：

| API | 作用 |
|-----|------|
| `getSkillCatalogCharBudget` | 推算预算（`maxChars` / `BOLO_SKILL_CATALOG_CHAR_BUDGET` / 窗口 / 默认） |
| `formatSkillCatalogWithStats` | 文本 + `SkillCatalogStats`（listed/omitted/budget/used…） |
| `formatSkillCatalogStatsLine` | 人类可读一行 |

**可见性：**

- `/skills`：列表末行 stats  
- `/context`：`skill catalog: listed … · chars …`  
- 模型 system 段：预算截断时带 `… (N more skills omitted…)`  

环境变量：`BOLO_SKILL_CATALOG_CHAR_BUDGET`（正整数，覆盖窗口推算）。

## 4. 代码位置

| 模块 | 职责 |
|------|------|
| `packages/skills` · `frontmatter.ts` | **S-PORT-1** 契约解析 · 别名折叠 |
| `packages/skills` · `index.ts` | 发现、`mergeSkillsByPrecedence`、catalog、调用门控、format body |
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
- ~~frontmatter 契约表~~ → **S-PORT-1 ✅**  
- ~~覆盖序 / disable·user-invocable 矩阵~~ → **S-PORT-3/4 ✅**  
- ~~可选旁路 skill 根~~ → **S-PORT-2 ✅**（`extraSkillRoots`，默认 off）  
- ~~catalog 预算可观测~~ → **S-PORT-5 ✅**  

**后续：** S-PORT-6 creator · S-PORT-7 文档约束 — 见 **`docs/TODO_SKILL_MCP_PLUGIN.md`**。

---

**一句话：** 有 bundled + `~/.bolo/skills`；skill **进目录、不进全文**；全文靠 **Skill** 工具或 slash `/<id>` 按需加载，避免 token 爆炸。