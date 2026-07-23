# 会话持久化与 Resume（最小可用）

> 对照 HelsincyCode `sessionStorage`：有 session id、落盘、resume。  
> Bolo：**单文件 JSON 快照**（非整段 JSONL 事件流），**无遥测**。

## 1. 路径约定

| Scope | 路径 |
|-------|------|
| **project**（默认） | `<cwd>/.bolo/sessions/<sessionId>.json` |
| **user** | `~/.bolo/sessions/<sessionId>.json`（或 `$BOLO_CONFIG_DIR/sessions/`） |

- 目录由 `ensureUserLayout` / `ensureProjectLayout` 创建。
- 项目 `.bolo/sessions/` 已在仓库 `.gitignore` 中。
- 也可传入绝对 `filePath` / `sessionsDir`（测试或自定义）。

## 2. 快照格式（version 1）

单文件 JSON，字段包括：

| 字段 | 说明 |
|------|------|
| `version` | 固定 `1` |
| `id` | 会话 id |
| `cwd` | 工作目录 |
| `permissionMode` | 权限模式 |
| `messages` | `ChatMessage[]`（含 `tool_calls` / `tool_call_id`） |
| `systemPromptSections` | system 段快照（resume 可重建或回退） |
| `model` / `autoCompactEnabled` / `contextWindowTokens` / `maxPtlRetries` | 会话配置切片 |
| `createdAt` / `updatedAt` | ISO 时间 |

**不落盘**：provider、hooks 运行时、skills 全文、`onEvent`、`askPermission` 等句柄（resume 时由调用方重新注入）。

## 3. API

```ts
import {
  createSession,
  submitPrompt,
  saveSession,
  loadSession,
  resumeSession,
  persistSession,
} from '../packages/core/src/index.ts'

// 显式保存
const { path, snapshot } = await saveSession(session, { scope: 'project' })

// 读快照
const loaded = await loadSession(session.id, { cwd: session.cwd })

// 恢复 live session（SessionStart source=resume）
const { session: s2 } = await resumeSession({
  idOrPath: session.id, // 或绝对 .json 路径
  cwd: session.cwd,
  reassembleSystem: true, // 默认 true：重建 system；false 用快照
  provider: createMockProvider(), // 重新注入
  systemPrompt: false, // 测试可关
})

// 每轮 query 结束后自动写盘
const session = await createSession({
  cwd,
  autoSave: true, // 或 { scope: 'user', sessionsDir }
  // ...
})
```

| API | 作用 |
|-----|------|
| `toSnapshot` / `parseSessionSnapshot` | 序列化 / 校验 |
| `saveSession` / `persistSession` | 原子写（temp + rename） |
| `loadSession` | 读 JSON → `SessionSnapshot` |
| `resumeSession` | load + `createSession` + 恢复 messages/配置 |
| `resolveSessionFilePath` | 仅解析路径 |

## 4. 与 HC 的差异

| HelsincyCode | Bolo（本轮） |
|--------------|--------------|
| JSONL 追加 transcript | 整会话 JSON 覆盖写 |
| 项目哈希目录 + 多类 entry | 固定 `.bolo/sessions/<id>.json` |
| 丰富元数据 / 侧链 agent | 仅主会话 messages + 配置切片 |

后续若需要增量 transcript 或 GUI 历史列表，可在本格式上扩展，不必先抄 HC 全量。

## 5. 验收

```bash
npx tsx scripts/test-session-persist.ts
```