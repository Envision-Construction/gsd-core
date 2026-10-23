/**
 * Root `.planning/` mentions in runtime prose that are correct on purpose (lifecycle group).
 * Entry: { file, match: /regex for the line/, why: "reason the root path is intended" }.
 */
module.exports = [
  {
    file: 'gsd-core/workflows/pr-branch.md',
    match: /^# and `\.planning\/STATE\.md\.bak` are NOT treated as structural/,
    why: 'pr-branch.md classifies paths with drift-guarded mirrors of src/pr-branch-patterns.cts that describe the root planning layout; nested scopes (workstreams already, named projects now) are not classified yet. Widening the patterns is a separate change to the pattern module, its drift guard and the cherry-pick recipe tests.',
  },
  {
    file: 'gsd-core/workflows/pr-branch.md',
    match: /^# alternative matches only FILES directly under `\.planning\/milestones\/`/,
    why: 'pr-branch.md classifies paths with drift-guarded mirrors of src/pr-branch-patterns.cts that describe the root planning layout; nested scopes (workstreams already, named projects now) are not classified yet. Widening the patterns is a separate change to the pattern module, its drift guard and the cherry-pick recipe tests.',
  },
  {
    file: 'gsd-core/workflows/pr-branch.md',
    match: /^STRUCTURAL_RE="\^\\\.planning\/\(STATE\|ROADMAP/,
    why: 'pr-branch.md classifies paths with drift-guarded mirrors of src/pr-branch-patterns.cts that describe the root planning layout; nested scopes (workstreams already, named projects now) are not classified yet. Widening the patterns is a separate change to the pattern module, its drift guard and the cherry-pick recipe tests.',
  },
  {
    file: 'gsd-core/workflows/pr-branch.md',
    match: /^# passed at least one milestone: `\.planning\/milestones\/<milestone>-phases\/`/,
    why: 'pr-branch.md classifies paths with drift-guarded mirrors of src/pr-branch-patterns.cts that describe the root planning layout; nested scopes (workstreams already, named projects now) are not classified yet. Widening the patterns is a separate change to the pattern module, its drift guard and the cherry-pick recipe tests.',
  },
  {
    file: 'gsd-core/workflows/pr-branch.md',
    match: /^MILESTONE_PHASES_RE="\^\\\.planning\/milestones\//,
    why: 'pr-branch.md classifies paths with drift-guarded mirrors of src/pr-branch-patterns.cts that describe the root planning layout; nested scopes (workstreams already, named projects now) are not classified yet. Widening the patterns is a separate change to the pattern module, its drift guard and the cherry-pick recipe tests.',
  },
  {
    file: 'gsd-core/workflows/pr-branch.md',
    match: /^\s*# milestones yet \(`\.planning\/milestones\/` absent\)/,
    why: 'pr-branch.md classifies paths with drift-guarded mirrors of src/pr-branch-patterns.cts that describe the root planning layout; nested scopes (workstreams already, named projects now) are not classified yet. Widening the patterns is a separate change to the pattern module, its drift guard and the cherry-pick recipe tests.',
  },
  {
    file: 'gsd-core/workflows/pr-branch.md',
    match: /^\s*# `\.planning\/milestones\/`\), not just the expected-absent case/,
    why: 'pr-branch.md classifies paths with drift-guarded mirrors of src/pr-branch-patterns.cts that describe the root planning layout; nested scopes (workstreams already, named projects now) are not classified yet. Widening the patterns is a separate change to the pattern module, its drift guard and the cherry-pick recipe tests.',
  },
  {
    file: 'gsd-core/workflows/pr-branch.md',
    match: /^\s*MILESTONE_PHASE_DIRS=\$\(find \.planning\/milestones -mindepth 1/,
    why: 'pr-branch.md classifies paths with drift-guarded mirrors of src/pr-branch-patterns.cts that describe the root planning layout; nested scopes (workstreams already, named projects now) are not classified yet. Widening the patterns is a separate change to the pattern module, its drift guard and the cherry-pick recipe tests.',
  },
  {
    file: 'gsd-core/workflows/health.md',
    match: /^\| backfillMilestones \| Synthesize missing MILESTONES\.md entries from `\.planning\/milestones\/vX\.Y-ROADMAP\.md` snapshots \|/,
    why: 'Row of the repair-actions table that scripts/gen-health-docs.cjs generates (its --check pins the text); it describes the repair, which resolves the project-scoped milestones dir itself (src/health-diagnostic.cts repairPaths). Rewording belongs in the generator.',
  },
];
