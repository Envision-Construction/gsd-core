---
name: gsd:new-milestone
description: Start a new milestone cycle — update PROJECT.md and route to requirements
argument-hint: "[milestone name, e.g., 'v1.1 Notifications'] [--ws <name>] [--reset-phase-numbers]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Agent
  - AskUserQuestion
requires: [new-project, phase, plan-phase]
---

<arguments>$ARGUMENTS</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

**Project selection:** if the arguments include `--project <name>`, the user is targeting the named project in `.planning/<name>/`. In the first shell command you run for this command (once `gsd_run` is defined), run `gsd_run query project.set <name>` and stop if it fails; then treat the remaining arguments as if `--project <name>` were absent. The selection holds for the rest of the session, including subagents.

<objective>
Start a new milestone: questioning → research (optional) → requirements → roadmap.

Brownfield equivalent of new-project. Project exists, PROJECT.md has history. Gathers "what's next", updates PROJECT.md, then runs requirements → roadmap cycle.

**Creates/Updates** (`<project>/` for a named project, `workstreams/<ws>/` with `--ws`):
- `.planning/[<project>/]PROJECT.md` — updated with new milestone goals
- `.planning/[<project>/]research/` — domain research (optional, NEW features only)
- `.planning/[<project>/][workstreams/<ws>/]REQUIREMENTS.md` — scoped requirements for this milestone
- `.planning/[<project>/][workstreams/<ws>/]ROADMAP.md` — phase structure (continues numbering)
- `.planning/[<project>/][workstreams/<ws>/]STATE.md` — reset for new milestone

**After:** `/gsd:plan-phase [N]` to start execution.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/new-milestone.md
@~/.claude/gsd-core/references/questioning.md
@~/.claude/gsd-core/references/ui-brand.md
@~/.claude/gsd-core/templates/project.md
@~/.claude/gsd-core/templates/requirements.md
</execution_context>

<context>
Milestone name: the `<arguments>` block (optional - will prompt if not provided)

Project and milestone context files are resolved inside the workflow (`init new-milestone`) and delegated via `<required_reading>` blocks where subagents are used.
</context>

<process>
Execute end-to-end.
Preserve all workflow gates (validation, questioning, research, requirements, roadmap approval, commits).
</process>
