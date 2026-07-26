# 内置工具契约（Agent 能力面）

> **真源。** 增删工具、改 schema、改权限分类，都必须先改本文档再写代码。
> 进度水位见 [ROADMAP.md](./ROADMAP.md) §0 与 §14。工具管道顺序见 [ENGINEERING_PRINCIPLES.md](./ENGINEERING_PRINCIPLES.md) §2.2。

---

## 0. 全集（13）

| 工具 | 权限 | 并发安全 | 只读 | interrupt |
|------|------|----------|------|-----------|
| `Bash` | ✅ 需门控 | ✗ | ✗ | cancel |
| `BashOutput` | ✗ | ✅ | ✅ | cancel |
| `KillShell` | ✗ | ✗ | ✗ | block |
| `Read` | ✗ | ✅ | ✅ | cancel |
| `Write` | ✅ | ✗ | ✗ | block |
| `Edit` | ✅ | ✗ | ✗ | block |
| `apply_patch` | ✅ | ✗ | ✗ | block |
| `Glob` | ✗ | ✅ | ✅ | cancel |
| `Grep` | ✗ | ✅ | ✅ | cancel |
| `Skill` | ✗ | ✅ | ✅ | cancel |
| `WebFetch` | ✅ 网络出站 | ✅ | ✅ | cancel |
| `TodoWrite` | ✗ | ✗ | ✗ | cancel |
| `Agent` | 按 policy | — | ✗ | — |

权限判定统一在 **PermissionGate**，工具内不得自判 allow/deny。
`isConcurrencySafe` 决定 `StreamingToolExecutor` 能否与同批工具并行——**默认 fail-closed 为 `false`**。

---

## 1. TodoWrite（AR-T1）

### 1.1 为什么它值得一个工具

长任务里模型唯一的「跨步骤记忆」是上下文，而上下文正在被 compact 压缩。
待办表提供一个**不在消息历史里**的锚点：compact 改写 messages 时它不受影响。

### 1.2 契约

```ts
// packages/shared/src/todo.ts
type TodoStatus = 'pending' | 'in_progress' | 'completed'

type TodoItem = {
  content: string     // 祈使式 "Fix the auth bug"
  status: TodoStatus
  activeForm: string  // 现在进行式 "Fixing the auth bug"
}
```

输入 `{ todos: TodoItem[] }`，**整表替换**，不是增量 patch。

| 规则 | 行为 |
|------|------|
| `content` / `activeForm` 空白 | **拒绝**（`empty_content` / `empty_active_form`） |
| `status` 非法 | **拒绝**（`invalid_status`） |
| 非数组 / 元素非对象 | **拒绝**（`not_array` / `not_object`） |
| `in_progress` 不是恰好 1 个 | **通过但带 warning**，写进 tool_result 的 `NOTE:` |
| 全部 `completed` | 通过；**存储清空**，返回值仍是本次提交的表（供 UI 显示一次收尾态） |
| 空表 `[]` | 通过（用于主动清空计划） |

> `in_progress` 基数**故意不硬校验**：硬拒会让模型陷入「改一版→被拒→再改」的重试循环。
> 约束靠系统提示词 `# Task tracking` 段 + 工具结果里的 `NOTE:` 自纠。

### 1.3 状态存放与生命周期

```text
session.todos            ← 权威表（不进 messages）
  ↑ TodoWrite 工具经 ctx.extras.todoStore 写入（live getter/setter）
  ↓ session.onTodoWrite  → transcript `todo` 全量快照（append-only）
  ↓ resume               → projectTodosFromEntries 取最后一条快照
```

transcript 里的 `todo` entry 是**全量快照**而非增量：表很小（几行文本），
全量比增量更抗中断——半张待办表比没有更危险，坏快照整条丢弃。

### 1.4 再注入（模型如何看见它）

表不在 messages 里，所以模型默认看不见。core 在 **`before_provider` safe boundary** 按策略注入
一个 `<todo_reminder>` 包裹的 user 消息（与 `<background_task_result>` 同构）。

```text
if (待办表为空)                          → 永不注入
if (写锚点与提醒锚点同时消失)             → 立即注入一次   ← compact / resume 后
else 距上次 TodoWrite ≥ 10 assistant 轮
     且 距上次提醒     ≥ 10 assistant 轮 → 注入
```

锚点直接从 messages 反扫得出（找 `TodoWrite` tool_call 与 `<todo_reminder>` 消息），
**不额外持久化计数器**。compact / resume 之后锚点自然消失，正好等价于「模型已失去视野」，
因此快速路径不需要任何特殊 hook。注入的提醒本身成为新锚点，双阈值随即生效，不会连发。

### 1.5 渲染

`packages/core/src/todoCell.ts` 在 core 侧预渲染折叠/展开两态，
经既有 `tool_end.cellCollapsed / cellExpanded` 通道下发。**壳只打印，不重算状态。**

```text
折叠  Todos 1/3 · Building parser
展开  Todos 1/3 · Building parser
        ✔ scaffold project
        ▶ build parser
        ○ write tests
```

---

## 2. 后台 shell 三件套（AR-T2）

### 2.1 Bash `run_in_background`

```jsonc
{
  "command": "npm run dev",
  "run_in_background": true,
  "description": "dev server"   // 可选，状态行展示
}
```

后台分支**走完与前台完全相同的 policy / sandbox 门禁后才分流**。分流之后：

- **不套 timeout**（前台上限 600s；后台套上就失去意义）
- **不吃单轮 `ctx.signal`**（后台进程的价值就是跨 turn 存活）
- 沙箱临时文件**延后到进程退出**才清理（前台是 `finally` 清理，后台照搬会提前删掉）

返回 shell id，后续用 `BashOutput` / `KillShell` 操作。

### 2.2 BashOutput

`{ bash_id }` → 返回**自上次读取以来**的新输出 + 状态行。只读、免审批、并发安全。

游标按**实际读到的字节数**推进，允许越过 `bytesWritten`（stat 与 read 之间文件可能又长了），
这样才不会漏读。单次读取上限 200KB，超出时提示 `[more output available]`。

### 2.3 KillShell

`{ shell_id }` → 杀整棵进程树。

免审批的理由：它**只能作用于本会话注册过的 shell**，拿不到任意 pid，越权面为零。
对已结束的 shell 是安全 no-op，返回它此前的终态。

### 2.4 状态机

```text
running ──exit(0)────→ completed
        ──exit(≠0/null)→ failed
        ──kill────────→ killed
```

**terminal 幂等是硬要求**：kill 之后进程自然退出会再触发一次 exit，
那次必须被忽略，否则「用户杀掉的」会被记成「正常完成」。

参考实现另有 `backgrounded` 中间态（给「前台命令中途转后台」用）；
Bolo 本轮只支持显式 `run_in_background`，不需要该态。

### 2.5 进程树 kill（零依赖红线）

**`package.json` 的 `dependencies` 恒为空**，不得为此引入 `tree-kill` 之类的包。

| 平台 | 手段 |
|------|------|
| POSIX | `spawn(..., { detached: true })` 建独立进程组 → `process.kill(-pid, 'SIGTERM')` → 2s 后 `SIGKILL`；两级都失败时退回单 pid |
| Windows | `taskkill /pid <pid> /T /F`（`/T` 收整棵树） |

（与 codex `process_group(0)` + `terminate_process_group` → `kill_process_group` 同构。）

### 2.6 输出落盘与体积熔断

输出写到 `.bolo-tmp/shells/<sessionId>/<shellId>.log`，**不驻内存**——长跑命令的 stdout 可能是 GB 级。
累计字节超过 `DEFAULT_BACKGROUND_SHELL_OUTPUT_CAP_BYTES`（64MB）即熔断杀进程并标 `killedForSize`，
防止死循环 append 打满磁盘。

### 2.7 防僵尸

后台进程**跨 turn 存活，但绝不越过会话**：

```text
endSession → killAllBackgroundShells(session.backgroundShells)
           → cleanupShellOutputDir(cwd, sessionId)
```

`scripts/test-bash-background-runtime.ts` 用真实进程验证：kill 后 `isProcessAlive` 为假、
`killAll` 无残留、`endSession` 之后无僵尸。

---

## 3. 门禁

```bash
npx tsx scripts/test-todo.ts                     # todo 纯契约
npx tsx scripts/test-todo-session.ts             # session/transcript/resume/注入
npx tsx scripts/test-bash-background.ts          # 后台 shell 纯契约
npx tsx scripts/test-bash-background-runtime.ts  # 真实进程 spawn/read/kill/teardown
```

四个都已进 `npm test` 默认门禁。

---

## 4. 尚未实现（AR-T3+ 候选）

| 候选 | 现状 |
|------|------|
| `WebSearch` | 无（只有 `WebFetch`，能取已知 URL 不能发现） |
| plan 工具流 | `PERMISSION_MODES` 已有 `'plan'`，但只 deny 编辑 + 一行提示；**缺 `ExitPlanMode`**，没有「提计划→批准→执行」闭环 |
| `AskUserQuestion` | 无（只能自由文本发问，拿不到结构化选择） |
| 前台命令自动后台化 | 无（参考实现有阻塞预算超时自动转后台；语义复杂，暂不做） |
| LSP | 无（体量大，归 AR4 证据门控） |

逐项独立准入，见 [ROADMAP.md](./ROADMAP.md) §14.3。
