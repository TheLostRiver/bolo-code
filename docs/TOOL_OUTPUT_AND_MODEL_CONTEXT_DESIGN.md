# 长工具输出折叠与模型上下文元数据设计

> **状态：** CTX-1 `27a2506` 已完成；CTX-2 是下一刀；CTX-3 与 OUT-1..5 尚未实现。
> **设计基线：** `dc20807`；当前实施基线：`27a2506`。
> **路线标识：** `CTX-1..3`、`OUT-1..5`。
> **进度真源：** [ROADMAP.md](./ROADMAP.md) §0、§13.11。
> **相关实现：** [COMPACTION.md](./COMPACTION.md) ·
> [PROVIDERS.md](./PROVIDERS.md) · [CLI_TUI_REFACTOR_PLAN.md](./CLI_TUI_REFACTOR_PLAN.md)。

本文锁定两个相互独立但共同影响 CLI 可靠性的缺口：

1. Read、Bash、MCP 等长工具结果会把 retained transcript 填满；当前没有通用折叠、
   单块展开或全文查看契约。
2. `contextWindowTokens` 是 workspace 顶层单值；它不会随 provider/model 热切更新，
   写进 provider profile 还会被静默忽略。

本方案只借鉴 Pi、oh-my-pi、HelsincyCode、Codex、OpenCode 的职责边界与交互语义，
不引入这些项目的运行时依赖，不复制未授权实现。

### 实施水位

| 切片 | 状态 | 当前边界 |
|------|------|----------|
| CTX-1 | ✅ `27a2506` | config/schema/validator/resolver、深合并、warning、exact catalog 与 source 已落地 |
| CTX-2 | **▶ NEXT** | create/resume/hot-switch、dynamic compact、skills/dashboard/provider request 待接线 |
| CTX-3 | PENDING | `/provider`、`/model`、`/context`、`/doctor`、Desktop 与最终用户文档 |
| OUT-1..5 | PENDING | 通用 Tool presentation、折叠、全文 pager、鼠标与只读调用聚合 |

CTX-2 完成前，runtime 仍沿用旧顶层 `contextWindowTokens`，不能把 CTX-1 的配置与
resolver 宣称为端到端生效。OUT 完成前，长工具结果仍可能占满 retained transcript。

---

## 1. 决定摘要

### 1.1 模型上下文

- context window 与输出上限是两项独立模型能力。
- 用户可以在 provider 上写缺省值，也可以按 model 精确覆盖。
- config 只解析一次，生成 `ResolvedModelMetadata`；compact、skills、dashboard、
  create/resume、provider/model 热切均消费这一结果。
- 顶层 `contextWindowTokens` 保留为 legacy fallback，不再是主配置入口。
- 未识别模型仍可运行，但必须显示 fallback 值与来源，不得假装命中了 catalog。

### 1.2 工具输出

- 模型收到的 tool result 与用户默认看到的 preview 分层。
- TUI state 只保留有界 presentation；展开状态属于 renderer，不写进模型 messages。
- 成功长输出默认折叠；运行中显示有界 tail；错误默认展开但仍有 inline hard cap。
- 普通展开只显示受控 preview；真正全文进入 embedded pager。
- 已 spill 的全文由 file-backed pager 按需读取，不重新挂进 retained transcript。
- `Ctrl+O` 提供全局详情切换；单块点击与键盘 picker 打开全文。
- 鼠标支持由 Bolo 自己实现 SGR 1006 输入与命中区域，不增加运行时依赖。

---

## 2. 当前证据

### 2.1 长输出链路

当前真实数据流：

```text
Read/Bash/MCP tool
  → result.output（Read 会先把整个 UTF-8 文件读入内存）
  → truncateToolResultOutput()
  → 超预算时写 sessions/tool-results/<callId>.txt
  → tool_end.output（截断后的头尾 + full result 文本标记）
  → ChatMessage(role=tool)
  → CliTuiViewState.CliTuiToolBlock.output
  → retainedTranscript.formatToolBlock()
```

已存在的能力：

- core 有 per-tool budget、中段截断和完整结果 spill。
- file diff 与 TodoWrite 有专用 `cellCollapsed/cellExpanded`。
- CLI 有 embedded text pager、唯一 OverlayHost 和 Composer focus 恢复。
- Desktop timeline 有 `collapsed/truncated/status` 展示语义。

缺失的能力：

- 普通 Tool block 没有 semantic summary、overflow、原始规模、全文引用。
- `cellCollapsed/cellExpanded` 只覆盖 diff/Todo，不是通用工具输出协议。
- `BOLO_DIFF_CELL/BOLO_DIFF_VERBOSE` 是进程级静态环境开关，不是单块交互状态。
- retained transcript 不拥有输入焦点或鼠标 hit region。
- 单个超长 block 不会被历史 tail-window 机制解决。

当前 `dc20807` 的普通工具结果只追加渲染一次；“重复 push 两次”不属于现存缺陷。

### 2.2 上下文窗口链路

CTX-1 前、当前 runtime 仍在使用的真实数据流：

```text
config.contextWindowTokens（默认 128000）
  → buildWorkspaceSessionOptions(create)
  → BoloSession.contextWindowTokens
  → system prompt skill budget
  → auto compact prepare
  → /context 与 context dashboard
  → session snapshot / transcript meta
```

CTX-1 已关闭的配置/解析缺口：

- `ProviderConfigJson`、`ProviderProfile` 与 `profileFromConfigJson()` 已支持 provider
  默认 `contextWindowTokens/maxTokens` 和 exact model `models` map。
- user/project model entry 会逐字段深合并。
- 非法值、未知字段和常见拼错别名会进入现有 config warning 通道。
- `resolveModelMetadata()` 已按 model/provider/catalog/legacy/snapshot/fallback
  逐字段解析并记录 source；超窗 output 会被拒绝并向低优先级降级。

CTX-2 仍需关闭的 runtime 缺口：

- `ResolvedWorkspace` 没有 resolved model metadata 或 value source。
- `/provider use` 与 `/model` 更新 client/model/effort/cache，但不更新 context。
- auto-compact prepare 捕获装配时的固定窗口；后来只改 session 字段仍可能继续用旧阈值。
- resume 优先使用 snapshot window；用户修正当前配置后，旧会话仍可能保留旧值。

所以 CTX-1 只建立了可复用的配置与解析真源；在 CTX-2 接入消费者前，作用域和生命周期
问题仍未端到端解决。

---

## 3. 目标与非目标

### 3.1 目标

1. 任意单个工具结果都不能默认占满终端。
2. 用户能从摘要进入完整正文，并可靠返回原 Composer 草稿、光标和焦点。
3. resize、streaming、resume、native scrollback、paste 和 interrupt 不破坏布局。
4. 模型窗口能随 active provider/model 正确解析和热更新。
5. `/context`、`/provider`、`/model`、`/doctor` 能解释数值来自哪里。
6. 旧配置、旧 session 和 plain/non-TTY 调用保持兼容。
7. `dependencies` 继续为 `{}`；不增加其它 Agent 的运行时依赖。

### 3.2 非目标

- 不在本轨引入 tokenizer；token 估算策略仍由 compact 轨负责。
- 不修改模型厂商的服务端 context limit；本配置描述本地预算与请求上限元数据。
- 不把任意大文件全文长期复制进 TUI state。
- 不在首个 OUT 切片同时实现连续 Read/Search 聚合。
- 不把 mouse-only 交互作为唯一入口。
- 不恢复 alternate screen、legacy terminal surface 或第二 stdout owner。

---

## 4. 参考实现取舍

| 项目 | 采用的思想 | 不照搬的部分 |
|------|------------|--------------|
| Pi | model 级 `contextWindow` / `maxTokens`；renderer-local `Expandable`；`Ctrl+O` | 全局展开不能单独解决单块全文；不接其完整 coding-agent UI |
| oh-my-pi | catalog/discovery/user override 归一成同一 Model；缺字段继承 existing | 不引入其 catalog 包或动态 provider 体系 |
| HelsincyCode | Read/Search/MCP 分类摘要；连续只读调用可聚合 | 私有仓库仅作内部架构参考，不复制源码、路径或品牌 |
| Codex | model catalog + fallback 标记；active/live/transcript 分层；独立 tool output limit | 不引入 Rust TUI 栈或完整 models manager |
| OpenCode | `limit.context/output`；局部 expanded；溢出时才显示点击动作 | 当前 Bolo TUI 没有 `onClick`，需自研终端鼠标输入层 |

共同结论：

```text
模型能力：raw config/discovery → resolved model metadata → 所有 consumer
工具展示：full result/storage → bounded presentation → renderer-local state
```

---

## 5. 模型配置契约

### 5.1 JSONC 形态

```jsonc
{
  "defaultProvider": "work",
  "providers": {
    "work": {
      "kind": "openai-responses",
      "baseUrl": "https://example.invalid/v1",
      "apiKeyEnv": "WORK_API_KEY",
      "model": "model-a",

      // provider 缺省：只配一个模型时写这里即可
      "contextWindowTokens": 200000,
      "maxTokens": 32768,

      // 同一 provider 内切换多个模型时使用 exact override
      "models": {
        "model-a": {
          "contextWindowTokens": 200000,
          "maxTokens": 32768
        },
        "model-b": {
          "contextWindowTokens": 128000,
          "maxTokens": 16384
        }
      }
    }
  },

  // 旧字段：继续读取，只作为 legacy fallback
  "contextWindowTokens": 128000
}
```

`apiKey` 明文仍是现有兼容能力，但只应写入用户级 `~/.bolo/config.json`，不得提交。
本轨不改变密钥边界。

### 5.2 类型

```ts
export type ModelLimitsConfigJson = {
  contextWindowTokens?: number
  maxTokens?: number
}

export type ProviderConfigJson = {
  // existing fields...
  contextWindowTokens?: number
  maxTokens?: number
  models?: Record<string, ModelLimitsConfigJson>
}
```

`maxTokens` 延续现有 provider 输出基线语义；内部 resolved 类型使用
`maxOutputTokens` 命名，避免与 full context 混淆。

### 5.3 合并

```text
defaults < user config < project config
```

- provider profile 仍按 id 合并。
- `providers.<id>.models` 按 model id 深合并。
- 同一 model entry 内按字段合并；project 只覆盖自己显式写出的字段。
- 空 model id 忽略并 warning。
- 不用 `0` 或负数表达“自动”；省略字段才表示继承。

---

## 6. ResolvedModelMetadata

### 6.1 契约

```ts
export type ModelMetadataSource =
  | 'model'
  | 'provider'
  | 'catalog'
  | 'legacy'
  | 'snapshot'
  | 'fallback'

export type ResolvedModelMetadata = {
  providerId: string
  model?: string
  contextWindowTokens: number
  maxOutputTokens: number
  sources: {
    contextWindow: ModelMetadataSource
    maxOutput: ModelMetadataSource
  }
  usedFallback: boolean
  warnings: string[]
}
```

source 必须逐字段记录；context 来自 model 而 output 来自 provider 是合法状态。

### 6.2 优先级

```text
1. providers.<id>.models.<activeModel> exact override
2. active provider 默认 contextWindowTokens / maxTokens
3. 内置 catalog 或 provider preset 的已知 model metadata
4. 顶层 legacy contextWindowTokens（context only）
5. 同 provider/model 的 session snapshot（仅 resume 且当前链无有效来源）
6. 明确 fallback：context=128000，output=8192
```

正常 create 不使用 snapshot。resume 先恢复 snapshot 的 provider/model 身份，再用当前配置
重新解析；只有当前配置/catalog/legacy 都没有有效值时才使用同一 provider/model 的快照值。

### 6.3 校验

以下情况产生可见 config warning：

- context/output 不是有限正整数。
- `maxTokens > contextWindowTokens`。
- `models` 不是 object、model id 为空或 entry 不是 object。
- provider/model 中出现已知易错别名：`contextWindow`、`context_window`、
  `maxOutputTokens`；warning 必须提示 Bolo 的正确字段。
- profile 中出现其它未知字段；保留启动能力，但不得静默宣称生效。

运行时策略：

- 非法字段从 resolved 候选中排除，继续向下一优先级解析。
- output 大于 context 时不把非法组合传给 provider；忽略该 output 候选并 warning。
- `/doctor` 返回非零健康状态还是 warning 状态由现有 doctor 契约决定；不得让坏配置
  阻止用户进入 CLI 修复。

---

## 7. 模型运行时接线

### 7.1 Create

```text
loadWorkspace
  → normalize provider registry
  → resolve active provider/model metadata
  → ResolvedWorkspace.resolvedModel
  → createSession
```

session 保留以下有效快照：

```ts
resolvedModel: ResolvedModelMetadata
contextWindowTokens: number       // compatibility projection
maxOutputTokens: number           // observability/runtime projection
```

### 7.2 Auto compact

`createAutoCompactPrepare()` 不再捕获一个永久固定的 number，改为读取 getter：

```ts
getContextWindowTokens: () => session.resolvedModel.contextWindowTokens
```

这样 provider/model 热切不需要重建并猜测原有 snip/micro/custom prepare 链。
mid-turn compact、`/context` 与 dashboard 同样从 resolved metadata 读取。

### 7.3 Provider/model 热切

热切必须是一个原子操作：

```text
resolve target provider/model
  → validate metadata
  → create/rebind provider with effective model + output baseline
  → update session.resolvedModel
  → refresh skill catalog budget
  → refresh classifier/summarizer
  → force prompt-cache break
  → emit one result/warning
```

任一步在 commit 边界前失败，保留旧 provider/model/metadata，不允许半切换。

`/model` 选择同 provider 的另一个 model 时，也必须按 exact model entry 重新解析；
不能只写 `session.model = name`。

### 7.4 Resume

- snapshot 增加可选 resolved metadata/source 字段，旧版本仍可解析。
- 当前配置优先重新解析 snapshot provider/model。
- 当前配置未知且 snapshot 身份一致时，使用 snapshot 值并标 source=`snapshot`。
- provider/model 已改变时，不得把旧模型窗口错误套到新模型。
- 恢复完成后 prepare getter、skills budget、dashboard 和 provider output baseline 必须一致。

### 7.5 可观测性

建议文本：

```text
model: model-a
context: 200k tokens (model override)
max output: 32k tokens (provider default)
```

必须覆盖：

- `/provider list/use`
- `/model`
- `/context` 与 details
- `/doctor`
- Desktop session settings/status projection

fallback 示例：

```text
context: 128k tokens (fallback; unknown model metadata)
```

---

## 8. ToolPresentation 契约

### 8.1 类型

```ts
export type ToolResultReference = {
  kind: 'session-file'
  path: string
  bytes: number
}

export type ToolPresentation = {
  summary: string
  preview?: string
  previewMode?: 'head' | 'tail' | 'head-tail'
  originalChars: number
  originalLines: number
  retainedChars: number
  retainedLines: number
  truncated: boolean
  overflow: boolean
  fullResult?: ToolResultReference
}
```

约束：

- `summary` 单行、去控制字符、按 terminal width 重排。
- `preview` 是纯展示正文，字符 hard cap 默认 4,000。
- `fullResult.path` 只允许 session store 内的受控路径。
- presentation 不替代 `ChatMessage(role=tool)`，也不改变 provider 输入。
- 现有 `[full result: ...]` 模型文本标记在首刀保持兼容；UI 不再解析它。

### 8.2 分层

```text
ToolResult                    完整执行结果
  ├─ ChatMessage content      现有模型预算/截断语义
  ├─ spill reference          完整正文的受控只读来源
  └─ ToolPresentation         有界 UI 语义
       └─ renderer state      collapsed/preview/pager
```

`packages/shared` 定义纯契约与工具分类 policy；`packages/core` 在执行边界生成规模、
spill ref 和 presentation；CLI/Desktop 只消费，不重建第二套工具状态机。

---

## 9. 默认摘要策略

| 工具类别 | 折叠摘要 | preview |
|----------|----------|---------|
| Read | path · 行数 · 字节数 · 是否截断 | 少量 head；全文走 pager |
| Bash | command · running/exit/error · elapsed | running/completed tail，最多 10 visual lines |
| Grep/Glob/Search | query/path · 命中数 | 前 5 个样本 |
| Write/Edit/apply_patch | path · `+N/-N` | 继续使用 diff cell |
| TodoWrite | todo 状态摘要 | 继续使用现有 todo cell |
| MCP/未知 | tool name · server/状态 · 输出规模 | 通用 3 visual lines |
| Error | tool name · error | 默认展开，最多 20 visual lines；全文 pager |

overflow 同时考虑：

- 原始逻辑行数；
- 当前终端宽度下的 visual lines；
- 字符 hard cap；
- 是否已有 spill/truncation。

短结果不显示展开 affordance；只有 overflow 时允许展开/查看全文。

---

## 10. Renderer 状态机

状态只存在于 CLI renderer：

```ts
type ToolDisplayMode = 'summary' | 'preview' | 'pager'

type ToolDisplayState = {
  byBlockId: Map<string, 'summary' | 'preview'>
  globalPreview: boolean
  pagerBlockId?: string
}
```

状态转移：

```text
tool_start       → running preview（有界 tail）
tool_progress    → 更新同一 stable block，不改变用户选择
tool_end success → 无 overflow: preview
                 → 有 overflow: summary
tool_end error   → preview（inline hard cap）
Ctrl+O           → 全局 summary ↔ bounded preview
单块 activate    → pager
Esc/q/再次点击   → 关闭 pager，回到该块原 summary/preview
resume           → 重建 presentation，默认 summary
```

不变量：

1. renderer mode 不写 session JSONL，不进入模型消息。
2. block 更新不得重置用户已经选择的 summary/preview。
3. pager 打开/关闭不得卸载 Composer 或丢失 draft/cursor/history/undo。
4. 展开不能把任意大 spill 文件重新塞回 retained root。
5. resize 从 raw bounded preview 重新计算 visual lines，不缓存旧宽度物理行。

---

## 11. 键盘与鼠标

### 11.1 键盘

- `Ctrl+O`：全局 summary/preview 切换，沿用 Pi 的成熟心智模型。
- `/tools`：打开最近工具结果 picker；上下选择，Enter 打开全文 pager，Esc 返回。
- pager 继续沿用现有 `n/j/↓/→`、`p/k/↑/←`、`q/Esc`。
- running turn 中 Esc/Ctrl+C 的中断优先级保持现有契约，不能被工具查看抢走。

`/tools` 使用现有 structured catalog/overlay 路径，不把 transcript 变成长期 focus owner。

### 11.2 鼠标

OUT-4 自研以下最小层：

```text
BoloTerminalAdapter
  → capability/TTY 检测
  → enable SGR 1006 + button tracking
  → parse mouse press/release/wheel
  → RetainedRoot 当前 render hit regions
  → activate tool block / pager close
  → stop/异常时必定 disable mouse mode
```

只给 overflow block 注册 hit region。点击摘要打开全文 pager；pager 激活时再次点击来源摘要
或点击 pager 关闭动作会收起，Esc 永远等价可用。

bracketed paste 与 mouse escape sequence 必须由同一 stdin buffer 正确区分。能力不足、
pipe、CI、dumb terminal 不启用 mouse reporting。

---

## 12. Full result 与 pager

### 12.1 Spill 布局

新结果使用 session-scoped 路径：

```text
sessions/workspaces/<hash>/tool-results/<sessionId>/<callId>.txt
```

- call id 仍需文件名清洗。
- reference 保存绝对规范路径、bytes；读取时重新校验仍在 session tool-results 根内。
- 旧 `tool-results/<callId>.txt` 只读兼容，不迁移、不覆盖。
- 删除 session 时清理对应目录；清理失败 warning，不影响其它会话。

### 12.2 File-backed pager

现有 text pager 只接收完整 `content` 字符串。OUT-3 增加 source union：

```ts
type TextPagerSource =
  | { kind: 'inline'; content: string }
  | { kind: 'session-file'; path: string; bytes: number }
```

file source 必须：

- 按页或按块读取；
- 对行边界与 UTF-8 多字节安全；
- 不因打开 100MB 文件一次性分配 100MB 字符串；
- 文件缺失、权限失败、校验越界时在 pager 内显示可行动错误；
- close/interrupt 后释放 handle/cache 并恢复 Composer focus。

---

## 13. 持久化与 plain 兼容

### 13.1 Session side-channel

OUT-3 增加可选 transcript entry，按 call id 保存 presentation metadata 与受控 ref。
它不进入 provider messages。resume 优先使用 side-channel；旧 session 则从 tool message
重建摘要，无法证明全文 ref 时不显示“查看全文”。

不得从任意 tool output 文本中正则提取路径作为受信引用。

### 13.2 non-TTY / `--print`

- 不输出折叠控制序列、mouse mode 或可点击提示。
- plain formatter 继续输出稳定文本；当前 tool result 截断标记保持兼容。
- JSON/runtime protocol 如增加 presentation 字段，只能是可选向后兼容字段。
- `--print` 的退出码、stdout/stderr 分工和最终 assistant 文本不变。

---

## 14. 实施顺序

每个代码切片先写失败测试；新测试同时进入独立 npm script 与默认 `npm test`。
代码/测试与文档分批中文 commit，commit 后立即 push。

### CTX-1 · 配置契约与 resolver ✅ `27a2506`

packages-first：

- `ModelLimitsConfigJson`、provider `models` map、深合并。
- 字段级 validation/warnings。
- `ResolvedModelMetadata` 与纯 `resolveModelMetadata()`。
- 内置小型 catalog/preset metadata 与明确 fallback。

验收：user/project merge、精确 model/provider/catalog/legacy/fallback 优先级、拼错字段、
非法值、unknown model。新增 `test:model-metadata-config` 已进入默认 `npm test`；
专项、typecheck、既有 config/provider 回归与完整门禁已通过。

### CTX-2 · create/resume/hot-switch 接线 ▶ NEXT

- `ResolvedWorkspace.resolvedModel`。
- create/resume/provider/model 原子更新。
- dynamic compact getter。
- skills budget、dashboard、provider output baseline、cache break 一致。
- snapshot 兼容与 current-config-first resume。

验收：32k/128k/200k/1m 切换；旧 session；热切失败回滚；auto/mid-turn compact 阈值。

本切片完成前，session、compact、skills、dashboard 与 provider request 仍使用旧顶层
窗口或既有输出配置，不能把 provider/model limits 写进最终用户用法并宣称已生效。

### CTX-3 · 可观测性与用户文档

- `/provider`、`/model`、`/context`、`/doctor`、Desktop projection。
- CONFIG/PROVIDERS/USAGE/ROADMAP/AGENT_HANDOFF。

### OUT-1 · ToolPresentation 契约

- shared 类型/分类 policy。
- core 原始规模、truncated、spill ref、bounded preview。
- CLI reducer 不再长期保存第二份大正文。

### OUT-2 · 默认折叠与键盘路径

- renderer-local stable block state。
- 分工具摘要、running tail、error cap。
- `Ctrl+O`、`/tools` picker、embedded pager 与 focus 恢复。

### OUT-3 · file-backed pager 与 resume

- session-scoped spill。
- file pager source。
- transcript side-channel、旧 session fallback、session cleanup。

### OUT-4 · SGR mouse

- enable/disable、parser、hit region、click/close、paste 共存。
- 自动 VT 门禁 + 真人 Windows Terminal 验收项。

### OUT-5 · 连续只读调用聚合

- 只聚合相邻 Read/Grep/Glob/只读 MCP。
- assistant 正文、写工具、权限请求、错误切断 group。
- 这是第二阶段；不阻塞单块折叠交付。

---

## 15. 测试与预算

### 15.1 配置/上下文

- defaults/user/project 深合并。
- provider 默认与 exact model override。
- catalog/legacy/snapshot/fallback source。
- zero/negative/NaN/fraction/string/超窗 output。
- create/resume/provider use/model switch。
- compact prepare 动态读取，不捕获旧窗口。
- skill catalog、`/context`、doctor、Desktop 使用同一 metadata。

### 15.2 工具展示

- short/long/empty/ANSI/CJK/emoji/超长单行。
- Read/Bash/Grep/Glob/Edit/Todo/MCP/unknown/error。
- streaming progress、tool_end、interrupt、resume。
- terminal resize 前后 stable id 与用户展开状态。
- `Ctrl+O`、picker、pager close、draft/cursor/focus 恢复。
- spill missing/corrupt/symlink/越界路径。
- mouse click、wheel、paste、Esc/Ctrl+C 优先级。
- plain/non-TTY/JSON/`--print` 字节与退出码兼容。

### 15.3 性能

- `ToolPresentation.preview <= 4,000` chars。
- collapsed block 不持有 spill 全文或第二份 50k output。
- 100 个长 block resize/reflow 不随原始全文总大小线性增长。
- 100MB spill 在未打开 pager 时零读取；pager 按页读取，close 后释放。
- 保留现有 TUI cold start、CPU、heap、cleanup 与 dist size 门禁。

---

## 16. 回滚与兼容

- CTX 字段全部可选；删除新字段即退回 legacy/fallback。
- snapshot 新字段可选；旧 parser 保持。
- OUT presentation 是可选 event/view 字段；缺失时 renderer 使用现有 plain formatter。
- mouse 有 capability gate 和显式 disable；失败时键盘路径完整可用。
- file-backed pager 失败只影响“查看全文”，不得拖垮 turn 或丢失模型 tool result。
- 任一切片若需要恢复第二 terminal writer、alternate screen 或其它 Agent 运行时依赖，
  视为方案偏离，必须停止并回到本文重新决策。

---

## 17. 完成定义

本轨只有满足以下条件才能在 ROADMAP 标记完成：

1. provider/model context 配置在 create、resume、热切和 dashboard 中一致可见。
2. unknown/invalid/fallback 均有可解释来源，不再静默忽略。
3. 长 Read/Bash/MCP 默认只占有界行数。
4. 用户能通过键盘和支持的鼠标路径查看全文并返回原输入状态。
5. full spill 不进入 retained 内存；resume 能安全恢复可用引用或诚实降级。
6. plain/non-TTY/`--print` 与现有脚本兼容。
7. 定向测试、typecheck、完整 `npm test`、dist/pack/install、TUI 性能门禁全绿。
8. 真 TTY 鼠标与主观视觉未验时必须显式保留人工验收标记。
