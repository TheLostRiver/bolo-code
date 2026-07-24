# TODO / 路线图：Auto 权限分类器（YOLO 语义）

> **专项规划**（与 `docs/PERMISSIONS.md` 规则门控正交；与 `docs/TODO.md` 全局下一刀衔接）。  
> 更新：初版规划（对照 HelsincyCode `utils/permissions/*` + `yoloClassifier`，**重新实现**；无遥测 / 无 GrowthBook）。  
> 原则：fail-closed；不把 stub 当完成；完成度分 **规则层 / auto 语义 / 产品整体** 三口径。

---

## 0. 为何单独成册

| 问题 | 说明 |
|------|------|
| 体量 | HC 权限目录约 20+ 核心文件 + 大量 UI；Bolo 现为单文件规则门控 |
| 风险 | 误 allow 可破坏环境；不能当「加一个 mode 名」交付 |
| 目标 | 用户期望接近 **HC auto/YOLO 行为的 ~90%（headless 语义）**，非抄全套 UI/遥测 |
| 依赖 | 已有：四档 mode、always-allow/deny、Bash 通配、S8 子权限不升级、hooks PermissionRequest |

**现状粗估（分析结论，见会话审计）：**

| 口径 | 相对 HC | 说明 |
|------|---------|------|
| 规则门控日用 | ~55–70% | `decidePermission` 可用 |
| **auto/YOLO 子系统** | **~0–5%** | 无分类器 |
| 权限产品整体（含 UI） | ~15–25% | CLI 极简 |

本专题 **只规划 auto/YOLO 子系统 + 为 auto 服务的规则加固**；不吞掉 Electron 权限对话框全家桶。

---

## 1. 产品目标（验收北极星）

### 1.1 要达到的体验

在 **`permissionMode = auto`**（或等价名）时：

1. **安全只读 / 明确安全工具** → 不弹人、不打分类器（白名单）。  
2. **acceptEdits 本就会放行的 cwd 内编辑** → 可跳过分类器（快路径）。  
3. **其余危险操作** → 侧路 LLM 分类 → **allow 或 deny**（默认 **不可用/解析失败 → deny**）。  
4. **always-deny 硬规则** 与 **plan** 仍优先于 auto。  
5. **危险会话 allow**（如 `Bash` 全放行）在进入 auto 时被 **剥离或忽略**，防止架空分类器。  
6. **熔断**：分类器连续失败 / 超时 → 退出 auto 或回退 default+ask，并本地可见原因。  
7. **无遥测、无远程 dump 服务**；可选本地 debug 日志文件。

### 1.2 明确不抄 / 不做（或极后置）

| 项 | 原因 |
|----|------|
| GrowthBook / 远程开关 | 产品红线 |
| 遥测 logEvent / 成本上送 | 产品红线 |
| HC 全套 Permission UI 组件树 | Bolo 先 headless/CLI |
| 企业 policy / known marketplace 式策略引擎 | 非本专题 |
| PowerShell 完整语义 | 后置；Windows 可先走 Bash 或最小 PS 提示 |
| Adaptive thinking 与分类器强绑定 | 可选后置 |

### 1.3 「~90% HC auto 语义」定义（Bolo 验收用）

满足下表 **Y2+Y3 全部 ✅**，且 Y4 至少完成 2/4 项，即视为 **auto 语义 ~85–90%**（相对 HC YOLO **行为**，非代码行数）：

| # | 行为 | 最低阶段 |
|---|------|----------|
| A | auto 模式可进入/退出（slash + session 字段 + 快照） | Y1 |
| B | 白名单工具跳过分类器 | Y1 |
| C | acceptEdits 快路径跳过分类器 | Y2 |
| D | 真 side-query 分类 allow/deny | Y2 |
| E | 失败/超时 fail-closed deny | Y2 |
| F | 进 auto 剥离危险 allow 规则 | Y3 |
| G | 熔断 + 回退 | Y3 |
| H | 敏感路径 / 危险命令库最小 | Y3 |
| I | 两阶段或等价降本（fast 否决 / 深评） | Y4 |
| J | Agent/子 agent 不绕过（与 S8 协同） | Y3–Y4 |

**未要求** 达到 HC UI/遥测/企业策略 的 90%。

---

## 2. 对照 HC 模块 → Bolo 落点

| HC（参考） | 职责 | Bolo 目标模块（建议） |
|------------|------|----------------------|
| `PermissionMode` + `auto` | 模式枚举与展示 | `packages/permissions` 扩展 mode |
| `permissions.ts` auto 分支 | 决策链挂接 | `decidePermission` 或 `decidePermissionAsync` |
| `yoloClassifier.ts` | 侧路分类 | `packages/permissions/src/autoClassifier.ts`（新） |
| `classifierDecision.ts` | 安全白名单 | `autoAllowlist.ts` |
| `autoModeState.ts` | 激活/熔断 | `autoModeState.ts`（会话级即可） |
| `permissionSetup.ts` 危险规则 | 进 auto 清洗 | `stripDangerousAllows.ts` |
| `dangerousPatterns.ts` | 危险 shell | `dangerousPatterns.ts` 最小表 |
| `filesystem.ts` 敏感路径 | 路径安全 | 扩展现有 path 检查 |
| `denialTracking.ts` | 连续拒绝 | 会话计数，可选 |
| UI Permission* | 人机确认 | CLI：auto 下默认不 ask；熔断后回退 ask |

**接线点：** `runToolUse`（`toolExecution.ts`）在 gate 结果为需自动决策时调用 async 分类器；`queryLoop` 已有 `deps.callModel` / provider，分类器用 **独立短请求**（勿污染主对话 messages）。

---

## 3. 架构草图

```text
runToolUse
  → PreToolUse hooks
  → decidePermission(rules, mode)     # 同步规则层（已有）
       always-deny / plan / always-allow / matrix
  → if mode===auto && behavior===ask（或「需分类」）:
       → autoAllowlist? → allow
       → wouldAllowInAcceptEdits? → allow
       → strip 已在进模时处理危险 allow
       → runAutoClassifier(sideQuery) → allow | deny
            fail → deny + maybe trip circuit
  → else if ask → hooks / UI
  → tool.call
```

```text
packages/permissions/
  index.ts              # mode + decidePermission 同步 API
  autoMode.ts             # 状态、熔断、进/出 auto
  autoAllowlist.ts        # 安全工具集
  autoClassifier.ts       # prompt 组装 + 解析 + side call 接口
  dangerousPatterns.ts    # 最小危险模式
  stripDangerousAllows.ts # 进 auto 清洗 rules
  types.ts                # 可选拆分

packages/core/
  toolExecution.ts        # async gate 路径
  deps.ts                 # classifyCall 或复用 provider.completeText
```

**分类器 I/O（草案，实现可微调）：**

```ts
type AutoClassifyInput = {
  toolName: string
  toolInput: unknown
  cwd: string
  /** 近期 user/assistant/tool 摘要，非全量 transcript */
  recentSummary: string
  userRulesHint?: string
}

type AutoClassifyResult =
  | { decision: 'allow' | 'deny'; reason: string; model?: string; durationMs?: number }
  | { decision: 'deny'; reason: string; unavailable: true }
```

解析：优先简单 JSON `{"decision":"allow|deny","reason":"..."}`；失败 → deny。  
（HC 用 XML/tool_use 两阶段；Bolo Y2 单阶段 JSON 即可，Y4 再加深。）

---

## 4. 阶段切片（Y0–Y4）

### Y0 — 规格与契约（文档 + 类型，无行为冒险）

| ID | 任务 | 验收 |
|----|------|------|
| **Y0.1** | 本文定稿；`PERMISSIONS.md` 增加 auto 专节入口 | 链接互通 |
| **Y0.2** | 类型草案：`PermissionMode` 含 `auto`；`AutoClassify*` | 类型可编译，mode 尚未接线 |
| **Y0.3** | 对照表 HC→Bolo 冻结「做/不做」 | 本节 §1.2 / §2 |

**出口：** 实现者无需再猜产品边界。

---

### Y1 — 模式与快路径骨架（仍可无真 LLM）

| ID | 任务 | 验收 |
|----|------|------|
| **Y1.1** | `permissionMode: 'auto'` 进入枚举 + `/permissions auto` + 循环可选 | 单测 + slash |
| **Y1.2** | 快照 / JSONL meta 持久化 mode | resume 保持 auto |
| **Y1.3** | `autoAllowlist`：Read/Glob/Grep/Skill 等 → allow | 单测 |
| **Y1.4** | auto 下非白名单 **暂** deny 或 ask（显式配置 `autoFallback: 'deny'\|'ask'`，默认 **deny** 更安全） | 文档写清；**禁止**静默当 bypass |
| **Y1.5** | 系统提示词一行说明 auto 行为 | SYSTEM_PROMPT / catalog |

**出口：** 模式可切换；**尚未**「智能放行危险操作」（仅白名单真自动）。  
**相对 HC YOLO 语义：~10–15%。**

---

### Y2 — 真分类器（单阶段）★ 第一个「可用 auto」

| ID | 任务 | 验收 |
|----|------|------|
| **Y2.1** | `deps.classifyPermission` 或 `provider.completeText` 侧路调用 | mock provider 可测 |
| **Y2.2** | `autoClassifier`：组装 system + user（工具名/入参/cwd/摘要） | 单测 snapshot 字符串关键字段 |
| **Y2.3** | 解析 JSON decision；非法/空 → deny + `unavailable` | 单测 |
| **Y2.4** | `runToolUse`：mode=auto 且规则层 ask → 调分类器 | 集成测：mock 返回 allow 则执行 |
| **Y2.5** | acceptEdits 快路径：cwd 内 edit 跳过分类器 | 单测 |
| **Y2.6** | 超时（如 15–30s）→ deny | 单测 |
| **Y2.7** | `/permissions` / `/doctor` 显示最近一次分类 reason（本地） | 手工/测 |
| **Y2.8** | 文档：费用提示（每危险工具可能多一次调用） | PERMISSIONS / 本文件 |

**出口：** headless 可开 auto，危险操作经模型批/拒；**fail-closed**。  
**相对 HC YOLO 语义：~40–50%。**  
**建议默认「可合并主线」的第一里程碑。**

---

### Y3 — 敢用：清洗、熔断、路径/危险库

| ID | 任务 | 验收 |
|----|------|------|
| **Y3.1** | 进入 auto 时 `stripDangerousAllows`（Bash 全工具 allow、过宽 prefix 等） | 单测；进模前后 rules 对比 |
| **Y3.2** | 会话熔断：连续 N 次 unavailable/超时 → 退出 auto 或强制 ask | 单测 |
| **Y3.3** | `dangerousPatterns` 最小表（rm -rf、curl\|sh、磁盘格式化等）→ 直接 deny 或强制分类 | 单测 |
| **Y3.4** | 敏感路径（`.ssh`、`.git/config`、系统目录）→ deny 或 classifier 必问 | 单测 |
| **Y3.5** | 子 agent：auto 下仍遵守 S8；Agent 工具默认不白名单 | 单测 |
| **Y3.6** | 可选：分类结果写入 `system_note`（审计，不进模型链） | 可选 |

**出口：** 误配置 allow 不易架空 auto；故障可熔断。  
**相对 HC YOLO 语义：~65–75%。**

---

### Y4 — 对齐 HC 行为深度（冲 ~90%）

| ID | 任务 | 验收 |
|----|------|------|
| **Y4.1** | 两阶段：fast 否决 / 再 deep（或 HC 式 stage1/2 语义） | 测：明显安全跳过 deep |
| **Y4.2** | 分类器上下文：压缩后的 transcript 投影（控制 token） | 文档上限 + 测 |
| **Y4.3** | PowerShell / cmd 危险模式（Windows）最小 | 测 |
| **Y4.4** | plan 模式与 auto 组合策略（HC plan+auto 语义选一：plan 禁止写 或 plan 内只读分类） | 文档钉死 + 测 |
| **Y4.5** | 对抗用例集：`scripts/test-auto-classifier-adversarial.ts` | CI 可跑 mock |

**出口：** 行为接近 HC auto **日用路径** ~85–90%。  
**仍不宣称** 权限 UI/企业策略 90%。

---

## 5. 与现有模块关系

| 模块 | 关系 |
|------|------|
| `PERMISSIONS.md` 规则层 | **保持**；auto 挂在规则层之后 |
| Hooks PermissionRequest | auto 下：建议 **分类器优先于 UI**；hooks 仍可在 Pre 阶段 block |
| STE / interrupt | 不替代权限；分类在 execute 前 |
| Subagent S8 | auto 不提升子权限 rank |
| Providers | 分类器用当前 session model 或可配置 `autoClassifierModel` |
| 无遥测 | 本地 reason / 可选 debug 文件 only |

---

## 6. 测试策略

| 层级 | 内容 |
|------|------|
| 单元 | allowlist、strip、parse decision、dangerous、path |
| 门控集成 | mock classifier → allow/deny/unavailable |
| 回归 | 现有 `test-permissions.ts` 全绿（auto 不破坏四档） |
| 对抗（Y4） | 伪装「安全」的破坏性 Bash 字符串 |

**禁止：** 仅 e2e 真网才算过（必须 mock）。

---

## 7. 文档与 TODO 勾选约定

| 阶段 | `TODO.md` ID 建议 | 状态写法 |
|------|-------------------|----------|
| Y0 | YOLO-Y0 | 文档 ✅ |
| Y1 | YOLO-Y1 | 模式骨架 ✅ |
| Y2 | YOLO-Y2 | **可用 auto** ✅ |
| Y3 | YOLO-Y3 | 敢用 ✅ |
| Y4 | YOLO-Y4 | ~90% 语义 ✅ |

全局 `TODO.md` §8 写：

> 专项见 **`docs/TODO_AUTO_PERMISSIONS.md`**；默认从 **Y0→Y2** 串行；Y3/Y4 可按风险继续。

**禁止** 在 Y1 把「完整 YOLO」勾成 ✅。

---

## 8. 建议执行顺序（串行）

```text
Y0 规格 ──► Y1 模式+白名单 ──► Y2 真分类器（首个可发布）
                                    │
                                    ▼
                              Y3 清洗+熔断+危险库
                                    │
                                    ▼
                              Y4 两阶段/对抗/~90%
```

**并行支线（不挡 Y2）：** 分类器 prompt 文案打磨、doctor 展示、费用说明。

**不要并行：** 完整官方插件市场深度、Electron 权限 UI（另册）。

---

## 9. 风险与开放决策（实现前可再钉）

| # | 决策点 | 建议默认 |
|---|--------|----------|
| D1 | auto 下分类失败：deny 还是 ask？ | **deny**（headless 更安全）；CLI 可配置 ask |
| D2 | 分类器用哪个 model？ | 默认 `session.model`；可选更小/更便宜 model |
| D3 | 是否把分类对话写入 transcript？ | **默认否**；可选 system_note 审计 |
| D4 | mode 循环是否包含 auto？ | 是，夹在 acceptEdits 与 bypass 之间 |
| D5 | bypass 是否可与分类器并存？ | **否**；bypass 仍绕过分类器（但 always-deny 仍生效） |

---

## 10. 完成定义（本专题 Done）

1. **Y2 全部验收 ✅**（可用 auto，fail-closed）  
2. **Y3 全部验收 ✅**（清洗 + 熔断 + 最小危险/路径）  
3. **Y4** 达到 §1.3 表 A–J 中标注的 90% 门槛  
4. 现有四档权限回归绿  
5. 文档：`PERMISSIONS.md` + 本文状态与代码一致  
6. **无遥测**  

**非 Done：** 仅添加 `auto` 字符串、分类器恒 allow、无测试。

---

## 11. 与全局 ROADMAP 映射

| 全局 | 本专题 |
|------|--------|
| M-Tool+Permission 🟡 | 规则层已 🟡；**auto 走 Y0–Y4** |
| `TODO.md` 下一刀 | 指向本文 Y0 开工 |
| 插件市场 PL-MKT | **无关**；已最小交付 |
| Electron / T8 | 权限 UI 后置，不阻塞 Y2 |

---

## 12. 一句话

> **规则权限已有半成品；auto/YOLO 从零按 Y0→Y4 专册推进。Y2 为第一个可发布「真自动」；Y3+Y4 才谈相对 HC auto 语义的九成。**

**开工默认第一刀：Y0.1–Y0.3 落文档类型 → 立即 Y1.1–Y1.3。**  
实现时对照 HC 语义重写，禁止大段复制；文档无本机绝对路径。