# Bolo Code 整体路线图（详细版）

> 更新：对齐 **auto Y0–Y4 最小 + PL-MKT 最小 + Y3.6 审计 note**；主路径与相对 HC 分口径。  
> **勾选与「下一刀」以 `docs/TODO.md` 为准**；本文件回答：**做到哪 / 缺什么 / 验收 / 里程碑**。  
> 原则：借鉴参考实现 **语义**再实现；**无遥测**；文档无本机绝对路径；**状态按代码行为**，不按错误 commit subject。

---

## 0. 一句话进度

| 层 | 粗估 | 说明 |
|----|------|------|
| **Headless 核心**（loop / tools / provider / compact / prompt） | **~60–70%** | 主路径可用；**STE ✅**；**规则权限 ✅**；**auto Y0–Y4 最小 ✅**（~85–90% HC auto **语义**）；**snip 最小 ✅**；仍缺 cached MC、SnipTool/UUID、完整 YOLO 企业/UI 层 |
| 会话与 CLI | **~70–80%** | JSONL 默认写（T3）；resume/continue；title/system_note；无参 REPL；非成熟 Ink |
| **扩展面（MCP / Plugins / Skills）** | **~60–70%** | Skills + MCP stdio/HTTP/SSE 最小 + list_changed + **PL2 热加载 ✅**；**PL-MKT 最小 ✅**（本地/URL 清单 install）；官方市场深度 / OAuth ⬜ |
| **Subagent** | **~50–60%** | 真 loop + Agent + 目录定义；async/fork 最小；S8 不升级；worktree ⬜ |
| **项目规则 Rules** | **~75–85%** | 装载 + paths + 刷新 + `/rules` |
| **内置元技能 Creators** | **~70–80%** | skill/plugin-creator 最小 |
| **成本与缓存** | **~45–55%** | C1–C5 标记 ✅；TTL / break / 深度 usage 后置 |
| **斜杠命令** | **~70–80%** | 总线 + 日用 + SL-polish |
| **CLI TUI** | **~35–45%** | T0–T7 最小；完整 Ink ⬜ |
| **Electron GUI** | **~5%** | 占位 |
| **产品整体（可日用 headless agent）** | **~40–55%** | 相对 HelsincyCode headless；**主路径可脚本/CLI 跑**；auto/PL-MKT 抬了权限与扩展水位，**不**把整体抬到 ~70% |

**口径说明：**

| 口径 | 含义 |
|------|------|
| **主路径** | createSession → queryLoop → provider → tools → JSONL/CLI 可闭环 |
| **相对 HC** | 对照参考实现能力密度（loop 韧性、tool/permission 日用、compact、MCP 面） |
| **auto 语义** | 仅对照 HC auto/YOLO **行为**（headless）；见 `TODO_AUTO_PERMISSIONS.md`（**~85–90%**，非 UI/企业策略） |

**当前主线（执行序见 `TODO.md`）：**

1. ~~斜杠总线 + SL-polish · Rules · Creators · C1–C5 · resume/TUI 最小 · JSONL · Subagent · MCP stdio · plugins 最小 · Responses HTTP~~ ✅  
2. ~~**Loop 韧性**（错误分类 + 429/5xx 有限退避；与 PTL 正交）~~ ✅ 最小  
3. ~~**Tool+Permission 日用**（Edit、path/bash always-allow、中段 abort）~~ ✅ 最小  
4. ~~**长会话 compact 加深**（加权 token · 压力 · `/context`·`/compact` · 熔断）~~ ✅ 最小  
5. ~~**MCP 远程 transport**（`McpClient` 抽象 + Streamable HTTP）~~ ✅ 最小  
6. ~~**PL2 插件深化**（热加载 · commands · `/plugins reload`）~~ ✅ 最小  
7. ~~**Usage+**（`/cost` cache + by-model breakdown · 本地可观测）~~ ✅ 最小  
8. ~~**RC2**（Responses reasoning SSE · `/thinking` 显示开关）~~ ✅ 最小  
9. ~~**MCP-SSE**（经典 SSE 长连接）~~ ✅ 最小  
10. ~~**CP5**（默认开 auto · 环境熔断 · `/autocompact`）~~ ✅ 最小  
11. ~~**TP 余量：StreamingToolExecutor 最小**~~ ✅ 最小  
12. ~~**TP-PERM：permission 规则匹配小步**~~ ✅ 最小（always-deny + Bash 通配）  
13. ~~**CP-SNIP：snip 最小**~~ ✅ 最小  
14. ~~**J-D 余量：title entry + CLI list/migrate**~~ ✅ 最小  
15. ~~**J-D 再余量：system_note + lite list**~~ ✅ 最小  
16. ~~**TP-STE+ / HK / S8**~~ ✅ 最小  
18. ~~**TP-PATCH+ · RC3 · MCP-SSE 重连**~~ ✅ 最小  
19. ~~**PL-MKT 插件市场最小**~~ ✅ 最小  
20. ~~**Auto/YOLO Y0–Y4 最小**~~ ✅（两阶段 + 危险/PS 硬拦 + 熔断 demote + 对抗测 + **Y3.6 审计 note**）  
21. **下一主线：扩展三层** — Skill 可移植 → MCP 通用 → Bolo 插件规范（**`docs/TODO_SKILL_MCP_PLUGIN.md`**）  
22. **后置（需确认）：** 官方 marketplace 深度 · MCP OAuth · OR6 · T8 · Electron · worktree · 完整 YOLO 企业策略  

---

## 1. 产品目标与硬优先级

| 目标 | 说明 |
|------|------|
| 跨平台 GUI | Electron（一致性优先）；**先 CLI 可日用** |
| Headless Core | CLI / GUI / 自动化同一套 |
| **CLI 体验** | `bolo` 欢迎 + 会话 REPL；品牌 **BOLO** + 原创吉祥物 |
| 扩展面 | Skill · MCP · Hook · **Subagent** · 插件 |
| **项目规则** | `.bolo/rules` 注入；`/rules`；path-scoped |
| **可控成本** | 裁剪 + **prompt cache 标记** + **effort** |
| **可操作会话** | `/` 命令总线 |
| 工程纪律 | 对照参考再写；无遥测 |

```
契约 → Agent loop + Hook + Permission
  → Provider + Tools + System + Compact
  → 会话持久化 + CLI/TUI 最小
  → Loop 韧性（分类 + 退避）+ Tool/Permission 日用
  → 斜杠 + Rules + Creators + Cache 标记
  → Skills / MCP / Plugins / Subagent
  → 扩展深度（HTTP MCP ✅ · PL2 ✅ · Usage+ ✅ · RC2 ✅ · SSE 长连接可选）
  → Electron · 完整 Ink · 生产化打磨
```

---

## 2. 能力矩阵（全景）

> 状态：✅ 可用 · 🟡 最小/半成品 · ⬜ 缺失 · 🚫 明确不做

### 2.1 运行时核心

| 能力 | 状态 | 备注 |
|------|------|------|
| queryLoop / Hooks / 权限 | ✅/🟡 | 四档 + **`auto`**；always-allow/deny；Bash 通配；**auto 两阶段分类器 + 硬拦 + 熔断 + system_note 审计**；plan 仍 deny 写 |
| **Loop 韧性：错误分类 + model 退避** | 🟡 最小 | `errorClassify` + `wrapCallModelWithRetry`；默认 3 次；事件 `model_retry` |
| PTL 截断重试 | ✅ | 与 model 退避正交 |
| buildTool + 分区并发 + 常用工具 | ✅/🟡 | **Edit** ✅ 最小；真 apply_patch；Write；schema → tool_use_error |
| **StreamingToolExecutor**（边流边跑） | 🟡 最小+ | queryLoop 收 `tool_call` 即调度；保序 drain；Bash 级联；`discard`；**tool_progress**；**interruptBehavior**（Bash=cancel，默认 block） |
| tool 中段 AbortSignal | 🟡 最小 | Bash/Read/Write/Edit/apply_patch 尊重 abort |
| Provider：OpenAI 兼容 / Anthropic / **openai-responses** / mock | ✅ | Responses：**HTTP SSE** ✅；WS ⬜ |
| **思考链流式显示**（reasoning / thinking） | 🟡 最小+ | RC1–RC3：显示 + `/thinking persist` 回灌 + Anthropic budget 最小；adaptive ⬜ |
| System prompt + BOLO.md + Rules | ✅ | |
| Skill catalog + Skill 工具 + slash 调 skill | ✅ | 远程 skill ⬜ |

### 2.2 上下文 · 成本 · Effort

| 能力 | 状态 | 对资源的影响 |
|------|------|----------------|
| Full / auto / micro compact · PTL | ✅/🟡 | 加权 token 估 + pressure；默认 **`autoCompactEnabled: true`**；`BOLO_DISABLE_*` 熔断；`/autocompact`；**snip 最小 ✅**（门槛+安全 cut+边界）；cached MC / SnipTool 后置 |
| Skill catalog-only | ✅ | 降输入 |
| **Effort** low/medium/high/max/auto | ✅ | session + `/effort` → max_tokens |
| Prompt Cache 布局 + **API 标记** | ✅ | C1–C5：`cache_control` / `prompt_cache_key` |
| 大 tool_result 预算 | ✅ | 截断 + 可选 spill |
| `/context` `/cost` 本地可见 | ✅ | `/context` 分拆+pressure；`/cost` Usage+：cache + by-model |

### 2.3 项目规则 Rules

| 能力 | 状态 | 说明 |
|------|------|------|
| `.bolo/rules/**/*.md` + 可选 `~/.bolo/rules` | ✅ | 见 `docs/RULES.md` |
| 装载进 system（与 BOLO.md 分层） | ✅ | |
| frontmatter：`paths` / `alwaysApply` / `disabled` | ✅ | |
| **submitPrompt 刷新 path-scoped rules** | ✅ | 仅换 volatile `# Project rules` |
| `/rules` list · show | ✅ | enable/disable 持久化可加深 |
| 与 prompt cache 协同 | 🟡 | 变更会 break；稳定排序 + API 标记已接 |

### 2.4 内置元技能 / Creator

| 能力 | 状态 | 说明 |
|------|------|------|
| **skill-creator** / **plugin-creator** | ✅ | `packages/bundled-skills/` |
| slash 回落 `/skill-creator` 等 | ✅ | |
| rule-creator（可选） | ⬜ | 后置 |
| 远程市场 | 🚫/⬜ | 不强制 |

### 2.5 会话与 CLI / TUI

| 能力 | 状态 |
|------|------|
| JSON 快照 + `bolo --resume <id\|path>` | ✅ 只读兼容 |
| **`bolo --resume` 无 id → 项目列表选择** | ✅ |
| `listProjectSessions`（json + jsonl 去重；count/preview 跟 jsonl R1） | ✅ |
| `bolo --continue` | ✅ |
| JSONL **默认写** + R1 boundary + meta 配置切片 + migrate + 旧 JSON 只读 | ✅ J-D T3 |
| **`title` entry** + `/title` + list title + CLI `--list` / `--migrate-session` | ✅ J-D 余量最小 |
| **无参 `bolo` TTY 新会话 + banner** | ✅ |
| 状态行 / 流式工具行 / 权限 y/n / slash | ✅ |
| 完整 Ink 级 TUI | ⬜ T8 |
| SQLite | 🚫 现阶段 |

### 2.6 斜杠命令 `/xxx`

| 簇 | 示例 | 状态 |
|----|------|------|
| 总线 | 解析 `/`、help、skill 回落 | ✅ |
| 会话 | `/clear` `/compact` `/context` `/cost` | ✅ | compact 报前后 token；context 含压力 |
| 模型与推理 | `/model` **`/effort`** `/plan` `/permissions` `/allow` `/deny` | ✅ |
| 扩展 | `/skills` `/mcp` `/plugins` `/hooks` **`/rules`** `/agents` `/bg` | ✅ |
| 诊断脚手架 | `/doctor` `/status` `/init` | ✅ |
| 体验打磨 | `/help` 分组 · 未知建议 · `/context` 加深 · 别名隐藏 | ✅ **SL-polish** |
| 元技能 | `/skill-creator` `/plugin-creator`（skill 回落） | ✅ |
| 工程 | `/diff` `/commit` `/review`… | ⬜ 后置 |
| 产品周边 | login/theme/vim/remote… | 🚫 或后置 |

### 2.7 Subagent

| 能力 | 状态 | 说明 |
|------|------|------|
| Hook SubagentStart/Stop | ✅ | |
| `runSubagent` + Agent 工具 | ✅ | 废 stub |
| 内置 explore / general（+ fork） | ✅ | 禁嵌套 Agent |
| `.bolo/agents` 目录定义 | ✅ | |
| 同步摘要回写父 tool_result | ✅ | |
| 异步 / 后台 | ✅ 最小 | `run_in_background` + `/bg` |
| Fork 继承父 messages | ✅ 最小 | 无 worktree / 无完整 cache 共享 |
| 侧链 transcript | ✅ 最小 | `agent-*.jsonl` |
| `/agents` | ✅ | |
| Worktree / swarm | ⬜ | P3 |
| 遥测 / GrowthBook | 🚫 | |

### 2.8 扩展面 · GUI

| 能力 | 状态 |
|------|------|
| MCP stdio tools | ✅ |
| MCP resources/prompts（stdio）+ meta 工具 + `/mcp` | ✅ |
| MCP **list_changed 热刷新**（tools/resources/prompts） | ✅ |
| MCP **transport 抽象 + Streamable HTTP** | ✅ 最小 |
| MCP 经典 SSE 长连接（`type: sse`） | ✅ 最小 |
| Plugins 本地加载 | ✅ 最小 |
| Plugins 热加载 / commands（PL2） | ✅ 最小 |
| Plugins 市场最小（PL-MKT） | ✅ 最小；官方市场深度 / OAuth ⬜ |
| Subagent 真 loop | ✅ |
| Electron | ⬜ |

---

## 3. 里程碑详述

### M0–M2 ✅

契约 → 窄链路 → 真 Provider / 工具 / system+BOLO / compact（含 micro、PTL）。

### M2.9 / M-Cost — 缓存与 Token 🟡

| 切片 | 状态 |
|------|------|
| C1–C4 布局 + 稳定前缀测试 | ✅ |
| C5 API 标记（`promptCache.ts` 等） | ✅ |
| tool 结果预算 | ✅ 最小 |
| 1h TTL / break detection / cached MC | ⬜ 后置 |

Effort：`/effort` + provider 映射 ✅。

### M2.10 / M-Slash — 斜杠命令 ✅

总线 + 日用命令 + **SL-polish**（分组 `/help`、未知建议、`/context` token/sections/cache、参数 Usage、隐藏别名）已落地（见 §2.6、`docs/SLASH_COMMANDS.md`）。工程类 slash 后置。

### M2.11 / M-Rules — 项目规则 ✅

| # | 切片 | 状态 |
|---|------|------|
| R1–R2 | 发现 + 注入 + 预算 | ✅ |
| R3 | frontmatter paths 等 | ✅ |
| R3b | submitPrompt 刷新 path-scoped | ✅ |
| R4 | `/rules` | ✅ |
| R5–R6 | init 布局 + `RULES.md` | ✅ |

### M2.12 / M-Creators — 内置 creator ✅

K1–K2 + slash 回落 ✅；rule-creator 可选 ⬜。

### M3 — 扩展面 🟡

| # | 切片 | 状态 |
|---|------|------|
| 3.1 Skills | ✅ catalog + 工具 + slash；远程 ⬜ |
| 3.2 MCP stdio tools | ✅ |
| 3.2b MCP resources/prompts + meta + `/mcp` | ✅ |
| 3.2c MCP list_changed 热刷新 | ✅（stdio） |
| 3.2d MCP Streamable HTTP + client 抽象 | ✅ 最小 |
| 3.2e MCP 经典 SSE 长连接 | ✅ 最小 |
| 3.3 Plugins 真加载 | ✅ 最小（本地）；**PL2 热加载 ✅**；**PL-MKT 最小 ✅**；官方市场深度 ⬜ |
| 3.4 Subagent | ✅ 见 M-Subagent |

### M3.4 / M-Subagent ✅（最小完成线 + partial 加深）

| # | 切片 | 状态 |
|---|------|------|
| S0–S7 | 文档 · 定义 · runSubagent · Agent · 项目 agents | ✅ |
| S8 | 子权限更严（不升级） | ✅ 最小 |
| S9 | 侧链 jsonl | ✅ 最小 |
| S10 | 并发策略（Agent 串行） | ✅ 文档/默认 false |
| S11 | `/agents` | ✅ |
| S12 | fork 继承 / 后台 async | ✅ 最小 |
| S13–S14 | 通知打磨 / worktree | ⬜ |

契约：`docs/SUBAGENT.md`。

### M4 — Electron ⬜

门禁建议：headless 日用已满足；GUI 仍后置。Subagent UI 卡片更后。

### M5 — 生产化 🟡

| # | 切片 | 状态 |
|---|------|------|
| 5.1 会话持久化 | ✅ JSON 只读兼容 + **JSONL 默认写（T3）** + migrate + R1 resume + list 跟 jsonl |
| 5.2 CLI 入口 | ✅ resume 无 id / continue / 无参新建 |
| 5.3 多平台构建 | ⬜（GUI 后；CLI 已跨平台可用） |
| 5.4 micro + PTL | ✅ |
| 5.5 真 patch | ✅ 最小 |
| 5.6 本地 trace | ⬜ |

### M5.T / M-TUI — CLI 终端 UI 🟡

| # | 切片 | 状态 |
|---|------|------|
| T0–T7 | 文档 · banner · 无参会话 · 状态/流式/权限 · slash · resume 列表 | ✅ |
| T7b | `--continue` | ✅ |
| T8 | 完整 Ink | ⬜ |
| T9–T10 | 主题 / 共享品牌资源 | ⬜ |

`bolo --resume` 无 id：**已实现**（项目 scope 默认）。

### M6 — 体验 ⬜

插件市场 UX、TUI 主题包等；**不做**远程遥测。

```mermaid
flowchart TB
  M0[M0 契约 ✅]
  M1[M1 窄链路 ✅]
  M2[M2 真干活 ✅]
  MCost[M-Cost C1–C5 ✅]
  MSlash[M-Slash ✅]
  MRules[M-Rules ✅]
  MCreators[M-Creators ✅]
  MSub[M-Subagent ✅]
  MTUI[M-TUI T0–T7 ✅]
  M3[M3 MCP/Plugins 🟡]
  M5[M5 会话/CLI 🟡]
  M4[M4 Electron ⬜]
  M0 --> M1 --> M2
  M2 --> MSlash
  M2 --> MRules
  M2 --> MCost
  M2 --> M5
  M2 --> MSub
  M5 --> MTUI
  MSlash --> MTUI
  MSlash --> MCreators
  MRules --> MCreators
  MSlash --> M3
  MSub --> M3
  M3 --> M4
  MTUI --> M4
  M5 --> M4
  MCost --> M4
  MSub --> M4
```

---

## 4. 缓存 · Token · Effort（摘要）

| 种类 | 作用 | Bolo |
|------|------|------|
| 上下文裁剪 | 少送字 | micro/full/catalog **有** |
| Prompt Cache | 前缀命中 | **C1–C5 ✅**（布局 + API 标记） |
| **Effort** | 推理强度档 | ✅ session + `/effort` |

**后置：** tool 预算加深、1h TTL / global scope、cached microcompact、cache break detection。

详：`docs/PROMPT_CACHE.md`。

---

## 5. 斜杠命令详表（对照 HC 子集）

> Bolo **只抄** coding agent 相关语义；无遥测。实现：`packages/core/src/slash.ts` · `docs/SLASH_COMMANDS.md`。

### 5.1 路由语义

```text
输入以 / 开头
  → 内置注册表
  → 同名 skill（user-invocable）  ← skill-creator / plugin-creator
  → 未知：建议 + help 提示
```

### 5.2 已落地（日用）

| 命令 | 行为 |
|------|------|
| `/help` | 分组列命令 |
| `/compact` `/clear` `/context` | 压缩 / 清对话 / 上下文概览（token/sections/cache） |
| `/model` `/effort` `/plan` `/permissions` `/allow` `/deny` | 模型 · 档位 · 模式 · always-allow/deny |
| `/rules` `/skills` `/skill` · `/<id>` | 规则与技能 |
| `/mcp` `/plugins` `/hooks` | 扩展状态 |
| `/agents` `/bg` | 子代理 / 后台 |
| `/cost` `/usage` | 本地累计 |
| `/doctor` `/status` `/init` | 诊断与脚手架 |

### 5.3 后置

`/diff` `/commit` `/review` `/export` `/branch` `/rewind` …；login/theme/vim/remote 等 **不抄或后置**。

---

## 5b. Subagent（摘要）

| | 状态 |
|--|------|
| Agent 工具 + `runSubagent` | ✅ |
| explore / general / 项目 agents | ✅ |
| fork / async / 侧链 | ✅ 最小 |
| worktree / swarm | ⬜ |

模块：`packages/core/src/subagent.ts` · `docs/SUBAGENT.md` · `scripts/test-subagent.ts`。

**红线：** 禁止 stub 当完成；禁止无限递归 Agent；禁止遥测；失败 `is_error` 回父。

---

## 5c. CLI TUI / 品牌（摘要）

| 项 | 状态 / 约定 |
|----|-------------|
| TTY `bolo` → 欢迎 + 新会话 | ✅ |
| 字标 **BOLO** + 原创吉祥物 | ✅（见 `BRAND.md`） |
| 完整 Ink | ⬜ T8 |
| 降级 plain / 非 TTY | ✅ |

---

## 6. Rules 与 BOLO.md 分层

| 层 | 路径 | 用途 |
|----|------|------|
| 身份/系统 | 代码内 sections | 产品行为 |
| 用户规则 | `~/.bolo/rules/*.md` | 个人约束 |
| 项目规则 | **`.bolo/rules/*.md`** | 团队约束 |
| 项目说明 | `BOLO.md` | 总览（已有） |
| Skills | skills 目录 | 流程知识；默认 catalog-only |

**不要**用 skill 冒充 rules。

---

## 7. 易漏模块检查单（校准后）

| 模块 | 状态 |
|------|------|
| 斜杠总线 · SL-polish · `/effort` · `/rules` | ✅ |
| `.bolo/rules` + path-scoped 刷新 | ✅ |
| skill-creator / plugin-creator | ✅ |
| Subagent 真 loop / Agent | ✅；worktree ⬜ |
| Prompt cache C1–C5 | ✅ |
| JSONL 默认写 + R1/list + migrate + meta 切片 | ✅ J-D T3 |
| Usage 本地记账 | ✅ Usage+ 最小（cache + byModel + `/cost`） |
| openai-responses HTTP SSE | ✅；WS ⬜ |
| MCP stdio + resources/prompts + list_changed | ✅ |
| MCP Streamable HTTP + `McpClient` 抽象 | ✅ 最小 |
| MCP 经典 SSE 长连接（`type: sse`） | ✅ 最小 |
| Plugins 本地最小 | ✅ |
| Plugins 热加载 + commands（PL2） | ✅ 最小 |
| Plugins 市场最小（PL-MKT） | ✅ 最小；官方深度 / OAuth ⬜ |
| Undo / 多模态 / 沙箱 | ⬜ 后置 |
| 遥测 | 🚫 |

---

## 8. 包职责（现状）

| 包 | 已承担 |
|----|--------|
| `core` | loop · slash · rules · transcript · subagent · session |
| `config` | layout（rules/agents/skills…）· workspace 加载 |
| `tools` | builtins（含 Edit）· Agent · apply_patch |
| `skills` | 发现 · catalog · bundled |
| `plugins` / `mcp` | 本地加载 · stdio/http/**sse** host（resources/prompts/list_changed） |
| `cli` | banner · REPL · resume picker · `submitUserInput` |
| `providers` | effort · usage · **promptCache** · openai-responses |

---

## 9. 排期轨道（校准）

| 轨道 | 内容 | 状态 |
|------|------|------|
| A 交互 | 斜杠 · SL-polish · rules · skills · creators | ✅ |
| B 成本 | C1–C5 | ✅；C6+ 后置 |
| C 存盘 | JSONL A–D + **J-D T3**（默认 jsonl / migrate / meta / R1） | ✅ 主路径 |
| D 扩展 | Subagent · MCP（stdio + HTTP + **SSE 最小**）· plugins PL1+PL2 · **PL-MKT 最小** | ✅ 最小；**官方市场深度 · OAuth ⬜** |
| E TUI | T0–T7 | ✅；T8 ⬜ |
| F GUI | Electron | ⬜ 后置 |
| G 协议 | Responses HTTP | ✅；WS 后置 |
| H 韧性 | 错误分类 + model 退避 + PTL | 🟡 最小 |
| I 权限 auto | Y0–Y4 最小 + Y3.6 审计 note | ✅ 最小（HC auto 语义 ~85–90%；UI/企业 ⬜） |

**默认下一刀：** 见 **`docs/TODO.md` §8** + **`docs/TODO_SKILL_MCP_PLUGIN.md`**（**M-GEN-8** 或 **M-GEN-6**）。

---

## 10. 工作方式与红线

1. 参考 HC 语义 → findings → 最小切片 → 测绿 → 更新 **TODO** 与本文件总览  
2. mock **不**冒充 MCP/Plugins/Subagent 完成  
3. Compact 禁止无摘要 truncate  
4. 改 system 布局考虑 cache break  
5. **禁止遥测**  
6. rules/creator **不**要求联网市场  
7. Subagent **禁止**无限递归  
8. TUI **禁止**抄袭第三方 IP；提供 plain 模式  
9. commit message **与 tree 一致**（勿复用陈旧 `COMMITMSG` 文件）  
10. 完成度分 **主路径** vs **相对 HC**；骨架/最小标 🟡，勿标满 ✅  

---

## 11. 文档地图

| 文档 | 用途 |
|------|------|
| **本文件** | 里程碑 / 能力矩阵 / 验收 |
| **`TODO.md`** | **执行入口 + 下一刀** |
| **`TODO_AUTO_PERMISSIONS.md`** | **Auto/YOLO 分类器专项（Y0–Y4）** |
| **`TODO_SKILL_MCP_PLUGIN.md`** | **Skill 可移植 · MCP 通用 · Bolo 插件规范** |
| `PERMISSIONS.md` | 规则门控 + **auto 分类器路径**（与 YOLO 企业层正交） |
| `AGENT_LOOP.md` | loop · 错误分类 · model/PTL 重试 |
| `TODO_SESSION_JSONL.md` | JSONL 专项（主路径已齐） |
| `PROMPT_CACHE.md` | C1–C5 与后置 |
| `PLUGINS.md` | 插件 · PL-MKT 最小市场（Spec v0 见专册 PL-SPEC） |
| `SLASH_COMMANDS.md` · `RULES.md` · `SUBAGENT.md` | 契约 |
| `TUI.md` · `BRAND.md` | 欢迎与品牌 |
| `SESSIONS.md` · `PROVIDERS.md` · `MCP.md` · `SKILLS.md` | 会话 / 厂商 / 扩展 |
| `ENGINEERING_PRINCIPLES.md` | 纪律 |

---

## 12. 近期 main 水位（节选）

> 按 **代码行为** 标注；个别 commit subject 曾与 tree 不符，以本表与代码为准。

| commit | 内容（代码行为） |
|--------|------------------|
| *(本刀)* | **Y3.6**：auto 分类 `system_note` 审计（`kind=auto_classify`；不进模型链） |
| *(近主线)* | **auto Y0–Y4 最小** + **PL-MKT 最小**（见 TODO；subject 以代码为准） |
| *(近主线)* | **J-D 余量**：`title` entry · `/title` · list · CLI `--list` / `--migrate-session` |
| `08047b7` | **CP-SNIP**：snip 最小（门槛裁前缀 · tool 安全 cut · `History snipped` · prepare 写回 · snip→micro→auto） |
| `bd99c95` | **TP-STE**：StreamingToolExecutor 最小（边流边跑 · 保序 · Bash 级联 · discard · queryLoop 接入） |
| `19cf680` | **CP5**：默认 auto compact + 环境熔断 + `/autocompact` |
| `3ec8b52` | **Loop 韧性**：`errorClassify` + `wrapCallModelWithRetry`；queryLoop `model_retry`；文档口径诚实化 |
| `b7a4ccc` | **MCP2 list_changed 热刷新**（tools/resources/prompts → 缓存 + session.tools）；subject 曾误写为 J-D T3 |
| `11ded88` | **J-D T3**：默认 JSONL 写、meta 配置切片、`migrateSessionToJsonl` |
| `a8aed34` | MCP2 resources/prompts（stdio）+ meta 工具 + `/mcp` |
| `2c02ef8` | J-D：R1 compact_boundary、双文件冲突/回退、list 更准 |
| `2b6721e` | SL-polish：分组 help / 建议 / richer `/context` |
| `12ec371` | C5 prompt cache API 标记 |
| `5b0251f` | path-scoped rules submitPrompt 刷新 |
| `ee3eaff` | openai-responses HTTP SSE |
| `1fe6060` | 快照持久化 permissionRules/effort/usage |
| `eef3b90` / `c04280f` | fork / 后台 subagent |
| `66616cf` 等 | `/plugins` + 会话挂载 plugins |

---

## 13. 总览表（汇报用）

| 里程碑 | 状态 | 一句话 |
|--------|------|--------|
| M0–M2 | ✅/🟡 | headless 主路径可跑；相对 HC 未满 |
| **M-Loop 韧性** | 🟡 最小 | 分类 + 429/5xx 有限退避；PTL 正交 |
| **M-Tool+Permission** | 🟡/✅ auto | 规则层 ✅；**auto Y0–Y4 最小 ✅**（~85–90% HC auto **语义**；UI/企业策略 ⬜） |
| **M-Compact 日用** | 🟡 最小 | 加权 token · pressure · `/context`·`/compact`；**默认 auto ✅**；**snip 最小 ✅**；cached MC / SnipTool 后置 |
| **M-Slash** | ✅ | 日用 `/` + SL-polish |
| **M-Rules** | ✅ | `.bolo/rules` + path-scoped + `/rules` |
| **M-Creators** | ✅ | bundled creators |
| **M-Subagent** | 🟡 | S0–S7 + **S8 权限不升级** + async/fork/侧链最小 |
| **M-TUI** | 🟡 | T0–T7 ✅；T8 Ink ⬜ |
| **M-Cost** | 🟡 | C1–C5 ✅；TTL/break 后置 |
| **M3** | 🟡 | MCP stdio + list_changed + **HTTP/SSE 最小** + **PL2 热加载最小** + **PL-MKT 最小**；官方市场深度 / OAuth ⬜ |
| **M5** | 🟡 | 会话/CLI 可用；JSONL 主路径 T3 ✅；title/list/migrate ✅；**system_note+lite list ✅** |
| **Responses** | 🟡 | HTTP SSE ✅；WS ⬜ |
| M4–M6 | ⬜ | Electron 与体验打磨 |

**一句话：**  
Headless **主路径可日用**，相对参考实现约 **40–55%**（文档不再写 ~70% 乐观数）。  
**规则权限 + auto Y0–Y4 最小已齐**（HC auto **语义** ~85–90%；Y3.6 审计 note ✅；UI/企业策略 ⬜）。  
**PL-MKT 最小已齐**（本地/URL 清单 install；非官方市场全家桶）。  
扩展下一主线：**Skill → MCP → Bolo 插件规范**（`docs/TODO_SKILL_MCP_PLUGIN.md`；默认 **S-PORT-1**）。  
后置：官方市场深度 / MCP OAuth / T8 / Electron。  
执行序 → **`docs/TODO.md`**。