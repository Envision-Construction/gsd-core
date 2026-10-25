'use strict';

// ORCH-03: test the maintained instructions as executable data. No live checkout
// is retired. Original source/helper tests and generated modules remain untouched.
const { before, after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createTempDir, cleanup, installSpawnEnv, homeSandboxEnv, TOOLS_PATH } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { authorizeFixtureEntry, git, snapshotFixtureTree } = require('./helpers/custody-fixture.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS = path.join(ROOT, 'gsd-core/workflows');
const CONSUMERS = ['execute-phase.md', 'quick.md', 'quick-batch/steps/merge-wave.md'];
let f;

function readWorkflow(relative) {
  return fs.readFileSync(path.join(WORKFLOWS, relative), 'utf8');
}

function shellBlocks(content) {
  const blocks = [];
  let lines = null;
  for (const line of splitLines(content)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (lines) { blocks.push(lines.join('\n')); lines = null; }
      else if (['```bash', '```sh', '```zsh', '```shell'].includes(trimmed)) lines = [];
    } else if (lines) lines.push(line);
  }
  return blocks;
}

function retirementCommands(content) {
  const found = [];
  for (const block of shellBlocks(content)) {
    const joined = block.replaceAll('\\\n', ' ');
    for (const command of joined.split(/[;|&\r\n]/)) {
      const words = command.trim().split(/\s+/);
      const gitIndex = words.indexOf('git');
      if (gitIndex >= 0) {
        const argv = words.slice(gitIndex + 1);
        const wt = argv.indexOf('worktree');
        const branch = argv.indexOf('branch');
        const update = argv.indexOf('update-ref');
        if ((wt >= 0 && argv.slice(wt + 1).some(w => ['remove', 'unlock', 'prune'].includes(w))) ||
            (branch >= 0 && argv.slice(branch + 1).some(w => w === '--delete' || /^-[a-zA-Z]*[dD][a-zA-Z]*$/.test(w))) ||
            (update >= 0 && argv.slice(update + 1).some(w => ['-d', '--delete', '--stdin'].includes(w)))) found.push(command.trim());
      }
      if (words.includes('rm') && words.some(w => w.includes('$WORKSPACE_PATH') || w.includes('$WT_PATH'))) found.push(command.trim());
    }
  }
  return found;
}

function workflowFiles(dir = WORKFLOWS) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? workflowFiles(full) : entry.name.endsWith('.md') ? [full] : [];
  });
}

function spawn(program, args, overrides = {}) {
  const result = cp.spawnSync(program, args, {
    cwd: f.repo, env: f.env, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, ...overrides,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function cli(manifest, extra = []) {
  return spawn(process.execPath, [...extra, TOOLS_PATH, 'query', 'worktree.cleanup-wave', '--manifest', manifest, '--exit-contract=v1']);
}

function runConsumer(relative, response, status, { manifest = f.manifest, shell = 'bash' } = {}) {
  const blocks = shellBlocks(readWorkflow(relative)).filter(b => b.includes('RETENTION_RESULT='));
  assert.equal(blocks.length, 1, 'one actual bounded cleanup callsite, including the custom-merge path');
  const responseFile = path.join(f.base, 'response.json');
  const manifestFile = path.join(f.base, 'consumer-manifest.json');
  const traceFile = path.join(f.base, 'consumer.trace');
  const scriptFile = path.join(f.base, 'consumer.sh');
  fs.writeFileSync(responseFile, typeof response === 'string' ? response : JSON.stringify(response));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(traceFile, '');
  fs.writeFileSync(scriptFile, `set -eu\ngsd_run() { printf '%s\\n' "$*" >> "$TRACE_FILE"; cat "$RESPONSE_FILE"; return "$RESPONSE_EXIT"; }\n${blocks[0]}\nprintf 'UNREACHABLE_SUCCESS\\n'\n`);
  const result = spawn(shell, [scriptFile], { env: { ...f.env,
    RESPONSE_FILE: responseFile, RESPONSE_EXIT: String(status), TRACE_FILE: traceFile,
    WAVE_WORKTREE_MANIFEST: manifestFile, QUICK_WORKTREE_MANIFEST: manifestFile,
    MERGE_MANIFEST_PATH: manifestFile, EXPECTED_BRANCH: 'main',
  } });
  assert.doesNotMatch(result.stdout, /UNREACHABLE_SUCCESS/);
  return { ...result, trace: fs.readFileSync(traceFile, 'utf8') };
}

before(() => {
  const base = createTempDir('gsd-workflow-retention-');
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const wt = path.join(base, 'worker');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  f = { base, repo, home, wt, env: installSpawnEnv({ ...homeSandboxEnv(home), GSD_STRICT_LIVE_CONFIG_GUARD: '1' }) };
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Fixture'], repo);
  git(['config', 'user.email', 'fixture@example.invalid'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.mkdirSync(path.join(base, 'hooks'));
  git(['config', 'core.hooksPath', path.join(base, 'hooks')], repo);
  fs.mkdirSync(path.join(repo, '.planning'));
  fs.writeFileSync(path.join(repo, '.planning/config.json'), JSON.stringify({ commit_docs: true, branching_strategy: 'none' }));
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(['add', '.'], repo); git(['commit', '-m', 'base'], repo);
  f.baseHead = git(['rev-parse', 'HEAD'], repo);
  git(['worktree', 'add', '-b', 'worktree-agent-cli', wt], repo);
  fs.writeFileSync(path.join(wt, 'accepted.txt'), 'accepted\n');
  git(['add', 'accepted.txt'], wt); git(['commit', '-m', 'worker'], wt);
  // A genuinely exited fixture PID, never an assumed live-machine PID.
  const exited = spawn(process.execPath, ['-e', 'console.log(process.pid)']);
  assert.equal(exited.status, 0);
  const entry = authorizeFixtureEntry(repo, { agent_id: 'cli', worktree_path: wt,
    branch: 'worktree-agent-cli', expected_base: f.baseHead }, { pid: Number(exited.stdout.trim()) });
  f.entry = entry;
  f.manifest = { orchestrator_root: repo, worktrees: [entry] };
  f.manifestPath = path.join(base, 'manifest.json');
  const unsignedPath = path.join(base, 'unsigned.json');
  const unsigned = { ...entry }; delete unsigned.retirement_authorization;
  fs.writeFileSync(unsignedPath, JSON.stringify({ worktrees: [unsigned] }));
  f.refused = cli(unsignedPath);
  f.afterRefusal = git(['rev-parse', 'HEAD'], repo);
  fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  f.accepted = cli(f.manifestPath);
  // Use a fresh entry for the observation fault. Reusing an already-integrated
  // entry changes its merge-base and correctly refuses before observation.
  const unknownWt = path.join(base, 'unknown-worker');
  const unknownBase = git(['rev-parse', 'HEAD'], repo);
  git(['worktree', 'add', '-b', 'worktree-agent-unknown', unknownWt], repo);
  fs.writeFileSync(path.join(unknownWt, 'unknown.txt'), 'unknown observation fixture\n');
  git(['add', 'unknown.txt'], unknownWt); git(['commit', '-m', 'unknown worker'], unknownWt);
  const unknownEntry = authorizeFixtureEntry(repo, { agent_id: 'unknown', worktree_path: unknownWt,
    branch: 'worktree-agent-unknown', expected_base: unknownBase }, { pid: Number(exited.stdout.trim()) });
  f.unknownManifest = { orchestrator_root: repo, worktrees: [unknownEntry] };
  const unknownManifestPath = path.join(base, 'unknown-manifest.json');
  fs.writeFileSync(unknownManifestPath, JSON.stringify(f.unknownManifest));
  // Test-only preload changes one observation result, then executes the real CLI.
  // It neither changes production source nor wraps/replaces the production verb.
  const preload = path.join(base, 'unknown-observation.cjs');
  fs.writeFileSync(preload, `const p = require(${JSON.stringify(path.join(ROOT, 'gsd-core/bin/lib/shell-command-projection.cjs'))});\nconst real = p.execGit;\np.execGit = (args, opts) => {\n  if (args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[2] === ${JSON.stringify(unknownEntry.retirement_authorization.accepted_head)} && args[3] === 'HEAD') return { exitCode: 128, stdout: '', stderr: 'injected observation unavailable', signal: null, timedOut: false };\n  return real(args, opts);\n};\n`);
  f.unknown = cli(unknownManifestPath, ['--require', preload]);
});

after(() => { if (f) cleanup(f.base); });

describe('ORCH-03 maintained workflow retirement inventory', () => {
  test('every maintained workflow has no direct automatic worktree/ref retirement command', () => {
    const dangerous = workflowFiles().flatMap(file => retirementCommands(fs.readFileSync(file, 'utf8')).map(command => ({ file: path.relative(WORKFLOWS, file), command })));
    assert.deepEqual(dangerous, []);
  });

  for (const command of [
    'git worktree unlock "$WT" 2>/dev/null || true',
    'git worktree remove "$WT" --force', 'git worktree prune',
    'git branch -D "$WT_BRANCH"', 'git branch -q -D "$PR_BRANCH"',
    'git branch -d "$branch" 2>/dev/null || git branch -D "$branch"',
    'git -C "$SOURCE_REPO_PATH" worktree remove "$WORKSPACE_PATH/$REPO_NAME"',
    'git update-ref -d refs/heads/worker "$OLD_SHA"',
    'rm -rf "$WORKSPACE_PATH"', 'git worktree \\\nremove "$WT"',
  ]) {
    test(`the inventory rejects the actual legacy command shape: ${command}`, () => {
      assert.notEqual(retirementCommands('```bash\n' + command + '\n```').length, 0);
    });
  }

  test('retirement policy accounts for writers, inventories, exact identity and independent recovery', () => {
    const policy = readWorkflow('execute-phase/steps/worktree-recovery-policy.md');
    for (const term of ['all writers', 'ignored', 'nested', 'registration', 'exact current HEAD',
      'independent', 'expected old SHA', 'non-forced', 'phase product acceptance']) assert.ok(policy.includes(term), term);
    const execute = readWorkflow('execute-phase.md');
    assert.doesNotMatch(execute, /force-removes the worktree|must be fully removed/);
    assert.match(execute, /same guarded snippet above once/);
    assert.match(readWorkflow('quick-batch/steps/merge-wave.md'), /"worktrees" array/);
    assert.doesNotMatch(readWorkflow('quick-batch/steps/merge-wave.md'), /"dispatchedWorktree":null/);
    assert.doesNotMatch(readWorkflow('quick-batch/steps/verification-wave.md'), /worktree was already removed/);
  });

  test('quick-batch halts every attempted failed/unverified merge until manual root reconciliation', () => {
    const merge = readWorkflow('quick-batch/steps/merge-wave.md');
    assert.match(merge, /Every attempted failed or unverified merge halts/);
    assert.match(merge, /including clean refusals, transport errors, timeouts\/signals/);
    assert.match(merge, /Absence of `MERGE_HEAD` does not\s+authorize continuation/);
    assert.match(merge, /no next round\/invocation automatically resumes them/);
    assert.match(merge, /actual command-return index, worktree/);
    assert.match(merge, /all surviving writers\/hooks/);
    assert.match(merge, /pre-integration entry\s+refusals independently/);
    assert.doesNotMatch(merge, /genuinely mid-merge|resume picks them up on the next/);
  });

  for (const relative of ['remove-workspace.md', 'complete-milestone/detail/elaboration.md']) {
    test(`${relative} has an executable manual retirement hold`, (t) => {
      const block = shellBlocks(readWorkflow(relative)).find(b => b.includes('BLOCKED:') && b.includes('retirement'));
      assert.ok(block);
      const base = createTempDir('manual-retirement-hold-');
      t.after(() => cleanup(base));
      const repo = path.join(base, 'repo');
      const wt = path.join(base, 'worker');
      fs.mkdirSync(repo);
      git(['init', '-b', 'main'], repo);
      git(['config', 'user.name', 'Fixture'], repo);
      git(['config', 'user.email', 'fixture@example.invalid'], repo);
      fs.writeFileSync(path.join(repo, 'accepted.txt'), 'accepted\n');
      git(['add', 'accepted.txt'], repo); git(['commit', '-m', 'base'], repo);
      git(['worktree', 'add', '-b', 'worktree-agent-hold', wt], repo);
      git(['update-ref', 'refs/forensic-recovery/hold', 'HEAD'], repo);
      // Preserve linked worktree registrations, recovery refs and dirty data.
      fs.writeFileSync(path.join(wt, 'accepted.txt'), 'accepted but now modified\n');
      git(['add', 'accepted.txt'], wt);
      const info = path.join(repo, '.git', 'info');
      fs.mkdirSync(info, { recursive: true });
      fs.writeFileSync(path.join(info, 'exclude'), 'ignored.bin\n');
      fs.writeFileSync(path.join(wt, 'ignored.bin'), Buffer.from([255, 0, 42, 10]));
      fs.writeFileSync(path.join(wt, 'untracked.bin'), Buffer.from([1, 0, 2]));
      const before = snapshotFixtureTree(base);
      const result = spawn('bash', ['-eu', '-c', block], { env: { ...f.env, WORKSPACE_PATH: wt } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /BLOCKED:/);
      assert.deepEqual(snapshotFixtureTree(base), before,
        'a retirement hold must preserve all bytes, raw indexes, refs and registrations');
    });
  }

  for (const relative of ['quick.md', 'quick-batch.md', 'execute-phase/steps/executor-isolation-dispatch.md']) {
    for (const enabled of [true, false]) {
      test(`${relative} report-only startup inventory ${enabled ? 'propagates failure' : 'skips when disabled'}`, () => {
        const content = splitLines(readWorkflow(relative));
        const call = content.findIndex(line => line.includes('gsd_run query worktree.reap-orphans || exit $?'));
        assert.ok(call > 0);
        const block = content.slice(call - 1, call + 2).join('\n');
        const result = spawn('bash', ['-eu', '-c',
          'gsd_run() { echo "retained candidate; inventory unavailable" >&2; return 23; }\n' + block], {
          env: { ...f.env, USE_WORKTREES: enabled ? 'true' : 'false', ISOLATION: enabled ? 'orchestrator-worktree' : 'none' },
        });
        assert.equal(result.status, enabled ? 23 : 0);
        if (enabled) assert.match(result.stderr, /retained candidate; inventory unavailable/);
        else assert.equal(result.stderr, '');
      });
    }
  }
});

describe('ORCH-03 real CLI output contract in disposable repositories', () => {
  test('missing acceptance exits 1, explicitly reports false integration and preserves parent HEAD', () => {
    assert.equal(f.refused.status, 1, f.refused.stderr);
    const response = JSON.parse(f.refused.stdout);
    assert.equal(response.ok, false);
    assert.equal(response.result.entries[0].integrated, false);
    assert.equal(response.result.entries[0].status, 'blocked');
    assert.equal(response.result.entries[0].reason, 'retirement_authorization_required');
    assert.equal(f.afterRefusal, f.baseHead);
  });

  test('accepted integration exits 1 with integrated_retained and retains checkout/ref/registration/recovery', () => {
    assert.equal(f.accepted.status, 1, f.accepted.stderr);
    const response = JSON.parse(f.accepted.stdout);
    assert.equal(response.ok, false);
    assert.deepEqual(response.result.pending, []);
    assert.equal(response.result.entries[0].integrated, true);
    assert.equal(response.result.entries[0].status, 'integrated_retained');
    assert.equal(response.result.entries[0].reason, 'retirement_manual_root_handoff_required');
    const accepted = f.entry.retirement_authorization.accepted_head;
    assert.equal(git(['rev-parse', `refs/heads/${f.entry.branch}`], f.repo), accepted);
    assert.equal(git(['rev-parse', 'HEAD'], f.wt), accepted);
    assert.equal(git(['rev-parse', f.entry.retirement_authorization.recovery_ref], f.repo), accepted);
    assert.match(git(['worktree', 'list', '--porcelain'], f.repo), /branch refs\/heads\/worktree-agent-cli/);
    assert.equal(fs.readFileSync(path.join(f.wt, 'accepted.txt'), 'utf8'), 'accepted\n');
    assert.equal(git(['merge-base', '--is-ancestor', accepted, 'HEAD'], f.repo), '');
  });

  test('failed integration observation is null/unknown through the real CLI, never retired', () => {
    assert.equal(f.unknown.status, 1, f.unknown.stderr);
    const response = JSON.parse(f.unknown.stdout);
    assert.equal(response.result.entries[0].integrated, null);
    assert.equal(response.result.entries[0].status, 'integration_unknown_retained');
    assert.ok(fs.existsSync(f.wt));
  });

  test('missing manifest argument and missing file preserve actual usage/read failure exits', () => {
    const usage = spawn(process.execPath, [TOOLS_PATH, 'query', 'worktree.cleanup-wave', '--exit-contract=v1']);
    assert.equal(usage.status, 2);
    const missing = cli(path.join(f.base, 'not-found.json'));
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).reason, 'manifest_read_failed');
  });
});

for (const relative of CONSUMERS) {
  describe(`ORCH-03 executable workflow consumer: ${relative}`, () => {
    test('accepted integration is reportable while command failure and retirement hold remain', () => {
      const run = runConsumer(relative, f.accepted.stdout, f.accepted.status);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Accepted integration confirmed; manual retirement held/);
      assert.match(run.stderr, /phase acceptance are not complete/);
      assert.match(run.trace, /query worktree\.cleanup-wave --manifest/);
      assert.match(run.trace, /--exit-contract=v1/);
      assert.equal(splitLines(run.trace).filter(Boolean).length, 1);
    });

    for (const kind of ['refused', 'unknown']) {
      test(`${kind} real CLI response holds progression and retains exact failure status`, () => {
        const run = runConsumer(relative, f[kind].stdout, f[kind].status, { manifest: kind === 'unknown' ? f.unknownManifest : f.manifest });
        assert.equal(run.status, 1);
        assert.match(run.stderr, /BLOCKED:/);
        assert.match(run.stderr, kind === 'unknown' ? /integration_unknown_retained: integrated=null/ : /blocked: integrated=false/);
        assert.doesNotMatch(run.stderr, /Accepted integration confirmed/);
      });
    }

    for (const status of [0, 2, 37]) {
      test(`unexpected helper exit ${status} cannot be promoted by an accepted-looking payload`, () => {
        const run = runConsumer(relative, f.accepted.stdout, status);
        assert.equal(run.status, status || 1);
        assert.doesNotMatch(run.stderr, /Accepted integration confirmed/);
      });
    }

    for (const variant of ['malformed', 'missing-entry', 'pending', 'identity-mismatch', 'head-mismatch', 'other-retention', 'legacy-status', 'duplicate', 'unsupported-manifest']) {
      test(`${variant} holds instead of claiming successful cleanup or acceptance`, () => {
        let response = JSON.parse(f.accepted.stdout);
        const manifest = structuredClone(f.manifest);
        if (variant === 'malformed') response = '{';
        if (variant === 'missing-entry') response.result.entries = [];
        if (variant === 'pending') response.result.pending = [f.entry];
        if (variant === 'identity-mismatch') response.result.entries[0].branch = 'worktree-agent-foreign';
        if (variant === 'head-mismatch') response.result.entries[0].retirement_authorization.accepted_head = '0'.repeat(40);
        if (variant === 'other-retention') response.result.entries[0].reason = 'retirement_head_advanced';
        if (variant === 'legacy-status') response.result.entries[0].status = 'merged_removed';
        if (variant === 'duplicate') { manifest.worktrees.push(f.entry); response.result.entries.push(response.result.entries[0]); }
        if (variant === 'unsupported-manifest') { manifest.entries = manifest.worktrees; delete manifest.worktrees; }
        const run = runConsumer(relative, response, 1, { manifest });
        assert.equal(run.status, 1);
        assert.match(run.stderr, /BLOCKED:/);
        assert.doesNotMatch(run.stderr, /Accepted integration confirmed/);
      });
    }

    test('the same actual block preserves accepted-retained semantics under zsh', t => {
      const available = cp.spawnSync('zsh', ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
      if (available.error?.code === 'ENOENT') { t.skip('zsh is not available on this platform'); return; }
      assert.ifError(available.error);
      const run = runConsumer(relative, f.accepted.stdout, 1, { shell: 'zsh' });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Accepted integration confirmed; manual retirement held/);
    });
  });
}

test('execute-phase rejects absent dispatch root without falling back to another checkout', () => {
  const manifest = structuredClone(f.manifest); delete manifest.orchestrator_root;
  const run = runConsumer('execute-phase.md', f.accepted.stdout, 1, { manifest });
  assert.equal(run.status, 1);
  assert.equal(run.trace, '');
  assert.match(run.stderr, /missing orchestrator_root/);
});

for (const shell of ['bash', 'zsh']) {
  for (const scenario of [
    { name: 'dirty tree holds without stashing or running the hook', diff: 1, hook: 0, status: 1, invoked: false },
    { name: 'hook failure propagates its actual status', diff: 0, hook: 7, status: 7, invoked: true },
    { name: 'clean tree and passing hook proceed', diff: 0, hook: 0, status: 0, invoked: true },
    { name: 'config read failure propagates', configExit: 23, diff: 0, hook: 0, status: 23, invoked: false },
    { name: 'malformed config holds', setting: 'unknown', diff: 0, hook: 0, status: 1, invoked: false },
    { name: 'explicit per-commit validation needs no extra hook', setting: 'false', diff: 0, hook: 0, status: 0, invoked: false },
  ]) {
    test(`post-wave hook under ${shell}: ${scenario.name}`, t => {
      const available = cp.spawnSync(shell, ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
      if (available.error?.code === 'ENOENT') { t.skip(`${shell} is unavailable`); return; }
      assert.ifError(available.error);
      const blocks = shellBlocks(readWorkflow('execute-phase.md')).filter(b => b.includes('HOOK_RC=0'));
      assert.equal(blocks.length, 1);
      const trace = path.join(f.base, `post-hook-${shell}-${scenario.diff}-${scenario.hook}.trace`);
      fs.writeFileSync(trace, '');
      const script = `set -eu\ngsd_run() { printf '%s\\n' "$HOOK_SETTING"; return "$CONFIG_STATUS"; }\ngit() {\n  printf '%s\\n' "$*" >> "$HOOK_TRACE"\n  case "$*" in\n    *'status --porcelain=v1 --untracked-files=all --ignored=matching --ignore-submodules=none'|*'ls-files --stage -v') return 0;;\n    'diff --quiet'|'diff --cached --quiet') return "$DIFF_STATUS";;\n    'hook run pre-commit') return "$HOOK_STATUS";;\n    *) return 99;;\n  esac\n}\n${blocks[0]}\nprintf 'HOOK_HANDOFF_COMPLETE\\n'\n`;
      const run = spawn(shell, ['-c', script], { env: { ...f.env,
        HOOK_TRACE: trace, DIFF_STATUS: String(scenario.diff), HOOK_STATUS: String(scenario.hook),
        HOOK_SETTING: scenario.setting ?? 'true', CONFIG_STATUS: String(scenario.configExit ?? 0),
      } });
      assert.equal(run.status, scenario.status, run.stderr);
      const calls = fs.readFileSync(trace, 'utf8');
      assert.equal(calls.includes('hook run pre-commit'), scenario.invoked);
      assert.doesNotMatch(calls, /stash|reset|restore|clean/);
      assert.equal(run.stdout.includes('HOOK_HANDOFF_COMPLETE'), scenario.status === 0);
    });
  }
}

// RGS-12: execute the exact doc block with actual config-get, Git inventories
// and harmless fixture hooks. The stub controls above retain exit-branch proof.
for (const shell of ['bash', 'zsh']) {
  for (const scenario of ['clean', 'tracked', 'untracked', 'ignored', 'hook-fails', 'config-malformed',
    'per-commit', 'status-error', 'status-diagnostic', 'tracked-error', 'assume-unchanged', 'skip-worktree', 'gitlink']) {
    test(`RGS-12 actual Git post-wave block under ${shell}: ${scenario}`, t => {
      const available = cp.spawnSync(shell, ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
      if (available.error?.code === 'ENOENT') { t.skip(`${shell} is unavailable`); return; }
      assert.ifError(available.error);
      const base = createTempDir('gsd-real-post-hook-'); t.after(() => cleanup(base));
      const repo = path.join(base, 'repo'); const hooks = path.join(base, 'hooks');
      fs.mkdirSync(repo); fs.mkdirSync(hooks);
      git(['init', '-q', '-b', 'main'], repo);
      git(['config', 'user.name', 'Fixture'], repo); git(['config', 'user.email', 'fixture@example.invalid'], repo);
      git(['config', 'commit.gpgsign', 'false'], repo); git(['config', 'core.hooksPath', hooks], repo);
      fs.mkdirSync(path.join(repo, '.planning'));
      fs.writeFileSync(path.join(repo, '.planning/config.json'), JSON.stringify({ workflow: { worktree_skip_hooks: scenario !== 'per-commit' } }));
      fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n'); git(['add', '.'], repo); git(['commit', '-qm', 'base'], repo);
      const head = git(['rev-parse', 'HEAD'], repo);
      const marker = path.join(base, 'hook-ran');
      fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nprintf ran > "$HOOK_MARKER"\nexit ' + (scenario === 'hook-fails' ? '7' : '0') + '\n', { mode: 0o755 });
      const binary = Buffer.from([255, 0, 42, 10]);
      if (scenario === 'tracked') fs.writeFileSync(path.join(repo, 'base.txt'), binary);
      if (['untracked', 'ignored', 'per-commit'].includes(scenario)) fs.writeFileSync(path.join(repo, 'independent.bin'), binary);
      if (scenario === 'ignored') {
        // Git templates may omit info/: keep this actual ignore fixture self-contained.
        fs.mkdirSync(path.join(repo, '.git/info'), { recursive: true });
        fs.appendFileSync(path.join(repo, '.git/info/exclude'), '\nindependent.bin\n');
      }
      if (scenario === 'config-malformed') fs.writeFileSync(path.join(repo, '.planning/config.json'), '{');
      if (['assume-unchanged', 'skip-worktree'].includes(scenario)) {
        git(['update-index', '--' + scenario, 'base.txt'], repo);
        fs.writeFileSync(path.join(repo, 'base.txt'), binary);
      }
      if (scenario === 'gitlink') {
        // A real Git index gitlink, with nested contents deliberately unknown.
        fs.unlinkSync(path.join(hooks, 'pre-commit'));
        git(['update-index', '--add', '--cacheinfo', '160000,' + head + ',nested'], repo);
        git(['commit', '-qm', 'fixture gitlink'], repo);
        fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nprintf ran > "$HOOK_MARKER"\n', { mode: 0o755 });
      }
      const block = shellBlocks(readWorkflow('execute-phase.md')).find(b => b.includes('HOOK_RC=0'));
      assert.ok(block);
      const trace = path.join(base, 'git.trace');
      fs.writeFileSync(trace, '');
      // Only enumeration fault cases substitute one Git observation. Every
      // other Git command, and every normal inventory/config/hook, is real.
      const prelude = `set -eu\ngsd_run() { node "$FIXTURE_TOOLS" "$@"; }\ngit() {\n  printf '%s\\n' "$*" >> "$GIT_TRACE"\n  case "$FAULT:$*" in\n    status-error:*'status --porcelain=v1'*) return 128;;\n    status-diagnostic:*'status --porcelain=v1'*) echo 'fixture incomplete inventory' >&2; return 0;;\n    tracked-error:*'ls-files --stage -v'*) return 128;;\n  esac\n  command git "$@"\n}\n`;
      const script = path.join(base, 'post-hook.sh'); fs.writeFileSync(script, prelude + block + '\nprintf HOOK_HANDOFF_COMPLETE\n');
      const indexBefore = fs.readFileSync(path.join(repo, '.git/index'));
      const run = spawn(shell, [script], { cwd: repo, env: { ...f.env,
        HOOK_MARKER: marker, FIXTURE_TOOLS: TOOLS_PATH, GIT_TRACE: trace, FAULT: scenario,
      } });
      const expectedStatus = scenario === 'hook-fails' ? 7 : ['clean', 'per-commit'].includes(scenario) ? 0 : 1;
      assert.equal(run.status, expectedStatus, run.stderr);
      assert.equal(fs.existsSync(marker), ['clean', 'hook-fails'].includes(scenario));
      assert.equal(run.stdout.includes('HOOK_HANDOFF_COMPLETE'), expectedStatus === 0);
      const calls = fs.readFileSync(trace, 'utf8');
      assert.doesNotMatch(calls, /stash|reset|restore|clean/);
      if (['per-commit', 'config-malformed'].includes(scenario)) assert.equal(calls, '', 'config policy returns before any Git invocation');
      else assert.match(calls, /--untracked-files=all --ignored=matching --ignore-submodules=none/);
      assert.deepEqual(fs.readFileSync(path.join(repo, '.git/index')), indexBefore);
      if (['untracked', 'ignored', 'per-commit'].includes(scenario)) assert.deepEqual(fs.readFileSync(path.join(repo, 'independent.bin')), binary);
      if (['tracked', 'assume-unchanged', 'skip-worktree'].includes(scenario)) assert.deepEqual(fs.readFileSync(path.join(repo, 'base.txt')), binary);
      const evidence = process.env.GSD_PARENT_CUSTODY_EVIDENCE;
      if (evidence) {
        fs.mkdirSync(evidence, { recursive: true });
        fs.writeFileSync(path.join(evidence, `hook-${shell}-${scenario}.json`), JSON.stringify({ shell, scenario,
          status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr,
          hookRan: fs.existsSync(marker), calls, indexBefore: indexBefore.toString('hex'),
          indexAfter: fs.readFileSync(path.join(repo, '.git/index')).toString('hex'),
          method: 'exact workflow block; actual Git, config-get and harmless hook; enumeration faults explicitly injected' }, null, 2) + '\n');
      }
    });
  }
}
