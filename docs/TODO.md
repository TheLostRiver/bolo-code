# Bolo Code 总任务清单（TODO）

> **执行入口**：勾选与优先级以本文为准；细节切片见 `docs/ROADMAP.md` 与各专项 TODO。  
> 更新：对齐 HC `cli --resume`（无 id → **当前项目**会话列表可选）+ 全盘优先级。  
> 原则：无遥测；对照 HelsincyCode 语义再实现；不把 stub 当完成。

---

## 0. 怎么用

| 文档 | 角色 |
|------|------|
| **本文 `TODO.md`** | **P0→P3 总序**、跨模块依赖、本周默认下一刀 |
| `ROADMAP.md` | 里程碑、能力矩阵、验收表 |
| `TODO_SESSION_JSONL.md` | JSONL 存盘专项 |
| 其它 `docs/*.md` | 契约真源 |

**规则：** 一次只推进 **一条 P0 主切片**（可并行一条「文档/纯 UI 无模型」支线）。

---

## 1. 优先级总览

```text
P0  立刻影响「像成熟 agent / 对齐 HC 日用」
P1  体验与省成本，紧随 P0
P2  扩展面与深度能力
P3  GUI / 打磨 / 后置
```

| 优先级 | 主题 | 一句话 |
|--------|------|--------|
| **P0-a** | **`--resume` 无 id 会话列表** | 对齐 HC：项目相关会话列表 → 用户选择进入 |
| **P0-b** | **斜杠总线 + 最小命令** | `/help` `/compact` `/context` `/effort` `/model` `/clear`… |
| **P0-c** | **`bolo` 无参新会话 + BOLO 欢迎** | TUI 最小可见产品（可与 a/b 交错） |
| **P1-a** | **`.bolo/rules` + `/rules`** | 项目约束装载 |
| **P1-b** | **Prompt 缓存友好前缀** | 省 token |
| **P1-c** | **JSONL transcript 双写** | 按 `TODO_SESSION_JSONL` A+B |
| **P1-d** | **内置 skill-creator / plugin-creator** | 元技能 |
| **P2-a** | **Subagent 真 loop（S0–S6）** | ✅ 废 stub，Agent 工具 |
| **P2-b** | **MCP stdio** | 真连接，禁止 mock 冒充 |
| **P2-c** | Plugins / Subagent 目录定义 / JSONL 侧链 | |
| **P3** | Electron · 完整 Ink · fork/async agent | |

---

## 2. P0 — 必须先做

### P0-a · `bolo --resume` 无会话 id → 项目列表选择（对齐 HC）

**HC 行为：** `cli --resume` **不填 id** → 展示**与当前项目相关**的会话列表 → 用户选择进入。  
**Bolo 现状：** 必须 `--resume <id|path>`；无列表、无选择器（`parseArgs` 强制 value）。

| ID | 任务 | 验收 | 状态 |
|----|------|------|------|
| **RS1** | `listProjectSessions(cwd)` 扫 `{cwd}/.bolo/sessions/*`（先 JSON 快照） | 单测：临时目录多文件排序 | ✅ |
| **RS2** | CLI：`--resume` / `-r` **允许无 value** | `parseArgs` + help 文案 | ✅ |
| **RS3** | TTY：编号列表 + 选择 → `resumeSession` | 手工 + 测 | ✅ |
| **RS4** | 非 TTY：打印列表，要求显式 id，exit≠0 | 测 | ✅ |
| **RS5** | 空列表提示新建 `bolo` | | ✅ |
| **RS6** | 列表字段：id · mtime · preview · 消息数 | | ✅ |
| **RS7** | JSONL 双格式列表 | `*.json`+`*.jsonl` 去重 | ✅ |
| **RS8** | 表格列表 + id/过滤/q 取消（非箭头键；跨平台 readline） | 美化 picker | ✅ |
| RS9 | `--continue` 最近一条 | P1 捷径 | ✅ |

**范围钉死：** 默认 **仅当前项目** sessions；全局 `~/.bolo/sessions` 需显式 flag（如 `--scope user`）再议。

**依赖：** 现有 `resumeSession` / 快照即可；**不**阻塞 JSONL。

---

### P0-b · 斜杠命令总线（M-Slash 最小）

| ID | 任务 | 状态 |
|----|------|------|
| SL0 | `docs/SLASH_COMMANDS.md` 契约 | ✅ |
| SL1 | `parseSlash` + 注册表 + `submitUserInput` | ✅ |
| SL2 | `/help` `/compact` `/clear` `/context` | ✅ |
| SL3 | `/model` **`/effort`** `/plan` `/permissions` | ✅ |
| SL4 | CLI REPL 走 `submitUserInput` | ✅ |

详见 `ROADMAP.md` §5。

---

### P0-c · CLI 可见产品（M-TUI 最小）

| ID | 任务 | 状态 |
|----|------|------|
| T0 | `docs/TUI.md` + `docs/BRAND.md`（吉祥物定稿） | ✅ |
| T1 | `renderWelcomeBanner`：**大写 BOLO** + 原创吉祥物 ASCII | ✅ |
| T2 | `bolo` **无参 TTY** → 新会话 + banner + 输入循环 | ✅ |
| T3–T6 | 状态行 / 流式工具行 / 权限 y/n / 接 slash | ✅（T4–T6：`23b51c7`） |
| T7 | 与 **RS\*** 合流：resume 路径也显示缩略 banner | ✅（轻量一行） |

吉祥物候选：Bolot / Nyxkit / Pipkin / Glim（**择一**，禁止抄第三方 IP）。

---

## 3. P1 — 紧随

| ID | 主题 | 关键切片 | 状态 |
|----|------|----------|------|
| R1–R2 | **`.bolo/rules` 发现 + 注入** | M-Rules | ✅ |
| R4 | `/rules` | 依赖 Slash | ✅ |
| C1–C4 | **Prompt 静态/动态边界 + 前缀稳定测试** | M-Cost（`PROMPT_CACHE.md` + stable/volatile + `test-prompt-cache`） | ✅ |
| J-A/B | **JSONL 双写** | `TODO_SESSION_JSONL` Phase A+B（commit 19f7594） | ✅ |
| J-C | **JSONL resume 起步** | `loadTranscriptMessages` + JSON 缺失回退 | ✅ 最小 |
| K1–K2 | **skill-creator / plugin-creator** | M-Creators | ✅ |
| SL5 | `/skills` + `/<skill-id>` 回落 | | ✅ |

---

## 4. P2 — 扩展与深度

| ID | 主题 | 状态 |
|----|------|------|
| S0–S6 | **Subagent** 真 `runSubagent` + Agent 工具；废 stub | ✅ |
| MCP1 | **MCP stdio** listTools/call → 进 tools 表 | ✅ |
| PL1 | Plugins 真加载（本地发现 + skills/hooks/mcp 合并；非市场） | ✅ 最小 |
| S7 | `.bolo/agents` 目录定义（frontmatter + 覆盖内置 + `/agents`） | ✅ |
| S7+ | 侧链 transcript · 权限细化 | ✅ 最小（agent-*.jsonl + Stop path） |
| J-C+ | JSONL resume 主路径优先 · list 增强（RS7） | ✅（双文件 messages 优先 jsonl；RS7 列表） |

---

## 5. P3 — 后置

| ID | 主题 | 状态 |
|----|------|------|
| M4 | Electron GUI | ⬜ |
| T8 | 完整 Ink TUI | ⬜ |
| S12+ | Fork 继承上下文 / 异步 agent / worktree | 🟡 partial（async：`run_in_background` + `/bg` ✅；fork 继承父 messages 最小 ✅；worktree ⬜） |
| 其它 | 真 apply_patch ✅ 最小 · **usage 本地累计** `/cost` ✅ · 会话 always-allow + tool_result 预算 ✅ · **快照持久化** permissionRules/effort/usage ✅ · 企业策略… | 🟡 |

**不做：** 远程遥测、GrowthBook、抄 Claude 商标/IP。

---

## 6. 推荐执行顺序（串行主线）

```text
① RS1–RS6     bolo --resume 无 id 项目列表选择   ← 对齐 HC，收益大、依赖少
② SL0–SL3     斜杠 P0（含 /effort）
③ T0–T2       BOLO 欢迎 + 无参新会话
④ R1–R2       .bolo/rules
⑤ C1–C4       prompt cache 布局
⑥ J-A/B       JSONL 双写
⑦ K1–K2       creators
⑧ S0–S6       Subagent 真实现
⑨ MCP1        MCP stdio
⑩ T3–T7 / M4  TUI 加深 → Electron
```

**可并行支线（不抢 P0 主线程）：**

- T0–T1 纯 banner/ASCII（无模型）  
- `SUBAGENT.md` / `RULES.md` / `SLASH_COMMANDS.md` 文档  
- `PROMPT_CACHE.md` 规格  

---

## 7. 本周默认「下一刀」

若只开一刀：

> **OpenAI Responses HTTP SSE 已实现**（OR1–OR5）；OR6 WebSocket 后置。  
> **Electron / 完整 Ink T8** 后置。

已齐：resume / slash / BOLO TUI / rules / cache / JSONL / creators / Subagent / MCP / plugins / usage+effort / always-allow / apply_patch / **openai-responses 直连**。

---

## 8. 与 ROADMAP 里程碑映射

| TODO | ROADMAP |
|------|---------|
| RS* | M5.2 / M-TUI T7 / § resume 选择器 |
| SL* | M-Slash |
| T* | M-TUI |
| R* | M-Rules |
| C* | M-Cost |
| J* | M5.1 / `TODO_SESSION_JSONL` |
| K* | M-Creators |
| S* | M-Subagent |
| MCP* | M3.2 |
| **OR*** | **OpenAI Responses 直连** ✅ HTTP SSE；WS 后置 |
| M4 | Electron |

---

## 9. 检查清单（开 PR 前）

- [ ] 无遥测  
- [ ] 文档无本机绝对路径  
- [ ] 相关 `scripts/test-*.ts` 绿  
- [ ] 更新本文对应 ⬜→✅  
- [ ] stub / mock 未勾成「完成」  

---

**一句话：**  
日用 CLI 主路径已齐；**Electron 后置**；下一协议刀：**OpenAI Responses 原生直连**（保留 Chat Completions；Codex 只读 `codex-api` responses 定点，不通读全仓）。