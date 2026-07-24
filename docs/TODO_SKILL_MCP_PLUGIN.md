# TODO / 路线图：Skill 可移植 · MCP 通用 · Bolo 插件规范

> **专项规划**（与 `docs/SKILLS.md` / `docs/MCP.md` / `docs/PLUGINS.md` 契约文档正交；与 `docs/TODO.md` 全局下一刀衔接）。  
> 更新：初版落盘（扩展三层：Skill → MCP → Plugin；**Bolo 规范一等公民**；**不接** Claude / Codex 官方市场）。  
> 原则：无遥测；不把 stub 当完成；完成度分 **主路径 / 可移植性 / 产品生态** 三口径；状态按代码行为写。

---

## 0. 为何单独成册

| 问题 | 说明 |
|------|------|
| 三层混谈 | Skill / MCP / Plugin 常被合成「扩展」，但格式通用性与产品边界完全不同 |
| 市场陷阱 | HC 可挂 Claude 官方市场；Bolo **无版权、不接** Claude/Codex 官方商店 |
| 格式现实 | Claude 与 Codex **插件包不是通用格式**；Skill（`SKILL.md`）与 MCP 协议更接近可移植 |
| 目标 | 先把 **Skill 契约与发现** 做成可写、可测、可移植；再加固 **MCP 日用连接**；插件以 **`bolo.*` 规范** 为源 |

**三层定位（北极星）：**

| 层 | 定位 | 兼容策略 |
|----|------|----------|
| **Skill** | 接近通用的内容格式 | **优先完善**；`SKILL.md` 契约；可选旁路目录只读 |
| **MCP** | 业界协议（tools / resources / prompts） | **第二优先**；协议对齐 + 诊断 + 秘钥卫生 |
| **Plugin** | **Bolo 一等公民** | `bolo.plugin.json` / `bolo.marketplace.json`；外来格式最多 importer |

**硬红线**

- 不接入、不镜像、不伪装 Claude / Codex **官方市场**
- 无遥测
- 插件不以「完整兼容对方运行时」为目标
- Skill **catalog-only 进上下文**，全文按需（不得回退为全文塞 prompt）

**与契约文档分工**

| 文档 | 角色 |
|------|------|
| **本文** | 切片 ID、序、验收、明确不做 |
| `SKILLS.md` | Skill 目录 / catalog / 工具 契约真源 |
| `MCP.md` | transport / 配置 / API 契约真源 |
| `PLUGINS.md` | 插件加载 + PL-MKT 最小 + **将升为 Spec v0** |
| `TODO.md` | 全局下一刀入口 |

---

## 1. 现状水位（落盘时）

### 1.1 Skill

| 已有 | 缺口 |
|------|------|
| bundled / `~/.bolo/skills` / `.bolo/skills` / 插件 `skills/` | 旁路根（如 `~/.agents/skills`）未认；默认策略未写死 |
| frontmatter + catalog 预算 + Skill 工具 | 可移植契约表未专册化；别名兼容测可加强 |
| `/skills` · slash 回落 · skill-creator | `disable-model-invocation` 行为未完全钉死 |
| `test-skill-catalog` | 多根覆盖、坏文件隔离、disable 路径测可扩 |
| — | 远程 skill / MCP skill / 动态 discovery 预取 ⬜ |

**粗估：** 主路径可用 **~65–75%**；「可移植契约完整」**~40–50%**。

### 1.2 MCP

| 已有 | 缺口 |
|------|------|
| stdio / Streamable HTTP / 经典 SSE | OAuth / headersHelper ⬜ |
| tools + resources + prompts + list_changed | 配置校验友好错误、doctor 诊断再深 |
| meta 工具 + `/mcp` + 错误隔离 | 秘钥卫生（Authorization 不进日志）可钉 |
| SSE 重连字段最小 | http 侧重连预算仍薄 |
| 插件 contributes.mcp + reload 最小 | 合并序与冲突文档可加强 |

**粗估：** 协议日用 **~60–70%**；企业鉴权 **~10%**。

### 1.3 Plugin

| 已有 | 缺口 |
|------|------|
| `bolo.plugin.json` + contributes（skills/hooks/mcp/commands…） | 正式 **Spec v0** 文档与校验 |
| PL1 加载 + PL2 热加载 + reload | 坏 manifest 隔离测 |
| PL-MKT 最小（清单 path 安装） | **不做**官方市场；zip/git 后置 |
| plugin-creator | 与 Spec v0 对齐 |

**粗估：** Bolo 规范加载 **~55–65%**；市场产品 **~15–25%**（仅最小清单）。

---

## 2. 格式边界（决策摘要）

> 分析结论（对照 HC 插件体系 + Codex `core-plugins`）：**插件包格式不通用**；Skill / MCP 更值得先做「可移植」。

| 内容 | 通用程度 | Bolo 策略 |
|------|----------|-----------|
| `SKILL.md` + frontmatter | 高 | **一等可移植层**；先完善 |
| MCP 协议（JSON-RPC / 三 transport） | 高（协议层） | **第二优先**；客户端体验加深 |
| commands markdown | 中 | 插件 contributes；frontmatter 各家略异 |
| hooks 配置 | 低–中 | **Bolo hooks 语义**为准；外来不保证 |
| Claude `.claude-plugin/*` | 产品私有 | 可选只读 importer（后置） |
| Codex `.codex-plugin/*` / `.agents/plugins` | 产品私有 | 可选只读 importer（后置） |
| 官方 marketplace | 无（版权/账号） | **永不接入** |

**默认产品拍板（可改，改则改本文）：**

| # | 决策 | 默认 |
|---|------|------|
| D1 | 旁路 skill 根（如 `~/.agents/skills`） | **默认关闭**；配置显式开启 |
| D2 | MCP `${ENV}` 插值 | P1 **可做最小**；OAuth 仍后置 |
| D3 | 外来 plugin 导入 | **附录 / P3**；不冲淡 Bolo 一等公民 |
| D4 | 官方市场深度 | **后置**；与本专册 Skill/MCP 主线正交 |

---

## 3. 总序与依赖

```text
P0  S-PORT  Skill 可移植完善
  → P1  M-GEN   MCP 通用连接加深
  → P2  PL-SPEC Bolo 插件规范固化
  → P3  IMPORT  可选只读发现（best-effort）
  → 更后：自有市场深度（zip/git）· MCP OAuth · Electron
```

```text
S-PORT-1 契约 ──┬──► S-PORT-2/3 发现与覆盖
                ├──► S-PORT-4 disable 行为
                └──► S-PORT-6 creator

S-PORT 出口 ────────► PL-SPEC-2 skills 贡献更稳

M-GEN-1/2/3 ────────► 日用 MCP
M-GEN-8 ─────────────► PL-SPEC mcp 合并

PL-SPEC-0/1 ─────────► PL-SPEC-3 creator
PL-SPEC 出口 ────────► IMPORT-*（可选）
```

**规则：** 一次只推进 **一条主切片**（可并行纯文档支线）。

---

## 4. P0 — Skill 可移植（S-PORT）★ 默认主刀区

**目标：** 写一次 `id/SKILL.md` 即可在 Bolo 稳定发现；契约可文档、可测；catalog 安全。

| ID | 任务 | 验收 | 状态 |
|----|------|------|------|
| **S-PORT-0** | 本文落盘；`TODO.md` / `ROADMAP.md` / `SKILLS.md` 互链 | 链接互通 | ✅ |
| **S-PORT-1** | **Frontmatter 契约表**（规范字段 + 别名） | `name`/`id`/`description`/`when_to_use`↔`whenToUse` 等；未知键忽略；`frontmatter.ts` + `test-skill-catalog` | ✅ 最小 |
| **S-PORT-2** | **发现根**：Bolo 一等 + **可选旁路** | `extraSkillRoots`；`source=extra`；默认 **off**；测 | ✅ 最小 |
| **S-PORT-3** | **覆盖序与同 id** 写死 | `mergeSkillsByPrecedence`；`/skills` 显示 source；测 | ✅ 最小 |
| **S-PORT-4** | **`disable-model-invocation` / `user-invocable` 钉死** | 矩阵：catalog / Skill 工具 / slash 正交；测 | ✅ 最小 |
| **S-PORT-5** | **catalog 预算可观测** | `formatSkillCatalogWithStats` · `/skills`/`/context` 一行 stats · 测 | ✅ 最小 |
| **S-PORT-6** | **skill-creator 对齐契约** | bundled `skill-creator` 教 S-PORT frontmatter/矩阵/无远程；测 | ✅ 最小 |
| **S-PORT-7** | **拒绝远程 skill（本阶段）** | `SKILLS.md` + creator 写明；无 URL 装 skill API | ✅ 文档 |
| **S-PORT-8** | 回归包 | `test-skill-catalog`：别名 · disable · 坏 frontmatter · 覆盖 · 预算省略 | ✅ 最小（随 S-PORT-1） |

**出口（Skill 专题最小 Done）：**

1. 符合契约的 skill 在三根（user/project/bundled）+ plugin 合并稳定  
2. 全文仅经 Skill 工具 / 显式 slash  
3. frontmatter 兼容表有测  
4. 第三方可只读 `SKILLS.md` + 本文写 skill（不绑插件市场）

**明确不做（Skill 本阶段）：**

- 远程 skill 商店 / MCP-hosted skill  
- 与 HC 完全一致的动态 skill_discovery 预取  
- 自动展开 Claude/Codex **插件包**为 skill（→ IMPORT）

**相对「可移植 Skill」粗估：** 出口约 **~80–85%**（非远程生态）。

---

## 5. P1 — MCP 通用连接（M-GEN）

**目标：** 协议已通 → 日用连得稳、配得清、秘钥不泄漏。

| ID | 任务 | 验收 | 状态 |
|----|------|------|------|
| **M-GEN-0** | `MCP.md`「通用性边界」 | 协议 ✅ / 与官方商店无关 / OAuth 后置 | ✅ |
| **M-GEN-1** | **配置校验与友好错误** | `validateMcpServerConfig` · `loadMcpConfigFileDetailed` · 坏项跳过 + warn | ✅ 最小 |
| **M-GEN-2** | **`/doctor` 或 `/mcp` 诊断加深** | transport · last error · 计数 · capability 可读 | ⬜ |
| **M-GEN-3** | **headers 秘钥卫生** | `redactMcpHeaders` · summary 不打印全文 | ✅ 最小 |
| **M-GEN-4** | **resources/prompts 日用加固** | list/read 测；空 capability 不报错 | ⬜ |
| **M-GEN-5** | **list_changed 回归** | stdio/sse 测绿；http 行为写清 | ⬜ |
| **M-GEN-6** | **env/headers `${VAR}` 插值最小** | 可选；无远程脚本执行 | ⬜（D2） |
| **M-GEN-7** | **OAuth / headersHelper** | 浏览器流 / 刷新令牌 | ⬜ **后置** |
| **M-GEN-8** | 插件 mcp 与 `mcp.json` **合并序** | 文档 + 测；冲突策略 | ⬜ |

**出口：** stdio/http/sse + resources/prompts + list_changed 文档/测一致；配置可诊；无秘钥泄漏；OAuth 可仍 ⬜。

**明确不做（MCP 本阶段）：** 把 MCP 包装成插件商店；遥测；完整 OAuth（M-GEN-7）。

**相对「MCP 日用通用」粗估：** 出口约 **~75%**（无 OAuth）。

---

## 6. P2 — Bolo 插件规范（PL-SPEC）

**目标：** `bolo.*` 为唯一一等规范；加载稳；creator 合规；市场保持最小。

| ID | 任务 | 验收 | 状态 |
|----|------|------|------|
| **PL-SPEC-0** | `PLUGINS.md` → **Bolo Plugin Spec v0** | 布局 · manifest schema · contributes · 覆盖序 | ⬜ |
| **PL-SPEC-1** | **manifest 校验** | 缺 id/坏 JSON → 跳过 + errors；不拖垮会话 | ⬜ |
| **PL-SPEC-2** | **contributes 契约** | skills/hooks/mcp/commands/agents 路径与默认目录 | ⬜ |
| **PL-SPEC-3** | **plugin-creator 对齐 Spec v0** | 只产 bolo 规范脚手架 | ⬜ |
| **PL-SPEC-4** | **PL2 reload ↔ skill/mcp 重挂** | 测绿 | ⬜ |
| **PL-SPEC-5** | **PL-MKT 保持最小** | 仅清单/path；文档重申非官方市场 | ✅ 最小已有；保持 |
| **PL-SPEC-6** | **边界图** | 插件 = 打包单元；skill/mcp 可独立存在 | ⬜ 文档 |

**出口：** 作者只读 Spec 能写出可加载插件；坏插件隔离；不宣传跨产品商店兼容。

**明确不做：** Claude/Codex 官方市场；完整 zip/git/npm 运营市场（另刀「自有市场深度」）。

---

## 7. P3 — 可选只读导入（IMPORT）附录

> **不进默认主刀**；P0–P2 出口后再开。失败必须显式 warn。

| ID | 任务 | 范围 | 状态 |
|----|------|------|------|
| **IMPORT-S1** | 旁路 skill 根（配置开关） | 例：`~/.agents/skills`；不改对方文件 | ⬜ |
| **IMPORT-P1** | 识别 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` | **仅映射** skills（+ 可选 mcp 路径）；hooks **不保证** | ⬜ |
| **IMPORT-X** | 失败面文档 | 不支持的 contributes → warn | ⬜ |

**禁止：** 导入 = 接入对方官方 market API / 远程 curated 目录。

---

## 8. 推荐近序（默认 6 刀）

| 序 | 刀 | 切片 |
|----|----|------|
| 1 | Skill 可移植 | ~~S-PORT-0..8~~ ✅ 最小出口 |
| 2 | MCP 诊断卫生 | **M-GEN-0..3** |
| 3 | MCP 诊断卫生 | M-GEN-0 · M-GEN-1 · M-GEN-2 · M-GEN-3 |
| 4 | MCP 加固 | M-GEN-4 · M-GEN-5 · M-GEN-8（± M-GEN-6） |
| 5 | Bolo Spec | PL-SPEC-0 · PL-SPEC-1 · PL-SPEC-2 · PL-SPEC-3 · PL-SPEC-4 |

**暂缓：** M-GEN-7 OAuth、自有市场 zip/git、IMPORT-P 全量、Electron。

---

## 9. 完成度口径（防吹牛）

| 口径 | 含义 | 勿写成 |
|------|------|--------|
| Skill 可移植 | 目录 + frontmatter + 发现 + catalog | 远程 skill 商店完成 |
| MCP 通用 | 三 transport + 资源/提示 + 可诊 | OAuth 企业级完成 |
| 插件产品 | Bolo Spec 加载 + 热加载 + 最小清单市场 | Claude/Codex 兼容层 / 官方市场 |

| 阶段 | Skill 可移植 | MCP 日用 | 插件 Bolo 规范 |
|------|--------------|----------|----------------|
| 落盘时 | ~40–50% 契约 / ~65–75% 主路径 | ~60–70% | ~55–65% |
| S-PORT 出口 | ~80–85% | — | — |
| +M-GEN（无 OAuth） | — | ~75% | — |
| +PL-SPEC | — | — | ~70% |
| +IMPORT | 旁路发现加分 | — | 有限 importer，**不**宣称兼容 |

---

## 10. 与全局 ROADMAP / TODO 映射

| 本专册 | 全局 |
|--------|------|
| S-PORT-* | 扩展面 Skills；`SKILLS.md` |
| M-GEN-* | M3 MCP；`MCP.md`（OAuth 仍后置） |
| PL-SPEC-* | M3 Plugins；`PLUGINS.md`；PL-MKT 最小保持 |
| IMPORT-* | 附录；不挡主路径 |
| 官方市场深度 | **正交后置**；见 `PLUGINS.md` / 历史 ROADMAP 备注 |

| 全局勿做 | 原因 |
|----------|------|
| 接 Claude/Codex 官方市场 | 版权 / ToS / 账号 |
| 插件格式「完全通用」承诺 | 运行时语义不通用 |
| Skill 全文默认进 system | token 爆炸；已否决 |

---

## 11. 检查清单（开切片 PR 前）

- [ ] 无遥测  
- [ ] 文档无本机绝对路径  
- [ ] 相关 `scripts/test-*.ts` 绿  
- [ ] 未把 Claude/Codex 官方市场写成支持项  
- [ ] Skill 未回退「全文进 prompt」  
- [ ] stub / 仅改文件名未勾 ✅  
- [ ] commit message 与 tree 一致  
- [ ] 完成度用上表三口径  

---

## 12. 一句话

> **Skill 先做成可移植内容标准；MCP 做成稳、可诊、无秘钥泄漏的协议客户端；插件始终以 `bolo.*` 为一等规范。官方市场与外来完整运行时兼容从长计议，且永不绑 Claude/Codex 商店。**

**默认下一刀：** **M-GEN**（MCP 通用连接加深，见本文 §5）— 从 **M-GEN-0/1** 起。  

**Skill 专题：** S-PORT-0..8 最小出口 ✅（可移植契约 + creator + 无远程商店承诺）。