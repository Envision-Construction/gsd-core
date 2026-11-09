#!/usr/bin/env bash
# Fork-only pre-merge gate for Envision-Construction/gsd-core (see .github/fork/README.md).
# Upstream has no .github/fork/ and npm does not ship .github/, so upstream syncs never conflict.
#
# Usage, from a gsd-core checkout whose `origin` is the fork:
#   bash .github/fork/pre-merge-gate.sh <pr> [--squash|--merge] [--full] [--no-regression-test] [--dry-run]
#
# Tests the PR head against its merge base in a clean environment, then admin-merges exactly
# that head (--match-head-commit), so a merge can never land untested or red.
#   --full                 also run the unit suite (use for upstream syncs and large PRs)
#   --no-regression-test   GSD_SKIP_REGRESSION_TEST_GATE=1 for lint:ci (prose-only fixes)
#   --dry-run              run every check, do not merge
set -euo pipefail

SLUG=Envision-Construction/gsd-core
PR=${1:?usage: pre-merge-gate.sh <pr> [--squash|--merge] [--full] [--no-regression-test] [--dry-run]}
shift
METHOD=--squash; FULL=0; DRY=0; SKIP_RT=
for a in "$@"; do
  case $a in
    --squash|--merge) METHOD=$a ;;
    --full) FULL=1 ;;
    --no-regression-test) SKIP_RT=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done
die() { printf '\nGATE FAILED (PR #%s): %s\n' "$PR" "$*" >&2; exit 1; }
REPO=$(git rev-parse --show-toplevel)

# 0. Disk: the operator floor is 70 GiB; npm ci and the test runs need headroom above it.
FREE=$(df -k "$REPO" | awk 'NR==2 {print int($4/1048576)}')
[ "$FREE" -ge "${MIN_FREE_GIB:-80}" ] || die "only $FREE GiB free (< ${MIN_FREE_GIB:-80})"

# 1. PR facts. Fetch by SHA so no shared ref in the common git dir moves.
read -r STATE BASE_REF HEAD_SHA < <(gh pr view "$PR" --repo "$SLUG" --json state,baseRefName,headRefOid --jq '[.state,.baseRefName,.headRefOid]|@tsv')
[ "$STATE" = OPEN ] || die "PR state is '$STATE'"
TIP=$(git -C "$REPO" ls-remote origin "refs/heads/$BASE_REF" | cut -f1)
git -C "$REPO" fetch --quiet --no-tags origin "$TIP" "refs/pull/$PR/head"
git -C "$REPO" cat-file -e "$HEAD_SHA^{commit}" || die "PR head $HEAD_SHA was not fetched (did it move?)"
BASE_SHA=$(git -C "$REPO" merge-base "$TIP" "$HEAD_SHA")
TIP_CI=$(gh run list --repo "$SLUG" --workflow test.yml --commit "$TIP" --limit 1 --json conclusion --jq '.[0].conclusion // "none"')
[ "$TIP_CI" = success ] || echo "WARNING: Tests on $BASE_REF tip ${TIP:0:9} is '$TIP_CI'; a failure below may predate this PR." >&2
echo "gate: PR #$PR head ${HEAD_SHA:0:9}, merge base ${BASE_SHA:0:9}, $FREE GiB free"

# 2. Scratch worktree at the PR head, a throwaway HOME, and a temporary base ref for the
#    diff-based lints (they read origin/<GITHUB_BASE_REF>). All removed on exit.
TMP=$(mktemp -d /private/tmp/gsd-gate-XXXXXX)
WT=$TMP/head; H=$TMP/home; GATE_REF=gate-base-$$
cleanup() {
  cd "$REPO"
  git worktree remove --force "$WT" 2>/dev/null || true
  git update-ref -d "refs/remotes/origin/$GATE_REF" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
mkdir -p "$H"
git -C "$REPO" update-ref "refs/remotes/origin/$GATE_REF" "$BASE_SHA"
git -C "$REPO" worktree add --quiet --detach "$WT" "$HEAD_SHA"
cd "$WT"
E=(env -i HOME="$H" PATH=/opt/homebrew/bin:/usr/bin:/bin npm_config_cache="$HOME/.npm")
run() {  # run LABEL CMD... : output to a log, tail it on failure
  local label=$1; shift
  "$@" > "$TMP/$label.log" 2>&1 || { tail -40 "$TMP/$label.log"; die "$label"; }
}

# 3. Install and build. A build that rewrites tracked files means generated output was not committed.
run npm-ci "${E[@]}" npm ci --no-audit --no-fund
run build "${E[@]}" npm run build
[ -z "$(git status --porcelain)" ] || { git status --short | head -20; die "npm run build changed tracked files: commit the regenerated output"; }

# 4. Lint exactly as CI's lint-tests job does for a PR, pinned to the merge base.
run lint-ci "${E[@]}" CI=true GITHUB_BASE_REF="$GATE_REF" GSD_REGRESSION_GATE_BASE="$BASE_SHA" GSD_SKIP_REGRESSION_TEST_GATE="$SKIP_RT" npm run lint:ci

# 5. Generators outside lint:ci. benchmark-compact-content ALWAYS exits 0 ("REPORT, not a gate"),
#    so its output is what decides; tests/benchmark-compact-content.test.cjs requires 'up to date'.
run research-agents "${E[@]}" node scripts/gen-research-agents.cjs --check
run parity-corpus "${E[@]}" node scripts/gen-prompt-budget-parity-corpus.cjs --check
OUT=$("${E[@]}" node scripts/benchmark-compact-content.cjs --check 2>&1) || die "benchmark-compact-content crashed"
case $OUT in
  *"is up to date with the live recompute"*) ;;
  *) printf '%s\n' "$OUT" | head -5; die "compact-content baseline drift: run node scripts/benchmark-compact-content.cjs --write and commit it" ;;
esac

# 6. Tests in CI's environment. run-affected-tests maps markdown only by filename stem, so also run
#    CI's own targeted list and every test that names a changed file (catches byte-cap tests).
T=(CI=true GSD_PLUGIN_ROOT=.ci-gsd-plugin-root-disabled GSD_STRICT_LIVE_CONFIG_GUARD=1 GSD_EMITTED_BASE="$BASE_SHA")
run affected "${E[@]}" "${T[@]}" GSD_AFFECTED_BASE="$BASE_SHA" node scripts/run-affected-tests.cjs
"${E[@]}" node scripts/ci-test-scope.cjs --base "$BASE_SHA" --head "$HEAD_SHA" > "$TMP/scope.json" || die "ci-test-scope"
node -e 'for (const t of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).targeted_tests || []) console.log(t)' "$TMP/scope.json" > "$TMP/extra.txt"
git diff --name-only --no-renames "$BASE_SHA...$HEAD_SHA" | while read -r f; do
  case $f in tests/*|.github/*) continue ;; esac
  case ${f##*/} in package.json|package-lock.json|README.md|CHANGELOG.md|index.cjs|index.js) continue ;; esac
  git grep -l -F -e "${f##*/}" -- 'tests/*.test.cjs' || true
done >> "$TMP/extra.txt"
git diff --name-only --no-renames --diff-filter=d "$BASE_SHA...$HEAD_SHA" -- 'tests/*.test.cjs' >> "$TMP/extra.txt"
sort -u -o "$TMP/extra.txt" "$TMP/extra.txt"
if [ -s "$TMP/extra.txt" ]; then
  echo "gate: $(wc -l < "$TMP/extra.txt" | tr -d ' ') targeted and reader test files"
  run targeted "${E[@]}" "${T[@]}" node scripts/run-tests.cjs --files-from "$TMP/extra.txt"
fi
[ "$FULL" = 1 ] && run unit-suite "${E[@]}" "${T[@]}" NODE_OPTIONS=--max-old-space-size=6144 node scripts/run-tests.cjs --suite unit

# 7. Merge only the exact head that passed.
printf '\nGATE PASSED: PR #%s head %s vs base %s\n' "$PR" "$HEAD_SHA" "$BASE_SHA"
[ "$DRY" = 1 ] && { echo "--dry-run: not merging"; exit 0; }
gh pr merge "$PR" --repo "$SLUG" --admin "$METHOD" --match-head-commit "$HEAD_SHA"
