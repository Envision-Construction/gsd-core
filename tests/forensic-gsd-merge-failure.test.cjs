'use strict';
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { once } = require('node:events');
const { createTempDir, cleanup, installSpawnEnv, homeSandboxEnv, waitFor } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS, PROBE_TIMEOUT_MS, HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { authorizeFixtureEntry } = require('./helpers/custody-fixture.cjs');
const safety = require('../gsd-core/bin/lib/worktree-safety.cjs');
const projection = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const LIB = path.resolve(__dirname, '../gsd-core/bin/lib');
// A fixture-only merge budget: long enough for the ready marker and a second
// writer's small Git add, short enough to exercise an actual hook timeout.
const MERGE_BUDGET_MS = 3000;

function fixtureEnv(root) {
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(home); fs.mkdirSync(tmp);
  const env = installSpawnEnv({ ...homeSandboxEnv(home),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GSD_STRICT_LIVE_CONFIG_GUARD: '1',
  });
  for (const key of Object.keys(env)) {
    if ((key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT',
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(key))
      || ['NODE_OPTIONS', 'GSD_SKIP_LIVE_CONFIG_GUARD'].includes(key)) delete env[key];
  }
  return env;
}
function fixture(t, { autoStash = false, conflict = false } = {}) {
  const root = createTempDir('gsd-merge-custody-');
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const env = fixtureEnv(root);
  const git = (args, cwd = repo) => gitOrThrow(args, { cwd, env, timeoutMs: GIT_TIMEOUT_MS }).trim();
  const hooks = path.join(root, 'hooks'); fs.mkdirSync(hooks);
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', hooks]); git(['config', 'merge.autoStash', String(autoStash)]);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(['add', 'base.txt']); git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  const entries = ['first', 'next'].map((id) => {
    const worktree = path.join(root, 'worker-' + id); const branch = 'worktree-agent-' + id;
    git(['worktree', 'add', '-q', '-b', branch, worktree]);
    fs.writeFileSync(path.join(worktree, id + '.txt'), 'accepted ' + id + '\n');
    if (conflict && id === 'first') fs.writeFileSync(path.join(worktree, 'base.txt'), 'worker conflict\n');
    git(['add', '.'], worktree); git(['commit', '-qm', id], worktree);
    return authorizeFixtureEntry(repo, { agent_id: id, branch, worktree_path: worktree, expected_base: base });
  });
  fs.writeFileSync(path.join(repo, 'parent.txt'), 'parent\n');
  if (conflict) fs.writeFileSync(path.join(repo, 'base.txt'), 'parent conflict\n');
  git(['add', '.']); git(['commit', '-qm', 'parent']);
  const head = git(['rev-parse', 'HEAD']);
  const f = { root, repo, hooks, entries, base, head, env, git, stop: null };
  t.after(async () => { try { await f.stop?.(); } finally { cleanup(root); } });
  return f;
}

// Raw bytes include the complete parent worktree and .git tree: index, refs,
// reflogs, worker registrations, stash/merge state and objects. Read-only probes
// after the failed merge must not change any of these bytes or remove a path.
function snapshotTree(root) {
  const result = {};
  function walk(dir, rel = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name); const key = path.join(rel, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) result[key] = { link: fs.readlinkSync(file) };
      else if (stat.isDirectory()) { result[key] = { directory: true }; walk(file, key); }
      else result[key] = { bytes: fs.readFileSync(file).toString('hex') };
    }
  }
  walk(root); return result;
}
function assertNoRecoveryMutations(calls) {
  assert.deepEqual(calls.filter((a) => ['reset', 'stash', 'restore', 'checkout', 'read-tree', 'update-index', 'add', 'rm', 'clean'].includes(a[0])
    || (a[0] === 'merge' && ['--abort', '--quit'].includes(a[1]))
    || (a[0] === 'worktree' && ['remove', 'unlock', 'prune'].includes(a[1]))
    || (a[0] === 'update-ref' && a.includes('-d')) || (a[0] === 'branch' && a.some((v) => ['-d', '-D'].includes(v)))), [],
  'no automatic recovery, staging, removal or ref deletion attempt is allowed');
}
function assertHalted(f, out, { integrated = false, reason = 'merge_failed' } = {}) {
  const r = out.result;
  assert.equal(r.ok, false); assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].reason, reason); assert.equal(r.entries[0].integrated, integrated);
  assert.equal(r.entries[0].status, integrated === true ? 'integrated_retained' : integrated === null ? 'integration_unknown_retained' : 'blocked');
  assert.deepEqual(r.pending, safety.planWorktreeWaveCleanup(f.repo, [f.entries[1]]).entries);
  assert.equal(r.entries[0].warnings.at(-1).code, safety.WAVE_CLEANUP_WARNING.MERGE_MANUAL_ROOT_RECOVERY_REQUIRED);
  assert.match(r.entries[0].stderr, /Manual root recovery required/);
  assert.deepEqual(r.warnings, r.entries[0].warnings);
  assert.equal(out.calls.filter((a) => a[0] === 'merge').length, 1, 'no second merge or abort');
  const merge = out.calls.find((a) => a[0] === 'merge');
  assert.equal(merge[1], f.entries[0].retirement_authorization.accepted_head);
  assert.ok(merge.includes('--no-autostash')); assertNoRecoveryMutations(out.calls);
  for (const entry of f.entries) {
    assert.ok(fs.existsSync(entry.worktree_path));
    assert.equal(f.git(['rev-parse', 'refs/heads/' + entry.branch]), entry.retirement_authorization.accepted_head);
    assert.equal(f.git(['rev-parse', entry.retirement_authorization.recovery_ref]), entry.retirement_authorization.accepted_head);
  }
}
function cleanupTrace(f, intercept = (a, o, real) => real(a, o)) {
  const calls = []; let boundary; let beforeMerge; let merged = false;
  const result = safety.executeWorktreeWaveCleanupPlan(safety.planWorktreeWaveCleanup(f.repo, f.entries), {
    isPidAlive: () => false,
    execGit: (a, o) => {
      calls.push(a);
      if (a[0] === 'merge') beforeMerge = snapshotTree(f.repo);
      const real = (args, opts) => projection.execGit(args, { ...opts, env: f.env });
      const r = intercept(a, o, real, merged);
      if (a[0] === 'merge') { boundary = snapshotTree(f.repo); merged = true; }
      return r;
    },
  });
  if (boundary && result.entries.some((r) => ['merge_failed', 'merge_timed_out', 'integration_not_observed'].includes(r.reason))) {
    assert.deepEqual(snapshotTree(f.repo), boundary, 'helper must preserve exact post-command bytes');
  }
  assertNoRecoveryMutations(calls);
  return { result, calls, boundary, beforeMerge };
}

// Each actual merge is in its own fixture process group. Killing that group
// exercises a real Git timeout/signal without abandoning a hook process. This
// executor is only a test dependency; the production runner is unchanged.
function mergeExecutor() {
  const fs = require('node:fs'); const cp = require('node:child_process');
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const child = cp.spawn('git', config.args, { cwd: config.repo, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let timedOut = false; let spawnError = null;
  child.stdout.on('data', (s) => { stdout += s; }); child.stderr.on('data', (s) => { stderr += s; });
  child.on('error', (e) => { spawnError = { message: e.message, code: e.code }; });
  fs.writeFileSync(config.groupFile, JSON.stringify({ pid: child.pid, executorPid: process.pid }));
  const kill = (signal) => { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
  let force;
  const timer = setTimeout(() => {
    timedOut = true; kill('SIGTERM');
    force = setTimeout(() => kill('SIGKILL'), config.forceBudget);
  }, config.timeout);
  child.on('close', (status, signal) => {
    clearTimeout(timer); clearTimeout(force);
    // Also accounts for a descendant which closed stdio but ignored SIGTERM.
    kill('SIGKILL');
    process.stdout.write(JSON.stringify({ exitCode: status ?? 1, stdout, stderr, signal, timedOut,
      error: timedOut ? { code: 'ETIMEDOUT', message: 'fixture merge budget exceeded' } : spawnError }));
  });
}
function hookDriver() {
  const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const safety = require(path.join(config.lib, 'worktree-safety.cjs'));
  const real = require(path.join(config.lib, 'shell-command-projection.cjs')).execGit;
  const calls = []; let boundary; let mergeOutcome; let executorOutcome;
  const result = safety.executeWorktreeWaveCleanupPlan(safety.planWorktreeWaveCleanup(config.repo, config.entries), {
    isPidAlive: () => false, mergeTimeoutMs: config.mergeBudget,
    execGit: (a, o) => {
      calls.push(a);
      if (a[0] !== 'merge') return real(a, o);
      fs.writeFileSync(config.mergeConfig, JSON.stringify({ args: a, repo: o.cwd, timeout: o.timeout,
        forceBudget: config.forceBudget, groupFile: config.groupFile }));
      const run = cp.spawnSync(process.execPath, [config.executor, config.mergeConfig], { encoding: 'utf8', timeout: config.outerBudget });
      executorOutcome = { status: run.status, signal: run.signal, error: run.error?.message, stdout: run.stdout, stderr: run.stderr };
      boundary = snapshotTree(config.repo);
      if (run.status !== 0) throw new Error(run.stderr || 'fixture executor failed');
      mergeOutcome = JSON.parse(run.stdout);
      return mergeOutcome;
    },
  });
  fs.writeFileSync(config.output, JSON.stringify({ result, calls, boundary, mergeOutcome, executorOutcome }));
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}

async function hookFailure(t, { hookName = 'pre-merge-commit', death = 'timeout', autoStash = false, lateAutostash = false } = {}) {
  const f = fixture(t, { autoStash });
  let foreignStash;
  if (lateAutostash) {
    fs.writeFileSync(path.join(f.repo, 'base.txt'), 'foreign stash work\n'); f.git(['add', 'base.txt']);
    foreignStash = f.git(['stash', 'create', 'second writer recovery']);
    fs.writeFileSync(path.join(f.repo, 'base.txt'), 'base\n'); f.git(['add', 'base.txt']);
  }
  const ready = path.join(f.root, 'hook-ready.json'); const release = path.join(f.root, 'release');
  const groupFile = path.join(f.root, 'group.json'); const driverFile = path.join(f.root, 'driver.cjs');
  const executor = path.join(f.root, 'executor.cjs'); const hookFile = path.join(f.root, 'hook.cjs');
  const output = path.join(f.root, 'output.json'); const configFile = path.join(f.root, 'config.json');
  const hook = `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, gitPid: process.ppid }));
    const tick = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(tick); clearTimeout(bound); process.exitCode = 1; } }, 10);
    const bound = setTimeout(() => { clearInterval(tick); process.exitCode = 82; }, ${HOOK_FANOUT_TIMEOUT_MS});`;
  fs.writeFileSync(hookFile, hook);
  fs.writeFileSync(path.join(f.hooks, hookName), '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(hookFile) + '\n', { mode: 0o755 });
  fs.writeFileSync(executor, '(' + mergeExecutor.toString() + ')();\n');
  fs.writeFileSync(driverFile, "const fs = require('node:fs'); const path = require('node:path');\n" + snapshotTree.toString() + '\n(' + hookDriver.toString() + ')();\n');
  fs.writeFileSync(configFile, JSON.stringify({ lib: LIB, repo: f.repo, entries: f.entries, executor, output, groupFile,
    mergeConfig: path.join(f.root, 'merge.json'), mergeBudget: death === 'timeout' ? MERGE_BUDGET_MS : PROBE_TIMEOUT_MS,
    forceBudget: MERGE_BUDGET_MS, outerBudget: HOOK_FANOUT_TIMEOUT_MS }));
  assert.equal(f.git(['status', '--porcelain=v1']), '', 'merge starts clean');
  const driver = cp.spawn(process.execPath, [driverFile, configFile], { cwd: f.repo, env: f.env,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: HOOK_FANOUT_TIMEOUT_MS });
  let stderr = ''; driver.stderr.on('data', (s) => { stderr += s; }); driver.stdout.resume();
  const closed = once(driver, 'close'); let hookPid;
  f.stop = async () => {
    if (fs.existsSync(groupFile)) {
      const { pid } = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
      try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    if (driver.exitCode === null && driver.signalCode === null) driver.kill('SIGKILL');
    await closed;
    if (hookPid) await waitFor(() => !isAlive(hookPid), { timeoutMs: PROBE_TIMEOUT_MS, message: 'orphan fixture hook' });
  };
  const hookState = await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(ready, 'utf8')); } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return false; throw e; }
  }, { timeoutMs: PROBE_TIMEOUT_MS, message: 'fixture hook was not reached' });
  hookPid = hookState.pid;
  assert.notEqual(hookPid, process.pid); assert.notEqual(hookPid, driver.pid);
  // This test process is the independent second writer, not the hook or merge.
  fs.writeFileSync(path.join(f.repo, 'late-parent.txt'), Buffer.from([255, 0, 42, 10]));
  fs.writeFileSync(path.join(f.repo, 'late-untracked.txt'), 'second writer untracked\n');
  f.git(['add', 'late-parent.txt']);
  if (lateAutostash) {
    f.git(['update-ref', 'MERGE_AUTOSTASH', foreignStash]); f.git(['update-ref', 'refs/stash', foreignStash]);
  }
  const staged = fs.readFileSync(path.join(f.repo, '.git', 'index'));
  assert.match(f.git(['diff', '--cached', '--name-only']), /late-parent\.txt/);
  const group = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
  assert.equal(group.pid, hookState.gitPid, 'signal target is the fixture Git process group');
  if (death === 'signal') process.kill(-group.pid, 'SIGTERM');
  if (death === 'hook-refusal') fs.writeFileSync(release, 'fail\n');
  const [status, signal] = await closed;
  assert.equal(status, 0, stderr); assert.equal(signal, null);
  const out = JSON.parse(fs.readFileSync(output, 'utf8'));
  let evidenceFile;
  if (process.env.GSD_MERGE_CUSTODY_EVIDENCE) {
    fs.mkdirSync(process.env.GSD_MERGE_CUSTODY_EVIDENCE, { recursive: true });
    evidenceFile = path.join(process.env.GSD_MERGE_CUSTODY_EVIDENCE, hookName + '-' + death + (lateAutostash ? '-foreign-autostash' : '') + '.json');
    fs.writeFileSync(evidenceFile,
      JSON.stringify({ ...out, afterHelper: snapshotTree(f.repo), stagedIndexBeforeKill: staged.toString('hex'), writerPid: process.pid, driverPid: driver.pid, hook: hookState }, null, 2) + '\n');
  }
  assert.ok(out.mergeOutcome, JSON.stringify(out.executorOutcome));
  assert.deepEqual(snapshotTree(f.repo), out.boundary, 'all parent and Git state is byte-identical after helper returns');
  assert.deepEqual(fs.readFileSync(path.join(f.repo, '.git', 'index')), staged, 'raw second-writer index survives');
  assert.deepEqual(fs.readFileSync(path.join(f.repo, 'late-parent.txt')), Buffer.from([255, 0, 42, 10]));
  assert.equal(fs.readFileSync(path.join(f.repo, 'late-untracked.txt'), 'utf8'), 'second writer untracked\n');
  const integrated = hookName === 'post-merge';
  assertHalted(f, out, { integrated, reason: death === 'timeout' ? 'merge_timed_out' : 'merge_failed' });
  assert.equal(out.mergeOutcome.timedOut, death === 'timeout');
  if (death !== 'hook-refusal') assert.equal(out.mergeOutcome.signal, 'SIGTERM');
  if (!integrated) assert.equal(f.git(['rev-parse', 'HEAD']), f.head);
  // A killed post-merge hook can leave MERGE_HEAD even though HEAD advanced.
  // Preserve whichever exact state Git left; pre-merge and commit-msg have
  // deterministic state-file expectations at their respective hook boundary.
  if (!integrated) assert.equal(fs.existsSync(path.join(f.repo, '.git', 'MERGE_HEAD')), hookName === 'commit-msg' || death === 'hook-refusal');
  assert.equal(fs.existsSync(path.join(f.repo, '.git', 'MERGE_AUTOSTASH')), lateAutostash);
  if (lateAutostash) {
    assert.equal(f.git(['rev-parse', 'MERGE_AUTOSTASH']), foreignStash);
    assert.equal(f.git(['rev-parse', 'refs/stash']), foreignStash);
  }
  assert.equal(f.git(['config', 'merge.autoStash']), String(autoStash));
  await waitFor(() => !isAlive(hookPid), { timeoutMs: PROBE_TIMEOUT_MS, message: 'hook survived helper return' });
  const processesStopped = { driver: !isAlive(driver.pid), merge: !isAlive(group.pid), hook: !isAlive(hookPid), executor: !isAlive(group.executorPid) };
  assert.ok(Object.values(processesStopped).every(Boolean), JSON.stringify(processesStopped));
  if (evidenceFile) {
    const record = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    fs.writeFileSync(evidenceFile, JSON.stringify({ ...record, group, processesStopped }, null, 2) + '\n');
  }
}

describe('RGS-10 real Git concurrent parent writes survive failed merges', { skip: process.platform === 'win32' ? 'POSIX fixture process groups and sh hooks' : false }, () => {
  for (const hookName of ['pre-merge-commit', 'commit-msg']) for (const death of ['timeout', 'signal']) {
    test(`${hookName} ${death} preserves exact parent/index/state and halts pending entries`, (t) => hookFailure(t, { hookName, death, autoStash: true }));
  }
  test('a second writer autostash and stash ref appearing during the hook are preserved', (t) => hookFailure(t, { death: 'signal', lateAutostash: true }));
  test('pre-merge hook failure preserves concurrent staging without an abort', (t) => hookFailure(t, { death: 'hook-refusal' }));
  test('killed post-merge hook reports actual integrated:true and still requires root recovery', (t) => hookFailure(t, { hookName: 'post-merge', death: 'signal' }));
});

describe('RGS-10 accepted merge, refusal, autostash and unknown controls', () => {
  test('ordinary merge uses immutable acceptance with no-autostash and retains both integrated workers', (t) => {
    const f = fixture(t, { autoStash: true }); const { result, calls } = cleanupTrace(f);
    assert.equal(result.ok, false); assert.deepEqual(result.pending, []);
    assert.deepEqual(result.entries.map((r) => r.integrated), [true, true]);
    assert.deepEqual(result.entries.map((r) => r.status), ['integrated_retained', 'integrated_retained']);
    assert.ok(result.entries.every((r) => r.reason === 'retirement_manual_root_handoff_required'));
    assert.equal(calls.filter((a) => a[0] === 'merge').length, 2);
    for (const entry of f.entries) {
      assert.ok(calls.some((a) => a[0] === 'merge' && a[1] === entry.retirement_authorization.accepted_head && a.includes('--no-autostash')));
      assert.ok(fs.existsSync(entry.worktree_path));
      assert.equal(f.git(['rev-parse', entry.retirement_authorization.recovery_ref]), entry.retirement_authorization.accepted_head);
    }
    assert.equal(f.git(['status', '--porcelain=v1']), ''); assert.equal(f.git(['config', 'merge.autoStash']), 'true');
  });
  for (const autoStash of [false, true]) test(`clean refusal preserves staged work with merge.autoStash=${autoStash}`, (t) => {
    const f = fixture(t, { autoStash });
    let stagedPatch;
    // RGS-11 now refuses pre-existing dirty inventory before Git. Preserve the
    // actual RGS-10 native refusal stimulus by staging after the last read.
    // This also demonstrates that the inventory does not acquire a writer lease.
    const out = cleanupTrace(f, (a, o, real) => {
      if (a[0] === 'merge') {
        fs.writeFileSync(path.join(f.repo, 'base.txt'), 'operator staged\n');
        fs.writeFileSync(path.join(f.repo, 'precious.txt'), 'operator unique\n'); f.git(['add', 'base.txt', 'precious.txt']);
        stagedPatch = f.git(['diff', '--cached', '--binary']);
      }
      return real(a, o);
    }); assertHalted(f, out);
    // Native Git may refresh cache-tree metadata even on refusal. The staged
    // patch is unchanged, and cleanupTrace compares raw index bytes plus the
    // entire parent tree exactly from the command-return boundary.
    assert.equal(f.git(['diff', '--cached', '--binary']), stagedPatch);
    assert.equal(fs.readFileSync(path.join(f.repo, 'precious.txt'), 'utf8'), 'operator unique\n');
    assert.equal(fs.readFileSync(path.join(f.repo, 'base.txt'), 'utf8'), 'operator staged\n');
    assert.equal(f.git(['rev-parse', 'HEAD']), f.head);
    assert.equal(f.git(['config', 'merge.autoStash']), String(autoStash));
    assert.equal(fs.existsSync(path.join(f.repo, '.git', 'MERGE_AUTOSTASH')), false);
    assert.equal(f.git(['stash', 'list']), '');
  });
  test('no-autostash also overrides isolated user configuration without rewriting it', (t) => {
    const f = fixture(t); const globalConfig = path.join(f.root, 'user.gitconfig');
    f.git(['config', '--unset', 'merge.autoStash']);
    fs.writeFileSync(globalConfig, '[merge]\n  autoStash = true\n'); f.env.GIT_CONFIG_GLOBAL = globalConfig;
    const config = fs.readFileSync(globalConfig);
    let stagedPatch;
    const out = cleanupTrace(f, (a, o, real) => {
      if (a[0] === 'merge') {
        fs.writeFileSync(path.join(f.repo, 'base.txt'), 'operator user-config staging\n'); f.git(['add', 'base.txt']);
        stagedPatch = f.git(['diff', '--cached', '--binary']);
      }
      return real(a, o);
    }); assertHalted(f, out);
    assert.equal(f.git(['diff', '--cached', '--binary']), stagedPatch);
    assert.deepEqual(fs.readFileSync(globalConfig), config);
    assert.equal(f.git(['config', 'merge.autoStash']), 'true');
    assert.equal(fs.existsSync(path.join(f.repo, '.git', 'MERGE_AUTOSTASH')), false);
  });
  test('real conflicted merge preserves MERGE_HEAD, conflict entries and every ref for root', (t) => {
    const f = fixture(t, { conflict: true }); const out = cleanupTrace(f); assertHalted(f, out);
    assert.equal(f.git(['rev-parse', 'HEAD']), f.head);
    assert.equal(f.git(['rev-parse', 'MERGE_HEAD']), f.entries[0].retirement_authorization.accepted_head);
    assert.ok(f.git(['ls-files', '-u']));
  });
  test('pre-existing MERGE_AUTOSTASH and stash ref are refused and preserved intact', (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.repo, 'base.txt'), 'operator work\n'); f.git(['add', 'base.txt']);
    const stash = f.git(['stash', 'create', 'retained fixture work']);
    f.git(['update-ref', 'MERGE_AUTOSTASH', stash]); f.git(['update-ref', 'refs/stash', stash]);
    const index = fs.readFileSync(path.join(f.repo, '.git', 'index'));
    const out = cleanupTrace(f);
    assert.ok(out.result.entries.every((r) => r.reason === 'integration_parent_sequencer_unverified'));
    assert.equal(out.calls.some((a) => a[0] === 'merge'), false);
    assert.deepEqual(fs.readFileSync(path.join(f.repo, '.git', 'index')), index);
    assert.equal(f.git(['rev-parse', 'MERGE_AUTOSTASH']), stash); assert.equal(f.git(['rev-parse', 'refs/stash']), stash);
    assert.equal(fs.readFileSync(path.join(f.repo, 'base.txt'), 'utf8'), 'operator work\n');
  });
  const unknown = [
    { timedOut: true }, { signal: 'SIGTERM' }, { error: new Error('read failure') },
    { exitCode: 128 }, { stdout: 'malformed' }, { stderr: 'unexpected diagnostic' }, 'throw',
  ];
  for (const [i, fault] of unknown.entries()) test(`unverifiable integration ${i} after failed merge stays null and halts`, (t) => {
    const f = fixture(t);
    const out = cleanupTrace(f, (a, o, real, merged) => {
      if (a[0] === 'merge') {
        fs.writeFileSync(path.join(f.repo, 'base.txt'), 'operator staging\n'); f.git(['add', 'base.txt']);
      }
      if (merged && a[0] === 'merge-base' && a.at(-1) === 'HEAD') {
        if (fault === 'throw') throw new Error('injected read exception');
        return { exitCode: 1, stdout: '', stderr: '', signal: null, error: null, timedOut: false, ...fault };
      }
      return real(a, o);
    });
    assertHalted(f, out, { integrated: null });
    assert.equal(f.git(['rev-parse', 'HEAD']), f.head);
  });
  test('a throwing merge transport reports observed non-integration and halts without recovery', (t) => {
    const f = fixture(t); const before = snapshotTree(f.repo);
    const out = cleanupTrace(f, (a, o, real) => {
      if (a[0] === 'merge') throw new Error('injected transport uncertainty');
      return real(a, o);
    });
    assertHalted(f, out); assert.equal(f.git(['rev-parse', 'HEAD']), f.head);
    assert.equal(snapshotTree(f.repo)['.git/index'].bytes, before['.git/index'].bytes);
  });
  test('a successful merge with unknown observation halts pending entries for root', (t) => {
    const f = fixture(t);
    const out = cleanupTrace(f, (a, o, real, merged) => merged && a[0] === 'merge-base' && a.at(-1) === 'HEAD'
      ? { exitCode: 1, stdout: '', stderr: '', timedOut: true } : real(a, o));
    assertHalted(f, out, { integrated: null, reason: 'integration_not_observed' });
    assert.equal(f.git(['merge-base', '--is-ancestor', f.entries[0].retirement_authorization.accepted_head, 'HEAD']), '');
  });
});
