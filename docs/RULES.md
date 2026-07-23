# Rules（`.bolo/rules`）

> 对照 HelsincyCode `.claude/rules` 多文件自动加载 + Antigravity 式 rules 文件夹。  
> **无遥测。**

## 路径

| 位置 | 说明 |
|------|------|
| `{cwd}/.bolo/rules/**/*.md` | 项目约束（推荐提交仓库） |
| `~/.bolo/rules/**/*.md` | 用户全局（可选） |

- 递归扫描 `.md`；跳过 `node_modules` / `.git`
- 排序：先用户目录，再项目目录；各自按相对路径名字母序（稳定，利于 prompt 缓存）

## 与 BOLO.md

| 层 | 角色 |
|----|------|
| **rules** | 可拆分约束包，默认进入 system |
| **BOLO.md** | 项目总说明 / 架构入口 |

注入顺序（system）：… → Environment → **`# Project rules`** → **`# Project & user instructions (BOLO.md)`** → skill catalog。

## Frontmatter（最小）

```md
---
disabled: true
alwaysApply: false
---
正文…
```

| 字段 | 默认 | 行为 |
|------|------|------|
| `disabled` | false | `true` 时跳过 |
| `alwaysApply` | true | `false` 时本版跳过（路径匹配以后再做） |

无 frontmatter 的文件整篇作为 body。

## 预算

与 BOLO.md 类似：

- 单文件默认 ≤ 32_000 字符
- 合计默认 ≤ 48_000 字符

关闭装载：`BOLO_DISABLE_RULES=1`。

## 斜杠

```text
/rules              # 等同 list：已加载 sources
/rules list
/rules show <name>  # 按 label / 片段预览
```

## API

- `loadBoloRules({ cwd, userConfigDir? })` → `{ text, sources[] }`
- `getSystemPrompt` / `assembleSessionSystemPrompt` 默认自动装载（`loadRules: false` 可关）
- `ensureProjectLayout` 会创建 `rules/` 目录

## 测试

```bash
npx tsx scripts/test-rules.ts
```