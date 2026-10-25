// allow-test-rule: source-text-is-the-product
// Workflow markdown is the installed orchestration contract.

'use strict';

/**
 * Cleanup enhancement: branch pruning (#40)
 *
 * Seam: gsd-core/workflows/cleanup.md
 *
 * Verifies that /gsd-cleanup inventories and retains branches whose upstream is gone,
 * integrated between archive_phases and commit steps.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const CLEANUP_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'cleanup.md');

// ─── Helpers (mirrors worktree-cleanup.test.cjs) ─────────────────────────────

function extractNamedBlock(markdown, blockName) {
  const openStep = `<step name="${blockName}">`;
  let start = markdown.indexOf(openStep);
  if (start !== -1) {
    const closeTag = '</step>';
    const end = markdown.indexOf(closeTag, start + openStep.length);
    if (end !== -1) return markdown.slice(start + openStep.length, end);
  }
  const openBare = `<${blockName}>`;
  start = markdown.indexOf(openBare);
  if (start === -1) return null;
  const closeBare = `</${blockName}>`;
  const end = markdown.indexOf(closeBare, start + openBare.length);
  if (end === -1) return null;
  return markdown.slice(start + openBare.length, end);
}

function extractFencedCodeBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split('\n');
  let inFence = false;
  let fenceLang = '';
  let buffer = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      if (!inFence) {
        inFence = true;
        fenceLang = trimmed.slice(3).trim();
        buffer = [];
      } else {
        blocks.push({ lang: fenceLang, body: buffer.join('\n') });
        inFence = false;
        fenceLang = '';
        buffer = [];
      }
    } else if (inFence) {
      buffer.push(line);
    }
  }
  return blocks;
}

function shellStatements(script) {
  const statements = [];
  const lines = script.split('\n');
  for (let raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/(?:&&|\|\||;)/);
    for (const part of parts) {
      let trimmed = part.trim();
      if (!trimmed) continue;
      const assignMatch = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*=(.*)$/);
      if (assignMatch) trimmed = assignMatch[1];
      const subMatch = trimmed.match(/^\$\((.*?)\)?$/);
      if (subMatch) trimmed = subMatch[1];
      if (trimmed.startsWith('$(')) trimmed = trimmed.slice(2);
      trimmed = trimmed.replace(/\)+\s*$/, '').trim();
      if (!trimmed) continue;
      statements.push(trimmed.split(/\s+/).filter(Boolean));
    }
  }
  return statements;
}

function findCommandIndex(statements, predicate) {
  for (let i = 0; i < statements.length; i++) {
    if (predicate(statements[i])) return i;
  }
  return -1;
}

// ─── #40: prune local branches whose upstream is gone ──────────────────────

// Execute the shipped advisory inventory over real local tracking metadata.
// All mutations below construct a disposable fixture; the workflow command must
// retain the exact full Git/worktree state, including unrelated dirty data.
function runAdvisoryInventoryFixture(candidateNames) {
  const { createTempDir, cleanup, homeSandboxEnv, installSpawnEnv } = require('./helpers.cjs');
  const { git, snapshotFixtureTree } = require('./helpers/custody-fixture.cjs');
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const base = createTempDir('advisory-branches-');
  try {
    const repo = path.join(base, 'repo');
    const home = path.join(base, 'home');
    fs.mkdirSync(repo); fs.mkdirSync(home);
    git(['init', '-b', 'main'], repo);
    git(['config', 'user.name', 'Fixture'], repo);
    git(['config', 'user.email', 'fixture@example.invalid'], repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
    git(['add', 'tracked.txt'], repo); git(['commit', '-m', 'base'], repo);
    git(['remote', 'add', 'origin', 'https://example.invalid/fixture.git'], repo);
    git(['update-ref', 'refs/remotes/origin/stale', 'HEAD'], repo);
    for (const name of candidateNames) {
      if (name !== 'main') git(['branch', name], repo);
      git(['config', `branch.${name}.remote`, 'origin'], repo);
      git(['config', `branch.${name}.merge`, 'refs/heads/stale'], repo);
    }
    git(['update-ref', '-d', 'refs/remotes/origin/stale'], repo);
    git(['update-ref', 'refs/forensic-recovery/main', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'unrelated staged data\n');
    git(['add', 'tracked.txt'], repo);
    const info = path.join(repo, '.git', 'info');
    fs.mkdirSync(info, { recursive: true });
    fs.writeFileSync(path.join(info, 'exclude'), 'ignored.bin\n');
    fs.writeFileSync(path.join(repo, 'ignored.bin'), Buffer.from([255, 0, 42, 10]));
    fs.writeFileSync(path.join(repo, 'untracked.bin'), Buffer.from([1, 0, 2]));
    const content = fs.readFileSync(CLEANUP_PATH, 'utf8');
    const block = extractFencedCodeBlocks(extractNamedBlock(content, 'show_dry_run'))
      .find(({ body }) => body.includes('git branch -vv'));
    assert.ok(block, 'the actual dry-run branch inventory must remain executable');
    const before = snapshotFixtureTree(repo);
    const result = require('node:child_process').spawnSync('bash', ['-eu', '-c', block.body], {
      cwd: repo, env: installSpawnEnv(homeSandboxEnv(home)), encoding: 'utf8', timeout: PROBE_TIMEOUT_MS,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshotFixtureTree(repo), before,
      'inventory must preserve every ref, exact index and tracked/ignored/untracked byte');
    return result.stdout.trim().split('\n').filter(Boolean);
  } finally { cleanup(base); }
}

describe('cleanup #40: prune local branches whose upstream is gone', () => {
  const content = fs.readFileSync(CLEANUP_PATH, 'utf-8');

  test('cleanup.md contains a prune_local_branches step', () => {
    const block = extractNamedBlock(content, 'prune_local_branches');
    assert.ok(block, 'cleanup.md must contain a <prune_local_branches> step');
  });

  test('show_dry_run inventories local metadata without pruning remote-tracking refs', () => {
    const block = extractNamedBlock(content, 'show_dry_run');
    assert.ok(block);
    const statements = extractFencedCodeBlocks(block).flatMap(({ body }) => shellStatements(body));
    assert.equal(findCommandIndex(statements, cmd => cmd[0] === 'git' && cmd[1] === 'fetch'), -1);
    assert.match(block, /advisory candidates from current local tracking metadata \(which may be stale\)/);
    assert.match(block, /gone upstream is not owner completion, integration or recovery proof/);
  });

  test('prune_local_branches cannot fetch or prune tracking refs during the retention handoff', () => {
    const block = extractNamedBlock(content, 'prune_local_branches');
    assert.ok(block);
    const codeBlocks = extractFencedCodeBlocks(block);
    const allStatements = codeBlocks.flatMap(({ body }) => shellStatements(body));
    const idx = findCommandIndex(allStatements, (cmd) =>
      cmd[0] === 'git' && cmd[1] === 'fetch' && (cmd.includes('--prune') || cmd.includes('-p'))
    );
    assert.strictEqual(
      idx, -1,
      'the retained handoff cannot prune tracking refs or refresh a different candidate set'
    );
  });

  test('show_dry_run identifies advisory gone-upstream branches via git branch -vv', () => {
    const block = extractNamedBlock(content, 'show_dry_run');
    assert.ok(block);
    const statements = extractFencedCodeBlocks(block).flatMap(({ body }) => shellStatements(body));
    assert.notEqual(findCommandIndex(statements, cmd => cmd[0] === 'git' && cmd[1] === 'branch' && cmd.includes('-vv')), -1);
    assert.match(block, /do not automatically prune refs/);
  });

  test('prune_local_branches retains candidates until exact root custody and recovery review', () => {
    const block = extractNamedBlock(content, 'prune_local_branches');
    assert.ok(block);
    assert.match(block, /retained; manual root retirement pending/);
    assert.match(block, /each exact branch and every associated checkout/);
    assert.match(block, /Unknown\/active owners or unavailable independent recovery evidence retain the branch/);
    assert.doesNotMatch(block, /git branch -[dD]|git update-ref -d|git worktree (?:remove|unlock|prune)/);
  });

  test('an empty advisory result cannot invoke deletion or xargs', () => {
    const block = extractNamedBlock(content, 'prune_local_branches');
    assert.ok(block);
    assert.match(extractNamedBlock(content, 'show_dry_run'), /If none, show:[\s\S]*?No stale local branches detected/);
    assert.doesNotMatch(block, /\bxargs\b|git branch -[dD]/);
    assert.match(block, /branch retirement has not succeeded/);
  });

  test('prune_local_branches appears between archive_phases and commit in <process>', () => {
    const processBlock = extractNamedBlock(content, 'process');
    assert.ok(processBlock);

    const archivePhasesIdx = processBlock.indexOf('<step name="archive_phases">');
    const pruneBranchesIdx = processBlock.indexOf('<step name="prune_local_branches">');
    const commitIdx = processBlock.indexOf('<step name="commit">');

    assert.ok(archivePhasesIdx > -1, 'archive_phases step must exist');
    assert.ok(commitIdx > -1, 'commit step must exist');
    assert.notStrictEqual(pruneBranchesIdx, -1, 'prune_local_branches step must exist');
    assert.ok(
      archivePhasesIdx < pruneBranchesIdx && pruneBranchesIdx < commitIdx,
      'prune_local_branches must appear between archive_phases and commit steps'
    );
  });

  test('dry-run output in show_dry_run mentions stale branch detection', () => {
    const block = extractNamedBlock(content, 'show_dry_run');
    assert.ok(block);
    // Must explicitly enumerate stale branches, not just mention the word "branch"
    assert.ok(
      block.includes(': gone') || block.includes('gone]') || block.includes('upstream is gone'),
      'show_dry_run must mention gone-upstream branches in the dry-run summary'
    );
  });

  test('confirmation permits archival and explicitly retains branches for root review', () => {
    const block = extractNamedBlock(content, 'show_dry_run');
    assert.ok(block);
    assert.match(block, /Branch retirement remains held for root review/);
    assert.match(block, /Yes — archive phases; retain branches/);
  });

  test('report step counts retained advisory candidates and reports no refs deleted', () => {
    const block = extractNamedBlock(content, 'report');
    assert.ok(block);
    assert.match(block, /Retained: \{N\} advisory local branch candidates; manual root retirement pending\. No refs deleted/);
    assert.doesNotMatch(block, /Pruned:|pruned branch/);
  });

  test('show_dry_run awk pattern explicitly excludes the current branch (HEAD)', () => {
    const block = extractNamedBlock(content, 'show_dry_run');
    assert.ok(block);
    // In `git branch -vv` output, the current branch is prefixed with `* `.
    // awk '{print $1}' on the current branch yields `*`, NOT the branch name.
    // The pipeline must explicitly exclude the `*` marker so that
    // `git branch -D` is never passed `*` as a literal argument.
    const hasExplicitHeadGuard = (
      block.includes('$1 != "*"') ||    // awk field comparison
      block.includes('$1!="*"') ||
      block.includes('$1 !~') ||        // awk regex non-match (covers * and protected names)
      block.includes('!/^\\*/') ||      // awk negation pattern
      block.includes("!/^\\*") ||
      block.includes('--format') ||     // git branch --format skips * entirely
      (block.includes('sed') && block.includes('\\*'))
    );
    assert.ok(
      hasExplicitHeadGuard,
      'prune_local_branches awk must explicitly exclude the current branch marker (`*`) ' +
      'using $1 != "*", $1 !~ /regex/, or equivalent, to prevent passing literal `*` to `git branch -D`'
    );
  });

  test('identify_completed_milestones does NOT run git branch -vv (belongs in show_dry_run)', () => {
    const block = extractNamedBlock(content, 'identify_completed_milestones');
    assert.ok(block);
    // Branch detection is a dry-run concern, not milestone identification.
    // Including it here runs the command twice and splits responsibilities.
    const codeBlocks = extractFencedCodeBlocks(block);
    const allStatements = codeBlocks.flatMap(({ body }) => shellStatements(body));
    const branchVvIdx = findCommandIndex(allStatements, (cmd) =>
      cmd[0] === 'git' && cmd[1] === 'branch'
    );
    assert.strictEqual(
      branchVvIdx, -1,
      'identify_completed_milestones must not run git branch commands — ' +
      'branch detection belongs in show_dry_run where dry-run output is assembled'
    );
  });

  test('show_dry_run awk filter excludes protected branch names (main, next, trunk, develop)', () => {
    const block = extractNamedBlock(content, 'show_dry_run');
    assert.ok(block);
    // Protected branch names must be excluded even if their upstream is gone.
    // Accept double-quoted "main", single-quoted 'main', or regex anchor ^main$.
    assert.ok(
      block.includes('"main"') || block.includes("'main'") || block.includes('^main$') || block.includes('^main|'),
      'prune_local_branches awk must exclude "main" from deletion candidates'
    );
    assert.ok(
      block.includes('"next"') || block.includes("'next'") || block.includes('^next$') || block.includes('^next|') ||
      block.includes('"trunk"') || block.includes("'trunk'") || block.includes('^trunk$') || block.includes('^trunk|'),
      'prune_local_branches awk must exclude integration branch names (next or trunk)'
    );
  });

  test('real advisory inventory excludes current/protected branches and retains all refs and dirty bytes', () => {
    assert.deepEqual(runAdvisoryInventoryFixture(['main', 'next', 'trunk', 'develop', 'feature-retained']), ['feature-retained']);
  });

  test('real advisory inventory with no disposable candidates is a successful no-write empty result', () => {
    assert.deepEqual(runAdvisoryInventoryFixture(['main', 'next', 'trunk', 'develop']), []);
  });

  test('no breaking changes: existing archive_phases step is untouched', () => {
    const block = extractNamedBlock(content, 'archive_phases');
    assert.ok(block, 'original archive_phases step must still exist');
    assert.ok(block.includes('mv'), 'archive_phases must still move phase directories');
    assert.ok(
      block.includes('.planning/phases/') || block.includes('phases/'),
      'archive_phases must reference .planning/phases/'
    );
  });
});
