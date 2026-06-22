/**
 * Hub command family router — read-only `hub v1 *` query verbs.
 *
 * Routed via the capability registry's commandFamilies index (ADR-959):
 * capabilities/hub-mode/capability.json declares {family:"hub",
 * module:"hub-command-router.cjs", router:"routeHubCommand"}, and
 * gsd-tools.cjs dispatchCapabilityCommand auto-routes `hub …` here.
 *
 * SYNCHRONOUS by contract: dispatchCapabilityCommand errors if a router returns
 * a Promise (async capability routers are unsupported). All five verbs are
 * read-only (mutation:false) — no lock, no writes.
 *
 * Versioning: requires `hub v1 …`. Unknown version tokens are rejected with an
 * InvalidArgs-style error to reserve a future `v2` namespace.
 *
 * Invocation layout (dispatchCapabilityCommand passes the whole argv tail):
 *   args[0] = 'hub', args[1] = 'v1', args[2] = verb, args[3+] = verb args.
 *
 * Modeled on src/roadmap-command-router.cts.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- hub-query.cjs is an export= CommonJS module
import hubQuery = require('./hub-query.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import ioMod = require('./io.cjs');
const { output } = ioMod;
import { parseNamedArgs } from './command-arg-projection.cjs';

interface RouteHubCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string) => void;
}

const HUB_VERBS = ['milestone', 'phase', 'phases', 'manifest', 'spoke'];

function routeHubCommand({ args, cwd, raw, error }: RouteHubCommandOptions): void {
  const version = args[1];
  if (version !== 'v1') {
    error(`hub: only v1 API supported, got "${version ?? '(none)'}"`);
    return;
  }

  const verb = args[2];
  switch (verb) {
    case 'milestone': {
      const sub = args[3];
      if (sub !== 'current') {
        error(`hub v1 milestone: only 'current' is supported, got "${sub ?? '(none)'}"`);
        return;
      }
      output(hubQuery.getCurrentMilestone(cwd), raw);
      return;
    }
    case 'phase': {
      output(hubQuery.getPhase(cwd, args[3]), raw);
      return;
    }
    case 'phases': {
      const named = parseNamedArgs(args, ['milestone', 'state']);
      output(hubQuery.getPhases(cwd, {
        milestone: (named['milestone'] as string | null) ?? undefined,
        state: (named['state'] as string | null) ?? undefined,
      }), raw);
      return;
    }
    case 'manifest': {
      const named = parseNamedArgs(args, ['tier', 'role']);
      output(hubQuery.getManifest(cwd, {
        tier: (named['tier'] as string | null) ?? undefined,
        role: (named['role'] as string | null) ?? undefined,
      }), raw);
      return;
    }
    case 'spoke': {
      output(hubQuery.getSpoke(cwd, args[3]), raw);
      return;
    }
    default:
      error(`Unknown hub verb "${verb ?? '(none)'}". Available: ${HUB_VERBS.join(', ')}`);
  }
}

export = {
  routeHubCommand,
};
