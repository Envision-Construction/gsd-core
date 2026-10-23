---
name: gsd:new-project
description: Initialize a new project, or a separate one beside an existing project, with deep context gathering
argument-hint: "[--auto]"
allowed-tools:
  - Read
  - Bash
  - Grep
  - Write
  - Agent
  - AskUserQuestion
requires: [config, phase, plan-phase]
---

<arguments>$ARGUMENTS</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

**Project selection:** if the arguments include `--project <name>`, the user is targeting the named project in `.planning/<name>/`. In the first shell command you run for this command (once `gsd_run` is defined), run `gsd_run query project.set <name>` and stop if it fails; then treat the remaining arguments as if `--project <name>` were absent. The selection holds for the rest of the session, including subagents.

<runtime_note>
**Copilot (VS Code):** Use `vscode_askquestions` wherever this workflow calls `AskUserQuestion`. They are equivalent — `vscode_askquestions` is the VS Code Copilot implementation of the same interactive question API.
</runtime_note>

<context>
**Flags:**
- `--auto` — Automatic mode. After config questions, runs research → requirements → roadmap without further interaction. Expects idea document via @ reference.
</context>

<objective>
Initialize a new project through unified flow: questioning → research (optional) → requirements → roadmap.

**Creates** (`<project>/` when this run starts a separate project beside an existing one):
- `.planning/[<project>/]PROJECT.md` — project context
- `.planning/[<project>/]config.json` — workflow preferences
- `.planning/[<project>/]research/` — domain research (optional)
- `.planning/[<project>/]REQUIREMENTS.md` — scoped requirements
- `.planning/[<project>/]ROADMAP.md` — phase structure
- `.planning/[<project>/]STATE.md` — project memory

**After this command:** Run `/gsd:plan-phase 1` to start execution.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/new-project.md
@~/.claude/gsd-core/references/questioning.md
@~/.claude/gsd-core/references/ui-brand.md
@~/.claude/gsd-core/templates/project.md
@~/.claude/gsd-core/templates/requirements.md
</execution_context>

<process>
Execute end-to-end.
Preserve all workflow gates (validation, approvals, commits, routing).
</process>
