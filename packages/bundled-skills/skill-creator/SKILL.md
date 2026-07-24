---
name: skill-creator
id: skill-creator
description: Create and iterate Bolo skills (SKILL.md layout, S-PORT frontmatter contract, catalog-safe body).
when_to_use: Use when the user wants a new skill, scaffold SKILL.md, or improve an existing skill. Examples: "create a skill", "write SKILL.md", "/skill-creator", "scaffold a skill".
user-invocable: true
disable-model-invocation: false
---

# Skill creator (Bolo)

Guide the user to produce a **usable** skill directory that matches the **S-PORT portable contract** (`docs/SKILLS.md`).  
No telemetry, **no marketplace**, **no remote/URL skill install**, no network required.

## Target layout

```text
.bolo/skills/<id>/SKILL.md          # project (preferred while developing)
# or
~/.bolo/skills/<id>/SKILL.md        # user-global
```

Optional siblings next to `SKILL.md`: `scripts/`, `references/`, templates — keep the skill self-contained.

**Discovery precedence** (same `id`, later wins):  
`bundled` → `extra` (`config.extraSkillRoots`, default off) → `user` → `project` → `plugin`.

## Frontmatter (S-PORT-1 canonical)

Write **canonical keys** (aliases like `whenToUse` also parse, but prefer these):

```markdown
---
name: <short-title>
id: <kebab-id>
description: <one-line catalog blurb>
when_to_use: Use when … Examples: "…"
user-invocable: true
disable-model-invocation: false
---

# Instructions

Executable steps for the agent. Prefer checklists over essays.
```

| Field | Required | Rules |
|-------|----------|--------|
| `id` | recommended | kebab-case; defaults to **folder name** if omitted |
| `name` | recommended | short title; defaults to `id` |
| `description` | **yes for catalog quality** | one line; keep **≤ ~200–250 chars** (catalog clips at 250) |
| `when_to_use` | **yes for auto-invoke** | start with "Use when…"; include trigger phrases / example user messages; **≤ ~250 chars** in practice |
| `user-invocable` | optional | default `true`; `false` → block `/skill` and `/<id>` |
| `disable-model-invocation` | optional | default `false`; `true` → omit from model catalog + block Skill tool; slash still ok if user-invocable |

**Call matrix (orthogonal):**

| | Skill tool (model) | `/skill` · `/<id>` | Model catalog |
|--|--------------------|--------------------|---------------|
| default | allow | allow | listed |
| `disable-model-invocation: true` | deny | allow* | omitted |
| `user-invocable: false` | allow | deny | listed |

\*if `user-invocable` is not false.

Unknown frontmatter keys are ignored for meta (safe). Booleans: `true/false`, `yes/no`, `on/off`, `1/0`.

## Steps (do in order)

1. **Name the skill** — kebab-case `id` (folder name). Avoid colliding with built-ins unless intentional override.
2. **Write `description` + `when_to_use`** — catalog-only; full body is **not** in the default system prompt. Budget is ~1% of context for the whole listing.
3. **Write the body** — concrete steps: inputs, files to create/edit, verification commands, done criteria. Prefer success criteria on each major step.
4. **Create the directory** under project `.bolo/skills/<id>/` unless the user asks for global (`~/.bolo/skills/`).
5. **Write `SKILL.md`** with frontmatter + body. Prefer showing the full file for review before write when the user is iterating.
6. **Verify** — new session or skill rediscovery; appears in `/skills`, model catalog (unless disable-model), Skill tool / slash. Same `id` in project overrides user/bundled.
7. **Iterate** — if vague, tighten `when_to_use` and add failure cases / hard constraints.

## Quality bar

- Instructions must be executable without reading Bolo source.
- Prefer local files and shell over external APIs.
- **Never** add telemetry, analytics, or phone-home steps.
- Do not dump huge reference text into frontmatter.
- **Do not** design skills that require downloading skill packs from a URL or third-party skill store (S-PORT-7: remote skills out of scope).
- Do not promise Claude/Codex official marketplace compatibility; Bolo format is first-class.

## Explicitly out of scope (S-PORT-7)

- Remote / HTTP skill install
- MCP-hosted skills as a distribution channel
- Auto-import of `.claude-plugin` / `.codex-plugin` packages as skills (optional later importer only)

If the user asks for those, explain the limit and offer a **local** `SKILL.md` instead.

## After create

Tell the user:

- Path written
- How to invoke: Skill tool `{ "skill": "<id>" }`, or slash `/<id>` / `/skill <id>`
- That project skills override user and bundled on the same id
- Optional: `/skills` shows flags + catalog budget line; `/context` shows skill catalog stats

## Reference

- Contract: `docs/SKILLS.md` (frontmatter, merge, invoke matrix, catalog budget)
- Planning: `docs/TODO_SKILL_MCP_PLUGIN.md` (S-PORT)