/**
 * Worktree Safety Policy Module
 *
 * Owns worktree-root resolution and non-destructive prune policy decisions.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/worktree-safety.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit as execGitSeam, posixNormalize, type SpawnResultOutput } from './shell-command-projection.cjs';
import { isContainedIn } from './security.cjs';

// Default timeout for worktree-related git subprocess calls.
// 10 s is generous enough for normal git operations on large repos while still
// providing a deterministic failure path when git stalls (locked index, hung
// remote, stalled NFS mount, etc.).  Callers can override via deps.timeout.
const DEFAULT_GIT_TIMEOUT_MS = 10000;

// #4721: the wave's `git merge --no-ff` is the one call in this module that runs
// the commit-family hooks (`pre-merge-commit`, `prepare-commit-msg`,
// `commit-msg`, `post-merge`), and a repo whose pre-merge hook is a test-suite
// gate routinely runs for minutes. That is hook runtime, not "git stalling", so
// the merge gets its own budget instead of inheriting DEFAULT_GIT_TIMEOUT_MS —
// raising the shared default would be the wrong lever, because every other
// caller in the module is exactly what the 10 s comment above describes.
// (`worktree add` runs `post-checkout` and every ref update runs
// `reference-transaction`; those are plumbing-cheap and stay on the default.)
// Callers override via deps.mergeTimeoutMs.
const DEFAULT_MERGE_TIMEOUT_MS = 10 * 60 * 1000;

// #3021: accept the Workflow tool's worktree-wf_<runid>-<n> naming convention
// (claude-orchestration's isolation:"worktree" emission) alongside the
// existing agent-<id> / worktree-agent-<id> shapes.
const WORKTREE_AGENT_BRANCH_RE = /^((worktree-)?agent-|worktree-wf_)[A-Za-z0-9._/-]+$/;
const WORKTREE_AGENT_BRANCH_PATTERN = WORKTREE_AGENT_BRANCH_RE.source;

// GitResult now aliases the canonical SpawnResultOutput (shell-command-projection.cts),
// which already carries `timedOut` — kept as a local name since it is referenced
// below (gitResultOk).
type GitResult = SpawnResultOutput;

type ExecGitFn = typeof execGitSeam;

/**
 * Execute a git command via the shell-projection seam, applying the module's
 * default timeout. `timedOut` is now derived by the seam itself
 * (shell-command-projection.cts's `_spawnResult`), so this is a thin
 * passthrough. Tests inject mocks via deps.execGit using the same
 * (args, opts) shape — see worktree-safety-policy.test.cjs.
 */
function execGitDefault(args: string[], opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): GitResult {
  return execGitSeam(args, { ...opts, timeout: opts.timeout ?? DEFAULT_GIT_TIMEOUT_MS });
}

interface WorktreeBranchEntry {
  path: string;
  branch: string;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  /**
   * #4415: git's own verdict that this administrative entry is stale, carrying
   * the reason it gave — `null` when git did not mark it prunable. `git worktree
   * list --porcelain` emits `prunable <reason>` for an entry whose checkout it
   * cannot reach, while keeping the `branch` line.
   *
   * NOT a removal test, and measured rather than assumed: a parent directory at
   * mode 000 also produces `prunable gitdir file points to non-existent location`
   * for a checkout that is still there, because git cannot traverse the parent.
   * Removed vs unreadable is `statSync`'s errno to answer; this field records
   * git's staleness verdict and the reason text, which is worth surfacing to an
   * operator but must not stand in for the errno.
   */
  prunable: string | null;
  /**
   * #ORCH-03: git's lock marker for this administrative entry — `null` when the
   * entry is unlocked, otherwise the lock reason when git records one (possibly
   * the bare self-declared marker). `git worktree remove` refuses a locked
   * worktree, so this is the cheap read that lets the cleanup wave refuse a
   * live-owner checkout with a named reason BEFORE it ever reaches a removal
   * call, instead of discovering the lock and clearing it.
   */
  locked: string | null;
}

function parseWorktreePorcelain(porcelain: string): WorktreeBranchEntry[] {
  return parseWorktreeEntries(porcelain).filter((entry) => entry.branch !== null).map((entry) => ({
    path: entry.path,
    branch: entry.branch!,
  }));
}

function parseWorktreeEntries(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = String(porcelain || '').split('\n\n').filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    const worktreeLine = lines.find((l) => l.startsWith('worktree '));
    if (!worktreeLine) continue;
    const worktreePath = worktreeLine.slice('worktree '.length).trim();
    if (!worktreePath) continue;
    const branchLine = lines.find((l) => l.startsWith('branch refs/heads/'));
    const branch = branchLine ? branchLine.slice('branch refs/heads/'.length).trim() : null;
    // #4415: `prunable` appears either bare or with a reason. Keep the reason
    // when git gives one, and fall back to a non-empty marker when it does not,
    // so the field stays a truthful "git says stale" boolean either way.
    const prunableLine = lines.find((l) => l === 'prunable' || l.startsWith('prunable '));
    const prunable = prunableLine
      ? (prunableLine.slice('prunable'.length).trim() || 'prunable')
      : null;
    // #ORCH-01/#ORCH-03: `locked` appears either bare or with a reason, same
    // convention as `prunable` above. Kept as a truthful "git says locked"
    // marker so the retention reason survives even when git gave no reason.
    const lockedLine = lines.find((l) => l === 'locked' || l.startsWith('locked '));
    const locked = lockedLine
      ? (lockedLine.slice('locked'.length).trim() || 'locked')
      : null;
    entries.push({ path: worktreePath, branch, prunable, locked });
  }
  return entries;
}

function parseWorktreeListPaths(porcelain: string): string[] {
  return parseWorktreeEntries(porcelain).map((entry) => entry.path);
}

interface WorktreeListResult {
  ok: boolean;
  reason: string;
  porcelain: string;
  entries: WorktreeEntry[];
}

interface WorktreeDeps {
  execGit?: ExecGitFn;
  existsSync?: (p: string) => boolean;
  statSync?: (p: string) => fs.Stats;
  findSummaryFiles?: (worktreePath: string) => string[];
  readFileSync?: (p: string) => string;
  mkdirSync?: (d: string, o?: { recursive?: boolean }) => void;
  copyFileSync?: (src: string, dest: string, flags: number) => void;
  /** Raw bytes for evidence identity; the text reader remains separate. */
  readFileBytes?: (p: string) => Buffer;
  /**
   * #ORCH-02: real-path / symlink resolution for the SUMMARY-rescue destination
   * containment check. Injectable so the check is exercised without a real
   * filesystem; defaults to node's `fs.realpathSync`.
   */
  realpathSync?: (p: string) => string;
  /**
   * #ORCH-02: `lstat` (never `stat`) so a *dangling* destination symlink is
   * still seen. `existsSync` follows links and returns false for a dangling
   * one, which would let a copy write THROUGH the link to an outside target.
   */
  lstatSync?: (p: string) => fs.Stats;
  isPidAlive?: (pid: number) => boolean;
  readDirSafe?: (dir: string) => string[] | null;
  readFileSafe?: (file: string) => string | null;
  mtimeSafe?: (file: string) => Date | null;
  reapMtimeGuardMs?: number;
  /** Injected current time in ms since epoch for deterministic tests (#1191). */
  nowMs?: number;
  parseWorktreePorcelain?: (porcelain: string) => WorktreeBranchEntry[];
  /**
   * #4721: budget for the wave's `git merge --no-ff` — the one call that runs
   * the commit-family hooks. Defaults to DEFAULT_MERGE_TIMEOUT_MS; every other
   * git call in the wave keeps the module default.
   */
  mergeTimeoutMs?: number;
}

function readWorktreeList(repoRoot: string, deps: WorktreeDeps = {}): WorktreeListResult {
  const execGit = deps.execGit || execGitDefault;
  const listResult = execGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (listResult.timedOut) {
    // AC2 / AC4: surface timeout as a distinct reason so callers can emit a
    // structured warning rather than silently treating the failure as a generic
    // list error (PRED.k302 — error-swallowing-empty-sentinel).
    return {
      ok: false,
      reason: 'git_timed_out',
      porcelain: '',
      entries: [],
    };
  }
  if (!gitResultOk(listResult)) {
    const stderr = String(listResult.stderr || '');
    return {
      ok: false,
      reason: /not a git repository|not a git repo/i.test(stderr)
        ? 'not_a_git_repo'
        : 'git_list_failed',
      porcelain: '',
      entries: [],
    };
  }

  return {
    ok: true,
    reason: 'ok',
    porcelain: listResult.stdout,
    entries: parseWorktreeEntries(listResult.stdout),
  };
}

interface WorktreeContextResult {
  effectiveRoot: string;
  mode: string;
  reason: string;
}

/**
 * Shortcut-free git-dir-vs-git-common-dir comparison: the actual primitive
 * that distinguishes a linked worktree from the main worktree.
 *
 * Deliberately factored out of `resolveWorktreeContext` (#3045). That
 * function's `has_local_planning` shortcut answers a DIFFERENT question ("is
 * there already a usable project root right here") and must NOT be consulted
 * for isolation detection: a git worktree created specifically to isolate an
 * executor is a full checkout, so it normally has its OWN checked-out
 * `.planning/` too. A caller that ran the shortcut first would read that
 * correctly-isolated worktree as `current_directory`/`has_local_planning` —
 * i.e. "not isolated" — a false positive that defeats the very isolation
 * guard that needs this check (see `hooks/gsd-cursor-subagent-start.js`,
 * #3045). `resolveWorktreeLinkage` always performs the real git-dir
 * comparison, independent of whether `.planning` exists locally.
 */
function resolveWorktreeLinkage(cwd: string, deps: WorktreeDeps = {}): WorktreeContextResult {
  const execGit = deps.execGit || execGitDefault;

  const gitDir = execGit(['rev-parse', '--git-dir'], { cwd });
  const commonDir = execGit(['rev-parse', '--git-common-dir'], { cwd });
  // A TIMEOUT means the command never completed — it is not evidence of "not a
  // git repository" (which completes fast, with a clean non-zero exit). Surface
  // it under a distinct reason so callers can tell "genuinely not a repo" apart
  // from "could not determine" (#3050). effectiveRoot still degrades to cwd
  // (there is no safer default without a resolved git-dir), but the reason is
  // no longer indistinguishable from the benign case.
  if (gitDir.timedOut || commonDir.timedOut) {
    return {
      effectiveRoot: cwd,
      mode: 'current_directory',
      reason: 'git_timed_out',
    };
  }
  if (gitDir.exitCode !== 0 || commonDir.exitCode !== 0) {
    return {
      effectiveRoot: cwd,
      mode: 'current_directory',
      reason: 'not_git_repo',
    };
  }

  const gitDirResolved = path.resolve(cwd, gitDir.stdout);
  const commonDirResolved = path.resolve(cwd, commonDir.stdout);
  if (gitDirResolved !== commonDirResolved) {
    return {
      effectiveRoot: path.dirname(commonDirResolved),
      mode: 'linked_worktree_root',
      reason: 'linked_worktree',
    };
  }

  return {
    effectiveRoot: cwd,
    mode: 'current_directory',
    reason: 'main_worktree',
  };
}

function resolveWorktreeContext(cwd: string, deps: WorktreeDeps = {}): WorktreeContextResult {
  const existsSync = deps.existsSync || fs.existsSync;

  // Local .planning takes precedence over linked-worktree remapping.
  if (existsSync(path.join(cwd, '.planning'))) {
    return {
      effectiveRoot: cwd,
      mode: 'current_directory',
      reason: 'has_local_planning',
    };
  }

  return resolveWorktreeLinkage(cwd, deps);
}

interface WorktreePrunePlan {
  repoRoot: string;
  action: string;
  reason: string;
  destructiveModeRequested: boolean;
}

function planWorktreePrune(repoRoot: string, options: { allowDestructive?: boolean } = {}, deps: WorktreeDeps = {}): WorktreePrunePlan {
  const parsePorcelain = deps.parseWorktreePorcelain || parseWorktreePorcelain;
  const destructiveModeRequested = Boolean(options.allowDestructive);
  const listed = readWorktreeList(repoRoot, deps);
  if (!listed.ok) {
    return {
      repoRoot,
      action: 'skip',
      reason: listed.reason,
      destructiveModeRequested,
    };
  }

  let worktrees: WorktreeBranchEntry[] = [];
  let parseFailed = false;
  try {
    worktrees = parsePorcelain(listed.porcelain);
  } catch {
    // Preserve the diagnostic distinction; execution still requires root
    // maintenance authority and never prunes from an incomplete inventory.
    // #3050/#3057 (B6): but the reason must NOT collide with the
    // genuinely-empty-list case below — a parser that could not read the
    // porcelain output is not the same fact as "there are no worktrees", and
    // this plan drives a PRUNE, so conflating them means a prune decision made
    // on unread data would be indistinguishable from one made on real data.
    worktrees = [];
    parseFailed = true;
  }

  return {
    repoRoot,
    action: 'metadata_prune_only',
    reason: parseFailed
      ? 'parse_failed'
      : (worktrees.length === 0 ? 'no_worktrees' : 'worktrees_present'),
    destructiveModeRequested,
  };
}

interface PruneExecuteResult {
  ok: boolean;
  action: string;
  reason: string;
  timedOut?: boolean;
  pruned: unknown[];
}

function executeWorktreePrunePlan(plan: WorktreePrunePlan | null, deps: WorktreeDeps = {}): PruneExecuteResult {
  void deps;
  if (!plan || plan.action === 'skip') {
    return {
      ok: false,
      action: plan ? plan.action : 'skip',
      reason: plan ? plan.reason : 'missing_plan',
      pruned: [],
    };
  }

  if (plan.action !== 'metadata_prune_only') {
    return {
      ok: false,
      action: plan.action,
      reason: 'unsupported_action',
      pruned: [],
    };
  }

  // A repository-wide prune can retire registrations belonging to owners
  // outside this plan. The helper has no complete owner/recovery accounting.
  // Leave that explicit native Git maintenance to root after reconciliation.
  return { ok: false, action: plan.action, reason: 'manual_root_prune_required', timedOut: false, pruned: [] };
}

interface LinkedWorktreePathsResult {
  ok: boolean;
  reason: string;
  paths: string[];
}

function listLinkedWorktreePaths(repoRoot: string, deps: WorktreeDeps = {}): LinkedWorktreePathsResult {
  const listed = readWorktreeList(repoRoot, deps);
  if (!listed.ok) {
    return {
      ok: false,
      reason: listed.reason,
      paths: [],
    };
  }

  const allPaths = listed.entries.map((entry) => entry.path);
  // git worktree list always includes the current/main worktree first.
  return {
    ok: true,
    reason: 'ok',
    paths: allPaths.slice(1),
  };
}

interface WorktreeFinding {
  kind: 'orphan' | 'stale' | 'unverified';
  path: string;
  ageMinutes?: number;
}

interface HealthResult {
  ok: boolean;
  reason: string;
  findings: WorktreeFinding[];
}

function inspectWorktreeHealth(repoRoot: string, options: { staleAfterMs?: number; nowMs?: number } = {}, deps: WorktreeDeps = {}): HealthResult {
  const inventory = snapshotWorktreeInventory(repoRoot, options, deps);
  if (!inventory.ok) {
    return {
      ok: false,
      reason: inventory.reason,
      findings: [],
    };
  }

  const findings: WorktreeFinding[] = [];
  for (const entry of inventory.entries) {
    if (entry.exists === 'absent') {
      findings.push({
        kind: 'orphan',
        path: entry.path,
      });
      continue;
    }
    if (entry.exists === 'unverified') {
      // #3050/#3057 (B5): existsSync confirmed the path is present but statSync
      // threw, so age/staleness could not be determined. This is neither
      // "orphan" (existsSync says it IS there) nor "healthy" (we never verified
      // it) — surface it as its own finding so a caller can't silently treat an
      // unverifiable worktree as confirmed present-and-not-stale.
      findings.push({
        kind: 'unverified',
        path: entry.path,
      });
      continue;
    }
    if (entry.isStale) {
      findings.push({
        kind: 'stale',
        path: entry.path,
        ageMinutes: entry.ageMinutes ?? undefined,
      });
    }
  }

  return {
    ok: true,
    reason: 'ok',
    findings,
  };
}

interface InventoryEntry {
  path: string;
  /**
   * Tri-state (#3050/#3057, B5): `'present'` = existsSync AND statSync both
   * succeeded (confirmed present, age known); `'absent'` = existsSync confirmed
   * the path is genuinely absent; `'unverified'` = existsSync confirmed presence
   * but statSync threw — presence could not be fully verified. `'unverified'`
   * MUST NOT be treated as `'present'`: a caller that could not check must not
   * report the worktree as confirmed present.
   */
  exists: 'present' | 'absent' | 'unverified';
  isStale: boolean;
  ageMinutes: number | null;
}

interface InventoryResult {
  ok: boolean;
  reason: string;
  entries: InventoryEntry[];
}

function snapshotWorktreeInventory(repoRoot: string, options: { staleAfterMs?: number; nowMs?: number } = {}, deps: WorktreeDeps = {}): InventoryResult {
  const existsSync = deps.existsSync || fs.existsSync;
  const statSync = deps.statSync || fs.statSync;
  const staleAfterMs = options.staleAfterMs ?? (60 * 60 * 1000);
  const nowMs = options.nowMs ?? Date.now();
  const listed = listLinkedWorktreePaths(repoRoot, { execGit: deps.execGit || execGitDefault });
  if (!listed.ok) {
    return {
      ok: false,
      reason: listed.reason,
      entries: [],
    };
  }

  const entries: InventoryEntry[] = [];
  for (const worktreePath of listed.paths) {
    let exists: 'present' | 'absent' | 'unverified' = 'absent';
    let isStale = false;
    let ageMinutes: number | null = null;

    if (!existsSync(worktreePath)) {
      entries.push({
        path: worktreePath,
        exists,
        isStale,
        ageMinutes,
      });
      continue;
    }

    try {
      const stat = statSync(worktreePath);
      exists = 'present';
      const ageMs = nowMs - stat.mtimeMs;
      ageMinutes = Math.round(ageMs / 60000);
      if (ageMs > staleAfterMs) {
        isStale = true;
      }
    } catch {
      // #3050/#3057 (B5): a statSync throw means presence could not be
      // verified — do NOT report exists:'present' (a guard that could not
      // check must not claim the worktree is confirmed present). Distinguish
      // from the genuinely-absent case above with a third state ('unverified')
      // rather than silently falling through to the pre-existing 'present' default.
      exists = 'unverified';
    }
    entries.push({
      path: worktreePath,
      exists,
      isStale,
      ageMinutes,
    });
  }

  return {
    ok: true,
    reason: 'ok',
    entries,
  };
}

interface CleanupManifestEntry {
  agent_id: string | null;
  worktree_path: string;
  branch: string;
  expected_base: string;
  allowed_bases?: string[];
  /** #2596: the plan's declared `files_modified`, when the recorder supplied it. Absent = unknown, never "declares nothing". */
  files_modified?: string[];
  /**
   * #3003: paths the PLAN declared it would delete. The deletions guard blocks only
   * deletions NOT in this list. Absent = declares nothing, which keeps the guard's
   * original unconditional block — never "authorizes everything".
   *
   * A path LIST, not a boolean, deliberately: a boolean would disarm the guard for the
   * whole entry, so an unexpected deletion riding along with a declared one would pass
   * unnoticed. Matching is EXACT after `normalizeScopePath`, never a prefix and never a
   * glob — a directory prefix authorizes a mass deletion, which is the precise accident
   * this guard exists to catch.
   */
  declared_deletions?: string[];

  /** Root acceptance of a pinned integration input. Missing or incomplete
   * authority blocks before rescue writes. A matching completed native worker
   * record and fresh liveness/recovery checks are also required. Automatic
   * retirement remains held because the native record accounts for one PID,
   * not all writers; successful integration returns integrated_retained.
   */
  retirement_authorization?: RetirementAuthorization;
}

/**
 * #ORCH-03: root-provided retirement authorization. See
 * `CleanupManifestEntry.retirement_authorization`.
 */
interface RetirementAuthorization {
  owner_id: string;
  accepted_head: string;
  recovery_ref: string;
}

/**
 * #ORCH-03: accept a well-formed authorization, drop anything else.
 *
 * Deliberately all-or-nothing. A partial object (`owner_id` but no
 * `accepted_head`, say) is NOT an authorization: normalizing it into a
 * half-populated record would let downstream code read a missing field as
 * "not checked", which is precisely the synthesized approval this field
 * exists to refuse. Returning `undefined` routes it back to the entry's
 * retained/pending path.
 */
function normalizeRetirementAuthorization(raw: unknown): RetirementAuthorization | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const ownerId = typeof r.owner_id === 'string' ? r.owner_id.trim() : '';
  const acceptedHead = typeof r.accepted_head === 'string' ? r.accepted_head.trim() : '';
  const recoveryRef = typeof r.recovery_ref === 'string' ? r.recovery_ref.trim() : '';
  if (!ownerId || !acceptedHead || !recoveryRef) return undefined;
  return { owner_id: ownerId, accepted_head: acceptedHead, recovery_ref: recoveryRef };
}

function normalizeCleanupManifestEntry(entry: unknown): CleanupManifestEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const worktreePath = typeof e.worktree_path === 'string'
    ? e.worktree_path
    : (typeof e.path === 'string' ? e.path : '');
  const branch = typeof e.branch === 'string' ? e.branch : '';
  const expectedBase = typeof e.expected_base === 'string' ? e.expected_base : '';
  if (!worktreePath || !branch || !expectedBase) return null;
  if (!WORKTREE_AGENT_BRANCH_RE.test(branch)) return null;
  const rawAllowedBases = Array.isArray(e.allowed_bases) ? e.allowed_bases : [];
  const allowedBases = Array.from(new Set(
    [expectedBase, ...rawAllowedBases.filter((base): base is string => typeof base === 'string' && base.length > 0)]
  ));
  // #2596: liberal in what we accept — non-array, or non-string / empty
  // elements, are dropped rather than coerced. An EMPTY result omits the field
  // entirely, so "declared nothing" is indistinguishable from "not recorded":
  // that ambiguity is already resolved as *unknown* by the per-plan submodule
  // gate's own `[ -z "$PLAN_FILES" ]` rule, and inventing a second rule here
  // would make an unrecorded plan look 100% out of scope.
  const filesModified = (Array.isArray(e.files_modified) ? e.files_modified : [])
    .filter((f): f is string => typeof f === 'string' && f.trim().length > 0);
  // #3003: same liberal-in-what-we-accept rule as `files_modified` above — non-array,
  // or non-string / empty elements, are dropped rather than coerced, and an EMPTY
  // result omits the field entirely so "declares nothing" stays indistinguishable
  // from "not recorded" (the guard's own absence-check already treats both as unknown).
  const declaredDeletions = (Array.isArray(e.declared_deletions) ? e.declared_deletions : [])
    .filter((f): f is string => typeof f === 'string' && f.trim().length > 0);
  const normalized: CleanupManifestEntry = {
    agent_id: typeof e.agent_id === 'string' ? e.agent_id : null,
    worktree_path: worktreePath,
    branch,
    expected_base: expectedBase,
    allowed_bases: allowedBases,
  };
  if (filesModified.length > 0) normalized.files_modified = filesModified;
  if (declaredDeletions.length > 0) normalized.declared_deletions = declaredDeletions;
  // #ORCH-03: all-or-nothing, same rule as every other optional field above.
  // A partial or malformed authorization is dropped, so the entry falls back
  // to the retained/pending path instead of being read as a half-grant.
  const retirementAuthorization = normalizeRetirementAuthorization(e.retirement_authorization);
  if (retirementAuthorization) normalized.retirement_authorization = retirementAuthorization;
  return normalized;
}

interface NormalizedManifestResult {
  ok: boolean;
  reason: string;
  entries: CleanupManifestEntry[];
}

function normalizeCleanupManifest(manifest: unknown): NormalizedManifestResult {
  let parsed: unknown = manifest;
  if (typeof manifest === 'string') {
    try {
      parsed = JSON.parse(manifest);
    } catch {
      return { ok: false, reason: 'invalid_manifest_json', entries: [] };
    }
  }

  const p = parsed as Record<string, unknown> | unknown[] | null;
  const rawEntries = Array.isArray(p)
    ? p
    : (Array.isArray((p as Record<string, unknown>)?.worktrees) ? (p as Record<string, unknown>).worktrees as unknown[] : []);
  const seen = new Set<string>();
  const entries: CleanupManifestEntry[] = [];
  for (const raw of rawEntries) {
    const entry = normalizeCleanupManifestEntry(raw);
    if (!entry) continue;
    const key = `${entry.worktree_path}\0${entry.branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }

  if (entries.length === 0) {
    return { ok: false, reason: 'empty_manifest', entries: [] };
  }

  return { ok: true, reason: 'ok', entries };
}

interface WaveCleanupPlan {
  ok: boolean;
  repoRoot: string;
  action: string;
  discovery: string;
  reason: string;
  entries: CleanupManifestEntry[];
}

function planWorktreeWaveCleanup(repoRoot: string, manifest: unknown): WaveCleanupPlan {
  const normalized = normalizeCleanupManifest(manifest);
  if (!normalized.ok) {
    return {
      ok: false,
      repoRoot,
      action: 'skip',
      discovery: 'manifest',
      reason: normalized.reason,
      entries: [],
    };
  }

  return {
    ok: true,
    repoRoot,
    action: 'cleanup_wave',
    discovery: 'manifest',
    reason: 'manifest_entries_present',
    entries: normalized.entries,
  };
}

function gitResultOk(result: GitResult | null | undefined): boolean {
  return !!(result && result.exitCode === 0 && !result.timedOut && !result.signal && !result.error);
}

/**
 * #ORCH-03: a pinned commit SHA — exactly what `rev-parse` will hand back for
 * `--verify --quiet <sha>^{commit}`. Only the full 40- or 64-hex form is
 * accepted, so an abbreviated or symbolic accepted_head cannot be silently
 * widened into whatever the ref happens to point at when the wave runs. That
 * widening is exactly the ORCH-03 defect (`--force` removal of a moved branch),
 * one level up: a mutable name is not an accepted head.
 */
const RETIREMENT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * #ORCH-03: the outcome of evaluating a `retirement_authorization`.
 *
 * `ok: true` carries the normalized authorization so the caller never has to
 * re-read (and cannot accidentally narrow) the same field. Every failure
 * carries a distinct reason code so the wave's output tells an operator which
 * of the several possible proofs was missing, rather than a single opaque
 * "blocked".
 */
type RetirementGateResult =
  | { ok: true; auth: RetirementAuthorization }
  | { ok: false; reason: string; detail: string };

/** Verify pinned integration acceptance, named recovery and completed native
 * owner evidence. This gate does not grant automatic retirement authority.
 */
function evaluateRetirementAuthorization(
  entry: CleanupManifestEntry,
  repoRoot: string,
  execGit: ExecGitFn,
  deps: WorktreeDeps = {},
): RetirementGateResult {
  const auth = entry.retirement_authorization;
  if (!auth) {
    return {
      ok: false,
      reason: 'retirement_authorization_required',
      detail:
        'no retirement_authorization on the manifest entry — the worktree, its lock and its branch are preserved'
        + ' until root supplies owner_id, accepted_head and recovery_ref',
    };
  }

  const owner = typeof entry.agent_id === 'string' ? entry.agent_id.trim() : '';
  if (!owner) {
    return {
      ok: false,
      reason: 'retirement_owner_unaccounted',
      detail: `manifest entry for ${entry.worktree_path} records no agent_id, so the authorization names an owner the entry cannot confirm`,
    };
  }
  if (owner !== auth.owner_id) {
    return {
      ok: false,
      reason: 'retirement_owner_mismatch',
      detail: `authorization owner_id ${auth.owner_id} does not match the registered agent_id ${owner}`,
    };
  }
  if (!RETIREMENT_SHA_RE.test(auth.accepted_head)) {
    return {
      ok: false,
      reason: 'retirement_accepted_head_malformed',
      detail: `accepted_head ${JSON.stringify(auth.accepted_head)} is not a full commit SHA`,
    };
  }

  const branchRef = `refs/heads/${entry.branch}`;
  if (!auth.recovery_ref.startsWith('refs/') || auth.recovery_ref === branchRef
    || !gitResultOk(execGit(['check-ref-format', auth.recovery_ref], { cwd: repoRoot }))
    || !gitResultOk(execGit(['check-ref-format', branchRef], { cwd: repoRoot }))) {
    return { ok: false, reason: 'retirement_recovery_ref_invalid', detail: 'recovery must be a valid named ref independent of the branch being retained' };
  }
  // A symbolic recovery ref could be an alias for the ref being retired.
  const symbolic = execGit(['symbolic-ref', '--quiet', auth.recovery_ref], { cwd: repoRoot });
  if (symbolic.exitCode !== 1 || symbolic.timedOut || symbolic.signal || symbolic.error
    || symbolic.stdout !== '' || symbolic.stderr !== '') {
    return { ok: false, reason: 'retirement_recovery_ref_invalid', detail: 'recovery must be a verified direct named ref, not a symbolic alias or an unknown probe' };
  }
  // rev-parse --verify accepts ONE object. Resolve each separately and validate
  // its answer before using it as recovery/acceptance evidence (RGS-06/07).
  const accepted = execGit(['rev-parse', '--verify', '--quiet', `${auth.accepted_head}^{commit}`], { cwd: repoRoot });
  if (!gitResultOk(accepted) || accepted.stdout.trim() !== auth.accepted_head) {
    return { ok: false, reason: 'retirement_accepted_head_unverified', detail: 'accepted head did not resolve to the exact accepted commit' };
  }
  const recovery = execGit(['rev-parse', '--verify', '--quiet', `${auth.recovery_ref}^{commit}`], { cwd: repoRoot });
  if (!gitResultOk(recovery) || !RETIREMENT_SHA_RE.test(recovery.stdout.trim())) {
    return { ok: false, reason: 'retirement_recovery_ref_unverified', detail: 'named recovery ref did not resolve to a commit' };
  }
  if (!gitResultOk(execGit(['merge-base', '--is-ancestor', auth.accepted_head, recovery.stdout.trim()], { cwd: repoRoot }))) {
    return { ok: false, reason: 'retirement_recovery_does_not_cover_head', detail: 'named recovery ref does not verifiably retain the accepted head' };
  }

  // The branch must still be AT the accepted head. This is the pre-merge half of
  // ORCH-03's "recheck fresh head": a branch that advanced after review is no
  // longer the reviewed work, so nothing is merged or retired.
  const branchHead = execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${entry.branch}`], { cwd: repoRoot });
  if (!gitResultOk(branchHead)) {
    return {
      ok: false,
      reason: 'retirement_branch_unresolvable',
      detail: `branch ${entry.branch} could not be resolved (${branchHead?.stderr?.trim() || 'no detail'})`,
    };
  }
  const branchSha = String(branchHead.stdout || '').trim();
  if (branchSha !== auth.accepted_head) {
    return {
      ok: false,
      reason: 'retirement_head_mismatch',
      detail: `branch ${entry.branch} is at ${branchSha}, but the authorization accepts ${auth.accepted_head}`,
    };
  }

  // The manifest is acceptance input, not lifecycle evidence. Read the native
  // sibling worker record independently, including for a completed worker.
  const worktreePath = path.resolve(repoRoot, entry.worktree_path);
  const recordPath = workerRecordPath(worktreePath);
  let record: WorkerRecord;
  try {
    const stat = (deps.lstatSync || fs.lstatSync)(recordPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('worker record is not a regular file');
    record = JSON.parse((deps.readFileSync || ((p: string) => fs.readFileSync(p, 'utf8')))(recordPath)) as WorkerRecord;
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid native worker record');
  } catch {
    return { ok: false, reason: 'retirement_owner_evidence_unverified', detail: 'native worker lifecycle record is missing, unreadable or malformed; root must reconcile the owner' };
  }
  if (record.agentId !== owner || typeof record.worktreePath !== 'string'
    || !path.isAbsolute(record.worktreePath) || path.resolve(record.worktreePath) !== worktreePath) {
    return { ok: false, reason: 'retirement_owner_evidence_mismatch', detail: 'native worker record does not account for this exact owner and path' };
  }
  const started = Date.parse(record.startedAt);
  const completed = record.completedAt ? Date.parse(record.completedAt) : NaN;
  if (record.state !== 'complete' || record.exitCode !== 0 || typeof record.startedAt !== 'string'
    || typeof record.completedAt !== 'string' || !Number.isFinite(started)
    || !Number.isFinite(completed) || completed < started || completed > (deps.nowMs ?? Date.now())
    || !Number.isInteger(record.pid) || record.pid <= 0 || record.pid > 2147483647) {
    return { ok: false, reason: 'retirement_owner_incomplete', detail: 'native worker record does not prove successful completion with a valid process identity' };
  }
  try {
    if ((deps.isPidAlive || defaultIsPidAlive)(record.pid) !== false) {
      return { ok: false, reason: 'retirement_owner_live_or_unknown', detail: 'fresh owner liveness is live or unknown; worktree and branch retained' };
    }
  } catch {
    return { ok: false, reason: 'retirement_owner_live_or_unknown', detail: 'fresh owner liveness could not be established; worktree and branch retained' };
  }

  return { ok: true, auth };
}

/** A bounded/incomplete inventory is unknown, never evidence of absence. */
function findNestedCheckout(
  worktreePath: string,
  deps: WorktreeDeps,
): { state: 'present' | 'absent' | 'unknown'; detail: string } {
  const lstat = deps.lstatSync || fs.lstatSync;
  const readDir = deps.readDirSafe || defaultReadDirSafe;
  const unknown = (detail: string) => ({ state: 'unknown' as const, detail });
  try {
    const root = lstat(worktreePath);
    if (!root.isDirectory() || root.isSymbolicLink()) return unknown('worktree path is not a regular directory');
    const dotGit = lstat(path.join(worktreePath, '.git'));
    if (dotGit.isDirectory()) return { state: 'present', detail: 'root holds a primary checkout .git directory' };
    if (!dotGit.isFile() || dotGit.isSymbolicLink()) return unknown('worktree .git pointer is not a regular file');
  } catch {
    return unknown('worktree identity could not be read');
  }
  const walk = (dir: string, depth: number): { state: 'present' | 'absent' | 'unknown'; detail: string } => {
    let names: string[] | null;
    try { names = readDir(dir); } catch { return unknown(`unreadable directory: ${dir}`); }
    if (!names) return unknown(`unreadable directory: ${dir}`);
    for (const name of names) {
      if (name === '.git' && depth === 0) continue;
      const full = path.join(dir, name);
      if (name === '.git') return { state: 'present', detail: `nested checkout: ${full}` };
      let stat: fs.Stats;
      try { stat = lstat(full); } catch { return unknown(`unreadable entry: ${full}`); }
      if (stat.isSymbolicLink()) return unknown(`symlinked entry: ${full}`);
      if (!stat.isDirectory()) continue;
      if (depth >= 3 || name === 'node_modules') return unknown(`scan bound excludes directory: ${full}`);
      const result = walk(full, depth + 1);
      if (result.state !== 'absent') return result;
    }
    return { state: 'absent', detail: '' };
  };
  return walk(worktreePath, 0);
}

/** Observe current reachability instead of inferring integration from a wrapper exit. */
function observeIntegration(execGit: ExecGitFn, repoRoot: string, acceptedHead: string): boolean | null {
  try {
    const probe = execGit(['merge-base', '--is-ancestor', acceptedHead, 'HEAD'], { cwd: repoRoot });
    if (!probe || probe.timedOut || probe.signal || probe.error || probe.stdout !== '' || probe.stderr !== '') return null;
    return probe.exitCode === 0 ? true : probe.exitCode === 1 ? false : null;
  } catch { return null; }
}

/** Refuse integration into a pre-existing or unverified parent sequencer. */
function integrationSequencerBlock(execGit: ExecGitFn, repoRoot: string): string | null {
  for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_AUTOSTASH']) {
    const probe = execGit(['rev-parse', '--verify', '-q', ref], { cwd: repoRoot });
    if (probe.exitCode === 1 && !probe.timedOut && !probe.signal && !probe.error
      && probe.stdout === '' && probe.stderr === '') continue;
    return `parent ${ref} is present or unverified; preserve the existing sequencer and index for root`;
  }
  return null;
}

type ParentIntegrationInventory =
  | { ok: true; head: string }
  | { ok: false; reason: string; detail: string };

/**
 * RGS-11: only a clean, fully observed parent has a tracked recovery boundary
 * in HEAD. No uncommitted parent data has ownership/recovery evidence here, so
 * even non-conflicting untracked/ignored data holds integration for root.
 *
 * These reads are NOT an exclusive writer lease. The caller must account for
 * parent writers/hooks before invocation; a writer after the final observation
 * can still race Git itself. The native worker record proves neither parent
 * quiescence nor an exhaustive nested-submodule inventory.
 */
function inspectParentIntegrationInventory(execGit: ExecGitFn, repoRoot: string): ParentIntegrationInventory {
  const unknown = (): ParentIntegrationInventory => ({
    ok: false,
    reason: 'integration_parent_inventory_unverified',
    detail: 'parent tracked/untracked/ignored inventory or HEAD recovery boundary is unknown; retain all work for manual root accounting',
  });
  try {
    const head = execGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: repoRoot });
    if (!gitResultOk(head) || head.stderr !== '' || !RETIREMENT_SHA_RE.test(head.stdout)) return unknown();
    // Disable optional index writes and cached filesystem observations. status
    // alone hides assume-unchanged/skip-worktree entries: reject those flags,
    // unmerged entries and gitlinks whose nested ignored inventory is unknown.
    const tracked = execGit(['--no-optional-locks', 'ls-files', '--stage', '-v', '-z'], { cwd: repoRoot });
    if (!gitResultOk(tracked) || tracked.stderr !== '' || typeof tracked.stdout !== 'string') return unknown();
    if (tracked.stdout !== '') {
      if (!tracked.stdout.endsWith('\0')) return unknown();
      const records = tracked.stdout.slice(0, -1).split('\0');
      if (records.some(record => !/^H (?:100644|100755|120000) (?:[0-9a-f]{40}|[0-9a-f]{64}) 0\t[^\0]+$/.test(record))) return unknown();
    }
    const inventory = execGit([
      '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none',
    ], { cwd: repoRoot });
    if (!gitResultOk(inventory) || inventory.stderr !== '' || typeof inventory.stdout !== 'string') return unknown();
    if (inventory.stdout !== '') {
      const lines = inventory.stdout.split('\n');
      const kind = lines.some(line => line.startsWith('!! ')) ? 'ignored_data_present'
        : lines.some(line => line.startsWith('?? ')) ? 'untracked_data_present' : 'tracked_changes';
      return {
        ok: false,
        reason: `integration_parent_${kind}`,
        detail: 'parent contains unaccounted tracked, untracked or ignored data; no merge or automatic backup/restore is authorized; retain it for manual root accounting',
      };
    }
    const freshHead = execGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: repoRoot });
    if (!gitResultOk(freshHead) || freshHead.stderr !== '' || freshHead.stdout !== head.stdout) return unknown();
    return { ok: true, head: head.stdout };
  } catch { return unknown(); }
}

// #2596: the single definition of "this file is an executor-written SUMMARY
// artifact". Shared by `defaultFindSummaryFiles` (which walks for them to
// rescue) and the scope advisory below (which must never flag them) — a plan's
// declared `files_modified` never lists a SUMMARY, because the executor writes
// it by orchestration contract, so a second copy of this rule would make the
// advisory fire on essentially every wave.
const SUMMARY_ARTIFACT_DIR = '.planning';
const SUMMARY_ARTIFACT_SUFFIX = 'SUMMARY.md';

/**
 * Decode a git-quoted path. With `core.quotepath` left at its default (`true`)
 * git wraps any path containing non-ASCII or special bytes in double quotes
 * and C-escapes it — e.g. `tests/é.ts` is emitted as the literal
 * `"tests/\303\251.ts"`. Both sides of the deletion/scope comparison
 * (a declared path and a git-reported path) must agree on the same decoded
 * shape, and decoding it here — rather than passing `-c core.quotepath=false`
 * on the `execGit` call — keeps the git argv, and therefore every existing
 * test fixture that asserts on exact argv, unchanged. It also works
 * regardless of the user's own `core.quotepath` config.
 *
 * A value that is not wrapped in a leading and trailing `"` is returned
 * completely untouched — this is the overwhelmingly common (plain ASCII)
 * case and must not be altered in any way.
 *
 * Escapes decode to BYTES, collected into a Buffer and decoded as UTF-8 only
 * at the end: `\303\251` is two bytes that together form one character (é),
 * so decoding them one at a time would produce mojibake. Malformed input
 * (a trailing lone backslash, or an octal escape with fewer than three
 * digits) never throws — it degrades to treating the character literally, so
 * a single bad path can never take down the whole cleanup wave.
 *
 * Exported (#4081) so the codebase-drift gate's `--name-status` parser can
 * decode the identical C-quoted form before classifying paths — the gate's
 * `execGit` call sets no `core.quotepath` config, so it receives the same
 * quoting and must decode it with the same single owner of this seam.
 */
function decodeGitQuotedPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\' || i === body.length - 1) {
      // UTF-8 bytes, not the code unit: a DECLARED path may be quoted while
      // still holding a literal `é`, and pushing 0xE9 alone is invalid UTF-8.
      // codePointAt keeps a surrogate pair together.
      const codePoint = body.codePointAt(i);
      const char = codePoint === undefined ? ch : String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(char, 'utf8'));
      i += char.length - 1;
      continue;
    }
    const rest = body.slice(i + 1);
    const octalMatch = /^([0-3][0-7][0-7])/.exec(rest);
    if (octalMatch) {
      bytes.push(parseInt(octalMatch[1], 8));
      i += 3;
      continue;
    }
    const next = body[i + 1];
    const CONTROL_ESCAPES: Record<string, number> = {
      a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b,
      '\\': 0x5c, '"': 0x22,
    };
    if (Object.prototype.hasOwnProperty.call(CONTROL_ESCAPES, next)) {
      bytes.push(CONTROL_ESCAPES[next]);
    } else {
      bytes.push(next.charCodeAt(0));
    }
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Normalize one path for scope comparison. Applied to BOTH sides so a declared
 * path and a git-reported path meet in the same shape: any git C-quoting is
 * decoded first (order matters — the backslash-to-slash conversion below
 * would destroy the escape sequences if it ran first), then backslashes
 * become slashes unconditionally (a backslash path is not a Windows-only
 * input), and a leading `./` and any trailing `/` are stripped. This is the
 * single normalizer shared by the SUMMARY-artifact predicate and the scope
 * advisory, so the two can never disagree about what `./a\b/` means.
 */
function normalizeScopePath(raw: string): string {
  return decodeGitQuotedPath(String(raw || '').trim())
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/**
 * True when a worktree-relative path is a SUMMARY artifact. Input may use
 * either separator; normalization to POSIX is unconditional (backslash paths
 * reach Linux too).
 */
function isSummaryArtifactRelPath(relPath: string): boolean {
  const normalized = normalizeScopePath(relPath);
  return normalized.startsWith(`${SUMMARY_ARTIFACT_DIR}/`) // allow-handrolled-containment: artifact-type classification by a fixed known subdirectory name, not a filesystem root-confinement gate
    && normalized.endsWith(SUMMARY_ARTIFACT_SUFFIX);
}

/**
 * Walk <worktreePath>/.planning/ recursively and collect absolute paths of
 * all files whose names match *SUMMARY.md.  Returns [] when the directory
 * does not exist or cannot be read.
 *
 * Mirrors the shell fallback in quick.md (#2296, #2070, #2838):
 *   find "$WT/.planning" -name "*SUMMARY.md"
 */
function defaultFindSummaryFiles(worktreePath: string): string[] {
  const planningDir = path.join(worktreePath, SUMMARY_ARTIFACT_DIR);
  const results: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(SUMMARY_ARTIFACT_SUFFIX)) {
        results.push(full);
      }
    }
  }
  walk(planningDir);
  return results;
}

/**
 * Rescue uncommitted SUMMARY.md artifacts from a worktree into the main repo
 * tree before the dirty-state check.  Mirrors the shell-fallback rescue block
 * in quick.md (lines 878–891, #2296/#2070/#2838).
 *
 * For each *SUMMARY.md found under <worktreePath>/.planning/:
 *   - compute relative path from worktree root  → .planning/<id>-SUMMARY.md
 *   - if the file is ALREADY COMMITTED on the worktree branch
 *     (`git cat-file -e HEAD:<relPath>` returns exit 0), skip the copy entirely:
 *     the merge will carry it naturally and copying it as an untracked file would
 *     cause a "untracked working tree files would be overwritten by merge" collision.
 *     If commitment is not confirmed, attempt only a confined no-overwrite
 *     rescue and retain both copies on any uncertainty or divergence.
 *     (#706 — execute-phase committed-SUMMARY contract)
 *   - destination = <repoRoot>/<relPath>
 *   - copy ONLY when dest is absent, or when it already holds identical bytes
 *     (a no-op). A divergent, incomparable or uncontained destination is
 *     preserved on both sides and reported as a failure; see #ORCH-02 below.
 *
 * Returns `{ rescuedRelPaths, failures }`:
 *   - `rescuedRelPaths`: Set of worktree-relative paths that were successfully rescued
 *     (copy not needed because dest already matches, or copy succeeded).  Only paths
 *     where the rescue genuinely succeeded are included so the dirty-block filter does
 *     not suppress paths that were silently lost.
 *   - `failures`: array of `{ relPath, error }` for any path where mkdirSync or
 *     copyFileSync threw, where the destination failed the symlink/containment
 *     guard, or where the destination could not be PROVEN identical to the
 *     source. Every failure blocks the caller; none of them overwrites the
 *     destination. (#ORCH-02)
 */
function rescueSummaryArtifacts(
  worktreePath: string,
  repoRoot: string,
  deps: WorktreeDeps,
): { rescuedRelPaths: Set<string>; failures: Array<{ relPath: string; error: string }> } {
  const execGit = deps.execGit || execGitDefault;
  const realpath = deps.realpathSync || fs.realpathSync;
  const lstat = deps.lstatSync || fs.lstatSync;
  const readBytes = deps.readFileBytes || ((p: string) => fs.readFileSync(p));
  const copy = deps.copyFileSync || fs.copyFileSync;
  const mkdir = deps.mkdirSync || fs.mkdirSync;
  const worker = path.resolve(repoRoot, worktreePath);
  const parent = path.resolve(repoRoot);
  const rescuedRelPaths = new Set<string>();
  const failures: Array<{ relPath: string; error: string }> = [];

  // Append ONLY components proven absent by lstat. EIO/EACCES, dangling
  // symlinks and failures resolving an existing ancestor must stop the rescue.
  const resolveMissing = (target: string): string => {
    try { lstat(target); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const up = path.dirname(target);
      if (up === target) throw err;
      return path.join(resolveMissing(up), path.basename(target));
    }
    return realpath(target);
  };
  let summaryPaths: string[];
  try { summaryPaths = (deps.findSummaryFiles || defaultFindSummaryFiles)(worker); } catch (err) {
    return { rescuedRelPaths, failures: [{ relPath: '.planning', error: `summary_rescue_scan_failed: ${(err as Error).message}` }] };
  }
  for (const source of summaryPaths) {
    const relPath = posixNormalize(path.relative(worker, source));
    try {
      if (!isSummaryArtifactRelPath(relPath) || !isContainedIn(path.resolve(source), worker)) {
        throw new Error('summary_rescue_source_outside_worktree');
      }
      const rootReal = realpath(parent);
      const workerReal = realpath(worker);
      const sourceStat = lstat(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()
        || !isContainedIn(realpath(source), workerReal)) throw new Error('summary_rescue_source_uncontained_or_symlink');
      const committed = execGit(['-C', worker, 'cat-file', '-e', `HEAD:${relPath}`], { cwd: parent });
      if (gitResultOk(committed)) continue;
      const dest = path.resolve(parent, relPath);
      const validateDestination = (): void => {
        if (!isContainedIn(dest, parent) || !isContainedIn(resolveMissing(path.dirname(dest)), rootReal)) {
          throw new Error('summary_rescue_destination_outside_repo');
        }
        try {
          const stat = lstat(dest);
          if (!stat.isFile() || stat.isSymbolicLink() || !isContainedIn(realpath(dest), rootReal)) {
            throw new Error('summary_rescue_destination_symlink_or_nonfile');
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      };
      validateDestination();
      const identical = (): boolean => {
        validateDestination();
        const a = readBytes(source);
        const b = readBytes(dest);
        if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) throw new Error('summary_rescue_compare_requires_bytes');
        return a.equals(b);
      };
      let absent = false;
      try { lstat(dest); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        absent = true;
      }
      if (absent) {
        mkdir(path.dirname(dest), { recursive: true });
        validateDestination();
        // COPYFILE_EXCL is the publication guard, not the earlier absence read.
        // A late destination (including a symlink) can never be overwritten.
        try { copy(source, dest, fs.constants.COPYFILE_EXCL); } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      // Re-read raw bytes after publication or a late EEXIST. A failed/partial
      // copy or divergence keeps the source and the parent's evidence in place.
      if (!identical()) throw new Error('summary_rescue_diverged: both copies preserved');
      rescuedRelPaths.add(relPath);
    } catch (err) {
      failures.push({ relPath, error: (err as Error).message });
    }
  }
  return { rescuedRelPaths, failures };
}

/**
 * #2596: advisory codes emitted by the wave-cleanup gauntlet. Frozen and
 * exported so tests assert on a code rather than on rendered prose (this repo
 * forbids raw-text matching on test output).
 */
const WAVE_CLEANUP_WARNING = Object.freeze({
  /** A committed path fell outside the plan's declared `files_modified`. */
  SCOPE_OUT_OF_DECLARED: 'scope_out_of_declared',
  /** The scope diff could not be computed, so conformance is unknown. */
  SCOPE_CHECK_UNAVAILABLE: 'scope_check_unavailable',
  /** Legacy warning codes retained for consumers; automatic restoration is disabled. */
  MERGE_RESIDUE_RESTORED: 'merge_residue_restored',
  MERGE_RESIDUE_LEFT_STAGED: 'merge_residue_left_staged',
  MERGE_AUTOSTASH_UNRESTORED: 'merge_autostash_unrestored',
  /** A failed or unverified merge is preserved intact and the wave is halted. */
  MERGE_MANUAL_ROOT_RECOVERY_REQUIRED: 'merge_manual_root_recovery_required',
  /**
   * #4415: an entry was merged on the evidence that its checkout was already
   * gone, rather than on a clean read of a present worktree.
   *
   * Emitted because "the harness cleanly removed a finished executor" and
   * "something else removed this path" are the same signature to this code —
   * git still registers the path -> branch binding, and `statSync` reports
   * ENOENT, in both cases. Before this path existed, EVERY anomalous absence
   * blocked loudly, which gave an operator something to investigate; accepting
   * the routine case silently would take that signal away from the case that is
   * not routine. Advisory, never a gate: the entry still merged.
   */
  ACCEPTED_ABSENT_WORKTREE: 'accepted_absent_worktree',
});

interface WaveCleanupWarning {
  code: string;
  branch: string;
  /** The offending path; null when the check itself could not run. */
  path: string | null;
  /**
   * #4415: git's own words for why it considers the registration stale — the
   * text of the porcelain `prunable` line. Present only on
   * ACCEPTED_ABSENT_WORKTREE, and null when git marked the entry prunable with
   * no reason (it emits the marker bare in some versions).
   */
  detail?: string | null;
}

/**
 * The literal directory prefix a declared path covers, or `null` when the
 * pattern begins with a glob metacharacter and therefore has no usable prefix.
 *
 * Deliberately literal-prefix only — NOT a glob engine. A hand-rolled
 * `**`/`*`/`?` matcher inside a worktree-lifecycle module is an informal,
 * undocumented pattern language living where no language belongs, and this
 * repo forbids external deps in core. The submodule-intersection gate
 * (`workflows/execute-phase/steps/per-plan-worktree-gate.md`) already ships
 * exactly this glob-prefix rule; reusing it beats inventing a second one.
 *
 * `null` (no literal prefix, e.g. `*.md`) means "matches everything": for an
 * ADVISORY, a false alarm costs more than a miss, so the ambiguous case
 * suppresses rather than shouts.
 */
function declaredScopePrefix(declared: string): string | null {
  const globAt = declared.search(/[*?[]/);
  if (globAt < 0) return declared;
  const literal = declared.slice(0, globAt).replace(/\/+$/, '');
  return literal.length > 0 ? literal : null;
}

/**
 * #2596: compare a branch's actual committed paths against the plan's declared
 * scope. Pure — no git, no IO. Returns one warning per out-of-scope path, in
 * the order the paths were given. Returns [] when nothing usable was declared:
 * absence of data is not evidence of over-reach.
 */
function planWaveScopeConformance(
  changedPaths: unknown,
  declaredFiles: unknown,
  branch: string,
): WaveCleanupWarning[] {
  if (!Array.isArray(declaredFiles)) return [];
  const prefixes: Array<string | null> = [];
  for (const declared of declaredFiles) {
    if (typeof declared !== 'string') continue;
    const normalized = normalizeScopePath(declared);
    if (!normalized) continue;
    prefixes.push(declaredScopePrefix(normalized));
  }
  if (prefixes.length === 0) return [];

  const warnings: WaveCleanupWarning[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(changedPaths) ? changedPaths : []) {
    if (typeof raw !== 'string') continue;
    const changed = normalizeScopePath(raw);
    if (!changed || seen.has(changed)) continue;
    seen.add(changed);
    if (isSummaryArtifactRelPath(changed)) continue;
    const covered = prefixes.some((prefix) => (
      prefix === null || changed === prefix || changed.startsWith(`${prefix}/`) // allow-handrolled-containment: advisory scope-coverage match against a caller-declared prefix (documented above as deliberately distinct from a security gate) — not a filesystem root-confinement decision
    ));
    if (covered) continue;
    warnings.push({ code: WAVE_CLEANUP_WARNING.SCOPE_OUT_OF_DECLARED, branch, path: changed });
  }
  return warnings;
}

/**
 * #3003: split git's reported deletions into declared and undeclared.
 *
 * EXACT match after `normalizeScopePath` — the same normalizer both other path
 * comparisons in this file use, so a declared path and a git-reported path meet in the
 * same shape (`a\b` and `./a/b/` both become `a/b`).
 *
 * Deliberately NOT `declaredScopePrefix`. That helper returns `null` for a glob-leading
 * pattern meaning "matches everything", which is right for the ADVISORY it serves — a
 * false alarm there costs more than a miss — and exactly wrong for a GATE, where it would
 * let `["*.ts"]` disarm the guard. A glob here is simply a literal path that matches
 * nothing. Prefix matching is likewise refused: `["tests"]` must not authorize deleting
 * everything under tests/.
 *
 * Pure — no git, no IO. Returns the undeclared residue in the order git reported it.
 */
function partitionDeclaredDeletions(deletedPaths: unknown, declared: unknown): string[] {
  const allowed = new Set(
    (Array.isArray(declared) ? declared : [])
      .filter((p): p is string => typeof p === 'string')
      .map((p) => normalizeScopePath(p))
      .filter((p) => p.length > 0),
  );
  const undeclared: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(deletedPaths) ? deletedPaths : []) {
    if (typeof raw !== 'string') continue;
    const normalized = normalizeScopePath(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    if (allowed.has(normalized)) continue;
    undeclared.push(normalized);
  }
  return undeclared;
}

interface WaveCleanupEntryResult extends CleanupManifestEntry {
  /** true only when integration was observed; null means a failed probe. */
  integrated: boolean | null;
  /** Observed tracked recovery boundary, not a parent writer lease. */
  parent_head_before_merge?: string;
  status: string;
  reason: string | null;
  stderr: string;
  warnings: WaveCleanupWarning[];
}

interface WaveCleanupResult {
  ok: boolean;
  action: string;
  reason: string;
  entries: WaveCleanupEntryResult[];
  pending: CleanupManifestEntry[];
  warnings: WaveCleanupWarning[];
}

function executeWorktreeWaveCleanupPlan(plan: WaveCleanupPlan | null, deps: WorktreeDeps = {}): WaveCleanupResult {
  const execGit = deps.execGit || execGitDefault;
  const entries = Array.isArray(plan?.entries) ? plan.entries : [];
  if (!plan || plan.action !== 'cleanup_wave' || entries.length === 0) {
    return {
      ok: false,
      action: plan ? plan.action : 'skip',
      reason: plan ? (plan.reason || 'missing_entries') : 'missing_plan',
      entries: [],
      pending: entries,
      warnings: [],
    };
  }

  const results: WaveCleanupEntryResult[] = [];
  const pending: CleanupManifestEntry[] = [];
  const allWarnings: WaveCleanupWarning[] = [];
  let ok = true;

  // #4415: two questions, two sources, each asked only what it can actually prove.
  //
  //   IDENTITY  — "is the checkout registered at this path the branch the manifest
  //               names?" — comes from `git worktree list --porcelain`.
  //   REMOVAL   — "is the directory actually gone, as opposed to unreadable?" —
  //               comes from `statSync`'s errno.
  //
  // Neither source can answer the other's question, and both mistakes have been
  // measured rather than reasoned about:
  //
  // 1. An earlier cut inferred removal from `fs.existsSync` returning false and,
  //    with no checkout left to read, fell back to `refs/heads/<branch>` for
  //    identity. Git never loses the binding: after `rm -rf` it still prints
  //    `worktree <path>` + `branch refs/heads/<branch>`. The ref fallback weakened
  //    identity from "the checkout registered here is on this branch" to "a branch
  //    by this name exists", which let a foreign sibling branch through the gate.
  //
  // 2. `prunable` is NOT a removal test. Measured: with a parent directory at mode
  //    000, git emits `prunable gitdir file points to non-existent location` for a
  //    checkout that is still there — it cannot traverse the parent, so it reports
  //    the gitdir file as missing. Accepting `prunable` as "removed" would merge
  //    over uncommitted work in an unreadable worktree, which is the very thing the
  //    dirty check exists to refuse. `statSync` separates them: ENOENT is gone,
  //    EACCES/EIO is unreadable.
  //
  const resolveAgainstRepoRoot = (worktreePath: string): string => path.resolve(plan.repoRoot, worktreePath);
  const canonicalIdentity = (target: string): string | null => {
    try {
      try { (deps.lstatSync || fs.lstatSync)(target); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        const parent = path.dirname(target);
        if (parent === target) return null;
        const ancestor = canonicalIdentity(parent);
        return ancestor === null ? null : path.join(ancestor, path.basename(target));
      }
      return (deps.realpathSync || fs.realpathSync)(target);
    } catch { return null; }
  };
  const registeredFor = (worktreePath: string): WorktreeEntry | undefined => {
    const listed = readWorktreeList(plan.repoRoot, { execGit });
    const target = canonicalIdentity(resolveAgainstRepoRoot(worktreePath));
    return listed.ok && target !== null
      ? listed.entries.find((entry) => canonicalIdentity(resolveAgainstRepoRoot(entry.path)) === target)
      : undefined;
  };

  const statSyncRaw = deps.statSync || fs.statSync;
  // Only ENOENT is removal. A path that stats successfully is present; any other
  // errno means it could not be read, and an unreadable checkout blocked before
  // this PR and must keep blocking.
  const confirmedGone = (worktreePath: string): boolean => {
    try {
      statSyncRaw(resolveAgainstRepoRoot(worktreePath));
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    }
  };

  // Carries git's `prunable` reason for the most recent acceptance, so the
  // warning below can quote git rather than paraphrase it. Set only on the
  // accepting call; callers that reject never read it.
  let lastAcceptedPrunableReason: string | null = null;
  const absentAndIdentified = (worktreePath: string, branch: string): boolean => {
    const registered = registeredFor(worktreePath);
    if (!registered || registered.branch !== branch) return false;
    if (!confirmedGone(worktreePath)) return false;
    lastAcceptedPrunableReason = registered.prunable;
    return true;
  };

  /**
   * #4415 (maintainer review round 3): record that an entry took the absent path.
   *
   * Two Medium findings close here together. This code cannot distinguish "the
   * harness cleanly removed a finished executor" from "an operator or an external
   * process removed this path" — both leave git's registration intact and both
   * stat ENOENT. Before the absent path existed, every anomalous absence blocked
   * loudly; accepting the routine case silently would have removed that signal
   * from the case that is not routine, reporting `merged_removed`/`ok`
   * indistinguishably from an ordinary merge. The module already carries an
   * advisory channel for a materially less risky condition (scope conformance) a
   * few lines below, so withholding one here was inconsistent with its own
   * pattern.
   *
   * It also gives `WorktreeEntry.prunable` its consumer. The field was parsed and
   * documented as "worth surfacing to an operator" and then never read — dead
   * weight, and its bare-marker test asserted an outcome driven by other code.
   * Quoting git's own reason here is what that parsing was for.
   */
  const noteAcceptedAbsent = (result: WaveCleanupEntryResult, entry: CleanupManifestEntry): void => {
    // The parser normalises a bare `prunable` line to the literal 'prunable' so the
    // field stays truthy either way. That sentinel is the marker echoed back, not a
    // reason, so it is reported as "no reason given" rather than quoted at an
    // operator as though git had said something.
    const reason = lastAcceptedPrunableReason === 'prunable' ? null : lastAcceptedPrunableReason;
    const warning: WaveCleanupWarning = {
      code: WAVE_CLEANUP_WARNING.ACCEPTED_ABSENT_WORKTREE,
      branch: entry.branch,
      path: entry.worktree_path,
      detail: reason,
    };
    result.warnings.push(warning);
    allWarnings.push(warning);
  };

  // Per-entry refusals remain independent until a merge is attempted. A failed
  // or unverified merge halts the wave because parent state has no known owner.
  function blockEntry(result: WaveCleanupEntryResult, reason: string, stderr: string): void {
    result.status = result.integrated === true ? 'integrated_retained' : result.integrated === null ? 'integration_unknown_retained' : 'blocked';
    result.reason = reason;
    result.stderr = stderr;
    results.push(result);
    ok = false;
  }

  function noteManualMergeRecovery(result: WaveCleanupEntryResult): string {
    const detail = 'Manual root recovery required: parent index, worktree, merge/autostash state, worker checkouts and all recovery refs are retained. Account for any still-running hooks or concurrent writers before recovery or another merge.';
    const warning: WaveCleanupWarning = {
      code: WAVE_CLEANUP_WARNING.MERGE_MANUAL_ROOT_RECOVERY_REQUIRED,
      branch: result.branch,
      path: null,
      detail,
    };
    result.warnings.push(warning);
    allWarnings.push(warning);
    return detail;
  }

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const result: WaveCleanupEntryResult = {
      ...entry,
      integrated: false,
      status: 'pending',
      reason: null,
      stderr: '',
      warnings: [],
    };

    // #4415: the harness may have already removed this worktree. Claude Code
    // removes a subagent's worktree the moment the subagent finishes with a
    // clean tree, and an executor that committed everything — SUMMARY.md
    // included, under `commit_docs: true` — is exactly that case, so by wave
    // cleanup the directory is routinely gone while the branch it left behind
    // is intact and mergeable.
    //
    // `git -C <gone> rev-parse` fails, and that failure was indistinguishable
    // from a genuine mismatch, so the entry blocked as `branch_mismatch` and
    // nothing merged. Disambiguate at the point of failure rather than ahead of
    // it: a SUCCESSFUL read still decides identity exactly as before (a present
    // worktree on the wrong branch blocks, unchanged), and only a FAILED read
    // asks git and the filesystem why.
    let worktreeAbsent = false;
    const branchCheck = execGit(['-C', entry.worktree_path, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: plan.repoRoot });
    if (!gitResultOk(branchCheck)) {
      // The in-worktree read failed. Ask git WHY, instead of asking the
      // filesystem WHETHER: identity is still on record in the porcelain output,
      // so the #3677 swap control keeps its teeth here rather than degrading to
      // "some branch by this name exists".
      //
      // Blocked unless git still binds this path to the branch the manifest names
      // AND the directory is confirmed gone (ENOENT). Each way of failing that is a
      // genuine mismatch: a different branch registered at the path is the swap the
      // control exists to catch; a path git does not list at all is an entry naming
      // something git has no record of; and a path that stats, or that fails to stat
      // for any reason other than ENOENT, is a checkout that is present or merely
      // unreadable — which blocked before this PR and must keep blocking.
      if (!absentAndIdentified(entry.worktree_path, entry.branch)) {
        blockEntry(result, 'branch_mismatch', branchCheck?.stderr || '');
        // #2852: isolate — this entry's problem does not touch repoRoot's git state,
        // so every remaining entry is still independently evaluated.
        continue;
      }
      worktreeAbsent = true;
      noteAcceptedAbsent(result, entry);
    } else if (branchCheck.stdout.trim() !== entry.branch) {
      blockEntry(result, 'branch_mismatch', branchCheck?.stderr || '');
      continue; // #2852: isolate
    }

    const mergeBase = execGit(['merge-base', 'HEAD', entry.branch], { cwd: plan.repoRoot });
    const allowedBases = Array.isArray(entry.allowed_bases) && entry.allowed_bases.length > 0
      ? entry.allowed_bases
      : [entry.expected_base];
    if (!gitResultOk(mergeBase) || !allowedBases.includes(mergeBase.stdout.trim())) {
      blockEntry(result, 'base_mismatch', mergeBase?.stderr || '');
      continue; // #2852: isolate
    }

    const deletions = execGit(['diff', '--diff-filter=D', '--name-only', `HEAD...${entry.branch}`], { cwd: plan.repoRoot });
    if (!gitResultOk(deletions)) {
      blockEntry(result, 'deletion_check_failed', deletions?.stderr || '');
      continue; // #2852: isolate
    }
    if (deletions.stdout) {
      // #3003: a deletion the PLAN declared is authorized; anything else still blocks.
      // Only a SUCCESSFUL check reaches here — a failed one blocked above on its own
      // reason, so a broken check can never be filtered into a pass.
      //
      // The block detail carries ONLY the undeclared residue. Listing declared paths
      // there would misdirect the operator toward paths that were fine.
      const undeclaredDeletions = partitionDeclaredDeletions(
        deletions.stdout.split('\n'),
        entry.declared_deletions,
      );
      if (undeclaredDeletions.length > 0) {
        blockEntry(result, 'branch_contains_deletions', undeclaredDeletions.join('\n'));
        continue; // #2852: isolate
      }
    }

    // #2596: advisory scope conformance — does the branch's ACTUAL committed
    // diff stay inside the scope the plan declared? Gated on a declared scope
    // being present: with nothing declared there is nothing to compare, so no
    // git subprocess is spent at all (and every pre-#2596 fixture, none of
    // which declares one, issues exactly the git calls it always did).
    //
    // ADVISORY ONLY. Unlike the deletions check above, a finding here does NOT
    // call blockEntry and does NOT touch `ok` — the merge proceeds. Promotion
    // to a hard gate is a separate, disclosed change.
    // #3003: a declared deletion is in scope by construction — `git diff --name-only`
    // includes deleted paths, so without accounting for the declaration, authorizing a
    // deletion would immediately warn that the same path is out of declared scope.
    //
    // It is SUBTRACTED from the findings rather than UNIONED into the declared scope,
    // and the difference is not cosmetic. `planWaveScopeConformance` reads its scope
    // list with prefix-and-glob semantics, so unioning would silently hand
    // `declared_deletions` a second, WIDER matching rule than the gate gives it:
    // `["*.md"]` (inert at the gate) would yield a null prefix meaning "matches
    // everything" and mute the advisory entirely, and `["src"]` would mute all of
    // `src/`. One field with two matching rules is a trap. Subtracting keeps the
    // field exact-match-only on every surface it touches.
    //
    // Gating stays on `files_modified` alone for the same reason: a plan that declares
    // only deletions has still declared no modification scope, so the advisory stays
    // exactly as silent as it was before this change instead of warning on every
    // modified path.
    const declaredFiles = Array.isArray(entry.files_modified) ? entry.files_modified : [];
    if (declaredFiles.length > 0) {
      const scopeDiff = execGit(['diff', '--name-only', `HEAD...${entry.branch}`], { cwd: plan.repoRoot });
      const scopeWarnings: WaveCleanupWarning[] = !gitResultOk(scopeDiff)
        // A broken advisory must never become a gate: record that conformance
        // is unknown rather than blocking (or, worse, silently passing).
        ? [{ code: WAVE_CLEANUP_WARNING.SCOPE_CHECK_UNAVAILABLE, branch: entry.branch, path: null }]
        : planWaveScopeConformance((scopeDiff.stdout || '').split('\n'), declaredFiles, entry.branch)
          // A path-less warning (SCOPE_CHECK_UNAVAILABLE) is never subtracted.
          .filter((w) => w.path === null
            || partitionDeclaredDeletions([w.path], entry.declared_deletions).length > 0);
      result.warnings.push(...scopeWarnings);
      allWarnings.push(...scopeWarnings);
    }

    // Acceptance/lifecycle/recovery authority must be established BEFORE rescue
    // creates any parent artifact. Missing/active/unknown owners never write.
    const retirementGate = evaluateRetirementAuthorization(entry, plan.repoRoot, execGit, deps);
    if (!retirementGate.ok) {
      blockEntry(result, retirementGate.reason, retirementGate.detail);
      continue;
    }
    const acceptedHead = retirementGate.auth.accepted_head;
    const registeredBefore = registeredFor(entry.worktree_path);
    if (!registeredBefore || registeredBefore.branch !== entry.branch || registeredBefore.locked) {
      blockEntry(result, 'retirement_registration_unverified', 'fresh registration is missing, changed or locked; owner reconciliation required');
      continue;
    }

    const parentSequence = integrationSequencerBlock(execGit, plan.repoRoot);
    if (parentSequence) {
      blockEntry(result, 'integration_parent_sequencer_unverified', parentSequence);
      continue;
    }

    const parentInventory = inspectParentIntegrationInventory(execGit, plan.repoRoot);
    if (!parentInventory.ok) {
      blockEntry(result, parentInventory.reason, parentInventory.detail);
      continue;
    }

    // #4415: both steps below read the worktree directory. The rescue exists to
    // save work the executor left UNCOMMITTED; the dirty check exists to refuse
    // to merge over it. Against an absent path they fail differently, and only
    // one of them is loud: the default SUMMARY finder catches the unreadable
    // directory and simply returns no files, while `git -C <gone> status` errors
    // — and THAT is what surfaced as `worktree_dirty`, a block with nothing
    // merged. (Corrected in Codex review round 2: an earlier version of this
    // comment claimed both reads error.)
    //
    // The harness removes a worktree only when its tree is clean, so in the case
    // this fix targets there is genuinely nothing to rescue. That is a property
    // of the harness, NOT something checked here: this code cannot tell who
    // removed the directory, and a forced or manual `rm -rf` of a DIRTY worktree
    // would already have destroyed an uncommitted SUMMARY before cleanup ran.
    // What is claimed is only the narrow thing true either way — a missing
    // source cannot be read, so skipping the read loses nothing that still
    // exists. (Codex review round 1.)
    // #ORCH-03: hoisted so the post-merge fresh dirty probe below filters the
    // SAME rescued set. A rescue that landed the SUMMARY in the parent tree
    // leaves the worktree file in place, so it must not read as late work.
    let rescuedRelPaths: Set<string> = new Set();
    if (!worktreeAbsent) {
      // Safety net: rescue uncommitted SUMMARY.md artifacts before the dirty check.
      // The executor leaves <quick_id>-SUMMARY.md uncommitted by contract — the
      // orchestrator commits it.  Mirrors quick.md shell fallback (#2296, #2070, #2838, #3804).
      //
      // Destructured in place, not hoisted: every path that reaches the consumer
      // below has already run this line. (An earlier cut hoisted it on the
      // reasoning that the nested block created another route in; Codex review
      // round 2 showed that is not so — flipping `worktreeAbsent` SKIPS the
      // consumer rather than reaching it unassigned.)
      const { rescuedRelPaths: rescued, failures: rescueFailures } = rescueSummaryArtifacts(entry.worktree_path, plan.repoRoot, deps);
      rescuedRelPaths = rescued;
      if (rescueFailures.length > 0) {
        blockEntry(result, 'summary_rescue_failed', rescueFailures.map((f) => `${f.relPath}: ${f.error}`).join('; '));
        continue; // #2852: isolate
      }

      const worktreeStatus = execGit(['-C', entry.worktree_path, 'status', '--porcelain', '--untracked-files=all'], { cwd: plan.repoRoot });
      if (!gitResultOk(worktreeStatus)) {
        // #4415 (Codex review round 1): the harness can remove the worktree
        // between the branch read and here — while the repoRoot-side base,
        // deletion and scope checks run. `worktreeAbsent` records what was true
        // at IDENTIFICATION time, not now, so without this a mid-entry removal
        // failed `status` and blocked `worktree_dirty` with nothing merged: the
        // same bug as the branch read, one window later. Same disambiguation,
        // applied at the same point — the read failed, so ask why.
        //
        // Deliberately NOT extended to a rescue FAILURE above: a copy that
        // errored part-way can mean an uncommitted SUMMARY was genuinely lost,
        // and that must keep blocking. A rescue that simply finds nothing to
        // copy reports no failure and falls through to here.
        //
        // Identity was already established by the successful branch read above, so
        // the question here is only staleness — but it is asked of git, on the same
        // terms as the identification site, because a `status` failure is no more
        // self-explaining than a `rev-parse` failure was.
        if (!absentAndIdentified(entry.worktree_path, entry.branch)) {
          blockEntry(result, 'worktree_dirty', worktreeStatus?.stderr || '');
          continue; // #2852: isolate
        }
        worktreeAbsent = true;
        noteAcceptedAbsent(result, entry);
      }
      if (!worktreeAbsent) {
        // Filter rescued SUMMARY paths out of the porcelain output before deciding dirty.
        // A line like "?? .planning/q1-SUMMARY.md" should not block when the SUMMARY
        // has already been rescued into the main tree.
        const dirtyLines = (worktreeStatus.stdout || '')
          .split('\n')
          .filter((line) => {
            if (!line.trim()) return false;
            // porcelain v1 format: "XY path" (3-char prefix + space + path)
            const filePath = line.slice(3).trim();
            return !rescuedRelPaths.has(filePath);
          });
        if (dirtyLines.length > 0) {
          blockEntry(result, 'worktree_dirty', dirtyLines.join('\n'));
          continue; // #2852: isolate
        }
      }
    }

    const integrationGate = evaluateRetirementAuthorization(entry, plan.repoRoot, execGit, deps);
    const integrationRegistration = registeredFor(entry.worktree_path);
    if (!integrationGate.ok) {
      blockEntry(result, integrationGate.reason, integrationGate.detail);
      continue;
    }
    if (!integrationRegistration || integrationRegistration.branch !== entry.branch || integrationRegistration.locked) {
      blockEntry(result, 'retirement_registration_changed', 'registration changed before integration; all work retained');
      continue;
    }

    const freshParentSequence = integrationSequencerBlock(execGit, plan.repoRoot);
    if (freshParentSequence) {
      blockEntry(result, 'integration_parent_sequencer_unverified', freshParentSequence);
      continue;
    }

    // Rescue may itself have published an uncommitted parent SUMMARY, or a
    // writer may have arrived since the first inventory. Neither grants merge
    // authority: retain all copies and require root to account for the data.
    const freshParentInventory = inspectParentIntegrationInventory(execGit, plan.repoRoot);
    if (!freshParentInventory.ok) {
      blockEntry(result, freshParentInventory.reason, freshParentInventory.detail);
      continue;
    }
    if (freshParentInventory.head !== parentInventory.head) {
      blockEntry(result, 'integration_parent_head_changed', 'parent HEAD changed during preflight; recovery/ownership must be reconciled by root before integration');
      continue;
    }
    result.parent_head_before_merge = freshParentInventory.head;

    // #4721: the merge runs user hooks, so it carries its own budget — see
    // DEFAULT_MERGE_TIMEOUT_MS. Every other call in this gauntlet keeps the
    // module default.
    const mergeTimeoutMs = deps.mergeTimeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS;
    // #ORCH-03: merge the PINNED, authorized commit — not the mutable branch
    // name. The gate above proves the branch is at `acceptedHead` right now;
    // merging the name would still follow it if it moved between that read and
    // this call, which is precisely how the audit's `stale-merge` fixture
    // pulled an unreviewed late commit into the parent. The branch ref is
    // retained for a manual root-operated native Git retirement handoff.
    let merge: GitResult;
    try {
      merge = execGit(
        ['merge', acceptedHead, '--no-ff', '--no-edit', '--no-autostash', '-m', `chore: merge executor worktree (${entry.branch})`],
        { cwd: plan.repoRoot, timeout: mergeTimeoutMs },
      );
    } catch (error) {
      // A throwing transport cannot establish whether Git ran or committed.
      merge = { exitCode: 1, stdout: '', stderr: '', timedOut: false, signal: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (!gitResultOk(merge)) {
      result.integrated = observeIntegration(execGit, plan.repoRoot, acceptedHead);
      const recoveryDetail = noteManualMergeRecovery(result);
      if (merge?.timedOut) {
        const partial = (merge.stderr || merge.stdout || '').trim();
        blockEntry(
          result,
          'merge_timed_out',
          `git merge did not finish within ${mergeTimeoutMs} ms and was killed${partial ? `; output before the kill: ${partial}` : ''}. ${recoveryDetail}`,
        );
      } else {
        const diagnostic = (merge?.stderr || merge?.stdout || merge?.error?.message || '').trim();
        blockEntry(result, 'merge_failed', `${diagnostic ? `${diagnostic}. ` : ''}${recoveryDetail}`);
      }
      // RGS-10: even a clean initial index cannot establish ownership of later
      // staging. No abort/reset/stash/pop/restore is safe here. Do not infer a
      // pristine parent from missing MERGE_HEAD or continue after any failure.
      pending.push(...entries.slice(i + 1));
      break;
    }

    result.integrated = observeIntegration(execGit, plan.repoRoot, acceptedHead);
    if (result.integrated !== true) {
      const recoveryDetail = noteManualMergeRecovery(result);
      blockEntry(result, 'integration_not_observed', `merge returned success but current accepted-head reachability is absent or unverified. ${recoveryDetail}`);
      pending.push(...entries.slice(i + 1));
      break;
    }
    const registeredNow = registeredFor(entry.worktree_path);
    if (!registeredNow || registeredNow.branch !== entry.branch || registeredNow.locked) {
      blockEntry(result, 'retirement_registration_changed', 'fresh registration is missing, changed or locked after integration; worktree and branch retained');
      continue;
    }
    const freshGate = evaluateRetirementAuthorization(entry, plan.repoRoot, execGit, deps);
    if (!freshGate.ok) {
      blockEntry(result, freshGate.reason, freshGate.detail);
      continue;
    }
    if (!worktreeAbsent) {
      const postHead = execGit(['-C', entry.worktree_path, 'rev-parse', 'HEAD'], { cwd: plan.repoRoot });
      if (!gitResultOk(postHead) || postHead.stdout.trim() !== acceptedHead) {
        blockEntry(result, 'retirement_head_advanced', 'fresh worktree HEAD differs or is unknown; worktree and branch retained');
        continue;
      }
      const status = execGit(['-C', entry.worktree_path, 'status', '--porcelain', '--untracked-files=all', '--ignored=matching'], { cwd: plan.repoRoot });
      if (!gitResultOk(status)) {
        blockEntry(result, 'retirement_probe_failed', 'fresh status is unknown; worktree and branch retained');
        continue;
      }
      if (status.stdout.trim()) {
        blockEntry(result, status.stdout.split('\n').some((line) => line.startsWith('!!')) ? 'retirement_ignored_data_present' : 'worktree_dirty', 'worktree contains tracked, untracked or ignored data; all copies retained');
        continue;
      }
      const nested = findNestedCheckout(resolveAgainstRepoRoot(entry.worktree_path), deps);
      if (nested.state !== 'absent') {
        blockEntry(result, nested.state === 'present' ? 'retirement_nested_checkout_present' : 'retirement_nested_scan_unknown', nested.detail);
        continue;
      }
    }
    // The native lifecycle record tracks one PID, not all descendants or an
    // exclusive owner lease. It cannot authorize automatic retirement even when
    // that PID is dead and the record is complete. Root must account for every
    // writer and perform the final native Git handoff. No remove/unlock/prune/
    // ref deletion is attempted here, including for missing worktree paths.
    blockEntry(result, 'retirement_manual_root_handoff_required', 'accepted commit integrated; worktree, registration and branch retained. Root must verify quiescence and recovery before entry-scoped native Git retirement.');
  }

  return {
    ok,
    action: plan.action,
    reason: ok ? 'ok' : 'cleanup_blocked',
    entries: results,
    pending,
    warnings: allWarnings,
  };
}

function cmdWorktreeCleanupWave(cwd: string, args: string[] = []): void {
  const manifestFlagIndex = args.indexOf('--manifest');
  const manifestPath = manifestFlagIndex >= 0 ? args[manifestFlagIndex + 1] : '';
  if (!manifestPath) {
    process.stderr.write('Usage: worktree cleanup-wave --manifest <path>\n');
    process.exitCode = 2;
    return;
  }

  let manifest: string;
  try {
    manifest = fs.readFileSync(path.resolve(cwd, manifestPath), 'utf8');
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: 'manifest_read_failed',
      error: (err as Error).message,
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const plan = planWorktreeWaveCleanup(cwd, manifest);
  const result = executeWorktreeWaveCleanupPlan(plan);
  const response = {
    ok: result.ok,
    plan: {
      action: plan.action,
      discovery: plan.discovery,
      reason: plan.reason,
      entries: plan.entries.length,
    },
    result,
  };
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

interface RecordAgentFields {
  agentId: string;
  worktreePath: string;
  branch: string;
  base: string;
  files?: string;
  deletions?: string;
}

/**
 * #2596: split a `--files` value into declared paths. Whitespace-separated,
 * matching the `PLAN_FILES` shape the per-plan worktree gate already builds
 * with `jq -r '.files_modified // [] | join(" ")'`. Values are DATA compared
 * against a diff — never opened, never passed to a shell.
 */
function parseDeclaredScopeFlag(raw?: string): string[] {
  return String(raw || '').split(/\s+/).filter((token) => token.length > 0);
}

interface RecordAgentPlan {
  ok: boolean;
  reason: string;
  hint?: string;
  entry: CleanupManifestEntry | null;
  /** Serialized manifest to write back (with trailing newline); null when ok === false. */
  manifest: string | null;
}

/**
 * Pure planner for the per-agent wave-manifest append.
 *
 * Validates the candidate entry at write time using the SAME rules the
 * cleanup-wave reader enforces (via `normalizeCleanupManifestEntry`), so an
 * entry that `record-agent` accepts is guaranteed to survive
 * `normalizeCleanupManifest` on read — a field that would be silently dropped
 * at cleanup time fails loudly here instead.
 *
 * `agent_id` is treated write-strict (required) even though the reader is
 * lenient (nullable): the whole point of this verb is to catch an
 * under-populated entry at write time, and an entry whose author cannot be
 * identified defeats that. A duplicate `(worktree_path, branch)` is also
 * rejected loudly — the reader dedups on that key, so a re-record would be
 * silently dropped (the failure mode this verb exists to eliminate). The
 * on-disk shape stays the existing 4-field entry (`agent_id`, `worktree_path`,
 * `branch`, `expected_base`) unless `--files` declares a scope, in which case
 * an optional `files_modified` is appended (#2596); the reader still
 * re-derives `allowed_bases`.
 */
function planWorktreeRecordAgent(manifestRaw: string, fields: RecordAgentFields): RecordAgentPlan {
  // 1. Write-strict required-field check (loud, with which flag is missing).
  //    Trim first so a whitespace-only value ("   ") is rejected here rather
  //    than deferred to a guaranteed `git worktree remove` failure at cleanup.
  const agentId = (fields.agentId || '').trim();
  const worktreePath = (fields.worktreePath || '').trim();
  const branch = (fields.branch || '').trim();
  const base = (fields.base || '').trim();
  const missing: string[] = [];
  if (!agentId) missing.push('--agent-id');
  if (!worktreePath) missing.push('--path');
  if (!branch) missing.push('--branch');
  if (!base) missing.push('--base');
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'missing_field',
      hint: `record-agent requires ${missing.join(', ')}. Re-run with all of --agent-id, --path, --branch, --base set to non-empty (non-whitespace) values.`,
      entry: null,
      manifest: null,
    };
  }

  // 2. Shared validation: run the candidate through the reader's normalizer.
  //    If it returns null the reader would drop this entry on read — reject now.
  const declaredScope = parseDeclaredScopeFlag(fields.files);
  // #3003: reuse parseDeclaredScopeFlag — a blank/absent --deletions leaves the
  // entry shape untouched, mirroring the --files rule directly above.
  const declaredDeletions = parseDeclaredScopeFlag(fields.deletions);
  const candidate = {
    agent_id: agentId,
    worktree_path: worktreePath,
    branch,
    expected_base: base,
    ...(declaredScope.length > 0 ? { files_modified: declaredScope } : {}),
    ...(declaredDeletions.length > 0 ? { declared_deletions: declaredDeletions } : {}),
  };
  const entry = normalizeCleanupManifestEntry(candidate);
  if (!entry) {
    return {
      ok: false,
      reason: 'invalid_entry',
      hint: `Entry failed cleanup-manifest validation: --path/--branch/--base must be non-empty and --branch must match ${WORKTREE_AGENT_BRANCH_PATTERN} (accepts agent-<id>, worktree-agent-<id>, and worktree-wf_<runid> namespaces; got branch="${branch}"). Fix the field and re-run.`,
      entry: null,
      manifest: null,
    };
  }

  // 3. Parse the existing manifest. The init shell ({orchestrator_root, worktrees: []})
  //    is written inline by the orchestrator before any agent spawns; a missing or
  //    malformed manifest is a loud failure here, not a silent under-populated write.
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    return {
      ok: false,
      reason: 'invalid_manifest_json',
      hint: 'Manifest is not valid JSON. The orchestrator must initialize it as {"orchestrator_root": "...", "worktrees": []} before recording agents.',
      entry: null,
      manifest: null,
    };
  }

  // Accept the canonical {worktrees: []} shell or a bare top-level array (both
  // are read by normalizeCleanupManifest); preserve any other top-level keys.
  let worktrees: unknown[];
  let writeBack: unknown;
  if (Array.isArray(parsed)) {
    worktrees = parsed;
    writeBack = worktrees;
  } else if (parsed && typeof parsed === 'object') {
    const container = parsed as Record<string, unknown>;
    if (container.worktrees === undefined) container.worktrees = [];
    if (!Array.isArray(container.worktrees)) {
      return {
        ok: false,
        reason: 'manifest_shape_invalid',
        hint: 'Manifest "worktrees" must be an array. Re-initialize as {"orchestrator_root": "...", "worktrees": []}.',
        entry: null,
        manifest: null,
      };
    }
    worktrees = container.worktrees;
    writeBack = container;
  } else {
    return {
      ok: false,
      reason: 'manifest_shape_invalid',
      hint: 'Manifest must be a JSON object {"worktrees": []} or a top-level array.',
      entry: null,
      manifest: null,
    };
  }

  // 4. Reject a duplicate (worktree_path, branch). The reader dedups on this
  //    exact key, but only over entries that NORMALIZE successfully — so an
  //    existing malformed same-key entry (which the reader would drop) must NOT
  //    block recording a valid one. Run each existing entry through the reader's
  //    own normalizer and compare only the entries the reader would keep; this
  //    matches its dedup behavior exactly. A real duplicate signals an upstream
  //    double-spawn — surface it loudly instead of silently dropping it.
  const dupKey = `${entry.worktree_path}\0${entry.branch}`;
  const isDuplicate = worktrees.some((existing) => {
    const normalized = normalizeCleanupManifestEntry(existing);
    return normalized !== null && `${normalized.worktree_path}\0${normalized.branch}` === dupKey;
  });
  if (isDuplicate) {
    return {
      ok: false,
      reason: 'duplicate_entry',
      hint: `The manifest already records worktree_path="${entry.worktree_path}" branch="${entry.branch}". The cleanup reader dedups on (worktree_path, branch), so re-recording would be silently dropped — this usually signals an upstream double-spawn. Investigate rather than re-record.`,
      entry: null,
      manifest: null,
    };
  }

  // 5. Append the minimal 4-field entry, matching the existing on-disk format.
  const recorded: CleanupManifestEntry = {
    agent_id: entry.agent_id,
    worktree_path: entry.worktree_path,
    branch: entry.branch,
    expected_base: entry.expected_base,
  };
  // #2596: only written when a scope was actually declared — conservative in
  // what we send, so a blank --files leaves the 4-field shape untouched.
  if (entry.files_modified && entry.files_modified.length > 0) {
    recorded.files_modified = entry.files_modified;
  }
  // #3003: same conservative rule as --files above — a blank --deletions
  // leaves the entry shape untouched.
  if (entry.declared_deletions && entry.declared_deletions.length > 0) {
    recorded.declared_deletions = entry.declared_deletions;
  }
  worktrees.push(recorded);

  return {
    ok: true,
    reason: 'ok',
    entry: recorded,
    manifest: `${JSON.stringify(writeBack, null, 2)}\n`,
  };
}

interface RecordAgentCmdDeps {
  readFile?: (p: string) => string;
  writeFile?: (p: string, content: string) => void;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
}

interface RecordAgentCmdResult {
  ok: boolean;
  reason: string;
  hint?: string;
  entry: CleanupManifestEntry | null;
  manifest_path?: string;
}

/**
 * CLI command: append a validated per-agent entry to a wave cleanup manifest.
 *
 * Usage: worktree record-agent --manifest <path> --agent-id <id> --path <worktree> --branch <branch> --base <sha> [--files "<space-separated paths>"] [--deletions "<space-separated paths>"]
 *
 * Fails loudly (non-zero exit + recovery hint on stderr) when a field is
 * missing/garbled or the manifest is absent/malformed, rather than appending an
 * under-populated entry that the cleanup reader would silently drop.
 */
function cmdWorktreeRecordAgent(cwd: string, args: string[] = [], deps: RecordAgentCmdDeps = {}): RecordAgentCmdResult {
  const flag = (name: string): string => {
    const i = args.indexOf(name);
    if (i < 0 || i + 1 >= args.length) return '';
    return args[i + 1];
  };
  const write = deps.write || ((s: string) => process.stdout.write(s));
  const writeErr = deps.writeErr || ((s: string) => process.stderr.write(s));

  const manifestPath = flag('--manifest');
  if (!manifestPath) {
    writeErr('Usage: worktree record-agent --manifest <path> --agent-id <id> --path <worktree> --branch <branch> --base <sha> [--files "<space-separated paths>"] [--deletions "<space-separated paths>"]\n');
    process.exitCode = 2;
    return { ok: false, reason: 'usage', entry: null };
  }

  const resolved = path.resolve(cwd, manifestPath);
  const readFile = deps.readFile || ((p: string) => fs.readFileSync(p, 'utf8'));
  let manifestRaw: string;
  try {
    manifestRaw = readFile(resolved);
  } catch (err) {
    const hint = `Manifest not found or unreadable at ${manifestPath}. The orchestrator must initialize it ({"orchestrator_root": "...", "worktrees": []}) before recording agents.`;
    writeErr(`[gsd] worktree.record-agent: manifest_read_failed — ${hint}\n`);
    write(`${JSON.stringify({ ok: false, reason: 'manifest_read_failed', hint, error: (err as Error).message }, null, 2)}\n`);
    process.exitCode = 1;
    return { ok: false, reason: 'manifest_read_failed', hint, entry: null };
  }

  const plan = planWorktreeRecordAgent(manifestRaw, {
    agentId: flag('--agent-id'),
    worktreePath: flag('--path'),
    branch: flag('--branch'),
    base: flag('--base'),
    files: flag('--files'),
    deletions: flag('--deletions'),
  });

  if (!plan.ok || plan.manifest === null) {
    writeErr(`[gsd] worktree.record-agent: ${plan.reason} — ${plan.hint || ''}\n`);
    write(`${JSON.stringify({ ok: false, reason: plan.reason, hint: plan.hint }, null, 2)}\n`);
    process.exitCode = 1;
    return { ok: false, reason: plan.reason, hint: plan.hint, entry: null };
  }

  const writeFile = deps.writeFile || ((p: string, content: string) => fs.writeFileSync(p, content, 'utf8'));
  writeFile(resolved, plan.manifest);
  write(`${JSON.stringify({ ok: true, reason: 'ok', entry: plan.entry, manifest_path: resolved }, null, 2)}\n`);
  return { ok: true, reason: 'ok', entry: plan.entry, manifest_path: resolved };
}

// ─── worktree create (#2584 ADR-1239 Codex-binding amendment — Phase 2) ───────
//
// The `orchestrator-worktree` isolation ladder value (ADR-1239) requires GSD
// itself to create + bind the git worktree an executor runs in — this is that
// git-worktree-creation primitive. UNCONSUMED in Phase 2: no scheduler calls
// this yet (Phase 3 wires it). Mirrors the plan/execute/cmd split used by
// cleanup-wave and record-agent above so a created worktree is immediately
// manageable by cleanup-wave / reap-orphans without a second code path.

interface WorktreeCreateFields {
  agentId: string;
  worktreePath: string;
  branch: string;
  base: string;
  files?: string;
  deletions?: string;
}

interface WorktreeCreatePlan {
  ok: boolean;
  reason: string;
  hint?: string;
  entry: CleanupManifestEntry | null;
}

/**
 * Pure planner for `worktree create`. Validates the four required fields
 * (write-strict, same missing-field-hint style as `planWorktreeRecordAgent`),
 * then runs the candidate entry through the SAME `normalizeCleanupManifestEntry`
 * validation the cleanup-wave reader and record-agent use — so a worktree this
 * verb creates is guaranteed manageable by cleanup-wave/reap-orphans, and an
 * entry that would fail the reader's branch-namespace guard is rejected here,
 * fail-closed, before any git command runs.
 */
function planWorktreeCreate(fields: WorktreeCreateFields): WorktreeCreatePlan {
  const agentId = (fields.agentId || '').trim();
  const worktreePath = (fields.worktreePath || '').trim();
  const branch = (fields.branch || '').trim();
  const base = (fields.base || '').trim();
  const missing: string[] = [];
  if (!agentId) missing.push('--agent-id');
  if (!worktreePath) missing.push('--path');
  if (!branch) missing.push('--branch');
  if (!base) missing.push('--base');
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'missing_field',
      hint: `worktree create requires ${missing.join(', ')}. Re-run with all of --agent-id, --path, --branch, --base set to non-empty (non-whitespace) values.`,
      entry: null,
    };
  }

  const declaredScope = parseDeclaredScopeFlag(fields.files);
  // #3003: reuse parseDeclaredScopeFlag — a blank/absent --deletions leaves the
  // entry shape untouched, mirroring the --files rule directly above.
  const declaredDeletions = parseDeclaredScopeFlag(fields.deletions);
  const candidate = {
    agent_id: agentId,
    worktree_path: worktreePath,
    branch,
    expected_base: base,
    ...(declaredScope.length > 0 ? { files_modified: declaredScope } : {}),
    ...(declaredDeletions.length > 0 ? { declared_deletions: declaredDeletions } : {}),
  };
  const entry = normalizeCleanupManifestEntry(candidate);
  if (!entry) {
    return {
      ok: false,
      reason: 'invalid_entry',
      hint: `Entry failed cleanup-manifest validation: --path/--branch/--base must be non-empty and --branch must match ${WORKTREE_AGENT_BRANCH_PATTERN} (accepts agent-<id>, worktree-agent-<id>, and worktree-wf_<runid> namespaces; got branch="${branch}"). Fix the field and re-run.`,
      entry: null,
    };
  }

  // #2584 FIX 4 — git argument-injection guard: a value starting with '-'
  // could be parsed by git as a FLAG rather than a positional argument (e.g.
  // base="--upload-pack=x", path="-f"). `git worktree add` / `git rev-parse`
  // support for a `--` end-of-options separator is inconsistent across git
  // versions, so rejecting a leading dash outright — not relying on `--` — is
  // the portable fix.
  if (branch.startsWith('-') || base.startsWith('-') || worktreePath.startsWith('-')) {
    return {
      ok: false,
      reason: 'unsafe_leading_dash',
      hint: `--branch/--base/--path must not start with "-" (a leading dash would be parsed by git as a flag, not a value). Got branch="${branch}" base="${base}" path="${worktreePath}".`,
      entry: null,
    };
  }

  // #2584 FIX 4 — path-traversal guard: reject a ".." path segment in --path.
  // Absolute paths ARE allowed (the orchestrator legitimately uses them —
  // Phase-3 root confinement is out of Phase-2 scope); only a literal ".."
  // component is rejected. Split on BOTH separators so the guard is effective
  // on a Windows-style path too.
  if (worktreePath.split(/[/\\]/).includes('..')) {
    return {
      ok: false,
      reason: 'unsafe_path_traversal',
      hint: `--path must not contain a ".." path segment (got: "${worktreePath}").`,
      entry: null,
    };
  }

  return { ok: true, reason: 'ok', entry };
}

interface WorktreeCreateResult {
  ok: boolean;
  reason: string;
  worktree_path?: string;
  branch?: string;
  base?: string;
  cwd?: string;
  stderr?: string;
}

/**
 * Execute a `planWorktreeCreate` plan via bounded git. Fail-closed at every
 * step — a timeout or a non-zero exit degrades to a structured result rather
 * than throwing, and the base must resolve BEFORE any worktree is created (no
 * partial/orphaned worktree on a bad base). Returns `cwd` — the working
 * directory Phase 3's executor spawn will pass through.
 */
function executeWorktreeCreatePlan(plan: WorktreeCreatePlan, repoRoot: string, deps: WorktreeDeps = {}): WorktreeCreateResult {
  const execGit = deps.execGit || execGitDefault;
  if (!plan || !plan.ok || !plan.entry) {
    return {
      ok: false,
      reason: plan ? plan.reason : 'missing_plan',
    };
  }

  const { worktree_path: worktreePath, branch, expected_base: base } = plan.entry;
  const normalizedPath = posixNormalize(worktreePath);

  // 1. Verify the base resolves BEFORE creating anything (fail-closed). Nothing
  //    has been created on this path yet, so there is nothing to roll back.
  const baseCheck = execGit(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: repoRoot });
  if (baseCheck.timedOut) {
    return { ok: false, reason: 'git_timeout', worktree_path: normalizedPath, branch, base };
  }
  if (!gitResultOk(baseCheck)) {
    return { ok: false, reason: 'base_unresolved', worktree_path: normalizedPath, branch, base, stderr: baseCheck.stderr || '' };
  }

  // 2. Create the worktree + branch together.
  const addResult = execGit(['worktree', 'add', '-b', branch, worktreePath, base], { cwd: repoRoot });
  if (addResult.timedOut) {
    // #2584 FIX 3: a SIGTERM'd `add` can leave a partial worktree on disk.
    // Retain partial checkout/admin evidence for root; timeout is not owner authority.
    return { ok: false, reason: 'git_timeout', worktree_path: normalizedPath, branch, base };
  }
  if (addResult.exitCode !== 0) {
    // #2584 FIX 5: deliberately NO rollback here. A clean non-zero exit is
    // most commonly a COLLISION (path/branch already a registered worktree),
    // and git fails FAST on that — it creates nothing. A colliding path in
    // this branch namespace is very plausibly a LIVE PEER executor;
    // `git worktree remove --force` on it would destroy real, uncommitted
    // work. The safe response to a clean failure is to fail loudly and leave
    // whatever is already on disk untouched.
    return { ok: false, reason: 'worktree_add_failed', worktree_path: normalizedPath, branch, base, stderr: addResult.stderr || '' };
  }

  return {
    ok: true,
    reason: 'created',
    worktree_path: normalizedPath,
    branch,
    base,
    cwd: normalizedPath,
  };
}

interface WorktreeCreateCmdResult {
  ok: boolean;
  reason: string;
  hint?: string;
  entry?: CleanupManifestEntry | null;
  cwd?: string;
  manifest_path?: string;
  stderr?: string;
}

/**
 * CLI command: create a git worktree + branch off `--base`, then append the
 * validated manifest entry so the worktree is immediately manageable by
 * `worktree cleanup-wave` / `worktree reap-orphans`.
 *
 * Usage: worktree create --manifest <path> --agent-id <id> --path <worktree> --branch <branch> --base <sha> --root <dir> [--files "<space-separated paths>"] [--deletions "<space-separated paths>"]
 *
 * #2584 FIX 1 — ORDERING CONTRACT: every manifest read/parse/shape-validate/
 * plan step runs BEFORE the git side effect (step 5). The ONLY manifest
 * operation that can run AFTER `git worktree add` has succeeded is the final
 * guarded write (step 6). A failure retains the created checkout and branch
 * for root reconciliation; neither a timeout nor a failed manifest write is
 * authority to discard data or registrations.
 */
function cmdWorktreeCreate(cwd: string, args: string[] = [], deps: RecordAgentCmdDeps & WorktreeDeps = {}): WorktreeCreateCmdResult {
  const flag = (name: string): string => {
    const i = args.indexOf(name);
    if (i < 0 || i + 1 >= args.length) return '';
    return args[i + 1];
  };
  const write = deps.write || ((s: string) => process.stdout.write(s));
  const writeErr = deps.writeErr || ((s: string) => process.stderr.write(s));

  const manifestPath = flag('--manifest');
  if (!manifestPath) {
    writeErr('Usage: worktree create --manifest <path> --agent-id <id> --path <worktree> --branch <branch> --base <sha> --root <dir> [--files "<space-separated paths>"] [--deletions "<space-separated paths>"]\n');
    process.exitCode = 2;
    return { ok: false, reason: 'usage' };
  }

  // 1. Read the manifest (no side effect yet).
  const resolved = path.resolve(cwd, manifestPath);
  const readFile = deps.readFile || ((p: string) => fs.readFileSync(p, 'utf8'));
  let manifestRaw: string;
  try {
    manifestRaw = readFile(resolved);
  } catch (err) {
    const hint = `Manifest not found or unreadable at ${manifestPath}. The orchestrator must initialize it ({"orchestrator_root": "...", "worktrees": []}) before creating agent worktrees.`;
    writeErr(`[gsd] worktree.create: manifest_read_failed — ${hint}\n`);
    write(`${JSON.stringify({ ok: false, reason: 'manifest_read_failed', hint, error: (err as Error).message }, null, 2)}\n`);
    process.exitCode = 1;
    return { ok: false, reason: 'manifest_read_failed', hint };
  }

  // 2. Parse + shape-validate the manifest BEFORE any git command runs.
  //    Mirrors planWorktreeRecordAgent's shell-acceptance rules (canonical
  //    {worktrees:[]} object OR a bare top-level array).
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    const hint = 'Manifest is not valid JSON. The orchestrator must initialize it as {"orchestrator_root": "...", "worktrees": []} before creating agent worktrees.';
    writeErr(`[gsd] worktree.create: invalid_manifest_json — ${hint}\n`);
    write(`${JSON.stringify({ ok: false, reason: 'invalid_manifest_json', hint }, null, 2)}\n`);
    process.exitCode = 1;
    return { ok: false, reason: 'invalid_manifest_json', hint };
  }

  let worktrees: unknown[];
  let writeBack: unknown;
  if (Array.isArray(parsed)) {
    worktrees = parsed;
    writeBack = worktrees;
  } else if (parsed && typeof parsed === 'object') {
    const container = parsed as Record<string, unknown>;
    if (container.worktrees === undefined) container.worktrees = [];
    if (!Array.isArray(container.worktrees)) {
      const hint = 'Manifest "worktrees" must be an array. Re-initialize as {"orchestrator_root": "...", "worktrees": []}.';
      writeErr(`[gsd] worktree.create: manifest_shape_invalid — ${hint}\n`);
      write(`${JSON.stringify({ ok: false, reason: 'manifest_shape_invalid', hint }, null, 2)}\n`);
      process.exitCode = 1;
      return { ok: false, reason: 'manifest_shape_invalid', hint };
    }
    worktrees = container.worktrees;
    writeBack = container;
  } else {
    const hint = 'Manifest must be a JSON object {"worktrees": []} or a top-level array.';
    writeErr(`[gsd] worktree.create: manifest_shape_invalid — ${hint}\n`);
    write(`${JSON.stringify({ ok: false, reason: 'manifest_shape_invalid', hint }, null, 2)}\n`);
    process.exitCode = 1;
    return { ok: false, reason: 'manifest_shape_invalid', hint };
  }

  // 3. Plan (pure, no I/O) — still before any git command.
  const plan = planWorktreeCreate({
    agentId: flag('--agent-id'),
    worktreePath: flag('--path'),
    branch: flag('--branch'),
    base: flag('--base'),
    files: flag('--files'),
    deletions: flag('--deletions'),
  });

  if (!plan.ok || !plan.entry) {
    writeErr(`[gsd] worktree.create: ${plan.reason} — ${plan.hint || ''}\n`);
    write(`${JSON.stringify({ ok: false, reason: plan.reason, hint: plan.hint }, null, 2)}\n`);
    process.exitCode = 1;
    return { ok: false, reason: plan.reason, hint: plan.hint };
  }

  // 3b. Mandatory root confinement (#2627 Phase 3 introduced it; #3050 made it
  //     mandatory — the confinement Phase 2 deferred here from
  //     planWorktreeCreate's path-traversal guard). planWorktreeCreate rejects a
  //     literal ".." SEGMENT, but a plain absolute path outside the project
  //     contains no ".." and passes. The orchestrator SPAWNS executor processes
  //     into these paths, so an unconfined --path is a write primitive aimed
  //     anywhere on the filesystem.
  //
  //     The root is DECLARED by the caller (`--root`) rather than inferred: agent
  //     worktrees legitimately live outside the orchestrator's own root (a lane
  //     orchestrator creates siblings under the repo's .claude/worktrees/), so
  //     there is no layout this module could derive without guessing.
  //
  //     Lexical by design: the worktree does not exist yet, so there is nothing
  //     to realpath, and resolving only the root would not close a symlinked-leaf
  //     hole. Pairs with the leading-dash and ".."-segment guards above.
  //
  //     #3050: confinement does not depend on the caller remembering to pass
  //     `--root` — it used to be silently skippable, so a caller that forgot the
  //     flag got an unconfined `--path` with no warning. Fail closed instead:
  //     absent `--root`, this verb refuses to create anything. The one current
  //     caller (execute-phase's orchestrator-worktree dispatch) always passes
  //     `--root`, so this closes the gap without breaking it.
  const rootFlag = flag('--root');
  if (!rootFlag) {
    const hint = '--root is required (fail-closed root confinement, #3050). Pass --root <orchestrator-root-dir> so worktree.create can verify --path resolves inside it before creating anything.';
    writeErr(`[gsd] worktree.create: root_required — ${hint}\n`);
    write(`${JSON.stringify({ ok: false, reason: 'root_required', hint }, null, 2)}\n`);
    process.exitCode = 1;
    return { ok: false, reason: 'root_required', hint };
  }
  {
    const absRoot = path.resolve(cwd, rootFlag);
    const absWorktree = path.resolve(cwd, plan.entry.worktree_path);
    // Lexical containment (ADR-4650): the worktree does not exist yet, so there is
    // nothing to realpath. Both operands are already resolved above, so the shared
    // `isContainedIn` comparison applies directly (mirrors the already-resolved-caller
    // exception documented on `isContainedIn`) — a different Windows drive/UNC root
    // fails the prefix comparison the same way an escaping relative path does.
    // The canonical predicate treats target === root as CONTAINED; this call site
    // explicitly REJECTS that case (absWorktree === absRoot below), because a worktree
    // AT the root would clobber the checkout — the inversion this migration preserves.
    if (absWorktree === absRoot || !isContainedIn(absWorktree, absRoot)) {
      const hint = `--path must resolve INSIDE --root (root="${absRoot}", path="${absWorktree}"). A worktree outside the declared root is unreachable by manifest-scoped cleanup and would let a spawned executor write outside the project.`;
      writeErr(`[gsd] worktree.create: path_outside_root — ${hint}\n`);
      write(`${JSON.stringify({ ok: false, reason: 'path_outside_root', hint }, null, 2)}\n`);
      process.exitCode = 1;
      return { ok: false, reason: 'path_outside_root', hint };
    }
  }

  // 4. Compute the deduped final manifest STRING in memory now — the ONLY
  //    manifest work left is the guarded write in step 6, after git succeeds.
  //    #2584 FIX 2: the on-disk entry is the SAME minimal 4-field shape
  //    `cmdWorktreeRecordAgent` writes — never the full normalized entry with
  //    the derived `allowed_bases` — so the two verbs never write divergent
  //    shapes into the same manifest (the reader re-derives `allowed_bases`
  //    from `expected_base` on load, exactly as it does for record-agent).
  const recorded: CleanupManifestEntry = {
    agent_id: plan.entry.agent_id,
    worktree_path: plan.entry.worktree_path,
    branch: plan.entry.branch,
    expected_base: plan.entry.expected_base,
  };
  // #2596: only written when a scope was actually declared — conservative in
  // what we send, so a blank --files leaves the 4-field shape untouched.
  if (Array.isArray(plan.entry.files_modified) && plan.entry.files_modified.length > 0) {
    recorded.files_modified = plan.entry.files_modified;
  }
  // #3003: same conservative rule as --files above — a blank --deletions
  // leaves the entry shape untouched.
  if (Array.isArray(plan.entry.declared_deletions) && plan.entry.declared_deletions.length > 0) {
    recorded.declared_deletions = plan.entry.declared_deletions;
  }
  const dedupeKey = `${recorded.worktree_path}\0${recorded.branch}`;
  const alreadyPresent = worktrees.some((existing) => {
    const normalized = normalizeCleanupManifestEntry(existing);
    return normalized !== null && `${normalized.worktree_path}\0${normalized.branch}` === dedupeKey;
  });
  if (!alreadyPresent) {
    worktrees.push(recorded);
  }
  const manifestToWrite = `${JSON.stringify(writeBack, null, 2)}\n`;

  // 5. NOW run the git side effect. Every manifest problem above is caught
  //    before this point. A timeout retains partial creation evidence for root;
  //    it never force-removes a checkout or prunes registrations.
  const result = executeWorktreeCreatePlan(plan, cwd, deps);
  if (!result.ok) {
    writeErr(`[gsd] worktree.create: ${result.reason} — ${result.stderr || ''}\n`);
    write(`${JSON.stringify({ ok: false, reason: result.reason, stderr: result.stderr }, null, 2)}\n`);
    process.exitCode = 1;
    return { ok: false, reason: result.reason, stderr: result.stderr };
  }

  // 6. Write the pre-computed manifest string, guarded. A write failure here
  //    means a real checkout may exist without a manifest entry. Report and
  //    retain it for root reconciliation. Never remove it on a write error.
  const writeFile = deps.writeFile || ((p: string, content: string) => fs.writeFileSync(p, content, 'utf8'));
  try {
    writeFile(resolved, manifestToWrite);
  } catch (err) {
    const hint = `The worktree was created but the manifest write failed (${(err as Error).message}); worktree, registration and branch retained for manual root reconciliation.`;
    writeErr(`[gsd] worktree.create: manifest_write_failed — ${hint}\n`);
    write(`${JSON.stringify({ ok: false, reason: 'manifest_write_failed', hint, error: (err as Error).message }, null, 2)}\n`);
    process.exitCode = 1;
    return { ok: false, reason: 'manifest_write_failed', hint };
  }

  write(`${JSON.stringify({ ok: true, reason: 'created', entry: recorded, cwd: result.cwd, manifest_path: resolved }, null, 2)}\n`);
  return { ok: true, reason: 'created', entry: recorded, cwd: result.cwd, manifest_path: resolved };
}

/**
 * Inspect linked worktrees whose lock owner process is dead, whose branch tip
 * is fully merged into the default branch, and whose lock file mtime is older
 * than REAP_MTIME_GUARD_MS (race guard).
 *
 * NON-DESTRUCTIVE since the 2026-10-23 custody audit (#ORCH-01). Those three
 * conditions are a nomination, not an authorization: see section 4d below.
 * The sweep reports each candidate as `retained` and removes nothing. The
 * `reap-orphans` name is retained for CLI/registry compatibility; the
 * function no longer reaps.
 */
const REAP_MTIME_GUARD_MS = 5 * 60 * 1000; // 5 minutes

interface ReapResult {
  path: string;
  /**
   * #ORCH-01: `retained` is the non-destructive third outcome.
   *
   * The PID-age/ancestry heuristics below can only ever NOMINATE a candidate.
   * They cannot establish that the work is unowned, complete or recoverable —
   * which is what retirement actually requires. A candidate that passes every
   * heuristic is therefore retained and reported here, with the worktree, its
   * lock and its branch left exactly as found.
   *
   * `retained` is deliberately distinct from `skipped`: `skipped` means the
   * sweep declined to act on its own heuristics, while `retained` means it
   * found a candidate it is NOT authorized to retire. Collapsing the two would
   * hide the actionable candidates among the ordinary negatives.
   */
  status: 'reaped' | 'skipped' | 'retained';
  reason: string;
}

function reapOrphanWorktrees(repoRoot: string, deps: WorktreeDeps = {}): ReapResult[] {
  const execGit = deps.execGit || execGitDefault;
  const isPidAliveCheck = deps.isPidAlive || defaultIsPidAlive;
  const readDirSafe = deps.readDirSafe || defaultReadDirSafe;
  const readFileSafe = deps.readFileSafe || defaultReadFileSafe;
  const mtimeSafe = deps.mtimeSafe || defaultMtimeSafe;
  const reapMtimeGuardMs = deps.reapMtimeGuardMs !== undefined ? deps.reapMtimeGuardMs : REAP_MTIME_GUARD_MS;
  const nowMs = deps.nowMs ?? Date.now();

  const results: ReapResult[] = [];

  // 1. Discover the .git/worktrees/ admin directory.
  const gitDir = execGit(['rev-parse', '--git-dir'], { cwd: repoRoot });
  if (!gitResultOk(gitDir)) return results;
  const gitDirPath = path.resolve(repoRoot, gitDir.stdout.trim());

  const worktreesAdminDir = path.join(gitDirPath, 'worktrees');
  const entries = readDirSafe(worktreesAdminDir);
  if (!entries) return results;

  // 2. Discover the default branch (main/master/etc) tip.
  const defaultBranchResult = execGit(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { cwd: repoRoot }
  );

  let mainTip: string | undefined;
  if (gitResultOk(defaultBranchResult)) {
    // Remote default branch is known — use it exclusively.
    const branchName = defaultBranchResult.stdout.trim().replace(/^origin\//, '');
    const r = execGit(['rev-parse', `refs/remotes/origin/${branchName}`], { cwd: repoRoot });
    if (!gitResultOk(r)) return results; // remote ref unresolvable — fail closed
    mainTip = r.stdout.trim();
  } else {
    // No remote configured (local-only repo, e.g. test fixtures).
    const hasRemote = execGit(['remote'], { cwd: repoRoot });
    if (gitResultOk(hasRemote) && hasRemote.stdout.trim()) {
      // Remote exists but origin/HEAD not set — ambiguous; fail closed.
      return results;
    }
    // Build candidate list: init.defaultBranch config, HEAD symref, then main, master.
    const candidateBranches: string[] = [];
    const configResult = execGit(['config', '--get', 'init.defaultBranch'], { cwd: repoRoot });
    if (gitResultOk(configResult) && configResult.stdout.trim()) {
      candidateBranches.push(configResult.stdout.trim());
    }
    const headSymref = execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoRoot });
    if (gitResultOk(headSymref) && headSymref.stdout.trim()) {
      const headBranch = headSymref.stdout.trim();
      if (!candidateBranches.includes(headBranch)) {
        candidateBranches.push(headBranch);
      }
    }
    for (const b of ['main', 'master']) {
      if (!candidateBranches.includes(b)) candidateBranches.push(b);
    }
    for (const candidate of candidateBranches) {
      const r = execGit(['rev-parse', candidate], { cwd: repoRoot });
      if (gitResultOk(r)) {
        mainTip = r.stdout.trim();
        break;
      }
    }
    if (!mainTip) return results;
  }

  // 3. Build a canonical-path → listed-path index from git worktree list.
  const listedResult = execGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  const canonicalToListed = new Map<string, string>();
  if (gitResultOk(listedResult)) {
    const normalizedListed = listedResult.stdout.replace(/\r\n/g, '\n');
    for (const block of normalizedListed.split('\n\n').filter(Boolean)) {
      const wtLine = block.split('\n').find((l) => l.startsWith('worktree '));
      if (!wtLine) continue;
      const listed = wtLine.slice('worktree '.length).trim();
      try {
        const canonical = fs.realpathSync.native(listed);
        canonicalToListed.set(canonical, listed);
      } catch {
        // If the path doesn't exist (already removed), skip silently.
      }
    }
  }

  // 4. Process each worktree admin entry that has a 'locked' file.
  for (const entryName of entries) {
    const adminDir = path.join(worktreesAdminDir, entryName);
    const lockedFile = path.join(adminDir, 'locked');
    const lockedContent = readFileSafe(lockedFile);
    if (lockedContent === null) continue; // no lock file — not our concern

    // Resolve the actual worktree path from the gitdir pointer.
    const gitdirFile = path.join(adminDir, 'gitdir');
    const gitdirContent = readFileSafe(gitdirFile);
    if (!gitdirContent) continue;
    const resolvedGitFile = path.resolve(adminDir, gitdirContent.trim());
    const worktreePath = path.basename(resolvedGitFile) === '.git'
      ? path.dirname(resolvedGitFile)
      : resolvedGitFile;

    // Look up the git-list path (the path git knows about) for use in
    // git worktree unlock/remove commands.
    let gitKnownPath = worktreePath;
    try {
      const canonical = fs.realpathSync.native(worktreePath);
      gitKnownPath = canonicalToListed.get(canonical) || worktreePath;
    } catch {
      // worktreePath may not exist yet (already removed); use as-is.
    }

    // 4a. Stale-lock guard: skip if lock is too fresh (PID recycling / race).
    //
    // The two causes are reported SEPARATELY (#3057). A lock whose mtime could
    // not be read is not "fresh" in any sense: `lock_too_fresh` tells an
    // operator that waiting will resolve the skip, and waiting never resolves a
    // stat failure — the lock could be seconds or months old and the sweep has
    // no way to tell. Conflating them is the same defect this module already
    // fixed for `parse_failed` vs `no_worktrees` in planWorktreePrune: a
    // decision made on unread data must not be indistinguishable from one made
    // on real data.
    const lockMtime = mtimeSafe(lockedFile);
    if (!lockMtime) {
      results.push({ path: worktreePath, status: 'skipped', reason: 'lock_age_unknown' });
      continue;
    }
    if (nowMs - lockMtime.getTime() < reapMtimeGuardMs) {
      results.push({ path: worktreePath, status: 'skipped', reason: 'lock_too_fresh' });
      continue;
    }

    // 4b. PID liveness check.
    const pidStr = lockedContent.trim().match(/^\d+/)?.[0];
    if (!pidStr) {
      results.push({ path: worktreePath, status: 'skipped', reason: 'lock_owner_unknown' });
      continue;
    }
    const pid = parseInt(pidStr, 10);
    // Number.isFinite, not Number.isNaN: pidStr is captured by /^\d+/ above, so
    // pid can never be NaN. A 309-or-more-digit string parses to Infinity.
    //
    // NOT LOAD-BEARING FOR SAFETY — do not delete it as redundant. Fail-closed
    // liveness now lives in defaultIsPidAlive, which treats every non-ESRCH
    // outcome (including the TypeError process.kill throws for Infinity) as
    // ALIVE. This guard survives because it produces a more ACCURATE verdict
    // for garbage input: `lock_owner_unknown` says "the lock names a PID this
    // parse could not represent", whereas falling through would report
    // `pid_alive` — an assertion about an owner that was never probed.
    // Note this is an EARLIER, DIFFERENT gate than the process.kill range
    // limit: process.kill accepts up to 2147483647 and rejects 2147483648
    // (measured), far below the parse cliff this guard catches.
    if (!Number.isFinite(pid)) {
      results.push({ path: worktreePath, status: 'skipped', reason: 'lock_owner_unknown' });
      continue;
    }
    let pidIsAlive: boolean;
    try {
      pidIsAlive = isPidAliveCheck(pid);
    } catch {
      pidIsAlive = true; // Cannot determine liveness — treat as alive, do not reap.
    }
    if (pidIsAlive) {
      results.push({ path: worktreePath, status: 'skipped', reason: 'pid_alive' });
      continue;
    }

    // 4c. Ancestry guard: branch-tip must be reachable from main (fail closed).
    let branchTip: string | undefined;
    {
      const headContent = readFileSafe(path.join(adminDir, 'HEAD'));
      if (!headContent) {
        results.push({ path: worktreePath, status: 'skipped', reason: 'cannot_resolve_branch_tip' });
        continue;
      }
      const trimmed = headContent.trim();
      if (trimmed.startsWith('ref: refs/heads/')) {
        // Symbolic ref — resolve to commit SHA via git
        const branchName = trimmed.slice('ref: refs/heads/'.length);
        const resolveResult = execGit(['rev-parse', `refs/heads/${branchName}`], { cwd: repoRoot });
        if (!gitResultOk(resolveResult)) {
          results.push({ path: worktreePath, status: 'skipped', reason: 'cannot_resolve_branch_tip' });
          continue;
        }
        branchTip = resolveResult.stdout.trim();
      } else if (/^[0-9a-f]{40}$/i.test(trimmed)) {
        // Detached HEAD — bare SHA
        branchTip = trimmed;
      } else {
        results.push({ path: worktreePath, status: 'skipped', reason: 'cannot_resolve_branch_tip' });
        continue;
      }
    }

    const ancestorCheck = execGit(
      ['merge-base', '--is-ancestor', branchTip, mainTip],
      { cwd: repoRoot }
    );
    if (!gitResultOk(ancestorCheck)) {
      results.push({ path: worktreePath, status: 'skipped', reason: 'branch_not_merged' });
      continue;
    }

    // 4d. RETAIN — never destroy (#ORCH-01).
    //
    // Everything above is a HEURISTIC that only NOMINATES a candidate: the lock
    // is stale, its owner PID is gone, and the branch tip is already an ancestor
    // of the default branch. None of that is authorization to retire the work.
    //
    // A dead creator PID does not mean the work is unowned. A worker can die
    // after committing — or after leaving tracked, untracked or ignored edits —
    // and never be resumed, and the ancestry test stays true the whole time
    // because the branch was cut from an already-merged base. That combination
    // is exactly what the 2026-10-23 custody audit reproduced as `orphan-dead`:
    // a dirty, locked worktree whose creator crashed, force-removed together
    // with its uncommitted files. It is also why no dirty/untracked/ignored/
    // nested-checkout check below would be sufficient on its own: the sweep is
    // not the owner, so it has no standing to decide this work is disposable.
    //
    // The previous cut additionally ran `worktree unlock` and
    // `worktree remove --force`, overriding another owner's lock as a side
    // effect of a maintenance sweep. That is a separate authority the sweep
    // does not hold, so both calls are gone: no unlock, no forced removal, no
    // branch deletion. Nothing here can clear a lock, remove a directory, or
    // retire a ref.
    //
    // What remains is the honest verdict: the entry is a retirement CANDIDATE
    // that stays on disk for root to authorize against the recorded owner,
    // accepted head and recovery reference. The cleanup wave also retains the checkout;
    // final retirement requires a manual root-operated native Git handoff.
    results.push({
      path: gitKnownPath,
      status: 'retained',
      reason: 'owner_completion_authorization_required',
    });
  }

  // Startup nomination has no authority over unrelated stale registrations.

  return results;
}

// ─── reapOrphanWorktrees deps helpers ─────────────────────────────────────────

/**
 * Liveness probe for a lock-owner PID — FAILS CLOSED (#3057).
 *
 * `ESRCH` ("no such process") is the ONLY outcome that proves the owner is
 * gone. Every other failure means the probe could not determine liveness:
 *   - `EPERM` — the process exists, we just may not signal it;
 *   - `TypeError` / `ERR_INVALID_ARG_TYPE` — `process.kill` accepts a pid up
 *     to 2147483647 and REJECTS 2147483648 and above (measured), so a finite
 *     but out-of-range pid never reaches the OS at all;
 *   - anything else — an outcome this helper does not recognise.
 *
 * The return value feeds a DESTRUCTIVE decision (`git worktree remove
 * --force`), so an unrecognised failure must never read as "dead". Hence the
 * inversion: only ESRCH returns false; everything else returns true (alive,
 * do not reap).
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null | undefined)?.code !== 'ESRCH';
  }
}

function defaultReadDirSafe(dir: string): string[] | null {
  try { return fs.readdirSync(dir); } catch { return null; }
}

function defaultReadFileSafe(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function defaultMtimeSafe(file: string): Date | null {
  try { return fs.statSync(file).mtime; } catch { return null; }
}

function cmdWorktreeReapOrphans(cwd: string, deps: RecordAgentCmdDeps & WorktreeDeps = {}): void {
  const write = deps.write || ((s: string) => process.stdout.write(s));
  const writeErr = deps.writeErr || ((s: string) => process.stderr.write(s));
  let result: ReapResult[];
  try {
    result = reapOrphanWorktrees(cwd, deps);
  } catch (err) {
    // Surface failure as a one-line warning; keep exit-zero so workflows don't break.
    writeErr(`[gsd] worktree.reap-orphans failed: ${err && (err as Error).message ? (err as Error).message : String(err)}\n`);
    result = [];
  }
  const skippedCount = result.filter((r) => r.status === 'skipped').length;
  if (skippedCount > 0) {
    // Surface skipped entries so operators are aware of unresolved orphans.
    writeErr(`[gsd] worktree.reap-orphans: ${skippedCount} orphan(s) skipped (run with DEBUG=1 for details)\n`);
  }
  // #ORCH-01: retained candidates are the sweep's actionable output now that it
  // no longer removes anything. They are reported separately from `skipped`
  // because they need root to supply owner/completion/recovery authorization,
  // which is a different operator action than "wait for the lock to age out".
  const retainedCount = result.filter((r) => r.status === 'retained').length;
  if (retainedCount > 0) {
    writeErr(
      `[gsd] worktree.reap-orphans: ${retainedCount} orphan candidate(s) retained`
      + ' — retirement requires owner completion/recovery authorization (nothing was removed)\n'
    );
  }
  // `reaped` is kept in the payload for workflow/CLI compatibility. It is now
  // always 0: this command removes nothing. `retained` carries the candidates.
  write(`${JSON.stringify({ ok: true, reaped: result.filter((r) => r.status === 'reaped').length, retained: retainedCount, entries: result }, null, 2)}\n`);
}

// ─── Worker lifecycle records (#4624) ────────────────────────────────────────
// Durable per-worker launch/terminal state for the orchestrator-worktree
// backend. The dispatch fragment spawns external executor processes with a
// bare background `wait`; when the orchestrator's turn ends before a worker
// finishes, nothing records the launch or guarantees reconciliation, and a
// resumed session has no state to recover — it re-derives everything from
// manual PID/log discovery. These records persist the launch identity, the
// result location, and the terminal outcome as a small JSON file beside the
// worktree (NOT inside it — cleanup removes the worktree; the record must
// survive it), so `worker-status` can answer "who was dispatched, is it
// still running, did it finish its artifacts, does it need reconciliation"
// deterministically on resume.

/** Path of the lifecycle record for a worktree: a SIBLING of the worktree dir. */
function workerRecordPath(worktreePath: string): string {
  return `${worktreePath}.worker.json`;
}

interface WorkerRecord {
  agentId: string;
  pid: number;
  plan: string;
  worktreePath: string;
  summaryPath: string;
  logFile: string;
  startedAt: string;
  state: 'running' | 'complete';
  exitCode: number | null;
  note: string;
  completedAt: string | null;
}

const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);

// local/require-fs-op-fallback: a concurrent reader or antivirus scanner can
// transiently hold the rename target open on Windows (DEFECT.WINDOWS-FS-OPS) —
// bounded retry on the transient errnos, per the house pattern.
function renameWithRetry(tmp: string, target: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code && RENAME_RETRY_ERRNOS.has(code) && attempt < 3) {
        const until = Date.now() + 25 * (attempt + 1);
        while (Date.now() < until) { /* bounded spin: transient locks clear in <100ms */ }
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function writeWorkerRecord(
  recordPath: string,
  record: WorkerRecord,
  deps: Record<string, unknown> = {}
): void {
  const writeFile = (deps.writeFile as ((p: string, d: string) => void)) || ((p: string, d: string) => fs.writeFileSync(p, d));
  const tmp = `${recordPath}.tmp-${process.pid}`;
  writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameWithRetry(tmp, recordPath);
}

function cmdWorktreeWorkerRecord(cwd: string, args: string[] = [], deps: Record<string, unknown> = {}): void {
  const flag = (name: string): string => {
    const i = args.indexOf(name);
    if (i < 0 || i + 1 >= args.length) return '';
    return args[i + 1];
  };
  const write = (deps.write as ((s: string) => void)) || ((s: string) => process.stdout.write(s));
  const writeErr = (deps.writeErr as ((s: string) => void)) || ((s: string) => process.stderr.write(s));

  const worktreePath = flag('--path');
  const pidText = flag('--pid');
  const plan = flag('--plan');
  const summaryPath = flag('--summary-path');
  const logFile = flag('--log-file');
  if (!worktreePath || !pidText || !plan || !summaryPath) {
    writeErr('Usage: worktree worker-record --path <worktree> --pid <pid> --plan <plan_number> --summary-path <path> [--log-file <path>]\n');
    process.exitCode = 2;
    return;
  }
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) {
    writeErr(`[gsd] worktree.worker-record: invalid --pid: ${pidText}\n`);
    process.exitCode = 2;
    return;
  }

  const resolvedWorktree = path.resolve(cwd, worktreePath);
  const recordPath = workerRecordPath(resolvedWorktree);
  const readFile = (deps.readFile as ((p: string) => string)) || ((p: string) => fs.readFileSync(p, 'utf8'));
  let existing: WorkerRecord | null = null;
  try {
    existing = JSON.parse(readFile(recordPath)) as WorkerRecord;
  } catch { /* no record yet — first dispatch for this worktree */ }
  if (existing && existing.state === 'running') {
    // Duplicate-dispatch guard (#4624): a running record means a resumed
    // session re-entered the dispatch step. The worker must be reconciled
    // (worker-status → completion-reconciliation), never re-spawned.
    const hint = 'A worker is already recorded RUNNING for this worktree. Reconcile it (worktree worker-status, then execute-phase/steps/completion-reconciliation.md) before any new dispatch — never re-dispatch a recorded plan.';
    writeErr(`[gsd] worktree.worker-record: already_running — ${hint}\n`);
    write(`${JSON.stringify({ ok: false, reason: 'already_running', hint, record: existing }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const record: WorkerRecord = {
    agentId: path.basename(resolvedWorktree),
    pid,
    plan,
    worktreePath: resolvedWorktree,
    summaryPath: path.resolve(cwd, summaryPath),
    logFile: logFile ? path.resolve(cwd, logFile) : '',
    startedAt: new Date().toISOString(),
    state: 'running',
    exitCode: null,
    note: '',
    completedAt: null,
  };
  try {
    writeWorkerRecord(recordPath, record, deps);
  } catch (err) {
    writeErr(`[gsd] worktree.worker-record: write_failed — ${(err as Error).message}\n`);
    write(`${JSON.stringify({ ok: false, reason: 'write_failed', error: (err as Error).message }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  write(`${JSON.stringify({ ok: true, record }, null, 2)}\n`);
}

function workerStatusView(
  record: WorkerRecord,
  deps: Record<string, unknown> = {}
): Record<string, unknown> {
  // Only ESRCH is dead (defaultIsPidAlive contract): a verdict feeding a
  // merge/reconcile decision must fail toward ALIVE on unrecognized errnos.
  const pidAlive = (deps.isPidAlive as ((pid: number) => boolean)) || defaultIsPidAlive;
  const exists = (deps.existsSync as ((p: string) => boolean)) || fs.existsSync;
  const summaryExists = exists(record.summaryPath);
  const alive = record.state === 'running' && pidAlive(record.pid);
  return {
    agentId: record.agentId,
    pid: record.pid,
    plan: record.plan,
    worktreePath: record.worktreePath,
    summaryPath: record.summaryPath,
    logFile: record.logFile,
    state: record.state,
    exitCode: record.exitCode,
    note: record.note,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    pidAlive: record.state === 'running' ? alive : null,
    summaryExists,
    needsReconciliation: record.state === 'running' && !alive,
  };
}

function readWorkerRecordsFromRoot(
  root: string,
  readFile: (p: string) => string,
  readdir: (p: string) => string[]
): { path: string; record: WorkerRecord }[] {
  let entries: string[] = [];
  try {
    entries = readdir(root).filter((f) => f.endsWith('.worker.json'));
  } catch { /* root missing — no workers ever recorded */ return []; }
  const out: { path: string; record: WorkerRecord }[] = [];
  for (const entry of entries) {
    const recordPath = path.join(root, entry);
    try {
      out.push({ path: recordPath, record: JSON.parse(readFile(recordPath)) as WorkerRecord });
    } catch { // a torn/partial record must not hide the others
      out.push({ path: recordPath, record: null as unknown as WorkerRecord });
    }
  }
  return out;
}

function cmdWorktreeWorkerStatus(cwd: string, args: string[] = [], deps: Record<string, unknown> = {}): void {
  const flag = (name: string): string => {
    const i = args.indexOf(name);
    if (i < 0 || i + 1 >= args.length) return '';
    return args[i + 1];
  };
  const write = (deps.write as ((s: string) => void)) || ((s: string) => process.stdout.write(s));
  const writeErr = (deps.writeErr as ((s: string) => void)) || ((s: string) => process.stderr.write(s));

  const worktreePath = flag('--path');
  const root = flag('--root');
  if (!worktreePath === !root) { // exactly one of the two
    writeErr('Usage: worktree worker-status (--path <worktree> | --root <worktrees-dir>)\n');
    process.exitCode = 2;
    return;
  }
  const readFile = (deps.readFile as ((p: string) => string)) || ((p: string) => fs.readFileSync(p, 'utf8'));
  const readdir = (deps.readdir as ((p: string) => string[])) || ((p: string) => fs.readdirSync(p));

  const views: Record<string, unknown>[] = [];
  if (worktreePath) {
    const recordPath = workerRecordPath(path.resolve(cwd, worktreePath));
    let record: WorkerRecord | null = null;
    let unreadable = false;
    try {
      record = JSON.parse(readFile(recordPath)) as WorkerRecord;
    } catch {
      // A record that exists but cannot be parsed is NOT "never dispatched" —
      // conflating the two invites a re-dispatch. Surface it as a candidate.
      unreadable = fs.existsSync(recordPath);
    }
    if (unreadable) {
      // exists but unparseable — a reconciliation candidate, never "never dispatched"
      views.push({ state: 'unreadable', needsReconciliation: true, recordPath });
    } else if (record) {
      views.push(workerStatusView(record, deps));
    } else {
      // no record file: genuinely never dispatched (found:false)
      write(`${JSON.stringify({ ok: true, found: false, workers: [] }, null, 2)}\n`);
      return;
    }
  } else {
    for (const { record } of readWorkerRecordsFromRoot(path.resolve(cwd, root), readFile, readdir)) {
      if (!record) { // torn record is itself a reconciliation candidate
        views.push({ state: 'unreadable', needsReconciliation: true });
        continue;
      }
      views.push(workerStatusView(record, deps));
    }
  }
  write(`${JSON.stringify({ ok: true, found: true, workers: views }, null, 2)}\n`);
}

function cmdWorktreeWorkerComplete(cwd: string, args: string[] = [], deps: Record<string, unknown> = {}): void {
  const flag = (name: string): string => {
    const i = args.indexOf(name);
    if (i < 0 || i + 1 >= args.length) return '';
    return args[i + 1];
  };
  const write = (deps.write as ((s: string) => void)) || ((s: string) => process.stdout.write(s));
  const writeErr = (deps.writeErr as ((s: string) => void)) || ((s: string) => process.stderr.write(s));

  const worktreePath = flag('--path');
  const exitText = flag('--exit-code');
  const note = flag('--note');
  if (!worktreePath || !exitText) {
    writeErr('Usage: worktree worker-complete --path <worktree> --exit-code <n> [--note <recovery info>]\n');
    process.exitCode = 2;
    return;
  }
  const exitCode = Number(exitText);
  if (!Number.isInteger(exitCode)) {
    writeErr(`[gsd] worktree.worker-complete: invalid --exit-code: ${exitText}\n`);
    process.exitCode = 2;
    return;
  }

  const recordPath = workerRecordPath(path.resolve(cwd, worktreePath));
  const readFile = (deps.readFile as ((p: string) => string)) || ((p: string) => fs.readFileSync(p, 'utf8'));
  let record: WorkerRecord;
  try {
    record = JSON.parse(readFile(recordPath)) as WorkerRecord;
  } catch (err) {
    writeErr(`[gsd] worktree.worker-complete: no_record — ${(err as Error).message}\n`);
    write(`${JSON.stringify({ ok: false, reason: 'no_record', error: (err as Error).message }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const alreadyComplete = record.state === 'complete';
  record.state = 'complete';
  record.exitCode = exitCode;
  record.note = note || record.note || '';
  record.completedAt = record.completedAt || new Date().toISOString();
  try {
    writeWorkerRecord(recordPath, record, deps);
  } catch (err) {
    writeErr(`[gsd] worktree.worker-complete: write_failed — ${(err as Error).message}\n`);
    write(`${JSON.stringify({ ok: false, reason: 'write_failed', error: (err as Error).message }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  write(`${JSON.stringify({ ok: true, alreadyComplete, record }, null, 2)}\n`);
}

// Unused exports kept for API compatibility
void parseWorktreeListPaths;

// ─── Moved from core.cjs (ADR-857 T0 #1268 rehome-core-squatters) ─────────────

/**
 * Resolve the main worktree root when running inside a git worktree, along
 * with the `reason` that produced it (#3050). Callers MUST inspect `reason`
 * before trusting `root` unconditionally — a `reason` of `git_timed_out`
 * means the git subprocess used to distinguish "linked worktree" from
 * "not a repo" never completed, so `root` is a best-effort fallback (cwd),
 * not a confirmed worktree root. Degrading to cwd rather than throwing is
 * intentional (return degraded result on timeout; do not throw) — but the
 * reason must still reach the caller so it can surface the risk instead of
 * silently trusting the wrong root.
 */
function resolveWorktreeRoot(cwd: string, deps: WorktreeDeps = {}): { root: string; reason: string } {
  const context = resolveWorktreeContext(cwd, {
    existsSync: deps.existsSync || fs.existsSync,
    execGit: deps.execGit,
  });
  return { root: context.effectiveRoot, reason: context.reason };
}

/**
 * Report retained worktree metadata. Repository-wide pruning requires root
 * accounting for all affected owners and recovery references.
 *
 * @param repoRoot - absolute path to the main (or any) worktree of
 *   the repository; used as `cwd` for git commands.
 * @returns list of worktree paths that were removed (always empty)
 */
function pruneOrphanedWorktrees(repoRoot: string, deps: WorktreeDeps & { writeErr?: (s: string) => void } = {}): string[] {
  const writeErr = deps.writeErr || ((s: string) => process.stderr.write(s));
  try {
    // `...deps` comes LAST deliberately: `parseWorktreePorcelain` is a declared
    // member of WorktreeDeps and planWorktreePrune already reads
    // `deps.parseWorktreePorcelain` before falling back to the module function,
    // so a caller-supplied parser is an intended override, not an accident.
    // The hard-coded key is only a restatement of that same default. Do not
    // reorder the two — `tests/worktree-safety-reap.test.cjs` pins the override.
    const plan = planWorktreePrune(
      repoRoot,
      { allowDestructive: false },
      { parseWorktreePorcelain, ...deps }
    );
    const pruneResult = executeWorktreePrunePlan(plan, deps);
    if (pruneResult.reason === 'manual_root_prune_required') {
      writeErr('[gsd-tools] worktree metadata retained: repository-wide prune requires root owner/recovery accounting.\n');
    }
    if (pruneResult && pruneResult.timedOut) {
      writeErr(
        '[gsd-tools] WARNING: worktree health check degraded' +
        ' — git worktree prune timed out after 10s.' +
        ' Orphaned worktree metadata may remain until the next successful run.\n'
      );
    }
  } catch { /* never crash the caller */ }
  return [];
}

export = {
  // Re-exported for the codebase-drift gate's --name-status parser (#4081):
  // single owner of git C-quoted-path decoding.
  decodeGitQuotedPath,
  resolveWorktreeContext,
  resolveWorktreeLinkage,
  parseWorktreePorcelain,
  planWorktreePrune,
  executeWorktreePrunePlan,
  listLinkedWorktreePaths,
  inspectWorktreeHealth,
  snapshotWorktreeInventory,
  rescueSummaryArtifacts,
  evaluateRetirementAuthorization,
  findNestedCheckout,
  normalizeCleanupManifest,
  planWorktreeWaveCleanup,
  executeWorktreeWaveCleanupPlan,
  WAVE_CLEANUP_WARNING,
  DEFAULT_MERGE_TIMEOUT_MS,
  planWaveScopeConformance,
  isSummaryArtifactRelPath,
  cmdWorktreeCleanupWave,
  planWorktreeRecordAgent,
  cmdWorktreeRecordAgent,
  planWorktreeCreate,
  executeWorktreeCreatePlan,
  cmdWorktreeCreate,
  reapOrphanWorktrees,
  cmdWorktreeReapOrphans,
  workerRecordPath,
  cmdWorktreeWorkerRecord,
  cmdWorktreeWorkerStatus,
  cmdWorktreeWorkerComplete,
  resolveWorktreeRoot,
  pruneOrphanedWorktrees,
};
