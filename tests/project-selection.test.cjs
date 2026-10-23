/**
 * Named-project selection — `--project`, `project set|get|list`, and the
 * /gsd-new-project fields that let a second project live beside the root one
 * in `.planning/<name>/` without touching the root project's files.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGsdTools, createTempGitProject, cleanup, toPosixPath } = require('./helpers.cjs');
const { runGit } = require('./helpers/process-seam.cjs');
const { QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

function json(result) {
  assert.ok(result.success, `gsd-tools failed: ${result.error || result.output}`);
  return JSON.parse(result.output);
}

describe('named-project selection', () => {
  let tmpDir;
  let session;
  // CLAUDECODE is blanked so a test run inside Claude Code does not anchor every call to the host CLI.
  const hermetic = { CLAUDECODE: '' };
  const run = (args, env = {}) => runGsdTools(args, tmpDir, { ...hermetic, GSD_SESSION_KEY: session, ...env });
  const planning = (...segments) => toPosixPath(path.join(fs.realpathSync(tmpDir), '.planning', ...segments));

  beforeEach(() => {
    tmpDir = createTempGitProject('gsd-project-sel-');
    session = `project-sel-${crypto.randomBytes(6).toString('hex')}`;
  });

  afterEach(() => {
    run(['query', 'project.set', '--clear']);
    cleanup(tmpDir);
  });

  test('without a selection, new-project reports the existing root project', () => {
    const init = json(run(['query', 'init.new-project']));
    assert.equal(init.project_exists, true);
    assert.equal(init.planning_project, null);
    assert.equal(toPosixPath(init.research_dir), planning('research'));
  });

  test('--project scopes every new-project path to .planning/<name>/ for that call only', () => {
    const init = json(run(['query', 'init.new-project', '--project', 'beta']));
    assert.equal(init.project_exists, false);
    assert.equal(init.planning_project, 'beta');
    assert.equal(toPosixPath(init.project_path), planning('beta', 'PROJECT.md'));
    assert.equal(toPosixPath(init.roadmap_path), planning('beta', 'ROADMAP.md'));
    assert.equal(toPosixPath(init.state_path), planning('beta', 'STATE.md'));
    assert.equal(toPosixPath(init.research_dir), planning('beta', 'research'));

    assert.equal(json(run(['query', 'project.get'])).active, null);
  });

  test('project set persists for the session, from subdirectories too, but not for other sessions', () => {
    assert.equal(json(run(['query', 'project.set', 'beta'])).active, 'beta');
    assert.equal(json(run(['query', 'init.new-project'])).planning_project, 'beta');

    fs.mkdirSync(path.join(tmpDir, 'src', 'nested'), { recursive: true });
    const fromSubdir = runGsdTools(['query', 'project.get'], path.join(tmpDir, 'src', 'nested'), { ...hermetic, GSD_SESSION_KEY: session });
    assert.equal(json(fromSubdir).active, 'beta');

    assert.equal(json(run(['query', 'project.get'], { GSD_SESSION_KEY: `${session}-other` })).active, null);

    run(['query', 'project.set', '--clear']);
    assert.equal(json(run(['query', 'project.get'])).active, null);
  });

  test('a linked worktree with its own tracked .planning/ resolves the session project', () => {
    const wt = `${tmpDir}-wt`;
    runGit(['add', '-A'], { cwd: tmpDir });
    runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'planning', '--allow-empty'], { cwd: tmpDir });
    assert.equal(runGit(['worktree', 'add', '-q', '-b', 'exec', wt], { cwd: tmpDir }).exitCode, 0, 'fixture: git worktree add');
    try {
      assert.ok(fs.existsSync(path.join(wt, '.planning')), 'fixture: worktree carries its own .planning/');
      run(['query', 'project.set', 'beta']);
      const fromWorktree = runGsdTools(['query', 'project.get'], wt, { ...hermetic, GSD_SESSION_KEY: session });
      assert.equal(json(fromWorktree).active, 'beta');
    } finally {
      runGit(['worktree', 'remove', '--force', wt], { cwd: tmpDir });
    }
  });

  test('a gitignored named project resolves to the main checkout from a linked worktree', () => {
    const wt = `${tmpDir}-wt`;
    fs.mkdirSync(path.join(tmpDir, '.planning', 'beta', 'phases', '01-start'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'beta', 'PROJECT.md'), '# Beta\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'beta', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: Start\n**Goal:** begin\n');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.planning/beta/\n');
    runGit(['add', '-A'], { cwd: tmpDir });
    runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'root planning', '--allow-empty'], { cwd: tmpDir });
    assert.equal(runGit(['worktree', 'add', '-q', '-b', 'exec', wt], { cwd: tmpDir }).exitCode, 0, 'fixture: git worktree add');
    try {
      assert.ok(fs.existsSync(path.join(wt, '.planning')), 'fixture: the root project is tracked');
      assert.ok(!fs.existsSync(path.join(wt, '.planning', 'beta')), 'fixture: beta is ignored, so absent in the worktree');
      const dir = json(runGsdTools(['query', 'planning.dir', '--project', 'beta'], wt, { ...hermetic, GSD_SESSION_KEY: session }));
      assert.equal(toPosixPath(dir.dir), planning('beta'));
      const phase = json(runGsdTools(['query', 'init.execute-phase', '1', '--project', 'beta'], wt, { ...hermetic, GSD_SESSION_KEY: session }));
      assert.equal(phase.phase_found, true);
      // A stray handoff written into the worktree's copy must not hide the main checkout's project.
      fs.mkdirSync(path.join(wt, '.planning', 'beta'), { recursive: true });
      fs.writeFileSync(path.join(wt, '.planning', 'beta', 'HANDOFF.json'), '{}\n');
      const after = json(runGsdTools(['query', 'planning.dir', '--project', 'beta'], wt, { ...hermetic, GSD_SESSION_KEY: session }));
      assert.equal(toPosixPath(after.dir), planning('beta'));
    } finally {
      runGit(['worktree', 'remove', '--force', wt], { cwd: tmpDir });
    }
  });

  test("the root project's workstreams do not put a named project into workstream mode", () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'ws1'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'beta'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'beta', 'PROJECT.md'), '# Beta\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'beta', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'beta', 'STATE.md'), '# State\n');
    const progress = run(['query', 'init.progress', '--project', 'beta']);
    assert.equal(progress.success, true, progress.error);
    assert.equal(json(progress).planning_project, 'beta');
    // A workstream of the named project is found under .planning/<project>/workstreams.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'beta', 'workstreams', 'api'), { recursive: true });
    const status = json(run(['query', 'workstream.status', 'api', '--project', 'beta']));
    assert.notEqual(status.found, false);
  });

  test('config-new-project reports the config file it wrote for a named project', () => {
    const out = json(run(['query', 'config-new-project', JSON.stringify({ mode: 'interactive' }), '--project', 'gamma']));
    assert.equal(out.path, '.planning/gamma/config.json');
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'gamma', 'config.json')));
  });

  test("a named project's workstream inherits that project's config, never the root's", () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ mode: 'yolo' }));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'beta', 'workstreams', 'api'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'beta', 'PROJECT.md'), '# Beta\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'beta', 'config.json'), JSON.stringify({ mode: 'interactive' }));
    const mode = (extra) => run(['query', 'config-get', 'mode', '--raw', ...extra]).output.trim();
    assert.equal(mode(['--project', 'beta', '--ws', 'api']), 'interactive');
    assert.equal(mode([]), 'yolo');
  });

  test('a gitignored named project skips its planning commits instead of failing', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'beta'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'beta', 'PROJECT.md'), '# Beta\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'beta', 'STATE.md'), '# State\n');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.planning/beta/\n');
    const out = json(run(['query', 'commit', 'docs: beta state', '--files', '.planning/beta/STATE.md', '--project', 'beta']));
    assert.equal(out.committed, false);
    assert.equal(out.skipped, true);
  });

  test('project list reports projects that have a PROJECT.md', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'beta'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'beta', 'PROJECT.md'), '# Beta\n');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'notes'), { recursive: true });

    const list = json(run(['query', 'project.list']));
    assert.equal(list.root_project, true);
    assert.deepEqual(list.projects, ['beta']);
  });

  test('rejects names GSD reserves and existing directories that are not projects', () => {
    const reserved = run(['query', 'project.set', 'phases']);
    assert.equal(reserved.success, false);
    assert.match(reserved.error, /reserved/);

    fs.mkdirSync(path.join(tmpDir, '.planning', 'analysis'), { recursive: true });
    const notProject = run(['query', 'project.set', 'analysis']);
    assert.equal(notProject.success, false);
    assert.match(notProject.error, /not a GSD project/);

    const viaFlag = run(['query', 'init.new-project', '--project', 'workstreams']);
    assert.equal(viaFlag.success, false);
    assert.match(viaFlag.error, /reserved/);
  });

  test('a stored root workstream pointer does not leak into a named project', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'feature-a'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'active-workstream'), 'feature-a\n');

    const root = json(run(['query', 'init.new-project']));
    assert.match(toPosixPath(root.roadmap_path), /\/workstreams\/feature-a\/ROADMAP\.md$/);

    const beta = json(run(['query', 'init.new-project', '--project', 'beta']));
    assert.equal(toPosixPath(beta.roadmap_path), planning('beta', 'ROADMAP.md'));
  });

  test("each project keeps its own workstream selection; a named project never clears the root's", () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'ws1'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'beta', 'workstreams', 'api'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'beta', 'PROJECT.md'), '# Beta\n');
    const wsGet = (extra = []) => json(run(['query', 'workstream.get', ...extra])).active;

    run(['query', 'workstream.set', 'ws1']);
    assert.equal(wsGet(), 'ws1');
    assert.equal(wsGet(['--project', 'beta']), null);
    assert.equal(wsGet(), 'ws1', "reading under beta must not clear the root's selection");

    run(['query', 'workstream.set', 'api', '--project', 'beta']);
    assert.equal(wsGet(['--project', 'beta']), 'api');
    assert.equal(wsGet(), 'ws1', "beta's selection must not overwrite the root's");
  });

  test('GSD_PROJECT is held to the same name rules as --project', () => {
    for (const bad of ['phases', '.', '..', '../x']) {
      assert.equal(run(['query', 'project.get'], { GSD_PROJECT: bad }).success, false, `GSD_PROJECT=${bad} must be rejected`);
    }
  });

  const storeRoot = () => path.join(os.tmpdir(), `gsd-project-sessions-${process.getuid()}`);
  const pointerPath = () => {
    const base = storeRoot();
    return fs.readdirSync(base).map((d) => path.join(base, d, `gsd-session-key-${session}`)).find((f) => fs.existsSync(f));
  };

  test('a FIFO or directory at the pointer path never blocks or breaks unrelated commands', { skip: process.platform === 'win32' }, () => {
    const { execFileSync } = require('child_process');
    run(['query', 'project.set', 'beta']);
    const pointer = pointerPath();
    assert.ok(pointer, 'fixture: pointer file written');
    for (const plant of ['fifo', 'dir']) {
      fs.unlinkSync(pointer);
      if (plant === 'fifo') execFileSync('mkfifo', [pointer], { timeout: QUICK_SPAWN_TIMEOUT_MS });
      else fs.mkdirSync(pointer);
      try {
        assert.equal(json(run(['query', 'generate-slug', 'Hello World'])).slug, 'hello-world', plant);
        assert.equal(json(run(['query', 'project.get'])).active, null, plant);
      } finally {
        cleanup(pointer);
      }
      fs.writeFileSync(pointer, 'beta\n');
    }
  });

  test('a store directory other users can write is not read until its owner re-secures it', { skip: process.platform === 'win32' }, () => {
    run(['query', 'project.set', 'beta']);
    const root = storeRoot();
    fs.chmodSync(root, 0o777);
    try {
      assert.equal(json(run(['query', 'project.get'])).active, null);
      assert.equal(json(run(['query', 'project.set', 'beta'])).active, 'beta');
      if (process.platform !== 'win32') assert.equal(fs.statSync(root).mode & 0o777, 0o700);
      assert.equal(json(run(['query', 'project.get'])).active, 'beta');
    } finally {
      fs.chmodSync(root, 0o700);
    }
  });

  test('a selection unused for more than 12 hours lapses', { skip: process.platform === 'win32' }, () => {
    run(['query', 'project.set', 'beta']);
    const stale = new Date(Date.now() - 13 * 60 * 60 * 1000);
    fs.utimesSync(pointerPath(), stale, stale);
    assert.equal(json(run(['query', 'project.get'])).active, null);
  });

  test('planning dir resolves the scoped directories a fence should use', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'ws1'), { recursive: true });
    const root = json(run(['query', 'planning.dir']));
    assert.equal(toPosixPath(root.dir), planning());
    assert.equal(toPosixPath(root.project_dir), planning());
    const named = json(run(['query', 'planning.dir', '--project', 'beta']));
    assert.equal(toPosixPath(named.dir), planning('beta'));
    assert.equal(named.project, 'beta');
    // Repo-relative forms for prompts read from another checkout (worktree executors).
    assert.equal(root.dir_rel, '.planning');
    assert.equal(named.dir_rel, '.planning/beta');
    assert.equal(named.project_dir_rel, '.planning/beta');
    const stream = json(run(['query', 'planning.dir', '--ws', 'ws1']));
    assert.equal(toPosixPath(stream.dir), planning('workstreams', 'ws1'));
    assert.equal(toPosixPath(stream.project_dir), planning());
    assert.equal(stream.dir_rel, '.planning/workstreams/ws1');
    assert.equal(stream.project_dir_rel, '.planning');
  });

  test('progress reports the selected project and the projects beside the root one', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'beta'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'beta', 'PROJECT.md'), '# Beta\n');
    const root = json(run(['query', 'init.progress']));
    assert.equal(root.planning_project, null);
    assert.deepEqual(root.projects, ['beta']);
    assert.equal(json(run(['query', 'init.progress', '--project', 'beta'])).planning_project, 'beta');
  });

  test('project set without a session identity fails instead of selecting nothing', () => {
    const result = run(['query', 'project.set', 'beta'], { GSD_SESSION_KEY: '' });
    assert.equal(result.success, false);
    assert.match(result.error, /No session identity/);
  });

  test('new-milestone reads the selected scope\'s milestones, research and phases', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'MILESTONES.md'), '## v9.9 Root (Shipped: 2026-01-01)\n');
    const beta = path.join(tmpDir, '.planning', 'beta');
    fs.mkdirSync(path.join(beta, 'phases'), { recursive: true });
    fs.writeFileSync(path.join(beta, 'PROJECT.md'), '# Beta\n');
    fs.writeFileSync(path.join(beta, 'MILESTONES.md'), '## v1.0 Beta (Shipped: 2026-02-02)\n');
    const ws = path.join(tmpDir, '.planning', 'workstreams', 'ws1');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'MILESTONES.md'), '## v2.3 Stream (Shipped: 2026-03-03)\n');

    const named = json(run(['query', 'init.new-milestone', '--project', 'beta']));
    assert.equal(named.planning_project, 'beta');
    assert.equal(named.latest_completed_milestone, 'v1.0');
    assert.equal(toPosixPath(named.phase_archive_path), planning('beta', 'milestones', 'v1.0-phases'));
    assert.equal(toPosixPath(named.research_dir), planning('beta', 'research'));
    assert.equal(toPosixPath(named.phases_dir), planning('beta', 'phases'));

    // The archive path follows `milestone complete`, which archives inside the active workstream.
    const stream = json(run(['query', 'init.new-milestone', '--ws', 'ws1']));
    assert.equal(stream.latest_completed_milestone, 'v2.3');
    assert.equal(toPosixPath(stream.phase_archive_path), planning('workstreams', 'ws1', 'milestones', 'v2.3-phases'));

    const root = json(run(['query', 'init.new-milestone']));
    assert.equal(root.planning_project, null);
    assert.equal(root.latest_completed_milestone, 'v9.9');
    assert.equal(toPosixPath(root.phase_archive_path), planning('milestones', 'v9.9-phases'));
    assert.equal(toPosixPath(root.research_dir), planning('research'));
  });

  test('a monorepo sub-project in a linked worktree resolves the session project; the repo root does not', () => {
    const pkg = path.join(tmpDir, 'pkg');
    fs.mkdirSync(path.join(pkg, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(pkg, '.planning', 'PROJECT.md'), '# Pkg\n');
    const wt = `${tmpDir}-mono-wt`;
    runGit(['add', '-A'], { cwd: tmpDir });
    runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'pkg'], { cwd: tmpDir });
    assert.equal(runGit(['worktree', 'add', '-q', '-b', 'mono', wt], { cwd: tmpDir }).exitCode, 0, 'fixture: git worktree add');
    const env = { ...hermetic, GSD_SESSION_KEY: session };
    try {
      json(runGsdTools(['query', 'project.set', 'beta'], pkg, env));
      assert.equal(json(runGsdTools(['query', 'project.get'], path.join(wt, 'pkg'), env)).active, 'beta');
      assert.equal(json(run(['query', 'project.get'])).active, null);
      runGsdTools(['query', 'project.set', '--clear'], pkg, env);
    } finally {
      runGit(['worktree', 'remove', '--force', wt], { cwd: tmpDir });
    }
  });

  test("a gitignored named project in a monorepo sub-project resolves to the main checkout's sub-project", () => {
    const pkg = path.join(tmpDir, 'pkg');
    fs.mkdirSync(path.join(pkg, '.planning', 'beta'), { recursive: true });
    fs.writeFileSync(path.join(pkg, '.planning', 'PROJECT.md'), '# Pkg\n');
    fs.writeFileSync(path.join(pkg, '.planning', 'beta', 'PROJECT.md'), '# Beta\n');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'pkg/.planning/beta/\n');
    const wt = `${tmpDir}-mono-ign-wt`;
    runGit(['add', '-A'], { cwd: tmpDir });
    runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'pkg'], { cwd: tmpDir });
    assert.equal(runGit(['worktree', 'add', '-q', '-b', 'mono-ign', wt], { cwd: tmpDir }).exitCode, 0, 'fixture: git worktree add');
    try {
      assert.ok(!fs.existsSync(path.join(wt, 'pkg', '.planning', 'beta')), 'fixture: beta is ignored, so absent in the worktree');
      const dir = json(runGsdTools(['query', 'planning.dir', '--project', 'beta'], path.join(wt, 'pkg'), { ...hermetic, GSD_SESSION_KEY: session }));
      assert.equal(toPosixPath(dir.dir), toPosixPath(path.join(fs.realpathSync(pkg), '.planning', 'beta')));
    } finally {
      runGit(['worktree', 'remove', '--force', wt], { cwd: tmpDir });
    }
  });
});

// Workflows, agents and references are executed verbatim. A literal root path for a
// scoped artifact writes the root project's files while a named project (or a
// workstream) is selected, which is how a second project used to overwrite the first.
// Scoped paths come from init fields ({state_path}, {roadmap_path}, {phase_dir}, ...)
// or `gsd_run query planning.dir` (`dir`, `project_dir`). ALLOW lists the root-level
// uses that are correct on purpose.
describe('runtime prose names scoped planning artifacts through their resolved paths', () => {
  const ROOT = path.join(__dirname, '..');
  // Artifacts that belong to one project (or workstream). Repo-level directories (todos, debug,
  // codebase, intel, seeds, threads, ...) stay at the root on purpose and are not listed.
  const SCOPED = /\.planning\/(research\b|ROADMAP\.md|STATE\.md|REQUIREMENTS\.md|PROJECT\.md|config\.json|phases\b|MILESTONES\.md|milestones\b|quick\b|HANDOFF\.json|\.continue-here|v[^/\s`]*-MILESTONE-AUDIT\.md|INGEST-CONFLICTS\.md|DECISIONS-INDEX\.md|RETROSPECTIVE\.md|reports\/MILESTONE_SUMMARY)/;
  const ALLOW = fs.readdirSync(path.join(__dirname, 'fixtures/project-scoped-path-allowlist'))
    .flatMap((f) => require(`./fixtures/project-scoped-path-allowlist/${f}`));

  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []);
  }
  // Everything an agent reads as instructions: workflows, references, agents, command bodies,
  // capability fragments and the templates planning documents are generated from (skills/ is
  // generated from commands/).
  const files = ['gsd-core/workflows', 'gsd-core/references', 'gsd-core/templates', 'gsd-core/contexts', 'agents', 'commands/gsd', 'capabilities']
    .flatMap((d) => walk(path.join(ROOT, d)))
    .map((f) => toPosixPath(path.relative(ROOT, f)))
    .sort();

  function allowed(file, line) {
    return ALLOW.some((a) => a.file === file && a.match.test(line));
  }

  // Every line counts: a read instruction, an @-include or a commit bullet aims at the root
  // project just as surely as a fenced command does.
  test('no instruction names a root .planning artifact literally', () => {
    const offenders = [];
    for (const file of files) {
      const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (SCOPED.test(line) && !allowed(file, line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, []);
  });

  test('every command that takes arguments offers --project selection', () => {
    const dir = path.join(ROOT, 'commands', 'gsd');
    const missing = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).filter((f) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      return text.includes('<arguments>$ARGUMENTS</arguments>') && !text.includes('gsd_run query project.set <name>');
    });
    assert.deepEqual(missing, []);
  });

  test('every allowlist entry still matches a line (no stale exceptions)', () => {
    for (const a of ALLOW) {
      const text = fs.readFileSync(path.join(ROOT, a.file), 'utf8');
      assert.ok(text.split(/\r?\n/).some((l) => a.match.test(l)), `stale allowlist entry: ${a.file} ${a.match}`);
    }
  });

  test('every roadmapper spawn passes write targets', () => {
    for (const file of ['gsd-core/workflows/new-project.md', 'gsd-core/workflows/new-milestone.md']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const spawns = text.split('subagent_type="gsd-roadmapper"').length - 1;
      const targets = text.split('<write_targets>').length - 1;
      assert.ok(spawns > 0, `${file}: no roadmapper spawn found`);
      assert.ok(targets >= spawns || /same `<write_targets>` block/.test(text), `${file}: ${spawns} roadmapper spawn(s), ${targets} write-target block(s)`);
    }
  });
});
