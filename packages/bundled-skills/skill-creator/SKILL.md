---
name: skill-creator
id: skill-creator
description: Create and iterate Bolo skills (SKILL.md layout, frontmatter, catalog-safe body).
when_to_use: User wants a new skill, scaffold SKILL.md, or improve an existing skill. Examples: "create a skill", "write SKILL.md", "/skill-creator".
user-invocable: true
disable-model-invocation: false
---

# Skill creator (Bolo)

Guide the user to produce a **usable** skill directory. No telemetry, no marketplace, no network required.

## Target layout

```text
.bolo/skills/<id>/SKILL.md          # project (preferred while developing)
# or
~/.bolo/skills/<id>/SKILL.md        # user-global
```

Optional siblings next to `SKILL.md`: `scripts/`, `references/`, templates — keep the skill self-contained.

## Frontmatter (required shape)

```markdown
---
name: <short-title>
id: <kebab-id>                    # optional; defaults to folder name
description: <one-line catalog blurb>
when_to_use: <when the model should call this skill>
user-invocable: true              # allow /skill-id slash
disable-model-invocation: false   # true = user slash only
---

# Instructions

Executable steps for the agent. Prefer checklists over essays.
```

## Steps (do in order)

1. **Name the skill** — kebab-case `id` (folder name). Avoid colliding with built-ins unless intentional override.
2. **Write `description` + `when_to_use`** — catalog only; keep under ~200 chars each. Full body is NOT in the default system prompt.
3. **Write the body** — concrete steps: inputs, files to create/edit, verification commands, done criteria.
4. **Create the directory** under project `.bolo/skills/<id>/` unless the user asks for global.
5. **Write `SKILL.md`** with frontmatter + body.
6. **Verify** — restart session or re-run skill discovery; skill appears in catalog / `Skill` tool / `/skills`. Same `id` in project overrides user/bundled.
7. **Iterate** — if the skill is vague, tighten `when_to_use` and add failure cases.

## Quality bar

- Instructions must be executable without reading Bolo source.
- Prefer local files and shell over external APIs.
- Never add telemetry, analytics, or phone-home steps.
- Do not dump huge reference dumps into frontmatter.

## After create

Tell the user:

- Path written
- How to invoke: `Skill` tool with `{ "skill": "<id>" }`, or slash `/<id>` / `/skill <id>`
- That project skills override user and bundled on the same id