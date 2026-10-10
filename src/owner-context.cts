/**
 * Owner Context - additive, versioned portfolio ownership contract (v1).
 *
 * This module answers one question before any topology-changing step: "which
 * repository and planning scope owns this work, and is the context I was handed
 * still true?" It is deliberately SEPARATE from the frozen six-key
 * .planning/state.json contract (src/state-contract.cts, CONTRACT_KEY_ORDER).
 * The state contract is a best-effort publisher that never throws; this
 * contract is a MANDATORY gate that can and does refuse.
 *
 * Contract shape (wire form, versioned independently of state.json):
 *   { contract, flavor, task_id, owner, planning, workflow, policy,
 *     fingerprint, generated_at }
 *
 * The envelope form is attached additively to every init.* result (see
 * src/init.cts's withProjectRoot) under the key owner_context. No existing init
 * key changes and the frozen state contract is untouched.
 *
 * THREE mandatory boundaries (never an opt-in capability, never a silent
 * best-effort publisher):
 *   1. CORE ENTRY    - ownerContextEnvelopeField is folded into every init
 *                      envelope. Init is a TOTAL, read-only publisher: it
 *                      resolves and reports the context and NEVER refuses. The
 *                      enforce gate lives only at the mutating boundaries (2,3).
 *   2. DIRECT WRITER - assertOwnerContextForWrite gates the multi-file
 *                      planning transaction (src/phase.cts's
 *                      writePlanningFileSet) before any byte is written.
 *   3. DISPATCH      - assertOwnerContextForWrite gates mutating command
 *                      families in gsd-core/bin/gsd-tools.cjs before the
 *                      command runs. Boundaries 2 and 3 call the SAME function.
 *
 * MODE. Policy defaults to audit: the context is resolved and reported, and the
 * current behaviour is preserved exactly (nothing is refused). enforce (an
 * explicit, trusted, local JSON file - never a path taken from prompt text)
 * rejects a missing / wrong-owner / stale / invalid policy context BEFORE a
 * mutation. Only a genuinely ABSENT default policy file keeps audit: a present
 * policy that is unreadable, malformed/truncated, schema-invalid, or named by
 * an escaping path is FAIL-CLOSED, so a broken policy can never authorise more
 * than today and can never silently decay to audit.
 *
 * ENFORCE REQUIRES AN EXECUTABLE TASK DESCRIPTOR. Resolving the local cwd is
 * NOT by itself authorisation: without a descriptor the gate cannot tell which
 * of the policy's owners this run is for, or whether the caller saw the same
 * HEAD/planning snapshot it is about to mutate. In enforce mode the caller MUST
 * supply a descriptor (in-process, or through the GSD_OWNER_* env contract the
 * dispatcher sets - see OWNER_DESCRIPTOR_ENV) that pins the owner, states the
 * workflow explicitly (never an implicit operational fallback), and carries the
 * expected HEAD / planning fingerprint. A missing descriptor is a MISSING
 * refusal, never a silent self-authorisation from the current cwd. A policy
 * that is present and DECLARES enforce but fails its own schema is fail-closed
 * (INVALID_POLICY blocks) instead of silently decaying to audit.
 *
 * NO PROVIDER CALLS. Read-only init resolves git/planning facts locally and
 * sends nothing over the network. There is no HTTP/agent/model surface here.
 *
 * ADR-457 build-at-publish: source in src/owner-context.cts, compiled to
 * gsd-core/bin/lib/owner-context.cjs (gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execGit, retryRenameSync } from './shell-command-projection.cjs';
import { tryWithinRoot, tryWithinRootLexical, PathAcceptance } from './security.cjs';
// #ownership-runtime: the command-alias registry is the single source of truth
// for the mutating-command classification below (see buildMutationTables).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import commandAliasesModule = require('./command-aliases.cjs');

export { PathAcceptance };

// --- Public wire vocabulary (frozen; pinned by tests) -----------------------

/** Version of the owner_context envelope. Versioned independently of state.json. */
export const OWNER_CONTEXT_VERSION = '1.0.0';
export const OWNER_CONTEXT_FLAVOR = 'core';

/** Version of the owner policy file. Independent of the context envelope. */
export const OWNER_POLICY_VERSION = '1.0.0';

/** Key order of the emitted owner_context object - an observable, pinned by test. */
export const OWNER_CONTEXT_KEY_ORDER: readonly string[] = Object.freeze([
  'contract',
  'flavor',
  'task_id',
  'owner',
  'planning',
  'workflow',
  'policy',
  'fingerprint',
  'generated_at',
]);

/** Enforcement mode. audit is the default and preserves current behaviour. */
export const OWNER_POLICY_MODE = Object.freeze({
  AUDIT: 'audit',
  ENFORCE: 'enforce',
});
export type OwnerPolicyMode = (typeof OWNER_POLICY_MODE)[keyof typeof OWNER_POLICY_MODE];

/** Closed verdict vocabulary - callers branch on these, never on prose. */
export const OWNER_CONTEXT_VERDICT = Object.freeze({
  OK: 'ok',
  /** Policy is absent or mode=audit: nothing is refused (current safety). */
  DISABLED: 'policy_disabled',
  /** Workflow/plan linkage required by policy is absent or incomplete. */
  MISSING: 'missing_owner_context',
  /** Resolved identity is not a member of the policy's known owners. */
  WRONG_OWNER: 'wrong_owner',
  /** Live HEAD / planning / dirty fingerprint disagrees with the expected one. */
  STALE: 'stale_context',
  /** The policy file exists but does not satisfy the owner-policy schema. */
  INVALID_POLICY: 'invalid_policy',
  /** cwd is not inside a resolvable git worktree, or planning scope is unreadable. */
  UNRESOLVED: 'unresolved_identity',
});
export type OwnerContextVerdict = (typeof OWNER_CONTEXT_VERDICT)[keyof typeof OWNER_CONTEXT_VERDICT];

/**
 * Workflow discriminator. `UNRESOLVED` is a real terminal value: when no kind
 * is supplied the descriptor reports `unresolved` rather than a confident
 * `operational`, and an unresolved kind is refused under enforce. There is no
 * silent fallback in EITHER direction.
 */
export const OWNER_WORKFLOW_KIND = Object.freeze({
  PHASE: 'phase',
  LINKED_QUICK: 'linked-quick',
  STANDALONE_QUICK: 'standalone-quick',
  OPERATIONAL: 'operational',
  UNRESOLVED: 'unresolved',
});
export type OwnerWorkflowKind = (typeof OWNER_WORKFLOW_KIND)[keyof typeof OWNER_WORKFLOW_KIND];

/** Explicit trusted-local policy path, relative to the project root. */
export const OWNER_POLICY_RELATIVE_PATH = '.planning/owner-policy.json';
/** Additive record of the most recently resolved context (never state.json). */
export const OWNER_CONTEXT_RELATIVE_PATH = '.planning/owner-context.json';

const OWNER_POLICY_ENV = 'GSD_OWNER_POLICY';

/**
 * The published env contract a dispatcher / runtime adapter binds BEFORE it
 * invokes a mutating command. These are trusted-local (the adapter's own
 * process env), never prompt text. `GSD_OWNER_DESCRIPTOR` names a JSON file
 * confined to the project root; the scalar vars are the field-level form.
 */
export const OWNER_DESCRIPTOR_ENV = Object.freeze({
  FILE: 'GSD_OWNER_DESCRIPTOR',
  TASK_ID: 'GSD_OWNER_TASK_ID',
  REPO_ID: 'GSD_OWNER_REPO_ID',
  REMOTE: 'GSD_OWNER_REMOTE',
  ROOT: 'GSD_OWNER_ROOT',
  WORKFLOW: 'GSD_OWNER_WORKFLOW',
  PHASE: 'GSD_OWNER_PHASE',
  PLAN: 'GSD_OWNER_PLAN',
  PARENT_PLAN: 'GSD_OWNER_PARENT_PLAN',
  RATIONALE: 'GSD_OWNER_RATIONALE',
  PROJECT: 'GSD_OWNER_PROJECT',
  WORKSTREAM: 'GSD_OWNER_WORKSTREAM',
  EXPECT_HEAD: 'GSD_OWNER_EXPECT_HEAD',
  EXPECT_FINGERPRINT: 'GSD_OWNER_EXPECT_FINGERPRINT',
  EXPECT_LINK_FINGERPRINT: 'GSD_OWNER_EXPECT_LINK_FINGERPRINT',
  EXPECT_SCOPE_FINGERPRINT: 'GSD_OWNER_EXPECT_SCOPE_FINGERPRINT',
  EXPECT_DIRTY: 'GSD_OWNER_EXPECT_DIRTY',
  WRITABLE_SCOPES: 'GSD_OWNER_WRITABLE_SCOPES',
  TARGETS: 'GSD_OWNER_TARGETS',
  AFFECTED_REPOS: 'GSD_OWNER_AFFECTED_REPOS',
  DEPENDENCIES: 'GSD_OWNER_DEPENDENCIES',
  PROVENANCE: 'GSD_OWNER_PROVENANCE',
});

const PLANNING_FINGERPRINT_FILES: readonly string[] = Object.freeze([
  'ROADMAP.md',
  'STATE.md',
  'PROJECT.md',
  'REQUIREMENTS.md',
  'config.json',
]);

// --- Input shapes -----------------------------------------------------------

export interface GitExecResult {
  exitCode: number;
  stdout: string;
}
export type GitExecFn = (args: string[], opts?: { cwd?: string; timeout?: number }) => GitExecResult;

export interface OwnerContextDeps {
  execGit?: GitExecFn;
  now?: () => number;
}

export interface RepoIdentity {
  inside: boolean;
  root: string | null;
  real_root: string | null;
  common_dir: string | null;
  head: string | null;
  branch: string | null;
  remote: string | null;
  repo_id: string | null;
  linked_worktree: boolean;
  nested: boolean;
  dirty: string[];
  dirty_truncated: boolean;
}

export interface PlanningScope {
  root: string;
  project: string | null;
  workstream: string | null;
  mode: 'root' | 'project' | 'workstream';
}

export interface WorkflowDescriptor {
  kind: OwnerWorkflowKind;
  phase: string | null;
  plan: string | null;
  parent_plan: string | null;
  rationale: string | null;
}

export interface OwnerContextFingerprint {
  head: string | null;
  planning: string | null;
  /**
   * Content fingerprint of the workflow's referenced artifact (the phase PLAN
   * or the linked quick's parent plan), resolved within the planning scope.
   * null when the workflow kind carries no link. Binds a referenced plan to
   * stale detection, not only the five root planning docs.
   */
  link: string | null;
  dirty: string[];
}

export interface OwnerContextPolicyView {
  mode: OwnerPolicyMode;
  version: string;
  source: string | null;
  valid: boolean;
}

export interface OwnerContextV1 {
  contract: string;
  flavor: string;
  task_id: string | null;
  owner: RepoIdentity;
  planning: PlanningScope;
  workflow: WorkflowDescriptor;
  policy: OwnerContextPolicyView;
  fingerprint: OwnerContextFingerprint;
  generated_at: string;
}

export interface OwnerPolicy {
  policy_version: string;
  mode: OwnerPolicyMode;
  known_owners: Array<{ repo_id?: string; remote?: string; root?: string }>;
  allow_standalone_quick: boolean;
  allow_operational: boolean;
  require_workflow_link: boolean;
  allow_dirty: boolean;
  require_owner_for_mutation: boolean;
}

export interface OwnerPolicyLoadResult {
  policy: OwnerPolicy;
  source: string | null;
  /** True when the file EXISTS on disk (even if it is unreadable or invalid). */
  present: boolean;
  ok: boolean;
  reasons: string[];
  /** True when the caller named the policy path (an option or GSD_OWNER_POLICY). */
  explicit: boolean;
  /**
   * True when enforce must be assumed. Set by: a parsed/inspected
   * `mode:"enforce"` (including inside a truncated or otherwise unreadable
   * file), an explicitly named policy path, or a present-but-unreadable file.
   * Any of those is fail-closed: the gate blocks rather than decaying to audit.
   * False only for a genuinely absent default policy path.
   */
  requested_enforce: boolean;
}

export interface OwnerContextExpected {
  head?: string | null;
  planning_fingerprint?: string | null;
  link_fingerprint?: string | null;
  /** Combined content fingerprint over the descriptor's explicit writable scopes. */
  scope_fingerprint?: string | null;
  dirty?: boolean;
}

/** The resolved planning scope a descriptor pins (project / workstream). */
export interface PlanningBinding {
  project: string | null;
  workstream: string | null;
}

/**
 * The caller-declared intent for one mutating run. Required under enforce:
 * it pins WHICH owner this run is for, states the workflow explicitly, and
 * carries the snapshot the caller observed. Never derived from prompt text.
 */
export interface OwnerTaskDescriptor {
  task_id: string | null;
  owner: { repo_id?: string; remote?: string; root?: string } | null;
  planning: PlanningBinding | null;
  workflow: WorkflowDescriptor;
  expected: OwnerContextExpected;
  /** Explicit, confined writable source paths the caller owns for this run. */
  writable_scopes: string[];
  affected_repos: string[];
  dependencies: string[];
  provenance: string | null;
}

export interface OwnerTaskDescriptorLoad {
  descriptor: OwnerTaskDescriptor | null;
  present: boolean;
  valid: boolean;
  reasons: string[];
  source: string | null;
}

export interface OwnershipVerdict {
  ok: boolean;
  verdict: OwnerContextVerdict;
  reasons: string[];
}

export interface OwnerContextGateResult {
  mode: OwnerPolicyMode;
  /** True only when a valid policy file selects enforce mode. */
  enforcing: boolean;
  ok: boolean;
  verdict: OwnerContextVerdict;
  reasons: string[];
  policy: OwnerPolicy;
  policy_source: string | null;
  /** The executable task descriptor the gate validated (null in audit, or when absent). */
  descriptor: OwnerTaskDescriptor | null;
  context: OwnerContextV1;
}

// --- Defaults ---------------------------------------------------------------

export const OWNER_POLICY_DEFAULT: OwnerPolicy = Object.freeze({
  policy_version: OWNER_POLICY_VERSION,
  mode: OWNER_POLICY_MODE.AUDIT,
  known_owners: [],
  allow_standalone_quick: true,
  allow_operational: true,
  require_workflow_link: false,
  allow_dirty: true,
  require_owner_for_mutation: true,
});

const ALLOWED_POLICY_KEYS = new Set(Object.keys(OWNER_POLICY_DEFAULT));
const POLICY_OWNER_KEYS = new Set(['repo_id', 'remote', 'root']);

function sha256Hex(input: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function emptyIdentity(): RepoIdentity {
  return {
    inside: false,
    root: null,
    real_root: null,
    common_dir: null,
    head: null,
    branch: null,
    remote: null,
    repo_id: null,
    linked_worktree: false,
    nested: false,
    dirty: [],
    dirty_truncated: false,
  };
}

/**
 * Canonical repo identity from a git remote URL. Stable across ssh/https
 * spellings so the same repository never yields two repo_ids.
 */
export function canonicalRepoId(remote: string | null | undefined): string | null {
  if (typeof remote !== 'string') return null;
  let value = remote.trim();
  if (!value) return null;
  value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  value = value.replace(/^[^@/]+@/, '');
  value = value.replace(/:/, '/');
  value = value.replace(/\.git$/, '');
  value = value.replace(/\/+$/, '');
  return value.toLowerCase() || null;
}

// --- Repo identity ----------------------------------------------------------

/**
 * Resolve the local git identity of cwd. Total: any git failure degrades to
 * inside:false and never throws. deps.execGit is the injectable seam.
 */
export function resolveRepoIdentity(cwd: string, deps: OwnerContextDeps = {}): RepoIdentity {
  const git: GitExecFn = deps.execGit ?? ((args, opts) => {
    const r = execGit(args, opts);
    return { exitCode: typeof r.exitCode === 'number' ? r.exitCode : 1, stdout: String(r.stdout || '') };
  });
  const identity = emptyIdentity();

  let insideResult: GitExecResult;
  try {
    insideResult = git(['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5000 });
  } catch {
    return identity;
  }
  if (insideResult.exitCode !== 0 || insideResult.stdout.trim() !== 'true') return identity;
  identity.inside = true;

  try {
    const r = git(
      ['rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir', 'HEAD', '--abbrev-ref', 'HEAD', '--show-prefix'],
      { cwd, timeout: 5000 },
    );
    if (r.exitCode === 0) {
      const lines = r.stdout.split('\n').map((l) => l.trim());
      identity.root = lines[0] || null;
      identity.common_dir = lines[1] || null;
      const head = lines[3] || '';
      identity.head = /^[0-9a-f]{7,64}$/i.test(head) ? head : null;
      const branch = lines[4] || '';
      identity.branch = branch && branch !== 'HEAD' ? branch : (identity.head || null);
      const prefix = lines[5] || '';
      identity.nested = prefix.length > 0 && prefix !== './' && prefix !== '.';
    }
  } catch {
    /* leave whatever resolved */
  }

  if (identity.root) {
    try {
      identity.real_root = fs.realpathSync.native(identity.root);
    } catch {
      identity.real_root = path.resolve(identity.root);
    }
    identity.linked_worktree = identity.common_dir !== null
      && path.resolve(identity.root, identity.common_dir) !== path.join(identity.root, '.git');
  }

  try {
    const remoteResult = git(['remote', 'get-url', 'origin'], { cwd, timeout: 5000 });
    if (remoteResult.exitCode === 0 && remoteResult.stdout.trim()) {
      identity.remote = remoteResult.stdout.trim();
    }
  } catch {
    /* no origin is a normal state */
  }
  identity.repo_id = canonicalRepoId(identity.remote)
    || (identity.root ? 'local:' + path.basename(identity.root) : null);

  try {
    // `--untracked-files=normal` so an untracked scope file counts toward the
    // advisory dirty list (the authoritative content check is the explicit
    // writable-scope fingerprint, which hashes bytes on disk).
    const statusResult = git(['status', '--porcelain=v1', '--untracked-files=normal'], { cwd, timeout: 5000 });
    if (statusResult.exitCode === 0) {
      const lines = statusResult.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      const MAX = 200;
      identity.dirty = lines.slice(0, MAX);
      identity.dirty_truncated = lines.length > MAX;
    }
  } catch {
    /* dirty state is advisory */
  }

  return identity;
}

// --- Planning scope ---------------------------------------------------------

function planningPathsOf(cwd: string): { planning: string } | null {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const mod = require('./planning-workspace.cjs') as typeof import('./planning-workspace.cjs');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const paths = mod.planningPaths(cwd);
    return { planning: paths.planning };
  } catch {
    return null;
  }
}

/**
 * Resolve the planning scope through the EXISTING GSD resolver. Never
 * re-derives project/workstream segments - GSD_PROJECT / GSD_WORKSTREAM are read
 * by planningDir/planningPaths themselves.
 */
export function resolvePlanningScope(cwd: string): PlanningScope {
  const project = (process.env['GSD_PROJECT'] ?? '').trim() || null;
  const workstream = (process.env['GSD_WORKSTREAM'] ?? '').trim() || null;
  const mode: PlanningScope['mode'] = workstream ? 'workstream' : project ? 'project' : 'root';
  const paths = planningPathsOf(cwd);
  return {
    root: paths ? paths.planning : path.join(cwd, '.planning'),
    project,
    workstream,
    mode,
  };
}

function fileDigestOr(filePath: string, fallback: string): string {
  try {
    return sha256Hex(fs.readFileSync(filePath)).slice(0, 24);
  } catch {
    return fallback;
  }
}

/** A deterministic fingerprint of the relevant planning documents. */
export function planningFingerprint(scope: PlanningScope): string {
  const parts: string[] = [
    'root:' + scope.root,
    'project:' + (scope.project ?? '-'),
    'workstream:' + (scope.workstream ?? '-'),
  ];
  for (const name of PLANNING_FINGERPRINT_FILES) {
    parts.push(name + ':' + fileDigestOr(path.join(scope.root, name), 'absent'));
  }
  return sha256Hex(parts.join('\n')).slice(0, 32);
}

// --- Explicit writable-scope fingerprint ------------------------------------

/**
 * Bounded traversal/read budgets for a scope snapshot. A caller declares the
 * write scope it owns; the fingerprint walks ONLY those paths (never the whole
 * repository), and a budget overrun is a refusal, not a best-effort partial.
 */
export const OWNER_SCOPE_BUDGET = Object.freeze({
  MAX_FILES: 2000,
  MAX_BYTES: 32 * 1024 * 1024,
  MAX_DEPTH: 24,
});

/**
 * GSD's OWN transient lock/temp artifacts - nothing else. A writable-scope
 * snapshot must bind the bytes of every legitimate file and directory an owner
 * may keep: a checked-in `Gemfile.lock`, a `foo.tmp/` build directory, a user's
 * own `.lock` data file. An earlier revision excluded any `*.lock`/`*.tmp` name
 * and any directory containing `.tmp-`; that silently dropped real content from
 * the snapshot (review 2026-10-10: `src/Gemfile.lock` edits did not move the
 * fingerprint). Only the exact names GSD itself creates around an owned write
 * are exempt, each with the source that owns it:
 *   - `STATE.md.lock`      - state.cts acquireStateLock (`statePath + '.lock'`)
 *   - `milestone.lock`     - milestone-lock.cts MILESTONE_LOCK_FILENAME (a
 *                            persistent claim, listed as an owned artifact in
 *                            artifacts.cts, so it must not move the snapshot)
 *   - `.WINDOWS.lock`      - broken-windows.cts ledger lock
 *   - `.consent.lock`      - capability-consent.cts consent-store lock
 *   - `.lock`              - capability-lifecycle.cts `.gsd/capabilities/.lock`
 *   - `<f>.tmp-<pid>`      - estimate-cli.cts / owner-context publish temp
 *   - `<f>.tmp.<pid>[-<n>]`- shell-command-projection.cts retryRenameSync /
 *                            capability-ledger.cts / capability-consent.cts
 *   - `<lock>.stale-<pid>-<ts>-<hex>` - capability-lock.cts stolen-lock rename
 * Those are operation transients of an owned file, never user content.
 */
const OWNED_TRANSIENT_EXACT: ReadonlySet<string> = new Set([
  'STATE.md.lock',
  'milestone.lock',
  '.WINDOWS.lock',
  '.consent.lock',
  '.lock',
]);

function isTransientScopeEntry(name: string): boolean {
  if (OWNED_TRANSIENT_EXACT.has(name)) return true;
  return /\.tmp-\d+$/.test(name)
    || /\.tmp\.\d+(?:-\d+)?$/.test(name)
    || /\.stale-\d+-\d+-[0-9a-f]+$/.test(name);
}

export interface ScopeFingerprintResult {
  ok: boolean;
  fingerprint: string | null;
  reasons: string[];
  file_count: number;
  bytes: number;
  truncated: boolean;
  entries: string[];
}

type LstatResult = { kind: 'ok'; stat: fs.Stats } | { kind: 'enoent' } | { kind: 'error'; message: string };

/** lstat (never follows a symlink) that distinguishes ENOENT from other errors. */
function lstatResult(p: string): LstatResult {
  try {
    return { kind: 'ok', stat: fs.lstatSync(p) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'enoent' };
    return { kind: 'error', message: (err as Error).message };
  }
}

/** Legacy lstat-or-null for the link resolver (existence/type only). */
function lstatOrNull(p: string): fs.Stats | null {
  const result = lstatResult(p);
  return result.kind === 'ok' ? result.stat : null;
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * Realpath of the nearest EXISTING ancestor of `abs` (or `abs` itself). Used to
 * confine a not-yet-existing path — a missing child beneath a dangling or
 * escaping symlink resolves its ancestor outside the root and is refused.
 */
function nearestExistingAncestorReal(abs: string): string | null {
  let cur = abs;
  for (;;) {
    const resolved = realpathOrNull(cur);
    if (resolved) return resolved;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Content fingerprint over the caller's explicit writable scopes: the real
 * bytes on disk, not `git status`. It therefore catches an edit to an
 * ALREADY-dirty tracked file, an untracked file appearing, and an untracked
 * file being deleted — all invisible to HEAD/porcelain status. Missing paths
 * record an `absent` outcome. Escapes, symlink escapes, unreadable files, and
 * any budget overrun refuse (ok:false) rather than authorize.
 */
export function scopeFingerprint(worktreeRoot: string, scopes: readonly string[]): ScopeFingerprintResult {
  const reasons: string[] = [];
  const entries: string[] = [];
  let fileCount = 0;
  let bytes = 0;
  let truncated = false;

  const rootReal = realpathOrNull(worktreeRoot);
  if (!rootReal) {
    return { ok: false, fingerprint: null, reasons: ['worktree root is not resolvable'], file_count: 0, bytes: 0, truncated: false, entries: [] };
  }
  const rootAbs = path.resolve(worktreeRoot);

  const hashFile = (abs: string, rel: string): void => {
    if (truncated) return;
    fileCount += 1;
    if (fileCount > OWNER_SCOPE_BUDGET.MAX_FILES) {
      truncated = true;
      reasons.push('writable scope file-count budget exceeded (' + OWNER_SCOPE_BUDGET.MAX_FILES + ')');
      return;
    }
    // Stat BEFORE reading so an oversized file is refused without allocating it.
    let size: number;
    try {
      size = fs.statSync(abs).size;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        reasons.push('writable scope file disappeared before read: ' + rel);
      } else {
        reasons.push('writable scope file is unreadable: ' + rel + ' (' + (err as Error).message + ')');
      }
      return;
    }
    if (size > OWNER_SCOPE_BUDGET.MAX_BYTES || bytes + size > OWNER_SCOPE_BUDGET.MAX_BYTES) {
      truncated = true;
      reasons.push('writable scope byte budget exceeded (' + OWNER_SCOPE_BUDGET.MAX_BYTES + ') at ' + rel);
      return;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      reasons.push('writable scope file is unreadable: ' + rel + ' (' + (code ?? (err as Error).message) + ')');
      return;
    }
    if (bytes + buf.length > OWNER_SCOPE_BUDGET.MAX_BYTES) {
      truncated = true;
      reasons.push('writable scope byte budget exceeded (' + OWNER_SCOPE_BUDGET.MAX_BYTES + ') at ' + rel);
      return;
    }
    bytes += buf.length;
    entries.push(rel + ':' + sha256Hex(buf).slice(0, 24));
  };

  const walk = (absDir: string, depth: number, relBase: string): void => {
    if (truncated) return;
    if (depth > OWNER_SCOPE_BUDGET.MAX_DEPTH) {
      truncated = true;
      reasons.push('writable scope depth budget exceeded at ' + relBase);
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      reasons.push('writable scope is unreadable: ' + relBase + ' (' + (err as Error).message + ')');
      return;
    }
    for (const dirent of dirents.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (truncated) return;
      if (isTransientScopeEntry(dirent.name)) continue;
      const abs = path.join(absDir, dirent.name);
      const rel = relBase ? relBase + '/' + dirent.name : dirent.name;
      // A symlink OR special entry inside a writable scope is refused outright:
      // following it would fingerprint bytes outside the declared scope, and
      // skipping it would silently drop content from the snapshot.
      if (dirent.isSymbolicLink()) {
        reasons.push('writable scope contains a symlink entry (refused): ' + rel);
        return;
      }
      if (dirent.isDirectory()) {
        walk(abs, depth + 1, rel);
      } else if (dirent.isFile()) {
        hashFile(abs, rel);
      } else {
        reasons.push('writable scope contains a special entry (refused): ' + rel);
        return;
      }
    }
  };

  for (const scope of scopes) {
    if (truncated) break;
    const relScope = scope.trim();
    if (!relScope) continue;
    const abs = path.isAbsolute(relScope) ? path.resolve(relScope) : path.resolve(worktreeRoot, relScope);
    if (!tryWithinRootLexical(abs, rootAbs)) {
      reasons.push('writable scope escapes the worktree root: ' + relScope);
      continue;
    }
    if (abs === rootAbs || abs === rootReal) {
      reasons.push('writable scope must be narrower than the worktree root: ' + relScope);
      continue;
    }
    // Nearest-existing-ancestor confinement: a missing child below a dangling
    // or escaping symlink resolves its ancestor outside the root and refuses.
    const ancestor = nearestExistingAncestorReal(abs);
    if (!ancestor || !tryWithinRoot(ancestor, rootReal, PathAcceptance.AbsoluteInsideRoot)) {
      reasons.push('writable scope resolves outside the worktree root: ' + relScope);
      continue;
    }
    const lstat = lstatResult(abs);
    if (lstat.kind === 'enoent') {
      entries.push(relScope + ':absent');
      continue;
    }
    if (lstat.kind === 'error') {
      reasons.push('writable scope stat failed: ' + relScope + ' (' + lstat.message + ')');
      continue;
    }
    if (lstat.stat.isSymbolicLink()) {
      reasons.push('writable scope is a symlink (refused): ' + relScope);
      continue;
    }
    if (lstat.stat.isFile()) {
      hashFile(abs, relScope);
    } else if (lstat.stat.isDirectory()) {
      walk(abs, 0, relScope);
    } else {
      reasons.push('writable scope is not a regular file or directory: ' + relScope);
    }
  }

  const ok = reasons.length === 0 && !truncated;
  const sorted = entries.slice().sort();
  const fingerprint = ok ? sha256Hex(sorted.join('\n')).slice(0, 32) : null;
  return { ok, fingerprint, reasons, file_count: fileCount, bytes, truncated, entries: sorted };
}

export interface TargetAuthorization {
  ok: boolean;
  reasons: string[];
  offending: string[];
}

/**
 * Bind concrete write TARGETS to the caller's explicit writable scopes. This
 * is the shared boundary for the direct planning writer and any dispatch
 * adapter that knows its output paths: a target must sit inside a declared
 * scope (planning roots therefore have to be listed explicitly) and must not
 * resolve outside the worktree root through a symlink. An empty scope list
 * authorizes nothing.
 */
export function authorizeOwnerTargets(worktreeRoot: string, scopes: readonly string[], targets: readonly string[]): TargetAuthorization {
  if (targets.length === 0) return { ok: true, reasons: [], offending: [] };
  if (scopes.length === 0) {
    return { ok: false, reasons: ['no writable scopes declared to authorize write targets'], offending: targets.slice() };
  }
  const rootReal = realpathOrNull(worktreeRoot);
  if (!rootReal) {
    return { ok: false, reasons: ['worktree root is not resolvable'], offending: targets.slice() };
  }
  const scopeAbs = scopes.map((scope) => (path.isAbsolute(scope) ? path.resolve(scope) : path.resolve(worktreeRoot, scope)));
  const reasons: string[] = [];
  const offending: string[] = [];
  for (const target of targets) {
    const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(worktreeRoot, target);
    const inScope = scopeAbs.some((scope) => tryWithinRootLexical(abs, scope));
    if (!inScope) {
      offending.push(target);
      reasons.push('write target is outside the declared writable scopes: ' + target);
      continue;
    }
    const ancestor = nearestExistingAncestorReal(abs);
    if (!ancestor || !tryWithinRoot(ancestor, rootReal, PathAcceptance.AbsoluteInsideRoot)) {
      offending.push(target);
      reasons.push('write target resolves outside the worktree root: ' + target);
    }
  }
  return { ok: offending.length === 0, reasons, offending };
}

export interface AssertTargetsOptions {
  policyPath?: string | null;
  descriptor?: OwnerTaskDescriptor | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * The shared pre-mutation boundary for direct writer/mutation exports that
 * skip the CLI dispatch gate. It runs the FULL semantic preflight once — policy
 * validity, descriptor schema, owner match, freshness snapshot, AND the
 * concrete write/delete/rename targets against the declared writable scopes —
 * so a direct JS caller with a malformed, stale, or wrong-owner descriptor (or
 * a target outside its scopes) is refused BEFORE the first filesystem mutation.
 * Under audit (no enforce policy) it is a no-op, preserving existing command
 * semantics. Call it once at a command's entry with the complete target set;
 * the writes it then performs are inside the validated operation context.
 */
export function assertTargetsAuthorized(cwd: string, targets: readonly string[], options: AssertTargetsOptions = {}): void {
  assertOwnerContextForWrite(cwd, {
    policyPath: options.policyPath ?? null,
    descriptor: options.descriptor ?? null,
    env: options.env,
    targets,
  });
}

export interface WorkflowLinkResolution {
  /** Absolute resolved path when the link resolves inside the scope and exists. */
  path: string | null;
  /** True when this workflow kind REQUIRES a resolvable link under enforce. */
  required: boolean;
  /** Why the link did not resolve (null when resolved or not required). */
  reason: string | null;
}

/**
 * Resolve a workflow's referenced artifact (a phase `plan` or a linked-quick
 * `parent_plan`) strictly inside the resolved planning scope. Rejects absolute
 * escapes, sibling-directory paths, and non-existent targets — an enforce gate
 * must never accept a link string that names nothing it can bind.
 */
export function resolveWorkflowLink(scope: PlanningScope, workflow: WorkflowDescriptor, worktreeRoot: string | null = null): WorkflowLinkResolution {
  const raw = workflow.kind === OWNER_WORKFLOW_KIND.PHASE
    ? workflow.plan
    : workflow.kind === OWNER_WORKFLOW_KIND.LINKED_QUICK
      ? workflow.parent_plan
      : null;
  if (!raw) {
    const required = workflow.kind === OWNER_WORKFLOW_KIND.PHASE || workflow.kind === OWNER_WORKFLOW_KIND.LINKED_QUICK;
    return { path: null, required, reason: required ? 'workflow ' + workflow.kind + ' requires a plan/parent_plan link' : null };
  }
  // Accept either a scope-relative link or a worktree-root-relative link (the
  // conventional `.planning/phases/...` form). Every candidate must still be
  // CONTAINED in the resolved planning scope; a link that lands outside the
  // scope (an absolute escape or a sibling path) is rejected, and a candidate
  // that is contained but missing falls through to "does not exist".
  const candidates: string[] = path.isAbsolute(raw)
    ? [path.resolve(raw)]
    : [path.resolve(scope.root, raw), path.resolve(worktreeRoot ?? scope.root, raw)];
  let sawContained = false;
  let sawNonFile = false;
  for (const candidate of candidates) {
    const contained = tryWithinRoot(candidate, scope.root, PathAcceptance.AbsoluteInsideRoot);
    if (!contained) continue;
    sawContained = true;
    const stat = lstatOrNull(contained);
    if (!stat) continue;
    if (!stat.isFile()) {
      // A directory (or special file) is not a bindable plan artifact.
      sawNonFile = true;
      continue;
    }
    try {
      fs.accessSync(contained, fs.constants.R_OK);
    } catch {
      sawNonFile = true;
      continue;
    }
    // Phase linkage: a `phase` plan must live in the phase directory matching
    // the declared phase and carry the `-PLAN.md` artifact suffix.
    if (workflow.kind === OWNER_WORKFLOW_KIND.PHASE && !phasePlanLinkMatches(contained, workflow.phase)) {
      sawNonFile = true;
      continue;
    }
    return { path: contained, required: true, reason: null };
  }
  return {
    path: null,
    required: true,
    reason: !sawContained
      ? 'workflow link escapes the resolved planning scope: ' + raw
      : sawNonFile
        ? 'workflow link is not a readable phase/plan artifact: ' + raw
        : 'workflow link does not exist: ' + raw,
  };
}

/**
 * A phase workflow's `plan` must sit in the phase directory that matches the
 * declared phase and end in `-PLAN.md` — a bare markdown path elsewhere in the
 * scope is not a valid phase-plan linkage.
 */
function phasePlanLinkMatches(absPlan: string, phase: string | null): boolean {
  if (!phase || !/^\d+$/.test(phase.trim())) return false;
  const normalized = phase.trim();
  const padded = normalized.padStart(2, '0');
  const dirName = path.basename(path.dirname(absPlan));
  const baseName = path.basename(absPlan);
  const dirOk = dirName === padded || dirName.startsWith(padded + '-')
    || dirName === normalized || dirName.startsWith(normalized + '-');
  return dirOk && baseName.endsWith('-PLAN.md');
}

/** Content fingerprint of a resolved workflow link (null when there is no link). */
export function linkFingerprint(scope: PlanningScope, workflow: WorkflowDescriptor, worktreeRoot: string | null = null): string | null {
  const resolved = resolveWorkflowLink(scope, workflow, worktreeRoot);
  if (!resolved.path) return null;
  return fileDigestOr(resolved.path, 'absent');
}

// --- Workflow descriptor ----------------------------------------------------

export interface WorkflowInput {
  kind?: OwnerWorkflowKind | null;
  phase?: string | null;
  plan?: string | null;
  parentPlan?: string | null;
  rationale?: string | null;
}

/**
 * Normalise a workflow descriptor. A missing or unrecognised kind resolves to
 * the explicit `unresolved` terminal — NEVER a confident `operational`, and
 * never an implicit quick task. Fields are passed through only when they are
 * already strings; no `String(...)` coercion, so an object/array rationale
 * becomes `null` (and is separately rejected by the strict descriptor schema)
 * rather than `"[object Object]"`.
 */
export function resolveWorkflow(input: WorkflowInput = {}): WorkflowDescriptor {
  const raw = input.kind;
  const validKinds = Object.values(OWNER_WORKFLOW_KIND) as string[];
  const kind: OwnerWorkflowKind = (typeof raw === 'string' && validKinds.includes(raw))
    ? raw
    : OWNER_WORKFLOW_KIND.UNRESOLVED;
  const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    kind,
    phase: str(input.phase),
    plan: str(input.plan),
    parent_plan: str(input.parentPlan),
    rationale: str(input.rationale),
  };
}

// --- Context builder --------------------------------------------------------

export interface BuildOwnerContextOptions extends WorkflowInput {
  taskId?: string | null;
  policy?: OwnerPolicyLoadResult;
  deps?: OwnerContextDeps;
}

export function buildOwnerContext(cwd: string, options: BuildOwnerContextOptions = {}): OwnerContextV1 {
  const deps = options.deps ?? {};
  const nowFn = deps.now ?? Date.now;
  const owner = resolveRepoIdentity(cwd, deps);
  const planning = resolvePlanningScope(cwd);
  const workflow = resolveWorkflow(options);
  const policyLoad = options.policy ?? loadOwnerPolicy(cwd, { deps });
  const fingerprint: OwnerContextFingerprint = {
    head: owner.head,
    planning: planningFingerprint(planning),
    link: linkFingerprint(planning, workflow, owner.root),
    dirty: owner.dirty,
  };
  return {
    contract: OWNER_CONTEXT_VERSION,
    flavor: OWNER_CONTEXT_FLAVOR,
    task_id: options.taskId ? String(options.taskId) : null,
    owner,
    planning,
    workflow,
    policy: {
      mode: policyLoad.policy.mode,
      version: policyLoad.policy.policy_version,
      source: policyLoad.source,
      valid: policyLoad.ok,
    },
    fingerprint,
    generated_at: new Date(nowFn()).toISOString(),
  };
}

// --- Policy -----------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve the explicit trusted-local policy path. ONLY a path already resolved
 * by the caller (opts.policyPath - a CLI flag / env resolved by the dispatcher)
 * or the GSD_OWNER_POLICY env var or the fixed .planning/owner-policy.json
 * default is accepted. A caller-supplied path MUST stay inside the project root;
 * a path from prompt/description text has no route into this function.
 *
 * The default policy file is resolved against the CANONICAL GIT WORKTREE ROOT,
 * never the raw supplied cwd. A direct writer handed a nested cwd (e.g.
 * `<root>/src`) must not silently fall back to audit just because no
 * `owner-policy.json` sits under the nested directory: the policy that governs
 * the resolved owner root is the one that applies, and the resolved context
 * already reports `owner.root` as the root. `root` may be supplied by a caller
 * that already resolved identity (avoids a second git call); otherwise it is
 * resolved here. Non-git cwd degrades to cwd, preserving today's behaviour.
 */
export function resolveOwnerPolicyPath(
  cwd: string,
  candidate?: string | null,
  options: { root?: string | null; deps?: OwnerContextDeps } = {},
): { path: string; trusted: boolean } {
  let root = options.root ?? null;
  if (root === null) {
    try {
      const identity = resolveRepoIdentity(cwd, options.deps ?? {});
      root = identity.real_root ?? identity.root ?? cwd;
    } catch {
      root = cwd;
    }
  }
  const explicit = typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  const fromEnv = (process.env[OWNER_POLICY_ENV] ?? '').trim() || null;
  const chosen = explicit ?? fromEnv;
  if (!chosen) {
    return { path: path.join(root, OWNER_POLICY_RELATIVE_PATH), trusted: true };
  }
  const resolved = path.isAbsolute(chosen) ? path.resolve(chosen) : path.resolve(cwd, chosen);
  const contained = tryWithinRoot(resolved, root, PathAcceptance.AbsoluteInsideRoot);
  if (contained) return { path: contained, trusted: true };
  return { path: resolved, trusted: false };
}

function validatePolicyObject(raw: unknown): { policy: OwnerPolicy; reasons: string[] } {
  const reasons: string[] = [];
  if (!isPlainObject(raw)) {
    return { policy: { ...OWNER_POLICY_DEFAULT }, reasons: ['policy is not a JSON object'] };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_POLICY_KEYS.has(key)) reasons.push('unknown policy key: ' + key);
  }
  const merged: OwnerPolicy = { ...OWNER_POLICY_DEFAULT };
  if (typeof raw['policy_version'] !== 'string') {
    reasons.push('policy_version must be a string');
  } else if (raw['policy_version'] !== OWNER_POLICY_VERSION) {
    reasons.push('unsupported policy_version: ' + raw['policy_version'] + ' (expected ' + OWNER_POLICY_VERSION + ')');
  } else {
    merged.policy_version = raw['policy_version'];
  }
  if (raw['mode'] === OWNER_POLICY_MODE.AUDIT || raw['mode'] === OWNER_POLICY_MODE.ENFORCE) {
    merged.mode = raw['mode'];
  } else {
    reasons.push('mode must be audit or enforce');
  }
  if (raw['known_owners'] !== undefined) {
    if (Array.isArray(raw['known_owners'])) {
      const entries: OwnerPolicy['known_owners'] = [];
      for (const entry of raw['known_owners'] as unknown[]) {
        if (!isPlainObject(entry)) { reasons.push('known_owners entries must be objects'); continue; }
        for (const key of Object.keys(entry)) {
          if (!POLICY_OWNER_KEYS.has(key)) reasons.push('unknown known_owners entry key: ' + key);
        }
        const e: { repo_id?: string; remote?: string; root?: string } = {};
        for (const key of ['repo_id', 'remote', 'root'] as const) {
          const value = entry[key];
          if (value === undefined) continue;
          if (typeof value !== 'string') { reasons.push('known_owners entry.' + key + ' must be a string'); continue; }
          if (value.trim()) e[key] = value.trim();
        }
        if (Object.keys(e).length === 0) {
          reasons.push('known_owners entries must name at least one of repo_id/remote/root');
        }
        entries.push(e);
      }
      merged.known_owners = entries;
    } else {
      reasons.push('known_owners must be an array');
    }
  }
  const boolKeys = ['allow_standalone_quick', 'allow_operational', 'require_workflow_link', 'allow_dirty', 'require_owner_for_mutation'] as const;
  for (const boolKey of boolKeys) {
    const value = raw[boolKey];
    if (value === undefined) continue;
    if (typeof value === 'boolean') merged[boolKey] = value;
    else reasons.push(boolKey + ' must be a boolean');
  }
  // Cutover invariant: enforce is only meaningful with a non-empty canonical
  // owner registry. An empty registry would let ownerMatchesPolicy's
  // "no owners configured" branch silently pass every repo, which is exactly
  // the "never silently quick" bypass this contract exists to close.
  if (merged.mode === OWNER_POLICY_MODE.ENFORCE && merged.known_owners.length === 0) {
    reasons.push('enforce mode requires a non-empty known_owners registry');
  }
  return { policy: merged, reasons };
}

export interface LoadOwnerPolicyOptions {
  policyPath?: string | null;
  deps?: OwnerContextDeps;
  /** Pre-resolved canonical worktree root (skips a second git resolution). */
  root?: string | null;
}

/** Canonical worktree root for policy ownership; cwd when not a git worktree. */
function canonicalOwnerRoot(cwd: string, deps: OwnerContextDeps = {}): string {
  try {
    const identity = resolveRepoIdentity(cwd, deps);
    return identity.real_root ?? identity.root ?? cwd;
  } catch {
    return cwd;
  }
}

/**
 * Load the explicit trusted-local policy JSON. A genuinely ABSENT default path
 * is the documented audit default. Anything else that is not a valid audit
 * policy fails closed: a present-but-unreadable file, a malformed/truncated
 * body, an invalid schema, or an explicitly named path that escapes the root
 * all set requested_enforce, so the gate blocks instead of decaying to audit.
 * Never throws.
 */
export function loadOwnerPolicy(cwd: string, options: LoadOwnerPolicyOptions = {}): OwnerPolicyLoadResult {
  const explicit = Boolean(
    (typeof options.policyPath === 'string' && options.policyPath.trim())
    || ((process.env[OWNER_POLICY_ENV] ?? '').trim()),
  );
  const root = options.root ?? canonicalOwnerRoot(cwd, options.deps ?? {});
  const resolved = resolveOwnerPolicyPath(cwd, options.policyPath ?? null, { root, deps: options.deps });
  if (!resolved.trusted) {
    // An explicitly named path that escapes the project root cannot be honoured.
    return {
      policy: { ...OWNER_POLICY_DEFAULT },
      source: resolved.path,
      present: true,
      ok: false,
      reasons: ['policy path escapes the project root'],
      explicit: true,
      requested_enforce: true,
    };
  }
  if (!fs.existsSync(resolved.path)) {
    if (explicit) {
      // An EXPLICITLY named policy that does not exist is a configuration
      // error, not "no policy" - it must not silently fall back to audit and
      // bypass an operator's intent to enforce.
      return {
        policy: { ...OWNER_POLICY_DEFAULT },
        source: resolved.path,
        present: false,
        ok: false,
        reasons: ['explicitly requested policy file is missing: ' + resolved.path],
        explicit,
        requested_enforce: true,
      };
    }
    // Genuinely absent IMPLICIT default policy - audit is preserved.
    return { policy: { ...OWNER_POLICY_DEFAULT }, source: null, present: false, ok: true, reasons: [], explicit, requested_enforce: false };
  }
  // Symlink confinement: a present policy file whose realpath escapes the
  // project root (e.g. a symlink to another checkout) is refused.
  {
    const contained = tryWithinRoot(resolved.path, root, PathAcceptance.AbsoluteInsideRoot);
    if (!contained) {
      return {
        policy: { ...OWNER_POLICY_DEFAULT },
        source: resolved.path,
        present: true,
        ok: false,
        reasons: ['policy path resolves outside the project root (symlink escape)'],
        explicit,
        requested_enforce: true,
      };
    }
  }
  let raw: string;
  try {
    raw = fs.readFileSync(resolved.path, 'utf8');
  } catch (err) {
    // Present but unreadable - the mode is unknowable, so fail closed.
    return {
      policy: { ...OWNER_POLICY_DEFAULT },
      source: resolved.path,
      present: true,
      ok: false,
      reasons: ['policy exists but is unreadable: ' + (err as Error).message],
      explicit,
      requested_enforce: true,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      policy: { ...OWNER_POLICY_DEFAULT },
      source: resolved.path,
      present: true,
      ok: false,
      reasons: ['policy is not valid JSON: ' + (err as Error).message],
      explicit,
      requested_enforce: true,
    };
  }
  const validated = validatePolicyObject(parsed);
  const ok = validated.reasons.length === 0;
  // A present policy only yields audit when it is a SCHEMA-VALID audit policy.
  // Any invalid present file, and a valid enforce file, fail closed.
  const requestedEnforce = !ok || (isPlainObject(parsed) && parsed['mode'] === OWNER_POLICY_MODE.ENFORCE);
  return {
    policy: validated.policy,
    source: resolved.path,
    present: true,
    ok,
    reasons: validated.reasons,
    explicit,
    requested_enforce: requestedEnforce,
  };
}

// --- Executable task descriptor ---------------------------------------------

/**
 * Parse an untrusted descriptor object into the executable contract. An EXPLICIT
 * workflow kind is required - a missing kind is a reason, never a silent
 * operational fallback (that is the "never silently quick / operational"
 * invariant). Under enforce the gate additionally requires a pinned owner and a
 * HEAD + planning-fingerprint snapshot.
 */
const DESCRIPTOR_KEYS = new Set(['task_id', 'owner', 'planning', 'workflow', 'expected', 'writable_scopes', 'affected_repos', 'dependencies', 'provenance']);
const DESCRIPTOR_OWNER_KEYS = new Set(['repo_id', 'remote', 'root']);
const DESCRIPTOR_PLANNING_KEYS = new Set(['project', 'workstream']);
const DESCRIPTOR_WORKFLOW_KEYS = new Set(['kind', 'phase', 'plan', 'parent_plan', 'rationale']);
const DESCRIPTOR_EXPECTED_KEYS = new Set(['head', 'planning_fingerprint', 'link_fingerprint', 'scope_fingerprint', 'dirty']);

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, label: string, reasons: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) reasons.push('unknown ' + label + ' key: ' + key);
  }
}

/** Strict string-or-absent: a non-string (number/object/array) is a reason, never coerced. */
function strictStringOrNull(obj: Record<string, unknown>, key: string, label: string, reasons: string[]): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    reasons.push(label + '.' + key + ' must be a string or null');
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function strictStringArray(obj: Record<string, unknown>, key: string, label: string, reasons: string[]): string[] {
  const value = obj[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    reasons.push(label + '.' + key + ' must be an array of non-empty strings');
    return [];
  }
  return value.map((entry) => (entry as string).trim());
}

/**
 * Parse an untrusted descriptor into the executable contract with a STRICT,
 * closed schema: unknown keys and wrong types are reasons (never coerced), and
 * a missing/unknown workflow kind is an explicit reason. Absence is a
 * completeness concern handled under enforce, not a silent default here.
 */
export function parseTaskDescriptor(raw: unknown): { descriptor: OwnerTaskDescriptor | null; reasons: string[] } {
  if (!isPlainObject(raw)) return { descriptor: null, reasons: ['descriptor is not a JSON object'] };
  const reasons: string[] = [];
  rejectUnknownKeys(raw, DESCRIPTOR_KEYS, 'descriptor', reasons);

  let owner: OwnerTaskDescriptor['owner'] = null;
  if (raw['owner'] !== undefined) {
    if (!isPlainObject(raw['owner'])) {
      reasons.push('descriptor.owner must be an object');
    } else {
      rejectUnknownKeys(raw['owner'], DESCRIPTOR_OWNER_KEYS, 'owner', reasons);
      const parsed: NonNullable<OwnerTaskDescriptor['owner']> = {};
      for (const key of ['repo_id', 'remote', 'root'] as const) {
        const value = raw['owner'][key];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') { reasons.push('owner.' + key + ' must be a string'); continue; }
        if (value.trim()) parsed[key] = value.trim();
      }
      owner = parsed;
    }
  }

  let planning: PlanningBinding | null = null;
  if (raw['planning'] !== undefined) {
    if (!isPlainObject(raw['planning'])) {
      reasons.push('descriptor.planning must be an object');
    } else {
      rejectUnknownKeys(raw['planning'], DESCRIPTOR_PLANNING_KEYS, 'planning', reasons);
      planning = {
        project: strictStringOrNull(raw['planning'], 'project', 'planning', reasons),
        workstream: strictStringOrNull(raw['planning'], 'workstream', 'planning', reasons),
      };
    }
  }

  const validKinds = Object.values(OWNER_WORKFLOW_KIND) as string[];
  let workflow = resolveWorkflow({});
  if (raw['workflow'] === undefined) {
    reasons.push('descriptor.workflow is required; state an explicit workflow kind (' + validKinds.join('|') + ')');
  } else if (!isPlainObject(raw['workflow'])) {
    reasons.push('descriptor.workflow must be an object');
  } else {
    rejectUnknownKeys(raw['workflow'], DESCRIPTOR_WORKFLOW_KEYS, 'workflow', reasons);
    const kindRaw = raw['workflow']['kind'];
    if (kindRaw === undefined) {
      reasons.push('descriptor must state an explicit workflow kind (' + validKinds.join('|') + ')');
    } else if (typeof kindRaw !== 'string' || !validKinds.includes(kindRaw)) {
      reasons.push('descriptor.workflow.kind must be one of ' + validKinds.join('|'));
    }
    workflow = resolveWorkflow({
      kind: typeof kindRaw === 'string' ? (kindRaw as OwnerWorkflowKind) : null,
      phase: strictStringOrNull(raw['workflow'], 'phase', 'workflow', reasons),
      plan: strictStringOrNull(raw['workflow'], 'plan', 'workflow', reasons),
      parentPlan: strictStringOrNull(raw['workflow'], 'parent_plan', 'workflow', reasons),
      rationale: strictStringOrNull(raw['workflow'], 'rationale', 'workflow', reasons),
    });
  }

  const expected: OwnerContextExpected = {};
  if (raw['expected'] !== undefined) {
    if (!isPlainObject(raw['expected'])) {
      reasons.push('descriptor.expected must be an object');
    } else {
      rejectUnknownKeys(raw['expected'], DESCRIPTOR_EXPECTED_KEYS, 'expected', reasons);
      const head = strictStringOrNull(raw['expected'], 'head', 'expected', reasons);
      const planningFp = strictStringOrNull(raw['expected'], 'planning_fingerprint', 'expected', reasons);
      const linkFp = strictStringOrNull(raw['expected'], 'link_fingerprint', 'expected', reasons);
      const scopeFp = strictStringOrNull(raw['expected'], 'scope_fingerprint', 'expected', reasons);
      if (head) expected.head = head;
      if (planningFp) expected.planning_fingerprint = planningFp;
      if (linkFp) expected.link_fingerprint = linkFp;
      if (scopeFp) expected.scope_fingerprint = scopeFp;
      const dirtyValue = raw['expected']['dirty'];
      if (dirtyValue !== undefined) {
        if (typeof dirtyValue !== 'boolean') reasons.push('expected.dirty must be a boolean');
        else expected.dirty = dirtyValue;
      }
    }
  }

  const descriptor: OwnerTaskDescriptor = {
    task_id: strictStringOrNull(raw, 'task_id', 'descriptor', reasons),
    owner,
    planning,
    workflow,
    expected,
    writable_scopes: strictStringArray(raw, 'writable_scopes', 'descriptor', reasons),
    affected_repos: strictStringArray(raw, 'affected_repos', 'descriptor', reasons),
    dependencies: strictStringArray(raw, 'dependencies', 'descriptor', reasons),
    provenance: strictStringOrNull(raw, 'provenance', 'descriptor', reasons),
  };
  return { descriptor, reasons };
}

function descriptorFromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  const get = (key: string): string | null => {
    const value = (env[key] ?? '').trim();
    return value ? value : null;
  };
  const list = (key: string): string[] | undefined => {
    const value = get(key);
    return value === null ? undefined : value.split(',').map((entry) => entry.trim()).filter(Boolean);
  };
  const kind = get(OWNER_DESCRIPTOR_ENV.WORKFLOW);
  const repoId = get(OWNER_DESCRIPTOR_ENV.REPO_ID);
  const remote = get(OWNER_DESCRIPTOR_ENV.REMOTE);
  const root = get(OWNER_DESCRIPTOR_ENV.ROOT);
  const head = get(OWNER_DESCRIPTOR_ENV.EXPECT_HEAD);
  const fingerprint = get(OWNER_DESCRIPTOR_ENV.EXPECT_FINGERPRINT);
  const linkFingerprint = get(OWNER_DESCRIPTOR_ENV.EXPECT_LINK_FINGERPRINT);
  const scopeFingerprint = get(OWNER_DESCRIPTOR_ENV.EXPECT_SCOPE_FINGERPRINT);
  const taskId = get(OWNER_DESCRIPTOR_ENV.TASK_ID);
  const writableScopes = list(OWNER_DESCRIPTOR_ENV.WRITABLE_SCOPES);
  if (!kind && !repoId && !remote && !root && !head && !fingerprint && !taskId && !writableScopes) return null;
  const dirtyRaw = get(OWNER_DESCRIPTOR_ENV.EXPECT_DIRTY);
  const dirty = dirtyRaw === null ? undefined : dirtyRaw === 'false' ? false : dirtyRaw === 'true' ? true : undefined;
  return {
    task_id: taskId,
    owner: { repo_id: repoId ?? undefined, remote: remote ?? undefined, root: root ?? undefined },
    // The env form always carries a planning binding: empty project/workstream
    // means the ROOT scope, which is a deliberate pin, not an omission.
    planning: { project: get(OWNER_DESCRIPTOR_ENV.PROJECT), workstream: get(OWNER_DESCRIPTOR_ENV.WORKSTREAM) },
    workflow: {
      kind,
      phase: get(OWNER_DESCRIPTOR_ENV.PHASE),
      plan: get(OWNER_DESCRIPTOR_ENV.PLAN),
      parent_plan: get(OWNER_DESCRIPTOR_ENV.PARENT_PLAN),
      rationale: get(OWNER_DESCRIPTOR_ENV.RATIONALE),
    },
    expected: {
      head: head ?? undefined,
      planning_fingerprint: fingerprint ?? undefined,
      link_fingerprint: linkFingerprint ?? undefined,
      scope_fingerprint: scopeFingerprint ?? undefined,
      dirty,
    },
    writable_scopes: writableScopes,
    affected_repos: list(OWNER_DESCRIPTOR_ENV.AFFECTED_REPOS),
    dependencies: list(OWNER_DESCRIPTOR_ENV.DEPENDENCIES),
    provenance: get(OWNER_DESCRIPTOR_ENV.PROVENANCE),
  };
}

export interface LoadTaskDescriptorOptions {
  descriptor?: OwnerTaskDescriptor | Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the executable descriptor from (in order) an in-process descriptor,
 * a GSD_OWNER_DESCRIPTOR JSON file confined to the project root, or the flat
 * GSD_OWNER_* env vars. Never throws; an absent descriptor is present:false and
 * the gate decides whether that is fatal (enforce) or ignored (audit).
 */
export function loadTaskDescriptor(cwd: string, options: LoadTaskDescriptorOptions = {}): OwnerTaskDescriptorLoad {
  const env = options.env ?? process.env;
  let raw: unknown = options.descriptor ?? null;
  let source: string | null = raw ? 'in-process' : null;
  if (!raw) {
    const fileEnv = (env[OWNER_DESCRIPTOR_ENV.FILE] ?? '').trim();
    if (fileEnv) {
      const resolved = resolveOwnerPolicyPath(cwd, fileEnv);
      if (!resolved.trusted) {
        return { descriptor: null, present: false, valid: false, reasons: ['descriptor path escapes the project root'], source: resolved.path };
      }
      try {
        raw = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
        source = resolved.path;
      } catch (err) {
        return { descriptor: null, present: true, valid: false, reasons: ['descriptor is not valid JSON: ' + (err as Error).message], source: resolved.path };
      }
    } else {
      raw = descriptorFromEnv(env);
      if (raw) source = 'env';
    }
  }
  if (!raw) return { descriptor: null, present: false, valid: false, reasons: [], source: null };
  const parsed = parseTaskDescriptor(raw);
  return { descriptor: parsed.descriptor, present: true, valid: parsed.reasons.length === 0, reasons: parsed.reasons, source };
}

// --- Semantic validation ----------------------------------------------------

function ownerMatchesPolicy(owner: RepoIdentity, policy: OwnerPolicy): boolean {
  // An empty registry only passes in audit. Under enforce it must never be a
  // silent allow-all: loadOwnerPolicy already rejects enforce+empty as invalid,
  // and this branch keeps a directly-constructed enforce policy fail-closed too.
  if (policy.known_owners.length === 0) return policy.mode !== OWNER_POLICY_MODE.ENFORCE;
  return policy.known_owners.some((entry) => refSatisfiedByOwner(owner, entry));
}

function sameRealPath(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    return fs.realpathSync.native(a) === b;
  } catch {
    return path.resolve(a) === b;
  }
}

/**
 * Whether a `{repo_id, remote, root}` reference is satisfied by the live owner.
 * EVERY supplied field must match — a reference that names a known repo_id but
 * a different root (or vice versa) does not match, so a conflicting reference
 * can never broaden authorization by matching on just one of its fields.
 */
function refSatisfiedByOwner(owner: RepoIdentity, ref: { repo_id?: string; remote?: string; root?: string }): boolean {
  const repoId = (owner.repo_id ?? '').toLowerCase();
  const ownerRemote = canonicalRepoId(owner.remote);
  const realRoot = owner.real_root ?? owner.root ?? '';
  let supplied = false;
  if (ref.repo_id) {
    supplied = true;
    if (ref.repo_id.toLowerCase() !== repoId) return false;
  }
  if (ref.remote) {
    supplied = true;
    const want = canonicalRepoId(ref.remote);
    if (!want || want !== ownerRemote) return false;
  }
  if (ref.root) {
    supplied = true;
    if (!sameRealPath(ref.root, realRoot)) return false;
  }
  return supplied;
}

function workflowKindAllowed(workflow: WorkflowDescriptor, policy: OwnerPolicy): boolean {
  switch (workflow.kind) {
    case OWNER_WORKFLOW_KIND.PHASE:
    case OWNER_WORKFLOW_KIND.LINKED_QUICK:
      // The referenced plan/parent artifact is resolved and existence-checked
      // separately; here we only confirm the kind itself is permitted.
      return true;
    case OWNER_WORKFLOW_KIND.STANDALONE_QUICK:
      return policy.allow_standalone_quick ? Boolean(workflow.rationale) : false;
    case OWNER_WORKFLOW_KIND.OPERATIONAL:
      // Operational work requires an AFFIRMATIVE rationale regardless of the
      // require_workflow_link knob — a silent operational run is not authorized.
      return policy.allow_operational ? Boolean(workflow.rationale) : false;
    default:
      // `unresolved` (and anything unknown) is never allowed to mutate.
      return false;
  }
}

/**
 * Missing-field reasons for an enforce-bound descriptor. Each required field
 * (worktree root binding + identity, planning scope binding, task id,
 * provenance, explicit workflow kind, expected head + planning fingerprint) that
 * is absent is named, so an incomplete descriptor is refused field-by-field and
 * never accepted on a subset.
 */
function descriptorCompletenessReasons(descriptor: OwnerTaskDescriptor): string[] {
  const missing: string[] = [];
  if (!descriptor.task_id) missing.push('descriptor.task_id is required under enforce');
  if (!descriptor.owner) {
    missing.push('descriptor.owner is required under enforce');
  } else {
    if (!descriptor.owner.root) missing.push('descriptor.owner.root (worktree root binding) is required under enforce');
    if (!descriptor.owner.repo_id && !descriptor.owner.remote) missing.push('descriptor.owner must name repo_id or remote');
  }
  if (!descriptor.planning) missing.push('descriptor.planning (project/workstream scope binding) is required under enforce');
  if (descriptor.writable_scopes.length === 0) missing.push('descriptor.writable_scopes must name at least one owned write scope');
  if (!descriptor.expected.head) missing.push('descriptor.expected.head is required under enforce');
  if (!descriptor.expected.planning_fingerprint) missing.push('descriptor.expected.planning_fingerprint is required under enforce');
  if (!descriptor.expected.scope_fingerprint) missing.push('descriptor.expected.scope_fingerprint is required under enforce');
  if (!descriptor.provenance) missing.push('descriptor.provenance is required under enforce');
  const kind = descriptor.workflow.kind;
  if (kind === OWNER_WORKFLOW_KIND.UNRESOLVED) {
    missing.push('descriptor.workflow.kind is unresolved; state an explicit phase|linked-quick|standalone-quick|operational');
  } else if (!(Object.values(OWNER_WORKFLOW_KIND) as string[]).includes(kind)) {
    missing.push('descriptor.workflow.kind is required under enforce');
  }
  // A rationale is required wherever the workflow has no resolvable plan link.
  if ((kind === OWNER_WORKFLOW_KIND.OPERATIONAL || kind === OWNER_WORKFLOW_KIND.STANDALONE_QUICK) && !descriptor.workflow.rationale) {
    missing.push('descriptor.workflow.rationale is required for ' + kind + ' work');
  }
  return missing;
}

export interface ValidateOwnerContextOptions {
  policy?: OwnerPolicy;
  expected?: OwnerContextExpected;
  descriptor?: OwnerTaskDescriptor | null;
  /** When true (the gate's enforce path), a missing descriptor is MISSING. */
  requireDescriptor?: boolean;
  /** Concrete write targets to bind to the descriptor's writable scopes. */
  targets?: readonly string[];
}

/**
 * Semantic validation. Schema validity is necessary but not sufficient - this
 * verifies real identity membership, workflow linkage, and fingerprint freshness
 * (expected at handoff). Under enforce the caller must also pass a task
 * descriptor (requireDescriptor) pinning the owner/workflow/snapshot, so a bare
 * local resolution never self-authorises.
 */
export function validateOwnerContext(ctx: OwnerContextV1, options: ValidateOwnerContextOptions = {}): OwnershipVerdict {
  const policy = options.policy ?? OWNER_POLICY_DEFAULT;
  const reasons: string[] = [];

  if (!ctx.owner.inside || !ctx.owner.root || !ctx.owner.head) {
    return { ok: false, verdict: OWNER_CONTEXT_VERDICT.UNRESOLVED, reasons: ['cwd is not inside a resolvable git worktree'] };
  }
  const descriptor = options.descriptor ?? null;
  if (options.requireDescriptor) {
    if (!descriptor) {
      return {
        ok: false,
        verdict: OWNER_CONTEXT_VERDICT.MISSING,
        reasons: ['enforce requires an executable task descriptor (owner + planning + workflow + expected snapshot); none was supplied'],
      };
    }
    const missing = descriptorCompletenessReasons(descriptor);
    if (missing.length > 0) return { ok: false, verdict: OWNER_CONTEXT_VERDICT.MISSING, reasons: missing };
  }
  // A descriptor owner pins WHICH owner this run is for - it must agree with the
  // resolved identity, and cannot name an owner the policy does not know.
  if (descriptor && descriptor.owner && !ownerMatchesDescriptor(ctx.owner, descriptor.owner)) {
    return {
      ok: false,
      verdict: OWNER_CONTEXT_VERDICT.WRONG_OWNER,
      reasons: ['resolved identity does not match the descriptor owner '
        + [descriptor.owner.repo_id, descriptor.owner.remote, descriptor.owner.root].filter(Boolean).join(' / ')],
    };
  }
  if (!ownerMatchesPolicy(ctx.owner, policy)) {
    return { ok: false, verdict: OWNER_CONTEXT_VERDICT.WRONG_OWNER, reasons: ['repo ' + (ctx.owner.repo_id ?? '<unknown>') + ' is not a known owner'] };
  }
  // Scoped planning binding must match the resolved scope exactly.
  if (descriptor && descriptor.planning
    && (descriptor.planning.project !== ctx.planning.project || descriptor.planning.workstream !== ctx.planning.workstream)) {
    return {
      ok: false,
      verdict: OWNER_CONTEXT_VERDICT.STALE,
      reasons: ['descriptor planning scope (' + (descriptor.planning.project ?? '<root>') + '/' + (descriptor.planning.workstream ?? '-')
        + ') does not match the resolved scope (' + (ctx.planning.project ?? '<root>') + '/' + (ctx.planning.workstream ?? '-') + ')'],
    };
  }
  // Bind concrete write targets to the caller's owned scopes. A descriptor
  // that names one scope cannot authorize a write somewhere else; planning
  // roots must be listed explicitly. Reported in audit; refused under enforce.
  if (options.targets && options.targets.length > 0) {
    const authorization = authorizeOwnerTargets(ctx.owner.root, descriptor?.writable_scopes ?? [], options.targets);
    if (!authorization.ok) {
      return { ok: false, verdict: OWNER_CONTEXT_VERDICT.MISSING, reasons: authorization.reasons };
    }
  }
  const workflow = descriptor?.workflow ?? ctx.workflow;
  // Resolve the referenced artifact inside the scope: escapes, sibling paths,
  // and non-existent targets refuse rather than pass on a non-empty string.
  const link = resolveWorkflowLink(ctx.planning, workflow, ctx.owner.root);
  if (options.requireDescriptor && link.required && !link.path) {
    return { ok: false, verdict: OWNER_CONTEXT_VERDICT.MISSING, reasons: [link.reason ?? 'workflow link is not resolvable'] };
  }
  const expected: OwnerContextExpected | undefined = descriptor?.expected && Object.keys(descriptor.expected).length > 0
    ? descriptor.expected
    : options.expected;
  if (options.requireDescriptor && link.required && expected && !expected.link_fingerprint) {
    return {
      ok: false,
      verdict: OWNER_CONTEXT_VERDICT.MISSING,
      reasons: ['descriptor.expected.link_fingerprint is required for a workflow with a referenced plan'],
    };
  }
  // Explicit writable-scope content snapshot. Computed from the real bytes on
  // disk (NOT `git status`), so an edit to an already-dirty tracked file, an
  // untracked file appearing, or one being deleted all move the fingerprint —
  // none of which HEAD/porcelain status would reveal. Unreadable or
  // budget-truncated scopes refuse rather than authorize.
  let scopeSnapshot: ScopeFingerprintResult | null = null;
  if (descriptor && descriptor.writable_scopes.length > 0) {
    scopeSnapshot = scopeFingerprint(ctx.owner.root, descriptor.writable_scopes);
    if (!scopeSnapshot.ok) {
      return {
        ok: false,
        verdict: options.requireDescriptor ? OWNER_CONTEXT_VERDICT.MISSING : OWNER_CONTEXT_VERDICT.STALE,
        reasons: ['writable scope snapshot is not readable/bounded: ' + scopeSnapshot.reasons.join('; ')],
      };
    }
  }
  if (expected) {
    if (expected.head && ctx.owner.head !== expected.head) {
      reasons.push('HEAD moved: expected ' + expected.head + ', found ' + ctx.owner.head);
    }
    if (expected.planning_fingerprint && ctx.fingerprint.planning !== expected.planning_fingerprint) {
      reasons.push('planning fingerprint changed');
    }
    if (expected.link_fingerprint && link.path && ctx.fingerprint.link !== expected.link_fingerprint) {
      reasons.push('referenced plan link fingerprint changed');
    }
    if (expected.scope_fingerprint && scopeSnapshot && scopeSnapshot.fingerprint !== expected.scope_fingerprint) {
      reasons.push('writable scope content changed (scope fingerprint mismatch)');
    }
    if (expected.dirty !== undefined && (ctx.fingerprint.dirty.length > 0) !== expected.dirty) {
      reasons.push('dirty snapshot mismatch: expected dirty=' + expected.dirty + ', found ' + ctx.fingerprint.dirty.length + ' changed file(s)');
    }
    if (reasons.length > 0) return { ok: false, verdict: OWNER_CONTEXT_VERDICT.STALE, reasons };
  }
  if (!policy.allow_dirty && ctx.fingerprint.dirty.length > 0) {
    return { ok: false, verdict: OWNER_CONTEXT_VERDICT.STALE, reasons: ['worktree is dirty (' + ctx.fingerprint.dirty.length + ' file(s))'] };
  }
  if (!workflowKindAllowed(workflow, policy)) {
    return { ok: false, verdict: OWNER_CONTEXT_VERDICT.MISSING, reasons: ['workflow ' + workflow.kind + ' lacks its required plan/rationale link'] };
  }
  return { ok: true, verdict: OWNER_CONTEXT_VERDICT.OK, reasons: [] };
}

/** True when `owner` (live identity) satisfies a descriptor's pinned owner ref. */
function ownerMatchesDescriptor(owner: RepoIdentity, ref: { repo_id?: string; remote?: string; root?: string }): boolean {
  return refSatisfiedByOwner(owner, ref);
}

// --- Gate (mandatory boundaries) --------------------------------------------
// --- Mutating-command classification (dispatch gate) ------------------------

/**
 * The single source of truth for "does this invocation mutate planning/state?"
 * is the command-alias registry (src/command-aliases.cts) — the SAME table the
 * family routers consume. Deriving the classifier from it means a new writer
 * verb is classified the moment its registry row lands, and a new ALIAS cannot
 * slip past the dispatch gate by not being named in a second, hand-maintained
 * list. scripts/check-alias-drift.cjs and the mutating-classification drift
 * test in tests/owner-context.unit.test.cjs keep the two from diverging.
 *
 * Row shapes handled:
 *  - family rows (`state.update`, subcommand `update`): keyed by the canonical
 *    family prefix + subcommand.
 *  - non-family rows: the invocation is the canonical with its first dot
 *    replaced by a space (`frontmatter.set` -> `frontmatter set`,
 *    `commit-docs-guard.enable` -> `commit-docs-guard enable`), or a bare
 *    top-level command (`config-set`, `commit`). Each declared alias is also
 *    registered, so a space-separated alias cannot bypass the classification.
 */
interface MutationTables {
  /** family -> subcommand -> mutating */
  families: Map<string, Map<string, boolean>>;
  /** top-level command -> mutating */
  commands: Map<string, boolean>;
  /** family -> subcommand -> conditional-mutation flags (mutating only when present) */
  familyFlags: Map<string, Map<string, string[]>>;
  /** top-level command -> conditional-mutation flags */
  commandFlags: Map<string, string[]>;
  /** family -> subcommand -> read-only opt-out flags (mutating UNLESS present) */
  familyReadOnlyFlags: Map<string, Map<string, string[]>>;
  /** top-level command -> read-only opt-out flags */
  commandReadOnlyFlags: Map<string, string[]>;
}

/** One row of the command-alias registry (src/command-aliases.cts). */
interface AliasRow {
  canonical: string;
  aliases: string[];
  subcommand?: string;
  mutation: boolean;
  mutationFlags?: string[];
  readOnlyFlags?: string[];
}

function registerInvocation(tables: MutationTables, tokens: readonly string[], mutating: boolean, mutationFlags: readonly string[] = [], readOnlyFlags: readonly string[] = []): void {
  if (tokens.length === 0) return;
  if (tokens.length === 1) {
    // A top-level command never becomes non-mutating just because a later row
    // says so; any mutating form wins.
    const current = tables.commands.get(tokens[0]);
    tables.commands.set(tokens[0], (current ?? false) || mutating);
    if (mutationFlags.length > 0) {
      const merged = new Set([...(tables.commandFlags.get(tokens[0]) ?? []), ...mutationFlags]);
      tables.commandFlags.set(tokens[0], [...merged]);
    }
    if (readOnlyFlags.length > 0) {
      const merged = new Set([...(tables.commandReadOnlyFlags.get(tokens[0]) ?? []), ...readOnlyFlags]);
      tables.commandReadOnlyFlags.set(tokens[0], [...merged]);
    }
    return;
  }
  let family = tables.families.get(tokens[0]);
  if (!family) {
    family = new Map<string, boolean>();
    tables.families.set(tokens[0], family);
  }
  family.set(tokens[1], (family.get(tokens[1]) ?? false) || mutating);
  if (mutationFlags.length > 0) {
    let flagFamily = tables.familyFlags.get(tokens[0]);
    if (!flagFamily) {
      flagFamily = new Map<string, string[]>();
      tables.familyFlags.set(tokens[0], flagFamily);
    }
    flagFamily.set(tokens[1], [...new Set([...(flagFamily.get(tokens[1]) ?? []), ...mutationFlags])]);
  }
  if (readOnlyFlags.length > 0) {
    let roFamily = tables.familyReadOnlyFlags.get(tokens[0]);
    if (!roFamily) {
      roFamily = new Map<string, string[]>();
      tables.familyReadOnlyFlags.set(tokens[0], roFamily);
    }
    roFamily.set(tokens[1], [...new Set([...(roFamily.get(tokens[1]) ?? []), ...readOnlyFlags])]);
  }
}

function registerRow(tables: MutationTables, canonical: string, aliases: readonly string[], mutating: boolean, mutationFlags: readonly string[] = [], readOnlyFlags: readonly string[] = []): void {
  registerInvocation(tables, canonical.split('.'), mutating, mutationFlags, readOnlyFlags);
  for (const alias of aliases) {
    registerInvocation(tables, alias.split(' '), mutating, mutationFlags, readOnlyFlags);
  }
}

function buildMutationTables(): MutationTables {
  const tables: MutationTables = {
    families: new Map(),
    commands: new Map(),
    familyFlags: new Map(),
    commandFlags: new Map(),
    familyReadOnlyFlags: new Map(),
    commandReadOnlyFlags: new Map(),
  };
  // Family rows: canonical `<family>.<subcommand>`, one per router subcommand.
  const registry = commandAliasesModule as unknown as Record<string, AliasRow[]>;
  for (const tableName of FAMILY_ALIAS_TABLES) {
    for (const row of registry[tableName] ?? []) {
      registerInvocation(tables, [row.canonical.split('.')[0], row.subcommand ?? row.canonical], row.mutation, row.mutationFlags ?? [], row.readOnlyFlags ?? []);
      for (const alias of row.aliases ?? []) registerInvocation(tables, alias.split(' '), row.mutation, row.mutationFlags ?? [], row.readOnlyFlags ?? []);
    }
  }
  for (const row of commandAliasesModule.NON_FAMILY_COMMAND_ALIASES as unknown as AliasRow[]) {
    registerRow(tables, row.canonical, row.aliases ?? [], row.mutation, row.mutationFlags ?? [], row.readOnlyFlags ?? []);
  }
  return tables;
}

const FAMILY_ALIAS_TABLES: readonly string[] = Object.freeze([
  'STATE_COMMAND_ALIASES',
  'VERIFY_COMMAND_ALIASES',
  'INIT_COMMAND_ALIASES',
  'PHASE_COMMAND_ALIASES',
  'PHASES_COMMAND_ALIASES',
  'VALIDATE_COMMAND_ALIASES',
  'ROADMAP_COMMAND_ALIASES',
  'QUICK_BATCH_COMMAND_ALIASES',
  'EVAL_COMMAND_ALIASES',
]);

const MUTATION_TABLES: MutationTables = buildMutationTables();

/**
 * Backwards-compatible, read-only projections of the derived tables. The
 * classifier no longer branches on a hand-maintained literal list; these are
 * exported only so an existing importer keeps working during the transition.
 */
export const MUTATING_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    [...MUTATION_TABLES.families.entries()].map(([family, subs]) => [
      family,
      Object.freeze([...subs.entries()].filter(([, mutating]) => mutating).map(([sub]) => sub)),
    ]),
  ),
);

export const MUTATING_COMMANDS: readonly string[] = Object.freeze([
  ...[...MUTATION_TABLES.commands.entries()].filter(([, mutating]) => mutating).map(([command]) => command),
]);

/** True when this invocation mutates planning/state (used by the dispatch gate). */
export function isMutatingCommand(command: string, args: readonly string[]): boolean {
  if (typeof command !== 'string' || !command) return false;
  const sub = typeof args[1] === 'string' ? args[1] : '';
  const family = MUTATION_TABLES.families.get(command);
  const baseMutating = family ? family.get(sub) === true : MUTATION_TABLES.commands.get(command) === true;
  // Read-only opt-outs (e.g. `state prune --dry-run`): the invocation writes
  // nothing when one of these flags is present, so it must never be gated.
  const readOnly = [
    ...(MUTATION_TABLES.familyReadOnlyFlags.get(command)?.get(sub) ?? []),
    ...(family ? [] : (MUTATION_TABLES.commandReadOnlyFlags.get(command) ?? [])),
  ];
  if (readOnly.some((flag) => args.includes(flag))) return false;
  if (baseMutating) return true;
  // Conditional writers (e.g. `effort sync --apply`) mutate only when a
  // declared flag is actually present, so a dry run keeps read-only behaviour.
  const conditional = [
    ...(MUTATION_TABLES.familyFlags.get(command)?.get(sub) ?? []),
    ...(family ? [] : (MUTATION_TABLES.commandFlags.get(command) ?? [])),
  ];
  return conditional.some((flag) => args.includes(flag));
}


export interface OwnerContextGateOptions extends BuildOwnerContextOptions {
  policyPath?: string | null;
  expected?: OwnerContextExpected;
  /** In-process executable descriptor; otherwise resolved from the env contract. */
  descriptor?: OwnerTaskDescriptor | null;
  /** Concrete write targets; otherwise read from GSD_OWNER_TARGETS. */
  targets?: readonly string[];
  /** Env source for the descriptor (tests inject; defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The single gate every mandatory boundary calls. Never throws. enforcing is
 * true when a present, VALID policy file selects enforce OR a present file
 * DECLARES enforce but fails its schema (fail-closed). An absent policy, or a
 * present audit-mode policy, leaves current behaviour. Under enforce a task
 * descriptor is required - a bare local resolution never self-authorises.
 */
export function ownerContextGate(cwd: string, options: OwnerContextGateOptions = {}): OwnerContextGateResult {
  // A nested write inside an already-authorized operation is not a new entry:
  // the operation's entry gate already validated the descriptor against the
  // pre-mutation snapshot. Re-running the freshness comparison here -- after
  // the operation has legitimately changed that snapshot -- would refuse a
  // fully-authorized multi-file write half-applied (see withOwnedOperation).
  const nested = nestedOwnedOperationResult(cwd, options);
  if (nested) return nested;
  const policyLoad = loadOwnerPolicy(cwd, { policyPath: options.policyPath ?? null, deps: options.deps });
  const descriptorLoad = loadTaskDescriptor(cwd, {
    descriptor: options.descriptor ?? null,
    env: options.env ?? process.env,
  });
  const descriptor = descriptorLoad.descriptor;
  // Build the context with the DESCRIPTOR's workflow when one is present, so
  // the fingerprint's link binding reflects the artifact the run actually
  // references (a phase PLAN / linked parent), not the resolve-default kind.
  const context = buildOwnerContext(cwd, {
    ...options,
    kind: descriptor?.workflow.kind ?? options.kind,
    phase: descriptor?.workflow.phase ?? options.phase,
    plan: descriptor?.workflow.plan ?? options.plan,
    parentPlan: descriptor?.workflow.parent_plan ?? options.parentPlan,
    rationale: descriptor?.workflow.rationale ?? options.rationale,
    policy: policyLoad,
  });
  const enforcing = policyLoad.ok
    ? policyLoad.present && policyLoad.policy.mode === OWNER_POLICY_MODE.ENFORCE
    : policyLoad.requested_enforce;

  if (!policyLoad.ok) {
    return {
      mode: policyLoad.policy.mode,
      enforcing,
      ok: false,
      verdict: OWNER_CONTEXT_VERDICT.INVALID_POLICY,
      reasons: policyLoad.reasons.length > 0 ? policyLoad.reasons : ['owner policy is invalid'],
      policy: policyLoad.policy,
      policy_source: policyLoad.source,
      descriptor,
      context,
    };
  }
  if (enforcing && descriptorLoad.present && !descriptorLoad.valid) {
    return {
      mode: policyLoad.policy.mode,
      enforcing: true,
      ok: false,
      verdict: OWNER_CONTEXT_VERDICT.MISSING,
      reasons: descriptorLoad.reasons,
      policy: policyLoad.policy,
      policy_source: policyLoad.source,
      descriptor: null,
      context,
    };
  }
  // Concrete write targets: in-process, or the GSD_OWNER_TARGETS env list a
  // dispatch adapter declares before it writes.
  const envTargetsRaw = ((options.env ?? process.env)[OWNER_DESCRIPTOR_ENV.TARGETS] ?? '').trim();
  const targets = options.targets && options.targets.length > 0
    ? [...options.targets]
    : (envTargetsRaw ? envTargetsRaw.split(',').map((entry) => entry.trim()).filter(Boolean) : []);
  const verdict = validateOwnerContext(context, {
    policy: policyLoad.policy,
    expected: options.expected,
    descriptor,
    requireDescriptor: enforcing,
    targets,
  });
  return {
    mode: policyLoad.policy.mode,
    enforcing,
    ok: verdict.ok,
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    policy: policyLoad.policy,
    policy_source: policyLoad.source,
    descriptor,
    context,
  };
}

/** Typed refusal so a caller can map it to error(...) with a stable reason. */
export class OwnerContextRefusal extends Error {
  readonly verdict: OwnerContextVerdict;
  readonly reasons: readonly string[];
  constructor(verdict: OwnerContextVerdict, reasons: readonly string[]) {
    super('owner context refused (' + verdict + '): ' + (reasons.join('; ') || 'no reason recorded'));
    this.name = 'OwnerContextRefusal';
    this.verdict = verdict;
    this.reasons = reasons;
  }
}

/**
 * An authorized multi-file operation. Some commands bind ALL of their concrete
 * targets once at entry and then perform several writes — a phase-directory
 * delete, sibling renames, a ROADMAP rewrite, a STATE.md read-modify-write —
 * some of which are themselves gated writers. The entry gate validates the
 * descriptor against the snapshot that existed BEFORE the operation ran;
 * re-running that freshness comparison for a nested write, AFTER the operation
 * has legitimately changed the very snapshot it was checked against, would
 * refuse a fully-authorized operation and leave it half-applied (review
 * 2026-10-10: `phase remove --force` deleted the phase, rewrote ROADMAP.md,
 * then exited 1 stale_context without touching STATE.md).
 *
 * `withOwnedOperation` records the target set the entry gate authorized for the
 * duration of a synchronous call frame. While it is active a nested gate call
 * still binds the nested target to the operation's authorized set — a nested
 * write OUTSIDE the targets the entry gate approved is still refused — but it
 * does NOT re-compare the head/planning/scope snapshot the operation is itself
 * mutating. This is NOT a bypass flag: the entry gate must pass with a complete
 * descriptor before the scope opens, it only relaxes the freshness re-check,
 * and the scope is popped in a finally so it cannot leak past the operation.
 */
interface AuthorizedOperation {
  /** Canonical worktree root the entry gate resolved. */
  root: string;
  /** Identity of the descriptor that authorized the operation (audit aid). */
  descriptorKey: string | null;
  /** The entry gate result (its context/policy are reused for nested results). */
  entry: OwnerContextGateResult;
  /** Absolute targets bound at entry — the operation's authorized write set. */
  targetsAbs: readonly string[];
  /** The policy source the entry gate used; a nested call cannot switch it. */
  policySource: string | null;
}

const OPERATION_STACK: AuthorizedOperation[] = [];

/** Stable identity of a descriptor, used only to distinguish concurrent ops. */
function descriptorIdentity(descriptor: OwnerTaskDescriptor | null): string | null {
  if (!descriptor) return null;
  return [
    descriptor.task_id ?? '-',
    descriptor.owner?.root ?? '-',
    descriptor.expected?.head ?? '-',
    descriptor.expected?.planning_fingerprint ?? '-',
    descriptor.expected?.scope_fingerprint ?? '-',
    (descriptor.writable_scopes ?? []).join('|'),
  ].join('\u0000');
}

/** The innermost active operation whose root matches this cwd's worktree. */
function currentOwnedOperation(cwd: string): AuthorizedOperation | null {
  if (OPERATION_STACK.length === 0) return null;
  let realRoot: string | null;
  try {
    const identity = resolveRepoIdentity(cwd);
    realRoot = identity.real_root ?? identity.root;
  } catch {
    return null;
  }
  if (!realRoot) return null;
  for (let i = OPERATION_STACK.length - 1; i >= 0; i--) {
    if (OPERATION_STACK[i].root === realRoot) return OPERATION_STACK[i];
  }
  return null;
}

/** True when `abs` is `scope` itself or sits lexically inside it. */
function targetInside(abs: string, scope: string): boolean {
  if (abs === scope) return true;
  return tryWithinRootLexical(abs, scope) !== null;
}

/**
 * The gate result for a nested write inside an active authorized operation, or
 * null when no operation is active (the caller is at a real entry boundary).
 */
function nestedOwnedOperationResult(cwd: string, options: OwnerContextGateOptions): OwnerContextGateResult | null {
  const op = currentOwnedOperation(cwd);
  if (!op) return null;
  // A nested call cannot switch the governing policy out from under the
  // operation it belongs to.
  const explicitPolicy = typeof options.policyPath === 'string' && options.policyPath.trim() ? path.resolve(options.policyPath) : null;
  if (explicitPolicy && op.policySource && explicitPolicy !== path.resolve(op.policySource)) {
    return {
      ...op.entry,
      ok: false,
      verdict: OWNER_CONTEXT_VERDICT.MISSING,
      reasons: ['nested write cannot switch the owner policy of its authorized operation'],
    };
  }
  const envTargetsRaw = ((options.env ?? process.env)[OWNER_DESCRIPTOR_ENV.TARGETS] ?? '').trim();
  const nestedTargets = options.targets && options.targets.length > 0
    ? [...options.targets]
    : (envTargetsRaw ? envTargetsRaw.split(',').map((entry) => entry.trim()).filter(Boolean) : []);
  if (nestedTargets.length === 0) {
    // No new target requested: the operation already authorized its write set.
    return { ...op.entry, ok: true, verdict: OWNER_CONTEXT_VERDICT.OK, reasons: [] };
  }
  const reasons: string[] = [];
  for (const target of nestedTargets) {
    const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(op.root, target);
    const authorized = op.targetsAbs.some((scope) => targetInside(abs, scope));
    if (!authorized) {
      reasons.push('nested write target is outside the authorized operation set: ' + target);
      continue;
    }
    const ancestor = nearestExistingAncestorReal(abs);
    if (!ancestor || !tryWithinRoot(ancestor, op.root, PathAcceptance.AbsoluteInsideRoot)) {
      reasons.push('nested write target resolves outside the worktree root: ' + target);
    }
  }
  if (reasons.length > 0) {
    return { ...op.entry, ok: false, verdict: OWNER_CONTEXT_VERDICT.MISSING, reasons };
  }
  return { ...op.entry, ok: true, verdict: OWNER_CONTEXT_VERDICT.OK, reasons: [] };
}

/**
 * Open an authorized operation around a synchronous multi-file mutation. Runs
 * the FULL entry gate for the complete target set (refusing before any write),
 * then executes `fn` with the nested-write relaxation active, popping the
 * scope in a finally. In audit mode it is a transparent pass-through.
 */
export function withOwnedOperation<T>(
  cwd: string,
  targets: readonly string[],
  fn: () => T,
  options: OwnerContextGateOptions = {},
): T {
  const result = ownerContextGate(cwd, { ...options, targets });
  if (result.enforcing && !result.ok) {
    throw new OwnerContextRefusal(result.verdict, result.reasons);
  }
  if (!result.enforcing) return fn();
  const root = result.context.owner.real_root ?? result.context.owner.root ?? cwd;
  const targetsAbs = targets.map((target) => (path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target)));
  const op: AuthorizedOperation = {
    root,
    descriptorKey: descriptorIdentity(result.descriptor),
    entry: result,
    targetsAbs,
    policySource: result.policy_source,
  };
  OPERATION_STACK.push(op);
  try {
    return fn();
  } finally {
    const idx = OPERATION_STACK.lastIndexOf(op);
    if (idx >= 0) OPERATION_STACK.splice(idx, 1);
  }
}

/**
 * THE single mandatory semantic gate for every mutating boundary. Under enforce
 * any non-ok context — missing/underspecified descriptor, wrong owner, stale
 * snapshot, invalid policy — refuses with an OwnerContextRefusal BEFORE any
 * mutation. There is no knob that disables this: `require_owner_for_mutation`
 * is retained only as a schema-compatible field and no longer weakens the gate.
 * In audit mode it always returns the resolved result unchanged.
 */
export function assertOwnerContextForWrite(cwd: string, options: OwnerContextGateOptions = {}): OwnerContextGateResult {
  const result = ownerContextGate(cwd, options);
  if (result.enforcing && !result.ok) {
    throw new OwnerContextRefusal(result.verdict, result.reasons);
  }
  return result;
}

/**
 * Stable, JSON-serialisable preflight outcome for a boundary that wants to
 * know whether a mutation WOULD be authorized before it starts (a runtime
 * adapter's mkdir/Edit/spawn path). It never throws and never authorizes a
 * mutation by itself — an absent/ignored descriptor does not create ownership;
 * it only reports the gate's current verdict under the configured policy.
 */
export interface OwnerContextPreflight {
  ok: boolean;
  mode: OwnerPolicyMode;
  enforcing: boolean;
  verdict: OwnerContextVerdict;
  reasons: string[];
  policy_source: string | null;
  descriptor_present: boolean;
  descriptor_valid: boolean;
  owner: { repo_id: string | null; root: string | null };
  planning: { project: string | null; workstream: string | null; mode: PlanningScope['mode'] };
  workflow: { kind: OwnerWorkflowKind; resolved: boolean };
  expected: {
    head: string | null;
    planning_fingerprint: string | null;
    link_fingerprint: string | null;
    scope_fingerprint: string | null;
  };
  /** Explicit writable scopes the descriptor named (empty when none). */
  writable_scopes: string[];
  /** Concrete write targets validated against the scopes (empty when none). */
  targets: string[];
  targets_authorized: boolean;
}

export function preflightOwnerContext(cwd: string, options: OwnerContextGateOptions = {}): OwnerContextPreflight {
  const gate = ownerContextGate(cwd, options);
  const descriptorLoad = loadTaskDescriptor(cwd, { descriptor: options.descriptor ?? null, env: options.env ?? process.env });
  return {
    ok: gate.ok,
    mode: gate.mode,
    enforcing: gate.enforcing,
    verdict: gate.verdict,
    reasons: gate.reasons,
    policy_source: gate.policy_source,
    descriptor_present: descriptorLoad.present,
    descriptor_valid: descriptorLoad.descriptor ? descriptorLoad.valid : false,
    owner: { repo_id: gate.context.owner.repo_id, root: gate.context.owner.root },
    planning: { project: gate.context.planning.project, workstream: gate.context.planning.workstream, mode: gate.context.planning.mode },
    workflow: {
      kind: gate.context.workflow.kind,
      resolved: gate.context.workflow.kind !== OWNER_WORKFLOW_KIND.UNRESOLVED,
    },
    expected: {
      head: descriptorLoad.descriptor?.expected.head ?? null,
      planning_fingerprint: descriptorLoad.descriptor?.expected.planning_fingerprint ?? null,
      link_fingerprint: descriptorLoad.descriptor?.expected.link_fingerprint ?? null,
      scope_fingerprint: descriptorLoad.descriptor?.expected.scope_fingerprint ?? null,
    },
    writable_scopes: descriptorLoad.descriptor?.writable_scopes ?? [],
    targets: (() => {
      const raw = ((options.env ?? process.env)[OWNER_DESCRIPTOR_ENV.TARGETS] ?? '').trim();
      return options.targets && options.targets.length > 0 ? [...options.targets] : (raw ? raw.split(',').map((entry) => entry.trim()).filter(Boolean) : []);
    })(),
    targets_authorized: !gate.reasons.some((reason) => /outside the declared writable scopes|outside the worktree root/.test(reason)),
  };
}

// --- Additive init-envelope integration -------------------------------------

/**
 * The additive owner_context field folded into init envelopes. Total: a
 * resolution failure yields a null-owner context rather than throwing, so a
 * read-only init never fails because of an ownership probe. In enforce mode the
 * caller still consults ownerContextGate before a mutation.
 */
export function ownerContextEnvelopeField(cwd: string, options: OwnerContextGateOptions = {}): OwnerContextV1 {
  try {
    return buildOwnerContext(cwd, options);
  } catch {
    return buildOwnerContext(cwd, { ...options, deps: { ...(options.deps ?? {}), execGit: () => ({ exitCode: 1, stdout: '' }) } });
  }
}

// --- Additive record --------------------------------------------------------

export const OWNER_CONTEXT_PUBLISH_REASON = Object.freeze({
  PUBLISHED: 'published',
  NO_PLANNING_DIR: 'no_planning_dir',
  WRITE_FAILED: 'write_failed',
});

/**
 * Publish the resolved context to .planning/owner-context.json - an ADDITIVE
 * artifact, never .planning/state.json (the frozen six-key contract). Never
 * throws; no .planning/ directory means nothing is written or created.
 */
export function publishOwnerContext(cwd: string, options: OwnerContextGateOptions = {}): { published: boolean; reason: string } {
  try {
    const paths = planningPathsOf(cwd);
    if (!paths || !fs.existsSync(paths.planning)) {
      return { published: false, reason: OWNER_CONTEXT_PUBLISH_REASON.NO_PLANNING_DIR };
    }
    const context = ownerContextEnvelopeField(cwd, options);
    const target = path.join(paths.planning, 'owner-context.json');
    const tmp = target + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify(context, null, 2) + '\n');
      retryRenameSync(tmp, target);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* nothing to remove */ }
      return { published: false, reason: OWNER_CONTEXT_PUBLISH_REASON.WRITE_FAILED };
    }
    return { published: true, reason: OWNER_CONTEXT_PUBLISH_REASON.PUBLISHED };
  } catch {
    return { published: false, reason: OWNER_CONTEXT_PUBLISH_REASON.WRITE_FAILED };
  }
}

