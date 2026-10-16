<!-- OWNERSHIP-RUNTIME-PREFLIGHT v3 (patch-gsd-ownership-runtime) -->
<ownership_preflight>
Before creating a planning directory, editing planning state, or dispatching a
leaf agent, resolve ownership with the ACCEPTED core interface via the RESOLVED
`gsd_run` invocation this workflow already defines — never treat the caller's
cwd as the intended owner, and never call a bare `gsd-tools` from PATH:

1. Run `gsd_run owner-context preflight` (add `--json-errors` for a structured
   outcome). Under enforce, a missing, invalid, stale, or otherwise refused
   context exits non-zero with `owner_context_refused`: STOP the affected
   operation before any mkdir, edit, or dispatch. A valid, authorized context may
   proceed — but only for a target inside its verified writable scopes, never
   outside them.
2. Under audit it exits 0 and records the unresolved observation; report that
   observation honestly and never describe audit as enforcement.
3. Resolve the quick path from the core, not a literal: use the `quick_dir` /
   `task_dir` fields from `gsd_run init.quick` output. A hard-coded
   `.planning/quick` bypasses GSD_PROJECT / GSD_WORKSTREAM.
</ownership_preflight>
<!-- /OWNERSHIP-RUNTIME-PREFLIGHT -->