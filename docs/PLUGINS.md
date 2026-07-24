# 插件市场（PL-MKT 最小）

> 对照 HelsincyCode marketplace 的**极简子集**：本地/URL 清单 + 安装到 plugins 目录。  
> **不是**完整官方市场（无 zip cache、企业策略、npm、OAuth、自动更新守护）。无遥测。

## 能力

| 操作 | 说明 |
|------|------|
| 注册市场 | 本地目录（含 `bolo.marketplace.json` / `marketplace.json`）或 **https URL** 到 JSON |
| 搜索 | 在已注册市场中按 id/name/description 过滤 |
| 安装 | 将插件 **复制** 到 `~/.bolo/plugins/<id>/` 或项目 `.bolo/plugins/` |
| 卸载 | 删除 plugins 目录下对应 id |
| 热加载 | 安装后 `/plugins reload`（PL2） |

## 清单格式 `bolo.marketplace.json`

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

- `source.path`：相对 **marketplace 根目录** 的插件文件夹（内含 `bolo.plugin.json`）
- `source.url`：登记可用；**安装** 当前仅支持 path（url 插件请本地下载后 `path:` 安装）

## Slash

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

## 落盘

| 路径 | 内容 |
|------|------|
| `~/.bolo/marketplaces/known.json` | 已注册市场 |
| `~/.bolo/installed_plugins.json` | 安装账本 |
| `~/.bolo/plugins/<id>/` | 实际插件文件 |

## 测试

```bash
npx tsx scripts/test-plugins-market.ts
npx tsx scripts/test-plugins-pl2.ts
```

## 规范优先级

- **一等公民：** `bolo.plugin.json` + `bolo.marketplace.json` + 本文 / 将升 **Spec v0**  
- **不接** Claude / Codex 官方市场（版权与账号）  
- 外来 `.claude-plugin` / `.codex-plugin` 仅可选只读 importer（后置）  

规划切片：**`docs/TODO_SKILL_MCP_PLUGIN.md`（PL-SPEC · IMPORT 附录）**。

## 后置（非本最小版）

- 完整官方 marketplace 命名/策略（**Bolo 自有**运营深度，非借用他厂商店）  
- zip / git / npm 源安装  
- 自动更新 / 依赖解析  
- 插件市场 Web UI