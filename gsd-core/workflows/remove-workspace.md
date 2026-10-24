<purpose>
Inventory a GSD workspace for manual root retirement; retain files, worktrees and registrations pending custody and recovery review.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

## 1. Setup

Extract workspace name from $ARGUMENTS.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --raw --default "" 2>/dev/null || echo "")
INIT=$(gsd_run query init.remove-workspace "$WORKSPACE_NAME")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

Parse JSON for: `workspace_name`, `workspace_path`, `has_manifest`, `strategy`, `repos`, `repo_count`, `dirty_repos`, `has_dirty_repos`.

**If no workspace name provided:**

First run `/gsd:workspace --list` to show available workspaces, then ask:


**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Antigravity, etc.) where `AskUserQuestion` is not available.
Use AskUserQuestion:
- header: "Remove Workspace"
- question: "Which workspace do you want to remove?"
- requireAnswer: true

Re-run init with the provided name.

## 2. Safety Checks

**If `has_dirty_repos` is true:**

```
Cannot remove workspace "$WORKSPACE_NAME" — the following repos have uncommitted changes:

  - repo1
  - repo2

Preserve these changes and hand their inventory to root for custody/recovery review. Do not automatically stash, commit or discard them.
```

Exit. Do NOT proceed.

## 3. Manual Root Retirement Hold

The dirty-repo summary and typing the workspace name do not establish custody of all files, ignored data, nested checkouts or writers. Automatic workspace/worktree retirement is held for every strategy. Do not remove a worktree, unlock it, prune registrations, delete refs or recursively delete the workspace directory.

Read `execute-phase/steps/worktree-recovery-policy.md` § Accepted integration and manual retirement. Hand root the exact workspace/repository paths, registered branches, current HEADs, known owner records and all unresolved inventory/recovery questions. Root must account for every writer and independently retained recovery for each checkout before any manual native Git retirement. Missing/unknown state retains the entire workspace; no force fallback.

```bash
echo "BLOCKED: workspace retained; manual root retirement required: $WORKSPACE_PATH" >&2
exit 1
```

## 4. Report

Report `Workspace retained; retirement pending root custody review`, its path and the known/unknown repository inventory. Do not report the workspace deleted or worktrees cleaned up. Project verification and product acceptance remain separate gates.

</process>
