# Bolo Code 总任务清单（TODO）

> **执行入口**：勾选与优先级以本文为准；里程碑/能力矩阵见 `docs/ROADMAP.md`；专项细节见各 `docs/*.md`。  
> 更新：对齐 **已交付 headless 日用主路径**（resume / slash / rules / cache C1–C5 / JSONL / Subagent / MCP / plugins / openai-responses）。  
> 原则：无遥测；对照 HelsincyCode 语义再实现；不把 stub 当完成。

---

## 0. 怎么用

| 文档 | 角色 |
|------|------|
| **本文 `TODO.md`** | **P0→P3 总序**、跨模块依赖、**本周默认下一刀** |
| `ROADMAP.md` | 里程碑、能力矩阵、验收表（不重复长篇勾选） |
| `TODO_SESSION_JSONL.md` | JSONL 存盘深化专项 |
| 其它 `docs/*.md` | 契约真源 |

**规则：** 一次只推进 **一条主切片**（可并行一条「文档/纯 UI 无模型」支线）。

---

## 1. 一句话现状

```text
日用 headless CLI agent 主路径已齐：
  bolo / --resume / --continue · 斜杠总线 · rules · prompt cache API 标记
  · JSONL 双写 · Subagent · MCP stdio · plugins 最小 · openai-responses HTTP SSE

缺口偏「打磨与深度」：JSONL 主路径/entry 细化、MCP·plugins 深度、
  slash 体验、T8 Ink、cache TTL/break、Responses WebSocket、Electron。
```

| 优先级 | 含义（当前） |
|--------|----------------|
| **P0** | 主路径已 ✅；仅保留回归/验收意识，**不再占默认下一刀** |
| **P1** | 体验与成本加深（可选主刀） |
| **P2** | 扩展面深度 / 未做子项 |
| **P3** | GUI / Ink 完整 / 后置协议 |

---

## 2. 已交付（勿再当「缺口」）

### 2.1 会话与 CLI

| ID | 内容 | 状态 |
|----|------|------|
| **RS1–RS9** | `listProjectSessions`；`--resume` 无 id 列表选择；非 TTY；双格式；表格 picker；`--continue` | ✅ |
| **T0–T7** | BOLO banner + 吉祥物；无参 TTY 新会话；状态行/工具行/权限 y/n；接 slash；resume 缩略 banner | ✅ |
| **J-A/B** | JSON + `.jsonl` 双写 | ✅（历史过渡） |
| **J-C / J-C+** | `loadTranscriptMessages`；JSON 缺失回退；双文件 messages 优先 jsonl（非空） | ✅ 最小 |
| **J-D / T3** | R1 boundary · 空/坏回退 · list 跟 jsonl · **默认停写 JSON** · meta 配置切片 · `migrateSessionToJsonl` | ✅ |

### 2.2 斜杠 · Rules · Cache · Creators

| ID | 内容 | 状态 |
|----|------|------|
| **SL0–SL5** | 总线 + `/help` `/compact` `/clear` `/context` `/model` `/effort` `/plan` `/permissions`…；`/skills` + `/<skill-id>` 回落 | ✅ |
| 扩展 slash | `/doctor` `/status` `/mcp` `/plugins` `/hooks` `/init` `/cost` `/usage` `/rules` `/agents` `/bg` `/allow` | ✅ |
| **R1–R4 / R3b** | `.bolo/rules` + 用户 rules；`paths` 作用域；submitPrompt 刷新；`/rules` | ✅ |
| **C1–C5** | 稳定前缀布局 + Anthropic `cache_control` + OpenAI/Responses `prompt_cache_key`（`promptCache.ts`） | ✅ |
| **K1–K2** | bundled `skill-creator` / `plugin-creator` | ✅ |

### 2.3 扩展 · Provider · 会话策略

| ID | 内容 | 状态 |
|----|------|------|
| **S0–S7** | `runSubagent` + Agent 工具 + `.bolo/agents` + `/agents` | ✅ |
| **S7+ / S12 partial** | 侧链 `agent-*.jsonl`；`run_in_background` + `/bg`；fork 继承父 messages 最小 | ✅ 最小 |
| **MCP1** | MCP stdio listTools/call → tools 表 | ✅ |
| **MCP2** | resources/prompts（stdio）+ meta + `/mcp`；**list_changed 热刷新** ✅；SSE/HTTP 仍 ⬜ | 🟡 部分 |
| **PL1** | 本地 plugins 发现 + skills/hooks/mcp 合并（非市场） | ✅ 最小 |
| **OR1–OR5** | OpenAI Responses HTTP SSE 直连 | ✅ |
| 其它 | 真 `apply_patch` 最小 · usage 本地 `/cost` · always-allow · tool_result 预算 · 快照持久化 permissionRules/effort/usage | ✅ / 🟡 |

---

## 3. P1 — 紧随（体验与成本加深）

| ID | 主题 | 说明 | 状态 |
|----|------|------|------|
| **J-D** | JSONL 主路径细化 | T3 默认只写 jsonl · meta 配置切片 · migrate · R1/冲突/list ✅；可选 entry 类型 / CLI `migrate-session` 子命令仍可加深 | ✅ 主路径 |
| **SL-polish** | 斜杠打磨 | help 分组、未知命令建议、`/context` token/sections/cache、参数 Usage、别名隐藏 | ✅ |
| **C6+** | Cache 后置 | 1h TTL / global scope / break detection / cached MC | ⬜ 后置 |
| **Usage+** | 本地 usage 展示 | 已有累计；可加深 breakdown | 🟡 |

---

## 4. P2 — 扩展深度

| ID | 主题 | 状态 |
|----|------|------|
| **MCP2** | SSE/HTTP transport · 插件热重载 MCP | 🟡 部分（stdio resources/prompts + list_changed ✅） |
| **PL2** | 插件热加载 / 市场（若做）· 贡献 slash 深化 | ⬜ |
| **S8+** | 子 agent 权限细化 · 并行策略文档化 · worktree | 🟡 / ⬜ |
| **OR6** | Responses **WebSocket** | ⬜ **后置**（HTTP SSE 已够用） |
| Skills+ | 远程 skill / 动态 discovery 预取 | ⬜ |

---

## 5. P3 — 后置

| ID | 主题 | 状态 |
|----|------|------|
| **T8** | 完整 Ink TUI / 箭头键 picker | ⬜ |
| **T9** | 主题 · 窄终端 · 吉祥物开关 | ⬜ |
| **M4** | Electron GUI | ⬜ |
| S14+ | Worktree 隔离 · swarm/teammate | ⬜ |
| 其它 | 企业策略 · 完整 model 目录… | ⬜ |

**不做：** 远程遥测、GrowthBook、抄 Claude 商标/IP。

---

## 6. 推荐执行顺序（当前）

```text
已完成主线（勿回退当 P0）：
  RS* · SL* · SL-polish · T0–T7 · R* · C1–C5 · J-A/B/C · K* · S0–S7 · MCP1 · MCP2(resources/prompts) · PL1 · OR1–OR5

下一阶段串行候选（择一为主刀）：
  ① MCP2 余量    SSE/HTTP transport（list_changed 热刷新已交付）
  ② PL2          plugins 热加载 / slash 贡献深化
  ③ Usage+       本地 usage breakdown（可选）
  ④ T8           Ink TUI（可选，不挡 headless）
  ⑤ C6+ / OR6    cache 后置 / Responses WS —— 明确后置
  ⑥ M4           Electron —— 门禁后置
  （J-D T3 已交付：默认 jsonl 写 + migrate + meta 切片）
  （MCP2 list_changed 已交付：tools/resources/prompts 通知热刷新）
```

---

## 7. 本周默认「下一刀」

若只开一刀（**非 Electron**）：

> **主推候选：**  
> 1. **MCP2 SSE/HTTP · PL2** — 远程 transport 或 plugins 深度（禁止 mock 冒充）  
> 2. **Usage+** — 本地 usage breakdown（可选）  
>
> **可选支线：** JSONL entry 类型 / CLI `migrate-session` 包装。  
> **明确后置：** OR6 WebSocket · C6+ cache TTL/break · T8 Ink · Electron。

已齐：resume / slash（含 **SL-polish**）/ BOLO TUI 最小 / rules（含 path-scoped 刷新）/ cache C1–C5 / JSONL 双写+**J-D T3**（默认 jsonl、migrate、meta 切片）/ creators / Subagent / MCP stdio + **resources/prompts** + **list_changed 热刷新** / plugins 最小 / usage+effort / always-allow / apply_patch / **openai-responses HTTP SSE**。

---

## 8. 与 ROADMAP 里程碑映射

| TODO | ROADMAP |
|------|---------|
| RS* · T* | M5.2 / M-TUI（T0–T7 ✅；T8 ⬜） |
| SL* | M-Slash ✅ 最小 |
| R* | M-Rules ✅ |
| C* | M-Cost（C1–C5 ✅；C6+ 后置） |
| J* | M5.1 / `TODO_SESSION_JSONL`（J-D T3 ✅ 主路径） |
| K* | M-Creators ✅ |
| S* | M-Subagent（S0–S7 ✅；S12 partial） |
| MCP* · PL* | M3（MCP2 resources/prompts 部分 ✅） |
| **OR*** | Responses：HTTP SSE ✅；WS 后置 |
| M4 | Electron ⬜ |

---

## 9. 检查清单（开 PR 前）

- [ ] 无遥测  
- [ ] 文档无本机绝对路径  
- [ ] 相关 `scripts/test-*.ts` 绿  
- [ ] 更新本文对应 ⬜→✅，并扫一眼 `ROADMAP` 总览是否仍一致  
- [ ] stub / mock 未勾成「完成」  

---

**一句话：**  
可日用 headless 主路径已齐；**MCP2**（stdio resources/prompts + meta + `/mcp` + **list_changed 热刷新**）已交付；**J-D T3** 已交付；下一刀优先 **MCP SSE/HTTP · PL2 / Usage+**；**Electron · Ink · Responses WS · cache TTL** 后置。