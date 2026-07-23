# Progress Log

## Session: tool-calling align (HC Tool.ts)

- `packages/tools`: types.buildTool, builtins, providerSchema
- `packages/core`: toolExecution / toolOrchestration partition
- Glob fix: `**/` → `(?:.*/)?` 使 `**/*.ts` 命中根目录
- providers 去掉重复 defaultToolParameters，转发 toolsToOpenAI/Anthropic
- tests: test-tool-calling / test-provider-unit / smoke-turn PASS

## Session: dual providers (OpenAI + Anthropic)

- anthropic Messages SSE + openai-compatible
- docs/PROVIDERS.md
- *Done dual protocol.*