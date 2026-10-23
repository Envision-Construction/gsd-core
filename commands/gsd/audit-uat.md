---
name: gsd:audit-uat
description: Cross-phase audit of all outstanding UAT and verification items
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---
<objective>
Scan all phases for pending, skipped, blocked, and human_needed UAT items. Cross-reference against codebase to detect stale documentation. Produce prioritized human test plan.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/audit-uat.md
</execution_context>

<context>
Core planning files are loaded in-workflow via CLI.

**Scope** (`{planning_dir}` = `gsd_run query planning.dir --raw`):
Glob: {planning_dir}/phases/*/*-UAT.md
Glob: {planning_dir}/phases/*/*-VERIFICATION.md
</context>
