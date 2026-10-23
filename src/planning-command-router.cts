/**
 * Planning command router — CLI subcommand dispatcher for `gsd-tools planning`.
 *
 * Routes `planning inspect` (#2790) to `planningInspect.cmdPlanningInspect`.
 * Both the spaced form (`query planning inspect`) and the dotted canonical form
 * (`query planning.inspect`) reach here identically: `gsd-tools` splits a dotted
 * command on its FIRST dot before dispatch, so the router never sees the dot.
 *
 * v1 accepts NO arguments beyond the subcommand. `--raw`, `--cwd`, `--pick`,
 * `--default` and `--json-errors` are global and are spliced out of argv by
 * `gsd-tools`' own `main()` before any router runs, so anything still present at
 * `args[2]` or beyond is genuinely unrecognised and is a fail-loud USAGE error.
 * That strictness is deliberate: silently ignoring an argument a caller believed
 * was scoping the query would return a full-project snapshot presented as a
 * scoped one — a confidently wrong answer.
 *
 * Router signature `{ args, cwd, raw, error }` — identical to the other host
 * routers. Test seam: pass `_planningInspect` to inject a recording mock; the
 * `_` prefix follows this repo's established seam convention.
 *
 * ADR-457 build-at-publish: source in src/planning-command-router.cts, compiled
 * to gsd-core/bin/lib/planning-command-router.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningInspect = require('./planning-inspect.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');

const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const { ERROR_REASON, output } = io;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PlanningInspectModule {
  cmdPlanningInspect(cwd: string, raw: boolean): void;
}

interface RoutePlanningCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  /** Test seam: inject a mock planning-inspect module. Defaults to the real one. */
  _planningInspect?: PlanningInspectModule;
  /** Test seam: capture what `planning dir` emits. Defaults to io.output. */
  _output?: (value: unknown, raw: boolean, rawValue?: unknown) => void;
}

// ─── Implementation ───────────────────────────────────────────────────────────

const PLANNING_SUBCOMMANDS = ['inspect', 'dir'];

function routePlanningCommand({ args, cwd, raw, error, _planningInspect, _output }: RoutePlanningCommandOptions): void {
  const mod: PlanningInspectModule = _planningInspect ?? planningInspect;
  const emit = _output ?? output;

  routeCjsCommandFamily({
    args,
    subcommands: PLANNING_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_subcommand: string, available: string[]) =>
      `Unknown planning subcommand. Available: ${available.join(', ')}`,
    handlers: {
      inspect: () => {
        const extra = args.slice(2);
        if (extra.length > 0) {
          const offender = extra[0];
          const shape = offender.startsWith('-') ? 'flag' : 'positional argument';
          error(
            `planning inspect takes no arguments; got ${shape}: ${offender}. ` +
              'Usage: gsd-tools query planning inspect',
            ERROR_REASON.USAGE,
          );
          return;
        }
        mod.cmdPlanningInspect(cwd, raw);
      },
      // The scoped planning directory a workflow fence should use instead of a literal
      // `.planning/`: `dir` holds ROADMAP/STATE/REQUIREMENTS/phases (project and
      // workstream scoped); `project_dir` holds PROJECT.md and research (project scoped).
      dir: () => {
        if (args.length > 2) {
          error(`planning dir takes no arguments; got: ${args[2]}. Usage: gsd-tools query planning dir`, ERROR_REASON.USAGE);
          return;
        }
        const dir = planningWorkspace.planningDir(cwd);
        const projectDir = planningWorkspace.planningDir(cwd, null);
        // Relative to the GSD project root (where `.planning/` literals were anchored), for
        // prompts read from another checkout such as a worktree executor.
        const rel = (p: string) => path.relative(cwd, p).split(path.sep).join('/');
        emit({
          dir,
          project_dir: projectDir,
          dir_rel: rel(dir),
          project_dir_rel: rel(projectDir),
          project: process.env['GSD_PROJECT']?.trim() || null,
          workstream: process.env['GSD_WORKSTREAM']?.trim() || null,
        }, raw, dir);
      },
    },
  });
}

export = {
  routePlanningCommand,
  PLANNING_SUBCOMMANDS,
};
