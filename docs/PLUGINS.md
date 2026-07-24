# Bolo Plugin Spec v0 + PL-MKT 最小市场

> **一等公民：** `bolo.plugin.json`（本 Spec）。  
> 对照 HelsincyCode 插件语义**重实现**；**不接** Claude / Codex 官方市场。无遥测。  
> 切片：`docs/TODO_SKILL_MCP_PLUGIN.md`（PL-SPEC）。

---

## 0. 边界图（PL-SPEC-6）

| 单元 | 职责 | 可独立存在？ |
|------|------|----------------|
| **Skill** | `SKILL.md` 可移植内容 | ✅ `~/.bolo/skills` / `.bolo/skills` |
| **MCP** | 协议客户端 + `mcp.json` | ✅ 用户/项目 mcp.json |
| **Plugin** | **打包分发单元**：skills + hooks + mcp + commands… | 可选；不强制 |

插件 = 目录 + manifest + contributes 路径；**不是**运行时协议标准，也不是他厂商店客户端。

```
user/project mcp.json  ──┐
user/project skills  ──┼── loadWorkspace ──► session
plugins/*/bolo.plugin.json ─┘   (后层覆盖，见下)
```

---

## 1. 布局（Spec v0）

```text
.bolo/plugins/<plugin-id>/          # 或 ~/.bolo/plugins/<plugin-id>/
  bolo.plugin.json                  # 必填
  skills/<skill-id>/SKILL.md        # 默认 contributes（若未写 contributes.skills）
  commands/*.md                     # 默认 slash 命令目录
  hooks.json                        # 仅当 contributes.hooks 指向
  mcp.json                          # 仅当 contributes.mcpServers 指向
  agents/                           # 可选（contributes.agents）
```

| 作用域 | 路径 |
|--------|------|
| user | `~/.bolo/plugins/`（或 `$BOLO_CONFIG_DIR/plugins/`） |
| project | `<repo>/.bolo/plugins/` |

同 `id`：后发现覆盖先发现（**project 盖 user**）。

---

## 2. Manifest `bolo.plugin.json`（PL-SPEC-1/2）

### 2.1 最小示例

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "contributes": {
    "skills": ["skills"],
    "hooks": "hooks.json",
    "mcpServers": "mcp.json",
    "commands": ["commands"],
    "agents": ["agents"]
  }
}
```

### 2.2 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | **是** | 推荐 kebab-case：`my-plugin`；缺省/空 → **不加载** |
| `name` | 否 | 展示名；缺省用 `id` |
| `version` | 否 | 缺省 `"0.0.0"`（warning） |
| `contributes` | 否 | 对象；未知键 **warning 并忽略** |

### 2.3 `contributes` 契约

| 键 | 类型 | 默认（未声明时） | 说明 |
|----|------|------------------|------|
| `skills` | `string[]` | `["skills"]` | 相对根的目录，扫 `<id>/SKILL.md`；显式 `[]` = 不扫 |
| `commands` | `string[]` | `["commands"]` | 相对根的目录，扫一层 `*.md`；显式 `[]` = 不扫 |
| `hooks` | `string` | — | 相对路径 → hooks.json；缺省不贡献 hooks |
| `mcpServers` | `string` | — | 相对路径 → mcp.json；合并进 workspace（后层赢） |
| `agents` | `string[]` | — | 相对目录列表（预留） |

- 路径均相对 **插件根**。  
- 省略未用的 key，勿造空文件。  
- 实现：`parsePluginManifest`（`packages/plugins/src/manifest.ts`）。

### 2.4 校验与失败隔离

| 情况 | 行为 |
|------|------|
| 缺 `bolo.plugin.json` / 坏 JSON | 跳过该目录 + error 字符串 |
| 缺 `id` / `contributes` 类型错误 | 跳过 + errors |
| id 非 kebab | **仍加载** + warning |
| 未知 `contributes.*` 键 | 忽略 + warning |
| 同 id 两插件 | 后扫覆盖 |

`discoverPluginsDetailed` 返回 `{ plugins, errors }`；`loadWorkspace` 把 errors 并入 `pluginMerge.errors`。

---

## 3. 合并与覆盖序

| 层 | skills | mcp servers |
|----|--------|-------------|
| bundled / extra / user / project skills | S-PORT | — |
| user `mcp.json` | — | M-GEN-8 底层 |
| project `mcp.json` | — | 盖 user |
| **plugins**（user 目录 → project 目录） | 盖同 skill id | 盖同 server name |

Slash 命令：后插件同名 command 覆盖前插件；冲突记 error 文案。

热加载：`/plugins reload`（PL2）→ 重扫 plugins → 刷新 skills catalog 段 + 可选重连 MCP。

---

## 4. plugin-creator（PL-SPEC-3）

Bundled skill：`packages/bundled-skills/plugin-creator/SKILL.md`  
只产出 **本 Spec** 脚手架；不写 Claude/Codex 官方 manifest。

---

## 5. PL-MKT 最小市场（PL-SPEC-5，保持）

> 极简子集：本地/URL 清单 + 复制安装。**不是**完整官方市场。

| 操作 | 说明 |
|------|------|
| 注册市场 | 本地目录（`bolo.marketplace.json` / `marketplace.json`）或 **https URL** 到 JSON |
| 搜索 | 已注册市场中按 id/name/description 过滤 |
| 安装 | **复制** 到 `~/.bolo/plugins/<id>/` 或项目 `.bolo/plugins/` |
| 卸载 | 删除对应 id |
| 热加载 | 安装后 `/plugins reload` |

### 清单格式 `bolo.marketplace.json`

```json
{
  "name": "my-market",
  "description": "optional",
  "plugins": [
    {
      "id": "demo-plug",
      "version": "1.0.0",
      "description": "hello",
      "source": { "type": "path", "path": "plugins/demo-plug" }
    }
  ]
}
```

- `source.path`：相对 marketplace 根；插件内需有 `bolo.plugin.json`  
- `source.url`：可登记；**安装**当前仅 path（url 请本地下载后 `path:` 装）

### Slash

```
/plugins market list
/plugins market add <path-or-url> [name]
/plugins market show <name>
/plugins search [query]
/plugins install <id>@<marketplace>
/plugins install path:<plugin-dir>
/plugins uninstall <id>
/plugins reload
```

`--project`：安装/卸载到项目 `.bolo/plugins`。

### 落盘

| 路径 | 内容 |
|------|------|
| `~/.bolo/marketplaces/known.json` | 已注册市场 |
| `~/.bolo/installed_plugins.json` | 安装账本 |
| `~/.bolo/plugins/<id>/` | 实际插件文件 |

---

## 6. 测试

```bash
npx tsx scripts/test-plugin-manifest.ts
npx tsx scripts/test-plugins-pl2.ts
npx tsx scripts/test-plugins-market.ts
npx tsx scripts/test-config.ts
```

---

## 7. 明确不做

- Claude / Codex **官方市场**与商标商店  
- 完整 zip / git / npm 运营市场（另刀）  
- 外来插件 **完整运行时**兼容（hooks/commands/agents 不保证）  
- 遥测  

## 8. 只读导入（IMPORT 最小）

| 配置 | 作用 |
|------|------|
| `extraSkillRoots` | 旁路 skill 根（S-PORT-2 / IMPORT-S1）；默认 off |
| `foreignPluginRoots` | 外来插件目录；只映射 skills（IMPORT-P1） |

API：`importForeignPluginSkills` / `detectForeignPluginDir`（`packages/plugins`）。  
失败面：unsupported contributes → warnings（IMPORT-X）。  
**禁止**写成「完全兼容 Claude/Codex」。

测试：

```bash
node --import tsx/esm scripts/test-import-compat.ts
```

---

**一句话：** 插件以 `bolo.plugin.json` 为唯一一等规范；坏插件隔离；skill/mcp 可独立；市场仅最小清单安装；外来目录仅 skills 只读映射。