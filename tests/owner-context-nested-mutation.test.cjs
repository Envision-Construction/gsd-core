'use strict';

/**
 * RED/GREEN controls for the 2026-10-10 core correction bundle.
 *
 * Each case here reproduces a confirmed finding from the root acceptance review
 * and asserts the FIXED behavior, not the symptom:
 *   1. a multi-file `phase remove` binds all of its targets once, so the nested
 *      STATE.md writer does not re-check a snapshot the operation itself
 *      rewrote (partial-mutation-then-refuse regression);
 *   2. the same operation still REFUSES stale external input at entry, with no
 *      partial effects;
 *   3. the writable-scope fingerprint binds legitimate source bytes
 *      (`src/Gemfile.lock`, a `foo.tmp/` dir) and exempts ONLY GSD's exact
 *      operation transients;
 *   4. an authorized operation relaxes freshness for nested writes but STILL
 *      refuses a nested target outside the authorized set;
 *   5. policy ownership is bound to the canonical Git worktree root, so a direct
 *      writer handed a NESTED cwd cannot fall back to audit;
 *   6. the classifier treats the flag-supplied writers and the read-only
 *      subcommands correctly (prompt-budget, restore-custom-files, research-store,
 *      state prune --dry-run / state sync --verify).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const oc = require('../gsd-core/bin/lib/owner-context.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');

const E = oc.OWNER_DESCRIPTOR_ENV;
const SPAWN_TIMEOUT_MS = 60_000;

function git(dir, ...args) {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: SPAWN_TIMEOUT_MS });
}

function enforcePolicy(real) {
  const pre = oc.buildOwnerContext(real);
  fs.writeFileSync(
    path.join(real, '.planning', 'owner-policy.json'),
    JSON.stringify({ policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: pre.owner.repo_id }] }, null, 2),
  );
  git(real, 'add', '-A');
  git(real, 'commit', '-q', '-m', 'owner-policy');
  return oc.buildOwnerContext(real);
}

function sandbox(real) {
  const home = path.join(real, '.home');
  fs.mkdirSync(home, { recursive: true });
  const cleared = {};
  for (const key of Object.values(E)) cleared[key] = undefined;
  return { ...cleared, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
}

function descriptorEnv(ctx, scopes) {
  return {
    [E.TASK_ID]: 'nested-1',
    [E.REPO_ID]: ctx.owner.repo_id,
    [E.ROOT]: ctx.owner.root,
    [E.WORKFLOW]: 'operational',
    [E.RATIONALE]: 'nested mutation control',
    [E.WRITABLE_SCOPES]: scopes.join(','),
    [E.PROVENANCE]: 'test',
    [E.EXPECT_HEAD]: ctx.owner.head,
    [E.EXPECT_FINGERPRINT]: ctx.fingerprint.planning,
    [E.EXPECT_SCOPE_FINGERPRINT]: oc.scopeFingerprint(ctx.owner.root, scopes).fingerprint,
  };
}

function phaseRemoveFixture() {
  const tmp = createTempGitProject('oc-nested-phase-');
  const planning = path.join(tmp, '.planning');
  fs.mkdirSync(path.join(planning, 'phases', '01-foo'), { recursive: true });
  fs.mkdirSync(path.join(planning, 'phases', '02-bar'), { recursive: true });
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), '# Roadmap\n\n## Phase 1: Foo\n## Phase 2: Bar\n');
  fs.writeFileSync(path.join(planning, 'STATE.md'), '---\nstatus: planning\n---\n# State\n\nTotal Phases: 2\n');
  fs.writeFileSync(path.join(planning, 'phases', '01-foo', '01-PLAN.md'), '# plan\n');
  fs.writeFileSync(path.join(planning, 'phases', '02-bar', '02-PLAN.md'), '# plan\n');
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', 'fixture');
  const real = fs.realpathSync.native(tmp);
  const ctx = enforcePolicy(real);
  return { tmp, real, ctx };
}

function runTools(real, argv, env) {
  try {
    const output = execFileSync('node', [path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs'), ...argv], {
      cwd: real,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: SPAWN_TIMEOUT_MS,
    });
    return { exitCode: 0, output, error: '' };
  } catch (err) {
    return { exitCode: err.status ?? 1, output: err.stdout || '', error: err.stderr || '' };
  }
}

describe('multi-file operation: nested state writer does not re-stale', () => {
  test('phase remove succeeds end-to-end: directory deleted, sibling renumbered, ROADMAP + STATE rewritten', () => {
    const { tmp, real, ctx } = phaseRemoveFixture();
    try {
      const r = runTools(real, ['phase', 'remove', '1', '--force', '--json-errors'], { ...sandbox(real), ...descriptorEnv(ctx, ['.planning']) });
      assert.equal(r.exitCode, 0, `phase remove must succeed: ${r.error}${r.output}`);
      assert.equal(fs.existsSync(path.join(real, '.planning', 'phases', '01-foo')), false, 'phase dir removed');
      assert.equal(fs.existsSync(path.join(real, '.planning', 'phases', '01-bar')), true, 'sibling 02 -> 01 renumbered');
      const roadmap = fs.readFileSync(path.join(real, '.planning', 'ROADMAP.md'), 'utf8');
      assert.ok(!/# Phase 1: Foo/.test(roadmap), 'ROADMAP rewritten to drop the removed phase');
    } finally {
      cleanup(tmp);
    }
  });

  test('phase remove refuses STALE external input at entry with NO partial effects', () => {
    const { tmp, real, ctx } = phaseRemoveFixture();
    try {
      const env = { ...sandbox(real), ...descriptorEnv(ctx, ['.planning']) };
      // External edit AFTER the descriptor snapshot -> stale.
      fs.writeFileSync(path.join(real, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phase 1: Foo\n## Phase 2: Bar\n## Phase 3: Baz\n');
      const before = {
        roadmap: fs.readFileSync(path.join(real, '.planning', 'ROADMAP.md'), 'utf8'),
        dir1: fs.existsSync(path.join(real, '.planning', 'phases', '01-foo')),
        dir2: fs.existsSync(path.join(real, '.planning', 'phases', '02-bar')),
        state: fs.readFileSync(path.join(real, '.planning', 'STATE.md'), 'utf8'),
      };
      const r = runTools(real, ['phase', 'remove', '1', '--force', '--json-errors'], env);
      assert.notEqual(r.exitCode, 0, 'a stale descriptor must refuse');
      assert.match(r.error, /owner_context_refused/, 'refusal carries the stable reason');
      assert.equal(fs.readFileSync(path.join(real, '.planning', 'ROADMAP.md'), 'utf8'), before.roadmap, 'no ROADMAP write');
      assert.equal(fs.existsSync(path.join(real, '.planning', 'phases', '01-foo')), before.dir1, 'no phase-dir delete');
      assert.equal(fs.existsSync(path.join(real, '.planning', 'phases', '02-bar')), before.dir2, 'no sibling rename');
      assert.equal(fs.readFileSync(path.join(real, '.planning', 'STATE.md'), 'utf8'), before.state, 'no STATE write');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('writable-scope fingerprint binds real content, exempts only owned transients', () => {
  function scopeFixture() {
    const tmp = createTempGitProject('oc-scope-fp-');
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'a.js'), 'a\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-q', '-m', 'fixture');
    return fs.realpathSync.native(tmp);
  }

  test('a change to src/Gemfile.lock moves the fingerprint', () => {
    const root = scopeFixture();
    try {
      fs.writeFileSync(path.join(root, 'src', 'Gemfile.lock'), 'BEFORE\n');
      const before = oc.scopeFingerprint(root, ['src']);
      fs.writeFileSync(path.join(root, 'src', 'Gemfile.lock'), 'AFTER!\n');
      const after = oc.scopeFingerprint(root, ['src']);
      assert.notEqual(before.fingerprint, after.fingerprint, 'a *.lock SOURCE file must bind its bytes');
      assert.equal(before.file_count, 2, 'src/a.js + src/Gemfile.lock both counted');
    } finally {
      cleanup(root);
    }
  });

  test('a foo.tmp/ source directory binds its bytes (no blanket .tmp- exclusion)', () => {
    const root = scopeFixture();
    try {
      const d = path.join(root, 'src', 'foo.tmp');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'x.txt'), 'BEFORE\n');
      const before = oc.scopeFingerprint(root, ['src']);
      fs.writeFileSync(path.join(d, 'x.txt'), 'AFTER!\n');
      const after = oc.scopeFingerprint(root, ['src']);
      assert.notEqual(before.fingerprint, after.fingerprint, 'a *.tmp DIRECTORY must bind its bytes');
    } finally {
      cleanup(root);
    }
  });

  test("GSD's exact operation transients are exempt (STATE.md.lock, milestone.lock, pid temps)", () => {
    const root = scopeFixture();
    try {
      const d = path.join(root, 'src');
      fs.writeFileSync(path.join(d, 'STATE.md.lock'), 'lock');
      fs.writeFileSync(path.join(d, 'milestone.lock'), 'claim');
      fs.writeFileSync(path.join(d, '.WINDOWS.lock'), 'ledger');
      fs.writeFileSync(path.join(d, 'x.json.tmp-1234'), 'temp');
      fs.writeFileSync(path.join(d, 'y.json.tmp.1234-99'), 'temp');
      const snap = oc.scopeFingerprint(root, ['src']);
      assert.equal(snap.file_count, 1, `only src/a.js should be counted, got ${snap.entries.join(', ')}`);
    } finally {
      cleanup(root);
    }
  });
});

describe('authorized operation relaxes freshness for nested writes but keeps the target bound', () => {
  test('a nested write inside its authorized set is allowed after the outer mutation', () => {
    const { tmp, real, ctx } = phaseRemoveFixture();
    try {
      const env = { ...sandbox(real), ...descriptorEnv(ctx, ['.planning']) };
      const statePath = path.join(real, '.planning', 'STATE.md');
      const result = oc.withOwnedOperation(real, [path.join(real, '.planning')], () => {
        // Simulate the outer operation mutating the snapshot before a nested gate.
        fs.writeFileSync(statePath, '---\nstatus: executing\n---\n# State\n');
        assert.doesNotThrow(() => oc.assertTargetsAuthorized(real, [statePath], { env }));
        return 'ok';
      }, { env });
      assert.equal(result, 'ok');
    } finally {
      cleanup(tmp);
    }
  });

  test('a nested write OUTSIDE the authorized set is still refused', () => {
    const { tmp, real, ctx } = phaseRemoveFixture();
    try {
      const env = { ...sandbox(real), ...descriptorEnv(ctx, ['.planning']) };
      const outside = path.join(real, 'src', 'escape.txt');
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      assert.throws(() => oc.withOwnedOperation(real, [path.join(real, '.planning')], () => {
        oc.assertTargetsAuthorized(real, [outside], { env });
      }, { env }), /outside the authorized operation set|outside the declared writable scopes/);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('policy ownership is bound to the canonical Git worktree root', () => {
  test('gate(root/src) resolves the root policy and still enforces', () => {
    const { tmp, real } = phaseRemoveFixture();
    try {
      const atRoot = oc.ownerContextGate(real);
      const nested = oc.ownerContextGate(path.join(real, '.planning'));
      assert.equal(atRoot.enforcing, true);
      assert.equal(nested.enforcing, true, 'a nested cwd must not silently fall back to audit');
      assert.equal(nested.context.owner.root, real, 'the resolved owner root is still the worktree root');
    } finally {
      cleanup(tmp);
    }
  });

  test('a direct writer called with a nested cwd still refuses an unowned target', () => {
    const { tmp, real, ctx } = phaseRemoveFixture();
    try {
      const env = { ...sandbox(real), ...descriptorEnv(ctx, ['src']) };
      const nested = path.join(real, 'src', 'deep');
      fs.mkdirSync(nested, { recursive: true });
      // cwd is the nested dir (no policy there); the ROOT policy must still apply.
      assert.throws(() => oc.assertTargetsAuthorized(nested, [path.join(real, '.planning', 'STATE.md')], { env }),
        /outside the declared writable scopes/);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('classifier: flag-supplied writers and read-only subcommands', () => {
  test('flag-supplied writers are classified mutating', () => {
    assert.equal(oc.isMutatingCommand('prompt-budget', ['prompt-budget', '--budget', '1000']), true);
    assert.equal(oc.isMutatingCommand('research-store', ['research-store', 'put', 'a'.repeat(64)]), true);
    assert.equal(oc.isMutatingCommand('restore-custom-files', ['restore-custom-files', '--config-dir', '/x', '--apply']), true);
  });

  test('read-only subcommands/flags stay unclassified', () => {
    assert.equal(oc.isMutatingCommand('research-store', ['research-store', 'get', 'a'.repeat(64)]), false);
    assert.equal(oc.isMutatingCommand('restore-custom-files', ['restore-custom-files', '--config-dir', '/x']), false);
    assert.equal(oc.isMutatingCommand('state', ['state', 'prune', '--dry-run']), false);
    assert.equal(oc.isMutatingCommand('state', ['state', 'prune']), true);
    assert.equal(oc.isMutatingCommand('state', ['state', 'sync', '--verify']), false);
    assert.equal(oc.isMutatingCommand('state', ['state', 'sync']), true);
    assert.equal(oc.isMutatingCommand('state', ['state', 'rebuild', '--dry-run']), false);
  });
});

describe('runtime/backend checker reads live exports (regression control)', () => {
  test('the compiled backend exposes real callables, not just text', () => {
    const backend = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'owner-context.cjs');
    const mod = require(backend);
    assert.equal(typeof mod.OWNER_CONTEXT_VERSION, 'string');
    for (const name of ['OwnerContextRefusal', 'assertOwnerContextForWrite', 'assertTargetsAuthorized', 'preflightOwnerContext', 'isMutatingCommand']) {
      assert.equal(typeof mod[name], 'function', `${name} must be a live callable`);
    }
  });
});

