# Bolo Code 总任务清单（TODO）

> **执行入口**：勾选与优先级以本文为准；里程碑/能力矩阵见 `docs/ROADMAP.md`；专项细节见各 `docs/*.md`。  
> 更新：对齐 **Loop 韧性切片** + 已交付主路径；完成度按 **主路径 vs 相对 HC** 诚实口径。  
> 原则：无遥测；对照 HelsincyCode 语义再实现；不把 stub 当完成；**状态按代码行为写**，不按错误 commit subject。

---

## 0. 怎么用

| 文档 | 角色 |
|------|------|
| **本文 `TODO.md`** | **P0→P3 总序**、跨模块依赖、**本周默认下一刀** |
| `ROADMAP.md` | 里程碑、能力矩阵、验收表（不重复长篇勾选） |
| `AGENT_LOOP.md` | loop / 错误分类 / model·PTL 重试 |
| `TODO_SESSION_JSONL.md` | JSONL 存盘专项（主路径已齐；余量 entry/CLI） |
| 其它 `docs/*.md` | 契约真源 |

**规则：** 一次只推进 **一条主切片**（可并行一条「文档/纯 UI 无模型」支线）。

---

## 1. 一句话现状

```text
主路径可跑（脚本/CLI）：
  bolo / --resume / --continue · 斜杠 + rules · C1–C5 · JSONL 默认写
  · Subagent · MCP stdio 面 · plugins 最小 · Responses HTTP
  · Loop 韧性最小：错误分类 + 429/5xx 有限退避（与 PTL 正交）

相对 HelsincyCode headless 约 40–55%（勿再写 ~70% 乐观数）。
真正抬水位的 P0 余量：
  1. ~~Loop 韧性~~ ✅ 最小（本刀）
  2. Tool+Permission 日用  ← 默认下一刀
  3. 长会话 compact 加深
P1：MCP SSE/HTTP · PL2 · Usage+
```

| 优先级 | 含义（当前） |
|--------|----------------|
| **P0** | 抬 headless 水位：韧性已 🟡；**Tool+Permission** / compact 仍缺口 |
| **P1** | 扩展深度（MCP SSE · PL2 · Usage+） |
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
| **SL-polish** | `/help` 分组 · 未知命令建议 · `/context` token/sections/cache · 参数 Usage · 别名隐藏 | ✅ |
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
| **PL1** | 本地 plugins 发现 + skills/hooks/mcp 合并（非市场） | ✅ 最小 |
| **OR1–OR5** | OpenAI Responses HTTP SSE 直连 | ✅ |
| 其它 | 真 `apply_patch` 最小 · usage 本地 `/cost` · always-allow · tool_result 预算 · 快照/meta 中 permissionRules/effort/usage | ✅ / 🟡 |

### 2.4 Loop 韧性（本刀）

| ID | 内容 | 状态 |
|----|------|------|
| **LR1** | 统一错误分类 `retryable` / `fatal` / `user_abort`（`errorClassify.ts`） | ✅ 最小 |
| **LR2** | `wrapCallModelWithRetry`：默认 3 次指数退避；尊重 AbortSignal；仅 retryable | ✅ 最小 |
| **LR3** | `productionDeps` / `createCallModelFromProvider` 默认包装；可关 | ✅ |
| **LR4** | queryLoop：`model_retry` 事件；user_abort → `aborted`；与 **PTL** 正交 | ✅ |
| **LR5** | 测试 `scripts/test-model-retry.ts`（429→成功、abort/fatal/PTL 不重试） | ✅ |
| **LR6** | Bash：可选 `timeout` + abort 错误码加固 | ✅ 小加分 |
| **LR-doc** | `AGENT_LOOP.md` / `ROADMAP` / `TODO` 诚实口径 + 分区并发描述 | ✅ |

---

## 3. P0 — 抬 headless 水位（默认主刀区）

| ID | 主题 | 说明 | 状态 |
|----|------|------|------|
| **LR*** | Loop 韧性 | 分类 + model 退避 + 与 PTL 分工 | ✅ 最小（本刀） |
| **TP*** | **Tool+Permission 日用** | Edit/Write 深度、权限体验、中段 abort 一致、常用工具契约 | ⬜ **默认下一刀** |
| **CP*** | 长会话 compact | auto 策略、boundary 体验、大上下文日用 | 🟡 / ⬜ |

---

## 4. P1 — 紧随（扩展深度与体验）

| ID | 主题 | 说明 | 状态 |
|----|------|------|------|
| **MCP2 余量** | 远程 transport | **SSE / HTTP（streamable）** 接同一 host 语义；stdio 面已齐 | ⬜ |
| **PL2** | plugins 深度 | 热加载 / 贡献 slash 深化 /（若做）市场 | ⬜ |
| **Usage+** | 本地 usage 展示 | 已有累计与 `/cost`；可加深 breakdown | 🟡 可选 |
| **J-D 余量** | entry / CLI | 更多 entry 类型；CLI `migrate-session` 包装 | 🟡 可选支线 |
| **C6+** | Cache 后置 | 1h TTL / global scope / break detection / cached MC | ⬜ **后置** |

---

## 5. P2 — 扩展与协议

| ID | 主题 | 状态 |
|----|------|------|
| **S8+** | 子 agent 权限细化 · 并行策略 · worktree | 🟡 / ⬜ |
| **OR6** | Responses **WebSocket** | ⬜ **后置**（HTTP SSE 已够用） |
| Skills+ | 远程 skill / 动态 discovery 预取 | ⬜ |
| MCP 插件热重载 | 插件变更后重挂 MCP | ⬜（可跟 PL2） |

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
  · K* · S0–S7 · MCP1 · MCP2(stdio + list_changed) · PL1 · OR1–OR5
  · LR* Loop 韧性最小

下一阶段：
  ① TP* Tool+Permission 日用   ← 默认主刀（抬水位）
  ② CP* 长会话 compact 加深
  ③ MCP2 SSE/HTTP · PL2 · Usage+   （P1）
  ④ T8 / C6+ / OR6 / Electron      （后置）
```

---

## 8. 本周默认「下一刀」

若只开一刀（**非 Electron**）：

> **主推：Tool+Permission 日用（TP*）**  
> - Edit/Write（或等价）契约加深、权限 always-allow / ask 体验  
> - tool 中段 AbortSignal 一致  
> - 禁止假装「完整 StreamingToolExecutor」  
>
> **本刀已勾选：** Loop 韧性 LR1–LR6 + 文档诚实化。  
> **明确后置：** MCP SSE/HTTP · PL2（P1）· OR6 · C6+ · T8 · Electron。

**已齐摘要：** resume · slash · BOLO TUI 最小 · rules · C1–C5 · JSONL 主路径 · creators · Subagent · MCP stdio 面 · plugins 最小 · Responses HTTP · **Loop 韧性最小**。

---

## 9. 与 ROADMAP 里程碑映射

| TODO | ROADMAP |
|------|---------|
| LR* | M-Loop 韧性 🟡 |
| TP* | 运行时 permission / tools 日用 |
| RS* · T* | M5.2 / M-TUI（T0–T7 ✅；T8 ⬜） |
| SL* · SL-polish | M-Slash ✅ |
| R* | M-Rules ✅ |
| C* | M-Cost（C1–C5 ✅；C6+ 后置） |
| J* | M5.1 / `TODO_SESSION_JSONL`（J-D T3 ✅） |
| K* | M-Creators ✅ |
| S* | M-Subagent（S0–S7 ✅；S12 partial） |
| MCP* · PL* | M3（stdio 面 ✅；SSE/HTTP · PL2 ⬜） |
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
Loop 韧性最小已落地；**下一刀 Tool+Permission 日用**；MCP SSE/PL2 为 P1，勿抢 P0。