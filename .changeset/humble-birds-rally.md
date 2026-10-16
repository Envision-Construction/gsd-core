---
type: Added
pr: 3
---
**Workflow ownership is now enforced at GSD write boundaries** — every mutating command binds its concrete target(s) to the caller's declared writable scopes before the first side effect; `init`/dispatch carry a versioned `owner_context` and an ownership refusal exits non-zero with the stable `owner_context_refused` reason under an enforce policy (audit stays the default).
