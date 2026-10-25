'use strict';
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createTempDir, cleanup, installSpawnEnv, homeSandboxEnv } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS, PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { authorizeFixtureEntry, git } = require('./helpers/custody-fixture.cjs');
const safety = require('../gsd-core/bin/lib/worktree-safety.cjs');
const LIB = path.resolve(__dirname, '../gsd-core/bin/lib');
let f;
function setup() {
  const base = createTempDir('forensic-gsd-');
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Fixture'], repo);
  git(['config', 'user.email', 'fixture@example.invalid'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.mkdirSync(path.join(base, 'hooks'));
  git(['config', 'core.hooksPath', path.join(base, 'hooks')], repo);
  fs.mkdirSync(path.join(repo, '.planning'));
  fs.writeFileSync(path.join(repo, '.planning/config.json'), JSON.stringify({ commit_docs: true, branching_strategy: 'none' }));
  for (const p of ['named.md', 'remove.md', 'peer.md']) fs.writeFileSync(path.join(repo, '.planning', p), 'base\n');
  git(['add', '.planning'], repo); git(['commit', '-m', 'base'], repo);
  return { base, repo, home };
}
function snapshot(repo) {
  const gitPath = (p) => path.resolve(repo, git(['rev-parse', '--git-path', p], repo));
  const files = {};
  for (const p of ['index', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_MSG', 'sequencer/head', 'sequencer/todo', 'sequencer/abort-safety']) {
    try { files[p] = fs.readFileSync(gitPath(p)).toString('hex'); } catch (err) { if (err.code !== 'ENOENT') throw err; files[p] = null; }
  }
  return { head: git(['rev-parse', 'HEAD'], repo), files };
}
function sequencer(repo, kind) {
  git(['checkout', '-b', 'side'], repo);
  fs.writeFileSync(path.join(repo, 'topic.txt'), 'side\n');
  git(['add', 'topic.txt'], repo); git(['commit', '-m', 'side'], repo);
  const side = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', 'main'], repo);
  if (kind === 'merge') git(['merge', '--no-ff', '--no-commit', 'side'], repo);
  else {
    fs.writeFileSync(path.join(repo, 'topic.txt'), 'main\n');
    git(['add', 'topic.txt'], repo); git(['commit', '-m', 'main'], repo);
    const failed = cp.spawnSync('git', ['cherry-pick', side], { cwd: repo, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    assert.equal(failed.status, 1, 'fixture must create a conflicted cherry-pick');
    fs.writeFileSync(path.join(repo, 'topic.txt'), 'resolved\n'); git(['add', 'topic.txt'], repo);
  }
  fs.writeFileSync(path.join(repo, '.planning/peer.md'), 'peer staged\n');
  git(['add', '.planning/peer.md'], repo);
}
function runCommit({ repo = f.repo, files = ['.planning/named.md'], removed = [], subrepo = false, fault = null, amend = false }) {
  const callsFile = path.join(f.base, 'calls.json');
  const script = `
    const fs = require('node:fs'); const path = require('node:path');
    const lib = ${JSON.stringify(LIB)}; const projection = require(path.join(lib, 'shell-command-projection.cjs'));
    const real = projection.execGit; const calls = []; const fault = ${JSON.stringify(fault)};
    projection.execGit = (args, opts) => {
      calls.push(args);
      if (fault && args[0] === 'rev-parse' && args.at(-1) === fault.ref) {
        return { exitCode: fault.exitCode, stdout: fault.stdout || '', stderr: fault.stderr || '', signal: fault.signal || null,
          timedOut: fault.timedOut || false, error: fault.error ? Object.assign(new Error('injected'), { code: fault.error }) : null };
      }
      return real(args, opts);
    };
    process.on('exit', () => fs.writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls)));
    const io = require(path.join(lib, 'io.cjs')); const out = []; io.output = (r) => out.push(r);
    const commands = require(path.join(lib, 'commands.cjs'));
    ${subrepo ? `commands.cmdCommitToSubrepo(${JSON.stringify(f.repo)}, 'scoped fixture', ${JSON.stringify(files)}, false);`
      : `commands.cmdCommit(${JSON.stringify(repo)}, 'scoped fixture', ${JSON.stringify(files)}, false, ${amend}, false, ${JSON.stringify(removed)});`}
    process.stdout.write(JSON.stringify(out.at(-1)));
  `;
  const run = cp.spawnSync(process.execPath, ['-e', script], { cwd: f.repo, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS,
    env: installSpawnEnv({ ...homeSandboxEnv(f.home), GSD_TEST_MODE: '1' }) });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return { result: JSON.parse(run.stdout), calls: JSON.parse(fs.readFileSync(callsFile, 'utf8')) };
}
function assertNoMutations(calls) {
  assert.deepEqual(calls.filter((a) => ['add', 'rm', 'commit', 'reset', 'update-index', 'checkout'].includes(a[0])), []);
}
function worker(id = 'fixture') {
  const wt = path.join(f.base, id === 'fixture' ? 'worker' : `worker-${id}`);
  const branch = `worktree-agent-${id}`;
  const expected = git(['rev-parse', 'HEAD'], f.repo);
  git(['worktree', 'add', '-b', branch, wt], f.repo);
  fs.writeFileSync(path.join(wt, `feature-${id}.txt`), 'accepted feature\n');
  git(['add', `feature-${id}.txt`], wt); git(['commit', '-m', 'worker'], wt);
  const entry = authorizeFixtureEntry(f.repo, { agent_id: id, branch, worktree_path: wt, expected_base: expected });
  return { wt, entry };
}
function runCleanup(entry, extra = {}) {
  const calls = [];
  const real = require('../gsd-core/bin/lib/shell-command-projection.cjs').execGit;
  const intercept = extra.execGit;
  const result = safety.executeWorktreeWaveCleanupPlan(safety.planWorktreeWaveCleanup(f.repo, [entry]), {
    isPidAlive: () => false, ...extra,
    execGit: (args, opts) => { calls.push(args); return intercept ? intercept(args, opts, real) : real(args, opts); },
  });
  assert.deepEqual(calls.filter((a) => (a[0] === 'worktree' && ['remove', 'unlock', 'prune'].includes(a[1])) || (a[0] === 'update-ref' && a.includes('-d')) || (a[0] === 'branch' && a.some((v) => ['-d', '-D'].includes(v)))), [], 'cleanup must never retire data/refs or prune unrelated metadata');
  return { result, calls };
}

beforeEach(() => { f = setup(); });
afterEach(() => cleanup(f.base));

describe('RGS-01/02 scoped Git custody', () => {
  for (const kind of ['merge', 'cherry-pick']) {
    for (const scope of ['addition', 'removal-only', 'removal-and-missing', 'amend']) {
      test(`${kind} refuses ${scope} before any mutation with exact index/HEAD/sequencer preservation`, () => {
        sequencer(f.repo, kind);
        fs.writeFileSync(path.join(f.repo, '.planning/named.md'), 'named unstaged\n');
        if (scope.startsWith('removal')) fs.unlinkSync(path.join(f.repo, '.planning/remove.md'));
        const before = snapshot(f.repo);
        const { result, calls } = runCommit({ files: scope === 'removal-only' ? [] : scope === 'removal-and-missing' ? ['.planning/optional.md'] : ['.planning/named.md'],
          removed: scope.startsWith('removal') ? ['.planning/remove.md'] : [], amend: scope === 'amend' });
        assert.equal(result.reason, 'scoped_commit_refused_during_merge');
        assertNoMutations(calls); assert.deepEqual(snapshot(f.repo), before);
      });
    }
    test(`${kind} all-missing optional additions are a no-write result`, () => {
      sequencer(f.repo, kind);
      const before = snapshot(f.repo);
      const { result, calls } = runCommit({ files: ['.planning/optional.md'] });
      assert.equal(result.reason, 'nothing_to_commit'); assertNoMutations(calls); assert.deepEqual(snapshot(f.repo), before);
    });
    test(`${kind} subrepository scope preserves its index and sequencer`, () => {
      const sub = path.join(f.repo, 'sub'); fs.mkdirSync(sub);
      git(['clone', '--no-local', f.repo, sub], f.base);
      git(['config', 'user.name', 'Fixture'], sub); git(['config', 'user.email', 'fixture@example.invalid'], sub);
      fs.writeFileSync(path.join(f.repo, '.planning/config.json'), JSON.stringify({ sub_repos: ['sub'] }));
      sequencer(sub, kind); fs.writeFileSync(path.join(sub, '.planning/named.md'), 'named\n');
      const before = snapshot(sub);
      const { result, calls } = runCommit({ files: ['sub/.planning/named.md'], subrepo: true });
      assert.equal(result.repos.sub.reason, 'scoped_commit_refused_during_merge'); assertNoMutations(calls); assert.deepEqual(snapshot(sub), before);
    });
  }
  for (const kind of ['merge', 'cherry-pick']) test(`${kind} subrepository removal-only scope is refused before mutation`, () => {
    const sub = path.join(f.repo, 'sub'); git(['clone', '--no-local', f.repo, sub], f.base);
    git(['config', 'user.name', 'Fixture'], sub); git(['config', 'user.email', 'fixture@example.invalid'], sub);
    fs.writeFileSync(path.join(f.repo, '.planning/config.json'), JSON.stringify({ sub_repos: ['sub'] }));
    sequencer(sub, kind); fs.unlinkSync(path.join(sub, '.planning/remove.md'));
    const before = snapshot(sub); const { result, calls } = runCommit({ subrepo: true, files: ['sub/.planning/remove.md'] });
    assert.equal(result.repos.sub.reason, 'scoped_commit_refused_during_merge'); assertNoMutations(calls); assert.deepEqual(snapshot(sub), before);
  });
  const faults = [
    { exitCode: 1, error: 'ETIMEDOUT', signal: 'SIGTERM' }, { exitCode: 1, error: 'ETIMEDOUT' },
    { exitCode: 127, error: 'ENOENT' }, { exitCode: 1, signal: 'SIGTERM' },
    { exitCode: 128 }, { exitCode: 0, stdout: 'not-a-sha\n' }, { exitCode: 0, stdout: '' },
    { exitCode: 1, stderr: 'unexpected diagnostic' }, { exitCode: 1, timedOut: true },
  ];
  for (const subrepo of [false, true]) for (const [i, fault] of faults.entries()) {
    test(`unknown sequencer probe ${i} refuses before mutation (${subrepo ? 'subrepo' : 'root'})`, () => {
      let repo = f.repo;
      if (subrepo) {
        repo = path.join(f.repo, 'sub'); git(['clone', '--no-local', f.repo, repo], f.base);
        fs.writeFileSync(path.join(f.repo, '.planning/config.json'), JSON.stringify({ sub_repos: ['sub'] }));
      }
      fs.writeFileSync(path.join(repo, '.planning/named.md'), 'named\n');
      fs.writeFileSync(path.join(repo, '.planning/peer.md'), 'peer\n'); git(['add', '.planning/peer.md'], repo);
      const before = snapshot(repo);
      const { result, calls } = runCommit({ repo, subrepo, files: [subrepo ? 'sub/.planning/named.md' : '.planning/named.md'], fault: { ref: 'MERGE_HEAD', ...fault } });
      assert.equal((subrepo ? result.repos.sub : result).reason, 'scoped_commit_sequencer_unknown');
      assertNoMutations(calls); assert.deepEqual(snapshot(repo), before);
    });
  }
  for (const mode of ['addition', 'removal', 'mixed', 'amend']) test(`ordinary ${mode} commits only declared paths`, () => {
    fs.writeFileSync(path.join(f.repo, '.planning/named.md'), 'named\n');
    fs.writeFileSync(path.join(f.repo, '.planning/peer.md'), 'peer\n'); git(['add', '.planning/peer.md'], f.repo);
    if (['removal', 'mixed'].includes(mode)) fs.unlinkSync(path.join(f.repo, '.planning/remove.md'));
    const { result, calls } = runCommit({ files: mode === 'removal' ? [] : ['.planning/named.md'], removed: ['removal', 'mixed'].includes(mode) ? ['.planning/remove.md'] : [], amend: mode === 'amend' });
    assert.equal(result.committed, true, JSON.stringify(result));
    assert.ok(calls.find((a) => a[0] === 'commit').includes('--'));
    const changed = mode === 'amend' ? [] : git(['diff', 'HEAD~1', 'HEAD', '--name-only'], f.repo).split('\n');
    if (mode !== 'amend') assert.deepEqual(changed, mode === 'removal' ? ['.planning/remove.md'] : mode === 'mixed' ? ['.planning/named.md', '.planning/remove.md'] : ['.planning/named.md']);
    assert.equal(git(['show', 'HEAD:.planning/peer.md'], f.repo), 'base');
    assert.match(git(['diff', '--cached', '--name-only'], f.repo), /peer\.md/);
  });
});

describe('additional scoped preservation controls', () => {
  test('ordinary subrepo commit scopes its declared paths and retains unrelated staging', () => {
    const sub = path.join(f.repo, 'sub'); git(['clone', '--no-local', f.repo, sub], f.base);
    git(['config', 'user.name', 'Fixture'], sub); git(['config', 'user.email', 'fixture@example.invalid'], sub);
    fs.writeFileSync(path.join(f.repo, '.planning/config.json'), JSON.stringify({ sub_repos: ['sub'] }));
    fs.writeFileSync(path.join(sub, '.planning/named.md'), 'named\n');
    fs.writeFileSync(path.join(sub, '.planning/peer.md'), 'peer\n'); git(['add', '.planning/peer.md'], sub);
    const { result, calls } = runCommit({ files: ['sub/.planning/named.md'], subrepo: true });
    assert.equal(result.repos.sub.committed, true, JSON.stringify(result));
    assert.deepEqual(git(['diff', 'HEAD~1', 'HEAD', '--name-only'], sub).split('\n'), ['.planning/named.md']);
    assert.equal(git(['diff', '--cached', '--name-only'], sub), '.planning/peer.md');
    assert.ok(calls.find((a) => a[0] === 'commit').includes('--'));
  });
  for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) test(`${ref} unknown refuses removal-only scope before index mutation`, () => {
    fs.unlinkSync(path.join(f.repo, '.planning/remove.md'));
    fs.writeFileSync(path.join(f.repo, '.planning/peer.md'), 'peer\n'); git(['add', '.planning/peer.md'], f.repo);
    const before = snapshot(f.repo);
    const { result, calls } = runCommit({ files: ['.planning/absent.md'], removed: ['.planning/remove.md'], fault: { ref, exitCode: 1, error: 'ETIMEDOUT' } });
    assert.equal(result.reason, 'scoped_commit_sequencer_unknown'); assertNoMutations(calls); assert.deepEqual(snapshot(f.repo), before);
  });
});

describe('RGS-03/04/05 SUMMARY evidence preservation', () => {
  function rescueFixture() {
    const w = worker();
    const rel = '.planning/01-SUMMARY.md'; const src = path.join(w.wt, rel); const dst = path.join(f.repo, rel);
    fs.writeFileSync(src, 'worker\n');
    return { ...w, src, dst, rel };
  }
  function rescue(w, deps = {}) { return safety.rescueSummaryArtifacts(w.wt, f.repo, { findSummaryFiles: () => [w.src], ...deps }); }
  test('absent destination is copied with exact bytes and source retained', () => {
    const w = rescueFixture(); const r = rescue(w);
    assert.deepEqual(r.failures, []); assert.deepEqual([...r.rescuedRelPaths], [w.rel]); assert.deepEqual(fs.readFileSync(w.dst), fs.readFileSync(w.src));
  });
  for (const [name, a, b, identical] of [['equal', [255], [255], true], ['invalid-utf8-divergent', [255], [254], false], ['text-divergent', [65], [66], false]]) {
    test(`${name} compares raw bytes and preserves both files`, () => {
      const w = rescueFixture(); fs.writeFileSync(w.src, Buffer.from(a)); fs.writeFileSync(w.dst, Buffer.from(b));
      const r = rescue(w); assert.equal(r.rescuedRelPaths.has(w.rel), identical); assert.equal(r.failures.length, identical ? 0 : 1);
      assert.deepEqual(fs.readFileSync(w.src), Buffer.from(a)); assert.deepEqual(fs.readFileSync(w.dst), Buffer.from(b));
    });
  }
  for (const identical of [false, true]) test(`destination created during copy is ${identical ? 'recognized' : 'preserved as divergent'}`, () => {
    const w = rescueFixture(); const late = identical ? 'worker\n' : 'late parent evidence\n';
    const r = rescue(w, { copyFileSync: (src, dst, flags) => { assert.equal(flags, fs.constants.COPYFILE_EXCL); fs.writeFileSync(dst, late); fs.copyFileSync(src, dst, flags); } });
    assert.equal(r.rescuedRelPaths.has(w.rel), identical); assert.equal(fs.readFileSync(w.dst, 'utf8'), late); assert.equal(fs.readFileSync(w.src, 'utf8'), 'worker\n');
  });
  for (const kind of ['destination', 'dangling', 'parent', 'source', 'late-symlink']) test(`rejects ${kind} symlink escape`, () => {
    const w = rescueFixture(); const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
    const sentinel = path.join(outside, 'sentinel'); fs.writeFileSync(sentinel, 'outside evidence\n');
    if (kind === 'source') { fs.unlinkSync(w.src); fs.symlinkSync(sentinel, w.src); }
    if (['destination', 'dangling'].includes(kind)) fs.symlinkSync(kind === 'dangling' ? path.join(outside, 'missing') : sentinel, w.dst);
    if (kind === 'parent') { cleanup(path.join(f.repo, '.planning')); fs.symlinkSync(outside, path.join(f.repo, '.planning')); }
    const r = rescue(w, kind === 'late-symlink' ? { copyFileSync: (src, dst, flags) => { fs.symlinkSync(sentinel, dst); fs.copyFileSync(src, dst, flags); } } : {});
    assert.equal(r.rescuedRelPaths.size, 0); assert.equal(r.failures.length, 1); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside evidence\n');
    assert.equal(fs.existsSync(path.join(outside, '01-SUMMARY.md')), false); assert.equal(fs.existsSync(path.join(outside, 'missing')), false);
  });
  for (const code of ['EIO', 'EACCES']) test(`${code} while resolving an existing parent fails closed`, () => {
    const w = rescueFixture(); const r = rescue(w, { realpathSync: (p) => { if (p === path.dirname(w.dst)) throw Object.assign(new Error(code), { code }); return fs.realpathSync(p); } });
    assert.equal(r.failures.length, 1); assert.equal(fs.existsSync(w.dst), false); assert.equal(fs.readFileSync(w.src, 'utf8'), 'worker\n');
  });
  test('true missing destination components may be appended to a verified existing ancestor', () => {
    const w = rescueFixture(); const nested = path.join(w.wt, '.planning/new/01-SUMMARY.md'); fs.mkdirSync(path.dirname(nested)); fs.renameSync(w.src, nested); w.src = nested;
    const r = rescue(w); assert.deepEqual(r.failures, []); assert.equal(fs.readFileSync(path.join(f.repo, '.planning/new/01-SUMMARY.md'), 'utf8'), 'worker\n');
  });
  test('unreadable byte comparison preserves both copies', () => {
    const w = rescueFixture(); fs.writeFileSync(w.dst, 'parent\n'); const r = rescue(w, { readFileBytes: () => { throw new Error('EIO'); } });
    assert.equal(r.failures.length, 1); assert.equal(fs.readFileSync(w.dst, 'utf8'), 'parent\n'); assert.equal(fs.readFileSync(w.src, 'utf8'), 'worker\n');
  });
});

describe('RGS-06/07/08/09 accepted integration and conservative retirement', () => {
  test('real Git independently verifies accepted and recovery commits, integrates pinned head, retains checkout and branch', () => {
    const w = worker(); const { result, calls } = runCleanup(w.entry);
    assert.equal(result.entries[0].status, 'integrated_retained', JSON.stringify(result)); assert.equal(result.entries[0].integrated, true); assert.equal(result.entries[0].reason, 'retirement_manual_root_handoff_required');
    assert.ok(fs.existsSync(w.wt)); assert.equal(git(['rev-parse', `refs/heads/${w.entry.branch}`], f.repo), w.entry.retirement_authorization.accepted_head);
    assert.equal(git(['merge-base', '--is-ancestor', w.entry.retirement_authorization.accepted_head, 'HEAD'], f.repo), '');
    assert.ok(calls.find((a) => a[0] === 'merge' && a[1] === w.entry.retirement_authorization.accepted_head));
    for (const a of calls.filter((a) => a[0] === 'rev-parse' && a.includes('--verify'))) assert.equal(a.filter((v) => v.endsWith('^{commit}')).length <= 1, true);
    assert.ok(calls.filter((a) => a.join(' ') === 'worktree list --porcelain').length >= 3, 'pre-rescue, pre-merge and post-merge registration reads must be fresh');
  });
  test('missing authority blocks before ANY rescue or parent write', () => {
    const w = worker(); delete w.entry.retirement_authorization;
    const src = path.join(w.wt, '.planning/01-SUMMARY.md'); fs.writeFileSync(src, 'worker\n'); const before = snapshot(f.repo); let scans = 0;
    const { result } = runCleanup(w.entry, { findSummaryFiles: () => { scans++; return [src]; } });
    assert.equal(result.entries[0].reason, 'retirement_authorization_required'); assert.equal(scans, 0); assert.equal(result.entries[0].integrated, false);
    assert.equal(fs.existsSync(path.join(f.repo, '.planning/01-SUMMARY.md')), false); assert.deepEqual(snapshot(f.repo), before); assert.equal(fs.readFileSync(src, 'utf8'), 'worker\n');
  });
  for (const mode of ['missing-record', 'record-symlink', 'wrong-owner', 'wrong-path', 'running', 'failed', 'malformed-date', 'live', 'unknown']) test(`${mode} owner cannot authorize rescue or integration`, () => {
    const w = worker(); const file = w.wt + '.worker.json'; const record = JSON.parse(fs.readFileSync(file));
    if (mode === 'missing-record') fs.unlinkSync(file);
    else if (mode === 'record-symlink') { const copy = path.join(f.base, 'copy.json'); fs.renameSync(file, copy); fs.symlinkSync(copy, file); }
    else { if (mode === 'wrong-owner') record.agentId = 'other'; if (mode === 'wrong-path') record.worktreePath = f.repo; if (mode === 'running') record.state = 'running'; if (mode === 'failed') record.exitCode = 2; if (mode === 'malformed-date') record.completedAt = 'invalid'; fs.writeFileSync(file, JSON.stringify(record)); }
    const before = snapshot(f.repo); let scans = 0;
    const { result, calls } = runCleanup(w.entry, { findSummaryFiles: () => { scans++; return []; }, isPidAlive: () => { if (mode === 'unknown') throw new Error('EPERM'); return mode === 'live'; } });
    assert.equal(result.entries[0].integrated, false); assert.match(result.entries[0].reason, /^retirement_owner_/); assert.equal(scans, 0); assert.equal(calls.some((a) => a[0] === 'merge'), false); assert.deepEqual(snapshot(f.repo), before);
  });
  for (const mode of ['same-ref', 'raw-sha', 'options', 'unrelated', 'symbolic', 'missing', 'stale-head']) test(`${mode} recovery/acceptance proof blocks`, () => {
    const w = worker(); const auth = w.entry.retirement_authorization;
    if (mode === 'same-ref') auth.recovery_ref = `refs/heads/${w.entry.branch}`;
    if (mode === 'raw-sha') auth.recovery_ref = auth.accepted_head;
    if (mode === 'options') auth.recovery_ref = '--help';
    if (mode === 'missing') auth.recovery_ref = 'refs/forensic-recovery/missing';
    if (mode === 'symbolic') { git(['symbolic-ref', 'refs/forensic-recovery/alias', `refs/heads/${w.entry.branch}`], f.repo); auth.recovery_ref = 'refs/forensic-recovery/alias'; }
    if (mode === 'unrelated') git(['update-ref', auth.recovery_ref, w.entry.expected_base], f.repo);
    if (mode === 'stale-head') { fs.writeFileSync(path.join(w.wt, 'late.txt'), 'late\n'); git(['add', 'late.txt'], w.wt); git(['commit', '-m', 'late'], w.wt); }
    const before = snapshot(f.repo); const { result, calls } = runCleanup(w.entry);
    assert.equal(result.entries[0].integrated, false); assert.equal(calls.some((a) => a[0] === 'merge'), false); assert.deepEqual(snapshot(f.repo), before); assert.ok(fs.existsSync(w.wt));
  });
  for (const race of ['head', 'lock', 'recovery', 'owner', 'dirty', 'ignored', 'scan']) test(`${race} changes after merge are reported integrated and retained`, () => {
    const w = worker(); let merged = false;
    const { result } = runCleanup(w.entry, {
      readDirSafe: race === 'scan' ? () => null : undefined,
      execGit: (a, o, real) => {
        const r = real(a, o);
        if (a[0] === 'merge' && r.exitCode === 0 && !merged) {
          merged = true;
          if (race === 'head') { fs.writeFileSync(path.join(w.wt, 'late.txt'), 'late\n'); git(['add', 'late.txt'], w.wt); git(['commit', '-m', 'late'], w.wt); }
          if (race === 'lock') git(['worktree', 'lock', w.wt, '--reason', 'owner resumed'], f.repo);
          if (race === 'recovery') git(['update-ref', w.entry.retirement_authorization.recovery_ref, w.entry.expected_base], f.repo);
          if (race === 'owner') { const p = w.wt + '.worker.json'; const rec = JSON.parse(fs.readFileSync(p)); rec.state = 'running'; fs.writeFileSync(p, JSON.stringify(rec)); }
          if (race === 'dirty') fs.writeFileSync(path.join(w.wt, 'late.txt'), 'unique late work\n');
          if (race === 'ignored') { fs.writeFileSync(path.join(w.wt, '.gitignore'), 'ignored.txt\n'); fs.writeFileSync(path.join(w.wt, 'ignored.txt'), 'unique ignored\n'); }
        }
        return r;
      },
    });
    assert.equal(result.entries[0].status, 'integrated_retained', JSON.stringify(result)); assert.equal(result.entries[0].integrated, true); assert.ok(fs.existsSync(w.wt));
    assert.ok(git(['rev-parse', `refs/heads/${w.entry.branch}`], f.repo));
    if (race === 'scan') assert.equal(result.entries[0].reason, 'retirement_nested_scan_unknown');
    if (race === 'lock') assert.equal(result.entries[0].reason, 'retirement_registration_changed');
  });
  test('absent registered worktree integrates only accepted commit and never prunes another absent registration', () => {
    const w = worker(); const other = path.join(f.base, 'other'); git(['worktree', 'add', '-b', 'worktree-agent-other', other], f.repo);
    cleanup(w.wt); cleanup(other); const listed = git(['worktree', 'list', '--porcelain'], f.repo).split('\n\n').slice(1);
    const { result } = runCleanup(w.entry);
    assert.equal(result.entries[0].status, 'integrated_retained'); assert.deepEqual(git(['worktree', 'list', '--porcelain'], f.repo).split('\n\n').slice(1), listed);
    assert.ok(git(['rev-parse', 'refs/heads/worktree-agent-other'], f.repo));
  });
  for (const mode of ['clean', 'unreadable', 'lstat-failure', 'depth-bound', 'node-modules', 'nested', 'symlink']) test(`nested inventory returns three states: ${mode}`, () => {
    const w = worker(); const deps = {};
    if (mode === 'unreadable') deps.readDirSafe = () => null;
    if (mode === 'lstat-failure') deps.lstatSync = () => { throw new Error('EIO'); };
    if (mode === 'depth-bound') fs.mkdirSync(path.join(w.wt, 'a/b/c/d'), { recursive: true });
    if (mode === 'node-modules') fs.mkdirSync(path.join(w.wt, 'node_modules'));
    if (mode === 'nested') { fs.mkdirSync(path.join(w.wt, 'nested/.git'), { recursive: true }); }
    if (mode === 'symlink') fs.symlinkSync(f.repo, path.join(w.wt, 'link'));
    assert.equal(safety.findNestedCheckout(w.wt, deps).state, mode === 'clean' ? 'absent' : mode === 'nested' ? 'present' : 'unknown');
  });
});


describe('accepted cleanup preserves parent state and isolates entry failures', () => {
  for (const kind of ['merge', 'cherry-pick']) test(`a pre-existing parent ${kind} is never aborted or staged by cleanup`, () => {
    const w = worker(); sequencer(f.repo, kind);
    const before = snapshot(f.repo); let scans = 0;
    const { result, calls } = runCleanup(w.entry, { findSummaryFiles: () => { scans++; return []; } });
    assert.equal(result.entries[0].reason, 'integration_parent_sequencer_unverified');
    assert.equal(scans, 0); assert.deepEqual(snapshot(f.repo), before);
    assert.equal(calls.some((a) => a[0] === 'merge'), false);
  });
  for (const failure of ['branch', 'base', 'deletions', 'dirty', 'authority', 'recovery']) test(`${failure} block does not prevent an independent accepted entry from integrating`, () => {
    const first = worker('first'); const next = worker('next');
    if (failure === 'branch') first.entry.branch = 'worktree-agent-missing';
    if (failure === 'base') first.entry.expected_base = '0'.repeat(40);
    if (failure === 'dirty') fs.writeFileSync(path.join(first.wt, 'unique.txt'), 'unfinished\n');
    if (failure === 'authority') delete first.entry.retirement_authorization;
    if (failure === 'recovery') git(['update-ref', first.entry.retirement_authorization.recovery_ref, first.entry.expected_base], f.repo);
    const real = require('../gsd-core/bin/lib/shell-command-projection.cjs').execGit; const calls = [];
    const result = safety.executeWorktreeWaveCleanupPlan(safety.planWorktreeWaveCleanup(f.repo, [first.entry, next.entry]), { isPidAlive: () => false,
      execGit: (a, o) => { calls.push(a); if (failure === 'deletions' && a[0] === 'diff' && a.includes(`HEAD...${first.entry.branch}`)) return { exitCode: 128, stdout: '', stderr: 'injected failure' }; return real(a, o); } });
    assert.equal(result.entries[0].integrated, false, JSON.stringify(result)); assert.equal(result.entries[1].integrated, true, JSON.stringify(result));
    assert.equal(result.entries[1].status, 'integrated_retained'); assert.deepEqual(result.pending, []);
    assert.ok(fs.existsSync(first.wt)); assert.ok(fs.existsSync(next.wt));
    assert.equal(calls.some((a) => a[0] === 'worktree' && ['remove', 'unlock', 'prune'].includes(a[1])), false);
  });
  for (const unknown of [false, true]) test(`unrecoverable or unknown parent merge state halts the remaining wave (${unknown})`, () => {
    const first = worker('first'); const next = worker('next'); const before = snapshot(f.repo);
    const real = require('../gsd-core/bin/lib/shell-command-projection.cjs').execGit; let attempted = false;
    const result = safety.executeWorktreeWaveCleanupPlan(safety.planWorktreeWaveCleanup(f.repo, [first.entry, next.entry]), { isPidAlive: () => false,
      execGit: (a, o) => {
        if (a[0] === 'merge' && a[1] !== '--abort') { attempted = true; return { exitCode: 1, stdout: '', stderr: 'injected merge failure' }; }
        if (attempted && a[0] === 'merge') return { exitCode: 128, stdout: '', stderr: 'abort refused' };
        if (attempted && a.at(-1) === 'MERGE_HEAD') return unknown ? { exitCode: 1, stdout: '', stderr: '', timedOut: true } : { exitCode: 0, stdout: first.entry.retirement_authorization.accepted_head, stderr: '' };
        return real(a, o);
      } });
    assert.equal(result.entries.length, 1); assert.equal(result.entries[0].integrated, false); assert.deepEqual(result.pending.map((e) => e.branch), [next.entry.branch]);
    assert.deepEqual(snapshot(f.repo), before); assert.ok(fs.existsSync(first.wt)); assert.ok(fs.existsSync(next.wt));
  });
});


describe('integration status is observed independently of merge exit', () => {
  for (const outcome of ['absent', 'unknown']) test(`successful merge wrapper with ${outcome} reachability is retained with truthful integration state`, () => {
    const w = worker(); let merged = false;
    const { result } = runCleanup(w.entry, { execGit: (a, o, real) => {
      const r = real(a, o);
      if (a[0] === 'merge' && a[1] !== '--abort' && r.exitCode === 0) {
        merged = true;
        if (outcome === 'absent') git(['update-ref', 'refs/heads/main', w.entry.expected_base, git(['rev-parse', 'HEAD'], f.repo)], f.repo);
      }
      if (merged && a[0] === 'merge-base' && a.at(-1) === 'HEAD' && outcome === 'unknown') return { exitCode: 1, stdout: '', stderr: '', timedOut: true };
      return r;
    } });
    assert.equal(result.entries[0].reason, 'integration_not_observed');
    assert.equal(result.entries[0].integrated, outcome === 'absent' ? false : null);
    assert.equal(result.entries[0].status, outcome === 'absent' ? 'blocked' : 'integration_unknown_retained');
    assert.ok(fs.existsSync(w.wt)); assert.ok(git(['rev-parse', `refs/heads/${w.entry.branch}`], f.repo));
  });
});

describe('registration path identity', () => {
  function aliasedWorker(t) {
    const w = worker();
    const alias = path.join(f.base, 'RUNNER~1');
    fs.symlinkSync(f.base, alias, 'junction');
    const entry = { ...w.entry, worktree_path: path.join(alias, 'worker') };
    const recordPath = w.wt + '.worker.json';
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    fs.writeFileSync(recordPath, JSON.stringify({ ...record, worktreePath: entry.worktree_path }));
    const legacy = fs.realpathSync;
    const native = legacy.native;
    const nativeCalls = [];
    // Model the Windows distinction at the resolver boundary, using a real
    // filesystem alias and actual Git everywhere else. This is not Windows
    // acceptance: the JavaScript resolver preserves a non-symlink 8.3 name,
    // whereas the native resolver obtains the filesystem's canonical name.
    t.mock.method(fs, 'realpathSync', (target, ...options) => {
      if (typeof target === 'string' && (target === alias || target.startsWith(alias + path.sep))) return path.resolve(target);
      return legacy(target, ...options);
    });
    t.mock.method(fs.realpathSync, 'native', (target, ...options) => {
      nativeCalls.push(target);
      return native(target, ...options);
    });
    return { ...w, alias, entry, nativeCalls };
  }

  for (const absent of [false, true]) test(`native filesystem evidence identifies the ${absent ? 'absent' : 'present'} registered alias`, (t) => {
    const w = aliasedWorker(t);
    assert.notEqual(fs.realpathSync(w.entry.worktree_path), fs.realpathSync(w.wt), 'the JavaScript resolver alone must reproduce distinct spellings');
    assert.equal(fs.realpathSync.native(w.entry.worktree_path), fs.realpathSync.native(w.wt), 'the two paths actually identify the same checkout');
    w.nativeCalls.length = 0;
    if (absent) cleanup(w.wt);
    const { result, calls } = runCleanup(w.entry);
    assert.equal(result.entries[0].reason, 'retirement_manual_root_handoff_required', JSON.stringify(result));
    assert.equal(result.entries[0].integrated, true);
    assert.equal(result.entries[0].status, 'integrated_retained');
    assert.ok(w.nativeCalls.includes(absent ? w.alias : w.entry.worktree_path), 'registration must use native evidence for the existing path or ancestor');
    assert.ok(calls.filter(a => a.join(' ') === 'worktree list --porcelain').length >= 3, 'all registration boundaries must be freshly observed');
    assert.equal(calls.filter(a => a[0] === 'merge').length, 1);
    assert.equal(git(['rev-parse', w.entry.retirement_authorization.recovery_ref], f.repo), w.entry.retirement_authorization.accepted_head);
    assert.equal(git(['rev-parse', `refs/heads/${w.entry.branch}`], f.repo), w.entry.retirement_authorization.accepted_head);
    assert.equal(fs.existsSync(w.wt), !absent, 'only fixture setup may remove the checkout');
  });

  for (const boundary of [1, 2, 3]) for (const fault of ['missing', 'branch', 'locked', 'unverified', 'different-directory', 'realpath-error']) {
    test(`${fault} registration at fresh boundary ${boundary} retains the alias and recovery`, (t) => {
      const w = aliasedWorker(t);
      const other = path.join(f.base, 'worker-other'); fs.mkdirSync(other);
      const before = snapshot(f.repo);
      let reads = 0;
      const native = fs.realpathSync.native;
      t.mock.method(fs.realpathSync, 'native', (target, ...options) => {
        if (fault === 'realpath-error' && reads >= boundary && target === w.entry.worktree_path) throw Object.assign(new Error('injected native identity error'), { code: 'EACCES' });
        return native(target, ...options);
      });
      const { result, calls } = runCleanup(w.entry, { execGit: (a, o, real) => {
        const r = real(a, o);
        if (a.join(' ') !== 'worktree list --porcelain' || ++reads < boundary) return r;
        if (fault === 'unverified') return { ...r, exitCode: 1, stdout: '', stderr: 'injected list failure', timedOut: true };
        const blocks = r.stdout.split('\n\n').filter(Boolean);
        const index = blocks.findIndex(block => block.includes(`branch refs/heads/${w.entry.branch}`));
        assert.ok(index >= 0, 'the real fixture registration must exist before substituting its observation');
        if (fault === 'missing') blocks.splice(index, 1);
        if (fault === 'branch') blocks[index] = blocks[index].replace(`branch refs/heads/${w.entry.branch}`, 'branch refs/heads/worktree-agent-other');
        if (fault === 'locked') blocks[index] += '\nlocked resumed owner';
        if (fault === 'different-directory') blocks[index] = blocks[index].replace(/^worktree .*/m, `worktree ${other}`);
        return { ...r, stdout: blocks.join('\n\n') + '\n\n' };
      } });
      assert.equal(reads, boundary, 'no registration result may be cached across boundaries');
      assert.equal(result.entries[0].reason, boundary === 1 ? 'retirement_registration_unverified' : 'retirement_registration_changed', JSON.stringify(result));
      assert.equal(result.entries[0].integrated, boundary === 3);
      assert.equal(result.entries[0].status, boundary === 3 ? 'integrated_retained' : 'blocked');
      assert.equal(calls.filter(a => a[0] === 'merge').length, boundary === 3 ? 1 : 0);
      if (boundary < 3) assert.deepEqual(snapshot(f.repo), before);
      assert.ok(fs.existsSync(w.wt));
      assert.equal(git(['rev-parse', w.entry.retirement_authorization.recovery_ref], f.repo), w.entry.retirement_authorization.accepted_head);
      assert.equal(git(['rev-parse', `refs/heads/${w.entry.branch}`], f.repo), w.entry.retirement_authorization.accepted_head);
    });
  }

  test('a different common directory with the same branch and accepted commit is not a registered alias', () => {
    const w = worker();
    const foreign = path.join(f.base, 'foreign');
    git(['clone', '--no-local', f.repo, foreign], f.base);
    git(['checkout', '-b', w.entry.branch, w.entry.retirement_authorization.accepted_head], foreign);
    const record = JSON.parse(fs.readFileSync(w.wt + '.worker.json', 'utf8'));
    fs.writeFileSync(foreign + '.worker.json', JSON.stringify({ ...record, worktreePath: foreign }));
    assert.notEqual(fs.realpathSync.native(path.resolve(foreign, git(['rev-parse', '--git-common-dir'], foreign))), fs.realpathSync.native(path.resolve(f.repo, git(['rev-parse', '--git-common-dir'], f.repo))));
    const before = snapshot(f.repo);
    const { result, calls } = runCleanup({ ...w.entry, worktree_path: foreign });
    assert.equal(result.entries[0].reason, 'retirement_registration_unverified', JSON.stringify(result));
    assert.equal(result.entries[0].integrated, false);
    assert.equal(calls.some(a => a[0] === 'merge'), false);
    assert.deepEqual(snapshot(f.repo), before);
    assert.ok(fs.existsSync(foreign)); assert.ok(fs.existsSync(w.wt));
  });
});
