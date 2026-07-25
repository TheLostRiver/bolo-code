# Bolo Code 整体路线图

> **原则：** 日用主路径已收口 ≠ 相对 HC/Codex UI 密度 100%。无 stub 冒充完成。  
> **永不：** 遥测 · Claude/Codex **官方市场 API**。

---

## 0. 一句话进度

| 层 | 粗估 | 说明 |
|----|------|------|
| **Headless 核心** | **~80–88%** | loop/STE/权限/auto/snip/policy/OS sandbox |
| 会话与 CLI | **~80–88%** | JSONL · resume · slash |
| **扩展面** | **~80–88%** | MCP×3 · Skills · Plugins · WebFetch · OAuth 本地 |
| **Subagent** | **~85–92%** | 见 SUBAGENT / SUBAGENT_SPEC v0 |
| **Rules / Creators** | **~75–85%** | 日用齐 |
| **成本与缓存** | **~94–97%** | /cost 日用近满 |
| **文件 Diff · 日用契约** | **~95%+** | **D0–D7 已收口**；见 [FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) |
| **文件 Diff · 交互 UI** | **~90–95%** | **U0–U4 已落地**（VM · 面板 · 审批 · cell · 行号/主题/轻量语法）；U5 真·Ink/IDE 可选 |
| **斜杠** | **~80–88%** | 日用 + polish |
| **CLI TUI（壳）** | **~70–80%** | 文本框布局/picker/主题；**非**真 React Ink |
| **Electron GUI** | **~55–65%** | 壳 + 流式 + 权限 + 设置 |
| **Hooks · 日用契约** | **~96–98%** | **H0–H5 已落地**（SessionEnd · exit 语义 · updatedInput · `/hooks recent`）；trust/UI 菜单后置 |
| **Compact · 日用管道** | **~92–95%** | **C0–C5 已落地**（keep 轮次 · usage 阈值 · mid-turn · 再注入 · /context 诊断） |
| **产品整体（相对 HC）** | **~70–85%** | 日用高；UI 全家桶另计 |

**主线已闭环：** headless 日用 → FULL → M4 → sandbox/OAuth/settings → **Diff D0–D7** · **U0–U4** · **Hooks H0–H5**。

**开放轨（下一刀）：**  
U5 可选真·Ink/IDE · Hooks trust/managed · Compact partial/remote（后置，见 §8.9）。

---

## 1. 双轨模型（务必分清）

```text
轨 A · 日用契约（已完成 ~95%+）
  textDiff · meta · preview · fileDiffLog · /diff · git · resume · ANSI 摘要
  → 模型链干净；CLI/Desktop 能看懂改了啥

轨 B · 交互 UI 密度（规划 · 目标日用 UI ~90%+ / 全家桶不设 100%）
  可滚动 Diff 面板 · 权限内嵌 structured 预览 · 写后历史 cell
  → 对齐 HC DiffDialog / FileEditToolDiff · Codex diff_render 语义
  → 技术选型：优先「无重依赖」终端组件；可选真 Ink；Desktop 面板
```

| | 轨 A 日用 | 轨 B UI |
|--|-----------|---------|
| 目标 | 工作流正确、可查、可 resume | 浏览体验接近 HC/Codex |
| 现状 | D0–D7 ✅ | **U0–U4 ✅**；U5 真·Ink / IDE 可选 |
| 对标 | HC 工具结果 + Codex patch 摘要 | HC Ink 组件 + Codex ratatui |
| 不做 | — | 遥测 · 官方市场 · 必抄 React/Rust |

---

## 2. 文件 Diff · 轨 A（已完成）

| 阶段 | 交付 | 状态 |
|------|------|------|
| D0–D2 | textDiff · Edit/Write/apply_patch meta · fileDiffLog · `/diff` | ✅ |
| D3–D4 | 写前 preview · tool_end ANSI | ✅ |
| D5–D6 | git · transcript `file_diff` resume | ✅ |
| D7 | `createDiffSummary` · 默认短 unified · 更密 ask | ✅ |

详情：[FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) §0–§6。

---

## 3. 文件 Diff · 轨 B（Ink / ratatui 语义 · **规划**）

> **命名：** 文档称「Ink/ratatui 全家桶」= **对标体验**，不是必须引入 `ink` 或 `ratatui` crate。  
> Bolo 默认路径：**TypeScript 终端组件 + 复用 D 轨契约**；Desktop 共用同一 view-model。

### 3.1 对标什么

| HC (Ink) | Codex (ratatui) | Bolo U 轨应对 |
|----------|-----------------|---------------|
| `DiffDialog` + `useTurnDiffs` | history `new_patch_event` + pager | 可滚动会话/turn diff 面板 |
| `FileEditToolDiff` 权限内嵌 | apply_patch approval + 文件列表 | ask 内嵌 structured 预览（可滚） |
| `StructuredDiff` / 语法高亮 | `diff_render` 行号·折叠·语法 | 行级渲染器（先 ANSI 增强，后高亮） |
| `FileEditToolUpdatedMessage` | patch apply 历史 cell | 写后 transcript 风格 cell |
| `useDiffInIDE` | — | **后置 / 可选** |
| git merge-base / PR | — | **后置**（D5 已有 HEAD 级） |

### 3.2 架构（职责）

```text
packages/tools     已有：hunk / preview / ansi / git     （不变）
packages/core      已有：fileDiffLog / events / slash     （+ view-model 导出）
packages/cli/tui   新增：diffView · diffPane · 键位        （U 轨主战场）
apps/desktop       消费同一 DiffViewModel                 （U3）
```

**禁止：** 在 UI 里重算 diff 语义；只消费 `fileDiffLog` / `preview` / `meta` / git helper。

### 3.3 阶段 U0–U5

| 阶段 | 交付 | 相对「交互 UI」 | 状态 |
|------|------|-----------------|------|
| **U0** | 规格 + `DiffViewModel`（log/preview→可渲染行） | 契约 | ✅ |
| **U1** | **终端 Diff 面板**：`/diff` 可滚列表；j/k；Enter 展开；q 退出 | ~60–70% | ✅ |
| **U2** | **权限预览面板**：ask 多文件 + hunk 可滚；y/a/N | ~75–85% | ✅ |
| **U3** | **写后 History cell**；Desktop `<details>` 复用 | ~85–90% | ✅ |
| **U4** | 行号 · 主题色 · 轻量语法高亮（无 tree-sitter） | ~90–95% | ✅ |
| **U5** | 可选真·Ink / IDE / merge-base | 全家桶尾声 | 📋 |

### 3.4 U1/U2 行为（验收）

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

### 3.5 技术选型（建议默认）

| 方案 | 优点 | 缺点 | 建议 |
|------|------|------|------|
| **A. 自研 TTY pane**（readline/raw mode，类似 arrowPicker） | 无新依赖；与现 cli 一致 | 能力上限低于 Ink | **U1–U3 默认** |
| **B. 引入 React Ink** | 对齐 HC 生态 | 依赖重；Electron 已占 GUI | U5 可选 |
| **C. 只做 Desktop 面板** | 实现快 | CLI 用户无感 | 与 A 并行 U3，不替代 CLI |
| **D. 嵌 ratatui/Rust** | 对齐 Codex | 双语构建复杂 | **不做** |

### 3.6 明确不做（U 轨内）

- 遥测 / LOC counter  
- 必抄 HC `StructuredDiff` native 模块  
- 必引入 ratatui  
- 把大 patch 写入模型 message  

### 3.7 文档入口

| 文档 | 角色 |
|------|------|
| 本文件 §3 | U 轨总规划 |
| [FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) | D 轨完成态 + U 轨切片 |
| [TUI.md](./TUI.md) | CLI 壳 + U 轨挂载点 |

---

## 4. 产品目标（主线）

| 目标 | 状态 |
|------|------|
| Headless Core | ✅ |
| CLI 可日用 | ✅ |
| Skill/MCP/Plugin/Subagent | ✅ |
| Electron 可用壳 | ✅ |
| Diff 日用契约 D0–D7 | ✅ |
| Diff 交互 UI U0–U4 | ✅（U5 可选） |
| Hooks 日用 11 事件 + exit 语义 | ✅ **H0–H5** |
| Compact 日用管道打磨 | ✅ **C0–C5** |
| 无遥测 | ✅ |

---

## 5. 总览表（汇报）

| 里程碑 | 状态 | 一句话 |
|--------|------|--------|
| M0–M2 | ✅ | headless 主路径 |
| M-Loop / Tool / Compact / Slash | ✅ | 日用 |
| M-Subagent / Cost / MCP / JSONL | ✅ | 日用 |
| M-TUI（文本壳） | ✅ | 布局/picker/主题；非真 Ink |
| M4 Electron | ✅ | 壳 + 流式 + 权限 + Settings |
| **M-Diff-A（D0–D7）** | ✅ | 日用文件 diff 契约 |
| **M-Diff-B（U0–U4）** | ✅ U0–U4 | 交互 diff UI 主路径收口；U5 可选 |
| **M-Hooks（H0–H5）** | ✅ H0–H5 | SessionEnd + exit + updatedInput + `/hooks recent` |
| **M-Compact（C0–C5）** | ✅ C0–C5 | keep · usage · mid-turn · reinject · /context；见 §8 |
| 官方市场 / 遥测 | 🚫 | 永不 |

**一句话：**  
主路径、Diff、Hooks、**Compact C 轨**日用已收口（compact ~**92–95%**）。不追 HC/Codex 全家桶。

---

## 6. 文档地图

| 文档 | 用途 |
|------|------|
| 本文件 | 总路线 + U / H / **C 轨** |
| `COMPACTION.md` | Compact 契约真源（实现前先改这里） |
| `HOOKS.md` | Hook 契约 |
| `FILE_DIFF_SPEC.md` | Diff 契约与阶段 |
| `TUI.md` | CLI TUI 壳与 U 挂载 |
| `ARCHITECTURE.md` | 架构 |
| `apps/desktop/README.md` | 桌面 |
| `TODO*.md` | 历史轨（只读） |

---

## 7. Hooks 轨（H0–H5 · **规划 · SessionEnd 必做**）

> **口径：** 日用 = 契约事件齐全 + 主路径接线 + exit 语义可依赖。  
> **不对齐 100%：** HC ~26 事件全家桶 · http/prompt/agent handler · trust/managed · Ink HooksConfigMenu · 遥测。  
> **对标：** Codex `HOOK_EVENT_NAMES` **11 事件**（Bolo 原 10 + **SessionEnd**）；HC 共享核心语义。

### 7.1 现状水位（评估后）

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
| trust / managed / TUI browser | 后置（不对齐日用 95%） |

**粗估：** 日用 **~96–98%**（11 事件 + exit + rewrite + 诊断）；vs Codex 产品壳（trust/UI）另计。

### 7.2 目标与验收（H 轨完成定义）

1. **SessionEnd** 在会话真正结束路径触发（clear / 退出 / logout 等 reason），失败不拖垮进程  
2. Stop exit 2：stderr（或约定字段）可见于模型并**可续一轮**（对齐契约「继续对话」）  
3. SubagentStop exit 2：stderr 给子代理并**继续跑**（非默默忽略）  
4. PostToolUse exit 2：stderr **立即进入模型可见链**（非仅用户侧 emit）  
5. SubagentStart exit 0 stdout 可注入子代理上下文  
6. 单测覆盖 SessionEnd + 上述 exit 路径；无遥测  
7. `docs/HOOKS.md` 为真源；`HOOK_EVENTS` 含 SessionEnd

### 7.3 架构（职责不变）

```text
packages/shared     HOOK_EVENTS + 输入类型（+ SessionEnd）
packages/hooks      runHooks / matcher / command 归约（+ 事件分支）
packages/core       挂载点：endSession / queryLoop Stop / tool Post / subagent
packages/cli        可选：hook 失败/timeout 更可读（H5）
apps/desktop        会话关闭时走同一 endSession（勿只杀进程跳过 hook）
```

**禁止：** tool 内私自跑 hook；结束路径绕过 `SessionEnd`；把 hook 全文灌进无关 message。

### 7.4 阶段切片（建议实施顺序）

| 阶段 | 交付 | 优先级 | 状态 |
|------|------|--------|------|
| **H0** | **SessionEnd 必做**：契约 + 类型 + `endSession`/`close` 挂载 + reason matcher + 短超时 | P0 | ✅ |
| **H1** | **Stop / SubagentStop exit 2 续跑**：stderr→模型/子代理 + 再入 loop（有预算/防死循环） | P0 | ✅ |
| **H2** | **PostToolUse exit 2 → 模型可见**（并进 tool_result） | P0 | ✅ |
| **H3** | **SubagentStart injectText** 进子 `systemPromptSections` | P1 | ✅ |
| **H4** | **PreToolUse `updatedInput`**（JSON 改写 tool_input；失败则忽略改写） | P2 | ✅ |
| **H5** | `/hooks recent` · `/hooks failures` 诊断 ring | P2 | ✅ |
| 后置 | SessionEnd 以外的 HC 扩事件 · http/prompt/agent · trust/managed · FileChanged | — | 🚫 非本轨 |

**顺序硬约束：** **先 H0（SessionEnd）**，再 H1→H2（exit 语义），再 H3–H5。  
不在 H0 完成前扩散 Notification / Elicitation 等。

### 7.5 H0 · SessionEnd（契约草案）

```ts
// matcher: reason
type SessionEndReason =
  | 'clear'
  | 'logout'
  | 'prompt_input_exit'
  | 'other'
// 实现可增：'resume' 切换前结束旧会话 等；先对齐 HC 常用子集

type SessionEndInput = HookBaseInput & {
  hook_event_name: 'SessionEnd'
  reason: SessionEndReason | string
  transcript_path?: string
}

// 语义（对照 Codex/HC）：
// - exit 0：成功；stdout 默认可不展示
// - 其他：stderr 仅用户；**不**因 hook 失败阻止进程退出
// - 超时：短于普通 hook（建议默认 ~3s，上限更严）；teardown 必须有 headroom
```

挂载点（实现时选齐，禁止只写类型）：

| 时机 | reason 例 |
|------|-----------|
| `/clear` 或清空会话 | `clear` |
| CLI/Desktop 正常退出 | `prompt_input_exit` / `other` |
| 登出（若有） | `logout` |
| resume 替换旧会话前 | `other` 或显式 `resume`（若采用） |

### 7.6 H1–H2 · exit 语义（要点）

```text
Stop exit 2
  → 收集 continuation 文本（stderr 优先，或 JSON decision）
  → 注入为对模型可见的续跑输入
  → 再入 query（max 续跑次数，防 hook 互刷）

SubagentStop exit 2
  → 同类，作用域=子 loop，不抬升父权限

PostToolUse exit 2
  → stderr 立即对模型可见（transcript / 下轮 tool 反馈约定写进 HOOKS.md）
  → 不默默吞掉
```

### 7.7 明确不做（H 轨内）

- 遥测 / analytics  
- HC 全量 26 事件一次做完  
- Codex hook **trust** 与 managed-hooks-only 企业层（可另开轨）  
- 真·Ink HooksConfigMenu  
- `type: http|prompt|agent`（仍仅 command；字段可预留）

### 7.8 测试与提交

| 测试 | 覆盖 |
|------|------|
| `scripts/test-hooks-*.ts`（扩或新建） | SessionEnd 触发与 reason matcher |
| | Stop/SubagentStop exit2 续跑预算 |
| | PostToolUse exit2 模型可见 |
| | 超时/abort 回归（已有 s8） |

提交建议：`feat: hooks H0 SessionEnd` → `feat: hooks H1-H2 exit semantics` → `feat: hooks H3-H5 inject and UX`；只 stage 本轨。

### 7.9 文档入口

| 文档 | 角色 |
|------|------|
| 本文件 §7 | H 轨总规划与顺序 |
| [HOOKS.md](./HOOKS.md) | 事件/exit/挂载 **实现真源** |
| [ENGINEERING_PRINCIPLES.md](./ENGINEERING_PRINCIPLES.md) | 扩事件须先改 HOOKS |
| [AGENT_LOOP.md](./AGENT_LOOP.md) | loop 与 Stop 交叉（实现时同步） |

---

## 8. Compact 轨（C0–C5 · **规划 · 当前着重**）

> **口径：** 日用 = 摘要真管道 + 阈值/熔断可依赖 + 续作质量（keep）+ 触发时机（usage/mid-turn）+ 压后上下文不丢关键段。  
> **不对齐 100%：** HC partial / session-memory / cached API edits / reactive 全家 · Codex remote compact / window id / 换模触发。  
> **对标：** HC `compactConversation` + auto/snip/micro/PTL 语义；Codex 仅借「阈值与 mid-turn 意图」，不抄 remote。

### 8.1 现状水位（评估后）

| 项 | 状态 |
|----|------|
| Full compact + Pre/Post hooks + 禁止 slice 冒充 | ✅ |
| Auto 阈值（chars 启发）+ 熔断 + env + `/autocompact` | ✅ |
| Snip 最小 + micro content-clear + prepare 链 | ✅ |
| PTL 截断重试（loop + summarizer 副本） | ✅ |
| jsonl `compact_boundary` + resume R1 | ✅ |
| **messagesToKeep 按 user 轮次 / token** | ✅ **C1** — `splitMessagesForCompactKeep`；默认智能 keep |
| **auto 阈值接 session usage（有则用）** | ✅ **C2** — `usageInputTokens` / `getUsageInputTokens` |
| **工具环中途接近阈值再 full 一次** | ✅ **C3** — `tryMidTurnCompact` · 每 outer turn ≤1 |
| **post-compact 最小再注入**（技能 catalog） | ✅ **C4** — `postCompactReinjection`（可关） |
| **`/context` 来源与策略** | ✅ **C5** — pressure source · keep · last compact |
| partial / remote / session memory / 真 tokenizer | 后置 |

**粗估：** 日用 **~92–95%**（C0–C5）；vs HC 全家桶 / Codex 窗口机另计。

### 8.2 目标与验收（C 轨完成定义）

1. Full compact 默认 **按 user 轮次** 保留尾部（可配）；禁止无摘要只 keep  
2. Auto 阈值：**优先**最近 API `input`/`total` usage（若 session 有），否则回落 `estimateTokens`  
3. 主 loop 在 **tool 批之后、下一 callModel 前** 可再判一次 auto（mid-turn 最小，有预算防连打）  
4. compact 成功后可选再注入 **短** skill catalog / path-rules 提示（不灌全文、不拆 cache-stable 前缀策略）  
5. `/context` 展示：阈值来源（usage vs estimate）、keep 策略、上次 compact 摘要长度  
6. 单测绿；失败不毁 messages；**无遥测**  
7. `docs/COMPACTION.md` 为真源

### 8.3 架构（职责）

```text
packages/compact     纯：keep 切分 · 阈值 · pressure · full/snip/micro/PTL
packages/core        挂：prepare 链 · compactSession · queryLoop mid 判 · 再注入
packages/cli         /context · /compact 文案消费 pressure + 策略说明
apps/desktop         可选展示 compact 状态（不大改壳）
```

**禁止：** core 内 `slice(-N)` 冒充 full；无 summarizer silent truncate；把大 transcript 塞回 model message；遥测。

### 8.4 阶段切片（实施顺序）

| 阶段 | 交付 | 优先级 | 状态 |
|------|------|--------|------|
| **C0** | 规格对齐：本 § + COMPACTION 日用缺口表；验收清单 | P0 | ✅ |
| **C1** | **messagesToKeep 按 user 轮次**（可选 token 上限）；manual/auto 默认可配 | P0 | ✅ |
| **C2** | **usage 感知阈值**：`shouldAutoCompact` 可读 last usage；无 usage 则启发 | P0 | ✅ |
| **C3** | **mid-turn 一次**：tool drain 后若超阈值且未本 turn compact → 试 auto full | P1 | ✅ |
| **C4** | **post-compact 再注入最小**：catalog 短段；可关 | P1 | ✅ |
| **C5** | `/context`·`/compact` 诊断加深 + 回归测 + 水位 ~92–95% | P2 | ✅ |
| 后置 | partial · remote · session memory · 真 tokenizer · cache_edits API | — | 🚫 非本轨 |

**顺序硬约束：** **C0 文档 → C1 keep → C2 usage → C3 mid-turn → C4 再注入 → C5 UX/测**。  
不在 C1/C2 完成前做 partial/remote。

### 8.5 C1 · keep 轮次（契约草案）

```ts
// packages/compact — 纯函数
type KeepTailOptions = {
  /** 保留最近 N 个 user 开启的 turn（含其后 assistant/tool）；默认建议 2–4 */
  keepRecentUserTurns?: number
  /** 可选：keep 段 token 上限，超出从 keep 头再裁 */
  keepMaxTokens?: number
}

/** 切点须在 user 边界，不拆开 tool_use/tool_result 对 */
function splitMessagesForCompactKeep(
  messages: ChatMessage[],
  opts?: KeepTailOptions,
): { toSummarize: ChatMessage[]; messagesToKeep: ChatMessage[] }
```

- `runFullCompact` / `compactSession` 默认走轮次 keep（或显式 `keepRecentUserTurns`）  
- 旧 `keepRecentMessageCount`：**兼容**，文档标 deprecated  
- 安全：tool_use 与对应 tool 结果不得分到 summarize/keep 两侧

### 8.6 C2 · usage 阈值

```ts
shouldAutoCompact({
  tokenCount,           // 启发
  usageInputTokens?,    // 最近成功 call 的 input/total（sessionUsage）
  contextWindowTokens,
  enabled,
  consecutiveFailures,
  querySource,
  env?,
})
// 有效计数 = usageInputTokens ?? tokenCount
```

- 有 provider usage 时 auto 更贴真实窗  
- `/context` 标明 `pressure source: usage | estimate`

### 8.7 C3 · mid-turn（最小）

```text
queryLoop:
  … tool drain …
  if auto on && shouldAutoCompact && !compactedThisTurn
    → compactSession(auto) 一次
    → 写回 messages；标记 compactedThisTurn
  → 下一轮 callModel
```

- 与 turn 初 prepare 的 auto **共用熔断**  
- 每 turn 最多 **一次** mid full（防死循环）  
- 失败：保持 messages，继续（同现 auto）

### 8.8 C4 · 再注入（最小）

compact 成功且非 override system 时：

- 可选刷新 **短** skill catalog 段（可复用 `replaceSkillCatalogSection`）  
- 不强制重跑全量 memory 正文  
- 开关：`postCompactReinjection?: boolean`（与现 system 装配一致即可）

### 8.9 明确不做（C 轨内）

- 遥测 / GrowthBook  
- HC partial compact / session memory compact  
- Codex remote compaction v1/v2 / window_id 状态机  
- 厂商 `cache_edits` API（本地 cached-MC 标记已有即可）  
- 真 tokenizer 依赖  

### 8.10 测试与提交

| 测试 | 覆盖 |
|------|------|
| 扩 `test-compact` / 新建 `test-compact-c-track` | keep 轮次边界 + tool 对不拆 |
| | usage 优先于 estimate 触发 |
| | mid-turn 每 turn 最多一次 + 熔断 |
| | 再注入不炸、可关 |
| 回归 | `test-auto-compact` · `test-ptl-retry` · `test-snip` · `test-microcompact` |

提交建议：

1. `docs: plan compact C-track waterline`（本规划）  
2. `feat: compact C1 keep by user turns`  
3. `feat: compact C2 usage-aware auto threshold`  
4. `feat: compact C3-C4 mid-turn and reinjection`  
5. `docs+test: compact C5 waterline`

只 stage 本轨；**勿提交 `.bolo-tmp/`**。

### 8.11 文档入口

| 文档 | 角色 |
|------|------|
| 本文件 §8 | C 轨总规划与顺序 |
| [COMPACTION.md](./COMPACTION.md) | 管道/阈值/**实现真源** |
| [AGENT_LOOP.md](./AGENT_LOOP.md) | prepare / mid-turn 交叉 |
| [PROMPT_CACHE.md](./PROMPT_CACHE.md) | 稳定前缀 vs 再注入 |