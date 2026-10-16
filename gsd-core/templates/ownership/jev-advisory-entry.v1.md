---
type: workflow-fragment
---

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
