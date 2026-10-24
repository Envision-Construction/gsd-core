'use strict';

// RGS-11: actual Git, actual helper, synthetic parent data only. A preflight
// observation is deliberately not represented as an exclusive writer lease.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createTempDir, cleanup, homeSandboxEnv, installSpawnEnv } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS, PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { authorizeFixtureEntry } = require('./helpers/custody-fixture.cjs');
const safety = require('../gsd-core/bin/lib/worktree-safety.cjs');
const { execGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const PRECIOUS = Buffer.from([255, 0, 42, 10]);

function fixture(t) {
  const root = createTempDir('gsd-parent-inventory-');
  const repo = path.join(root, 'repo'); const home = path.join(root, 'home');
  const hooks = path.join(root, 'hooks');
  for (const dir of [repo, home, hooks]) fs.mkdirSync(dir);
  const env = installSpawnEnv({ ...homeSandboxEnv(home), GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const git = (args, cwd = repo) => gitOrThrow(args, { cwd, env, timeoutMs: GIT_TIMEOUT_MS }).trim();
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', hooks]);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(['add', 'base.txt']); git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  const exited = cp.spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { env, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  assert.ifError(exited.error); assert.equal(exited.status, 0);
  const entries = ['first', 'next'].map(id => {
    const worker = path.join(root, 'worker-' + id); const branch = 'worktree-agent-' + id;
    git(['worktree', 'add', '-q', '-b', branch, worker]);
    fs.writeFileSync(path.join(worker, id === 'first' ? 'artifact.bin' : 'next.txt'), Buffer.from([1, 2, 3, 4]));
    git(['add', '.'], worker); git(['commit', '-qm', id], worker);
    return authorizeFixtureEntry(repo, { agent_id: id, worktree_path: worker, branch, expected_base: base }, { pid: Number(exited.stdout.trim()) });
  });
  fs.writeFileSync(path.join(repo, 'parent.txt'), 'parent\n'); git(['add', '.']); git(['commit', '-qm', 'parent']);
  const head = git(['rev-parse', 'HEAD']);
  t.after(() => cleanup(root));
  return { root, repo, env, entries, head, git };
}

function snapshot(root) {
  const files = {};
  const walk = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name); const rel = path.relative(root, full);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) files[rel] = { link: fs.readlinkSync(full) };
      else if (stat.isDirectory()) { files[rel] = { directory: true }; walk(full); }
      else files[rel] = { bytes: fs.readFileSync(full).toString('hex') };
    }
  };
  walk(root); return files;
}

function execute(f, intercept = (args, opts, real) => real(args, opts)) {
  const calls = [];
  const result = safety.executeWorktreeWaveCleanupPlan(safety.planWorktreeWaveCleanup(f.repo, f.entries), {
    execGit: (args, opts) => {
      calls.push(args);
      return intercept(args, opts, (a, o) => execGit(a, { ...o, env: f.env }));
    },
  });
  assert.equal(calls.some(a => ['reset', 'stash', 'restore', 'checkout', 'add', 'rm', 'clean', 'update-ref'].includes(a[0])
    || (a[0] === 'merge' && a.includes('--abort'))
    || (a[0] === 'worktree' && ['remove', 'unlock', 'prune'].includes(a[1]))), false);
  return { result, calls };
}

function evidence(name, f, out, before, after) {
  const target = process.env.GSD_PARENT_CUSTODY_EVIDENCE;
  if (!target) return;
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, name + '.json'), JSON.stringify({ fixture: f.root,
    method: 'actual Git and cleanup helper; fixture-only data/probe faults; no writer lease claimed',
    head: f.head, entries: f.entries, ...out, before, after }, null, 2) + '\n');
}

function assertHeld(f, out, reason, before, name) {
  assert.equal(out.result.ok, false);
  assert.equal(out.result.entries.length, 2, 'pre-integration refusals may be independently evaluated');
  assert.deepEqual(out.result.pending, []);
  assert.ok(out.result.entries.every(e => e.integrated === false && e.status === 'blocked' && e.reason === reason), JSON.stringify(out.result));
  assert.equal(out.calls.some(a => a[0] === 'merge'), false, 'no merge can overwrite unaccounted parent data');
  const after = snapshot(f.repo);
  assert.deepEqual(after, before, 'complete parent and .git bytes are unchanged');
  evidence(name, f, out, before, after);
  for (const entry of f.entries) {
    assert.equal(f.git(['rev-parse', entry.branch]), entry.retirement_authorization.accepted_head);
    assert.equal(f.git(['rev-parse', entry.retirement_authorization.recovery_ref]), entry.retirement_authorization.accepted_head);
    assert.ok(fs.existsSync(entry.worktree_path));
  }
}

describe('RGS-11 accounted parent inventory before accepted integration', () => {
  test('ordinary clean accepted integration records tracked HEAD recovery and retains workers', t => {
    const f = fixture(t); const before = snapshot(f.repo); const out = execute(f);
    assert.deepEqual(out.result.entries.map(e => e.integrated), [true, true]);
    assert.ok(out.result.entries.every(e => e.reason === 'retirement_manual_root_handoff_required'));
    assert.equal(out.result.entries[0].parent_head_before_merge, f.head);
    assert.equal(out.calls.filter(a => a[0] === 'merge').length, 2);
    assert.deepEqual(fs.readFileSync(path.join(f.repo, 'artifact.bin')), Buffer.from([1, 2, 3, 4]));
    evidence('ordinary', f, out, before, snapshot(f.repo));
  });

  for (const kind of ['ignored-collision', 'global-ignored-collision', 'ignored-unrelated', 'untracked-collision', 'untracked-unrelated', 'tracked', 'staged']) {
    test(`${kind} binary data is retained before any merge`, t => {
      const f = fixture(t);
      const rel = kind.includes('unrelated') ? 'unrelated.bin' : kind === 'tracked' ? 'base.txt' : 'artifact.bin';
      if (kind.startsWith('ignored')) fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\n' + rel + '\n');
      if (kind.startsWith('global-ignored')) {
        const ignore = path.join(f.root, 'global-ignore'); fs.writeFileSync(ignore, rel + '\n');
        f.git(['config', 'core.excludesFile', ignore]);
      }
      fs.writeFileSync(path.join(f.repo, rel), PRECIOUS);
      if (kind === 'staged') f.git(['add', rel]);
      // Caller assertions cannot grant ownership of independent parent bytes.
      f.entries[0].parent_inventory = { accounted: true, ignored: [] };
      const before = snapshot(f.repo); const out = execute(f);
      const reason = kind.includes('ignored') ? 'integration_parent_ignored_data_present'
        : kind.startsWith('untracked') ? 'integration_parent_untracked_data_present' : 'integration_parent_tracked_changes';
      assertHeld(f, out, reason, before, kind);
      assert.deepEqual(fs.readFileSync(path.join(f.repo, rel)), PRECIOUS);
    });
  }

  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    test(`hidden tracked ${flag} bytes cannot masquerade as clean recovery`, t => {
      const f = fixture(t); f.git(['update-index', flag, 'base.txt']);
      fs.writeFileSync(path.join(f.repo, 'base.txt'), PRECIOUS);
      assert.equal(f.git(['status', '--porcelain=v1']), '', 'ordinary status misses hidden data');
      const before = snapshot(f.repo); const out = execute(f);
      assertHeld(f, out, 'integration_parent_inventory_unverified', before, flag.slice(2));
    });
  }

  test('a parent gitlink with unknown nested ignored inventory holds for manual accounting', t => {
    const f = fixture(t);
    f.git(['update-index', '--add', '--cacheinfo', '160000,' + f.head + ',nested']);
    f.git(['commit', '-qm', 'fixture gitlink']);
    const before = snapshot(f.repo); const out = execute(f);
    assertHeld(f, out, 'integration_parent_inventory_unverified', before, 'nested-gitlink');
  });

  test('ignored data arriving after the first observation is caught by the final inventory', t => {
    const f = fixture(t); fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\nartifact.bin\n');
    let inserted = false;
    const out = execute(f, (args, opts, real) => {
      const result = real(args, opts);
      if (!inserted && args.includes('status') && !args.includes('-C')) {
        inserted = true; fs.writeFileSync(path.join(f.repo, 'artifact.bin'), PRECIOUS);
      }
      return result;
    });
    assert.ok(inserted); assert.equal(out.calls.some(a => a[0] === 'merge'), false);
    assert.ok(out.result.entries.every(e => e.reason === 'integration_parent_ignored_data_present'));
    assert.deepEqual(fs.readFileSync(path.join(f.repo, 'artifact.bin')), PRECIOUS);
    evidence('late-before-final-inventory', f, out, null, snapshot(f.repo));
  });

  test('a rescued uncommitted SUMMARY remains in both checkouts and holds final integration', t => {
    const f = fixture(t); const rel = '.planning/01-SUMMARY.md';
    fs.mkdirSync(path.join(f.entries[0].worktree_path, '.planning'));
    fs.writeFileSync(path.join(f.entries[0].worktree_path, rel), PRECIOUS);
    const out = execute(f);
    assert.equal(out.calls.some(a => a[0] === 'merge'), false);
    assert.ok(out.result.entries.every(e => e.reason === 'integration_parent_untracked_data_present'));
    assert.deepEqual(fs.readFileSync(path.join(f.repo, rel)), PRECIOUS);
    assert.deepEqual(fs.readFileSync(path.join(f.entries[0].worktree_path, rel)), PRECIOUS);
    evidence('rescued-summary-hold', f, out, null, snapshot(f.repo));
  });

  test('parent HEAD advancing between inventories refuses that entry without resuming it automatically', t => {
    const f = fixture(t); let advanced = false;
    const out = execute(f, (args, opts, real) => {
      const result = real(args, opts);
      if (!advanced && args[0] === '-C' && args.includes('status')) {
        advanced = true; fs.writeFileSync(path.join(f.repo, 'parent.txt'), 'other root commit\n');
        f.git(['add', 'parent.txt']); f.git(['commit', '-qm', 'other writer']);
      }
      return result;
    });
    assert.equal(out.result.entries[0].reason, 'integration_parent_head_changed');
    assert.equal(out.result.entries[0].integrated, false);
    assert.equal(out.calls.some(a => a[0] === 'merge' && a[1] === f.entries[0].retirement_authorization.accepted_head), false);
    assert.equal(out.result.entries[1].integrated, true, 'a pre-integration refusal is independent');
  });
});

describe('RGS-11 fail-closed parent inventory errors and unknown results', () => {
  for (const probe of ['head', 'tracked', 'status']) {
    for (const [name, fault] of [
      ['timeout', { timedOut: true }], ['signal', { signal: 'SIGTERM' }],
      ['spawn-error', { error: new Error('fixture EIO') }], ['exit-error', { exitCode: 128 }],
      ['diagnostic', { stderr: 'fixture inventory incomplete' }], ['missing-output', { stdout: undefined }],
      ['throw', null],
    ]) {
      test(`${probe} ${name} retains all bytes with zero merges`, t => {
        const f = fixture(t); const before = snapshot(f.repo);
        const out = execute(f, (args, opts, real) => {
          const match = probe === 'head' ? args.at(-1) === 'HEAD^{commit}'
            : probe === 'tracked' ? args.includes('ls-files') : args.includes('status') && !args.includes('-C');
          if (!match) return real(args, opts);
          if (fault === null) throw new Error('fixture inventory exception');
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signal: null, ...fault };
        });
        assertHeld(f, out, 'integration_parent_inventory_unverified', before, probe + '-' + name);
      });
    }
  }
  for (const output of ['malformed', 'H 100644 ' + '1'.repeat(40) + ' 0\tbase.txt', 'H 100644 ' + '1'.repeat(40) + ' 1\tbase.txt\0']) {
    test(`malformed or incomplete tracked record ${JSON.stringify(output)} refuses integration`, t => {
      const f = fixture(t); const before = snapshot(f.repo);
      const out = execute(f, (args, opts, real) => args.includes('ls-files')
        ? { exitCode: 0, stdout: output, stderr: '', timedOut: false, signal: null } : real(args, opts));
      assertHeld(f, out, 'integration_parent_inventory_unverified', before, 'malformed-' + output.length);
    });
  }
});
