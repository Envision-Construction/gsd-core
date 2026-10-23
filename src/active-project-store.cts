/**
 * Active Project Store — selects a named project namespace (`.planning/<project>/`,
 * the GSD_PROJECT dimension of planningDir, #3749) and owns the `project`
 * set/get/list commands.
 *
 * Precedence: CLI --project > GSD_PROJECT env > session-scoped pointer > null (root project).
 *
 * GSD_PROJECT alone cannot carry a selection through a workflow on runtimes
 * whose shell fences are separate processes (Claude Code's Bash tool), so a
 * project chosen by /gsd-new-project was lost on the next `gsd_run` call. The
 * session pointer reuses the workstream session identity, so subagents spawned
 * by the same session resolve the same project.
 *
 * Unlike workstreams there is deliberately NO shared repo-wide marker: a session
 * that never selected a project keeps the root project, so creating a second
 * project can never repoint another session's STATE.md or ROADMAP.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isValidActiveWorkstreamName } from './workstream-name-policy.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import activeWorkstreamStore = require('./active-workstream-store.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output, error } = io;

// Directories GSD writes under the root `.planning/`. A project with one of these
// names would share its directory with the root project's own artifacts.
const RESERVED_PROJECT_NAMES: ReadonlyArray<string> = Object.freeze([
  'archive', 'async-jobs', 'codebase', 'debug', 'deliberations', 'forensics', 'graphs',
  'intel', 'memory', 'milestones', 'notes', 'onboarding', 'phase', 'phases', 'quick',
  'quick-batches', 'reports', 'research', 'seeds', 'sketches', 'spikes', 'threads',
  'tmp', 'todos', 'ui-reviews', 'workstreams',
]);

// A selection unused for this long lapses (see getSessionProject).
const IDLE_SELECTION_TTL_MS = 12 * 60 * 60 * 1000;

function formatError(name: string): string | null {
  if (!isValidActiveWorkstreamName(name) || name.startsWith('.')) {
    return `Invalid project name "${name}": use letters, digits, hyphens, underscores, or dots, not starting with a dot`;
  }
  if (RESERVED_PROJECT_NAMES.includes(name.toLowerCase())) {
    return `Project name "${name}" is reserved: .planning/${name}/ belongs to the root project`;
  }
  return null;
}

function isProjectDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'PROJECT.md')) || fs.existsSync(path.join(dir, 'config.json'));
}

// `project set` also refuses an existing directory that is not a project: adopting
// `.planning/analysis/` would mix a project's artifacts into unrelated files.
function selectionError(cwd: string, name: string): string | null {
  const err = formatError(name);
  if (err) return err;
  const dir = path.join(cwd, '.planning', name);
  if (fs.existsSync(dir) && !isProjectDir(dir)) {
    return `.planning/${name}/ already exists and is not a GSD project (no PROJECT.md or config.json)`;
  }
  return null;
}

// Every worktree of a repository shares one git common dir, so keying on it plus
// the GSD root's path inside the repository lets an executor in an isolated
// worktree (which carries its own tracked .planning/ copy) resolve the project
// its session selected, while separate monorepo sub-projects keep separate keys.
// Outside git, the .planning/ realpath.
function repoIdentity(cwd: string): string {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 32; depth += 1) {
    const dotGit = path.join(dir, '.git');
    try {
      let common: string;
      if (fs.statSync(dotGit).isFile()) {
        const gitDir = path.resolve(dir, fs.readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/, '').trim());
        const commonFile = path.join(gitDir, 'commondir');
        common = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()) : gitDir;
      } else {
        common = dotGit;
      }
      return `${fs.realpathSync.native(common)}\0${path.relative(dir, path.resolve(cwd))}`;
    } catch {
      // no usable .git here; keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    return fs.realpathSync.native(path.join(cwd, '.planning'));
  } catch {
    return path.resolve(cwd, '.planning');
  }
}

// Per-user, owner-only store. On a shared /tmp another user could otherwise pre-create
// the directory and plant pointers (or a FIFO) that redirect or hang this user's commands.
function storeRoot(): string {
  const owner = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return path.join(os.tmpdir(), `gsd-project-sessions-${owner}`);
}

function storeIsTrusted(root: string): boolean {
  try {
    const st = fs.lstatSync(root);
    if (!st.isDirectory()) return false;
    if (typeof process.getuid !== 'function') return true;
    return st.uid === process.getuid() && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function pointerFile(cwd: string): string | null {
  const sessionKey = activeWorkstreamStore.getWorkstreamSessionKey();
  if (!sessionKey) return null;
  const repoId = crypto.createHash('sha1').update(repoIdentity(cwd)).digest('hex').slice(0, 16);
  return path.join(storeRoot(), repoId, sessionKey);
}

// Non-blocking, no-follow read of a small regular file; anything else is "no selection".
function readPointer(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 256) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return buf.toString('utf8').trim() || null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

// A selection is not existence-checked: /gsd-new-project selects a project before its
// directory exists. It lapses after IDLE_SELECTION_TTL_MS without use, so an aborted
// run or a reused terminal key cannot silently redirect a later session.
function getSessionProject(cwd: string): string | null {
  if (!storeIsTrusted(storeRoot())) return null;
  const file = pointerFile(cwd);
  if (!file) return null;
  const name = readPointer(file);
  if (!name || formatError(name)) return null;
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > IDLE_SELECTION_TTL_MS) {
      removePointer(file);
      return null;
    }
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    return null;
  }
  return name;
}

function removePointer(file: string): void {
  try { fs.unlinkSync(file); } catch { /* already clear */ }
  try { fs.rmdirSync(path.dirname(file)); } catch { /* other sessions still selected */ }
}

function setSessionProject(cwd: string, name: string | null): void {
  const file = pointerFile(cwd);
  if (!file) {
    throw new Error('No session identity to scope the selection to (set GSD_SESSION_KEY), or pass --project <name> / GSD_PROJECT per command');
  }
  if (!name) {
    removePointer(file);
    return;
  }
  const err = selectionError(cwd, name);
  if (err) throw new Error(err);
  const root = storeRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // Re-secure a store this user owns but that is open to others (pointers read from it
  // must also be owned by this user, so nothing planted meanwhile is honoured).
  try {
    const st = fs.lstatSync(root);
    if (st.isDirectory() && typeof process.getuid === 'function' && st.uid === process.getuid()) fs.chmodSync(root, 0o700);
  } catch { /* checked below */ }
  if (!storeIsTrusted(root)) throw new Error(`Refusing to use ${root}: it must be a directory owned by you with mode 0700`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, name + '\n', { mode: 0o600 });
}

interface ParsedCliProject {
  value: string | null;
  args: string[];
}

function parseCliProject(args: string[]): ParsedCliProject {
  const eqArg = args.find((arg) => arg.startsWith('--project='));
  if (eqArg) {
    const value = eqArg.slice('--project='.length).trim();
    if (!value) throw new Error('Missing value for --project');
    return { value, args: args.filter((arg) => arg !== eqArg) };
  }
  const idx = args.indexOf('--project');
  if (idx !== -1) {
    const value = args[idx + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --project');
    return { value, args: args.filter((_: string, i: number) => i !== idx && i !== idx + 1) };
  }
  return { value: null, args: args.slice() };
}

interface ResolvedProject {
  project: string | null;
  source: 'cli' | 'env' | 'session' | 'none';
  args: string[];
}

// The bootstrap's resolution for this process, so `project set` can report an env override.
let lastResolvedSource: ResolvedProject['source'] = 'none';

function resolveActiveProject(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): ResolvedProject {
  const resolved = resolveProjectSource(cwd, args, env);
  lastResolvedSource = resolved.source;
  return resolved;
}

function resolveProjectSource(cwd: string, args: string[], env: NodeJS.ProcessEnv): ResolvedProject {
  const parsed = parseCliProject(args);
  if (parsed.value) {
    const err = formatError(parsed.value);
    if (err) throw new Error(err);
    return { project: parsed.value, source: 'cli', args: parsed.args };
  }
  const fromEnv = env['GSD_PROJECT']?.trim();
  if (fromEnv) {
    const err = formatError(fromEnv);
    if (err) throw new Error(`GSD_PROJECT: ${err}`);
    return { project: fromEnv, source: 'env', args: parsed.args };
  }
  const fromSession = getSessionProject(cwd);
  return { project: fromSession, source: fromSession ? 'session' : 'none', args: parsed.args };
}

function listProjects(cwd: string): string[] {
  const planning = path.join(cwd, '.planning');
  try {
    return fs.readdirSync(planning, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !RESERVED_PROJECT_NAMES.includes(d.name.toLowerCase()))
      .filter((d) => fs.existsSync(path.join(planning, d.name, 'PROJECT.md')))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function cmdProjectSet(cwd: string, name: string | undefined, raw: boolean): void {
  if (!name) error('Project name required. Usage: project set <name> (or project set --clear for the root project)');
  const clear = name === '--clear';
  try {
    setSessionProject(cwd, clear ? null : name as string);
  } catch (e) {
    error((e as Error).message);
  }
  const active = clear ? null : name as string;
  const dir = path.join(cwd, '.planning', ...(active ? [active] : []));
  const result: Record<string, unknown> = { active, planning_dir: dir, exists: fs.existsSync(path.join(dir, 'PROJECT.md')) };
  // An explicit GSD_PROJECT outranks the session selection on every later call.
  if (lastResolvedSource === 'env') result['overridden_by_env'] = process.env['GSD_PROJECT'];
  output(result, raw, active || 'root');
}

function cmdProjectGet(cwd: string, raw: boolean): void {
  // The bootstrap already resolved --project / GSD_PROJECT / the session pointer into the env.
  const active = process.env['GSD_PROJECT']?.trim() || null;
  output({
    active,
    exists: active ? fs.existsSync(path.join(cwd, '.planning', active, 'PROJECT.md')) : null,
    root_project: fs.existsSync(path.join(cwd, '.planning', 'PROJECT.md')),
  }, raw, active || 'root');
}

function cmdProjectList(cwd: string, raw: boolean): void {
  const active = process.env['GSD_PROJECT']?.trim() || null;
  output({
    root_project: fs.existsSync(path.join(cwd, '.planning', 'PROJECT.md')),
    projects: listProjects(cwd),
    active,
  }, raw, undefined);
}

export = {
  RESERVED_PROJECT_NAMES,
  parseCliProject,
  resolveActiveProject,
  getSessionProject,
  setSessionProject,
  listProjects,
  cmdProjectSet,
  cmdProjectGet,
  cmdProjectList,
};
