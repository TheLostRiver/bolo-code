# Findings

## 系统提示词（对照 HC）

| HC | Bolo |
|----|------|
| `constants/prompts.getSystemPrompt` | `core/systemPrompt.getSystemPrompt`（精简段） |
| `utils/systemPrompt.buildEffectiveSystemPrompt` | 同名，去掉 coordinator/agent/遥测 |
| `context.getUserContext` + CLAUDE.md | `loadBoloMd` → system section |
| query 内 `appendSystemContext` | `prepareModelMessages` 每轮前缀 |
| DYNAMIC_BOUNDARY / GrowthBook / memdir | **不做** |

## BOLO.md 优先级（拼接序）

1. `~/.bolo/BOLO.md`（或 `$BOLO_CONFIG_DIR`）
2. `{cwd}/BOLO.md`
3. `{cwd}/.bolo/BOLO.md`
4. 兼容：`CLAUDE.md` / `AGENTS.md` / `.bolo/CLAUDE.md`

预算：单文件 32k、合计 48k 字符。关闭：`BOLO_DISABLE_BOLO_MD`。

## Glob `**/*.ts` 根目录漏匹配
- 旧实现把 `**` 换成 `.*`，再保留 `/`，要求至少一层路径
- 修：`**/` → `(?:.*/)?`（0+ 层目录）

## Schema 职责
- 工具 JSON Schema 应只在 tools 包；provider 只做格式映射
- 已去掉 openaiCompatible/anthropic 内重复 defaultToolParameters

## 与 HC 仍有差距（有意后置）
- StreamingToolExecutor、zod 全量、maxResultSizeChars、MCP 进同一 Tools 列表
- 完整 memory/rules 目录 walk、git status systemContext、MCP instructions 动态段