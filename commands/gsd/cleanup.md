---
name: gsd:cleanup
description: Archive accumulated phase directories from completed milestones
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - AskUserQuestion
requires: [phase]
---
<objective>
Archive phase directories from completed milestones into `{planning_dir}/milestones/v{X.Y}-phases/`, where `{planning_dir}` is the scoped planning directory (`gsd_run query planning.dir --raw`).

Use when `{planning_dir}/phases/` has accumulated directories from past milestones.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/cleanup.md
</execution_context>

<process>
Execute end-to-end.
Identify completed milestones, show a dry-run summary, and archive on confirmation.
</process>
