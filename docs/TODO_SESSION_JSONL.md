# TODO：会话持久化对齐 HelsincyCode（JSONL transcript）

> 状态：**进行中**（A+B+C 最小 + **J-D 含 T3**：停写 JSON 默认、meta 配置切片、`migrateSessionToJsonl`）  
> 目标：把 Bolo 从「整文件 JSON 快照」贴向 HC 的 **JSONL 追加 transcript**，服务 resume / 列表 / 崩溃恢复。  
> 原则：先读 HC `sessionStorage` 再 reimplement；**无遥测**；**不上 SQLite**（HC 主路径也不是 SQLite）。  
> 真源参考（只读）：HelsincyCode `src/utils/sessionStorage.ts` · `sessionStoragePortable.ts` · `sessionRestore.ts`  
> Bolo 现状：`packages/core/src/sessionPersist.ts` · `sessionTranscript.ts` · `docs/SESSIONS.md` · `bolo --resume`  
> **T1（历史）：** 双写 JSON + `.jsonl`。  
> **T3（当前默认）：** `saveSession` / autoSave **只写 jsonl**；`writeJsonSnapshot: true` 可双写；旧 JSON 只读。  
> **J-C+ / J-D：** 双文件 messages 优先 jsonl（**非空**）；空/全坏 jsonl **回退 JSON**；`loadTranscriptMessages` **R1**；meta 扩展配置切片；`migrateSessionToJsonl`。

---

## 0. 为什么做

| 现状（Bolo） | 问题 | HC 做法 |
|--------------|------|---------|
| 每轮（或显式）整文件覆盖写 `.json` | 大会话写放大；中途崩溃易丢最近一轮细节 | **append-only JSONL** |
| 只有 messages + 配置切片 | 难区分 compact 边界、侧链、元数据 entry | 多类型 entry 追加 |
| 列表 = 扫目录读整文件 | 会话浏览器贵 | 读 jsonl **头部/尾部** 可做 lite 列表 |
| resume 读整包 JSON | 可用但扩展性差 | `loadTranscriptFile` + 链重建 |

**明确不做（本规划范围外）：**

- SQLite / 远程同步 / 加密 vault  
- HC 全量 entry 类型（PR 关联、attribution 全家桶、CCR remote 等）  
- 遥测 / GrowthBook  
- 完整 Ink TUI 会话 picker（可后置；CLI 列表最小即可）

---

## 1. 目标形态（Bolo 目标态）

### 1.1 路径（建议，实现时再定死并写 CONFIG）

| 项 | 建议 |
|----|------|
| 主会话文件 | `{sessionsDir}/{sessionId}.jsonl` |
| 默认 project | `{cwd}/.bolo/sessions/{id}.jsonl` |
| 默认 user | `~/.bolo/sessions/{id}.jsonl`（或 `$BOLO_CONFIG_DIR`） |
| 可选 sidecar | `{id}.meta.json`（标题、摘要等；**非必须 P0**） |
| 旧格式 | 继续识别 `*.json` 快照，resume 时 **导入/兼容** |

> HC 用「项目哈希目录 + jsonl」；Bolo 已有 `.bolo/sessions/`，**优先保留 Bolo 布局**，只换 **格式与写入语义**，降低迁移成本。

### 1.2 Entry 最小集合（P0）

每行一个 JSON 对象，建议公共字段：

```text
type, uuid?, parentUuid?, sessionId, timestamp, ...
```

| type（草案） | 用途 | P0? |
|--------------|------|-----|
| `session_meta` / `meta` | id、cwd、permissionMode、model、created | **P0**（文件头或首次写入） |
| `user` / `assistant` / `tool`（或统一 `message`） | 对话消息 | **P0** |
| `compact_boundary` | full compact 边界（与现 compact 语义对齐） | **P0** |
| `system_note` | 可选：PTL marker、内部说明 | P1 |
| `title` / `summary` | 会话标题、任务摘要 | P1 |
| `agent_*` 侧链 | subagent transcript | P2（M3 Subagent 时） |

**消息体：** 复用现有 `ChatMessage` 形状（含 `tool_calls` / `tool_call_id`），外裹 entry 头。

### 1.3 写入语义

| 操作 | 行为 |
|------|------|
| 新消息落盘 | **append** 一行（或一轮多行），禁止每轮 rewrite 整文件 |
| full compact | rewrite jsonl：`meta` + `compact_boundary` + 当前 messages；内存仍按现 compact 逻辑；JSON 快照不变 |
| microcompact | **默认不落盘**（view 层裁剪，与现「不写回 session」一致）；若需 resume 一致再议 P2 |
| flush | 提供 `flushTranscript()`（进程退出 / 显式 save） |
| 原子性 | 单行 append + 可选 fsync；损坏行 **跳过并记日志**（无遥测：本地 debug 即可） |

### 1.4 读取 / Resume

| API（目标名，可微调） | 行为 |
|----------------------|------|
| `appendTranscriptEntry` | 追加 |
| `loadTranscript` | 解析 jsonl → messages + meta |
| `resumeSession` | 优先 `.jsonl`；若无则回退 `.json` 快照 |
| `listSessions`（lite） | 扫目录：mtime + 读首条 meta / 首条 user 摘要，**不**整文件 parse |

Resume 后：仍由调用方注入 provider / hooks / skills；system 默认 **重建**（与现一致），可选从 meta 回退。

### 1.5 CLI

| 能力 | 优先级 |
|------|--------|
| `bolo --resume <id>` 读 jsonl | **P0**（兼容 path） |
| 仍支持旧 `.json` | **P0** |
| **`bolo --resume`（无 id）→ 当前项目会话列表 + 交互选择** | **P0**（对齐 HC；与是否已切 JSONL 无关，先扫现有快照） |
| `bolo --list` / `bolo sessions` | P1（可与无 id resume 共用 `listSessions`） |
| `bolo --continue`（最近一次） | P1 |
| 美化 picker（箭头/Ink） | P2 / 随 M-TUI |

---

## 2. 对照 HC 的借鉴清单（实现前必读）

| HC 符号 / 概念 | 借鉴什么 | Bolo 是否 1:1 |
|----------------|----------|----------------|
| `getTranscriptPathForSession` | id → 文件路径 | 路径规则换成 `.bolo/sessions` |
| `appendEntry` / `appendEntryToFile` | 追加一行 JSON | **要**；去掉遥测 |
| `recordTranscript` | 消息增量写入 | **要**（简化：不必 parentUuid 全套也可先线性） |
| `loadTranscriptFile` | 解析 + 过滤 | **要** 最小版 |
| `buildConversationChain` + `parentUuid` | 分叉/剪枝 | **P1**：先做线性 transcript，分叉后置 |
| `isTranscriptMessage` | 哪些 entry 进模型链 | **要** |
| `MAX_TRANSCRIPT_READ_BYTES` | 防 OOM | **要**（Bolo 设合理上限，如 50MB） |
| `getAgentTranscriptPath` | 子代理文件 | **P2** |
| file-history / attribution / PR link | 产品周边 | **不做** |
| lite log / progressive list | 会话列表 | **P1** |

**刻意简化（第一刀）：**

1. **线性 append**（不强制 parentUuid 图）  
2. **一种主文件**（不做 HC 那套巨型 entry 动物园）  
3. **兼容层** 读旧 JSON 快照  

---

## 3. 分阶段 TODO（可勾选）

### Phase A — 规格与类型（文档 + 类型，无行为切换）

- [x] **A1** 在 `docs/SESSIONS.md` 增加「目标格式 v2：JSONL」章节（entry schema、路径、与 v1 JSON 关系）  
- [x] **A2** 定义 TypeScript 类型：`TranscriptEntry` / meta·message·compact_boundary（`packages/core/src/sessionTranscript.ts`，与 `sessionPersist.ts` 并存）  
- [ ] **A3** `findings.md` 写 HC 对照表（函数级，无本机盘符进 docs）  
- [x] **A4** 确定：**T1 双写**（json 快照 + jsonl append）；resume 仍 JSON；迁移工具后置  

**验收：** 文档 + 类型可编译；resume 仍走 JSON（T1）。

---

### Phase B — 写入路径（append）

- [x] **B1** `appendTranscriptLine(file, entry)`：UTF-8 一行 + `\n`；目录 ensure  
- [x] **B2** `ensureTranscriptFile(file, meta)`：若不存在写 `meta` 首行  
- [x] **B3** `recordSessionMessages(file, messages[])`：把 user/assistant/tool 编成 entry 追加  
- [x] **B4** 接线（T1 最小）：  
  - `saveSession` / `maybeAutoSaveSession`（含 submitPrompt 结束）默认双写 jsonl 增量  
  - `createSession({ autoSave })` 经 autoSave 路径覆盖  
  - [x] `compactSession` 成功后 rewrite jsonl 并写入 `compact_boundary`（不改 JSON 快照）  
- [ ] **B5** `flushTranscript` / 进程退出尽力 flush  
- [x] **B6** 单测：`scripts/test-transcript-append.ts`（追加 N 行、文件行数、损坏行跳过、增量双写）

**验收（T1）：** 新会话有 `.json` + 旁路 `.jsonl`；增量 append 不每轮 rewrite jsonl。

---

### Phase C — 读取与 Resume

- [x] **C1** `loadTranscriptFile(path)`：按行 parse；跳过坏行；上限字节  
- [x] **C2** entries → `ChatMessage[]`（+ meta 配置）via `loadTranscriptMessages`  
- [x] **C3** `resumeSession` 双文件策略（J-D）：  
  1. `loadSessionPair`：json + jsonl 并存 → messages 用 jsonl（**R1 后非空**）  
  2. jsonl 无有效 message → **回退 JSON messages**  
  3. 仅 json / 仅 jsonl / 路径 `.jsonl` 均可  
  - [x] **T3**：默认停写 JSON；`writeJsonSnapshot` 可选双写  
  - 未做：id 解析「先扫 jsonl 文件名再 json」与现 project→user 路径等价（pair 已覆盖）  
- [x] **C4** CLI `bolo --resume` / `--continue` 走 `listProjectSessions` + `resumeSession`（摘要 mtime/消息数/preview）  
- [x] **C5** 测试：`scripts/test-transcript-load.ts`：写 jsonl → load 一致；删 JSON → resume；**R1 boundary**；空/坏 jsonl 回退 JSON  

**验收：** jsonl 主路径绿；旧 json 仍可 resume；T3 默认只写 jsonl。

---

### Phase D — 兼容与迁移

- [x] **D1** 双读：扩展名 `.json` / `.jsonl` + `loadSessionPair` 内容合并（冲突策略见 C3）  
- [x] **D2** `migrateSessionToJsonl(id)`：旁路写出 jsonl（默认不删旧 json；`deleteJson` / `force` 可选）  
- [x] **D3** 文档：`SESSIONS.md` — 新写默认 jsonl；json 只读 / 可选双写  
- [x] **D4** `.gitignore` 已有 `.bolo/sessions/`（目录级覆盖其下 `*.jsonl`）  

**验收：** 老 `.json` 不炸；新会话默认仅 jsonl；migrate 可旁路写出。

---

### Phase E — 列表与 CLI 体验（P1）

- [x] **E1** `listProjectSessions({ cwd, limit })`：id、path、updatedAt、preview、messageCount（J-D：双文件 count/preview 跟 jsonl R1）  
- [ ] **E2** `bolo --list` / `bolo sessions`（现由 `--resume` 无 id 覆盖列表）  
- [x] **E3** `bolo --continue`：resume list 第一条（最新）  
- [x] **E4** 测试：`test-session-list` 多文件排序 + jsonl-only + 双文件去重  

**验收（部分）：** 无 LLM 可 list/continue；独立 `--list` 子命令可选。

---

### Phase F — 与 compact / PTL 对齐（P1）

- [x] **F1** full compact 后 jsonl rewrite 含 `compact_boundary`；`loadTranscriptMessages` **R1** 只取最后 boundary 之后 messages（写盘若仍为全量历史+boundary，resume 不带回 boundary 前链）  
- [x] **F2** 策略 **R1** 已写死并测：`messagesFromTranscriptEntries` + `test-transcript-load`；文档见 `SESSIONS.md`  
  - R2（全量再 compact）**不做**  
- [ ] **F3** PTL truncate：是否 append `system_note` 记录截断事件（可选）  

**验收（部分）：** `test-auto-compact` boundary 写盘 + `test-transcript-load` R1 PASS。

---

### Phase G — 后置（明确砍掉或很后）

- [ ] parentUuid 分叉链 / 剪枝  
- [ ] subagent 独立 `agent-*.jsonl`  
- [ ] file-history-snapshot  
- [ ] 会话标题 AI 生成落盘  
- [ ] SQLite 索引层（仅当列表/搜索真成瓶颈）  
- [ ] GUI 历史浏览器（M4）

---

## 4. 建议实现顺序（下一刀怎么切）

```text
A 规格/类型
  → B append 写入 + submitPrompt/compact 接线
  → C load + resume + CLI
  → D 旧 JSON 兼容
  → E list / continue
  → F compact 语义钉死
```

**第一刀推荐（可独立 PR）：**  
**A + B1–B3 + 单测**（只写 jsonl，resume 仍可暂时靠并行写旧 JSON 或双写一阶段）。

**双写过渡（降低风险，可选）：**

| 阶段 | 行为 |
|------|------|
| T0 现在 | 仅 JSON 快照 |
| T1 | **双写**：jsonl append + 仍写 json 快照（resume 仍读 json） |
| T2 | resume 优先 jsonl；json 回退 |
| T3 | 停止写 json；仅兼容读 |

---

## 5. 模块落点（建议）

| 模块 | 职责 |
|------|------|
| `packages/core/src/sessionTranscript.ts` | entry 类型、append、load、list lite |
| `packages/core/src/sessionPersist.ts` | **保留** v1 JSON 快照 API；或变为「快照适配器」 |
| `packages/core/src/index.ts` | `createSession` / `submitPrompt` / `resumeSession` 接线 |
| `packages/cli` | `--resume` / `--list` / `--continue` |
| `docs/SESSIONS.md` | 格式权威说明 |
| `docs/ROADMAP.md` | M5.1 从「JSON 快照 ✅」扩为「JSONL transcript 进行中」 |
| `scripts/test-transcript-*.ts` | 单测 |

**禁止：** 在 provider / tools 里写磁盘会话；会话 IO 只进 core（+ CLI 调用）。

---

## 6. 测试矩阵

| 用例 | 阶段 |
|------|------|
| append 3 轮 → 文件 3+ 行 meta/messages | B |
| 坏行跳过仍能 load | C |
| resume jsonl messages 与内存一致 | C |
| resume 旧 `.json` 仍成功 | D |
| compact 后 resume（R1） | F |
| `bolo --resume` / `--list` | C/E |
| 超大文件截断读（上限） | C |
| 回归：smoke-turn、test-session-persist、test-cli-resume | 全程 |

---

## 7. 风险与决策点（开工前要拍板）

| # | 问题 | 建议默认 |
|---|------|----------|
| 1 | 是否 T1 双写？ | **是**，一到两个版本后关 JSON 写 |
| 2 | parentUuid？ | **P0 不做**，线性即可 |
| 3 | micro 是否写盘？ | **否** |
| 4 | compact resume 策略 | **R1**（boundary 后有效链） |
| 5 | sessions 目录布局改 HC 哈希？ | **否**，保留 `.bolo/sessions` |
| 6 | SQLite？ | **不做**，除非 E 列表性能真不够 |

---

## 8. 完成定义（本专题 Done）

1. 新会话默认 **jsonl append**；文档与 `PROMPT`/`CONFIG` 无矛盾表述  
2. `resumeSession` + `bolo --resume` 对 jsonl **主路径**绿  
3. 旧 `.json` **可读**  
4. full compact 与 transcript 策略写死并有测试  
5. **无遥测**；无 SQLite 依赖  
6. ROADMAP M5.1 更新为「JSONL transcript ✅（最小）」  

---

## 9. 与全局 ROADMAP 的关系

| 全局项 | 关系 |
|--------|------|
| M5.1 会话持久化 | 本 TODO = **升级版**（从快照 → HC 向 JSONL） |
| M5.2 CLI | `--list` / `--continue` 挂本专题 E |
| M3 Subagent | 侧链 jsonl = Phase G |
| M3 MCP | **无关**，可并行，不阻塞本规划 |
| M4 GUI | 会话列表 UI 消费 `listSessions` |

**并行建议：** MCP stdio（P0 扩展面）与本专题 **可两人/两刀并行**；若单线，按你偏好二选一。

---

## 10. 下一步（等人喊开工）

1. 确认 §7 决策默认是否 OK  
2. 开工 **Phase A + B（T1 双写）**  
3. 每完成一 Phase 勾选本文档并补测试  

---

**一句话：**  
不抄 HC 那几千行 `sessionStorage`，只对齐其 **JSONL 追加 + load/resume +（可选）lite 列表**；Bolo 路径与线性模型保持简单，旧 JSON 快照做兼容垫层，**明确不上 SQLite**。