# Bolo Code 总任务清单（TODO）

> **执行入口**：勾选与优先级以本文为准；里程碑/能力矩阵见 `docs/ROADMAP.md`；专项细节见各 `docs/*.md`。  
> 更新：对齐 **MCP Streamable HTTP + transport 抽象** + 已交付主路径；完成度按 **主路径 vs 相对 HC** 诚实口径。  
> 原则：无遥测；对照参考实现语义再实现；不把 stub 当完成；**状态按代码行为写**，不按错误 commit subject。

---

## 0. 怎么用

| 文档 | 角色 |
|------|------|
| **本文 `TODO.md`** | **P0→P3 总序**、跨模块依赖、**本周默认下一刀** |
| `ROADMAP.md` | 里程碑、能力矩阵、验收表（不重复长篇勾选） |
| `AGENT_LOOP.md` | loop / 错误分类 / model·PTL 重试 |
| `COMPACTION.md` | compact 管道 · auto 阈值 · micro · token 启发式 |
| `TOOL_CALLING.md` / `PERMISSIONS.md` | 工具管道 · 权限门控 · always-allow |
| `MCP.md` | MCP transport · 配置 · `/mcp` |
| `TODO_SESSION_JSONL.md` | JSONL 存盘专项（主路径已齐；余量 entry/CLI） |
| 其它 `docs/*.md` | 契约真源 |

**规则：** 一次只推进 **一条主切片**（可并行一条「文档/纯 UI 无模型」支线）。

---

## 1. 一句话现状

```text
主路径可跑（脚本/CLI）：
  bolo / --resume / --continue · 斜杠 + rules · C1–C5 · JSONL 默认写
  · Subagent · MCP stdio 面 + Streamable HTTP 最小 · plugins 最小 · Responses HTTP
  · Loop 韧性最小 · Tool+Permission 日用最小
  · Compact 日用加深（加权 token 估 · 压力 · /context·/compact · 熔断）
  · Usage+ 本地 breakdown（cache · byModel · /cost）
  · RC2 思考链二期（Responses reasoning SSE · /thinking 显示开关）

相对参考实现 headless 约 40–55%（勿再写 ~70% 乐观数）。
P0 抬水位：
  1. ~~Loop 韧性~~ ✅ 最小
  2. ~~Tool+Permission 日用~~ ✅ 最小
  3. ~~长会话 compact 加深~~ ✅ 最小
P1：
  4. ~~MCP 远程 transport（HTTP + 抽象）~~ ✅ 最小
  5. ~~思考链流式显示~~ ✅ 最小
  6. ~~PL2 插件深化~~ ✅ 最小
  7. ~~Usage+ 本地 breakdown~~ ✅ 最小
  8. ~~RC2 思考链二期~~ ✅ 最小（本刀）
  下一刀：经典 SSE 长连接 ·（或）CP/TP 余量 / C6+
```

| 优先级 | 含义（当前） |
|--------|----------------|
| **P0** | 抬 headless 水位：韧性 / TP / **CP 日用** 已 🟡 |
| **P1** | 扩展深度（**MCP HTTP ✅** · **RC1+RC2 ✅** · **PL2 ✅** · **Usage+ ✅**）— **默认下一刀区：经典 SSE / 余量** |
| **P2** | 未做或仅最小的子项 |
| **P3** | GUI / 完整 Ink / 后置协议 |

粗估（相对 HC headless）：**~40–55%**。主路径可日用 ≠ 产品完成。

---

## 2. 已交付（勿再当「缺口」）

### 2.1 会话与 CLI

| ID | 内容 | 状态 |
|----|------|------|
| **RS1–RS9** | `listProjectSessions`；`--resume` 无 id 列表选择；非 TTY；双格式；表格 picker；`--continue` | ✅ |
| **T0–T7** | BOLO banner + 吉祥物；无参 TTY 新会话；状态行/工具行/权限 y/n；接 slash；resume 缩略 banner | ✅ |
| **J-A/B** | JSON + `.jsonl` 双写 | ✅（**历史过渡**；非当前默认） |
| **J-C / J-C+** | `loadTranscriptMessages`；JSON 缺失回退；双文件 messages 优先 jsonl（非空） | ✅ 最小 |
| **J-D** | R1 `compact_boundary` · 空/坏 jsonl 回退 · list 跟 jsonl · 冲突策略 | ✅ |
| **J-D T3** | **默认只写 jsonl** · meta 配置切片 · `migrateSessionToJsonl` · 旧 JSON 只读 | ✅ |

### 2.2 斜杠 · Rules · Cache · Creators

| ID | 内容 | 状态 |
|----|------|------|
| **SL0–SL5** | 总线 + `/help` `/compact` `/clear` `/context` `/model` `/effort` `/plan` `/permissions`…；`/skills` + `/<skill-id>` 回落 | ✅ |
| 扩展 slash | `/doctor` `/status` `/mcp` `/plugins` `/hooks` `/init` `/cost` `/usage` `/rules` `/agents` `/bg` `/allow` | ✅ |
| **SL-polish** | `/help` 分组 · 未知建议 · `/context` token/sections/cache · 参数 Usage · 别名隐藏 | ✅ |
| **R1–R4 / R3b** | `.bolo/rules` + 用户 rules；`paths` 作用域；submitPrompt 刷新；`/rules` | ✅ |
| **C1–C5** | 稳定前缀布局 + Anthropic `cache_control` + OpenAI/Responses `prompt_cache_key` | ✅ |
| **K1–K2** | bundled `skill-creator` / `plugin-creator` | ✅ |

### 2.3 扩展 · Provider · 会话策略

| ID | 内容 | 状态 |
|----|------|------|
| **S0–S7** | `runSubagent` + Agent 工具 + `.bolo/agents` + `/agents` | ✅ |
| **S7+ / S12 partial** | 侧链 `agent-*.jsonl`；`run_in_background` + `/bg`；fork 继承父 messages 最小 | ✅ 最小 |
| **MCP1** | MCP stdio listTools/call → tools 表 | ✅ |
| **MCP2 stdio 面** | resources/prompts + meta 工具 + `/mcp` 子命令 | ✅ |
| **MCP2 list_changed** | tools/resources/prompts 通知 → 再 list → 缓存 + `session.tools` 热刷新 | ✅ |
| **MCP2 HTTP** | `McpClient` 抽象 + Streamable HTTP（`type: http` / url）+ 错误隔离 + `/mcp` transport/status | ✅ 最小 |
| **PL1** | 本地 plugins 发现 + skills/hooks/mcp 合并（非市场） | ✅ 最小 |
| **PL2** | 热加载 + commands 贡献 + `/plugins` 深化 | ✅ 最小（本刀） |
| **OR1–OR5** | OpenAI Responses HTTP SSE 直连 | ✅ |
| 其它 | 真 `apply_patch` · **Usage+** 本地 `/cost`（cache·byModel）· tool_result 预算 · 快照/meta 中 permissionRules/effort/usage | ✅ |

### 2.4 Loop 韧性

| ID | 内容 | 状态 |
|----|------|------|
| **LR1–LR6** | 错误分类 + model 退避 + Bash timeout/abort；与 PTL 正交 | ✅ 最小 |

### 2.5 Tool + Permission 日用

| ID | 内容 | 状态 |
|----|------|------|
| **TP1** | 内置 **Edit**（`old_string`/`new_string`；默认唯一匹配；`replace_all`；清晰错误） | ✅ 最小 |
| **TP2** | always-allow：**path glob** + **Bash 命令前缀**；`/allow path:…` `/allow bash:…`；快照兼容 | ✅ 最小 |
| **TP3** | plan 仍 deny 写/壳；bypass 仍全开；工具名 always-allow 保留 | ✅ |
| **TP4** | Bash/Read/Write/Edit/apply_patch 中段 **AbortSignal** → `Error: tool cancelled` | ✅ 最小 |
| **TP5** | schema 校验失败 → `<tool_use_error>`（既有，测试覆盖） | ✅ |
| **TP-doc** | `TOOL_CALLING.md` / `PERMISSIONS.md` / ROADMAP / TODO | ✅ |

### 2.6 Compact 日用加深

| ID | 内容 | 状态 |
|----|------|------|
| **CP1** | 加权 token 启发式：正文≈chars/4；密文 JSON≈chars/2；**tool_calls** 计入；与 `/context` 同源 | ✅ 最小 |
| **CP2** | auto 阈值常量显式化 + `getContextPressure`（ok/warn/critical/over）；临近窗口才 critical | ✅ 最小 |
| **CP3** | auto 失败熔断加固（连续失败不拖垮 turn）；compact **不改** `systemPromptSections` | ✅ 最小 |
| **CP4** | `/context`：messages/system 分拆、window/threshold/pressure、prepare 顺序；`/compact` 报告前后 token | ✅ 最小 |
| **CP-doc** | `COMPACTION.md` / `AGENT_LOOP.md` / ROADMAP / TODO；`test-context-slash` | ✅ |

**明确后置（CP 余量）：** cached microcompact / snip 全管线 / 默认开 `autoCompactEnabled` / 真 tokenizer。

### 2.7 MCP 远程 transport

| ID | 内容 | 状态 |
|----|------|------|
| **MCP-T1** | `McpClient` 接口；stdio / http 共用 host listTools/call · resources/prompts · list_changed 路径 | ✅ |
| **MCP-T2** | Streamable HTTP：`type: http` + `url` + `headers`；JSON 与 SSE 响应帧；`Mcp-Session-Id` | ✅ 最小 |
| **MCP-T3** | 错误隔离：远程失败不拖垮 stdio 其它 server | ✅ |
| **MCP-T4** | `/mcp` 显示 transport + status | ✅ |
| **MCP-T5** | fixture + `scripts/test-mcp-http.ts` | ✅ |
| **MCP-doc** | `MCP.md` / ROADMAP / TODO / ARCHITECTURE | ✅ |

**明确后置：** 经典 SSE 长连接（`type: sse`）· OAuth · headersHelper · 插件市场。

### 2.8 插件深化（PL2 本刀）

| ID | 内容 | 状态 |
|----|------|------|
| **PL2-1** | `contributes.commands` / 默认 `commands/*.md` → 命名空间 slash | ✅ |
| **PL2-2** | `reloadSessionPlugins`：重扫合并 skills/hooks/mcp/commands；刷新 skill catalog | ✅ |
| **PL2-3** | `/plugins` list · `commands` · `reload`；别名 `/reload-plugins` | ✅ |
| **PL2-4** | 插件 slash 注入 user 消息；内置优先；未知命令建议含插件名 | ✅ |
| **PL2-5** | 默认 reload 重连 MCP（含插件 contributes）；fixture `test-plugins-pl2` | ✅ |
| **PL2-doc** | ARCHITECTURE / CONFIG / SLASH / MCP / ROADMAP / TODO | ✅ |

**明确后置（PL 余量）：** 市场 / 远程安装 / 参数模板引擎 / 文件监视自动 reload。

---

## 3. P0 — 抬 headless 水位（默认主刀区）

| ID | 主题 | 说明 | 状态 |
|----|------|------|------|
| **LR*** | Loop 韧性 | 分类 + model 退避 + 与 PTL 分工 | ✅ 最小 |
| **TP*** | Tool+Permission 日用 | Edit、path/bash always-allow、中段 abort | ✅ 最小 |
| **CP*** | 长会话 compact | 加权估 · 压力 · boundary 前缀 · `/context`·`/compact` | ✅ 最小 |

---

## 4. P1 — 紧随（扩展深度与体验）— **默认下一刀区**

| ID | 主题 | 说明 | 状态 |
|----|------|------|------|
| **MCP2 余量** | 远程 transport | **Streamable HTTP + 抽象** 已接 host；经典 SSE 长连接后置 | ✅ 最小 |
| **RC1** | 思考链流式显示 | provider 解析 → queryLoop → CLI dim；不持久化回灌 | ✅ 最小 |
| **RC2** | Reasoning 加深 | openai-responses reasoning SSE；`/thinking` 显示开关；**跳过** ChatMessage 回灌 | ✅ 最小（本刀） |
| **PL2** | plugins 深度 | 热加载 / commands 贡献 / `/plugins reload` | ✅ 最小 |
| **Usage+** | 本地 usage 展示 | cache 字段 + byModel + `/cost` breakdown；快照/meta 持久化 | ✅ 最小 |
| **J-D 余量** | entry / CLI | 更多 entry 类型；CLI `migrate-session` 包装 | 🟡 可选支线 |
| **C6+** | Cache 后置 | 1h TTL / global scope / break detection / cached MC | ⬜ **后置** |
| **TP 余量** | permission 深度 | 完整分类器 / StreamingToolExecutor / 更强 apply_patch | ⬜ 后置 |
| **CP 余量** | compact 再深 | 默认开 auto · snip · cached MC · 真 tokenizer | ⬜ 后置 |
| **MCP-SSE** | 经典 SSE 长连接 | `type: sse` 真实现（配置已预留） | ⬜ 可选 |

---

## 5. P2 — 扩展与协议

| ID | 主题 | 状态 |
|----|------|------|
| **S8+** | 子 agent 权限细化 · 并行策略 · worktree | 🟡 / ⬜ |
| **OR6** | Responses **WebSocket** | ⬜ **后置**（HTTP SSE 已够用） |
| Skills+ | 远程 skill / 动态 discovery 预取 | ⬜ |
| MCP 插件热重载 | 插件变更后重挂 MCP | 🟡 最小（跟 PL2 reload） |

---

## 6. P3 — 后置

| ID | 主题 | 状态 |
|----|------|------|
| **T8** | 完整 Ink TUI / 箭头键 picker | ⬜ |
| **T9** | 主题 · 窄终端 · 吉祥物开关 | ⬜ |
| **M4** | Electron GUI | ⬜ |
| S14+ | Worktree 隔离 · swarm/teammate | ⬜ |
| 其它 | 企业策略 · 完整 model 目录… | ⬜ |

**不做：** 远程遥测、GrowthBook、抄 Claude 商标/IP。

---

## 7. 推荐执行顺序（当前）

```text
已完成主线：
  RS* · SL* · SL-polish · T0–T7 · R* · C1–C5 · J-A/B/C · J-D(+T3)
  · K* · S0–S7 · MCP1 · MCP2(stdio + list_changed + HTTP 最小) · PL1 · OR1–OR5
  · LR* · TP* · CP* 长会话 compact 日用最小 · RC1 思考链显示最小 · PL2 插件热加载最小
  · Usage+ 本地 breakdown 最小 · RC2 思考链二期最小

下一阶段：
  ① 经典 SSE 长连接 / CP 余量 / TP 余量   ← 默认主刀区（P1 余量）
  ② C6+ / OR6 / T8 / Electron  （后置）
```

---

## 8. 本周默认「下一刀」

若只开一刀（**非 Electron**）：

> **主推：经典 SSE 长连接**（MCP `type: sse` 真实现）或 **CP/TP 余量**（P1 余量）  
> - 勿一口做完整市场 / OAuth MCP / 完整 Ink  
>
> **本刀已勾选：** **RC2**（openai-responses reasoning SSE · `/thinking` 显示开关 · 不回灌 ChatMessage · 无遥测）。  
> **明确后置：** 思考链安全回灌 · Anthropic thinking budget · 插件市场 · OAuth · cached MC · snip · 默认开 auto · OR6 · C6+ · T8 · Electron · 完整 permission 分类器 · 远程 USD 账单。

**已齐摘要：** resume · slash · BOLO TUI 最小 · rules · C1–C5 · JSONL 主路径 · creators · Subagent · MCP stdio+HTTP 最小 · **plugins PL1+PL2 最小** · Responses HTTP · Loop 韧性最小 · Tool+Permission 日用最小 · Compact 日用加深最小 · **RC1+RC2 思考链** · **Usage+ 最小**。

---

## 9. 与 ROADMAP 里程碑映射

| TODO | ROADMAP |
|------|---------|
| LR* | M-Loop 韧性 🟡 |
| TP* | M-Tool+Permission 🟡 |
| CP* | 长会话 compact 🟡 最小 |
| RS* · T* | M5.2 / M-TUI（T0–T7 ✅；T8 ⬜） |
| SL* · SL-polish | M-Slash ✅ |
| R* | M-Rules ✅ |
| C* | M-Cost（C1–C5 ✅；C6+ 后置） |
| **Usage+** | 本地 usage breakdown ✅ 最小 |
| **RC1 · RC2** | 思考链流式 + Responses reasoning + `/thinking` ✅ 最小 |
| J* | M5.1 / `TODO_SESSION_JSONL`（J-D T3 ✅） |
| K* | M-Creators ✅ |
| S* | M-Subagent（S0–S7 ✅；S12 partial） |
| MCP* · PL* | M3（stdio + HTTP ✅；**PL2 ✅ 最小**；SSE 长连接 ⬜） |
| **OR*** | Responses：HTTP SSE ✅；WS 后置 |
| M4 | Electron ⬜ |

---

## 10. 检查清单（开 PR 前）

- [ ] 无遥测  
- [ ] 文档无本机绝对路径  
- [ ] 相关 `scripts/test-*.ts` 绿  
- [ ] 更新本文对应 ⬜→✅，并扫一眼 `ROADMAP` 总览是否仍一致  
- [ ] stub / mock 未勾成「完成」  
- [ ] commit message 与 tree 一致（勿复用旧 `COMMITMSG`）  
- [ ] 完成度区分主路径 vs 相对 HC  

---

**一句话：**  
RC2（Responses reasoning · `/thinking`）已落地；**下一刀：经典 SSE 或 CP/TP 余量**；市场 / cached MC / snip / 回灌勿抢。