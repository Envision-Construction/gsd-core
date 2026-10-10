'use strict';

/**
 * Unit tests for src/owner-context.cts - the additive, versioned portfolio
 * ownership contract (v1) and its mandatory semantic gate.
 *
 * Spawn-free by design: git identity is injected through the module's own
 * execGit seam, so the linked-worktree / nested / symlink cases run without a
 * child process. The CLI / dispatch / direct-writer integration band lives in
 * the sibling tests/owner-context.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const oc = require('../gsd-core/bin/lib/owner-context.cjs');

const {
  OWNER_CONTEXT_VERSION,
  OWNER_CONTEXT_KEY_ORDER,
  OWNER_POLICY_MODE,
  OWNER_CONTEXT_VERDICT,
  OWNER_WORKFLOW_KIND,
  OWNER_POLICY_DEFAULT,
  OwnerContextRefusal,
} = oc;

// --- fixtures ---------------------------------------------------------------

function writeAbs(fullPath, content) {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function fakeGit(map) {
  return (args) => {
    const key = args.join(' ');
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    return { exitCode: 128, stdout: '' };
  };
}

const INSIDE = { exitCode: 0, stdout: 'true\n' };

function revParseLine(root, commonDir, gitDir, head, branch, prefix, exitCode = 0) {
  return {
    exitCode,
    stdout: [root, commonDir, gitDir, head, branch, prefix, ''].join('\n'),
  };
}

// A linked-worktree identity: toplevel is the worktree dir, common dir is the
// MAIN repo's .git.
function linkedWorktreeDeps() {
  return {
    execGit: fakeGit({
      'rev-parse --is-inside-work-tree': INSIDE,
      'rev-parse --show-toplevel --git-common-dir --git-dir HEAD --abbrev-ref HEAD --show-prefix': revParseLine(
        '/main/wt-feature', '/main/.git', '/main/.git/worktrees/wt-feature',
        'a'.repeat(40), 'feature/x', '',
      ),
      'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:Open-GSD/gsd-core.git\n' },
      'status --porcelain=v1 --untracked-files=normal': { exitCode: 0, stdout: '' },
    }),
  };
}

function mainWorktreeDeps(opts = {}) {
  const root = opts.root || '/main';
  return {
    execGit: fakeGit({
      'rev-parse --is-inside-work-tree': INSIDE,
      'rev-parse --show-toplevel --git-common-dir --git-dir HEAD --abbrev-ref HEAD --show-prefix': revParseLine(
        root, path.join(root, '.git'), path.join(root, '.git'),
        'b'.repeat(40), 'main', opts.prefix || '',
      ),
      'remote get-url origin': { exitCode: 0, stdout: opts.remote || 'https://github.com/Open-GSD/gsd-core.git\n' },
      'status --porcelain=v1 --untracked-files=normal': { exitCode: 0, stdout: opts.status || '' },
    }),
  };
}

// A policy file written into <cwd>/.planning/owner-policy.json
function writePolicy(cwd, policy) {
  writeAbs(path.join(cwd, '.planning', 'owner-policy.json'), JSON.stringify(policy, null, 2));
}

// --- identity ---------------------------------------------------------------

describe('owner-context identity', () => {
  test('contract version and key order are frozen', () => {
    assert.equal(OWNER_CONTEXT_VERSION, '1.0.0');
    assert.deepEqual([...OWNER_CONTEXT_KEY_ORDER], ['contract', 'flavor', 'task_id', 'owner', 'planning', 'workflow', 'policy', 'fingerprint', 'generated_at']);
  });

  test('canonicalRepoId normalizes ssh, scp and https spellings to one id', () => {
    const expected = 'github.com/open-gsd/gsd-core';
    assert.equal(oc.canonicalRepoId('git@github.com:Open-GSD/gsd-core.git'), expected);
    assert.equal(oc.canonicalRepoId('https://github.com/Open-GSD/gsd-core.git'), expected);
    assert.equal(oc.canonicalRepoId('ssh://git@github.com/Open-GSD/gsd-core'), expected);
    assert.equal(oc.canonicalRepoId('  '), null);
    assert.equal(oc.canonicalRepoId(null), null);
  });

  test('a non-git directory degrades to inside:false without throwing', () => {
    const tmp = createTempDir();
    try {
      const id = oc.resolveRepoIdentity(tmp, { execGit: fakeGit({}) });
      assert.equal(id.inside, false);
      assert.equal(id.repo_id, null);
    } finally {
      cleanup(tmp);
    }
  });

  test('a linked worktree records the worktree root and the MAIN common dir', () => {
    const id = oc.resolveRepoIdentity('/main/wt-feature', linkedWorktreeDeps());
    assert.equal(id.inside, true);
    assert.equal(id.root, '/main/wt-feature');
    assert.equal(id.common_dir, '/main/.git');
    assert.equal(id.linked_worktree, true);
    assert.equal(id.repo_id, 'github.com/open-gsd/gsd-core');
  });

  test('a nested subdirectory is flagged nested with a resolved real_root', () => {
    const tmp = createTempDir();
    try {
      const nested = path.join(tmp, 'packages', 'app');
      fs.mkdirSync(nested, { recursive: true });
      // real git against the temp dir proves real_root resolves symlinks.
      const deps = mainWorktreeDeps({ root: tmp, prefix: 'packages/app/' });
      const id = oc.resolveRepoIdentity(nested, deps);
      assert.equal(id.nested, true);
      assert.equal(id.real_root, fs.realpathSync.native(tmp));
    } finally {
      cleanup(tmp);
    }
  });

  test('a symlinked cwd resolves real_root through the link', () => {
    const tmp = createTempDir();
    try {
      const real = path.join(tmp, 'real');
      const link = path.join(tmp, 'link');
      fs.mkdirSync(real, { recursive: true });
      fs.symlinkSync(real, link, 'dir');
      const id = oc.resolveRepoIdentity(link, mainWorktreeDeps({ root: real }));
      assert.equal(id.root, real);
      assert.equal(id.real_root, fs.realpathSync.native(real));
    } finally {
      cleanup(tmp);
    }
  });

  test('dirty files are captured from git status', () => {
    const deps = mainWorktreeDeps({ status: ' M src/a.cts\n?? scratch.txt\n' });
    const id = oc.resolveRepoIdentity('/main', deps);
    assert.deepEqual(id.dirty, ['M src/a.cts', '?? scratch.txt']);
    assert.equal(id.dirty_truncated, false);
  });
});

// --- planning scope ---------------------------------------------------------

describe('owner-context planning scope', () => {
  test('root scope when neither GSD_PROJECT nor GSD_WORKSTREAM is set', () => {
    const tmp = createTempDir();
    const prevP = process.env.GSD_PROJECT;
    const prevW = process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
    delete process.env.GSD_WORKSTREAM;
    try {
      const scope = oc.resolvePlanningScope(tmp);
      assert.equal(scope.mode, 'root');
      assert.equal(scope.root, path.join(tmp, '.planning'));
    } finally {
      if (prevP !== undefined) process.env.GSD_PROJECT = prevP;
      if (prevW !== undefined) process.env.GSD_WORKSTREAM = prevW;
      cleanup(tmp);
    }
  });

  test('project and workstream scopes resolve through the existing GSD resolver', () => {
    const tmp = createTempDir();
    const prevP = process.env.GSD_PROJECT;
    const prevW = process.env.GSD_WORKSTREAM;
    try {
      process.env.GSD_PROJECT = 'proj';
      const projectScope = oc.resolvePlanningScope(tmp);
      assert.equal(projectScope.mode, 'project');
      assert.equal(projectScope.root, path.join(tmp, '.planning', 'proj'));

      process.env.GSD_WORKSTREAM = 'ws';
      const wsScope = oc.resolvePlanningScope(tmp);
      assert.equal(wsScope.mode, 'workstream');
      assert.equal(wsScope.root, path.join(tmp, '.planning', 'proj', 'workstreams', 'ws'));
    } finally {
      if (prevP === undefined) delete process.env.GSD_PROJECT; else process.env.GSD_PROJECT = prevP;
      if (prevW === undefined) delete process.env.GSD_WORKSTREAM; else process.env.GSD_WORKSTREAM = prevW;
      cleanup(tmp);
    }
  });

  test('planningFingerprint is stable and changes when ROADMAP.md changes', () => {
    const tmp = createTempDir();
    try {
      writeAbs(path.join(tmp, '.planning', 'ROADMAP.md'), '# Roadmap\n');
      const scope = oc.resolvePlanningScope(tmp);
      const first = oc.planningFingerprint(scope);
      assert.equal(oc.planningFingerprint(scope), first, 'same input -> same fingerprint');
      writeAbs(path.join(tmp, '.planning', 'ROADMAP.md'), '# Roadmap\n\n- [x] Phase 1\n');
      assert.notEqual(oc.planningFingerprint(scope), first, 'changed ROADMAP.md -> changed fingerprint');
    } finally {
      cleanup(tmp);
    }
  });
});

// --- workflow ---------------------------------------------------------------

describe('owner-context workflow', () => {
  test('a missing/unknown kind resolves to unresolved, never a confident operational/quick', () => {
    assert.equal(oc.resolveWorkflow({}).kind, OWNER_WORKFLOW_KIND.UNRESOLVED);
    assert.equal(oc.resolveWorkflow({ kind: 'nonsense' }).kind, OWNER_WORKFLOW_KIND.UNRESOLVED);
    assert.equal(oc.resolveWorkflow({ kind: 'quick' }).kind, OWNER_WORKFLOW_KIND.UNRESOLVED);
  });

  test('resolveWorkflow never coerces non-string fields', () => {
    const d = oc.resolveWorkflow({ kind: 'operational', rationale: { note: 'x' }, phase: 42 });
    assert.equal(d.rationale, null, 'an object rationale must not become "[object Object]"');
    assert.equal(d.phase, null, 'a numeric phase must not be coerced to a string');
  });

  test('explicit kinds are preserved with their linkage fields', () => {
    const d = oc.resolveWorkflow({ kind: 'linked-quick', parentPlan: '.planning/phases/01/01-01-PLAN.md', rationale: 'why' });
    assert.equal(d.kind, OWNER_WORKFLOW_KIND.LINKED_QUICK);
    assert.equal(d.parent_plan, '.planning/phases/01/01-01-PLAN.md');
    assert.equal(d.rationale, 'why');
  });
});

// --- policy -----------------------------------------------------------------

describe('owner-context policy', () => {
  test('an absent policy file is the audit default and ok', () => {
    const tmp = createTempDir();
    try {
      const load = oc.loadOwnerPolicy(tmp);
      assert.equal(load.present, false);
      assert.equal(load.ok, true);
      assert.equal(load.policy.mode, OWNER_POLICY_MODE.AUDIT);
    } finally {
      cleanup(tmp);
    }
  });

  test('a present malformed policy is fail-closed (present invalid never decays to audit)', () => {
    const tmp = createTempDir();
    try {
      writeAbs(path.join(tmp, '.planning', 'owner-policy.json'), '{ not json');
      const load = oc.loadOwnerPolicy(tmp);
      assert.equal(load.present, true);
      assert.equal(load.ok, false);
      assert.equal(load.requested_enforce, true, 'a present invalid policy must fail closed');
      assert.equal(load.policy.mode, OWNER_POLICY_MODE.AUDIT);
      // Policy ownership resolves against the worktree root the identity
      // reports, so the fake root must match the cwd the policy was written
      // under (review 2026-10-10: nested-cwd policy fallback fix).
      const gate = oc.ownerContextGate(tmp, { deps: mainWorktreeDeps({ root: tmp }) });
      assert.equal(gate.verdict, OWNER_CONTEXT_VERDICT.INVALID_POLICY);
      assert.equal(gate.enforcing, true, 'a broken present policy enforces (fails closed)');
      assert.throws(() => oc.assertOwnerContextForWrite(tmp, { deps: mainWorktreeDeps({ root: tmp }) }), OwnerContextRefusal);
    } finally {
      cleanup(tmp);
    }
  });

  test('a genuinely ABSENT default policy preserves audit (ok, non-blocking)', () => {
    const tmp = createTempDir();
    try {
      const load = oc.loadOwnerPolicy(tmp);
      assert.equal(load.present, false);
      assert.equal(load.ok, true);
      assert.equal(load.requested_enforce, false);
      const gate = oc.ownerContextGate(tmp, { deps: mainWorktreeDeps({ root: tmp }) });
      assert.equal(gate.enforcing, false);
      assert.doesNotThrow(() => oc.assertOwnerContextForWrite(tmp, { deps: mainWorktreeDeps({ root: tmp }) }));
    } finally {
      cleanup(tmp);
    }
  });

  test('a TRUNCATED enforce policy body still fails closed', () => {
    const tmp = createTempDir();
    try {
      // An operator began an enforce policy and the file was cut off mid-write.
      // It must not read as audit just because the JSON does not parse.
      writeAbs(path.join(tmp, '.planning', 'owner-policy.json'),
        '{\n  "policy_version": "1.0.0",\n  "mode": "enforce",\n  "known_owners": [{ "repo_id": "local:x" }');
      const load = oc.loadOwnerPolicy(tmp);
      assert.equal(load.present, true);
      assert.equal(load.ok, false);
      assert.equal(load.requested_enforce, true, 'a truncated enforce body must not decay to audit');
      const gate = oc.ownerContextGate(tmp, { deps: mainWorktreeDeps({ root: tmp }) });
      assert.equal(gate.enforcing, true);
      assert.equal(gate.verdict, OWNER_CONTEXT_VERDICT.INVALID_POLICY);
    } finally {
      cleanup(tmp);
    }
  });

  test('an unknown policy key or bad mode is rejected as invalid', () => {
    const tmp = createTempDir();
    try {
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', bogus_key: true });
      const load = oc.loadOwnerPolicy(tmp);
      assert.equal(load.ok, false);
      assert.match(load.reasons.join(' '), /unknown policy key: bogus_key/);

      writePolicy(tmp, { policy_version: '1.0.0', mode: 'nope' });
      assert.equal(oc.loadOwnerPolicy(tmp).ok, false);
    } finally {
      cleanup(tmp);
    }
  });

  test('a policy path outside the project root is untrusted', () => {
    const tmp = createTempDir();
    try {
      const outside = path.join(path.dirname(tmp), 'elsewhere-policy.json');
      const resolved = oc.resolveOwnerPolicyPath(tmp, outside);
      assert.equal(resolved.trusted, false);
      const load = oc.loadOwnerPolicy(tmp, { policyPath: outside });
      assert.equal(load.ok, false);
      assert.equal(load.explicit, true);
      assert.equal(load.requested_enforce, true, 'an explicitly requested escaping path fails closed');
    } finally {
      cleanup(tmp);
    }
  });

  test('a present but UNREADABLE policy fails closed', () => {
    const tmp = createTempDir();
    try {
      // A directory where the policy file is expected: existsSync() is true but
      // readFileSync throws EISDIR. The mode is unknowable, so it must block.
      fs.mkdirSync(path.join(tmp, '.planning', 'owner-policy.json'), { recursive: true });
      const load = oc.loadOwnerPolicy(tmp);
      assert.equal(load.present, true);
      assert.equal(load.ok, false);
      assert.equal(load.requested_enforce, true);
      const gate = oc.ownerContextGate(tmp, { deps: mainWorktreeDeps({ root: tmp }) });
      assert.equal(gate.enforcing, true);
      assert.equal(gate.verdict, OWNER_CONTEXT_VERDICT.INVALID_POLICY);
    } finally {
      cleanup(tmp);
    }
  });

  test('a valid enforce policy is trusted and loads', () => {
    const tmp = createTempDir();
    try {
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'local:tmp' }] });
      const load = oc.loadOwnerPolicy(tmp);
      assert.equal(load.ok, true);
      assert.equal(load.policy.mode, OWNER_POLICY_MODE.ENFORCE);
      assert.deepEqual(load.policy.known_owners, [{ repo_id: 'local:tmp' }]);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- semantic validation + gate ---------------------------------------------

function contextFor(overrides = {}) {
  const base = oc.buildOwnerContext('/main', { deps: mainWorktreeDeps() });
  return {
    ...base,
    ...overrides,
    owner: { ...base.owner, ...(overrides.owner || {}) },
    fingerprint: { ...base.fingerprint, ...(overrides.fingerprint || {}) },
    // A resolved (not `unresolved`) workflow with an affirmative rationale, so
    // the semantic core validates identity without needing a descriptor.
    workflow: { ...base.workflow, kind: OWNER_WORKFLOW_KIND.OPERATIONAL, rationale: 'fixture', ...(overrides.workflow || {}) },
  };
}

describe('owner-context semantic validation', () => {
  test('resolved identity with default policy validates ok', () => {
    const verdict = oc.validateOwnerContext(contextFor());
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.OK);
  });

  test('a repo outside known_owners is wrong_owner', () => {
    const ctx = contextFor();
    const policy = { ...OWNER_POLICY_DEFAULT, known_owners: [{ repo_id: 'github.com/example/other' }] };
    const verdict = oc.validateOwnerContext(ctx, { policy });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.WRONG_OWNER);
  });

  test('an unresolved identity is unresolved_identity', () => {
    const ctx = contextFor({ owner: { inside: false, root: null, head: null } });
    assert.equal(oc.validateOwnerContext(ctx).verdict, OWNER_CONTEXT_VERDICT.UNRESOLVED);
  });

  test('a moved HEAD or changed planning fingerprint is stale_context', () => {
    const ctx = contextFor();
    const staleHead = oc.validateOwnerContext(ctx, { expected: { head: 'c'.repeat(40) } });
    assert.equal(staleHead.verdict, OWNER_CONTEXT_VERDICT.STALE);

    const stalePlanning = oc.validateOwnerContext(ctx, { expected: { planning_fingerprint: 'deadbeef' } });
    assert.equal(stalePlanning.verdict, OWNER_CONTEXT_VERDICT.STALE);
  });

  test('an expected-clean but dirty worktree is stale_context', () => {
    const ctx = contextFor({ fingerprint: { dirty: ['M src/a.cts'] } });
    const verdict = oc.validateOwnerContext(ctx, { expected: { dirty: false } });
    assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.STALE);
  });

  test('a standalone quick without a rationale is missing_owner_context', () => {
    const ctx = contextFor({ workflow: { kind: OWNER_WORKFLOW_KIND.STANDALONE_QUICK, rationale: null } });
    const verdict = oc.validateOwnerContext(ctx);
    assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.MISSING);
  });

  test('a standalone quick WITH a rationale validates ok', () => {
    const ctx = contextFor({ workflow: { kind: OWNER_WORKFLOW_KIND.STANDALONE_QUICK, rationale: 'one-off repair' } });
    assert.equal(oc.validateOwnerContext(ctx).ok, true);
  });
});

describe('owner-context gate + direct-writer assertion', () => {
  // A COMPLETE descriptor pinning the current resolved context: worktree root +
  // identity, planning binding, task id, provenance, and the expected snapshot
  // including the referenced phase-plan link fingerprint. Seeded with a real
  // plan file so the enforce link resolution succeeds.
  const PLAN_REL = '.planning/phases/01-widgets/01-01-PLAN.md';
  const SCOPE_REL = 'src/widgets.ts';
  function descriptorFor(cwd, deps, overrides = {}) {
    writeAbs(path.join(cwd, PLAN_REL), '# Plan 01\n');
    writeAbs(path.join(cwd, SCOPE_REL), 'export const widget = 1;\n');
    const ctx = oc.buildOwnerContext(cwd, { deps });
    const workflow = { kind: 'phase', phase: '01', plan: PLAN_REL, parent_plan: null, rationale: null };
    const link_fingerprint = oc.linkFingerprint(ctx.planning, workflow, ctx.owner.root);
    const scope = oc.scopeFingerprint(ctx.owner.root, [SCOPE_REL]);
    const base = {
      task_id: 't-1',
      owner: { repo_id: ctx.owner.repo_id, root: ctx.owner.root },
      planning: { project: ctx.planning.project, workstream: ctx.planning.workstream },
      workflow,
      writable_scopes: [SCOPE_REL],
      expected: { head: ctx.owner.head, planning_fingerprint: ctx.fingerprint.planning, link_fingerprint, scope_fingerprint: scope.fingerprint },
      provenance: 'test-fixture',
    };
    return {
      ...base,
      ...overrides,
      owner: { ...base.owner, ...(overrides.owner || {}) },
      planning: overrides.planning !== undefined ? overrides.planning : base.planning,
      writable_scopes: overrides.writable_scopes !== undefined ? overrides.writable_scopes : base.writable_scopes,
      expected: { ...base.expected, ...(overrides.expected || {}) },
      workflow: { ...base.workflow, ...(overrides.workflow || {}) },
    };
  }

  test('audit (no policy) never refuses', () => {
    const tmp = createTempDir();
    try {
      const gate = oc.ownerContextGate(tmp, { deps: { execGit: () => ({ exitCode: 1, stdout: '' }) } });
      assert.equal(gate.enforcing, false);
      assert.doesNotThrow(() => oc.assertOwnerContextForWrite(tmp, { deps: { execGit: () => ({ exitCode: 1, stdout: '' }) } }));
    } finally {
      cleanup(tmp);
    }
  });

  test('enforce WITHOUT a descriptor is missing_owner_context and refuses (no self-authorisation)', () => {
    const tmp = createTempDir();
    try {
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'github.com/open-gsd/gsd-core' }] });
      const deps = mainWorktreeDeps({ root: tmp });
      const gate = oc.ownerContextGate(tmp, { deps });
      assert.equal(gate.enforcing, true);
      assert.equal(gate.ok, false);
      assert.equal(gate.verdict, OWNER_CONTEXT_VERDICT.MISSING);
      assert.throws(() => oc.assertOwnerContextForWrite(tmp, { deps }), (err) => err instanceof OwnerContextRefusal && err.verdict === OWNER_CONTEXT_VERDICT.MISSING);
    } finally {
      cleanup(tmp);
    }
  });

  test('enforce + descriptor pinning a DIFFERENT owner is wrong_owner (task names another repo)', () => {
    const tmp = createTempDir();
    try {
      const deps = mainWorktreeDeps({ root: tmp });
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'github.com/open-gsd/gsd-core' }, { repo_id: 'github.com/example/other' }] });
      const descriptor = descriptorFor(tmp, deps, { owner: { repo_id: 'github.com/example/other' } });
      const gate = oc.ownerContextGate(tmp, { deps, descriptor });
      assert.equal(gate.enforcing, true);
      assert.equal(gate.verdict, OWNER_CONTEXT_VERDICT.WRONG_OWNER);
      assert.throws(() => oc.assertOwnerContextForWrite(tmp, { deps, descriptor }), (err) => err instanceof OwnerContextRefusal && err.verdict === OWNER_CONTEXT_VERDICT.WRONG_OWNER);
    } finally {
      cleanup(tmp);
    }
  });

  test('enforce + matching descriptor allows the write', () => {
    const tmp = createTempDir();
    try {
      const deps = mainWorktreeDeps({ root: tmp, remote: 'https://github.com/Envision-Construction/gsd-core.git' });
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ remote: 'git@github.com:Envision-Construction/gsd-core.git' }] });
      const descriptor = descriptorFor(tmp, deps);
      const gate = oc.ownerContextGate(tmp, { deps, descriptor });
      assert.equal(gate.enforcing, true);
      assert.equal(gate.ok, true);
      assert.doesNotThrow(() => oc.assertOwnerContextForWrite(tmp, { deps, descriptor }));
    } finally {
      cleanup(tmp);
    }
  });

  test('enforce + matching owner but a stale expected snapshot is stale_context', () => {
    const tmp = createTempDir();
    try {
      const deps = mainWorktreeDeps({ root: tmp });
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'github.com/open-gsd/gsd-core' }] });
      const descriptor = descriptorFor(tmp, deps, { expected: { head: 'c'.repeat(40), planning_fingerprint: 'deadbeef' } });
      const gate = oc.ownerContextGate(tmp, { deps, descriptor });
      assert.equal(gate.verdict, OWNER_CONTEXT_VERDICT.STALE);
      assert.throws(() => oc.assertOwnerContextForWrite(tmp, { deps, descriptor }), OwnerContextRefusal);
    } finally {
      cleanup(tmp);
    }
  });

  test('allow_dirty:false refuses a dirty worktree in enforce mode', () => {
    const tmp = createTempDir();
    try {
      const deps = mainWorktreeDeps({ root: tmp, status: ' M src/a.cts\n' });
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'github.com/open-gsd/gsd-core' }], allow_dirty: false });
      const descriptor = descriptorFor(tmp, deps);
      const gate = oc.ownerContextGate(tmp, { deps, descriptor });
      assert.equal(gate.verdict, OWNER_CONTEXT_VERDICT.STALE);
      assert.throws(() => oc.assertOwnerContextForWrite(tmp, { deps, descriptor }), OwnerContextRefusal);
    } finally {
      cleanup(tmp);
    }
  });

  test('a malformed policy that DECLARES enforce is fail-closed (never decays to audit)', () => {
    const tmp = createTempDir();
    try {
      // mode:enforce is present and valid, but the unknown key makes the whole
      // file schema-invalid. It must NOT silently fall back to audit.
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'github.com/open-gsd/gsd-core' }], bogus_key: true });
      const deps = mainWorktreeDeps({ root: tmp });
      const load = oc.loadOwnerPolicy(tmp);
      assert.equal(load.ok, false);
      assert.equal(load.requested_enforce, true);
      const gate = oc.ownerContextGate(tmp, { deps });
      assert.equal(gate.enforcing, true, 'a broken enforce policy still enforces');
      assert.equal(gate.verdict, OWNER_CONTEXT_VERDICT.INVALID_POLICY);
      assert.throws(() => oc.assertOwnerContextForWrite(tmp, { deps }), (err) => err instanceof OwnerContextRefusal && err.verdict === OWNER_CONTEXT_VERDICT.INVALID_POLICY);
    } finally {
      cleanup(tmp);
    }
  });

  test('enforce with an EMPTY known_owners registry is invalid, not allow-all (never silently quick)', () => {
    const tmp = createTempDir();
    try {
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [] });
      const deps = mainWorktreeDeps({ root: tmp });
      const load = oc.loadOwnerPolicy(tmp);
      assert.equal(load.ok, false);
      assert.match(load.reasons.join(' '), /non-empty known_owners/);
      const descriptor = descriptorFor(tmp, deps);
      const gate = oc.ownerContextGate(tmp, { deps, descriptor });
      assert.equal(gate.enforcing, true);
      assert.equal(gate.verdict, OWNER_CONTEXT_VERDICT.INVALID_POLICY);
      assert.throws(() => oc.assertOwnerContextForWrite(tmp, { deps, descriptor }), OwnerContextRefusal);
    } finally {
      cleanup(tmp);
    }
  });
});

// --- task descriptor + mutating classification ------------------------------

describe('owner-context task descriptor', () => {
  test('a form with no explicit workflow kind is invalid and reports unresolved (no silent operational)', () => {
    const parsed = oc.parseTaskDescriptor({ owner: { repo_id: 'x' }, expected: { head: 'a'.repeat(40) } });
    assert.equal(parsed.descriptor.workflow.kind, OWNER_WORKFLOW_KIND.UNRESOLVED, 'no confident operational fallback');
    assert.match(parsed.reasons.join(' '), /workflow is required/);
    assert.match(parsed.reasons.join(' '), /explicit workflow kind/);
  });

  test('strict schema rejects unknown keys and wrong types without coercing', () => {
    const parsed = oc.parseTaskDescriptor({
      task_id: 't',
      owner: { repo_id: 'x', unknown_owner_key: 'y' },
      planning: { project: 42, workstream: 'ws', extra: true },
      workflow: { kind: 'operational', rationale: { note: 'x' } },
      writable_scopes: [42],
      expected: { head: 'a'.repeat(40), dirty: 'yes' },
      unknown_authority: 'nope',
    });
    const reasons = parsed.reasons.join(' | ');
    assert.match(reasons, /unknown descriptor key: unknown_authority/);
    assert.match(reasons, /unknown owner key: unknown_owner_key/);
    assert.match(reasons, /unknown planning key: extra/);
    assert.match(reasons, /planning\.project must be a string or null/);
    assert.match(reasons, /workflow\.rationale must be a string or null/);
    assert.match(reasons, /descriptor\.writable_scopes must be an array of non-empty strings/);
    assert.match(reasons, /expected\.dirty must be a boolean/);
    assert.equal(parsed.descriptor.planning.project, null, 'no numeric coercion');
    assert.equal(parsed.descriptor.workflow.rationale, null, 'no object coercion');
  });

  test('unknown keys inside workflow/expected are rejected', () => {
    const parsed = oc.parseTaskDescriptor({
      workflow: { kind: 'operational', rationale: 'ok', workflow_kind: 'phase' },
      expected: { head: 'a'.repeat(40), plan_fingerprint: 'x' },
    });
    assert.match(parsed.reasons.join(' '), /unknown workflow key: workflow_kind/);
    assert.match(parsed.reasons.join(' '), /unknown expected key: plan_fingerprint/);
  });

  test('the published env contract round-trips into a descriptor', () => {
    const env = {
      [oc.OWNER_DESCRIPTOR_ENV.TASK_ID]: 'task-9',
      [oc.OWNER_DESCRIPTOR_ENV.REPO_ID]: 'github.com/open-gsd/gsd-core',
      [oc.OWNER_DESCRIPTOR_ENV.WORKFLOW]: 'phase',
      [oc.OWNER_DESCRIPTOR_ENV.PHASE]: '07',
      [oc.OWNER_DESCRIPTOR_ENV.EXPECT_HEAD]: 'd'.repeat(40),
      [oc.OWNER_DESCRIPTOR_ENV.EXPECT_FINGERPRINT]: 'f'.repeat(32),
      [oc.OWNER_DESCRIPTOR_ENV.WRITABLE_SCOPES]: 'src/a,src/b',
    };
    const tmp = createTempDir();
    try {
      const load = oc.loadTaskDescriptor(tmp, { env });
      assert.equal(load.present, true);
      assert.equal(load.valid, true);
      assert.equal(load.descriptor.task_id, 'task-9');
      assert.equal(load.descriptor.workflow.kind, OWNER_WORKFLOW_KIND.PHASE);
      assert.equal(load.descriptor.workflow.phase, '07');
      assert.deepEqual(load.descriptor.writable_scopes, ['src/a', 'src/b']);
      assert.equal(load.descriptor.expected.head, 'd'.repeat(40));
    } finally {
      cleanup(tmp);
    }
  });

  test('descriptor file path outside the project root is rejected', () => {
    const tmp = createTempDir();
    try {
      const outside = path.join(path.dirname(tmp), 'other-descriptor.json');
      const load = oc.loadTaskDescriptor(tmp, { env: { [oc.OWNER_DESCRIPTOR_ENV.FILE]: outside } });
      assert.equal(load.valid, false);
      assert.match(load.reasons.join(' '), /escapes the project root/);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('owner-context mutating classification', () => {
  test('quick-tasks writers and the confirmed family writers are classified mutating', () => {
    assert.equal(oc.isMutatingCommand('quick-tasks-append', ['quick-tasks-append', '--task', 'x']), true);
    assert.equal(oc.isMutatingCommand('quick-tasks-migrate', ['quick-tasks-migrate']), true);
    assert.equal(oc.isMutatingCommand('phases', ['phases', 'clear']), true);
    assert.equal(oc.isMutatingCommand('phase', ['phase', 'add-batch']), true);
    assert.equal(oc.isMutatingCommand('workstream', ['workstream', 'complete']), true);
    assert.equal(oc.isMutatingCommand('commit', ['commit']), true);
  });

  test('read-only subcommands of a classified family stay non-mutating', () => {
    assert.equal(oc.isMutatingCommand('state', ['state', 'load']), false);
    assert.equal(oc.isMutatingCommand('phase', ['phase', 'list-plans']), false);
    assert.equal(oc.isMutatingCommand('phases', ['phases', 'list']), false);
    assert.equal(oc.isMutatingCommand('requirements', ['requirements', 'ready-ids']), false);
    assert.equal(oc.isMutatingCommand('init', ['init', 'quick']), false);
  });
});

// --- enforce hardening (root acceptance gaps 1,2,4,5) ----------------------

describe('owner-context enforce hardening', () => {
  const PLAN = '.planning/phases/01/01-01-PLAN.md';
  const SCOPE = 'src';

  function scenario() {
    const tmp = createTempDir();
    writeAbs(path.join(tmp, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    writeAbs(path.join(tmp, PLAN), '# Plan\n');
    writeAbs(path.join(tmp, 'src', 'module.ts'), 'export const a = 1;\n');
    const deps = mainWorktreeDeps({ root: tmp });
    const workflow = { kind: 'phase', phase: '01', plan: PLAN, parent_plan: null, rationale: null };
    // Build the context WITH the workflow so its link fingerprint is populated,
    // exactly as the gate builds it from the descriptor.
    const ctx = oc.buildOwnerContext(tmp, { deps, kind: 'phase', phase: '01', plan: PLAN });
    const link = ctx.fingerprint.link;
    const scope = oc.scopeFingerprint(ctx.owner.root, [SCOPE]);
    const policy = { ...OWNER_POLICY_DEFAULT, mode: 'enforce', known_owners: [{ repo_id: ctx.owner.repo_id }] };
    const complete = {
      task_id: 't-1',
      owner: { repo_id: ctx.owner.repo_id, root: ctx.owner.root },
      planning: { project: ctx.planning.project, workstream: ctx.planning.workstream },
      workflow,
      writable_scopes: [SCOPE],
      expected: { head: ctx.owner.head, planning_fingerprint: ctx.fingerprint.planning, link_fingerprint: link, scope_fingerprint: scope.fingerprint },
      provenance: 'test',
    };
    return { tmp, deps, ctx, policy, complete, link };
  }

  const OMISSIONS = [
    ['task_id', (d) => { d.task_id = null; }],
    ['owner (whole)', (d) => { d.owner = null; }],
    ['owner.root (worktree root binding)', (d) => { d.owner = { repo_id: d.owner.repo_id }; }],
    ['owner identity (repo_id/remote)', (d) => { d.owner = { root: d.owner.root }; }],
    ['planning scope binding', (d) => { d.planning = null; }],
    ['writable scopes', (d) => { d.writable_scopes = []; }],
    ['expected.head', (d) => { d.expected.head = null; }],
    ['expected.planning_fingerprint', (d) => { d.expected.planning_fingerprint = null; }],
    ['expected.link_fingerprint', (d) => { d.expected.link_fingerprint = null; }],
    ['expected.scope_fingerprint', (d) => { d.expected.scope_fingerprint = null; }],
    ['provenance', (d) => { d.provenance = null; }],
  ];

  for (const [label, mutate] of OMISSIONS) {
    test('enforce refuses a descriptor with no ' + label, () => {
      const s = scenario();
      try {
        const descriptor = JSON.parse(JSON.stringify(s.complete));
        mutate(descriptor);
        const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor, requireDescriptor: true });
        assert.equal(verdict.ok, false, label);
        assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.MISSING, label);
        assert.ok(verdict.reasons.length > 0, label);
      } finally {
        cleanup(s.tmp);
      }
    });
  }

  test('a conflicting descriptor owner (repo_id matches, root differs) is refused, not accepted on one field', () => {
    const s = scenario();
    try {
      const descriptor = JSON.parse(JSON.stringify(s.complete));
      descriptor.owner = { repo_id: s.ctx.owner.repo_id, root: path.resolve(s.tmp, '..') };
      const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.WRONG_OWNER);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('a conflicting POLICY entry (repo_id matches, root differs) does not broaden authorization', () => {
    const s = scenario();
    try {
      const policy = { ...s.policy, known_owners: [{ repo_id: s.ctx.owner.repo_id, root: path.resolve(s.tmp, '..') }] };
      const verdict = oc.validateOwnerContext(s.ctx, { policy, descriptor: s.complete, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.WRONG_OWNER);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('a non-existent workflow link refuses', () => {
    const s = scenario();
    try {
      const descriptor = JSON.parse(JSON.stringify(s.complete));
      descriptor.workflow.plan = '.planning/phases/99/99-99-PLAN.md';
      descriptor.expected.link_fingerprint = 'anything';
      const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.MISSING);
      assert.match(verdict.reasons.join(' '), /does not exist/);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('an absolute workflow link that escapes the scope refuses', () => {
    const s = scenario();
    try {
      const descriptor = JSON.parse(JSON.stringify(s.complete));
      descriptor.workflow.plan = path.join(s.tmp, '..', 'escape-PLAN.md');
      descriptor.expected.link_fingerprint = 'anything';
      const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.MISSING);
      assert.match(verdict.reasons.join(' '), /escapes/);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('a sibling workflow link (outside the planning scope) refuses', () => {
    const s = scenario();
    try {
      const descriptor = JSON.parse(JSON.stringify(s.complete));
      descriptor.workflow.plan = 'sibling-PLAN.md'; // resolves beside .planning/, not inside it
      descriptor.expected.link_fingerprint = 'anything';
      const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.MISSING);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('a changed referenced-plan fingerprint is stale', () => {
    const s = scenario();
    try {
      const descriptor = JSON.parse(JSON.stringify(s.complete));
      descriptor.expected.link_fingerprint = 'deadbeefdeadbeefdeadbeef';
      const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.STALE);
      assert.match(verdict.reasons.join(' '), /link fingerprint changed/);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('dirty-snapshot mismatch is meaningful in BOTH directions', () => {
    const clean = scenario();
    const dirty = scenario();
    try {
      const dClean = JSON.parse(JSON.stringify(clean.complete));
      dClean.expected.dirty = true; // claim dirty, but the worktree is clean
      const vClean = oc.validateOwnerContext(clean.ctx, { policy: clean.policy, descriptor: dClean, requireDescriptor: true });
      assert.equal(vClean.verdict, OWNER_CONTEXT_VERDICT.STALE);
      assert.match(vClean.reasons.join(' '), /dirty snapshot mismatch: expected dirty=true/);

      const dDirty = JSON.parse(JSON.stringify(dirty.complete));
      dDirty.expected.dirty = false; // claim clean, but the worktree has changes
      const dirtyCtx = { ...dirty.ctx, fingerprint: { ...dirty.ctx.fingerprint, dirty: ['M src/a.cts'] } };
      const vDirty = oc.validateOwnerContext(dirtyCtx, { policy: dirty.policy, descriptor: dDirty, requireDescriptor: true });
      assert.equal(vDirty.verdict, OWNER_CONTEXT_VERDICT.STALE);
      assert.match(vDirty.reasons.join(' '), /dirty snapshot mismatch: expected dirty=false/);
    } finally {
      cleanup(clean.tmp);
      cleanup(dirty.tmp);
    }
  });

  test('require_owner_for_mutation:false does NOT disable enforce', () => {
    const tmp = createTempDir();
    try {
      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'local:whatever' }], require_owner_for_mutation: false });
      const deps = mainWorktreeDeps({ root: tmp });
      const gate = oc.ownerContextGate(tmp, { deps });
      assert.equal(gate.enforcing, true);
      assert.equal(gate.ok, false);
      assert.throws(() => oc.assertOwnerContextForWrite(tmp, { deps }), OwnerContextRefusal);
    } finally {
      cleanup(tmp);
    }
  });

  test('a valid complete descriptor passes the semantic core', () => {
    const s = scenario();
    try {
      const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor: s.complete, requireDescriptor: true });
      assert.equal(verdict.ok, true, verdict.reasons.join('; '));
    } finally {
      cleanup(s.tmp);
    }
  });

  test('an edit to an ALREADY-dirty tracked file is stale (same HEAD/status)', () => {
    const s = scenario();
    try {
      // Pretend the file was already dirty before this run: git status is
      // unchanged by a further edit, but the content fingerprint must move.
      const dirtyCtx = { ...s.ctx, fingerprint: { ...s.ctx.fingerprint, dirty: ['M src/module.ts'] } };
      writeAbs(path.join(s.tmp, 'src', 'module.ts'), 'export const a = 2; // edited\n');
      const verdict = oc.validateOwnerContext(dirtyCtx, { policy: s.policy, descriptor: s.complete, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.STALE);
      assert.match(verdict.reasons.join(' '), /scope fingerprint mismatch/);
      assert.equal(fs.readFileSync(path.join(s.tmp, 'src', 'module.ts'), 'utf8'), 'export const a = 2; // edited\n', 'validate must not mutate the scope');
    } finally {
      cleanup(s.tmp);
    }
  });

  test('a new UNTRACKED file inside the scope is stale', () => {
    const s = scenario();
    try {
      writeAbs(path.join(s.tmp, 'src', 'untracked-new.ts'), 'export const b = 1;\n');
      const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor: s.complete, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.STALE);
      assert.match(verdict.reasons.join(' '), /scope fingerprint mismatch/);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('a scope that was ABSENT and then appears is stale', () => {
    const s = scenario();
    try {
      const absentScope = path.join(s.tmp, 'src', 'future.ts');
      const descriptor = JSON.parse(JSON.stringify(s.complete));
      descriptor.writable_scopes = ['src/future.ts'];
      descriptor.expected.scope_fingerprint = oc.scopeFingerprint(s.ctx.owner.root, ['src/future.ts']).fingerprint;
      writeAbs(absentScope, 'export const future = true;\n');
      const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.STALE);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('a writable scope that escapes the worktree refuses', () => {
    const s = scenario();
    try {
      const descriptor = JSON.parse(JSON.stringify(s.complete));
      descriptor.writable_scopes = ['../outside-scope'];
      const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.MISSING);
      assert.match(verdict.reasons.join(' '), /escapes the worktree root/);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('a symlinked writable scope that escapes the worktree refuses', () => {
    const s = scenario();
    try {
      fs.symlinkSync(path.resolve(s.tmp, '..'), path.join(s.tmp, 'escape-link'), 'dir');
      const descriptor = JSON.parse(JSON.stringify(s.complete));
      descriptor.writable_scopes = ['escape-link'];
      const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.MISSING);
      assert.match(verdict.reasons.join(' '), /symlink|resolves outside the worktree root/);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('a DIRECTORY plan artifact refuses', () => {
    const s = scenario();
    try {
      const descriptor = JSON.parse(JSON.stringify(s.complete));
      descriptor.workflow.plan = '.planning/phases/01'; // a directory, not a plan file
      descriptor.expected.link_fingerprint = 'anything';
      const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.MISSING);
      assert.match(verdict.reasons.join(' '), /not a readable phase\/plan artifact/);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('a phase plan outside the declared phase directory refuses', () => {
    const s = scenario();
    try {
      writeAbs(path.join(s.tmp, '.planning', 'phases', '02-other', '02-01-PLAN.md'), '# Other plan\n');
      const descriptor = JSON.parse(JSON.stringify(s.complete));
      descriptor.workflow.plan = '.planning/phases/02-other/02-01-PLAN.md';
      descriptor.expected.link_fingerprint = 'anything';
      const verdict = oc.validateOwnerContext(s.ctx, { policy: s.policy, descriptor, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.MISSING);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('an OPERATIONAL workflow without a rationale refuses regardless of require_workflow_link', () => {
    const s = scenario();
    try {
      const policy = { ...s.policy, require_workflow_link: false };
      const descriptor = JSON.parse(JSON.stringify(s.complete));
      descriptor.workflow = { kind: 'operational', phase: null, plan: null, parent_plan: null, rationale: null };
      const verdict = oc.validateOwnerContext(s.ctx, { policy, descriptor, requireDescriptor: true });
      assert.equal(verdict.verdict, OWNER_CONTEXT_VERDICT.MISSING);
      assert.match(verdict.reasons.join(' '), /rationale is required for operational/);
    } finally {
      cleanup(s.tmp);
    }
  });

  test('scopeFingerprint bounded traversal records absent outcomes', () => {
    const tmp = createTempDir();
    try {
      writeAbs(path.join(tmp, 'owned', 'a.ts'), 'a\n');
      const first = oc.scopeFingerprint(tmp, ['owned', 'owned/deleted.ts']);
      assert.equal(first.ok, true);
      assert.ok(first.entries.includes('owned/deleted.ts:absent'));
      writeAbs(path.join(tmp, 'owned', 'a.ts'), 'a changed\n');
      const second = oc.scopeFingerprint(tmp, ['owned', 'owned/deleted.ts']);
      assert.notEqual(second.fingerprint, first.fingerprint, 'content change moves the fingerprint');
    } finally {
      cleanup(tmp);
    }
  });
});

// --- symlink / policy / target hardening ------------------------------------

describe('owner-context symlink, policy and target hardening', () => {
  test('scopeFingerprint refuses a symlinked scope root', () => {
    const tmp = createTempDir();
    try {
      fs.mkdirSync(path.join(tmp, 'target'));
      fs.writeFileSync(path.join(tmp, 'target', 'f.txt'), 'one');
      fs.symlinkSync(path.join(tmp, 'target'), path.join(tmp, 'scope'), 'dir');
      const result = oc.scopeFingerprint(tmp, ['scope']);
      assert.equal(result.ok, false);
      assert.match(result.reasons.join(' '), /symlink \(refused\)/);
    } finally {
      cleanup(tmp);
    }
  });

  test('scopeFingerprint refuses an internal symlink entry inside a scope (no silent skip)', () => {
    const tmp = createTempDir();
    try {
      fs.mkdirSync(path.join(tmp, 'real'));
      fs.writeFileSync(path.join(tmp, 'real', 'g.txt'), 'g1');
      fs.mkdirSync(path.join(tmp, 'scope'));
      fs.symlinkSync(path.join(tmp, 'real', 'g.txt'), path.join(tmp, 'scope', 'link.txt'));
      const result = oc.scopeFingerprint(tmp, ['scope']);
      assert.equal(result.ok, false);
      assert.match(result.reasons.join(' '), /symlink entry \(refused\)/);
    } finally {
      cleanup(tmp);
    }
  });

  test('a missing path beneath an escaping symlink is refused (nearest-existing-parent)', () => {
    const tmp = createTempDir();
    try {
      fs.symlinkSync(path.resolve(tmp, '..'), path.join(tmp, 'escape'), 'dir');
      const result = oc.scopeFingerprint(tmp, ['escape/newfile.ts']);
      assert.equal(result.ok, false);
      assert.match(result.reasons.join(' '), /resolves outside the worktree root/);
    } finally {
      cleanup(tmp);
    }
  });

  test('scopeFingerprint refuses an oversized file without allocating it', () => {
    const tmp = createTempDir();
    try {
      const big = path.join(tmp, 'big.bin');
      fs.writeFileSync(big, '');
      fs.truncateSync(big, oc.OWNER_SCOPE_BUDGET.MAX_BYTES + 1);
      const result = oc.scopeFingerprint(tmp, ['big.bin']);
      assert.equal(result.ok, false);
      assert.equal(result.truncated, true);
      assert.match(result.reasons.join(' '), /byte budget exceeded/);
    } finally {
      cleanup(tmp);
    }
  });

  test('an explicitly requested but MISSING policy fails closed; only an implicit absence audits', () => {
    const tmp = createTempDir();
    try {
      const explicit = oc.loadOwnerPolicy(tmp, { policyPath: '.planning/missing-policy.json' });
      assert.equal(explicit.ok, false);
      assert.equal(explicit.requested_enforce, true);
      assert.match(explicit.reasons.join(' '), /explicitly requested policy file is missing/);

      const implicit = oc.loadOwnerPolicy(tmp);
      assert.equal(implicit.ok, true);
      assert.equal(implicit.requested_enforce, false);
    } finally {
      cleanup(tmp);
    }
  });

  test('an unsupported policy_version and malformed known_owners entries are rejected', () => {
    const tmp = createTempDir();
    try {
      writePolicy(tmp, { policy_version: '9.9.9', mode: 'audit' });
      const versionLoad = oc.loadOwnerPolicy(tmp);
      assert.equal(versionLoad.ok, false);
      assert.match(versionLoad.reasons.join(' '), /unsupported policy_version/);

      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'x', extra: 1 }] });
      assert.match(oc.loadOwnerPolicy(tmp).reasons.join(' '), /unknown known_owners entry key: extra/);

      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 42 }] });
      assert.match(oc.loadOwnerPolicy(tmp).reasons.join(' '), /known_owners entry\.repo_id must be a string/);

      writePolicy(tmp, { policy_version: '1.0.0', mode: 'enforce', known_owners: [{}] });
      assert.match(oc.loadOwnerPolicy(tmp).reasons.join(' '), /must name at least one of repo_id\/remote\/root/);
    } finally {
      cleanup(tmp);
    }
  });

  test('authorizeOwnerTargets binds targets to scopes and refuses empty scopes', () => {
    const tmp = createTempDir();
    try {
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'a\n');
      const inside = oc.authorizeOwnerTargets(tmp, ['src'], ['src/a.ts', 'src/new.ts']);
      assert.equal(inside.ok, true);
      const outside = oc.authorizeOwnerTargets(tmp, ['src'], ['.planning/STATE.md']);
      assert.equal(outside.ok, false);
      assert.deepEqual(outside.offending, ['.planning/STATE.md']);
      const noScopes = oc.authorizeOwnerTargets(tmp, [], ['src/a.ts']);
      assert.equal(noScopes.ok, false);
      assert.match(noScopes.reasons.join(' '), /no writable scopes declared/);
    } finally {
      cleanup(tmp);
    }
  });

  test('a descriptor scope that excludes the write target is a reported MISSING, not authorized', () => {
    const tmp = createTempDir();
    try {
      const deps = mainWorktreeDeps({ root: tmp });
      const ctx = oc.buildOwnerContext(tmp, { deps, kind: 'operational', rationale: 'x' });
      writeAbs(path.join(tmp, 'src', 'foo.ts'), 'x\n');
      const policy = { ...OWNER_POLICY_DEFAULT, mode: 'enforce', known_owners: [{ repo_id: ctx.owner.repo_id }] };
      const descriptor = {
        task_id: 't', owner: { repo_id: ctx.owner.repo_id, root: ctx.owner.root },
        planning: { project: null, workstream: null },
        workflow: { kind: 'operational', phase: null, plan: null, parent_plan: null, rationale: 'x' },
        writable_scopes: ['src'],
        expected: { head: ctx.owner.head, planning_fingerprint: ctx.fingerprint.planning, scope_fingerprint: oc.scopeFingerprint(ctx.owner.root, ['src']).fingerprint },
        provenance: 'p',
      };
      const mismatch = oc.validateOwnerContext(ctx, { policy, descriptor, requireDescriptor: true, targets: ['.planning/STATE.md'] });
      assert.equal(mismatch.ok, false);
      assert.match(mismatch.reasons.join(' '), /outside the declared writable scopes/);
      const allowed = oc.validateOwnerContext(ctx, { policy, descriptor, requireDescriptor: true, targets: ['src/foo.ts'] });
      assert.equal(allowed.ok, true, allowed.reasons.join('; '));
    } finally {
      cleanup(tmp);
    }
  });
});

// --- envelope + record ------------------------------------------------------

describe('owner-context additive envelope + record', () => {
  test('envelope field carries the pinned key order', () => {
    const tmp = createTempDir();
    try {
      const field = oc.ownerContextEnvelopeField(tmp, { deps: mainWorktreeDeps({ root: tmp }) });
      assert.deepEqual(Object.keys(field), [...OWNER_CONTEXT_KEY_ORDER]);
      assert.equal(field.contract, OWNER_CONTEXT_VERSION);
      assert.equal(field.flavor, 'core');
    } finally {
      cleanup(tmp);
    }
  });

  test('envelope resolution is total even with a throwing git seam', () => {
    assert.doesNotThrow(() => {
      const field = oc.ownerContextEnvelopeField('/nope', { deps: { execGit: () => { throw new Error('boom'); } } });
      assert.equal(field.contract, OWNER_CONTEXT_VERSION);
    });
  });

  test('publishOwnerContext writes only the additive record, never state.json', () => {
    const tmp = createTempDir();
    try {
      writeAbs(path.join(tmp, '.planning', 'ROADMAP.md'), '# Roadmap\n');
      writeAbs(path.join(tmp, '.planning', 'state.json'), JSON.stringify({ contract: '1.0.0' }));
      const before = fs.readFileSync(path.join(tmp, '.planning', 'state.json'), 'utf-8');
      const res = oc.publishOwnerContext(tmp);
      assert.equal(res.published, true);
      assert.ok(fs.existsSync(path.join(tmp, '.planning', 'owner-context.json')));
      assert.equal(fs.readFileSync(path.join(tmp, '.planning', 'state.json'), 'utf-8'), before);
    } finally {
      cleanup(tmp);
    }
  });

  test('publishOwnerContext refuses with no_planning_dir and creates nothing', () => {
    const tmp = createTempDir();
    try {
      const res = oc.publishOwnerContext(tmp);
      assert.equal(res.published, false);
      assert.equal(res.reason, oc.OWNER_CONTEXT_PUBLISH_REASON.NO_PLANNING_DIR);
      assert.equal(fs.existsSync(path.join(tmp, '.planning')), false);
    } finally {
      cleanup(tmp);
    }
  });
});

