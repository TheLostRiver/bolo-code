# 会话持久化与 Resume（最小可用）

> 对照 HelsincyCode `sessionStorage`：有 session id、落盘、resume。  
> Bolo：**T3 默认只写 `.jsonl`**（`sessionTranscript.ts`）；旧 `.json` **只读兼容**；`writeJsonSnapshot: true` 可双写。  
> **`loadSession` / `resumeSession`（J-C+ / J-D）**：同 id 同时存在 `.json` 与 `.jsonl` 时，**messages 优先 jsonl**（须有至少一条有效 message；空/全坏行回退 JSON）；配置切片优先 JSON，仅 jsonl 时从 **meta 扩展字段**恢复。仅有其一则用其一。  
> **compact R1：** `loadTranscriptMessages` 只重建**最后一个** `compact_boundary` 之后的 message 链。

## 1. 路径约定

| Scope | 路径 |
|-------|------|
| **project**（默认写） | `<cwd>/.bolo/sessions/<sessionId>.jsonl` |
| **user** | `~/.bolo/sessions/<sessionId>.jsonl`（或 `$BOLO_CONFIG_DIR/sessions/`） |
| **旧 JSON（只读）** | 同目录 `<sessionId>.json`（resume / list 仍识别） |
| **可选双写** | `saveSession(..., { writeJsonSnapshot: true })` 仍写 JSON 快照 |

- 目录由 `ensureUserLayout` / `ensureProjectLayout` 创建。
- 项目 `.bolo/sessions/` 已在仓库 `.gitignore` 中。
- 也可传入绝对 `filePath` / `sessionsDir`（测试或自定义）。

### 1.1 格式 v2：JSONL（T3 主路径）

每行一个 JSON entry（线性，无 parentUuid）：

| type | 用途 |
|------|------|
| `meta` | 文件首行：id / cwd / permissionMode / model / createdAt + **配置切片**（systemPromptSections、autoCompact、contextWindow、maxPtlRetries、permissionRules、effortLevel、**providerId**、usage…） |
| `message` | 包裹现有 `ChatMessage` |
| `compact_boundary` | full compact 边界（`compactSession` 成功后 rewrite jsonl 写入） |
| `title` | 会话标题（**last-wins**；**不进**模型 messages；rewrite 时保留最后一条） |
| `turn` | Durable Turn 生命周期（`turnId` + `state`；**不进**模型 messages；rewrite 时保留） |

`saveSession` **默认**只增量 append / rewrite `.jsonl`；不再默认原子写 JSON。`migrateSessionToJsonl` 可将旧 JSON 旁路写出 jsonl（默认不删 JSON）。`setSessionTitle` / `/title` 追加 `title` 行；`appendSessionSystemNote` / `/note` 追加 `system_note`（不进模型链）。list 对 jsonl 走 `scanTranscriptLite`（轻量计数字段 + 近况 preview）。详见 `docs/TODO_SESSION_JSONL.md`。

### 1.2 Durable Turn v1（DR0–DR1）

持久化 CLI/workspace 会话在调用 provider 前追加 turn 生命周期：

```jsonc
{"type":"turn","sessionId":"...","turnId":"turn_...","state":"admitted","prompt":"最终 hook 归约后的输入","timestamp":"..."}
{"type":"turn","sessionId":"...","turnId":"turn_...","state":"running","timestamp":"..."}
{"type":"turn","sessionId":"...","turnId":"turn_...","state":"completed","terminalReason":"completed","timestamp":"..."}
```

状态集合：`admitted | running | completed | error | aborted | interrupted`。

- `admitted` 必须先于 user message 入内存和 provider 调用；只在这一行保存 prompt。
- `running` 表示本进程已领取执行；同一 `turnId` 重复提交不得再次调用 provider/tool。
- terminal 行必须晚于 messages 成功落盘。保存失败时保留 running，恢复按 interrupted 展示。
- resume 将最后状态仍为 admitted/running 的 turn 投影为 interrupted；默认不自动重放。
- compact rewrite 保留 turn entries；turn entries、title、notes、file_diff 都不进入模型消息链。
- 显式 in-memory session 可以无 transcript；CLI/workspace 的 autoSave 主路径提供上述 durable 保证。

### 1.3 SessionCoordinator（DR2A）

`submitPrompt` 在运行任何异步 hook/provider/tool 前，先向 `SessionCoordinator` 获取当前 `sessionId` 的 runner lease：

```text
tryAcquire(sessionId, turnId)
  ├─ idle → running(owner=turnId) → submitPrompt → finally release
  └─ busy → error(session runner busy); no hook/admission/message/provider/tool
```

- 默认 coordinator 在同一进程内共享；两个对象只要 `sessionId` 相同也不能并发跑 turn。
- 不同 `sessionId` 使用独立 slot，可以并行。
- busy 拒绝不覆盖 active session 的 phase，也不把被拒 prompt 写入 transcript/messages。
- normal、hook blocked、provider error、abort、admission failure 都释放 lease；release 幂等。
- coordinator/lease 是运行时句柄，不写入 JSON/JSONL；resume 会重新注入默认或调用方指定的 coordinator。
- DR2A 不提供跨进程文件锁，也不实现 queue/steer/interrupt；这些属于 DR2B–DR4。

#### DR2B1 control intent（进程内契约）

```text
requestControl(controlId, kind, sessionId, expectedTurnId, ...)
  ├─ steer     → pending → safe boundary → promoted
  ├─ interrupt → promoted(interrupt_signal)
  └─ queue     → pending(active) | ready(idle)
                         → turn terminal → ready → FIFO take → promoted
```

- `steer` / `interrupt` 必须命中 active `turnId`；stale caller 不能控制新 turn。
- 同一 `controlId` + 同 payload 重试幂等；不同 payload fail-closed。
- queue/steer 在 promotion 前可取消；未使用 steer 在 active turn 释放时 cancelled。
- `after_provider` / `before_tools` 等会破坏 assistant-tool pairing 的位置不 promotion steer。
- interrupt 目前先产生 lease-local signal；DR2B2 接入 queryLoop 后才成为完整运行时动作。
- controls 暂为进程内投影，不写 transcript；崩溃恢复与 compact 保留规则归 DR2C。

#### DR2B2 queryLoop wiring

`submitPrompt` 将 CLI/调用方的 turn signal 与 coordinator lease signal 合并。`requestControl(kind: "interrupt")` 命中 expected active turn 后，会沿同一 abort 链终止 provider、可取消工具和 permission/diff 等待。

steer 只在以下 message-safe boundary promotion：

| boundary | 行为 |
|----------|------|
| `before_provider` | 在 prepare/callModel 前追加 steering user message |
| `after_tools` | assistant tool_calls 与全部 tool results 闭合后追加 |
| `after_compact` | compact 尝试完成后追加 |
| `before_stop` | final assistant 后追加，并继续当前 durable turn |

`after_provider`、`before_tools`、`turn_terminal` 只用于观测/终态，不注入 steer。每次 promotion 发送结构化 `control` event；消息和 terminal 仍由 core 单一状态机维护。

DR2B2 尚未提供 CLI 输入队列菜单，也未持久化 controls；permission/diff ask 的显式退出边界与 CLI control 入口属于 DR2B3，恢复投影属于 DR2C。

## 2. 快照格式（version 1，只读兼容）

单文件 JSON（旧路径 / `writeJsonSnapshot`），字段包括：

| 字段 | 说明 |
|------|------|
| `version` | 固定 `1` |
| `id` | 会话 id |
| `cwd` | 工作目录 |
| `permissionMode` | 权限模式 |
| `messages` | `ChatMessage[]`（含 `tool_calls` / `tool_call_id`） |
| `systemPromptSections` | system 段快照（resume 可重建或回退） |
| `model` / `autoCompactEnabled` / `contextWindowTokens` / `maxPtlRetries` | 会话配置切片 |
| `permissionRules` / `effortLevel` / **`providerId`** / `usage`（可选） | Always-allow + always-deny；effort；**命名后端 id（CX6 resume）**；本地 token 累计；resume 恢复；无遥测 |
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
  migrateSessionToJsonl,
} from '../packages/core/src/index.ts'

// 显式保存（T3：默认只写 jsonl）
const { path, snapshot, transcriptPath } = await saveSession(session, {
  scope: 'project',
})

// 可选：仍双写 JSON
await saveSession(session, { writeJsonSnapshot: true })

// 读快照（json + jsonl 配对）
const loaded = await loadSession(session.id, { cwd: session.cwd })

// 旧 JSON → 旁路 jsonl（默认不删 json）
await migrateSessionToJsonl(session.id, { cwd: session.cwd })

// 恢复 live session（SessionStart source=resume）
const { session: s2 } = await resumeSession({
  idOrPath: session.id, // 或绝对 .json / .jsonl 路径
  cwd: session.cwd,
  reassembleSystem: true, // 默认 true：重建 system；false 用快照/meta
  provider: createMockProvider(), // 重新注入
  systemPrompt: false, // 测试可关
})

// 每轮 query 结束后自动写盘（T3：jsonl）
const session = await createSession({
  cwd,
  autoSave: true, // 或 { scope: 'user', sessionsDir }
  // ...
})
```

| API | 作用 |
|-----|------|
| `toSnapshot` / `parseSessionSnapshot` | 序列化 / 校验（JSON 形状） |
| `saveSession` / `persistSession` | **默认只写 jsonl**；`writeJsonSnapshot` 可选 JSON |
| `loadSession` | 读 JSON+旁路 jsonl → `SessionSnapshot`（双文件：jsonl messages 非空则优先；否则 JSON） |
| `loadTranscriptFile` / `loadTranscriptMessages` | 读 jsonl → entries / **R1** 线性 messages（最后 boundary 之后） |
| `migrateSessionToJsonl` | 旧 JSON 旁路写出 jsonl（D2；可选 `deleteJson` / `force`） |
| `setSessionTitle` | 追加 `title` entry（last-wins；不进模型链） |
| `listProjectSessions` | 扫 `*.json` + `*.jsonl`（path/配置优先 JSON；messageCount/preview 跟可用 jsonl；**title** 来自 jsonl last-wins；updatedAt 取较新；去重；坏文件跳过） |
| `resumeSession` | `loadSession` + `createSession` + 恢复 messages/配置 |
| `resolveSessionFilePath` | 解析「逻辑 JSON」路径（配对用） |

## 4. 与 HC 的差异

| HelsincyCode | Bolo（T3） |
|--------------|------------|
| JSONL 追加 transcript | **默认只写** `.jsonl` 增量 append；旧 JSON 只读 |
| 项目哈希目录 + 多类 entry | 固定 `.bolo/sessions/<id>.jsonl`（+ 可选旧 `.json`） |
| 丰富元数据 / 侧链 agent | 主会话 messages + meta 配置切片；entry 最小集 meta/message/boundary/**title** |

Resume 主路径：`loadSessionPair` — **messages 以 jsonl 为准**（有效 message 非空时），JSON 提供 meta/配置；仅 jsonl 时 meta 扩展字段恢复配置；jsonl 仅 meta/坏行时回退 JSON messages。

```bash
npx tsx scripts/test-transcript-append.ts
npx tsx scripts/test-transcript-load.ts
npx tsx scripts/test-session-persist.ts
npx tsx scripts/test-session-title.ts
```

## 5. CLI：`bolo --resume` / `--list` / migrate

最小 CLI 包 `@bolo/cli`（bin：`bolo`）。对照参考实现的 `-r/--resume`，本轮只做入口接线，**无 Ink TUI / 无遥测**。

### 用法

```bash
# 仓库内（需已安装依赖；tsx 在根 devDependencies）
# 非交互列项目会话
npx bolo --list
npx bolo -l

# 无 id：列出当前项目会话（TTY 选择 / 非 TTY 打印列表）
npx bolo --resume
npx bolo -r

# 旧 JSON → 旁路 jsonl（默认不删 JSON）
npx bolo --migrate-session <sessionId>
npx bolo migrate-session <sessionId> --force --delete-json

npx bolo --resume <sessionId>
npx bolo --resume=<sessionId>
npx bolo -r <sessionId>
npx bolo --resume path/to/session.json
npx bolo --resume path/to/session.jsonl

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
| **`--list` / `-l`** | 非交互打印 `listProjectSessions`（title 优先于 preview 展示） |
| **`--migrate-session` / `migrate-session`** | 包装 `migrateSessionToJsonl`；`--force` / `--delete-json` |
| 另有 prompt（`-p` / 位置参数 / 管道 stdin） | `submitPrompt` 一轮并打印助手文本；默认 autoSave |
| TTY 且无 prompt、无 `--print` | 极简 readline 循环（`bolo>` → submit → 打印；空行或 `/exit` 退出） |
| `--print` 且无 prompt | 仅摘要后退出 |
| 无 API key | **仍可加载快照**；真正 callModel 时清晰报错（`BOLO_PROVIDER=mock` 可离线） |

### 查找顺序（纯 id）

1. `<cwd>/.bolo/sessions/<id>.jsonl` / `.json`（project，`loadSessionPair`）
2. `~/.bolo/sessions/<id>.*` 或 `$BOLO_CONFIG_DIR/sessions/`（user）
3. 含路径分隔符或 `.json` / `.jsonl` 后缀 → 当作文件路径

与 `loadSession` / `resumeSession` 一致。

## 6. 验收

```bash
npx tsx scripts/test-session-persist.ts
npx tsx scripts/test-transcript-append.ts
npx tsx scripts/test-transcript-load.ts
npx tsx scripts/test-cli-resume.ts
npx tsx scripts/test-session-list.ts
npx tsx scripts/test-session-title.ts
```
