# Envision-Construction/gsd-core fork

This fork is `open-gsd/gsd-core` plus a small set of fork changes, and it is what the local GSD runtime is installed from. Everything under `.github/fork/` is fork-only. Upstream has no such directory, so syncs never conflict here.

## Merging into `next`

Merge every fork PR through the gate, from a checkout whose `origin` is this fork:

```bash
bash .github/fork/pre-merge-gate.sh <pr> --dry-run          # first look
bash .github/fork/pre-merge-gate.sh <pr>                    # gate, then gh pr merge --admin --squash
bash .github/fork/pre-merge-gate.sh <pr> --merge --full     # upstream syncs: keep merge commits, run the unit suite
```

The gate runs the following, then merges exactly the tested head (`--match-head-commit`):

- `npm ci` and the build, failing if the build rewrites tracked files.
- `lint:ci` pinned to the PR's merge base.
- The generated-artifact checks, judged by their output. `benchmark-compact-content.cjs --check` always exits 0, even on drift.
- The affected tests, CI's targeted list, and every test that names a changed file. `run-affected-tests` maps markdown only by filename, so it misses the byte-cap tests.

CI still runs on every PR, but the gate is the merge decision.

## Workflows disabled on the fork

Upstream's community automation and contributor gates assume upstream maintainers and labels. On this fork they closed PRs #9, #11 and #13 within seconds of opening, dismissed approvals every 15 minutes, and always failed fork-internal PRs. They are disabled with `gh workflow disable`, not by editing their files, so syncs stay conflict-free.

Still active: `test.yml`, `install-smoke.yml`, `security-scan.yml`, `pr-mergeable-preflight.yml`, CodeQL and Copilot.

Disabled: `dismiss-unauthorized-pr-approvals`, `close-draft-prs-sweep`, `ci-timeout-report`, `duplicate-sweep`, `stale`, `branch-cleanup`, `auto-close-unsolicited-prs`, `close-draft-prs`, `version-gate`, `duplicate-check`, `remove-duplicate-label`, `auto-label-issues`, `auto-branch`, `auto-backmerge`, `dependabot-auto-merge`, `dependabot-vendor-refresh`, `release`, `require-issue-link`, `pr-template-format`, `pr-title-validator`, `changeset-required`, `reviewed-or-maintainer`, `self-test-report`, `branch-naming`, `pr-target-validator`, `default-flip-documentation`, `docs-required`, `mutation` (all `.yml`).

To re-enable one: `gh workflow enable <file> -R Envision-Construction/gsd-core`.

After each sync, check for workflows upstream added, which arrive enabled:

```bash
gh workflow list -R Envision-Construction/gsd-core --all --json path,state --jq '.[]|select(.state=="active")|.path'
```

## Fork changes to upstream files

| Where | What | Conflict seam |
|---|---|---|
| `gsd-core/workflows/execute-phase.md` steps 5 and 5.5 | Custody: never stash, retain worktrees, hold on unknown inventory (fork #6) | Inline. The file sits a few bytes under upstream's 93600-byte cap. Move this into `execute-phase/steps/<fork step>.md` at the next sync; see below. |
| `scripts/gen-platform-conformance-tier.cjs` and `tests/platform-conformance-tier.test.cjs` | Real-OS custody tests | One `// fork` line each. The data lives in `scripts/lib/fork-conformance-overrides.cjs`. |
| Copies of open-gsd #5914, #5915 and #5916 | Scoped-path fixes ahead of upstream | When upstream merges each one, take upstream's version of its files. |

## Next upstream sync

1. Fetch, then preview conflicts: `git fetch upstream next && git merge-tree --write-tree --name-only origin/next upstream/next`.
2. Branch from `origin/next` and run `git merge upstream/next`.
3. Generated files (tier lists, benchmark baselines, `pi/package-agents`, manifests): take either side, then regenerate. Run `npm run build`, `node scripts/benchmark-compact-content.cjs --write` and `node scripts/gen-platform-conformance-tier.cjs --write`, the latter also with `--target macos`. Check that each prints "up to date" or "list matches".
4. While `execute-phase.md` is in conflict anyway, move steps 5 and 5.5 into a fork step file and leave one pointer line, so the cap has room.
5. Push the branch, open a PR, and run the gate with `--merge --full`.
6. Disable any newly added upstream workflows (see above). Reinstall the runtime from `next`.
