'use strict';

/**
 * Drift guard for the shared mutating-command classifier.
 *
 * The classifier in src/owner-context.cts is DERIVED from the command-alias
 * registry (src/command-aliases.cts), the same table the family routers
 * consume. Two failure modes matter:
 *
 *  1. A registry row declares a writer but the classifier does not treat its
 *     canonical name OR any of its aliases as mutating — a new alias that
 *     silently bypasses the dispatch gate.
 *  2. A command is routed by gsd-tools but is neither classified nor explicitly
 *     accounted for — a new writer command that skips the gate entirely.
 *
 * The registry-parity loop makes (1) impossible without a failing test. The
 * routed-command accounting pins the current un-classified set: any NEW routed
 * command fails this test until it is either given a registry row (classified)
 * or explicitly listed as read-only / not-yet-reconciled.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const oc = require('../gsd-core/bin/lib/owner-context.cjs');
const registry = require('../gsd-core/bin/lib/command-aliases.cjs');

const FAMILY_TABLES = [
  'STATE_COMMAND_ALIASES',
  'VERIFY_COMMAND_ALIASES',
  'INIT_COMMAND_ALIASES',
  'PHASE_COMMAND_ALIASES',
  'PHASES_COMMAND_ALIASES',
  'VALIDATE_COMMAND_ALIASES',
  'ROADMAP_COMMAND_ALIASES',
  'QUICK_BATCH_COMMAND_ALIASES',
  'EVAL_COMMAND_ALIASES',
];

/** Every invocation form a registry row resolves to. */
function invocationForms(row) {
  const forms = [];
  const dotted = row.canonical.split('.');
  if (row.subcommand !== undefined) {
    forms.push([dotted[0], row.subcommand]);
  } else {
    // Non-family: canonical is either a bare top-level command (`config-set`)
    // or a dotted `parent.child` (`frontmatter.set`).
    forms.push(dotted);
  }
  for (const alias of row.aliases ?? []) forms.push(alias.split(' '));
  return forms;
}

function classify(tokens) {
  return oc.isMutatingCommand(tokens[0], tokens);
}

describe('owner-context classifier ↔ command-alias registry parity', () => {
  const rows = [];
  for (const table of FAMILY_TABLES) {
    for (const row of registry[table] ?? []) rows.push({ table, row });
  }
  for (const row of registry.NON_FAMILY_COMMAND_ALIASES ?? []) rows.push({ table: 'NON_FAMILY', row });

  test('every registry row classifies its canonical form and every alias identically', () => {
    for (const { table, row } of rows) {
      for (const form of invocationForms(row)) {
        assert.equal(
          classify(form),
          row.mutation === true,
          `${table}:${row.canonical} form "${form.join(' ')}" must classify ${row.mutation}`,
        );
      }
    }
  });

  test('the classifier is not constant: it has both writer and read-only forms', () => {
    assert.equal(oc.isMutatingCommand('config-set', ['config-set']), true);
    assert.equal(oc.isMutatingCommand('frontmatter', ['frontmatter', 'validate']), false);
    assert.equal(oc.isMutatingCommand('state', ['state', 'complete-phase']), true);
    assert.equal(oc.isMutatingCommand('phase', ['phase', 'mvp-mode']), false);
  });

  test('the derived exports reflect the registry (no stale second list)', () => {
    assert.ok(oc.MUTATING_SUBCOMMANDS.state.includes('complete-phase'),
      'state complete-phase must be classified from the registry row');
    assert.ok(!oc.MUTATING_SUBCOMMANDS.phase.includes('mvp-mode'),
      'phase mvp-mode is read-only');
    assert.ok(!oc.MUTATING_COMMANDS.includes('check-commit'),
      'check-commit is read-only and must not be classified as a writer');
    assert.ok(oc.MUTATING_COMMANDS.includes('migrate-config'));
    assert.ok(oc.MUTATING_COMMANDS.includes('scaffold'));
  });
});

/** The routed-command set, read from the CLI dispatch table's own export. */
function routedCommands() {
  // The dispatch table is exported by the CLI module, so read it via require
  // rather than grepping the source text (no-source-grep discipline).
  const tools = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs'));
  return Object.keys(tools.HOST_COMMAND_ROUTERS);
}

function registryKnownCommands() {
  const known = new Set();
  for (const table of FAMILY_TABLES) {
    for (const row of registry[table] ?? []) known.add(row.canonical.split('.')[0]);
  }
  for (const row of registry.NON_FAMILY_COMMAND_ALIASES ?? []) known.add(row.canonical.split('.')[0]);
  return known;
}

describe('owner-context routed-command accounting', () => {
  test('every routed command is present in the command-alias registry (zero unclassified)', () => {
    const known = registryKnownCommands();
    const unexpected = routedCommands().filter((c) => !known.has(c));
    assert.deepEqual(
      unexpected,
      [],
      `routed command(s) with no command-alias registry row: ${unexpected.join(', ')} — `
      + 'every routed command must be reconciled into src/command-aliases.cts',
    );
  });

  test('subcommand surfaces are classified, not just top-level names', () => {
    // Flag-supplied writers: registry-classified read-only would let the writer
    // run with no owner descriptor (review 2026-10-10: prompt-budget wrote both
    // output files; research-store put wrote .planning/research/.cache; a newly
    // added family subcommand must not silently fall through as read-only).
    assert.equal(oc.isMutatingCommand('prompt-budget', ['prompt-budget', '--budget', '1']), true,
      'prompt-budget writes its --output-prompt/--output-metadata files and must be mutating');
    assert.equal(oc.isMutatingCommand('research-store', ['research-store', 'put', 'a'.repeat(64)]), true,
      'research-store put writes the cache file and must be mutating');
    assert.equal(oc.isMutatingCommand('research-store', ['research-store', 'get', 'a'.repeat(64)]), false,
      'research-store get is read-only');
    assert.equal(oc.isMutatingCommand('restore-custom-files', ['restore-custom-files', '--config-dir', '/x', '--apply']), true,
      'restore-custom-files only mutates with --apply');
    assert.equal(oc.isMutatingCommand('restore-custom-files', ['restore-custom-files', '--config-dir', '/x']), false,
      'the restore preview is read-only');
    // Read-only opt-out flags (mutating by default, dry-run does not write).
    assert.equal(oc.isMutatingCommand('state', ['state', 'prune', '--dry-run']), false);
    assert.equal(oc.isMutatingCommand('state', ['state', 'prune']), true);
    assert.equal(oc.isMutatingCommand('state', ['state', 'sync', '--verify']), false);
    assert.equal(oc.isMutatingCommand('state', ['state', 'sync']), true);
  });

  test('no registry row is purely decorative: each classifies at least one form', () => {
    for (const table of FAMILY_TABLES) {
      for (const row of registry[table] ?? []) {
        const form = [row.canonical.split('.')[0], row.subcommand];
        assert.equal(oc.isMutatingCommand(form[0], form), row.mutation === true,
          `${table}:${row.canonical} does not classify its subcommand`);
      }
    }
    for (const row of registry.NON_FAMILY_COMMAND_ALIASES ?? []) {
      assert.equal(invocationForms(row).length > 0, true);
    }
  });
});
