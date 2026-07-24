# Bolo Code 总任务清单（TODO）

> **执行入口**：勾选与优先级以本文为准；里程碑/能力矩阵见 `docs/ROADMAP.md`；专项细节见各 `docs/*.md`。  
> 更新：对齐 auto Y0–Y4 + PL-MKT + Y3.6；**扩展主线见 `TODO_SKILL_MCP_PLUGIN.md`（Skill→MCP→Bolo 插件）**。  
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
| **`TODO_AUTO_PERMISSIONS.md`** | **Auto/YOLO 分类器专项（Y0–Y4）；与规则层正交** |
| **`TODO_SKILL_MCP_PLUGIN.md`** | **Skill 可移植 · MCP 通用 · Bolo 插件规范（S-PORT / M-GEN / PL-SPEC）** |
| `MCP.md` | MCP transport · 配置 · `/mcp` |
| `SKILLS.md` | Skill 目录 · catalog · Skill 工具 |
| `PLUGINS.md` | 插件 · PL-MKT 最小市场 |
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
  · **CP 余量小步**：默认开 auto · 环境熔断 · `/autocompact`
  · **TP 余量小步**：StreamingToolExecutor 边流边跑（queryLoop 主路径）
  · **TP-PERM**：permission 规则匹配小步（always-deny · Bash 通配 · `/deny`）
  · **CP-SNIP**：snip 最小（门槛裁前缀 · 安全 cut · prepare 写回）
  · Usage+ 本地 breakdown（cache · byModel · /cost）
  · RC2 思考链二期（Responses reasoning SSE · /thinking 显示开关）
  · MCP-SSE 经典 SSE 长连接（type:sse · endpoint 事件 · list_changed）
  · **PL-MKT** 插件市场最小（register/search/install）
  · **auto Y0–Y4 最小**（两阶段分类 · 危险/PS 硬拦 · 熔断 demote · 对抗测 · **Y3.6 system_note 审计**）

相对参考实现 headless 约 **40–55%**（勿再写 ~70% 乐观数）。
auto **语义**（仅对照 HC YOLO 行为，非 UI/企业）：**~85–90%**。
P0 抬水位：~~LR / TP 日用 / CP 日用~~ ✅ 最小
P1 主切片：~~MCP HTTP/SSE · PL2 · PL-MKT · Usage+ · RC* · STE · PERM · snip · J-D · auto Y0–Y4+Y3.6~~ ✅ 最小
  下一刀：**Skill 可移植（S-PORT）** → 见 `docs/TODO_SKILL_MCP_PLUGIN.md`
```

| 优先级 | 含义（当前） |
|--------|----------------|
| **P0** | 抬 headless 水位：韧性 / TP / CP 日用 已 🟡 |
| **P1** | **扩展三层：** Skill 可移植 → MCP 通用 → Bolo 插件规范（专册）；auto / PL-MKT 最小已 ✅ |
| **P2** | 未做或仅最小的子项 |
| **P3** | GUI / 完整 Ink / 后置协议 |

粗估（相对 HC headless 整体）：**~40–55%**。主路径可日用 ≠ 产品完成。

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
| **J-D 余量** | **title entry**（last-wins · 不进模型链）· `/title` · list 展示 title · CLI `--list` / `--migrate-session` | ✅ 最小 |
| **J-D 再余量** | **system_note** entry · `/note` · rewrite 保留 · **scanTranscriptLite** list · 近况 preview | ✅ 最小（本刀） |

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
| **S8** | 子 agent 权限不升级 | `resolveSubagentPermissionMode`：子 mode rank ≤ 父；不可绕过到 bypass | ✅ 最小（本刀） |
| **HK1** | Hooks 超时硬化 | 默认 30s · 上限 600s · exit 124 · `timedOut` | ✅ 最小（本刀） |
| **HK2** | Hooks AbortSignal | `runHooks`/`runCommandHook` 支持 signal；tool/Stop/submit 透传 | ✅ 最小（本刀） |
| **MCP1** | MCP stdio listTools/call → tools 表 | ✅ |
| **MCP2 stdio 面** | resources/prompts + meta 工具 + `/mcp` 子命令 | ✅ |
| **MCP2 list_changed** | tools/resources/prompts 通知 → 再 list → 缓存 + `session.tools` 热刷新 | ✅ |
| **MCP2 HTTP** | `McpClient` 抽象 + Streamable HTTP（`type: http` / url）+ 错误隔离 + `/mcp` transport/status | ✅ 最小 |
| **MCP-SSE** | 经典 SSE 长连接（`type: sse`）+ endpoint 事件 + POST 消息 + list_changed | ✅ 最小（本刀） |
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
| **TP2** | always-allow：**path glob** + **Bash 前缀/通配/`:*`**；`/allow path:…` `/allow bash:…`；快照兼容 | ✅ 最小 |
| **TP3** | plan 仍 deny 写/壳；**bypass 仍可被 always-deny 拦住**；工具名 always-allow 保留 | ✅ |
| **TP4** | Bash/Read/Write/Edit/apply_patch 中段 **AbortSignal** → `Error: tool cancelled` | ✅ 最小 |
| **TP5** | schema 校验失败 → `<tool_use_error>`（既有，测试覆盖） | ✅ |
| **TP-STE** | **StreamingToolExecutor** 最小：边流边跑 · 入队序 drain · Bash 级联 · discard · queryLoop 接入 | ✅ 最小 |
| **TP-STE+** | **progress + interruptBehavior**：`tool_progress` 事件 · Bash `cancel` / 默认 `block` · CLI dim 进度行 | ✅ 最小（本刀） |
| **TP-PERM** | **规则匹配小步**：always-deny（工具/前缀/path/bash）· Bash 通配 · `/deny` · 快照/meta；**非** YOLO | ✅ 最小 |
| **TP-doc** | `TOOL_CALLING.md` / `PERMISSIONS.md` / ROADMAP / TODO | ✅ |

### 2.6 Compact 日用加深

| ID | 内容 | 状态 |
|----|------|------|
| **CP1** | 加权 token 启发式：正文≈chars/4；密文 JSON≈chars/2；**tool_calls** 计入；与 `/context` 同源 | ✅ 最小 |
| **CP2** | auto 阈值常量显式化 + `getContextPressure`（ok/warn/critical/over）；临近窗口才 critical | ✅ 最小 |
| **CP3** | auto 失败熔断加固（连续失败不拖垮 turn）；compact **不改** `systemPromptSections` | ✅ 最小 |
| **CP4** | `/context`：messages/system 分拆、window/threshold/pressure、prepare 顺序；`/compact` 报告前后 token | ✅ 最小 |
| **CP5** | 默认开 `autoCompactEnabled`；`BOLO_DISABLE_AUTO_COMPACT` / `BOLO_DISABLE_COMPACT` 环境熔断；`/autocompact` + prepare 重挂 | ✅ 最小 |
| **CP-SNIP** | **snip 最小**：token/条数门槛 · 安全 cut（tool 配对）· `History snipped` 边界 · prepare 写回 · snip→micro→auto | ✅ 最小（本刀） |
| **CP-doc** | `COMPACTION.md` / `AGENT_LOOP.md` / ROADMAP / TODO；`test-context-slash` · `test-auto-compact` · `test-snip` | ✅ |

**明确后置（CP 再后）：** cached microcompact / SnipTool·UUID 回放 / 真 tokenizer。

### 2.7 MCP 远程 transport

| ID | 内容 | 状态 |
|----|------|------|
| **MCP-T1** | `McpClient` 接口；stdio / http 共用 host listTools/call · resources/prompts · list_changed 路径 | ✅ |
| **MCP-T2** | Streamable HTTP：`type: http` + `url` + `headers`；JSON 与 SSE 响应帧；`Mcp-Session-Id` | ✅ 最小 |
| **MCP-T3** | 错误隔离：远程失败不拖垮 stdio 其它 server | ✅ |
| **MCP-T4** | `/mcp` 显示 transport + status | ✅ |
| **MCP-T5** | fixture + `scripts/test-mcp-http.ts` | ✅ |
| **MCP-doc** | `MCP.md` / ROADMAP / TODO / ARCHITECTURE | ✅ |

**明确后置：** OAuth · headersHelper · 插件市场 · SSE 自动重连预算。

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
| **MCP2 余量** | 远程 transport | **Streamable HTTP + 抽象** 已接 host | ✅ 最小 |
| **MCP-SSE** | 经典 SSE 长连接 | `type: sse` · GET 长连接 · endpoint · POST 消息 · list_changed | ✅ 最小（本刀） |
| **RC1** | 思考链流式显示 | provider 解析 → queryLoop → CLI dim；不持久化回灌 | ✅ 最小 |
| **RC2** | Reasoning 加深 | openai-responses reasoning SSE；`/thinking` 显示开关；**跳过** ChatMessage 回灌 | ✅ 最小 |
| **PL2** | plugins 深度 | 热加载 / commands 贡献 / `/plugins reload` | ✅ 最小 |
| **PL-MKT** | 插件市场最小 | 本地/URL 清单 · register/search/install/uninstall · 无官方策略 | ✅ 最小 |
| **YOLO-Y0…Y4** | auto 分类器 | 模式 · 白名单 · 两阶段 · 硬拦 · 熔断 demote · 对抗测 | ✅ 最小（~85–90% HC auto 语义） |
| **Y3.6** | auto 审计 note | `kind=auto_classify` system_note；不进模型链；失败静默 | ✅ 最小（本刀） |
| **Usage+** | 本地 usage 展示 | cache 字段 + byModel + `/cost` breakdown；快照/meta 持久化 | ✅ 最小 |
| **J-D 余量** | entry / CLI | **title** + `/title` + list title + `--list` + `--migrate-session` | ✅ 最小 |
| **J-D 再余量** | system_note / lite | **system_note** + `/note` + `scanTranscriptLite` list | ✅ 最小 |
| **C6+** | Cache 后置 | 1h TTL / global scope / break detection / cached MC | ⬜ **后置** |
| **TP 余量** | permission / STE | **STE ✅** · **TP-STE+ ✅** · **TP-PERM ✅** · **auto Y4 ✅**；完整企业 YOLO / sandbox 仍后置 | 🟡 企业层 ⬜（需确认） |
| **CP 余量** | compact 再深 | **默认开 auto ✅**；**snip 最小 ✅**；cached MC · SnipTool/UUID · 真 tokenizer 仍后置 | 🟡 snip 最小已齐；其余 ⬜ |

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
  · Usage+ 本地 breakdown 最小 · RC2 思考链二期最小 · MCP-SSE 经典 SSE 最小
  · CP5 默认 auto + 环境熔断 + /autocompact 最小
  · TP-STE StreamingToolExecutor 边流边跑最小
  · TP-PERM permission 规则匹配小步（always-deny · Bash 通配 · /deny）
  · CP-SNIP snip 最小（门槛 · 安全 cut · prepare 写回）
  · J-D 余量 title entry + CLI --list / migrate-session
  · J-D 再余量 system_note + /note + scanTranscriptLite list
  · TP-STE+ tool_progress + interruptBehavior（Bash cancel）
  · HK1–HK2 hooks 超时/abort · S8 子权限不升级
  · TP-PATCH+ Move/Rename · RC3 reasoning persist + Anthropic thinking budget · MCP-SSE 重连
  · **PL-MKT** 插件市场最小（register/search/install）
  · **auto Y0–Y4 + Y3.6**（两阶段 · 硬拦 · 熔断 · 对抗 · system_note 审计）

下一阶段：
  ① **Skill → MCP → Bolo 插件规范** — `docs/TODO_SKILL_MCP_PLUGIN.md`（S-PORT → M-GEN → PL-SPEC）
  ② 后置（需确认）：官方市场深度 / MCP OAuth / OR6 / T8 / Electron / 企业 YOLO
```

---

## 8. 本周默认「下一刀」

若只开一刀（**非 Electron**）：

> **扩展主线专册已落盘：** `docs/TODO_SKILL_MCP_PLUGIN.md`  
> - 序：**Skill 可移植（S-PORT）→ MCP 通用（M-GEN）→ Bolo 插件 Spec（PL-SPEC）**  
> - **默认下一刀：** 后置项需确认（OAuth · IMPORT · 市场深度 · Electron）  
> - **S-PORT ✅** · **M-GEN-0..6+8 ✅** · **PL-SPEC ✅**  
> - 红线：不接 Claude/Codex 官方市场；插件以 `bolo.*` 为一等公民  
> - 已齐：auto Y0–Y4 + Y3.6 · PL-MKT 最小 · MCP 三 transport 最小  

---

## 9. 与 ROADMAP 里程碑映射

| TODO | ROADMAP |
|------|---------|
| LR* | M-Loop 韧性 🟡 |
| TP* · STE · PERM · PATCH+ | M-Tool+Permission 🟡/✅ auto |
| **YOLO-Y0…Y4 · Y3.6** | **`TODO_AUTO_PERMISSIONS.md` / M-Tool+Permission auto** |
| CP* · SNIP | 长会话 compact 🟡 |
| RC1–RC3 | 思考链 |
| **S-PORT* · M-GEN* · PL-SPEC*** | **`TODO_SKILL_MCP_PLUGIN.md` / M3 扩展加深** |
| MCP* · **PL-MKT** | M3（**PL-MKT 最小 ✅**；官方市场深度 ⬜） |
| M4 / T8 | Electron / Ink ⬜ |

---

## 10. 检查清单（开 PR 前）

- [ ] 无遥测  
- [ ] 文档无本机绝对路径  
- [ ] 相关 `scripts/test-*.ts` 绿  
- [ ] YOLO 阶段仅按 `TODO_AUTO_PERMISSIONS.md` 勾选（勿越级）  
- [ ] stub / mock 未勾成「完成」  
- [ ] commit message 与 tree 一致  
- [ ] 完成度区分主路径 vs 相对 HC  

---

**一句话：**  
auto / PL-MKT 最小已齐。扩展下一主线：**Skill 可移植 → MCP 通用 → Bolo 插件规范**（`TODO_SKILL_MCP_PLUGIN.md`）。  
相对 HC headless **~40–55%**。扩展三层主切片（Skill/MCP/Plugin Spec）最小出口已齐；后置 OAuth/IMPORT/Electron。