---
name: gsd:ship
description: Create PR, run review, and prepare for merge after verification passes
argument-hint: "[phase number or milestone, e.g., '4' or 'v1.0']"
allowed-tools:
  - Read
  - Bash
  - Grep
  - Glob
  - Write
  - AskUserQuestion
requires: [review, verify-work]
---

<arguments>$ARGUMENTS</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

**Project selection:** if the arguments include `--project <name>`, the user is targeting the named project in `.planning/<name>/`. In the first shell command you run for this command (once `gsd_run` is defined), run `gsd_run query project.set <name>` and stop if it fails; then treat the remaining arguments as if `--project <name>` were absent. The selection holds for the rest of the session, including subagents.

<objective>
Bridge local completion → merged PR. After /gsd:verify-work passes, ship the work: push branch, create PR with auto-generated body, optionally trigger review, and track the merge.

Closes the plan → execute → verify → ship loop.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/ship.md
</execution_context>

Execute the ship workflow from @~/.claude/gsd-core/workflows/ship.md end-to-end.
