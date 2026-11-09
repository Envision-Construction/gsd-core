'use strict';

/**
 * Fork (Envision-Construction/gsd-core) conformance-tier overrides, kept out of upstream
 * files so upstream syncs merge cleanly. Two consumers:
 *
 * - scripts/gen-platform-conformance-tier.cjs unions ALWAYS_REAL_OS_ENTRIES into its
 *   ALWAYS_REAL_OS map (Windows tier only), exactly like an upstream entry.
 * - tests/platform-conformance-tier.test.cjs keeps the fork custody tests in the generated
 *   tier but counts them outside upstream's #4641 ratio ceiling, so the ceiling keeps
 *   guarding upstream's own categories.
 */

const path = require('node:path');

const ALWAYS_REAL_OS_ENTRIES = [
  [
    'tests/forensic-gsd-parent-inventory.test.cjs',
    'Exercises real Git parent/worktree paths and registration via fs.realpathSync.native ' +
      '(src/worktree-safety.cts:1433-1455). The inventory test uses actual Git without platform/path ' +
      'injection (tests/forensic-gsd-parent-inventory.test.cjs:17-70); its full .git/index and ' +
      'ignored/untracked custody checks (:46-57,86-106) depend on ambient/native filesystem semantics.',
  ],
];

const TIER_RATIO_EXEMPT = new Set([
  'forensic-gsd-custody.test.cjs',
  'forensic-gsd-merge-failure.test.cjs',
  'forensic-gsd-parent-inventory.test.cjs',
  'gsd-workflow-retirement-contract.test.cjs',
]);

function countsTowardTierRatio(file) {
  return !TIER_RATIO_EXEMPT.has(path.basename(file));
}

module.exports = { ALWAYS_REAL_OS_ENTRIES, TIER_RATIO_EXEMPT, countsTowardTierRatio };
