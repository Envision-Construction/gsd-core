'use strict';

/**
 * Integration band for the additive owner_context contract: the mandatory
 * DISPATCH boundary (gsd-tools runCommand), the additive init envelope, and the
 * no-provider-call invariant. The pure module contract lives in the sibling
 * tests/owner-context.unit.test.cjs.
 *
 * These spawn the real CLI (gsd-core/bin/gsd-tools.cjs) so a classification
 * regression (e.g. quick-tasks-append dropping out of the mutating set) fails
 * here at the boundary a user actually hits.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');

const oc = require('../gsd-core/bin/lib/owner-context.cjs');

const REPO_ROOT = path.join(__dirname, '..');

function writePolicy(cwd, policy) {
  fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.planning', 'owner-policy.json'), JSON.stringify(policy, null, 2));
}

/** Parse the JSON-error payload a --json-errors run writes to stderr. */
function jsonError(result) {
  try {
    return JSON.parse((result.error || '').trim());
  } catch {
    return null;
  }
}

describe('owner-context dispatch boundary (CLI)', () => {
  test('quick-tasks-append under a non-matching enforce policy is refused (owner_context_refused)', () => {
    const tmp = createTempGitProject('gsd-oc-dispatch-');
    try {
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'github.com/example/other' }] });
      const result = runGsdTools(['quick-tasks-append', '--task', 'x', '--json-errors'], tmp);
      assert.equal(result.success, false);
      const payload = jsonError(result);
      assert.ok(payload, `expected JSON error, got: ${result.error}`);
      assert.equal(payload.reason, 'owner_context_refused');
      // The gate refused BEFORE the writer ran, so no STATE.md appeared.
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'STATE.md')), false);
    } finally {
      cleanup(tmp);
    }
  });

  test('quick-tasks-migrate under a non-matching enforce policy is refused', () => {
    const tmp = createTempGitProject('gsd-oc-dispatch-');
    try {
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'github.com/example/other' }] });
      const result = runGsdTools(['quick-tasks-migrate', '--json-errors'], tmp);
      assert.equal(result.success, false);
      assert.equal(jsonError(result).reason, 'owner_context_refused');
    } finally {
      cleanup(tmp);
    }
  });

  test('a state family writer under a non-matching enforce policy is refused', () => {
    const tmp = createTempGitProject('gsd-oc-dispatch-');
    try {
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'github.com/example/other' }] });
      const result = runGsdTools(['state', 'add-blocker', '--blocker', 'x', '--json-errors'], tmp);
      assert.equal(result.success, false);
      assert.equal(jsonError(result).reason, 'owner_context_refused');
    } finally {
      cleanup(tmp);
    }
  });

  test('AUDIT compatibility: with no policy the same command is NOT refused', () => {
    const tmp = createTempGitProject('gsd-oc-dispatch-');
    try {
      const result = runGsdTools(['quick-tasks-append', '--task', 'x', '--json-errors'], tmp);
      const payload = jsonError(result);
      // It may fail for its own reason (no Quick Tasks table), but never for
      // ownership - audit preserves the exact pre-change behaviour.
      assert.notEqual(payload && payload.reason, 'owner_context_refused');
      assert.doesNotMatch(result.error || '', /owner_context_refused/);
    } finally {
      cleanup(tmp);
    }
  });

  test('a matching descriptor (env contract) authorises the mutation past the gate', () => {
    const tmp = createTempGitProject('gsd-oc-dispatch-');
    try {
      // The CLI canonicalises cwd (macOS /var -> /private/var), so the expected
      // snapshot must be built from the same realpath or the fingerprint drifts.
      const real = fs.realpathSync.native(tmp);
      const ctx = oc.buildOwnerContext(real, {});
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: ctx.owner.repo_id }] });
      const scope = '.planning/PROJECT.md';
      const scopeFp = oc.scopeFingerprint(ctx.owner.root, [scope]).fingerprint;
      const env = {
        [oc.OWNER_DESCRIPTOR_ENV.TASK_ID]: 'task-1',
        [oc.OWNER_DESCRIPTOR_ENV.REPO_ID]: ctx.owner.repo_id,
        [oc.OWNER_DESCRIPTOR_ENV.ROOT]: ctx.owner.root,
        [oc.OWNER_DESCRIPTOR_ENV.WORKFLOW]: 'operational',
        [oc.OWNER_DESCRIPTOR_ENV.RATIONALE]: 'dispatch integration fixture',
        [oc.OWNER_DESCRIPTOR_ENV.WRITABLE_SCOPES]: scope,
        [oc.OWNER_DESCRIPTOR_ENV.PROVENANCE]: 'test',
        [oc.OWNER_DESCRIPTOR_ENV.EXPECT_HEAD]: ctx.owner.head,
        [oc.OWNER_DESCRIPTOR_ENV.EXPECT_FINGERPRINT]: ctx.fingerprint.planning,
        [oc.OWNER_DESCRIPTOR_ENV.EXPECT_SCOPE_FINGERPRINT]: scopeFp,
      };
      const result = runGsdTools(['quick-tasks-append', '--task', 'x', '--json-errors'], tmp, env);
      const payload = jsonError(result);
      assert.notEqual(payload && payload.reason, 'owner_context_refused', 'a matching descriptor must not be refused');
    } finally {
      cleanup(tmp);
    }
  });

  test('an INCOMPLETE descriptor is refused field-by-field (operational without rationale/owner/head)', () => {
    const tmp = createTempGitProject('gsd-oc-dispatch-');
    try {
      const real = fs.realpathSync.native(tmp);
      const ctx = oc.buildOwnerContext(real, {});
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: ctx.owner.repo_id }] });
      // Only a workflow kind - no owner root, no head/fingerprint, no task id.
      const env = { [oc.OWNER_DESCRIPTOR_ENV.WORKFLOW]: 'operational' };
      const result = runGsdTools(['quick-tasks-append', '--task', 'x', '--json-errors'], tmp, env);
      assert.equal(result.success, false);
      assert.equal(jsonError(result).reason, 'owner_context_refused');
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'STATE.md')), false);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- behavioral refusal fixtures through the consumed CLI sequence ----------

describe('owner-context consumed run/list/status/resume refusals', () => {
  // The consumed sequence resolves `QUICK_DIR=$(gsd_run query init.quick "" --pick
  // quick_dir)` and writes through the dispatch-gated mutating commands. These
  // fixtures drive the REAL CLI with an env descriptor and assert refusal + zero
  // side effect, then a valid scoped success.
  function projEnv(ctx, scopes, overrides = {}) {
    const env = {
      [oc.OWNER_DESCRIPTOR_ENV.TASK_ID]: 'beh-1',
      [oc.OWNER_DESCRIPTOR_ENV.REPO_ID]: ctx.owner.repo_id,
      [oc.OWNER_DESCRIPTOR_ENV.ROOT]: ctx.owner.root,
      [oc.OWNER_DESCRIPTOR_ENV.WORKFLOW]: 'operational',
      [oc.OWNER_DESCRIPTOR_ENV.RATIONALE]: 'behavioral fixture',
      [oc.OWNER_DESCRIPTOR_ENV.WRITABLE_SCOPES]: scopes.join(','),
      [oc.OWNER_DESCRIPTOR_ENV.PROVENANCE]: 'test',
      [oc.OWNER_DESCRIPTOR_ENV.EXPECT_HEAD]: ctx.owner.head,
      [oc.OWNER_DESCRIPTOR_ENV.EXPECT_FINGERPRINT]: ctx.fingerprint.planning,
      [oc.OWNER_DESCRIPTOR_ENV.EXPECT_SCOPE_FINGERPRINT]: oc.scopeFingerprint(ctx.owner.root, scopes).fingerprint,
    };
    for (const key of Object.keys(overrides)) {
      if (overrides[key] === undefined) delete env[key];
      else env[key] = overrides[key];
    }
    return env;
  }

  function seedScope(tmp) {
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.planning', 'STATE.md'), '---\nstatus: active\n---\n# State\n');
    const real = fs.realpathSync.native(tmp);
    const ctx = oc.buildOwnerContext(real, {});
    writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: ctx.owner.repo_id }] });
    return { real, ctx };
  }

  const REFUSED = [
    ['conflicting worktree (descriptor ROOT elsewhere)', (ctx, real) => projEnv(ctx, ['.planning'], { [oc.OWNER_DESCRIPTOR_ENV.ROOT]: path.join(real, 'elsewhere') })],
    ['stale descriptor (expected HEAD moved)', (ctx, _real) => projEnv(ctx, ['.planning'], { [oc.OWNER_DESCRIPTOR_ENV.EXPECT_HEAD]: 'c'.repeat(40) })],
    ['missing parent (linked-quick parent_plan absent)', (ctx, _real) => projEnv(ctx, ['.planning'], {
      [oc.OWNER_DESCRIPTOR_ENV.WORKFLOW]: 'linked-quick',
      [oc.OWNER_DESCRIPTOR_ENV.PARENT_PLAN]: '.planning/quick/does-not-exist/PARENT.md',
      [oc.OWNER_DESCRIPTOR_ENV.RATIONALE]: undefined,
    })],
  ];

  for (const [label, build] of REFUSED) {
    test('run/status/resume refuse on ' + label + ' with no write', () => {
      const tmp = createTempGitProject('gsd-oc-beh-');
      try {
        const { real, ctx } = seedScope(tmp);
        const before = fs.readFileSync(path.join(tmp, '.planning', 'STATE.md'), 'utf8');
        const env = build(ctx, real);
        const result = runGsdTools(['quick-tasks-append', '--task', 'x', '--json-errors'], tmp, env);
        assert.equal(result.success, false, label);
        assert.equal(jsonError(result).reason, 'owner_context_refused', label);
        assert.equal(fs.readFileSync(path.join(tmp, '.planning', 'STATE.md'), 'utf8'), before, label);
      } finally {
        cleanup(tmp);
      }
    });
  }

  test('wrong cwd (not a resolvable worktree) refuses the preflight under enforce', () => {
    const tmp = createTempDir();
    try {
      fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.planning', 'owner-policy.json'), JSON.stringify({ policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'local:x' }] }));
      const result = runGsdTools(['owner-context', 'preflight', '--json-errors'], tmp, {});
      assert.equal(result.success, false);
      assert.equal(jsonError(result).reason, 'owner_context_refused');
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'quick')), false);
    } finally {
      cleanup(tmp);
    }
  });

  test('valid scoped descriptor allows the run sequence (project scope agrees with list/status/resume)', () => {
    const tmp = createTempGitProject('gsd-oc-beh-');
    const savedP = process.env.GSD_PROJECT;
    try {
      const { real } = seedScope(tmp);
      fs.mkdirSync(path.join(tmp, '.planning', 'pp'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.planning', 'pp', 'STATE.md'), '---\nstatus: active\n---\n# Scoped\n');
      const scopedEnv = { GSD_PROJECT: 'pp' };
      const scopedRoot = path.join(real, '.planning', 'pp');
      // Build the descriptor in the SAME scope the run uses (project=pp), so its
      // planning binding + expected planning fingerprint match the scoped root.
      process.env.GSD_PROJECT = 'pp';
      const ctx = oc.buildOwnerContext(real, {});
      const env = projEnv(ctx, ['.planning/pp'], { [oc.OWNER_DESCRIPTOR_ENV.PROJECT]: 'pp' });
      const resolved = runGsdTools(['init', 'quick', '', '--pick', 'quick_dir'], tmp, scopedEnv);
      assert.equal(resolved.success, true, resolved.error);
      assert.equal(resolved.output, path.join(scopedRoot, 'quick'), 'run/list/status/resume share this resolved path');
      const result = runGsdTools(['quick-tasks-append', '--task', 'x', '--json-errors'], tmp, { ...scopedEnv, ...env });
      assert.notEqual(jsonError(result) && jsonError(result).reason, 'owner_context_refused');
    } finally {
      if (savedP === undefined) delete process.env.GSD_PROJECT; else process.env.GSD_PROJECT = savedP;
      cleanup(tmp);
    }
  });
});

// --- consumed-CLI fixtures (real gsd-tools, not mocked) ---------------------

describe('owner-context consumed CLI fixtures', () => {
  test('init.quick resolves ONE scoped quick path for root / project / workstream', () => {
    const tmp = createTempGitProject('gsd-oc-scoped-');
    try {
      const real = fs.realpathSync.native(tmp);
      const rootPath = runGsdTools(['init', 'quick', '', '--pick', 'quick_dir'], tmp, {});
      assert.equal(rootPath.success, true, rootPath.error);
      assert.equal(rootPath.output, path.join(real, '.planning', 'quick'));

      const proj = runGsdTools(['init', 'quick', '', '--pick', 'quick_dir'], tmp, { GSD_PROJECT: 'pp' });
      assert.equal(proj.success, true, proj.error);
      assert.equal(proj.output, path.join(real, '.planning', 'pp', 'quick'));

      const ws = runGsdTools(['init', 'quick', '', '--pick', 'quick_dir'], tmp, { GSD_PROJECT: 'pp', GSD_WORKSTREAM: 'ww' });
      assert.equal(ws.success, true, ws.error);
      assert.equal(ws.output, path.join(real, '.planning', 'pp', 'workstreams', 'ww', 'quick'));
    } finally {
      cleanup(tmp);
    }
  });

  test('owner-context preflight CLI: enforce refuses (exit non-zero, owner_context_refused)', () => {
    const tmp = createTempGitProject('gsd-oc-cli-');
    try {
      const real = fs.realpathSync.native(tmp);
      const ctx = oc.buildOwnerContext(real, {});
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: ctx.owner.repo_id }] });
      const result = runGsdTools(['owner-context', 'preflight', '--json-errors'], tmp, {});
      assert.equal(result.success, false);
      assert.equal(jsonError(result).reason, 'owner_context_refused');
    } finally {
      cleanup(tmp);
    }
  });

  test('owner-context preflight CLI: audit reports the observation and exits 0', () => {
    const tmp = createTempGitProject('gsd-oc-cli-');
    try {
      const result = runGsdTools(['owner-context', 'preflight'], tmp, {});
      assert.equal(result.success, true, result.error);
      const parsed = JSON.parse(result.output);
      assert.equal(parsed.enforcing, false);
      assert.equal(parsed.ok, false, 'no descriptor → unresolved observation, honestly reported');
    } finally {
      cleanup(tmp);
    }
  });

  test('a malformed enforce policy refuses a mutating CLI command before any write', () => {
    const tmp = createTempGitProject('gsd-oc-cli-');
    try {
      fs.writeFileSync(path.join(tmp, '.planning', 'owner-policy.json'), '{ "mode": "enforce", "known_owners": [');
      const result = runGsdTools(['quick-tasks-append', '--task', 'x', '--json-errors'], tmp, {});
      assert.equal(result.success, false);
      assert.equal(jsonError(result).reason, 'owner_context_refused');
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'STATE.md')), false);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- remaining direct STATE writers + configuration gate-unavailable ---------

describe('owner-context remaining direct writers', () => {
  const state = require('../gsd-core/bin/lib/state.cjs');

  function projectWithState() {
    const tmp = createTempGitProject('gsd-oc-state-');
    fs.writeFileSync(path.join(tmp, '.planning', 'STATE.md'), '---\nmilestone: v1.0\nstatus: active\n---\n# State\n\n## Current Position\n\n- milestone: v1.0\n');
    const real = fs.realpathSync.native(tmp);
    const ctx = oc.buildOwnerContext(real, {});
    enforcePolicy(tmp, ctx);
    return { tmp, real, ctx };
  }

  test('cmdStateMilestoneSwitch: scope mismatch refuses with no partial mutation; valid scope succeeds', () => {
    const { tmp, real, ctx } = projectWithState();
    try {
      const statePath = path.join(tmp, '.planning', 'STATE.md');
      const before = fs.readFileSync(statePath, 'utf8');
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'a\n');
      assert.throws(() => withDirectEnv(ownershipEnv(ctx, ['src']), () => state.cmdStateMilestoneSwitch(real, 'v9.9', 'next', true)));
      assert.equal(fs.readFileSync(statePath, 'utf8'), before, 'a refused milestone switch must not mutate STATE.md');

      withDirectEnv(ownershipEnv(ctx, ['.planning']), () => state.cmdStateMilestoneSwitch(real, 'v9.9', 'next', true));
      assert.notEqual(fs.readFileSync(statePath, 'utf8'), before, 'a valid descriptor must allow the switch');
    } finally {
      cleanup(tmp);
    }
  });

  test('cmdStatePrune: scope mismatch refuses and creates no archive; valid scope succeeds', () => {
    const { tmp, real, ctx } = projectWithState();
    try {
      const statePath = path.join(tmp, '.planning', 'STATE.md');
      const archivePath = path.join(tmp, '.planning', 'STATE-ARCHIVE.md');
      const before = fs.readFileSync(statePath, 'utf8');
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'a\n');
      assert.throws(() => withDirectEnv(ownershipEnv(ctx, ['src']), () => state.cmdStatePrune(real, { keepRecent: 0, dryRun: false }, true)));
      assert.equal(fs.existsSync(archivePath), false, 'a refused prune must not create the archive');
      assert.equal(fs.readFileSync(statePath, 'utf8'), before, 'a refused prune must not mutate STATE.md');

      assert.doesNotThrow(() => withDirectEnv(ownershipEnv(ctx, ['.planning']), () => state.cmdStatePrune(real, { keepRecent: 0, dryRun: false }, true)));
    } finally {
      cleanup(tmp);
    }
  });

  test('configuration.migrateOnDisk refuses (gate unavailable) under an explicit enforce policy when the module cannot load', () => {
    const tmp = createTempDir();
    try {
      const bin = path.join(tmp, 'install', '.codex', 'gsd-core', 'bin');
      const lib = path.join(bin, 'lib');
      const shared = path.join(bin, 'shared');
      fs.mkdirSync(lib, { recursive: true });
      fs.mkdirSync(shared, { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'configuration.cjs'), path.join(lib, 'configuration.cjs'));
      for (const manifest of ['config-defaults.manifest.json', 'config-schema.manifest.json']) {
        fs.copyFileSync(path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', manifest), path.join(shared, manifest));
      }
      const installedCjs = path.join(lib, 'configuration.cjs');
      delete require.cache[installedCjs];
      const configMod = require(installedCjs);

      const proj = path.join(tmp, 'proj');
      fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(proj, '.planning', 'owner-policy.json'), JSON.stringify({ policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'local:x' }] }));
      const configPath = path.join(proj, '.planning', 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ branching_strategy: 'none' }));
      const before = fs.readFileSync(configPath, 'utf8');
      assert.throws(() => configMod.migrateOnDisk(proj, undefined, configPath), /gate unavailable/);
      assert.equal(fs.readFileSync(configPath, 'utf8'), before, 'no write when the gate is unavailable under enforce');
    } finally {
      cleanup(tmp);
    }
  });

  test('configuration.migrateOnDisk still audits (writes) when NO enforce policy is present in a standalone layout', () => {
    const tmp = createTempDir();
    try {
      const bin = path.join(tmp, 'install', '.codex', 'gsd-core', 'bin');
      const lib = path.join(bin, 'lib');
      const shared = path.join(bin, 'shared');
      fs.mkdirSync(lib, { recursive: true });
      fs.mkdirSync(shared, { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'configuration.cjs'), path.join(lib, 'configuration.cjs'));
      for (const manifest of ['config-defaults.manifest.json', 'config-schema.manifest.json']) {
        fs.copyFileSync(path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', manifest), path.join(shared, manifest));
      }
      const installedCjs = path.join(lib, 'configuration.cjs');
      delete require.cache[installedCjs];
      const configMod = require(installedCjs);

      const proj = path.join(tmp, 'proj');
      fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
      const configPath = path.join(proj, '.planning', 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ branching_strategy: 'none' }));
      const before = fs.readFileSync(configPath, 'utf8');
      configMod.migrateOnDisk(proj, undefined, configPath);
      assert.notEqual(fs.readFileSync(configPath, 'utf8'), before, 'audit behaviour preserved with no enforce policy');
    } finally {
      cleanup(tmp);
    }
  });

  function standaloneProject() {
    const tmp = createTempDir();
    const bin = path.join(tmp, 'install', '.codex', 'gsd-core', 'bin');
    const lib = path.join(bin, 'lib');
    const shared = path.join(bin, 'shared');
    fs.mkdirSync(lib, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'configuration.cjs'), path.join(lib, 'configuration.cjs'));
    for (const manifest of ['config-defaults.manifest.json', 'config-schema.manifest.json']) {
      fs.copyFileSync(path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', manifest), path.join(shared, manifest));
    }
    const installedCjs = path.join(lib, 'configuration.cjs');
    delete require.cache[installedCjs];
    const configMod = require(installedCjs);
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    const configPath = path.join(proj, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ branching_strategy: 'none' }));
    return { tmp, proj, configPath, configMod };
  }

  test('standalone migrateOnDisk refuses when GSD_OWNER_POLICY names a MISSING explicit path', () => {
    const { tmp, proj, configPath, configMod } = standaloneProject();
    const saved = process.env.GSD_OWNER_POLICY;
    try {
      process.env.GSD_OWNER_POLICY = path.join(tmp, 'missing-policy.json');
      const before = fs.readFileSync(configPath, 'utf8');
      assert.throws(() => configMod.migrateOnDisk(proj, undefined, configPath), /gate unavailable/);
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    } finally {
      if (saved === undefined) delete process.env.GSD_OWNER_POLICY; else process.env.GSD_OWNER_POLICY = saved;
      cleanup(tmp);
    }
  });

  test('standalone migrateOnDisk refuses a PRESENT corrupt/audit default policy (schema unverifiable)', () => {
    for (const body of ['{ not json', JSON.stringify({ policy_version: '1.0.0', mode: 'audit' })]) {
      const { tmp, proj, configPath, configMod } = standaloneProject();
      try {
        fs.writeFileSync(path.join(proj, '.planning', 'owner-policy.json'), body);
        const before = fs.readFileSync(configPath, 'utf8');
        assert.throws(() => configMod.migrateOnDisk(proj, undefined, configPath), /gate unavailable/, body);
        assert.equal(fs.readFileSync(configPath, 'utf8'), before);
      } finally {
        cleanup(tmp);
      }
    }
  });

  test('standalone migrateOnDisk refuses a present policy with an ESCAPED mode (no regex bypass)', () => {
    const { tmp, proj, configPath, configMod } = standaloneProject();
    try {
      // \u006dode decodes to "mode" — a regex like /"mode"\s*:\s*"enforce"/
      // would MISS this; presence-based refusal must not.
      fs.writeFileSync(path.join(proj, '.planning', 'owner-policy.json'), '{"\\u006dode":"enforce","known_owners":[{"repo_id":"x"}]}');
      const before = fs.readFileSync(configPath, 'utf8');
      assert.throws(() => configMod.migrateOnDisk(proj, undefined, configPath), /gate unavailable/);
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- direct-export mutation boundary (bypasses the CLI dispatch gate) -------

const DIRECT_ENV_KEYS = Object.values(oc.OWNER_DESCRIPTOR_ENV);

function withDirectEnv(env, fn) {
  const saved = {};
  for (const key of DIRECT_ENV_KEYS) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of DIRECT_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function enforcePolicy(tmp, ctx) {
  writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: ctx.owner.repo_id }] });
}

function ownershipEnv(ctx, scopes, overrides = {}) {
  const base = {
    [oc.OWNER_DESCRIPTOR_ENV.TASK_ID]: 'direct-1',
    [oc.OWNER_DESCRIPTOR_ENV.REPO_ID]: ctx.owner.repo_id,
    [oc.OWNER_DESCRIPTOR_ENV.ROOT]: ctx.owner.root,
    [oc.OWNER_DESCRIPTOR_ENV.WORKFLOW]: 'operational',
    [oc.OWNER_DESCRIPTOR_ENV.RATIONALE]: 'direct-export fixture',
    [oc.OWNER_DESCRIPTOR_ENV.WRITABLE_SCOPES]: scopes.join(','),
    [oc.OWNER_DESCRIPTOR_ENV.PROVENANCE]: 'test',
    [oc.OWNER_DESCRIPTOR_ENV.EXPECT_HEAD]: ctx.owner.head,
    [oc.OWNER_DESCRIPTOR_ENV.EXPECT_FINGERPRINT]: ctx.fingerprint.planning,
    [oc.OWNER_DESCRIPTOR_ENV.EXPECT_SCOPE_FINGERPRINT]: oc.scopeFingerprint(ctx.owner.root, scopes).fingerprint,
  };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) delete base[key];
    else base[key] = overrides[key];
  }
  return base;
}

describe('owner-context direct-export mutation boundary', () => {
  const milestone = require('../gsd-core/bin/lib/milestone.cjs');
  const workstream = require('../gsd-core/bin/lib/workstream.cjs');

  function directProject() {
    const tmp = createTempGitProject('gsd-oc-direct-');
    fs.writeFileSync(path.join(tmp, '.planning', 'REQUIREMENTS.md'), '# Requirements\n\n- [ ] **REQ-01** first\n');
    const real = fs.realpathSync.native(tmp);
    const ctx = oc.buildOwnerContext(real, {});
    enforcePolicy(tmp, ctx);
    return { tmp, real, ctx };
  }

  test('workstream create: wrong-owner descriptor refuses with ZERO mutation', () => {
    const { tmp, real, ctx } = directProject();
    try {
      const env = ownershipEnv(ctx, ['.planning'], { [oc.OWNER_DESCRIPTOR_ENV.REPO_ID]: 'github.com/example/other' });
      assert.throws(() => withDirectEnv(env, () => workstream.cmdWorkstreamCreate(real, 'ws1', {}, true)));
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'workstreams', 'ws1')), false);
    } finally {
      cleanup(tmp);
    }
  });

  test('workstream create: a STALE snapshot refuses with ZERO mutation', () => {
    const { tmp, real, ctx } = directProject();
    try {
      const env = ownershipEnv(ctx, ['.planning'], { [oc.OWNER_DESCRIPTOR_ENV.EXPECT_HEAD]: 'c'.repeat(40) });
      assert.throws(() => withDirectEnv(env, () => workstream.cmdWorkstreamCreate(real, 'ws1', {}, true)));
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'workstreams', 'ws1')), false);
    } finally {
      cleanup(tmp);
    }
  });

  test('workstream create: a MALFORMED enforce policy fails closed with ZERO mutation', () => {
    const { tmp, real, ctx } = directProject();
    try {
      fs.writeFileSync(path.join(tmp, '.planning', 'owner-policy.json'), '{ "mode": "enforce", "known_owners": [');
      const env = ownershipEnv(ctx, ['.planning']);
      assert.throws(() => withDirectEnv(env, () => workstream.cmdWorkstreamCreate(real, 'ws1', {}, true)));
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'workstreams', 'ws1')), false);
    } finally {
      cleanup(tmp);
    }
  });

  test('workstream create: a scope that excludes the target refuses with ZERO mutation', () => {
    const { tmp, real, ctx } = directProject();
    try {
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'a\n');
      const env = ownershipEnv(ctx, ['src']);
      assert.throws(() => withDirectEnv(env, () => workstream.cmdWorkstreamCreate(real, 'ws1', {}, true)));
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'workstreams', 'ws1')), false);
    } finally {
      cleanup(tmp);
    }
  });

  test('workstream create: a valid descriptor succeeds', () => {
    const { tmp, real, ctx } = directProject();
    try {
      withDirectEnv(ownershipEnv(ctx, ['.planning']), () => workstream.cmdWorkstreamCreate(real, 'ws1', {}, true));
      assert.equal(fs.existsSync(path.join(tmp, '.planning', 'workstreams', 'ws1')), true);
    } finally {
      cleanup(tmp);
    }
  });

  test('requirements mark-complete: scope mismatch refuses, valid scope mutates', () => {
    const { tmp, real, ctx } = directProject();
    try {
      const reqPath = path.join(tmp, '.planning', 'REQUIREMENTS.md');
      const before = fs.readFileSync(reqPath, 'utf8');
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'a\n');
      assert.throws(() => withDirectEnv(ownershipEnv(ctx, ['src']), () => milestone.cmdRequirementsMarkComplete(real, ['REQ-01'], true)));
      assert.equal(fs.readFileSync(reqPath, 'utf8'), before, 'a refused requirements write must not mutate');

      withDirectEnv(ownershipEnv(ctx, ['.planning']), () => milestone.cmdRequirementsMarkComplete(real, ['REQ-01'], true));
      assert.notEqual(fs.readFileSync(reqPath, 'utf8'), before, 'a valid descriptor must allow the write');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('owner-context init envelope', () => {
  test('init.* carries the additive owner_context and needs no network', () => {
    const tmp = createTempGitProject('gsd-oc-init-');
    try {
      // A dead proxy proves init resolves locally: any HTTP attempt would fail
      // or stall against 127.0.0.1:9.
      const env = { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '', no_proxy: '' };
      const result = runGsdTools(['init', 'quick'], tmp, env);
      assert.equal(result.success, true, result.error);
      const parsed = JSON.parse(result.output);
      assert.equal(parsed.owner_context.contract, oc.OWNER_CONTEXT_VERSION);
      assert.equal(parsed.owner_context.flavor, oc.OWNER_CONTEXT_FLAVOR);
      assert.deepEqual(Object.keys(parsed.owner_context), [...oc.OWNER_CONTEXT_KEY_ORDER]);
      // Additive: the pre-existing init key is untouched.
      assert.equal(parsed.project_root, fs.realpathSync.native(tmp));
    } finally {
      cleanup(tmp);
    }
  });
});

describe('owner-context no-provider-call invariant', () => {
  test('the compiled module and its source contain no HTTP/agent/model surface', () => {
    for (const rel of ['gsd-core/bin/lib/owner-context.cjs', 'src/owner-context.cts']) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const needle of ["require('node:http')", 'require("node:http")', "require('node:https')", 'require("node:https")', 'http.request', 'https.request', 'fetch(']) {
        assert.equal(text.includes(needle), false, `${rel} must not reference ${needle}`);
      }
    }
  });
});

describe('owner-context additive record', () => {
  test('publishOwnerContext writes .planning/owner-context.json and never state.json', () => {
    const tmp = createTempDir();
    try {
      fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.planning', 'state.json'), JSON.stringify({ contract: '1.0.0' }));
      const before = fs.readFileSync(path.join(tmp, '.planning', 'state.json'), 'utf8');
      const result = oc.publishOwnerContext(tmp);
      assert.equal(result.published, true);
      const written = JSON.parse(fs.readFileSync(path.join(tmp, '.planning', 'owner-context.json'), 'utf8'));
      assert.equal(written.contract, oc.OWNER_CONTEXT_VERSION);
      assert.equal(fs.readFileSync(path.join(tmp, '.planning', 'state.json'), 'utf8'), before);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- E2E: phase complete enforce boundary -----------------------------------

function seedCompletablePhase(dir) {
  const p = path.join(dir, '.planning');
  fs.writeFileSync(path.join(p, 'STATE.md'), '---\nstatus: active\n---\n# State\n');
  fs.writeFileSync(path.join(p, 'ROADMAP.md'), [
    '# Roadmap', '', '## Progress', '',
    '- [ ] **Phase 1: Foo**', '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|-----------------|--------|-----------|',
    '| 1. Foo | 0/0 | Not started | - |', '',
    '### Phase 1: Foo', '', '**Goal:** Do the thing', '',
  ].join('\n'));
  const phaseDir = path.join(p, 'phases', '01-foo');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan 1\n');
  fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary 1\n');
  fs.writeFileSync(path.join(phaseDir, '01-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');
  return phaseDir;
}

function snapshotTree(root) {
  const out = {};
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  })(root);
  return out;
}

function completePhaseEnv(real, ctx, phaseDir, scopeOverride) {
  // realpath both ends: the CLI canonicalises cwd, so a scope/plan path built
  // from the un-canonicalised temp dir would point outside the resolved root.
  const realPhaseDir = fs.realpathSync.native(phaseDir);
  const workflow = { kind: 'phase', phase: '01', plan: path.relative(real, path.join(realPhaseDir, '01-01-PLAN.md')), parent_plan: null, rationale: null };
  const link = oc.linkFingerprint(ctx.planning, workflow, ctx.owner.root);
  // The planning root must be explicitly owned: the direct writer's targets
  // include `.planning/ROADMAP.md` / `.planning/STATE.md`, which live outside
  // the phase directory. `scopeOverride` lets a test prove the boundary.
  const scope = scopeOverride || path.relative(real, path.join(real, '.planning'));
  const scopeFp = oc.scopeFingerprint(ctx.owner.root, [scope]).fingerprint;
  return {
    env: {
      [oc.OWNER_DESCRIPTOR_ENV.TASK_ID]: 'phase-1',
      [oc.OWNER_DESCRIPTOR_ENV.REPO_ID]: ctx.owner.repo_id,
      [oc.OWNER_DESCRIPTOR_ENV.ROOT]: ctx.owner.root,
      [oc.OWNER_DESCRIPTOR_ENV.WORKFLOW]: 'phase',
      [oc.OWNER_DESCRIPTOR_ENV.PHASE]: '01',
      [oc.OWNER_DESCRIPTOR_ENV.PLAN]: workflow.plan,
      [oc.OWNER_DESCRIPTOR_ENV.WRITABLE_SCOPES]: scope,
      [oc.OWNER_DESCRIPTOR_ENV.PROVENANCE]: 'test',
      [oc.OWNER_DESCRIPTOR_ENV.EXPECT_HEAD]: ctx.owner.head,
      [oc.OWNER_DESCRIPTOR_ENV.EXPECT_FINGERPRINT]: ctx.fingerprint.planning,
      [oc.OWNER_DESCRIPTOR_ENV.EXPECT_LINK_FINGERPRINT]: link,
      [oc.OWNER_DESCRIPTOR_ENV.EXPECT_SCOPE_FINGERPRINT]: scopeFp,
    },
    descriptor: {
      task_id: 'phase-1',
      owner: { repo_id: ctx.owner.repo_id, root: ctx.owner.root },
      planning: { project: ctx.planning.project, workstream: ctx.planning.workstream },
      workflow,
      writable_scopes: [scope],
      expected: { head: ctx.owner.head, planning_fingerprint: ctx.fingerprint.planning, link_fingerprint: link, scope_fingerprint: scopeFp },
      provenance: 'test',
    },
  };
}

describe('owner-context phase complete enforce E2E', () => {
  test('refuses with NO WRITE, then succeeds with a fresh complete descriptor', () => {
    const tmp = createTempGitProject('gsd-oc-phasecomplete-');
    try {
      const real = fs.realpathSync.native(tmp);
      const phaseDir = seedCompletablePhase(tmp);
      const ctx = oc.buildOwnerContext(real, {});
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: ctx.owner.repo_id }] });

      // (a) No descriptor under enforce -> refused, and the planning tree is untouched.
      const before = snapshotTree(path.join(tmp, '.planning'));
      const refused = runGsdTools(['phase', 'complete', '1', '--raw', '--json-errors'], tmp);
      assert.equal(refused.success, false);
      assert.equal(jsonError(refused).reason, 'owner_context_refused');
      assert.deepEqual(snapshotTree(path.join(tmp, '.planning')), before, 'a refused phase complete must write nothing');

      // (b) A complete, fresh descriptor authorises the write.
      const { env } = completePhaseEnv(real, ctx, phaseDir);
      const ok = runGsdTools(['phase', 'complete', '1', '--raw', '--json-errors'], tmp, env);
      assert.ok(ok.success, `phase complete must succeed with a valid descriptor: ${ok.error}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('a descriptor whose writable scope EXCLUDES the planning root cannot authorize a planning write', () => {
    const tmp = createTempGitProject('gsd-oc-phasecomplete-');
    try {
      const real = fs.realpathSync.native(tmp);
      const phaseDir = seedCompletablePhase(tmp);
      const ctx = oc.buildOwnerContext(real, {});
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: ctx.owner.repo_id }] });
      // Owns only the phase directory, but `phase complete` writes
      // `.planning/ROADMAP.md` and `.planning/STATE.md` — outside that scope.
      const { env } = completePhaseEnv(real, ctx, phaseDir, path.relative(real, fs.realpathSync.native(phaseDir)));
      const before = snapshotTree(path.join(tmp, '.planning'));
      const refused = runGsdTools(['phase', 'complete', '1', '--raw', '--json-errors'], tmp, env);
      assert.equal(refused.success, false);
      assert.equal(jsonError(refused).reason, 'owner_context_refused');
      assert.match(refused.error, /outside the declared writable scopes/);
      assert.deepEqual(snapshotTree(path.join(tmp, '.planning')), before, 'a target-scope refusal must write nothing');
    } finally {
      cleanup(tmp);
    }
  });
});

// --- preflight + cross-form schema parity -----------------------------------

describe('owner-context preflight entry', () => {
  test('env form and descriptor-file form obey the SAME schema and verdict', () => {
    const tmp = createTempGitProject('gsd-oc-preflight-');
    try {
      const real = fs.realpathSync.native(tmp);
      const ctx = oc.buildOwnerContext(real, {});
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: ctx.owner.repo_id }] });
      const { env, descriptor } = completePhaseEnv(real, ctx, (() => {
        const p = path.join(tmp, '.planning', 'phases', '01-foo');
        fs.mkdirSync(p, { recursive: true });
        fs.writeFileSync(path.join(p, '01-01-PLAN.md'), '# Plan 1\n');
        return p;
      })());
      const envOutcome = oc.preflightOwnerContext(real, { env });
      // The file form carries the identical fields, reached through one path.
      const descriptorPath = path.join(tmp, 'descriptor.json');
      fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
      const fileOutcome = oc.preflightOwnerContext(real, { env: { [oc.OWNER_DESCRIPTOR_ENV.FILE]: descriptorPath } });
      assert.equal(envOutcome.ok, true, JSON.stringify(envOutcome));
      assert.deepEqual(fileOutcome, envOutcome, 'both descriptor forms must yield the same stable outcome');
    } finally {
      cleanup(tmp);
    }
  });

  test('preflight with no descriptor under enforce is not ok and never auto-authorises', () => {
    const tmp = createTempGitProject('gsd-oc-preflight-');
    try {
      const real = fs.realpathSync.native(tmp);
      const ctx = oc.buildOwnerContext(real, {});
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: ctx.owner.repo_id }] });
      const outcome = oc.preflightOwnerContext(real, { env: {} });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.enforcing, true);
      assert.equal(outcome.verdict, 'missing_owner_context');
      assert.equal(outcome.descriptor_present, false);
    } finally {
      cleanup(tmp);
    }
  });
});
