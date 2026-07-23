# Findings

## Glob `**/*.ts` 根目录漏匹配
- 旧实现把 `**` 换成 `.*`，再保留 `/`，要求至少一层路径
- 修：`**/` → `(?:.*/)?`（0+ 层目录）

## Schema 职责
- 工具 JSON Schema 应只在 tools 包；provider 只做格式映射
- 已去掉 openaiCompatible/anthropic 内重复 defaultToolParameters

## 与 HC 仍有差距（有意后置）
- StreamingToolExecutor、zod 全量、maxResultSizeChars、MCP 进同一 Tools 列表