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

## 5. CLI：`bolo --resume`

最小 CLI 包 `@bolo/cli`（bin：`bolo`）。对照参考实现的 `-r/--resume`，本轮只做入口接线，**无 Ink TUI / 无遥测**。

### 用法

```bash
# 仓库内（需已安装依赖；tsx 在根 devDependencies）
npx bolo --resume <sessionId>
npx bolo --resume=<sessionId>
npx bolo -r <sessionId>
npx bolo --resume path/to/session.json

# 恢复后只打印摘要（非交互）
npx bolo --resume <id> --print

# 恢复后单轮 prompt，打印助手输出
npx bolo --resume <id> -p "继续上次任务"
npx bolo --resume <id> "位置参数也会当作 prompt"

# 指定解析 project sessions 的 cwd
npx bolo --resume <id> --cwd /path/to/project
```

也可：`npx tsx packages/cli/src/main.ts --resume <id>`。

### 行为

| 场景 | 行为 |
|------|------|
| `--resume` 成功 | 打印摘要：id、cwd、文件路径、消息数、最近一条 |
| 另有 prompt（`-p` / 位置参数 / 管道 stdin） | `submitPrompt` 一轮并打印助手文本；默认 autoSave |
| TTY 且无 prompt、无 `--print` | 极简 readline 循环（`bolo>` → submit → 打印；空行或 `/exit` 退出） |
| `--print` 且无 prompt | 仅摘要后退出 |
| 无 API key | **仍可加载快照**；真正 callModel 时清晰报错（`BOLO_PROVIDER=mock` 可离线） |

### 查找顺序（纯 id）

1. `<cwd>/.bolo/sessions/<id>.json`（project）
2. `~/.bolo/sessions/<id>.json` 或 `$BOLO_CONFIG_DIR/sessions/`（user）
3. 含路径分隔符或 `.json` 后缀 → 当作文件路径

与 `loadSession` / `resumeSession` 一致。

## 6. 验收

```bash
npx tsx scripts/test-session-persist.ts
npx tsx scripts/test-cli-resume.ts
```