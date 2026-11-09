#!/usr/bin/env bash
# Fork-only pre-merge gate for Envision-Construction/gsd-core (see .github/fork/README.md).
# Upstream has no .github/fork/ and npm does not ship .github/, so upstream syncs never conflict.
#
# Usage, from a gsd-core checkout whose `origin` is the fork:
#   bash .github/fork/pre-merge-gate.sh <pr> [--squash|--merge] [--no-regression-test] [--dry-run]
#
# An admin merge bypasses review and policy gates, never tests. The gate merges the PR head only if
#   1. deterministic local checks pass on that exact head (clean install and build, lint:ci pinned to
#      the merge base, generated artifacts judged by their OUTPUT), and
#   2. the PR's own CI Tests run on that exact head succeeded (it waits for the run to finish).
# Tests are judged by CI, not locally: macOS has environment-only failures CI's runners do not.
#   --no-regression-test   GSD_SKIP_REGRESSION_TEST_GATE=1 for lint:ci (prose-only fixes)
#   --dry-run              run every check, do not merge
set -euo pipefail

SLUG=Envision-Construction/gsd-core
PR=${1:?usage: pre-merge-gate.sh <pr> [--squash|--merge] [--no-regression-test] [--dry-run]}
shift
METHOD=--squash; DRY=0; SKIP_RT=
for a in "$@"; do
  case $a in
    --squash|--merge) METHOD=$a ;;
    --no-regression-test) SKIP_RT=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done
die() { printf '\nGATE FAILED (PR #%s): %s\n' "$PR" "$*" >&2; exit 1; }
REPO=$(git rev-parse --show-toplevel)

# 0. Disk: the operator floor is 70 GiB; npm ci needs headroom above it.
FREE=$(df -k "$REPO" | awk 'NR==2 {print int($4/1048576)}')
[ "$FREE" -ge "${MIN_FREE_GIB:-80}" ] || die "only $FREE GiB free (< ${MIN_FREE_GIB:-80})"

# 1. PR facts. Fetch by SHA so no shared ref in the common git dir moves.
read -r STATE BASE_REF HEAD_SHA < <(gh pr view "$PR" --repo "$SLUG" --json state,baseRefName,headRefOid --jq '[.state,.baseRefName,.headRefOid]|@tsv')
[ "$STATE" = OPEN ] || die "PR state is '$STATE'"
TIP=$(git -C "$REPO" ls-remote origin "refs/heads/$BASE_REF" | cut -f1)
git -C "$REPO" fetch --quiet --no-tags origin "$TIP" "refs/pull/$PR/head"
git -C "$REPO" cat-file -e "$HEAD_SHA^{commit}" || die "PR head $HEAD_SHA was not fetched (did it move?)"
BASE_SHA=$(git -C "$REPO" merge-base "$TIP" "$HEAD_SHA")
echo "gate: PR #$PR head ${HEAD_SHA:0:9}, merge base ${BASE_SHA:0:9}, $FREE GiB free"

# 2. Scratch worktree at the PR head, a throwaway HOME, and a temporary base ref for the
#    diff-based lints (they read origin/<GITHUB_BASE_REF>). All removed on exit; failing logs kept.
TMP=$(mktemp -d /private/tmp/gsd-gate-XXXXXX)
WT=$TMP/head; H=$TMP/home; GATE_REF=gate-base-$$; LOGS=$HOME/.cache/gsd-gate/logs
cleanup() {
  cd "$REPO"
  git worktree remove --force "$WT" 2>/dev/null || true
  git update-ref -d "refs/remotes/origin/$GATE_REF" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
mkdir -p "$H" "$LOGS"
git -C "$REPO" update-ref "refs/remotes/origin/$GATE_REF" "$BASE_SHA"
git -C "$REPO" worktree add --quiet --detach "$WT" "$HEAD_SHA"
cd "$WT"
E=(env -i HOME="$H" PATH=/opt/homebrew/bin:/usr/bin:/bin npm_config_cache="$HOME/.npm")
run() {  # run LABEL CMD... : output to a log; on failure keep the log and show its tail
  local label=$1; shift
  "$@" > "$TMP/$label.log" 2>&1 && return 0
  cp "$TMP/$label.log" "$LOGS/pr$PR-$label.log"
  tail -30 "$TMP/$label.log"
  die "$label (full log: $LOGS/pr$PR-$label.log)"
}

# 3. Install and build. A build that rewrites tracked files means generated output was not committed.
run npm-ci "${E[@]}" npm ci --no-audit --no-fund
# lint-workflow-shellcheck downloads a pinned ShellCheck into node_modules/.cache; keep it across runs.
mkdir -p "$HOME/.cache/gsd-gate/shellcheck" node_modules/.cache
ln -sfn "$HOME/.cache/gsd-gate/shellcheck" node_modules/.cache/shellcheck
run build "${E[@]}" npm run build
[ -z "$(git status --porcelain)" ] || { git status --short | head -20; die "npm run build changed tracked files: commit the regenerated output"; }

# 4. Lint exactly as CI's lint-tests job does for a PR, pinned to the merge base.
run lint-ci "${E[@]}" CI=true GITHUB_BASE_REF="$GATE_REF" GSD_REGRESSION_GATE_BASE="$BASE_SHA" GSD_SKIP_REGRESSION_TEST_GATE="$SKIP_RT" npm run lint:ci

# 5. Generators outside lint:ci. benchmark-compact-content ALWAYS exits 0 ("REPORT, not a gate"),
#    so its output decides; tests/benchmark-compact-content.test.cjs requires 'up to date'.
run research-agents "${E[@]}" node scripts/gen-research-agents.cjs --check
run parity-corpus "${E[@]}" node scripts/gen-prompt-budget-parity-corpus.cjs --check
OUT=$("${E[@]}" node scripts/benchmark-compact-content.cjs --check 2>&1) || die "benchmark-compact-content crashed"
case $OUT in
  *"is up to date with the live recompute"*) ;;
  *) printf '%s\n' "$OUT" | head -5; die "compact-content baseline drift: run node scripts/benchmark-compact-content.cjs --write and commit it" ;;
esac
echo "gate: local checks passed"

# 6. CI is the test verdict: the PR's Tests run on this exact head must succeed. Wait for it.
RUN_ID=$(gh run list --repo "$SLUG" --workflow test.yml --commit "$HEAD_SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty')
[ -n "$RUN_ID" ] || die "no Tests run for head ${HEAD_SHA:0:9} yet (push the branch, open the PR, rerun)"
echo "gate: waiting for Tests run $RUN_ID on ${HEAD_SHA:0:9}"
if ! gh run watch "$RUN_ID" --repo "$SLUG" --exit-status --interval 60 > "$TMP/ci-watch.log" 2>&1; then
  gh run view "$RUN_ID" --repo "$SLUG" --json jobs --jq '.jobs[] | select(.conclusion=="failure") | "  failed: \(.name)"' >&2 || true
  die "Tests run $RUN_ID failed on ${HEAD_SHA:0:9}: gh run view $RUN_ID --repo $SLUG --log-failed"
fi

# 7. Merge only the exact head that passed.
printf '\nGATE PASSED: PR #%s head %s vs base %s (Tests run %s)\n' "$PR" "$HEAD_SHA" "$BASE_SHA" "$RUN_ID"
[ "$DRY" = 1 ] && { echo "--dry-run: not merging"; exit 0; }
gh pr merge "$PR" --repo "$SLUG" --admin "$METHOD" --match-head-commit "$HEAD_SHA"
