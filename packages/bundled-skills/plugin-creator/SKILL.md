---
name: plugin-creator
id: plugin-creator
description: Scaffold a Bolo plugin (bolo.plugin.json + contributes for skills/hooks/mcp).
when_to_use: User wants a new plugin, bolo.plugin.json, or to package skills/hooks as a plugin. Examples: "create a plugin", "scaffold bolo.plugin.json", "/plugin-creator".
user-invocable: true
disable-model-invocation: false
---

# Plugin creator (Bolo)

Scaffold a **loadable** plugin directory. No telemetry, no marketplace, no forced network.

## Target layout

```text
.bolo/plugins/<plugin-id>/
  bolo.plugin.json
  skills/                 # optional; one skill per subdir
    <skill-id>/SKILL.md
  hooks.json              # optional; if contributes.hooks points here
  mcp.json                # optional; if contributes.mcpServers points here
  agents/                 # optional later
```

User-global equivalent: `~/.bolo/plugins/<plugin-id>/`.

## Manifest (`bolo.plugin.json`)

Minimal:

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

Rules:

- `id` is required (loader skips manifests without it).
- Paths in `contributes` are **relative to the plugin root**.
- `skills` entries are directories scanned for `<name>/SKILL.md` (same as skill discovery).
- `commands` entries are directories of `*.md` slash prompts (default name `plugin-id:file-stem`).
- Omit unused contribute keys rather than inventing empty files.

## Steps (do in order)

1. **Choose `plugin-id`** — kebab-case; matches folder name under `.bolo/plugins/`.
2. **Create the folder** under project `.bolo/plugins/<plugin-id>/` (or user plugins if asked).
3. **Write `bolo.plugin.json`** with `id`, `name`, `version`, and only the contributes you need.
4. **If shipping skills** — create `skills/<skill-id>/SKILL.md` (use skill-creator patterns for frontmatter/body).
5. **If shipping hooks** — write `hooks.json` matching Bolo hooks config shape; set `contributes.hooks` to that file.
6. **If shipping MCP** — write `mcp.json` server list; set `contributes.mcpServers`.
7. **If shipping slash commands** — add `commands/<name>.md` (optional frontmatter `name` / `description`); invoke as `/plugin-id:name`.
8. **Verify** — new session or mid-session `/plugins reload` (PL2); skills merge (later sources override same skill id).
9. **Document for the user** — path, contributes, `/plugins` · `/plugins commands` · `/plugins reload`.

## Quality bar

- Manifest must be valid JSON and loadable offline.
- Prefer project plugins while iterating.
- No telemetry, license phone-home, or remote skill fetch in the scaffold.
- Keep the first version small: one skill or one hooks file is enough.

## After create

Tell the user:

- Plugin root path and manifest path
- Which contributes were wired
- That skill ids from plugins override bundled/user/project on merge (last write wins in workspace load order)