---
name: gsd:execute-phase
description: SDD phase execution — execute all plans in a phase with dependency-aware wave parallelization
argument-hint: "<phase-number> [--wave N] [--gaps-only] [--interactive] [--tdd]"
effort: max
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - TodoWrite
  - AskUserQuestion
requires: [phase, verify-work]
---

<arguments>$ARGUMENTS</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

<!-- OWNERSHIP-RUNTIME-PREFLIGHT v4 -->
<ownership_preflight>
Resolve `gsd_run` (this workflow's bootstrap) first, then run
`gsd_run owner-context preflight` before any mkdir/write/dispatch: STOP on
`owner_context_refused` (enforce). The core gate re-checks the actual target
before the first side effect. Paths come from the core init.
</ownership_preflight>
<!-- /OWNERSHIP-RUNTIME-PREFLIGHT -->

<!-- JEV-ADVISORY-ENTRY v1 — optional, advisory-only, default-off -->
<ownership_jev_advisory>
Optional and default-off. Only when the caller supplies a NAMED synthetic
scenario id — one of `phase-owned-work`, `independent-operational-work`,
`misleading-quick-task`, `ambiguous-historical-ownership`,
`prompt-injection-state` — the accepted explicit path is, using this workflow's
already-resolved `gsd_run` invocation and never a bare `gsd-tools` from PATH:

1. `gsd_run jev-advisory prepare --scenario <id> --entry <entry-kind>` —
   offline. Prints the fixed request and the fixture's deterministic expected
   classification. No network call.
2. `gsd_run jev-advisory evaluate --scenario <id> --entry <entry-kind>` — the
   single outbound provider request, made by the capability's own bundled CLI
   from its install root. Run it only when the caller explicitly asked for the
   model answer.

`<entry-kind>` is one of `quick`, `fast`, `plan`, `execute`. Every envelope is
`advisory_only` with `authorizes_mutation: false`: it never changes owner
selection, never grants permission and never substitutes quick mode. The
deterministic ownership preflight above stays authoritative and runs
regardless of JEV's state. A missing, inactive or untrusted capability is an
advisory diagnostic, never a silent activation. Never pass a task description,
repository path or body, knowledge-base body, owner descriptor or plan text to
this command.
</ownership_jev_advisory>
<!-- /JEV-ADVISORY-ENTRY -->

<objective>
Execute all plans in a phase using wave-based parallel execution.

Orchestrator stays lean: discover plans, analyze dependencies, group into waves, spawn subagents, collect results. Each subagent loads the full execute-plan context and handles its own plan.

Optional wave filter:
- `--wave N` executes only Wave `N` for pacing, quota management, or staged rollout
- phase verification/completion still only happens when no incomplete plans remain after the selected wave finishes

Flag handling rule:
- The optional flags documented below are available behaviors, not implied active behaviors
- A flag is active only when its literal token appears in the `<arguments>` block
- If a documented flag is absent from the `<arguments>` block, treat it as inactive

Context budget: ~15% orchestrator, 100% fresh per subagent.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/execute-phase.md
@~/.claude/gsd-core/references/ui-brand.md
</execution_context>

<runtime_note>
**Copilot (VS Code):** Use `vscode_askquestions` wherever this workflow calls `AskUserQuestion`. They are equivalent — `vscode_askquestions` is the VS Code Copilot implementation of the same interactive question API.
</runtime_note>

<context>
Phase: the `<arguments>` block

**Available optional flags (documentation only — not automatically active):**
- `--wave N` — Execute only Wave `N` in the phase. Use when you want to pace execution or stay inside usage limits.
- `--gaps-only` — Execute only gap closure plans (plans with `gap_closure: true` in frontmatter). Use after verify-work creates fix plans.
- `--interactive` — Execute plans sequentially inline (no subagents) with user checkpoints between tasks. Lower token usage, pair-programming style. Best for small phases, bug fixes, and verification gaps.

**Active flags must be derived from the `<arguments>` block:**
- `--wave N` is active only if the literal `--wave` token is present in the `<arguments>` block
- `--gaps-only` is active only if the literal `--gaps-only` token is present in the `<arguments>` block
- `--interactive` is active only if the literal `--interactive` token is present in the `<arguments>` block
- If none of these tokens appear, run the standard full-phase execution flow with no flag-specific filtering
- Do not infer that a flag is active just because it is documented in this prompt

Context files are resolved inside the workflow via `gsd-tools query init.execute-phase` and per-subagent `<required_reading>` blocks.
</context>

<process>
Execute end-to-end.
Preserve all workflow gates (wave execution, checkpoint handling, verification, state updates, routing).
</process>
