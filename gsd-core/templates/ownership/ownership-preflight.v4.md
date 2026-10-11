<!-- OWNERSHIP-RUNTIME-PREFLIGHT v4 -->
<ownership_preflight>
Resolve `gsd_run` (this workflow's bootstrap) first, then run
`gsd_run owner-context preflight` before any mkdir/write/dispatch: STOP on
`owner_context_refused` (enforce). The core gate re-checks the actual target
before the first side effect. Paths come from the core init.{{QUICK_EXTRA}}
</ownership_preflight>
<!-- /OWNERSHIP-RUNTIME-PREFLIGHT -->
