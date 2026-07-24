# 权限模式 — 对照参考实现语义

> 参考 PermissionMode 与 permissions 决策链。  
> **不抄**遥测、GrowthBook、企业 YOLO UI。  
> **已实现** headless `auto` 分类器（Y0–Y4 最小 + Y3.6 审计 note）。

## 1. 外部模式（产品四档 + default）

| Mode ID | 用户说法 | 行为摘要 |
|---------|----------|----------|
| `default` | 请求批准 | 危险操作 → ask（UI / hook） |
| `acceptEdits` | 自动审批（编辑） | 工作区内读/写/补丁 auto-allow；Bash/MCP 仍 ask |
| `plan` | Plan | 只读类 allow；写/壳/MCP **deny**（规划不改系统） |
| **auto** | 自动（分类器） | 白名单/读/安全 cwd 内 edit 快路径；危险 bash/PS **硬 deny**；敏感路径限制；其余 **fast→deep 两阶段分类器**；失败 deny + 熔断 demote |
| `bypassPermissions` | 完全访问 | 尽量 allow（**仍可被 always-deny 硬规则挡住**） |

可选后置（见 `TODO_AUTO_PERMISSIONS.md` Y4）：

| Mode / 能力 | 说明 |
|-------------|------|
| `dontAsk` | ask → deny |
| 两阶段分类器 | fast/deep |

## 2. 决策链（简化，无遥测）

```
PreToolUse (可 block)
  → PermissionGate(mode, tool, input, cwd, rules?)
       → allow | deny | ask
  → 若 ask：PermissionRequest hooks → 仍 ask 则 UI askPermission
  → execute / 或 tool_result 拒绝文案
  → PostToolUse
```

**Gate 顺序（含 auto）：**

1. **会话 always-deny** → **deny**（**含** `bypassPermissions` / `auto`）  
2. `bypassPermissions` → allow  
3. `plan` → 读 allow；写/壳/MCP **deny**  
4. 会话 always-allow 规则 → allow  
5. **`auto`**：白名单/读 allow；cwd 内 edit allow；其余 → **ask 标记**（由 `runToolUse` 调分类器）  
6. `acceptEdits` / `default` 矩阵  

**auto 异步路径：** 规则层 `ask` + `mode=auto` → **两阶段分类器**（fast 否决 / deep 确认，`completeText` 侧路）→ allow/deny；`unavailable` → deny + 熔断；达阈值 **demote 到 default**。  
**auto 同步硬拦（Y3+Y4.3）：** 危险 Bash/PowerShell 模式 → deny；`.ssh` 私钥 hard deny；`.env` 等不快路径 allow。  
**plan 与 auto（Y4.4）：** 会话 mode **互斥**；`plan` 下写/壳/MCP **始终 deny**，不与 auto 叠加。  
**上下文（Y4.2）：** summary ≤ 2500 chars、toolInput JSON ≤ 2000 chars。  

进入 auto 时剥离 Bash/Agent always-allow 与解释器类 bash 前缀。  
费用：每个需分类的工具可能 **1–2 次** 额外模型调用（fast+deep）。  
**审计（Y3.6）：** 分类结果（含 fail-closed / 熔断 / demote）追加 JSONL `system_note`，`kind=auto_classify`；**不进**模型 messages；落盘失败静默。  
详见 `docs/TODO_AUTO_PERMISSIONS.md`。

## 3. 工具类别（Bolo）

| category | 工具 |
|----------|------|
| `read` | Read, Glob, Grep, Skill |
| `edit` | Write, Edit, apply_patch |
| `shell` | Bash |
| `mcp` | `mcp__*` |

## 4. 模式 × 类别矩阵

| | read | edit (cwd 内) | edit (cwd 外) | shell | mcp |
|--|------|---------------|---------------|-------|-----|
| default | allow* | ask | ask | ask | ask |
| acceptEdits | allow | **allow** | ask | ask | ask |
| plan | allow | **deny** | deny | **deny** | deny |
| bypassPermissions | allow | allow | allow | allow | allow |

\* default 下只读默认 allow。  
\* always-deny 命中时上表一律变为 deny。

## 5. 会话规则（`Session.permissionRules`）

可经 JSON / JSONL meta **本地持久化**；CLI 答 `a` 或 `/allow` / `/deny` 写入。

### Always-allow

| 字段 | 含义 |
|------|------|
| `alwaysAllowToolNames` | 精确工具名（如 `Bash`、`Write`） |
| `alwaysAllowPrefixes` | 工具名前缀（如 `mcp__trusted`） |
| `alwaysAllowPathGlobs` | 相对 cwd 的路径 glob；命中 path/file_path 则 allow |
| `alwaysAllowBashPrefixes` | Bash 模式：纯前缀 / 通配 `*` / 遗留 `foo:*` |

### Always-deny（硬规则）

| 字段 | 含义 |
|------|------|
| `alwaysDenyToolNames` | 精确工具名 → deny |
| `alwaysDenyPrefixes` | 工具名前缀 → deny |
| `alwaysDenyPathGlobs` | 路径 glob → deny |
| `alwaysDenyBashPrefixes` | Bash 模式 → deny |

**Bash 模式（allow 与 deny 共用语义）：**

| 写法 | 匹配 |
|------|------|
| `git ` | `startsWith('git ')`（纯前缀） |
| `git:*` | 前缀 `git`（遗留） |
| `git *` | 通配：匹配 `git` 与 `git status` |
| `npm * --watch` | 多通配 |

**`/allow` / `/deny` 用法：**

```text
/allow                 # 列出 always-allow
/allow Bash            # 工具名
/allow path:src/**     # 路径 glob
/allow bash:git        # Bash 前缀
/allow bash:git *      # Bash 通配

/deny                  # 列出 always-deny
/deny Bash             # 工具名硬 deny
/deny path:secrets/**  # 路径硬 deny
/deny bash:rm *        # Bash 通配硬 deny
/deny prefix:mcp__evil # 工具名前缀硬 deny
```

**硬约束：**

- always-deny **优先于** always-allow 与 `bypassPermissions`  
- `plan` 下写/壳/MCP 仍 **deny**，always-allow **不能** 覆盖  
- 无遥测；auto 为 **headless 最小**（非企业 UI / sandbox） 

## 6. 模块

```
packages/permissions/src/index.ts
  PermissionMode · classifyTool · decidePermission
  SessionPermissionRules · matchesAlwaysAllow · matchesAlwaysDeny
  matchPathGlob · matchBashPattern
  addAlwaysAllow* / addAlwaysDeny*

runToolUse 调用 gate，再 hooks/UI；auto → classify + system_note 审计
Session.permissionMode / permissionRules / autoModeState
packages/permissions/src/autoClassifier.ts · autoAudit.ts
/allow · /deny · /permissions auto
```

系统提示词注入模式说明，见 `docs/PROMPT_CATALOG.md` / `docs/SYSTEM_PROMPT.md`。

## 7. 验收

- gate 单测：四模式 × Bash/Write/Edit/Read + tool/path/bash always-allow  
- **always-deny 赢过 allow 与 bypass**；path/bash 通配；plan 仍 deny 写  
- 无遥测  

## 8. 明确不做（本文件范围） / 后置

- 跨会话全局 allow 规则 DSL  
- 企业 YOLO UI / GrowthBook / 遥测  
- sandbox 网络策略  
- 完整 path allowlist 引擎  

> **Y0–Y4 最小 + Y3.6 已落地**：模式 + 白名单 + 两阶段分类器 + 危险/PS 硬拦 + 敏感路径 + 熔断 demote + `system_note` 审计。  
> 更深项见 `TODO_AUTO_PERMISSIONS.md` 后置表。