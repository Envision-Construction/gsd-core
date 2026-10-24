**Step 7: Deterministic merge**

Skip entirely if `$ISOLATION == "none"` — nothing was worktree-isolated,
there is nothing to merge (executors already committed to the primary
checkout in Step 6).

**Merge rounds.** Repeat until no wave has a mergeable prefix left (bounded
by `$ITEM_COUNT` rounds):

1. For each DISTINCT `wave` value present among items that are
   `status == "pending"` with a `${item_dir}/${quick_id}-SUMMARY.md` on disk
   (executor returned) and NOT yet merged: build `$WAVE_ORDER_JSON` — the
   `quick_id`s of every item AT THAT WAVE, in `$BATCH_MANIFEST_JSON.items`
   array order (this IS the order `computeWaves`/`partitionByFileOverlap`
   assigned — never re-sort it).

2. Build `$READY_JSON` — the subset of that wave's items whose
   `SUMMARY.md` already exists (an executor may still be mid-flight for a
   sibling in the same wave; row 33 — merges happen strictly in wave order,
   an out-of-order finisher waits):
   ```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
   QB_MERGE_ELIG_JSON=$(gsd_run quick-batch merge-eligible --wave-order "$WAVE_ORDER_JSON" --ready "$READY_JSON" --raw)
   ```
   Parse `mergeable` — the PREFIX of `$WAVE_ORDER_JSON` currently mergeable.
   If empty, skip this wave this round (its first item hasn't finished yet).

3. **Build the cleanup-wave manifest for `mergeable`, IN THAT ORDER** — fresh
   from each item's own PLAN.md, never from `BATCH.json`'s `planned_files`
   alone (Open Question 2's accepted resolution). `$mergeable` is a bash
   ARRAY (parsed from the JSON `mergeable` array) — never a plain
   space-joined string, which re-splits unpredictably between bash and zsh
   (#4109):
   ```bash
   for quick_id in "${mergeable[@]}"; do
     PLAN_CONTENT=$(cat "${ITEM_DIR}/${quick_id}-PLAN.md")
     ENTRY_JSON=$(gsd_run quick-batch cleanup-entry \
       --agent-id "agent-${quick_id}" \
       --worktree-path "$WT_PATH" \
       --branch "$WT_BRANCH" \
       --expected-base "$EXPECTED_BASE" \
       --allowed-bases '["'"$EXPECTED_BASE"'"]' \
       --plan-content "$PLAN_CONTENT" --raw)
     # append $ENTRY_JSON to the merge manifest's "worktrees" array, in order
   done
   ```
   (`$WT_PATH`/`$WT_BRANCH`/`$EXPECTED_BASE` per item come from the recorded
   `$QUICK_BATCH_WORKTREE_MANIFEST` entry Step 6 wrote for that `agent_id`
   THIS process, when present.

   **Durable fallback (#3677):** for an item Step 6 did NOT dispatch this
   process — the crash-window guard correctly skipped it because
   `SUMMARY.md` already existed from a PRIOR, now-dead coordinator process —
   `$QUICK_BATCH_WORKTREE_MANIFEST` has no entry for it at all (it is a
   fresh per-process `mktemp` file). Read `$WT_PATH`/`$WT_BRANCH`/
   `$EXPECTED_BASE` from that item's OWN durable
   `dispatched_worktree`/`dispatched_branch`/`dispatched_base` fields in
   `$BATCH_MANIFEST_JSON` instead — persisted by Step 6's own durable-
   persistence step at the time it actually created the worktree, in
   whichever process that was. If ALL THREE are still `null` (the item was
   never durably recorded — should not happen once Step 6 always persists
   on dispatch, but fail closed rather than guess): route this entry via
   `merge-routing --kind merge_failed --detail "missing durable worktree
   record"` the same as any other blocked entry below, and do NOT attempt
   the cleanup-wave call for it.)

4. **Merge, one at a time, via the SAME bounded primitive every other worktree
   consumer uses** (never hand-roll `git merge`):
   ```bash
   RETENTION_MANIFEST="$MERGE_MANIFEST_PATH"
   # Capture the v1 CLI exit without erasing it; retained integration exits 1 too.
   RETENTION_RC=0
   RETENTION_RESULT=$(gsd_run query worktree.cleanup-wave --manifest "$RETENTION_MANIFEST" --exit-contract=v1) || RETENTION_RC=$?
   printf '%s\n' "$RETENTION_RESULT"
   RETENTION_REPORT_RC=0
   # shellcheck disable=SC2016 # JavaScript template expressions must reach node literally.
   printf '%s\n' "$RETENTION_RESULT" | RETENTION_MANIFEST="$RETENTION_MANIFEST" RETENTION_EXIT="$RETENTION_RC" node -e '
   const fs = require("fs");
   try {
     const response = JSON.parse(fs.readFileSync(0, "utf8"));
     const manifest = JSON.parse(fs.readFileSync(process.env.RETENTION_MANIFEST, "utf8"));
     const expected = Array.isArray(manifest) ? manifest : manifest.worktrees;
     const result = response.result;
     if (!Array.isArray(expected) || !expected.length || !result ||
         !Array.isArray(result.entries) || result.entries.length !== expected.length ||
         !Array.isArray(result.pending) || result.pending.length ||
         response.ok !== false || result.ok !== false || result.reason !== "cleanup_blocked") {
       throw new Error("incomplete or unexpected cleanup response; retain every entry");
     }
     const key = e => JSON.stringify([e.agent_id, e.worktree_path, e.branch]);
     const wanted = new Map(expected.map(e => [key(e), e]));
     if (wanted.size !== expected.length) throw new Error("duplicate manifest identities");
     let confirmed = process.env.RETENTION_EXIT === "1";
     for (const entry of result.entries) {
       const requested = wanted.get(key(entry));
       if (!requested) throw new Error("unmatched result identity");
       wanted.delete(key(entry));
       console.error(`${entry.status}: integrated=${JSON.stringify(entry.integrated)}; reason=${entry.reason}; retained ${entry.worktree_path}`);
       const accepted = requested.retirement_authorization;
       if (entry.integrated !== true || entry.status !== "integrated_retained" ||
           entry.reason !== "retirement_manual_root_handoff_required" || !accepted ||
           entry.retirement_authorization?.accepted_head !== accepted.accepted_head) confirmed = false;
     }
     if (!confirmed) throw new Error("integration or retirement evidence needs root review; hold progression");
     console.error("Accepted integration confirmed; manual retirement held. Project verification may proceed separately; cleanup and phase acceptance are not complete.");
   } catch (error) {
     console.error(`BLOCKED: ${error.message}`);
     process.exitCode = 1;
   }
   ' || RETENTION_REPORT_RC=$?
   # Preserve the command failure even when accepted integration was observed.
   [ "$RETENTION_RC" -eq 0 ] || exit "$RETENTION_RC"
   [ "$RETENTION_REPORT_RC" -eq 0 ] || exit "$RETENTION_REPORT_RC"
   echo "BLOCKED: unexpected cleanup success; root review required before progression." >&2
   exit 1
   ```
   Before invoking integration, root must account for parent writers and
   surviving hooks. The helper holds unaccounted tracked, untracked, ignored
   or unknown parent inventory for manual root handling; clean tracked data
   has the observed `parent_head_before_merge` recovery boundary. Preflight
   reads are not an exclusive writer lease against later concurrent writes.

   `executeWorktreeWaveCleanupPlan` may evaluate pre-integration entry
   refusals independently. Every attempted failed or unverified merge halts
   the wave, including clean refusals, transport errors, timeouts/signals and
   success without verified integration. Absence of `MERGE_HEAD` does not
   authorize continuation. All pending entries remain retained for manual
   root recovery; no next round/invocation automatically resumes them. Before
   resume, root must account for the actual command-return index, worktree,
   sequencer/autostash state, recovery refs and all surviving writers/hooks,
   then reconcile current accepted evidence. Never abort/reset/stash/restore
   shared work as automatic recovery.

5. **Route each entry in the printed `response.result.entries`, retaining the actual command exit:**
   Read `execute-phase/steps/worktree-recovery-policy.md` § Accepted integration and manual retirement. The helper emits ordinary JSON with nested `result.entries`, `result.pending` and top-level `ok`; `--raw` does not create a different cleanup result. The snippet preserves v1 exit 1, including for accepted integration with retirement held. Never use `|| true` to hide it. Missing/malformed output, an unexpected exit, omitted/mismatched entries or pending entries holds the affected wave for root review; do not complete those items or infer success from the invocation.

   - `integrated === true`, `status == "integrated_retained"`, reason `retirement_manual_root_handoff_required`, and confirmed by the reporter: accepted integration, **manual retirement pending**. The item may proceed to its independent verification/review and Step 9 completion gates. Keep `dispatched_worktree`/`dispatched_branch`/`dispatched_base` and the manifest intact; the worktree, ref and registration still exist. Do not call this cleanup success and do not re-merge an item whose accepted integration has already been observed this run.
   - `integrated === false` (`status == "blocked"`), `integrated === null` / `integration_unknown_retained`, another retention reason or any unrecognized legacy status: hold this item. Report observed integration and the exact reason, then route via:
     ```bash
     gsd_run quick-batch merge-routing --kind merge_failed --detail "$reason" --raw
     ```
     (or `--kind scope_violation` when `$reason` names an undeclared deletion). Preserve all work/recovery fields (`preserveWorktree: true`), do NOT call `quick-batch complete`, and continue only unrelated items/waves whose separate manifest responses independently confirm integration. A mixed response holds completion for this manifest pending root review. An already-integrated but differently blocked entry is not a failed-to-integrate claim; it needs root review. Do not blindly repeat a held merge on the next round; reconcile current accepted evidence first.

   The cleanup manifest must use a top-level `worktrees` array (or the supported array form), never an `entries` property. `quick-batch cleanup-entry` supplies scope metadata, not owner acceptance: preserve root-reviewed `retirement_authorization` for that exact recorded entry when assembling the manifest. Missing acceptance or native owner completion is a genuine hold; never synthesize it from a SUMMARY, process age or a matching email.

Continue to Step 9 (`--validate` routes through the verification step first)
once every wave with a mergeable prefix has been processed this round.
