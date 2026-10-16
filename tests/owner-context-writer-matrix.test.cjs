'use strict';

/**
 * Writer-boundary acceptance matrix for the portfolio ownership contract.
 *
 * The earlier owner-context suites proved the DISPATCH gate and a handful of
 * direct writers. This suite covers the full set of effective writer families
 * the shared classifier now routes, against the boundary a user actually hits.
 *
 * Each family is driven under four contexts:
 *   1. missing descriptor     -> refused, no write
 *   2. wrong owner            -> refused, no write
 *   3. mismatched scope       -> refused, no write
 *   4. valid fresh descriptor -> the write happens
 * plus read-only variants that must NOT be gated, and direct-export coverage
 * for the primitives the CLI wraps.
 *
 * A refusal is only real if nothing was written, so every refusal case
 * snapshots the fixture tree and asserts byte equality afterwards. Every run is
 * sandboxed (HOME under the fixture) so no family touches the developer's real
 * global store.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const oc = require('../gsd-core/bin/lib/owner-context.cjs');

const E = oc.OWNER_DESCRIPTOR_ENV;

function git(tmp, ...args) {
  execFileSync('git', args, { cwd: tmp, stdio: 'ignore', timeout: GIT_TIMEOUT_MS });
}

function makeFixture(prefix, setup) {
  const tmp = createTempGitProject(prefix);
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  setup(tmp);
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '--allow-empty', '-q', '-m', 'fixture');
  const real = fs.realpathSync.native(tmp);
  const ctx = oc.buildOwnerContext(real);
  fs.writeFileSync(
    path.join(tmp, '.planning', 'owner-policy.json'),
    JSON.stringify({ policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: ctx.owner.repo_id }] }, null, 2),
  );
  return { tmp, real, ctx };
}

function sandbox(tmp) {
  const home = path.join(tmp, '.home');
  fs.mkdirSync(home, { recursive: true });
  const cleared = {};
  for (const key of Object.values(E)) cleared[key] = undefined;
  return { ...cleared, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
}

function descEnv(ctx, scopes, overrides = {}) {
  const base = {
    [E.TASK_ID]: 'matrix-1',
    [E.REPO_ID]: ctx.owner.repo_id,
    [E.ROOT]: ctx.owner.root,
    [E.WORKFLOW]: 'operational',
    [E.RATIONALE]: 'writer matrix',
    [E.WRITABLE_SCOPES]: scopes.join(','),
    [E.PROVENANCE]: 'test',
    [E.EXPECT_HEAD]: ctx.owner.head,
    [E.EXPECT_FINGERPRINT]: ctx.fingerprint.planning,
    [E.EXPECT_SCOPE_FINGERPRINT]: oc.scopeFingerprint(ctx.owner.root, scopes).fingerprint,
  };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) delete base[key];
    else base[key] = overrides[key];
  }
  return base;
}

function snapshot(root) {
  const out = {};
  (function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (rel === '' && entry.name === '.git') continue;
      if (rel === '' && entry.name === '.home') continue;
      const abs = path.join(dir, entry.name);
      const next = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(abs, next);
      else out[next.replace(/\\/g, '/')] = fs.readFileSync(abs, 'utf8');
    }
  })(root, '');
  return out;
}

function reasonOf(result) {
  try {
    return JSON.parse((result.error || '').trim()).reason;
  } catch {
    return null;
  }
}

function assertRefused(result) {
  assert.notEqual(result.exitCode, 0, 'a refused write must exit non-zero');
  assert.equal(reasonOf(result), 'owner_context_refused', `expected owner_context_refused, got: ${result.error}`);
}

const TRAIL = ['--json-errors'];

/**
 * Drive one CLI writer family through the four contexts.
 *   args(real, ctx) -> argv (without the trailing --json-errors)
 *   scopes          -> descriptor scope that authorizes the write
 *   expectWrite(real) -> assertion the valid run must satisfy
 */
function matrixCli({ prefix, setup, describe: label, args, scopes, expectWrite, mismatchScope = ['src'], refusalOnly = false }) {
  describe(label, () => {
    test(`${label}: missing descriptor -> refused, no write`, () => {
      const { tmp, real, ctx } = makeFixture(prefix, setup);
      try {
        const before = snapshot(tmp);
        assertRefused(runGsdTools([...args(real, ctx), ...TRAIL], real, sandbox(tmp)));
        assert.deepEqual(snapshot(tmp), before, 'a refused write must not mutate the tree');
      } finally { cleanup(tmp); }
    });

    test(`${label}: wrong owner -> refused, no write`, () => {
      const { tmp, real, ctx } = makeFixture(prefix, setup);
      try {
        const before = snapshot(tmp);
        const env = { ...sandbox(tmp), ...descEnv(ctx, scopes, { [E.REPO_ID]: 'github.com/example/other', [E.ROOT]: path.join(tmp, 'nowhere') }) };
        assertRefused(runGsdTools([...args(real, ctx), ...TRAIL], real, env));
        assert.deepEqual(snapshot(tmp), before);
      } finally { cleanup(tmp); }
    });

    test(`${label}: mismatched scope -> refused, no write`, () => {
      const { tmp, real, ctx } = makeFixture(prefix, setup);
      try {
        const before = snapshot(tmp);
        assertRefused(runGsdTools([...args(real, ctx), ...TRAIL], real, { ...sandbox(tmp), ...descEnv(ctx, mismatchScope) }));
        assert.deepEqual(snapshot(tmp), before);
      } finally { cleanup(tmp); }
    });

    test(`${label}: valid fresh descriptor -> the write happens`, { skip: refusalOnly ? 'writer has no in-repo expressible target' : false }, () => {
      const { tmp, real, ctx } = makeFixture(prefix, setup);
      try {
        const r = runGsdTools([...args(real, ctx), ...TRAIL], real, { ...sandbox(tmp), ...descEnv(ctx, scopes) });
        assert.equal(r.exitCode, 0, `expected success, got: ${r.error || r.output}`);
        expectWrite(real);
      } finally { cleanup(tmp); }
    });
  });
}

// ─── CLI writer families ─────────────────────────────────────────────────────

matrixCli({
  describe: 'quick-batch create',
  prefix: 'oc-mx-qb-',
  setup: (tmp) => fs.writeFileSync(path.join(tmp, '.planning', 'tasks.md'), '- one\n- two\n'),
  args: (real) => ['quick-batch', 'create', '--file', path.join(real, '.planning', 'tasks.md'), '--raw'],
  scopes: ['.planning'],
  expectWrite: (real) => assert.equal(fs.existsSync(path.join(real, '.planning', 'quick-batches')), true),
});

matrixCli({
  describe: 'state update',
  prefix: 'oc-mx-su-',
  setup: (tmp) => fs.writeFileSync(path.join(tmp, '.planning', 'STATE.md'), '---\nstatus: active\n---\n# State\n\nStatus: active\n'),
  args: () => ['state', 'update', 'Status', 'changed', '--raw'],
  scopes: ['.planning'],
  expectWrite: (real) => assert.match(fs.readFileSync(path.join(real, '.planning', 'STATE.md'), 'utf8'), /changed/),
});

matrixCli({
  describe: 'config-set',
  prefix: 'oc-mx-cfg-',
  setup: () => {},
  args: () => ['config-set', 'workflow.mvp_mode', 'true', '--raw'],
  scopes: ['.planning'],
  expectWrite: (real) => assert.equal(fs.existsSync(path.join(real, '.planning', 'config.json')), true),
});

matrixCli({
  describe: 'quick-batch update',
  prefix: 'oc-mx-qbu-',
  setup: (tmp) => {
    const dir = path.join(tmp, '.planning', 'quick-batches', 'b1');
    fs.mkdirSync(dir, { recursive: true });
    const item = (id) => ({
      quick_id: id, client_id: null, description: 'task ' + id, status: 'pending',
      depends_on: [], planned_files: [], directory: null, worktree: null,
      dispatched_worktree: null, dispatched_branch: null, dispatched_base: null,
      wave: 0, commit: null, failure_reason: null,
    });
    fs.writeFileSync(path.join(dir, 'BATCH.json'), JSON.stringify({
      schema_version: 1, batch_id: 'b1', created_at: '2026-01-01T00:00:00.000Z',
      options: {}, base_revision: null, items: [item('261010-aaa'), item('261010-aab')],
    }, null, 2));
  },
  args: () => ['quick-batch', 'update', '--batch', 'b1', '--updates', JSON.stringify([{ quickId: '261010-aaa', plannedFiles: ['src/a.ts'] }]), '--raw'],
  scopes: ['.planning'],
  expectWrite: (real) => assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(real, '.planning', 'quick-batches', 'b1', 'BATCH.json'), 'utf8')).items[0].planned_files,
    ['src/a.ts'],
  ),
});

matrixCli({
  describe: 'frontmatter set (in-repo target)',
  prefix: 'oc-mx-fm-',
  setup: (tmp) => fs.writeFileSync(path.join(tmp, 'src', 'note.md'), '---\nstatus: old\n---\n# Note\n'),
  args: (real) => ['frontmatter', 'set', path.join(real, 'src', 'note.md'), '--field', 'status', '--value', 'changed', '--raw'],
  scopes: ['src'],
  mismatchScope: ['.planning'],
  expectWrite: (real) => assert.match(fs.readFileSync(path.join(real, 'src', 'note.md'), 'utf8'), /status: changed/),
});

matrixCli({
  describe: 'phase remove --force',
  prefix: 'oc-mx-pr-',
  setup: (tmp) => {
    const dir = path.join(tmp, '.planning', 'phases', '01-foo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '# Plan 1\n');
    fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n- [ ] **Phase 1: Foo**\n\n### Phase 1: Foo\n\n**Goal:** Do it\n');
  },
  args: () => ['phase', 'remove', '1', '--force', '--raw'],
  scopes: ['.planning'],
  expectWrite: (real) => assert.equal(fs.existsSync(path.join(real, '.planning', 'phases', '01-foo')), false),
});

matrixCli({
  describe: 'phase add',
  prefix: 'oc-mx-pa-',
  setup: (tmp) => fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phases\n'),
  args: () => ['phase', 'add', 'Brand new phase', '--raw'],
  scopes: ['.planning'],
  expectWrite: (real) => assert.match(fs.readFileSync(path.join(real, '.planning', 'ROADMAP.md'), 'utf8'), /Brand new phase/),
});

matrixCli({
  describe: 'template fill',
  prefix: 'oc-mx-tf-',
  setup: (tmp) => {
    const dir = path.join(tmp, '.planning', 'phases', '01-foo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '# Plan 1\n');
    fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n- [ ] **Phase 1: Foo**\n\n### Phase 1: Foo\n');
  },
  args: () => ['template', 'fill', 'summary', '--phase', '1', '--raw'],
  scopes: ['.planning'],
  expectWrite: (real) => assert.equal(fs.existsSync(path.join(real, '.planning', 'phases', '01-foo', '01-01-SUMMARY.md')), true),
});

matrixCli({
  describe: 'todo complete',
  prefix: 'oc-mx-td-',
  setup: (tmp) => {
    fs.mkdirSync(path.join(tmp, '.planning', 'todos', 'pending'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.planning', 'todos', 'pending', 'item.md'), '---\nstatus: pending\n---\n# Item\n');
  },
  args: () => ['todo', 'complete', 'item.md', '--raw'],
  scopes: ['.planning'],
  expectWrite: (real) => assert.equal(fs.existsSync(path.join(real, '.planning', 'todos', 'completed', 'item.md')), true),
});

matrixCli({
  describe: 'generate-claude-md',
  prefix: 'oc-mx-gm-',
  setup: (tmp) => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', '.keep'), '\n');
  },
  args: () => ['generate-claude-md', '--raw'],
  scopes: ['.claude'],
  expectWrite: (real) => assert.equal(fs.existsSync(path.join(real, '.claude', 'CLAUDE.md')), true),
});

matrixCli({
  describe: 'commit-docs-guard enable',
  prefix: 'oc-mx-cdg-',
  setup: () => {},
  args: () => ['commit-docs-guard', 'enable', '--raw'],
  scopes: ['.git/hooks'],
  expectWrite: (real) => assert.equal(fs.existsSync(path.join(real, '.git', 'hooks', 'pre-commit')), true),
});

// ─── Newly reconciled routed writers ─────────────────────────────────────────

matrixCli({
  describe: 'dispatch-isolation (sentinel write)',
  prefix: 'oc-mx-di-',
  setup: () => {},
  args: () => ['dispatch-isolation'],
  scopes: ['.gsd'],
  expectWrite: (real) => assert.equal(fs.existsSync(path.join(real, '.gsd', 'dispatch-isolation-sentinel.json')), true),
});

matrixCli({
  describe: 'record-dispatch-isolation (sentinel write)',
  prefix: 'oc-mx-rdi-',
  setup: () => {},
  args: () => ['record-dispatch-isolation', '--isolation', 'none'],
  scopes: ['.gsd'],
  expectWrite: (real) => assert.equal(fs.existsSync(path.join(real, '.gsd', 'dispatch-isolation-sentinel.json')), true),
});

matrixCli({
  describe: 'stamp-codebase-map',
  prefix: 'oc-mx-scm-',
  setup: (tmp) => {
    const dir = path.join(tmp, '.planning', 'codebase');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['STACK.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md', 'TESTING.md', 'INTEGRATIONS.md', 'CONCERNS.md']) {
      fs.writeFileSync(path.join(dir, f), '# ' + f + '\n');
    }
  },
  args: () => ['stamp-codebase-map', '--raw'],
  scopes: ['.planning'],
  expectWrite: (real) => assert.match(fs.readFileSync(path.join(real, '.planning', 'codebase', 'STACK.md'), 'utf8'), /stamped_at|sha|commit/i),
});

matrixCli({
  describe: 'estimate-calibrate',
  prefix: 'oc-mx-ec-',
  setup: (tmp) => {
    const dir = path.join(tmp, '.planning', 'phases', '01-foo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n- [ ] **Phase 1: Foo**\n\n### Phase 1: Foo\n');
    fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '# Plan 1\n');
    fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), '# Summary 1\n');
  },
  args: () => ['estimate-calibrate', '--raw'],
  scopes: ['.planning'],
  expectWrite: (real) => assert.equal(fs.existsSync(path.join(real, '.planning', 'estimation-calibration.json')), true),
});

matrixCli({
  describe: 'verification append-audit',
  prefix: 'oc-mx-va-',
  setup: (tmp) => {
    const dir = path.join(tmp, '.planning', 'phases', '01-foo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-SECURITY.md'), '# Security\n');
  },
  args: (real) => ['verification', 'append-audit', path.join(real, '.planning', 'phases', '01-foo', '01-SECURITY.md'), '--heading', 'Audit', '--rows', '{}', '--raw'],
  scopes: ['.planning'],
  expectWrite: (real) => assert.match(fs.readFileSync(path.join(real, '.planning', 'phases', '01-foo', '01-SECURITY.md'), 'utf8'), /Audit/),
});

matrixCli({
  describe: 'windows append (broken-windows ledger)',
  prefix: 'oc-mx-wa-',
  setup: (tmp) => fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), '# Roadmap\n'),
  args: () => ['windows', 'append', '--kind', 'stub', '--phase', '1', '--description', 'x', '--raw'],
  scopes: ['.planning'],
  expectWrite: (real) => assert.match(fs.readFileSync(path.join(real, '.planning', 'WINDOWS.md'), 'utf8'), /x/),
});

// Writers whose only targets are OUTSIDE the worktree (or unbound): under
// enforce every context must refuse; the valid case is intentionally skipped.
matrixCli({
  describe: 'capability install (global install root)',
  prefix: 'oc-mx-capi-',
  setup: () => {},
  args: () => ['capability', 'install', 'somepkg', '--yes'],
  scopes: ['.planning'],
  refusalOnly: true,
  expectWrite: () => {},
});

matrixCli({
  describe: 'effort sync --apply (global agents dir)',
  prefix: 'oc-mx-esa-',
  // The claude apply path resolves the GLOBAL agents dir; seed it under the
  // sandboxed HOME so the guard (not the "dir not found" early return) is what
  // the refusal cases exercise.
  setup: (tmp) => {
    const dir = path.join(tmp, '.home', '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gsd-executor.md'), '---\neffort: high\n---\n# Executor\n');
  },
  args: () => ['effort', 'sync', '--apply', '--raw'],
  scopes: ['.planning'],
  refusalOnly: true,
  expectWrite: () => {},
});

matrixCli({
  describe: 'review-lane dispatch-step (unbound spawn target)',
  prefix: 'oc-mx-rl-',
  setup: () => {},
  args: () => ['review-lane', 'dispatch-step'],
  scopes: ['.planning'],
  refusalOnly: true,
  expectWrite: () => {},
});

// ─── Read-only variants must NOT be gated ────────────────────────────────────

// ─── Pending root findings: explicit-missing policy + symlinked scope ────────

describe('owner-context pending root findings stay fail-closed', () => {
  test('an explicitly requested but MISSING policy refuses a writer (fail closed)', () => {
    const { tmp, real, ctx } = makeFixture('oc-fc-missing-', () => {});
    try {
      // Remove the default policy the fixture wrote, and point GSD_OWNER_POLICY
      // at a path that does not exist: an explicit request that cannot be read
      // must REFUSE, never decay to audit.
      fs.unlinkSync(path.join(tmp, '.planning', 'owner-policy.json'));
      const missing = path.join(tmp, '.planning', 'does-not-exist-policy.json');
      const before = snapshot(tmp);
      const r = runGsdTools(['config-set', 'workflow.mvp_mode', 'true', '--raw', ...TRAIL], real, {
        ...sandbox(tmp), ...descEnv(ctx, ['.planning']), GSD_OWNER_POLICY: missing,
      });
      assert.notEqual(r.exitCode, 0, 'an explicit missing policy must refuse');
      assert.deepEqual(snapshot(tmp), before, 'a refused write must not mutate');
    } finally { cleanup(tmp); }
  });

  test('a symlinked writable scope that escapes the worktree is refused', () => {
    const { tmp, real } = makeFixture('oc-fc-symlink-', (d) => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fc-outside-'));
      fs.symlinkSync(outside, path.join(d, 'link'));
    });
    try {
      // The scope-fingerprint layer must REFUSE a symlinked scope root (rather
      // than silently following it out of the worktree), so a descriptor that
      // names such a scope can never be built into a passing gate.
      const fp = oc.scopeFingerprint(real, ['link']);
      assert.equal(fp.ok, false, 'a symlinked scope root must not produce a usable fingerprint');
      assert.match(fp.reasons.join(' '), /link/);
    } finally { cleanup(tmp); }
  });
});

describe('read-only variants stay ungated under enforce', () => {
  const cases = [
    ['state get (family read)', ['state', 'get', 'status']],
    ['phases list', ['phases', 'list']],
    ['phase list-plans', ['phase', 'list-plans', '--phase', '1']],
    ['phase mvp-mode', ['phase', 'mvp-mode', '1']],
    ['config-get', ['config-get', 'workflow.mvp_mode']],
    ['frontmatter validate', ['frontmatter', 'validate', '.planning/PROJECT.md', '--schema', 'summary']],
    ['template select', ['template', 'select', '.planning/PROJECT.md']],
    ['check-commit', ['check-commit']],
    ['quick-batch parse-args', ['quick-batch', 'parse-args', '--text', 'do a thing']],
    ['workstream progress', ['workstream', 'progress']],
    ['skill-manifest without --write', ['skill-manifest']],
    ['effort sync dry run', ['effort', 'sync', '--raw']],
    ['capability list', ['capability', 'list']],
    ['windows status', ['windows', 'status']],
    ['git base-branch', ['git', 'base-branch']],
    ['drift-guard authority', ['drift-guard', 'authority']],
    ['dispatch-capacity', ['dispatch-capacity']],
    ['inspect-dispatch-isolation', ['inspect-dispatch-isolation']],
  ];
  for (const [label, argv] of cases) {
    test(`${label} is not refused as a mutation (no descriptor)`, () => {
      const { tmp, real } = makeFixture('oc-mx-ro-', () => {});
      try {
        const r = runGsdTools([...argv, ...TRAIL], real, sandbox(tmp));
        assert.notEqual(reasonOf(r), 'owner_context_refused', `${label} must not hit the ownership gate: ${r.error}`);
      } finally { cleanup(tmp); }
    });
  }
});

// ─── Every state writer entrypoint (registry STATE mutation rows) ────────────

describe('state writer entrypoints are all gated (CLI)', () => {
  let wroteCount = 0;
  // One invocation per registry state mutation row. The dispatch gate runs
  // BEFORE the handler's own arg parsing, so the mismatch case is arg-agnostic.
  // The valid case now asserts a REAL write for every row, so each fixture is a
  // meaningful valid command rather than a tolerated usage/no-op error.
  const STATE_WRITERS = [
    ['update', ['state', 'update', 'Status', 'executing']],
    ['patch', ['state', 'patch', '{"Status":"planning"}']],
    ['begin-phase', ['state', 'begin-phase', '--phase', '1', '--name', 'Foo']],
    ['complete-phase', ['state', 'complete-phase', '--phase', '1']],
    ['signal-waiting', ['state', 'signal-waiting', '--type', 'question', '--question', 'Q?', '--options', 'a,b']],
    ['signal-resume', ['state', 'signal-resume']],
    ['resolve-blocker', ['state', 'resolve-blocker', '--text', 'some blocker']],
    ['add-decision', ['state', 'add-decision', '--phase', '1', '--summary', 's']],
    ['add-blocker', ['state', 'add-blocker', '--text', 'blocked']],
    ['advance-plan', ['state', 'advance-plan']],
    ['record-metric', ['state', 'record-metric', '--phase', '1', '--plan', '01-01', '--duration', '5m', '--tasks', '1', '--files', '2']],
    ['update-progress', ['state', 'update-progress']],
    ['record-session', ['state', 'record-session', '--stopped-at', 'did a thing']],
    ['planned-phase', ['state', 'planned-phase', '--phase', '1', '--name', 'Foo']],
    ['sync', ['state', 'sync']],
    ['prune', ['state', 'prune', '--keep-recent', '1']],
    ['rebuild', ['state', 'rebuild']],
    ['milestone-switch', ['state', 'milestone-switch', '--milestone', 'v1', '--name', 'M1']],
    ['add-roadmap-evolution', ['state', 'add-roadmap-evolution', '--phase', '1', '--action', 'insert', '--note', 'n']],
  ];

  // A RICHER seed so every one of the 19 verbs has a MEANINGFUL valid-command
  // fixture that actually writes (review 2026-10-10: the previous seed left
  // `patch`, `resolve-blocker`, `update-progress`, `sync`, `prune` and `rebuild`
  // as tolerated usage/no-op errors that wrote nothing). A versioned ROADMAP
  // bounds the milestone so `update-progress`/`sync` compute a real percent; a
  // populated Blockers/Recently-Completed/Decisions body gives `resolve-blocker`
  // and `prune` real work; `current_phase: 3` puts the prune cutoff above the
  // aged entries.
  const STATE_MD = [
    '---',
    'status: executing',
    'milestone: v1.0',
    'current_phase: 3',
    '---',
    '# State',
    '',
    '## Current Position',
    '',
    'Phase: 3 of 3 (Three)',
    'Plan: 2 of 3',
    'Status: Executing Phase 3',
    '',
    // Deliberately STALE vs the versioned ROADMAP above (1 of 3 phases complete)
    // so `state sync` has a real percent to reconcile and therefore writes.
    '**Progress:** [░░░░░░░░░░] 0%',
    '',
    '## Blockers',
    '',
    '- [ ] some blocker text',
    '',
    '## Recently Completed',
    '',
    '- Phase 1: one (01-01)',
    '',
    '## Decisions',
    '',
    '- D1: chose a thing',
    '',
  ].join('\n');
  const ROADMAP_MD = [
    '# Roadmap',
    '',
    '## v1.0: Release',
    '',
    '- [x] **Phase 1: One**',
    '- [x] **Phase 2: Two**',
    '- [ ] **Phase 3: Three**',
    '',
    '### Phase 1: One',
    '**Goal:** a',
    '',
    '### Phase 2: Two',
    '**Goal:** b',
    '',
    '### Phase 3: Three',
    '**Goal:** c',
    '',
  ].join('\n');
  const seedState = (tmp) => {
    fs.writeFileSync(path.join(tmp, '.planning', 'STATE.md'), STATE_MD);
    fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), ROADMAP_MD);
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({ phase_id_convention: 'integer' }));
    fs.writeFileSync(path.join(tmp, '.planning', 'WAITING.json'), JSON.stringify({ status: 'waiting' }) + '\n');
    for (const [num, name] of [['01', 'one'], ['02', 'two'], ['03', 'three']]) {
      const dir = path.join(tmp, '.planning', 'phases', `${num}-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${num}-01-PLAN.md`), '# Plan\n');
    }
    const p1 = path.join(tmp, '.planning', 'phases', '01-one');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1\n');
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');
  };
  // `state rebuild` reconciles a DRIFTED doc, so it needs its own seed (the
  // shared seed is already consistent). Body Current Phase disagrees with the
  // frontmatter, and an orphan By-Phase row is dropped.
  const REBUILD_STATE_MD = [
    '---',
    'gsd_state_version: \'1.0\'',
    'status: executing',
    'milestone: 1.0.0',
    'milestone_name: Test',
    'current_phase: 2',
    'current_phase_name: Phase Two',
    'current_plan: 1',
    'progress:',
    '  total_phases: 2',
    '  completed_phases: 1',
    '  total_plans: 2',
    '  completed_plans: 1',
    '  percent: 50',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    '**Current Phase:** 1',
    '**Current Phase Name:** Phase One',
    '**Current Plan:** 1',
    '**Status:** executing',
    '',
    'Phase: 2 of 2 (Phase Two)',
    'Plan: 1 of 1',
    'Status: Executing Phase 2',
    '',
    '**Progress:** [█████░░░░░] 50%',
    '',
    '## By Phase',
    '',
    '| Phase | Plans | Total | Avg/Plan |',
    '|-------|-------|-------|----------|',
    '| 99 | 1 | 1 | 1m |',
    '',
  ].join('\n');
  const seedRebuildState = (tmp) => {
    seedState(tmp);
    fs.writeFileSync(path.join(tmp, '.planning', 'STATE.md'), REBUILD_STATE_MD);
  };
  // `state complete-phase` completes the CLAIMED current phase; the rich seed
  // marks Phase 1 already complete in the versioned ROADMAP, so give it a
  // minimal fresh phase-1 project where the completion actually changes bytes.
  const seedCompletePhase = (tmp) => {
    fs.writeFileSync(path.join(tmp, '.planning', 'STATE.md'),
      '---\nstatus: active\n---\n# State\n\n## Current Position\n\nPhase: 1\nPlan: 01-01\nStatus: executing\n');
    fs.writeFileSync(path.join(tmp, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n- [ ] **Phase 1: Foo**\n');
    const dir = path.join(tmp, '.planning', 'phases', '01-foo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '# Plan 1\n');
    fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), '# Summary 1\n');
    fs.writeFileSync(path.join(dir, '01-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');
  };
  const seedFor = (sub) => (sub === 'rebuild' ? seedRebuildState : sub === 'complete-phase' ? seedCompletePhase : seedState);

  // Proof the registry still lists exactly these writers (no silent drop).
  test('the registry still declares all 19 state mutation rows', () => {
    const reg = require('../gsd-core/bin/lib/command-aliases.cjs');
    const subs = reg.STATE_COMMAND_ALIASES.filter((r) => r.mutation).map((r) => r.subcommand).sort();
    assert.deepEqual(subs, STATE_WRITERS.map(([s]) => s).sort());
  });

  for (const [sub, argv] of STATE_WRITERS) {
    test(`state ${sub}: never partially writes; refuses whenever a write would occur`, () => {
      const valid = makeFixture(`oc-sw-${sub}-ok-`, seedFor(sub));
      const mismatch = makeFixture(`oc-sw-${sub}-mm-`, seedFor(sub));
      try {
        // A valid descriptor establishes whether this invocation actually writes.
        const validBefore = snapshot(valid.tmp);
        const validRun = runGsdTools([...argv, ...TRAIL], valid.real, { ...sandbox(valid.tmp), ...descEnv(valid.ctx, ['.planning']) });
        assert.notEqual(reasonOf(validRun), 'owner_context_refused', `state ${sub} wrongly refused a valid descriptor: ${validRun.error}`);
        const wrote = JSON.stringify(snapshot(valid.tmp)) !== JSON.stringify(validBefore);
        if (wrote) wroteCount += 1;

        // The mismatched scope must never partially mutate.
        const before = snapshot(mismatch.tmp);
        const refused = runGsdTools([...argv, ...TRAIL], mismatch.real, { ...sandbox(mismatch.tmp), ...descEnv(mismatch.ctx, ['src']) });
        assert.deepEqual(snapshot(mismatch.tmp), before, `state ${sub} must not partially mutate`);
        if (wrote) assertRefused(refused);
      } finally {
        cleanup(valid.tmp);
        cleanup(mismatch.tmp);
      }
    });
  }

  test('every state writer performed a real write in its valid run (full behavioral coverage)', () => {
    assert.equal(
      wroteCount,
      STATE_WRITERS.length,
      `only ${wroteCount}/${STATE_WRITERS.length} state writers produced a write in the valid run — `
      + 'a no-op/usage-error fixture does not exercise the writer or its refusal branch',
    );
  });
});

// ─── Direct-export primitives ────────────────────────────────────────────────

describe('direct-export writer primitives are bound too', () => {
  const qb = require('../gsd-core/bin/lib/quick-batch.cjs');
  const config = require('../gsd-core/bin/lib/config.cjs');

  function withEnv(env, fn) {
    const keys = Object.values(E);
    const saved = {};
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, env);
    try { return fn(); } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }

  test('quick-batch createBatch: no descriptor refuses and writes nothing', () => {
    const { tmp, real } = makeFixture('oc-dx-qb-', (d) => fs.writeFileSync(path.join(d, '.planning', 'tasks.md'), '- a\n'));
    try {
      assert.throws(() => withEnv({}, () => qb.createBatch(real, [{ description: 'a' }])));
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'quick-batches')), false);
    } finally { cleanup(tmp); }
  });

  test('quick-batch createBatch: mismatched scope refuses and writes nothing', () => {
    const { tmp, real, ctx } = makeFixture('oc-dx-qb2-', (d) => fs.writeFileSync(path.join(d, '.planning', 'tasks.md'), '- a\n'));
    try {
      assert.throws(() => withEnv(descEnv(ctx, ['src']), () => qb.createBatch(real, [{ description: 'a' }])));
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'quick-batches')), false);
    } finally { cleanup(tmp); }
  });

  test('quick-batch createBatch: a valid descriptor writes the batch', () => {
    const { tmp, real, ctx } = makeFixture('oc-dx-qb3-', (d) => fs.writeFileSync(path.join(d, '.planning', 'tasks.md'), '- a\n'));
    try {
      const out = withEnv(descEnv(ctx, ['.planning']), () => qb.createBatch(real, [{ description: 'a' }]));
      assert.equal(out.ok, true);
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'quick-batches')), true);
    } finally { cleanup(tmp); }
  });

  test('config.setConfigValue: no descriptor refuses and writes nothing', () => {
    const { tmp, real } = makeFixture('oc-dx-cfg-', () => {});
    try {
      assert.throws(() => withEnv({}, () => config.setConfigValue(real, 'workflow.mvp_mode', true)));
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'config.json')), false);
    } finally { cleanup(tmp); }
  });

  test('config.setConfigValue: a valid descriptor writes the config', () => {
    const { tmp, real, ctx } = makeFixture('oc-dx-cfg2-', () => {});
    try {
      withEnv(descEnv(ctx, ['.planning']), () => config.setConfigValue(real, 'workflow.mvp_mode', true));
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'config.json')), true);
    } finally { cleanup(tmp); }
  });
});
