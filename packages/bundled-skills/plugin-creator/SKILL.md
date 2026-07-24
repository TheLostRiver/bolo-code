---
name: plugin-creator
id: plugin-creator
description: Scaffold a Bolo plugin (bolo.plugin.json Spec v0 + contributes for skills/hooks/mcp/commands).
when_to_use: Use when the user wants a new plugin, bolo.plugin.json, or to package skills/hooks/commands as a Bolo plugin. Examples: "create a plugin", "scaffold bolo.plugin.json", "/plugin-creator".
user-invocable: true
disable-model-invocation: false
---

# Plugin creator (Bolo Spec v0)

Scaffold a **loadable** plugin that matches **Bolo Plugin Spec v0** (`docs/PLUGINS.md`).  
No telemetry, **no Claude/Codex official marketplace**, no forced network.

## Target layout

```text
.bolo/plugins/<plugin-id>/
  bolo.plugin.json            # required
  skills/<skill-id>/SKILL.md  # optional (default scan if contributes.skills omitted)
  commands/*.md               # optional slash prompts
  hooks.json                  # optional; only if contributes.hooks set
  mcp.json                    # optional; only if contributes.mcpServers set
  agents/                     # optional later
```

User-global: `~/.bolo/plugins/<plugin-id>/`.

## Manifest (`bolo.plugin.json`) — Spec v0

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "contributes": {
    "skills": ["skills"],
    "hooks": "hooks.json",
    "mcpServers": "mcp.json",
    "agents": ["agents"],
    "commands": ["commands"]
  }
}
```

### Rules (must follow)

| Rule | Detail |
|------|--------|
| `id` | **Required**, prefer kebab-case (`my-plugin`). Empty → plugin **skipped**. |
| Paths | All `contributes` paths are **relative to the plugin root**. |
| `skills` | Directories scanned for `<name>/SKILL.md`. Omit key → default `skills/`. Explicit `[]` → no skills. |
| `commands` | Directories of `*.md` slash prompts; slash name defaults to `plugin-id:file-stem`. |
| `hooks` | Single relative file path to hooks JSON. |
| `mcpServers` | Single relative file path to mcp.json (merged after user/project mcp; same name overrides). |
| Unused keys | **Omit** unused contributes; do not invent empty files. |
| Format | Only `bolo.plugin.json` — **not** `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json`. |

## Steps (do in order)

1. **Choose `plugin-id`** — kebab-case; folder name under `.bolo/plugins/`.
2. **Create the folder** under project `.bolo/plugins/<plugin-id>/` (or user plugins if asked).
3. **Write `bolo.plugin.json`** with `id`, `name`, `version`, and only needed contributes.
4. **If shipping skills** — `skills/<skill-id>/SKILL.md` (use **skill-creator** / S-PORT frontmatter).
5. **If shipping hooks** — `hooks.json` + `contributes.hooks`.
6. **If shipping MCP** — `mcp.json` + `contributes.mcpServers` (support `${VAR}` in env/headers after M-GEN-6).
7. **If shipping slash commands** — `commands/<name>.md` (optional frontmatter `name` / `description`); invoke as `/plugin-id:name`.
8. **Verify** — new session or `/plugins reload`; check `/plugins` · `/plugins commands`; bad plugins should not crash others.
9. **Tell the user** — root path, contributes, that same skill id / mcp name from plugins **overrides** earlier layers.

## Quality bar

- Valid JSON, offline-loadable.
- Prefer project plugins while iterating.
- No telemetry, license phone-home, or remote skill fetch.
- First version can be one skill or one command file only.
- Do **not** promise Claude/Codex marketplace install.

## After create

- Plugin root + manifest path  
- Wired contributes  
- `/plugins` · `/plugins commands` · `/plugins reload`  
- Docs: `docs/PLUGINS.md` (Spec v0)