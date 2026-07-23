# 工程原则：先借鉴，再实现

> 用户约束（硬）：参考 HelsincyCode 等优秀架构；**不做遥测**；功能不要一股脑瞎写——先看参考项目怎么做，再按同一职责边界自己实现。

## 1. 工作方式（强制）

```
要做功能 X
  → 1) 在参考项目中定位：入口 / 模块 / 数据流 / 状态
  → 2) 写进 findings 或本文件「映射表」（不写本机绝对路径）
  → 3) 只实现映射到的最小切片
  → 4) 用窄链路验收
  ✗ 禁止：凭感觉先堆 API / 假 MCP / 半套插件再补语义
```

**遥测 / analytics / GrowthBook / 远程上报：当前阶段一律不实现、不预留上报链路。**

## 2. HelsincyCode 架构里该借什么

HelsincyCode（Claude Code 系）优秀之处在于 **横切关注点拆开、主循环与 tool 管道清晰**，不是「文件多」。

### 2.1 推荐镜像的分层（产品语义）

| 参考职责 | 参考区域（逻辑名） | Bolo 应对应 | 不做 |
|----------|-------------------|-------------|------|
| SDK 事件与 Hook 名 | entrypoints / SDK `HOOK_EVENTS` | `packages/shared` + `docs/HOOKS.md` | 全量 20+ 事件一次做完 |
| 主查询循环 | `query` / QueryEngine | `packages/core` 的 turn 循环 | 抄 flag、reactive compact 全家桶 |
| Tool 契约 | `Tool` 定义、注册、查找 | `packages/tools` 统一 Tool 接口 | 每个 tool 私有权限逻辑 |
| Tool 编排 | tools 服务：并发/串行批 | core 内 `runTools` 风格 | 过早优化并发 |
| 单次 tool 执行 | find → PreHook → permission → run → PostHook | core 管道固定顺序 | 顺序打乱 |
| Hook 与权限交叉 | toolHooks + canUseTool | HookBus + PermissionGate | 遥测埋点 |
| MCP | mcp 服务：连接与工具映射 | `packages/mcp` | 无协议就先假 invoke 冒充完成 |
| Skills | skills 加载 | `packages/skills` | 搜索/实验 skill 特性 |
| Plugins | plugins 加载与 contributes | `packages/plugins` | 市场、远程安装 |
| Compact | compact 服务 | **`docs/COMPACTION.md` + `packages/compact`**；禁止 slice 冒充 | 遥测、cache_edits 全家桶 |
| UI | Ink REPL | Electron `apps/desktop` | 把 UI 状态当权威状态 |
| 分析上报 | analytics / datadog / growthbook | **不实现** | 任何 phone-home |

### 2.2 单次 Tool 管道（必须对齐的顺序）

参考实现中的实质顺序（语义层）：

```
resolve tool by name
  → PreToolUse hooks
      (可 deny / 改 input / 附加 context)
  → permission (canUseTool / PermissionRequest hooks / UI)
  → execute tool
  → PostToolUse hooks
  → tool_result 回写消息
```

Bolo **必须**保持同一顺序。  
参考里夹杂的 `logEvent` / analytics 调用：**实现时直接省略**，不要做 stub 上报。

### 2.3 Tool 编排（可后置的借鉴点）

参考 `runTools`：

- 只读类 tool 可并发批
- 写/副作用 tool 串行批

Bolo v1：**全部串行即可**；并发是性能优化，不是架构正确性前提。

### 2.4 Hook 事件：用户 10 个优先

参考 SDK 有更多事件（Notification、SessionEnd、Elicitation…）。  
**产品契约仍以用户指定的 10 个为最低完备集**；扩事件必须先补 `docs/HOOKS.md` 再写代码。

## 3. 对照：我们已写代码的健康度

| 已有切片 | 是否像参考 | 处理 |
|----------|------------|------|
| 10 Hook 事件名 + matcher 规则 | 对齐 | 保留，作契约真源 |
| HookBus command + exit 2 block | 对齐语义 | 保留；继续对照 hook 输入字段 |
| Session 状态 + turn 循环 + mock provider | 方向对，偏薄 | 按 query/tool 管道收紧，少造新概念 |
| Bash/Read/Write | 必要最小集 | 保留；接口逐步贴近 Tool 契约 |
| MCP 无 stdio 的 mock invoke | **偏瞎写** | 标为 placeholder；真做时对照 mcp client 连接/listTools/callTool |
| 插件 merge 草稿 | 可保留结构 | 贡献点形状对照参考后再加字段 |
| 遥测 | — | **禁止加入** |

## 4. 每个功能的「借鉴清单」模板

实现前在 `findings.md` 追加一节：

```markdown
### 功能: <名>
- 参考模块: <逻辑路径/职责名>
- 输入/输出: ...
- 状态/副作用: ...
- 与 Hook/Permission 的交叉: ...
- Bolo 落点包: packages/...
- 本切片不做: ...
- 验收: ...
```

未填此节，**不允许**开写该功能大段代码。

## 5. 推荐实现顺序（对齐参考，而非拍脑袋）

1. **Tool 契约 + 执行管道**（对照 Tool + toolExecution 语义）  
2. **Hook 挂载点齐全且顺序固定**（10 事件）  
3. **PermissionRequest 与 UI/回调**（对照 canUseTool / PermissionRequest hook）  
4. **Skills 目录加载**（对照 skills 加载，不做实验搜索）  
5. **MCP：配置 → 连接 → listTools → 注册名 `mcp__*` → callTool**（对照 mcp client，禁止长期 mock 冒充完成）  
6. **Plugins contributes 合并**（对照 plugin loader）  
7. **Subagent**（对照 Agent tool 生命周期 + SubagentStart/Stop）  
8. **Electron 壳**（只订阅 core 事件）  
9. **上下文压缩（Full compact 优先）** — 对照 `services/compact`，见 `docs/COMPACTION.md`；禁止截断消息  
10. Electron 壳 / 真 Provider / 持久化  

## 6. 文档地图

| 文档 | 角色 |
|------|------|
| 本文件 | 工程纪律与参考映射 |
| ARCHITECTURE.md | 目标分层 |
| HOOKS.md | Hook 契约 |
| **COMPACTION.md** | **上下文压缩设计（重点）** |
| DEEP_ANALYSIS.md | 分析与风险 |
| ROADMAP.md | 阶段完成标准 |
| findings.md | 每次借鉴记录 |

---

**一句话**：HelsincyCode 的价值是 **管道与边界**；压缩是「摘要替换前缀」不是「删消息」；我们不抄遥测、不抄 50 万行、不先发明一套再硬凑。