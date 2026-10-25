'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { gitOrThrow } = require('./git-fixture.cjs');
const { GIT_TIMEOUT_MS } = require('./timeouts.cjs');
function git(args, cwd) { return gitOrThrow(args, { cwd, timeoutMs: GIT_TIMEOUT_MS }).trim(); }
// Tests opt in explicitly. This never changes a production plan or native home.
function authorizeFixtureEntry(repoRoot, entry, recordOverrides = {}) {
  const repo = fs.realpathSync(repoRoot);
  const temp = fs.realpathSync(os.tmpdir());
  const relative = path.relative(temp, repo);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('custody authorization is fixture-only');
  const accepted = git(['rev-parse', '--verify', `refs/heads/${entry.branch}^{commit}`], repo);
  const recovery = `refs/forensic-recovery/${entry.agent_id}`;
  git(['update-ref', recovery, accepted], repo);
  const worktree = path.resolve(repoRoot, entry.worktree_path);
  const record = { agentId: entry.agent_id, pid: 4242, plan: 'fixture-plan', worktreePath: worktree,
    summaryPath: path.join(worktree, '.planning/01-SUMMARY.md'), logFile: '', startedAt: '2020-01-01T00:00:00Z',
    completedAt: '2020-01-01T00:01:00Z', state: 'complete', exitCode: 0, note: 'synthetic completed owner', ...recordOverrides };
  fs.writeFileSync(worktree + '.worker.json', JSON.stringify(record));
  return { ...entry, retirement_authorization: { owner_id: entry.agent_id, accepted_head: accepted, recovery_ref: recovery } };
}
function authorizeFixturePlan(plan) {
  return { ...plan, entries: plan.entries.map((entry) => authorizeFixtureEntry(plan.repoRoot, entry)) };
}
// Byte/mode inventory includes the full .git tree, refs, raw indexes, ignored
// and untracked files. lstat preserves symlinks without following them outside
// the fixture. Timestamps/xattrs and concurrent-writer guarantees are excluded.
function snapshotFixtureTree(root) {
  const realRoot = fs.realpathSync(root);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), realRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('snapshot is fixture-only');
  const files = {};
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(realRoot, full);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) files[rel] = { mode: stat.mode, link: fs.readlinkSync(full) };
      else if (stat.isDirectory()) { files[rel] = { mode: stat.mode, directory: true }; walk(full); }
      else {
        if (!stat.isFile()) throw new Error('unsupported fixture file type: ' + rel);
        const bytes = fs.readFileSync(full);
        files[rel] = { mode: stat.mode, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
    }
  }
  walk(realRoot);
  return files;
}
module.exports = { authorizeFixtureEntry, authorizeFixturePlan, git, snapshotFixtureTree };
