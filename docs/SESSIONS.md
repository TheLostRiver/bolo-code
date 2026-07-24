# 会话持久化与 Resume（最小可用）

> 对照 HelsincyCode `sessionStorage`：有 session id、落盘、resume。  
> Bolo：**单文件 JSON 快照**为主路径；**T1 双写**旁路 JSONL append（`sessionTranscript.ts`），**无遥测**。  
> **`loadSession` / `resumeSession`（J-C+ / J-D）**：同 id 同时存在 `.json` 与 `.jsonl` 时，**messages 优先 jsonl**（须有至少一条有效 message；空/全坏行回退 JSON）；配置切片可从 JSON 补。仅有其一则用其一。  
> **compact R1：** `loadTranscriptMessages` 只重建**最后一个** `compact_boundary` 之后的 message 链。

## 1. 路径约定

| Scope | 路径 |
|-------|------|
| **project**（默认） | `<cwd>/.bolo/sessions/<sessionId>.json` |
| **user** | `~/.bolo/sessions/<sessionId>.json`（或 `$BOLO_CONFIG_DIR/sessions/`） |
| **transcript（T1 旁路）** | 同目录 `<sessionId>.jsonl`（`saveSession` / autoSave 增量 append） |

- 目录由 `ensureUserLayout` / `ensureProjectLayout` 创建。
- 项目 `.bolo/sessions/` 已在仓库 `.gitignore` 中。
- 也可传入绝对 `filePath` / `sessionsDir`（测试或自定义）。

### 1.1 目标格式 v2：JSONL（T1 双写中）

每行一个 JSON entry（线性，无 parentUuid）：

| type | 用途 |
|------|------|
| `meta` | 文件首行：id / cwd / permissionMode / model / createdAt |
| `message` | 包裹现有 `ChatMessage` |
| `compact_boundary` | full compact 边界（`compactSession` 成功后 rewrite jsonl 写入；不改 JSON 快照） |

`saveSession` 仍原子写 JSON 快照，并按上次 `messages.length` **增量 append** 新消息到 `.jsonl`；messages 变短时 rewrite 整份 jsonl。详见 `docs/TODO_SESSION_JSONL.md`。

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
| `permissionRules` / `effortLevel` / `usage`（可选） | Always-allow 列表、effort 档位、本地 token 累计；resume 恢复；无遥测 |
| `createdAt` / `updatedAt` | ISO 时间 |

**不落盘**：provider、hooks 运行时、skills 全文、`onEvent`、`askPermission` 等句柄（resume 时由调用方重新注入）。

## 3. API

```ts
import {
  createSession,
  submitPrompt,
  saveSession,
  loadSession,
  listProjectSessions,
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
| `saveSession` / `persistSession` | 原子写（temp + rename）+ 旁路 jsonl 双写 |
| `loadSession` | 读 JSON+旁路 jsonl → `SessionSnapshot`（双文件：jsonl messages 非空则优先；否则 JSON） |
| `loadTranscriptFile` / `loadTranscriptMessages` | 读 jsonl → entries / **R1** 线性 messages（最后 boundary 之后） |
| `listProjectSessions` | 扫 `*.json` + `*.jsonl`（path/配置优先 JSON；messageCount/preview 跟可用 jsonl；updatedAt 取较新；去重；坏文件跳过） |
| `resumeSession` | `loadSession` + `createSession` + 恢复 messages/配置 |
| `resolveSessionFilePath` | 仅解析路径 |

## 4. 与 HC 的差异

| HelsincyCode | Bolo（本轮 / T1） |
|--------------|------------------|
| JSONL 追加 transcript | JSON 快照 + 旁路 `.jsonl` 增量 append |
| 项目哈希目录 + 多类 entry | 固定 `.bolo/sessions/<id>.json` + `<id>.jsonl` |
| 丰富元数据 / 侧链 agent | 仅主会话 messages + 配置切片；entry 最小集 meta/message/boundary |

Resume 主路径：`loadSessionPair` — **messages 以 jsonl 为准**（有效 message 非空时），JSON 提供 meta/配置；jsonl 仅 meta/坏行时回退 JSON messages；仅 JSON 或仅 jsonl 均可恢复。

```bash
npx tsx scripts/test-transcript-append.ts
npx tsx scripts/test-transcript-load.ts
```

## 5. CLI：`bolo --resume`

最小 CLI 包 `@bolo/cli`（bin：`bolo`）。对照参考实现的 `-r/--resume`，本轮只做入口接线，**无 Ink TUI / 无遥测**。

### 用法

```bash
# 仓库内（需已安装依赖；tsx 在根 devDependencies）
# 无 id：列出当前项目会话（TTY 选择 / 非 TTY 打印列表）
npx bolo --resume
npx bolo -r

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

也可：`npx tsx packages/cli/src/main.ts --resume` 或 `--resume <id>`。

### 行为

| 场景 | 行为 |
|------|------|
| `--resume <id>` 成功 | 打印摘要：id、cwd、文件路径、消息数、最近一条 |
| **`--resume` / `-r` 无 id（已实现 RS1–RS6）** | `listProjectSessions` 扫当前项目 `.bolo/sessions`；TTY 编号选择后 `resumeSession`；非 TTY 打印列表并要求 `--resume <id>`（exit 2）；空列表提示 `bolo` 新建（exit 1） |
| **`--continue` / `-c`（RS9）** | `listProjectSessions` 第一条（最新）→ `resumeSession`；空列表 exit 1 |
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
npx tsx scripts/test-transcript-append.ts
npx tsx scripts/test-transcript-load.ts
npx tsx scripts/test-cli-resume.ts
npx tsx scripts/test-session-list.ts
```