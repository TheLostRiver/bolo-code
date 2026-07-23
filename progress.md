# Progress Log

## Session: system prompt + BOLO.md

- `packages/core/src/systemPrompt.ts`：身份/规则/任务/工具/环境 + BOLO.md + skill catalog
- Session：`systemPromptSections`；queryLoop：`prepareModelMessages` 每轮前缀
- `createSessionFromWorkspace` 走统一组装；SessionStart inject 进 sections
- docs：`SYSTEM_PROMPT.md`；CONFIG / ROADMAP 更新
- tests：`test-system-prompt`；smoke-turn 显式 `systemPrompt: false`

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