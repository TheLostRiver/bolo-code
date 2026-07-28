# Bolo Code 路线图历史存档（只读）

> **本文件是存档**：收录已完成轨的详细切片记录、契约草案与验收细节，避免 [ROADMAP.md](./ROADMAP.md) 膨胀。
> **进度真源永远是 [ROADMAP.md](./ROADMAP.md) §0**；本文不再更新水位，只在新轨收口时追加存档。
> 各轨的**实现真源**是对应专题文档（HOOKS.md / COMPACTION.md / PROVIDERS.md / EFFORT.md / FILE_DIFF_SPEC.md / SESSIONS.md 等），本文仅保留当时的规划与落地契约记录。

---

## H1. 文件 Diff 轨 B（U0–U4 已收口 · 原 ROADMAP §3 详情）

### H1.1 对标

| HC (Ink) | Codex (ratatui) | Bolo U 轨应对 |
|----------|-----------------|---------------|
| `DiffDialog` + `useTurnDiffs` | history `new_patch_event` + pager | 可滚动会话/turn diff 面板 |
| `FileEditToolDiff` 权限内嵌 | apply_patch approval + 文件列表 | ask 内嵌 structured 预览（可滚） |
| `StructuredDiff` / 语法高亮 | `diff_render` 行号·折叠·语法 | 行级渲染器（先 ANSI 增强，后高亮） |
| `FileEditToolUpdatedMessage` | patch apply 历史 cell | 写后 transcript 风格 cell |
| `useDiffInIDE` | — | **后置 / 可选** |
| git merge-base / PR | — | **后置**（D5 已有 HEAD 级） |

### H1.2 架构（职责）

```text
packages/tools     已有：hunk / preview / ansi / git     （不变）
packages/core      已有：fileDiffLog / events / slash     （+ view-model 导出）
packages/cli/tui   新增：diffView · diffPane · 键位        （U 轨主战场）
apps/desktop       消费同一 DiffViewModel                 （U3）
```

**禁止：** 在 UI 里重算 diff 语义；只消费 `fileDiffLog` / `preview` / `meta` / git helper。

### H1.3 U1/U2 行为（验收）

```text
用户: /diff
  → TTY 全屏/半屏面板（非一次性 dump）
  → 文件列表 + 总 +N/−M
  → 选中文件显示 structuredPatch / 或提示 /diff git
  → q / Esc 回到 REPL
非 TTY: 纯文本 /diff

权限 ask（Edit/Write/apply_patch 且有 preview.files）:
  → 同一面板 mode=approve
  → jk 浏览 · Enter 看 hunk · y allow · a always · n/q deny
  → BOLO_PERM_DIFF_PANEL=0 回落文本 [y/a/N]
```

### H1.4 技术选型（当时决策）

| 方案 | 优点 | 缺点 | 建议 |
|------|------|------|------|
| **A. 自研 TTY pane**（readline/raw mode，类似 arrowPicker） | 无新依赖；与现 cli 一致 | 能力上限低于 Ink | **U1–U3 默认**（已采用） |
| B. 引入 React Ink | 对齐 HC 生态 | 依赖重 | U5 可选 |
| C. 只做 Desktop 面板 | 实现快 | CLI 用户无感 | 与 A 并行 U3 |
| D. 嵌 ratatui/Rust | 对齐 Codex | 双语构建复杂 | **不做** |

U 轨明确不做：遥测 / LOC counter · 必抄 HC `StructuredDiff` native 模块 · 必引入 ratatui · 把大 patch 写入模型 message。

---

## H2. Hooks 轨（H0–H5 已收口 · 原 ROADMAP §7 详情）

> 口径：日用 = 契约事件齐全 + 主路径接线 + exit 语义可依赖。对标 Codex `HOOK_EVENT_NAMES` 11 事件（原 10 + SessionEnd）。

### H2.1 落地水位

| 项 | 状态 |
|----|------|
| 原 10 事件名 + `runHooks` 挂点 | ✅ 已接线 |
| command + timeout/abort + 配置合并 + `/hooks` | ✅ |
| **SessionEnd** | ✅ **H0** — `endSession` / `runSessionEndHooks`；`/clear` · REPL 退出 · Desktop destroy |
| Stop / SubagentStop **exit 2 续跑** | ✅ **H1**（预算默认 3） |
| PostToolUse **exit 2 → 模型** | ✅ **H2**（并入 tool_result） |
| SubagentStart **stdout 注入子上下文** | ✅ **H3** |
| PreToolUse **updatedInput** | ✅ **H4**（schema 校验；失败忽略改写） |
| `/hooks recent` 诊断 | ✅ **H5**（ring · 无遥测） |
| trust / managed / TUI browser | 后置 |

### H2.2 H0 · SessionEnd 契约（当时草案，实现真源 HOOKS.md）

```ts
type SessionEndReason = 'clear' | 'logout' | 'prompt_input_exit' | 'other'

type SessionEndInput = HookBaseInput & {
  hook_event_name: 'SessionEnd'
  reason: SessionEndReason | string
  transcript_path?: string
}
// - exit 0：成功；stdout 默认可不展示
// - 其他：stderr 仅用户；不因 hook 失败阻止进程退出
// - 超时：短于普通 hook（默认 ~3s）；teardown 必须有 headroom
```

挂载点：`/clear`（clear）· CLI/Desktop 正常退出（prompt_input_exit/other）· 登出（logout）· resume 替换旧会话前。

### H2.3 H1–H2 exit 语义要点

```text
Stop exit 2        → 收集 continuation 文本 → 注入为对模型可见的续跑输入 → 再入 query（max 续跑次数）
SubagentStop exit 2 → 同类，作用域=子 loop，不抬升父权限
PostToolUse exit 2  → stderr 立即对模型可见（并入 tool_result），不默默吞掉
```

H 轨明确不做：遥测 · HC 全量 26 事件 · Codex hook trust / managed 企业层 · 真 Ink HooksConfigMenu · `type: http|prompt|agent`。

架构职责：`packages/shared` HOOK_EVENTS + 类型；`packages/hooks` runHooks/matcher/归约；`packages/core` 挂载点；Desktop 关闭走同一 `endSession`。禁止 tool 内私自跑 hook、结束路径绕过 SessionEnd。

---

## H3. Compact 轨（C0–C5 已收口 · 原 ROADMAP §8 详情）

> 口径：日用 = 摘要真管道 + 阈值/熔断可依赖 + keep + usage/mid-turn 触发 + 压后不丢关键段。
> 对标：HC `compactConversation` + auto/snip/micro/PTL；Codex 仅借「阈值与 mid-turn 意图」，不抄 remote。
> **实现真源：[COMPACTION.md](./COMPACTION.md)**。

### H3.1 落地水位

| 项 | 状态 |
|----|------|
| Full compact + Pre/Post hooks + 禁止 slice 冒充 | ✅ |
| Auto 阈值（chars 启发）+ 熔断 + env + `/autocompact` | ✅ |
| Snip 最小 + micro content-clear + prepare 链 | ✅ |
| PTL 截断重试（loop + summarizer 副本） | ✅ |
| jsonl `compact_boundary` + resume R1 | ✅ |
| messagesToKeep 按 user 轮次 / token | ✅ **C1** — `splitMessagesForCompactKeep` |
| auto 阈值接 session usage | ✅ **C2** — `usageInputTokens` / `getUsageInputTokens` |
| 工具环中途接近阈值再 full 一次 | ✅ **C3** — `tryMidTurnCompact` · 每 outer turn ≤1 |
| post-compact 最小再注入（技能 catalog） | ✅ **C4** — `postCompactReinjection`（可关） |
| `/context` 来源与策略 | ✅ **C5** — pressure source · keep · last compact |

### H3.2 C 轨验收（当时完成定义）

1. Full compact 默认按 user 轮次保留尾部（可配）；禁止无摘要只 keep
2. Auto 阈值优先最近 API usage，否则回落 `estimateTokens`
3. 主 loop 在 tool 批之后、下一 callModel 前可再判一次 auto（mid-turn 最小，有预算）
4. compact 成功后可选再注入短 skill catalog（不灌全文、不拆 cache-stable 前缀）
5. `/context` 展示阈值来源、keep 策略、上次 compact 摘要长度
6. 失败不毁 messages；无遥测
7. `docs/COMPACTION.md` 为真源

### H3.3 C1 keep 契约（草案存档）

```ts
type KeepTailOptions = {
  keepRecentUserTurns?: number   // 保留最近 N 个 user turn；默认建议 2–4
  keepMaxTokens?: number         // 可选 keep 段 token 上限
}
function splitMessagesForCompactKeep(messages, opts?): { toSummarize; messagesToKeep }
// 切点须在 user 边界，不拆 tool_use/tool_result 对
```

### H3.4 C2 usage 阈值 / C3 mid-turn / C4 再注入（草案存档）

```ts
shouldAutoCompact({ tokenCount, usageInputTokens?, contextWindowTokens, enabled, consecutiveFailures, querySource, env? })
// 有效计数 = usageInputTokens ?? tokenCount（AR2A0a 起升级为 usage 锚定 + 尾部增量估算）
```

```text
C3: queryLoop tool drain 后，auto on && shouldAutoCompact && !compactedThisTurn → compactSession(auto) 一次；与 turn 初 prepare 共用熔断
C4: compact 成功且非 override system 时可选刷新短 skill catalog 段（replaceSkillCatalogSection）；开关 postCompactReinjection
```

架构职责：`packages/compact` 纯（keep 切分 · 阈值 · pressure · full/snip/micro/PTL）；`packages/core` 挂 prepare 链 · compactSession · mid 判 · 再注入；CLI `/context` `/compact`。禁止 core 内 `slice(-N)` 冒充 full、无 summarizer silent truncate、遥测。

测试：`test-compact` / `test-compact-c-track`（keep·usage·mid·reinject·/context）；回归 `test-auto-compact` · `test-ptl-retry` · `test-snip` · `test-microcompact` · `test-context-slash`。

---

## H4. Provider 轨（P0–P4.1 + CX7 已收口 · 原 ROADMAP §9 详情）

> 痛点（已解）：曾只有单个 `config.provider`；现已支持 `providers` 表 + 运行中热切。
> **配置/协议真源：[PROVIDERS.md](./PROVIDERS.md) · [CONFIG.md](./CONFIG.md)**。

### H4.1 落地水位

| 项 | 状态 |
|----|------|
| 单 `provider.kind` + env 推断 | ✅ |
| 协议：openai-compatible / openai-responses / anthropic / mock | ✅ |
| `/model` · provider-qualified 糖 | ✅ |
| `/effort` · `/thinking` · `/ultrathink` | ✅ |
| 多 provider 配置表 | ✅ `providers` + `defaultProvider` |
| 运行时切换 | ✅ `switchSessionProvider` · `/provider use` · TTY picker |
| 缺 key 拒绝切换 + 可行动错误 | ✅ CX3 |
| resume `providerId` + effort clamp | ✅ CX6 |
| Desktop 多后端 | ✅ CX7（原 P5） |

### H4.2 切片记录

| 阶段 | 交付 | 状态 |
|------|------|------|
| P0 | 规格 + 兼容矩阵 | ✅ |
| P1 | `providers` + `defaultProvider` 加载；旧 `provider` 兼容；Registry 类型 | ✅ |
| P2 | `switchSessionProvider` + 重挂 deps；`/provider` list/use | ✅ |
| P3 | `/model` 增强 + cache break + `/doctor` 显示 active | ✅ |
| P4 | CLI 启动摘要 · 缺 key 错误 · 单测 | ✅ |
| P4.1 | TTY `/provider` 箭头选择器 | ✅ |
| P5 | Desktop 设置选 provider | ✅ 并入 CX7 |

### H4.3 合并规则与交叉（存档）

1. 仅 `provider` → 合成 `providers = { default }`；仅 `providers` → 用 `defaultProvider` 或 keys[0]；两者都有 → `providers` 为主
2. env `BOLO_PROVIDER` / keys 启动时覆盖 active；热切后以会话选择为准
3. 热切不自动 compact；切换 kind/base/model → cache-break；subagent 默认继承父 active provider；compact summarizer 随 `session.provider` 重绑；resume 快照存 `providerId`

明确不做：遥测/用量上报 · 官方市场拉模型 · 扫描全网 key · 自动 failover 重试同一 turn · apiKey 写入 transcript。

---

## H5. Effort 轨（E0–E9 已收口 · 原 ROADMAP §10 详情）

> 原则：用户意图字符串 → dialect 表折叠 → 有限 wire shape 打进 body。禁止每品牌永久 TS 适配器。
> **契约真源：[EFFORT.md](./EFFORT.md) · [EFFORT_OPTIMIZATION.md](./EFFORT_OPTIMIZATION.md)**。

| 阶段 | 交付 | 状态 |
|------|------|------|
| E0 | 规格 | ✅ |
| E1 | `resolveEffortWire` · body patch · 纯函数单测 | ✅ |
| E2 | builtin `deepseek-chat` + compatible 接线；`/effort` 超集与预览 | ✅ |
| E3 | builtin `openai-responses` → `reasoning.effort` | ✅ |
| E4 | `providers.*.effort.dialect` 配置 / 内联 | ✅ |
| E5 | anthropic-output：`output_config.effort` + beta · detect · 单测 | ✅ |
| E6 | EffortCapabilityView · strict choosable | ✅ |
| E7 | Anthropic max 轻门控 | ✅ |
| E8 | TTY `/effort` 箭头选择器 | ✅ |
| E9 | doctor 一行 + 文档水位 | ✅ |

后置：adaptive thinking 联动 · pro mode · Desktop · OAI 按模型裁档（归 AR4 证据门控）。

---

## H6. Durable Runtime DR0–DR4 已落地契约（原 ROADMAP §13.4 详情块）

> DR 轨阶段表与总体验收保留在 ROADMAP §13；以下是各切片收口时记录的落地契约细节。

### DR2A

- 默认 `SessionCoordinator` 是进程级 runtime domain，按稳定 `sessionId` 分槽；两个 `BoloSession` 对象只要 id 相同也共享 ownership。
- `tryAcquire` 在 `submitPrompt` 第一个 `await` 前同步完成；忙碌时返回 `session runner busy`，不运行 hook/provider/tool，不 admission，不修改 messages，也不覆盖 active phase。
- lease 用不可伪造 token 释放且 `release()` 幂等；normal、hook blocked、provider error、abort、durable admission failure 均由最外层 `finally` 回收。
- 不同 session 使用独立 slot，可真正并行；这不是全局串行锁。
- DR2A 只承诺单进程 ownership。跨进程/daemon 锁、queue/steer/interrupt、active abort controller 归 DR2B–DR4。
- 默认 `npm test` 已纳入 `test-session-coordinator`。

### DR2B1

- `steer` / `interrupt` 必须携带 `expectedTurnId`，并与当前 active owner 精确一致；无 active、缺 expected、stale expected 均稳定拒绝。
- `controlId` 是幂等键：同 payload 重试返回原记录且不重复入队；同 id 不同 payload 返回 `control_id_conflict`。
- control 状态为 `pending | ready | promoted | cancelled`；快照只暴露纯数据，不泄漏 AbortController。
- `queue` 在 active turn 期间保持 pending，owner release 的 terminal boundary 后才 ready；session idle 时只能 FIFO `takeNextQueued`，取出即 promoted。
- pending/ready queue 可取消；未 promotion 的 steer 在 owner release 时 cancelled，绝不悄悄变成后续 turn。
- interrupt 通过 owner-local signal 标记 `interrupt_signal`；DR2B2 才把该 signal 与现有 turn AbortSignal 合并并接入 queryLoop。
- 默认 `npm test` 已纳入 `test-session-controls`。

### DR2B2

- `submitPrompt` 合并 caller AbortSignal 与 runner lease signal，并在 terminal finally 移除 listener、释放 ownership。
- `queryLoop` 通过 async safe-boundary callback 消费 coordinator 已 promotion 的 controls；callback 本身不得直接修改 messages。
- steer 只在 `before_provider`、`after_tools`、`after_compact`、`before_stop` 进入消息链；`after_provider` / `before_tools` 只观测，禁止拆开 assistant tool_calls 与 tool results。
- final assistant 后若在 `before_stop` promotion steer，则跳过 Stop/terminal，继续同一 durable turn 的下一次 provider call。
- coordinator interrupt 会沿合并后的 signal 终止 provider/tool/permission 链，并归约成 `aborted` terminal。
- 所有 terminal 路径经过 `turn_terminal` boundary；maxTurns 无剩余预算时不 promotion 新 steer。
- 默认 `npm test` 已纳入 `test-session-safe-boundary`。

### DR2B3

- `AskPermissionFn` 接收 core 合并后的 turn/runner signal；即使自定义 UI 不监听 signal，core 也会用 abort race 按 deny 收口，interrupt 不会把 runner 永久挂在 ask。
- permission 决策返回或被取消后访问 `after_permission`；带结构化文件 preview 时再访问 `after_diff_approval`。两者只观察 coordinator，不 promotion steer。
- `/turn status|steer|interrupt|queue|cancel` 直接消费 core coordinator；expected active turn、幂等与状态转换仍只由 core 判断。
- CLI REPL 在询问下一次人工输入前 FIFO 取得一条 ready queue；取出即 promoted，绝不重放。
- Ctrl-C 优先针对 snapshot 中的真实 active turn 提交 interrupt intent。
- 默认 `npm test` 已纳入 `test-session-permission-boundary` 与 `test-turn-cli`。

### DR2C1

- transcript 新增并列 `control` entry，记录 control/session/turn refs、kind/state、prompt/querySource、boundary、timestamp/detail；不保存 signal、controller 或其它进程句柄。
- `projectDurableControls` 按 controlId last-wins：重启时 `pending/ready` 只投影为带 `interruptedFrom` 的 diagnostic `interrupted`，不会自动重新入队；`promoted/cancelled` 保留为已发生事实。
- parser 对坏行/未知状态 fail-closed；旧 transcript 无 control 时保持可读。
- compact/shrink rewrite 保留完整 control lifecycle，与 turn/title/note/file_diff 一样不进入模型 messages。
- 默认 `npm test` 已纳入 `test-session-control-recovery`。

### DR2C2

- `appendSessionControlState` 与 session-level runtime wrappers 覆盖产品 request、cancel、safe-boundary promotion、CLI queue take、Ctrl-C interrupt 与 runner release。
- accepted queue/steer 必须先写 transcript 才返回；写失败立即 fail-closed cancelled，不会进入消息或执行队列。
- interrupt signal 已应用但落盘失败时不会伪装成拒绝；调用方收到明确 persistence warning，runner 仍沿 abort 链退出。
- promotion/take 只有 durable state 写成功才把 steer/prompt 交给消息链或 CLI 执行。
- lease `releaseWithBarrier` 在 terminal transitions 落盘期间保持 session busy，并拒绝新 control 为 `turn_releasing`；未审计 ready queue 会转为 cancelled。
- `BoloSession.durableControls` 在 resume 时由 transcript 恢复；pending/ready 仍只变为 interrupted diagnostic。
- 默认 `npm test` 已纳入 `test-session-control-persistence`。

### DR2C3

- 同一 transcript 的 append、首次 meta ensure、message batch 与 compact/shrink rewrite 共享按绝对路径串行的进程内 write barrier；不同 session 文件不互相阻塞。
- barrier 前一写失败不会毒化后续队列；所有路径在 finally 解锁。
- rewrite 在读取旧 lifecycle 到原子 rename 的完整窗口持有 barrier，期间到达的 control append 会等待并在 rewrite 后追加。
- 截断 JSONL 尾行与未知/冲突 duplicate 行继续 fail-closed 跳过；已确认的 pending/ready 恢复为 interrupted，不自动重放。
- `test-session-control-crash` 覆盖 append-vs-rewrite 竞态、32 路并发追加、单次 EIO 恢复、截断尾行与冲突 controlId。
- 该 barrier 是单进程文件写正确性，不冒充跨进程锁。

### DR3A

- transcript 新增并列 `task` lifecycle 与 `task_result` entry；`taskId` 使用 background `agentId`，与父 `turnId` 分离，并通过可选 `parentTurnId` 建立关联。
- createSession 为 background store 绑定 session-level durable lifecycle：worker 启动前先顺序写 `admitted → running`；完成时先写 `task_result`，再写 terminal。
- completed/error/aborted 没有先行 result 时，投影 fail-closed 跳过 terminal；result 或 terminal 写失败时绝不伪造成功。
- resume 投影 `session.durableTasks`，把 admitted/running 保守恢复为带 `interruptedFrom` 的 interrupted；`/bg` 可区分状态但不会重启 worker。
- background Promise 不再异步 `messages.push(system)`；durable result 只进入 transcript/store。父消息 promotion 留给 DR3B safe boundary。
- compact/shrink rewrite 保留 task/result entries；旧 transcript 无 task 时继续可读。

### DR3B

- `agents.overflow: "queue"` 在 cap 满时真正建立 FIFO：先 durable `admitted` 并显示 QUEUED，取得 slot 时同步保留 ownership、durable 写 `running`，成功后才启动 worker。
- 可执行 start closure 与 drain barrier 只存在于 store 的 WeakMap runtime；resume 把 admitted/running 恢复 interrupted，绝不重建 queue 或自动执行。
- 每个 terminal 都在 finally pump queue；单 store drain barrier 与 slot reservation 防止并发完成超 cap，也关闭 cancel-vs-start 竞态。
- `/bg status` 展示全状态；`/bg cancel <taskId>` 只取消 queued。取消先从 executable FIFO 移除，再写 result→aborted。
- durable terminal 成功后 background worker 只把 task id 放入 delivery FIFO；queryLoop 作为唯一消息 owner 在安全边界推送 `<background_task_result>` user message。
- result 在父 turn terminal 后完成时等待下一 turn `before_provider`；同进程 delivery 只消费一次；重启后仅 `/bg` 诊断。

### DR4A

- `packages/shared` 提供 runtime protocol v1 的纯 JSON 类型、常量、hello/feature negotiation 与 snapshot/command/result parser；协议不绑定传输层。
- snapshot 统一 `session + runner + turns + controls + tasks` view-model；builder 只读取 durable records、coordinator public snapshot 与 background 纯数据 entry；运行时对象不跨边界。
- durable 与 live 状态按 id 合并；候选 snapshot 会再次经过 shared parser 自校验。
- 未知字段忽略并规范化返回；未知 protocolVersion、kind/action、生命周期枚举、跨 session 记录、重复实体 id 均 fail-closed。
- 初始 v1 command 只定义 `runtime.inspect | turn.interrupt | control.cancel | task.cancel`。

### DR4B1

- `executeRuntimeCommand` 是 transport-neutral executor：先构建 v1 snapshot 核对 session/target/expectedState，再复用 durable control/cancel API。
- `requestId` 直接作为 interrupt control 的幂等 id；不同 payload 冲突稳定返回 `state_conflict`。
- action 已生效但持久化或后置 snapshot 有问题时返回 `ok: true + warnings`。
- `/runtime list|json|inspect` 只消费 protocol snapshot；`/runtime interrupt|cancel` 只构造/执行 protocol command。
- target 消失、expectedState 变化、竞态都 fail-closed；不 replay interrupted work。

### DR4B2

- transcript 新增 append-only `resolution` entry；`discard` 只记录人工确认，不删除历史。resume、parser 与 compact rewrite 都保留 resolution。
- runtime v1 新增 `runtime.discard | runtime.retry-safe`、nested resolution view 与 `not_retry_safe`；target 必须显式携带 `expectedState=interrupted`。
- retry-safe 只接受 `interruptedFrom=admitted` 且保留 prompt 的 turn，或原状态为 pending/ready 的 queue control；绝不自动 replay。
- retry-safe 以 requestId 稳定派生新的 control/turn，写 replacement admitted 后进入 ready FIFO；原 ID 永不复活。
- 同 requestId/payload 幂等；queue 已接受而 resolution 后写失败时 result 保持 accepted + warning。

### DR4C

- 默认门禁新增 `test-runtime-closeout`：真实 crash → resume → `/runtime retry-safe` → CLI FIFO drain → `runOnePrompt` 单次执行 → 再次 resume 端到端回归；provider 只调用一次。
- retry-safe 后若尚未消费就再次重启，replacement 只恢复为 interrupted 诊断；coordinator queue 为空。
- new 与 resume 的 `/runtime json|inspect` 都经同一个 core protocol projection；旧 v1 snapshot 仍可解析。
- transcript resolution 只在引用合法可投影实体时恢复；orphan/跨 session/kind mismatch fail-closed 跳过。
- 没有第二客户端需求，因此没有引入 SQLite、daemon、app-server 或 RPC。

---

## H7. AR1 · CLI/TUI runtime UX 已落地详情（原 ROADMAP §13.10.1）

### H7.1 切片记录

| 切片 | packages-first 契约 | 人类可见结果 | 状态 |
|------|---------------------|--------------|------|
| **AR1A · query** | `RuntimeSnapshot → runtime.list/runtime.inspect` 纯 view-model；CLI 独立 consumer | `bolo runtime list|inspect … --resume/--continue [--json]`；不显示 banner/summary | ✅ `4c3db76` |
| **AR1B1 · action discovery** | 只由 snapshot/target/state 推导 `availableActions`，每个动作携带 expected state | inspect/list 告诉用户"现在可安全做什么" | ✅ `673df59` |
| **AR1B2 · queue remove/edit** | remove 复用 durable cancel；edit = cancel 旧 + append 新（新 ID、旧历史保留） | `/runtime edit\|remove` 替换/删除尚未开始的 live queue | ✅ `3643530` |
| **AR1B3 · command closeout** | query/command 共享稳定 result/error envelope | text/JSON 区分 usage、rejected、accepted-with-warning | ✅ `9f9a9f8` |
| **AR1C1 · text/pager** | renderer 输入仅为 AR1 view-model；分页状态不进入 core/session | 大列表分页；窄屏、NO_COLOR、非 TTY 不挂起 | ✅ `89309e6`/`136ac2e`/`30ea8ea` |
| **AR1C2 · automation closeout** | JSON schema/排序/错误码稳定 | 脚本无需清洗 ANSI/banner；help/USAGE 完整 | ✅ `d26aef4`/`58e0d66` |

### H7.2 AR1C 落地契约

- 纯 renderer 位于 `packages/core/src/runtimeTextView.ts`，CLI 与 `/runtime list` 共用 `RuntimeQueryView → RuntimeTextPage`。
- pager 位于 `packages/cli/src/tui/runtimePager.ts`；page 只存在当前调用栈，只有 text + stdin/stdout 双 TTY + 多页才读键。`n/j/↓/→` 与 `p/k/↑/←` 翻页，`q/Esc/EOF` 正常退出，`Ctrl-C` exit 130，所有终态恢复 raw mode。
- pipe 与 `--json` 永不读 stdin，一次性输出且不带 ANSI/banner；JSON success 保持原始 query view，failure 固定为 `{ok:false,code,detail}`，usage failure exit 2。
- 默认 `npm test` 已纳入 runtime query/action/queue/command、renderer、pager、automation 全部专项。

### H7.3 AR1B2 落地契约

- protocol v1 additive 增加 `commands.replace` / `control.replace`。target 必须携带 `controlId + expectedState=pending|ready`，replacement 必须提供非空 prompt。
- `availableActions` 只为 pending/ready queue 显示 `control.replace`（`requiredInput=["prompt"]`）；promoted/interrupted/terminal 不显示 edit。
- edit 先 append-only cancel 旧 control，再以 requestId 稳定派生新 control/turn 并追加到 FIFO 尾部；旧 prompt/history 保留。
- 完整成功后同 requestId 返回同一 replacement；cancel 已生效但新 admission 失败时保持 `ok:true + warnings` 且不返回 replacement。
- 默认 `npm test` 已纳入 `test-runtime-queue-edit`。

### H7.4 AR1B3 落地契约

- 顶层 CLI additive 支持 `bolo runtime discard|retry-safe <turn|control|task> <id> --resume <session>|--continue [--json]`。
- query 与 command 都在 provider/banner/summary 之前分流；JSON 成功/拒绝/load failure 均保持 stdout 单 payload。
- command JSON 直接使用 protocol `runtime.result`；accepted exit 0，rejected exit 1，usage exit 2。
- CLI 默认按 `sessionId/action/entity/entityId` 稳定派生 requestId，支持 `--request-id` 覆盖。
- 顶层 retry-safe 只 durable-admit queue，不调用 provider；result 必带 consumer warning。
- `test-runtime-cli-command` 覆盖全矩阵与真实 bin exit 0/1/2。

### H7.5 AR1C 明确非目标（存档）

- 不把 page、filter、cursor、terminal columns 写入 session、snapshot、protocol 或 JSONL。
- 不为 pager 引入 Ink/React/ratatui；若现有 TypeScript primitive 无法通过验收，按 AR4 独立举证。
- 不改变 interrupted 默认只诊断、不 replay 的语义。
- 不让 JSON/pipe 路径输出 ANSI、clear-screen、banner、provider warning 或人类摘要。

---

## H8. OI-08B · CLI 零步骤首次启动

- 普通 `bolo` 自动 materialize 用户级 `~/.bolo`，项目 `.bolo/` 始终只读发现；缺少项目
  配置是正常状态，search/status/list 等只读路径不创建目录。
- 新会话默认写入
  `~/.bolo/sessions/workspaces/<SHA-256(canonical-cwd)[0:32]>/`；超长 tool-result spill
  与默认 subagent 侧链使用同一 workspace 分桶，不再自动污染仓库。
- `listWorkspaceSessions` 与纯 id resume 按 workspace → legacy project → legacy user
  发现；旧路径不迁移、不覆盖，显式 filePath 继续原位续写。
- `bolo init [--project] [--cwd <dir>]` 与 `bolo init --user` 提供幂等、不覆盖的显式
  脚手架；`init` 在 prompt parser 前分发，会话内 `/init project` 保留。
- `test-cli-first-run` 覆盖真实 CLI 子进程、fresh cwd 零项目副作用、existing `.bolo`
  读取、旧 session 兼容、无效用户目录失败、显式 init 幂等、subagent 与 tool spill
  路径。代码批 `22c0d0c` 已通过 112 项完整门禁。

---

## H9. OI-09 · CLI TUI 交互重构

- 一次性欢迎区压缩为 product/workspace/model/session 三行内的信息面板；删除内部
  `ink-equiv` 名称、巨型 ASCII logo 和伪 `bolo>` 输入提示。
- `packages/cli/src/tui/inputBox.ts` 提供 grapheme 光标、历史、多行、编辑键、
  四行 viewport 与短生命周期 raw-mode driver；turn 开始前释放 stdin，权限/picker
  继续独占原有边界。
- `terminalText.ts` 统一 ANSI/CJK/emoji/国旗/keycap cell 宽度；Tab 归一为空格并过滤
  其它 C0/C1，窄终端不会破框。
- `runOnePrompt()` 在调用 provider 前立即回显用户消息并启动 activity；`phase`、
  tool、web search、retry、warning 驱动 `Thinking/Running/elapsed`，assistant 使用
  角色头和流式 inline Markdown。
- 动态路径只在 stdin/stdout 双 TTY + raw mode 启用；非 TTY、pipe、`-p`/`--print`
  与 JSON 保持追加式输出。`NO_COLOR` 不再从旧 tool formatter 泄露 SGR。
- `test:cli-tui` 同时注册独立入口和默认门禁，覆盖首 token 人工 gate、raw cleanup、
  宽窄输入、activity 单行、warning 恢复、NO_COLOR 与 plain fallback。代码批
  `843f593` 通过 CLI 兼容轨、typecheck 与 113 脚本完整 `npm test`；`1413da3`
  进一步让 `tool_progress` 只原位更新 activity，避免每个 tick 污染永久时间线。
- 真实 Windows Terminal 观感、光标/resize/组合键和长滚动仍为 OI-H3 人工项；未用
  静态快照或被禁止的终端 UI 自动化冒充真人验收。

### H9.1 品牌欢迎页与活动行稳定性

- `10879ec` 把三行身份面板升级为原创 Bolot 品牌欢迎页：`>=96` 列使用
  mascot/environment 与 action/session 双栏，`56–95` 列使用完整单栏，`38–55`
  列使用一行 Bolot 紧凑框，极窄或显式 plain 回落纯文本。
- 欢迎页沿用 input 的青色强调/灰色边框，`NO_COLOR` 只移除 SGR，`BOLO_MASCOT=0`
  只隐藏形象；new/resume 分别显示 `Welcome to Bolo Code` / `Welcome back.`。
- activity 删除 90ms Braille spinner 和 erase-then-draw 两次 write，改为固定 `✦`、
  250ms elapsed 刷新与 `\r + line + erase-to-end` 单次原位写入，消除周期性空白帧。
- `test:cli-tui` 新增 Bolot、双栏、三档宽度、NO_COLOR、固定符号和原子 writer 断言；
  113 脚本完整门禁、dist install、Desktop bundle 与 Electron launch 全部通过。
- OI-H3 仍保留真实 Windows Terminal 字体/颜色、raw 输入、光标、resize 和长滚动验收；
  Codex PTY smoke 只证明源码入口已接入欢迎页，不替代真人终端检查。

---

## H10. OI-10 · CLI 命令发现与 TUI 一致性

- `packages/core/src/slash.ts` 统一投影内置命令、Plugin command 与
  user-invocable Skill；CLI 只在该目录上追加 `/exit`、`/quit` 等本地候选，不复制
  扩展发现逻辑。
- raw input reducer 在输入 `/` 时展示全量目录，继续输入后执行精确/前缀过滤；
  `↑/↓` 导航、Tab/Enter 补全、Esc 关闭，空匹配与 hidden alias 都有显式契约。
- 欢迎区、输入框和已提交用户消息在 OI-10 阶段共用 frame width；activity 使用
  确定性多帧 glyph 和单次原位写入，既保留动画，也不制造先擦后绘的空白帧。
- 代码批 `67421bb` 通过 `test:slash-completion`、扩展后的 `test:cli-tui`、typecheck、
  114 个串联脚本与 dist smoke。后续 OI-11 将 composer 从共享 content frame
  分离为全宽 dock，并替换欢迎页身份；本节保留 OI-10 收口时的事实。
- 真人 Windows Terminal 的字体、光标、resize 与按键观感继续由 OI-H3 承接。

---

## H11. OI-11 · CLI TUI 持久终端表面与可审计权限交互

| 切片 | 代码批 | 已关闭行为 |
|------|--------|------------|
| OI-11F · Responses abort diagnosis | `e9a32cf` | provider deadline 与 parent/user abort 分源；timeout 带安全 endpoint、时长和可行动说明，非流式请求使用同一 deadline |
| OI-11A · terminal surface | `59acdf6` | append-only 历史与临时 dock 分离；Thinking/Running 期间 composer 常驻并使用终端可用宽度 |
| OI-11B · timeline/status | `b0feb0c` | Agent gutter、灰色用户消息块、model/mode/快捷键 footer 与 real/estimated token usage |
| OI-11C · segment activity | `4fc3791` | reasoning/tool/search/retry 分段计时；活动段持续动画，结束后留下 `Thought for <duration>` |
| OI-11D · permission chooser | `da0533c` | Bash 展示 command、cwd、前后台和 timeout；once/always/deny 三态选择并明示会话级作用域 |
| OI-11E · viewport stability | `b0fbb86` | arrow/diff/question/permission 面板只擦除自己拥有的行，不再发送嵌入式整屏 `ESC[2J` |
| OI-11G · crystal identity | `8088fbb` | 使用 `bolo-logo-tui.txt` 的宽/中/紧凑水晶；支持 ASCII、NO_COLOR、mascot-off，单文件 dist 内嵌资产 |

- OI-11H 将 README、TUI、USAGE、BRAND、RELEASE、ROADMAP、OPEN_ISSUES 与 handoff
  统一到上述行为；默认 agent 可闭环队列在本轨收口后为空。
- 七个专项均进入默认门禁；2026-07-28 完整 `npm.cmd test` 通过 121 个串联脚本，
  npm pack/install、单文件 dist、Desktop bundle/launch 全绿，根 `dependencies`
  保持 `{}`。
- 自动化证明 reducer、renderer、provider 分类、VT 序列和分发产物，不替代真人
  Windows Terminal 的字体/颜色、实际光标、resize、组合键、权限切换与长回答滚动；
  唯一剩余边界继续记录为 OI-H3。

---

## H12. OI-12 · CLI TUI 信息架构与多行输入稳定性

| 切片 | 代码批 | 已关闭行为 |
|------|--------|------------|
| OI-12A · argument hints | `1696127` | 精确 slash 命令后的首个尾随空格仍显示 provider/model 真源参数提示 |
| OI-12B · context dashboard | `15b37ed` | core view-model 驱动 TTY 使用率概览与 plain/details 回落 |
| OI-12C · content gutter | `40a5d41` | Agent、thinking、tool 与 slash 正文共享响应式留白，不再贴左墙 |
| OI-12D · full-width user block | `8d2a7a5` | 已提交用户块与 composer 使用同一 dock width |
| OI-12E · paste transaction | `7f76093` | bracketed paste 跨 chunk 聚合，CRLF/CR 不会中途 submit 或反复滚屏 |

- OI-12F 同步 README、TUI、USAGE、ROADMAP、OPEN_ISSUES、handoff 与 release。
- 123 项完整门禁、pack/install、Desktop bundle/launch 全绿，根 `dependencies` 保持
  `{}`；真人 Windows Terminal 的字体、颜色、resize 与按键观感继续交由 OI-H3。

---

## H13. OI-13 · CLI TUI 垂直节奏与水晶工作台

| 切片 | 代码批 | 已关闭行为 |
|------|--------|------------|
| OI-13A · silent thought completion | `fe2d39a` | provider 不发送 reasoning delta、直接进入正文时，已结束 thinking segment 仍输出一次 `Thought for <duration>` |
| OI-13B · surface breathing row | `bf25077` | history/activity 与常驻 composer 之间的空行由 `TerminalSurface` 所有，参与同一 cursor/erase/repaint 契约 |
| OI-13C · crystal workbench | `4c4fb08` | welcome 最大 100 cells；宽屏水晶/状态 split，中/紧凑 single，ASCII/NO_COLOR/mascot-off 与 CJK/emoji 安全回落 |

- OI-13D 同步 README、TUI、USAGE、ROADMAP、OPEN_ISSUES、handoff 与 release。
- 每刀先建失败测试，再运行专项、typecheck 和完整 `npm.cmd test`；三批均验证
  dist build、真实 pack/install、Desktop bundle 与 Electron launch，根
  `dependencies` 保持 `{}`。
- 自动化不替代 OI-H3：真实 Windows Terminal 的字体、颜色、动画流畅度、光标、
  鼠标/剪贴板粘贴、resize、组合键和长回答滚动仍需真人走查。
