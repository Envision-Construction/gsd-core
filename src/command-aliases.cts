/**
 * state.*, verify.*, init.*, phase.*, phases.*, validate.*, roadmap.*, and non-family alias/subcommand metadata for CJS routing.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/command-aliases.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

interface CommandAlias {
  canonical: string;
  aliases: string[];
  subcommand: string;
  mutation: boolean;
  /**
   * Conditional writers: the subcommand mutates ONLY when one of these flags is
   * present (e.g. `state prune --dry-run` is read-only and must not require an
   * owner descriptor). Absent means the `mutation` flag is unconditional.
   */
  mutationFlags?: string[];
  /**
   * Read-only opt-outs: the subcommand mutates UNLESS one of these flags is
   * present (e.g. `state prune --dry-run` and `state sync --verify` write
   * nothing and must not require an owner descriptor). The inverse of
   * `mutationFlags`; a row uses at most one of the two.
   */
  readOnlyFlags?: string[];
}

interface NonFamilyCommandAlias {
  canonical: string;
  aliases: string[];
  mutation: boolean;
  /**
   * Conditional writers: the invocation mutates ONLY when one of these flags
   * is present (e.g. `effort sync` is a read-only dry run by default and only
   * writes with `--apply`). Absent means the `mutation` flag is unconditional.
   */
  mutationFlags?: string[];
}

export const STATE_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "state.load",
    "aliases": [],
    "subcommand": "load",
    "mutation": false
  },
  {
    "canonical": "state.json",
    "aliases": [
      "state json"
    ],
    "subcommand": "json",
    "mutation": false
  },
  {
    "canonical": "state.get",
    "aliases": [
      "state get"
    ],
    "subcommand": "get",
    "mutation": false
  },
  {
    "canonical": "state.complete-phase",
    "aliases": [
      "state complete-phase"
    ],
    "subcommand": "complete-phase",
    "mutation": true
  },
  {
    "canonical": "state.update",
    "aliases": [
      "state update"
    ],
    "subcommand": "update",
    "mutation": true
  },
  {
    "canonical": "state.patch",
    "aliases": [
      "state patch"
    ],
    "subcommand": "patch",
    "mutation": true
  },
  {
    "canonical": "state.begin-phase",
    "aliases": [
      "state begin-phase"
    ],
    "subcommand": "begin-phase",
    "mutation": true
  },
  {
    "canonical": "state.advance-plan",
    "aliases": [
      "state advance-plan"
    ],
    "subcommand": "advance-plan",
    "mutation": true
  },
  {
    "canonical": "state.record-metric",
    "aliases": [
      "state record-metric"
    ],
    "subcommand": "record-metric",
    "mutation": true
  },
  {
    "canonical": "state.update-progress",
    "aliases": [
      "state update-progress"
    ],
    "subcommand": "update-progress",
    "mutation": true
  },
  {
    "canonical": "state.add-decision",
    "aliases": [
      "state add-decision"
    ],
    "subcommand": "add-decision",
    "mutation": true
  },
  {
    "canonical": "state.add-blocker",
    "aliases": [
      "state add-blocker"
    ],
    "subcommand": "add-blocker",
    "mutation": true
  },
  {
    "canonical": "state.resolve-blocker",
    "aliases": [
      "state resolve-blocker"
    ],
    "subcommand": "resolve-blocker",
    "mutation": true
  },
  {
    "canonical": "state.record-session",
    "aliases": [
      "state record-session"
    ],
    "subcommand": "record-session",
    "mutation": true
  },
  {
    "canonical": "state.signal-waiting",
    "aliases": [
      "state signal-waiting"
    ],
    "subcommand": "signal-waiting",
    "mutation": true
  },
  {
    "canonical": "state.signal-resume",
    "aliases": [
      "state signal-resume"
    ],
    "subcommand": "signal-resume",
    "mutation": true
  },
  {
    "canonical": "state.planned-phase",
    "aliases": [
      "state planned-phase"
    ],
    "subcommand": "planned-phase",
    "mutation": true
  },
  {
    "canonical": "state.validate",
    "aliases": [
      "state validate"
    ],
    "subcommand": "validate",
    "mutation": false
  },
  {
    "canonical": "state.sync",
    "aliases": [
      "state sync"
    ],
    "subcommand": "sync",
    "mutation": true,
    "readOnlyFlags": [
      "--verify"
    ]
  },
  {
    "canonical": "state.prune",
    "aliases": [
      "state prune"
    ],
    "subcommand": "prune",
    "mutation": true,
    "readOnlyFlags": [
      "--dry-run"
    ]
  },
  {
    "canonical": "state.rebuild",
    "aliases": [
      "state rebuild"
    ],
    "subcommand": "rebuild",
    "mutation": true,
    "readOnlyFlags": [
      "--dry-run"
    ]
  },
  {
    "canonical": "state.milestone-switch",
    "aliases": [
      "state milestone-switch"
    ],
    "subcommand": "milestone-switch",
    "mutation": true
  },
  {
    "canonical": "state.add-roadmap-evolution",
    "aliases": [
      "state add-roadmap-evolution"
    ],
    "subcommand": "add-roadmap-evolution",
    "mutation": true
  }
];

export const VERIFY_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "verify.plan-structure",
    "aliases": [
      "verify plan-structure"
    ],
    "subcommand": "plan-structure",
    "mutation": false
  },
  {
    "canonical": "verify.phase-completeness",
    "aliases": [
      "verify phase-completeness"
    ],
    "subcommand": "phase-completeness",
    "mutation": false
  },
  {
    "canonical": "verify.references",
    "aliases": [
      "verify references"
    ],
    "subcommand": "references",
    "mutation": false
  },
  {
    "canonical": "verify.commits",
    "aliases": [
      "verify commits"
    ],
    "subcommand": "commits",
    "mutation": false
  },
  {
    "canonical": "verify.artifacts",
    "aliases": [
      "verify artifacts"
    ],
    "subcommand": "artifacts",
    "mutation": false
  },
  {
    "canonical": "verify.key-links",
    "aliases": [
      "verify key-links"
    ],
    "subcommand": "key-links",
    "mutation": false
  },
  {
    "canonical": "verify.schema-drift",
    "aliases": [
      "verify schema-drift"
    ],
    "subcommand": "schema-drift",
    "mutation": false
  },
  {
    "canonical": "verify.codebase-drift",
    "aliases": [
      "verify codebase-drift"
    ],
    "subcommand": "codebase-drift",
    "mutation": false
  },
  {
    "canonical": "verify.context-drift",
    "aliases": [
      "verify context-drift"
    ],
    "subcommand": "context-drift",
    "mutation": false
  }
];

export const INIT_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "init.execute-phase",
    "aliases": [
      "init execute-phase"
    ],
    "subcommand": "execute-phase",
    "mutation": false
  },
  {
    "canonical": "init.plan-phase",
    "aliases": [
      "init plan-phase"
    ],
    "subcommand": "plan-phase",
    "mutation": false
  },
  {
    "canonical": "init.new-project",
    "aliases": [
      "init new-project"
    ],
    "subcommand": "new-project",
    "mutation": false
  },
  {
    "canonical": "init.new-milestone",
    "aliases": [
      "init new-milestone"
    ],
    "subcommand": "new-milestone",
    "mutation": false
  },
  {
    "canonical": "init.onboard",
    "aliases": [
      "init onboard"
    ],
    "subcommand": "onboard",
    "mutation": false
  },
  {
    "canonical": "init.quick",
    "aliases": [
      "init quick"
    ],
    "subcommand": "quick",
    "mutation": false
  },
  {
    "canonical": "init.quick-batch",
    "aliases": [
      "init quick-batch"
    ],
    "subcommand": "quick-batch",
    "mutation": false
  },
  {
    "canonical": "init.ingest-docs",
    "aliases": [
      "init ingest-docs"
    ],
    "subcommand": "ingest-docs",
    "mutation": false
  },
  {
    "canonical": "init.resume",
    "aliases": [
      "init resume"
    ],
    "subcommand": "resume",
    "mutation": false
  },
  {
    "canonical": "init.verify-work",
    "aliases": [
      "init verify-work"
    ],
    "subcommand": "verify-work",
    "mutation": false
  },
  {
    "canonical": "init.phase-op",
    "aliases": [
      "init phase-op"
    ],
    "subcommand": "phase-op",
    "mutation": false
  },
  {
    "canonical": "init.code-review",
    "aliases": [
      "init code-review"
    ],
    "subcommand": "code-review",
    "mutation": false
  },
  {
    "canonical": "init.review",
    "aliases": [
      "init review"
    ],
    "subcommand": "review",
    "mutation": false
  },
  {
    "canonical": "init.discuss-phase-assumptions",
    "aliases": [
      "init discuss-phase-assumptions"
    ],
    "subcommand": "discuss-phase-assumptions",
    "mutation": false
  },
  {
    "canonical": "init.todos",
    "aliases": [
      "init todos"
    ],
    "subcommand": "todos",
    "mutation": false
  },
  {
    "canonical": "init.milestone-op",
    "aliases": [
      "init milestone-op"
    ],
    "subcommand": "milestone-op",
    "mutation": false
  },
  {
    "canonical": "init.map-codebase",
    "aliases": [
      "init map-codebase"
    ],
    "subcommand": "map-codebase",
    "mutation": false
  },
  {
    "canonical": "init.progress",
    "aliases": [
      "init progress"
    ],
    "subcommand": "progress",
    "mutation": false
  },
  {
    "canonical": "init.manager",
    "aliases": [
      "init manager"
    ],
    "subcommand": "manager",
    "mutation": false
  },
  {
    "canonical": "init.complete-milestone",
    "aliases": [
      "init complete-milestone"
    ],
    "subcommand": "complete-milestone",
    "mutation": false
  },
  {
    "canonical": "init.autonomous",
    "aliases": [
      "init autonomous"
    ],
    "subcommand": "autonomous",
    "mutation": false
  },
  {
    "canonical": "init.docs-update",
    "aliases": [
      "init docs-update"
    ],
    "subcommand": "docs-update",
    "mutation": false
  },
  {
    "canonical": "init.update",
    "aliases": [
      "init update"
    ],
    "subcommand": "update",
    "mutation": false
  },
  {
    "canonical": "init.transition",
    "aliases": [
      "init transition"
    ],
    "subcommand": "transition",
    "mutation": false
  },
  {
    "canonical": "init.debug",
    "aliases": [
      "init debug"
    ],
    "subcommand": "debug",
    "mutation": false
  },
  {
    "canonical": "init.new-workspace",
    "aliases": [
      "init new-workspace"
    ],
    "subcommand": "new-workspace",
    "mutation": false
  },
  {
    "canonical": "init.list-workspaces",
    "aliases": [
      "init list-workspaces"
    ],
    "subcommand": "list-workspaces",
    "mutation": false
  },
  {
    "canonical": "init.remove-workspace",
    "aliases": [
      "init remove-workspace"
    ],
    "subcommand": "remove-workspace",
    "mutation": false
  }
];

export const PHASE_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "phase.uat-passed",
    "aliases": [
      "phase uat-passed"
    ],
    "subcommand": "uat-passed",
    "mutation": false
  },
  {
    "canonical": "phase.next-decimal",
    "aliases": [
      "phase next-decimal"
    ],
    "subcommand": "next-decimal",
    "mutation": false
  },
  {
    "canonical": "phase.add",
    "aliases": [
      "phase add"
    ],
    "subcommand": "add",
    "mutation": true
  },
  {
    "canonical": "phase.add-batch",
    "aliases": [
      "phase add-batch"
    ],
    "subcommand": "add-batch",
    "mutation": true
  },
  {
    "canonical": "phase.insert",
    "aliases": [
      "phase insert"
    ],
    "subcommand": "insert",
    "mutation": true
  },
  {
    "canonical": "phase.remove",
    "aliases": [
      "phase remove"
    ],
    "subcommand": "remove",
    "mutation": true
  },
  {
    "canonical": "phase.complete",
    "aliases": [
      "phase complete"
    ],
    "subcommand": "complete",
    "mutation": true
  },
  {
    "canonical": "phase.scaffold",
    "aliases": [
      "phase scaffold"
    ],
    "subcommand": "scaffold",
    "mutation": true
  },
  {
    "canonical": "phase.list-plans",
    "aliases": [
      "phase list-plans"
    ],
    "subcommand": "list-plans",
    "mutation": false
  }
];

export const PHASES_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "phases.list",
    "aliases": [
      "phases list"
    ],
    "subcommand": "list",
    "mutation": false
  },
  {
    "canonical": "phases.clear",
    "aliases": [
      "phases clear"
    ],
    "subcommand": "clear",
    "mutation": true
  },
  {
    "canonical": "phases.archive",
    "aliases": [
      "phases archive"
    ],
    "subcommand": "archive",
    "mutation": true
  }
];

export const VALIDATE_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "validate.consistency",
    "aliases": [
      "validate consistency"
    ],
    "subcommand": "consistency",
    "mutation": false
  },
  {
    "canonical": "validate.health",
    "aliases": [
      "validate health"
    ],
    "subcommand": "health",
    "mutation": false
  },
  {
    "canonical": "validate.agents",
    "aliases": [
      "validate agents"
    ],
    "subcommand": "agents",
    "mutation": false
  },
  {
    "canonical": "validate.context",
    "aliases": [
      "validate context"
    ],
    "subcommand": "context",
    "mutation": false
  }
];

export const ROADMAP_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "roadmap.analyze",
    "aliases": [
      "roadmap analyze"
    ],
    "subcommand": "analyze",
    "mutation": false
  },
  {
    "canonical": "roadmap.milestone-scope",
    "aliases": [
      "roadmap milestone-scope"
    ],
    "subcommand": "milestone-scope",
    "mutation": false
  },
  {
    "canonical": "roadmap.get-phase",
    "aliases": [
      "roadmap get-phase"
    ],
    "subcommand": "get-phase",
    "mutation": false
  },
  {
    "canonical": "roadmap.update-plan-progress",
    "aliases": [
      "roadmap update-plan-progress"
    ],
    "subcommand": "update-plan-progress",
    "mutation": true
  },
  {
    "canonical": "roadmap.annotate-dependencies",
    "aliases": [
      "roadmap annotate-dependencies"
    ],
    "subcommand": "annotate-dependencies",
    "mutation": true
  },
  {
    "canonical": "roadmap.validate",
    "aliases": [
      "roadmap validate"
    ],
    "subcommand": "validate",
    "mutation": false
  },
  {
    "canonical": "roadmap.upgrade",
    "aliases": [
      "roadmap upgrade"
    ],
    "subcommand": "upgrade",
    "mutation": true
  }
];

export const NON_FAMILY_COMMAND_ALIASES: NonFamilyCommandAlias[] = [
  {
    "canonical": "agent-skills",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "agent.classify-failure",
    "aliases": [
      "agent classify-failure"
    ],
    "mutation": false
  },
  {
    "canonical": "assumption-delta",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "capability.disable",
    "aliases": [
      "capability disable"
    ],
    "mutation": true
  },
  {
    "canonical": "capability.enable",
    "aliases": [
      "capability enable"
    ],
    "mutation": true
  },
  {
    "canonical": "capability.install",
    "aliases": [
      "capability install"
    ],
    "mutation": true
  },
  {
    "canonical": "capability.list",
    "aliases": [
      "capability list"
    ],
    "mutation": false
  },
  {
    "canonical": "capability.outdated",
    "aliases": [
      "capability outdated"
    ],
    "mutation": false
  },
  {
    "canonical": "capability.remove",
    "aliases": [
      "capability remove"
    ],
    "mutation": true
  },
  {
    "canonical": "capability.set",
    "aliases": [
      "capability set"
    ],
    "mutation": true
  },
  {
    "canonical": "capability.state",
    "aliases": [
      "capability state"
    ],
    "mutation": false
  },
  {
    "canonical": "capability.trust",
    "aliases": [
      "capability trust"
    ],
    "mutation": true
  },
  {
    "canonical": "capability.update",
    "aliases": [
      "capability update"
    ],
    "mutation": true
  },
  {
    "canonical": "check-commit",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "check.decision-coverage-plan",
    "aliases": [
      "check decision-coverage-plan"
    ],
    "mutation": false
  },
  {
    "canonical": "check.decision-coverage-verify",
    "aliases": [
      "check decision-coverage-verify"
    ],
    "mutation": false
  },
  {
    "canonical": "classify-confidence",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "commit",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "commit-docs-guard.disable",
    "aliases": [
      "commit-docs-guard disable"
    ],
    "mutation": true
  },
  {
    "canonical": "commit-docs-guard.enable",
    "aliases": [
      "commit-docs-guard enable"
    ],
    "mutation": true
  },
  {
    "canonical": "commit-to-subrepo",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "config-ensure-section",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "config-get",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "config-new-project",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "config-path",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "config-set",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "config-set-model-profile",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "context-predicates",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "current-timestamp",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "detect-custom-files",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "dispatch-capacity",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "dispatch-isolation",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "dispatch-should-flatten",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "docs-init",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "drift-guard",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "effort.sync",
    "aliases": [
      "effort sync"
    ],
    "mutationFlags": [
      "--apply"
    ],
    "mutation": false
  },
  {
    "canonical": "estimate-calibrate",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "estimate-calibration",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "estimate-check",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "find-phase",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "from-gsd2",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "frontmatter.get",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "frontmatter.merge",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "frontmatter.set",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "frontmatter.validate",
    "aliases": [
      "frontmatter validate"
    ],
    "mutation": false
  },
  {
    "canonical": "gap-analysis",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "generate-claude-md",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "generate-claude-profile",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "generate-dev-preferences",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "generate-slug",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "git.base-branch",
    "aliases": [
      "git base-branch"
    ],
    "mutation": false
  },
  {
    "canonical": "history-digest",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "inspect-dispatch-isolation",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "learnings.copy",
    "aliases": [
      "learnings copy"
    ],
    "mutation": true
  },
  {
    "canonical": "learnings.delete",
    "aliases": [
      "learnings delete"
    ],
    "mutation": true
  },
  {
    "canonical": "learnings.prune",
    "aliases": [
      "learnings prune"
    ],
    "mutation": true
  },
  {
    "canonical": "list-seeds",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "list-todos",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "loop",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "migrate-config",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "milestone.archive-quick",
    "aliases": [
      "milestone archive-quick"
    ],
    "mutation": true
  },
  {
    "canonical": "milestone.complete",
    "aliases": [
      "milestone complete"
    ],
    "mutation": true
  },
  {
    "canonical": "normalize-test-command",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "owner-context",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "package-legitimacy",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "phase-plan-index",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "phase.mvp-mode",
    "aliases": [
      "phase mvp-mode"
    ],
    "mutation": false
  },
  {
    "canonical": "planning",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "pr-subrepo",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "progress.bar",
    "aliases": [
      "progress bar"
    ],
    "mutation": false
  },
  {
    "canonical": "project-instruction-file",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "prompt-budget",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "quick-tasks-append",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "quick-tasks-migrate",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "record-dispatch-isolation",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "requirements.mark-complete",
    "aliases": [
      "requirements mark-complete"
    ],
    "mutation": true
  },
  {
    "canonical": "requirements.ready-ids",
    "aliases": [
      "requirements ready-ids"
    ],
    "mutation": false
  },
  {
    "canonical": "requirements.revert-phase",
    "aliases": [
      "requirements revert-phase"
    ],
    "mutation": true
  },
  {
    "canonical": "research-plan",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "research-store.get",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "research-store.put",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "resolve-agent",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "resolve-dispatch-type",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "resolve-execution",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "resolve-granularity",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "resolve-model",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "restore-custom-files",
    "aliases": [],
    "mutation": false,
    "mutationFlags": [
      "--apply"
    ]
  },
  {
    "canonical": "review-lane",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "runtime-identity",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "scaffold",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "select-revert-commits",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "skill-manifest",
    "aliases": [],
    "mutationFlags": [
      "--write"
    ],
    "mutation": false
  },
  {
    "canonical": "skills-root",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "smart-entry",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "stamp-codebase-map",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "state-snapshot",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "stats.json",
    "aliases": [
      "stats json"
    ],
    "mutation": false
  },
  {
    "canonical": "summary-extract",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "task.is-behavior-adding",
    "aliases": [
      "task is-behavior-adding"
    ],
    "mutation": false
  },
  {
    "canonical": "teams-status",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "template.fill",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "template.select",
    "aliases": [
      "template select"
    ],
    "mutation": false
  },
  {
    "canonical": "todo.complete",
    "aliases": [
      "todo complete"
    ],
    "mutation": true
  },
  {
    "canonical": "todo.match-phase",
    "aliases": [
      "todo match-phase"
    ],
    "mutation": false
  },
  {
    "canonical": "uat.complete-session",
    "aliases": [
      "uat complete-session"
    ],
    "mutation": true
  },
  {
    "canonical": "uat.render-checkpoint",
    "aliases": [
      "uat render-checkpoint"
    ],
    "mutation": false
  },
  {
    "canonical": "update-context",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "user-story.validate",
    "aliases": [
      "user-story validate"
    ],
    "mutation": false
  },
  {
    "canonical": "verification.append-audit",
    "aliases": [
      "verification append-audit"
    ],
    "mutation": true
  },
  {
    "canonical": "verification.fingerprint",
    "aliases": [
      "verification fingerprint"
    ],
    "mutation": false
  },
  {
    "canonical": "verification.resolve-file",
    "aliases": [
      "verification resolve-file"
    ],
    "mutation": false
  },
  {
    "canonical": "verification.status",
    "aliases": [
      "verification status"
    ],
    "mutation": false
  },
  {
    "canonical": "verify-path-exists",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "verify-summary",
    "aliases": [
      "verify.summary",
      "verify summary"
    ],
    "mutation": false
  },
  {
    "canonical": "websearch",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "windows.append",
    "aliases": [
      "windows append"
    ],
    "mutation": true
  },
  {
    "canonical": "windows.fixed",
    "aliases": [
      "windows fixed"
    ],
    "mutation": true
  },
  {
    "canonical": "windows.status",
    "aliases": [
      "windows status"
    ],
    "mutation": false
  },
  {
    "canonical": "windows.waive",
    "aliases": [
      "windows waive"
    ],
    "mutation": true
  },
  {
    "canonical": "workstream.complete",
    "aliases": [
      "workstream complete"
    ],
    "mutation": true
  },
  {
    "canonical": "workstream.create",
    "aliases": [
      "workstream create"
    ],
    "mutation": true
  },
  {
    "canonical": "workstream.list",
    "aliases": [
      "workstream list"
    ],
    "mutation": false
  },
  {
    "canonical": "workstream.progress",
    "aliases": [
      "workstream progress"
    ],
    "mutation": false
  },
  {
    "canonical": "workstream.set",
    "aliases": [
      "workstream set"
    ],
    "mutation": true
  },
  {
    "canonical": "worktree.cleanup-wave",
    "aliases": [
      "worktree cleanup-wave"
    ],
    "mutation": true
  },
  {
    "canonical": "worktree.reap-orphans",
    "aliases": [
      "worktree reap-orphans"
    ],
    "mutation": true
  },
  {
    "canonical": "write-profile",
    "aliases": [],
    "mutation": true
  }
];

// quick-batch coordination verbs (#3676). `resume` is deliberately
// non-mutating at the registry level: a resume with no pending transitions is
// read-only, so the writer binds its BATCH.json target at the transition write
// (src/quick-batch.cts) instead of refusing every read-only resume under an
// enforce policy.
export const QUICK_BATCH_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "quick-batch.create",
    "aliases": ["quick-batch create"],
    "subcommand": "create",
    "mutation": true
  },
  {
    "canonical": "quick-batch.update",
    "aliases": ["quick-batch update"],
    "subcommand": "update",
    "mutation": true
  },
  {
    "canonical": "quick-batch.resume",
    "aliases": ["quick-batch resume"],
    "subcommand": "resume",
    "mutation": false
  },
  {
    "canonical": "quick-batch.complete",
    "aliases": ["quick-batch complete"],
    "subcommand": "complete",
    "mutation": true
  },
  {
    "canonical": "quick-batch.effective-concurrency",
    "aliases": ["quick-batch effective-concurrency"],
    "subcommand": "effective-concurrency",
    "mutation": false
  },
  {
    "canonical": "quick-batch.merge-eligible",
    "aliases": ["quick-batch merge-eligible"],
    "subcommand": "merge-eligible",
    "mutation": false
  },
  {
    "canonical": "quick-batch.spawn-plan",
    "aliases": ["quick-batch spawn-plan"],
    "subcommand": "spawn-plan",
    "mutation": false
  },
  {
    "canonical": "quick-batch.filter-executed",
    "aliases": ["quick-batch filter-executed"],
    "subcommand": "filter-executed",
    "mutation": false
  },
  {
    "canonical": "quick-batch.verification-routing",
    "aliases": ["quick-batch verification-routing"],
    "subcommand": "verification-routing",
    "mutation": false
  },
  {
    "canonical": "quick-batch.merge-routing",
    "aliases": ["quick-batch merge-routing"],
    "subcommand": "merge-routing",
    "mutation": false
  },
  {
    "canonical": "quick-batch.cleanup-entry",
    "aliases": ["quick-batch cleanup-entry"],
    "subcommand": "cleanup-entry",
    "mutation": false
  },
  {
    "canonical": "quick-batch.parse-args",
    "aliases": ["quick-batch parse-args"],
    "subcommand": "parse-args",
    "mutation": false
  }
];

export const STATE_SUBCOMMANDS: string[] = STATE_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const VERIFY_SUBCOMMANDS: string[] = VERIFY_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const INIT_SUBCOMMANDS: string[] = INIT_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const PHASE_SUBCOMMANDS: string[] = PHASE_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const PHASES_SUBCOMMANDS: string[] = PHASES_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const VALIDATE_SUBCOMMANDS: string[] = VALIDATE_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const ROADMAP_SUBCOMMANDS: string[] = ROADMAP_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const QUICK_BATCH_SUBCOMMANDS: string[] = QUICK_BATCH_COMMAND_ALIASES.map((entry) => entry.subcommand);

export const EVAL_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "eval.score",
    "aliases": ["eval score"],
    "subcommand": "score",
    "mutation": false
  }
];

export const EVAL_SUBCOMMANDS: string[] = EVAL_COMMAND_ALIASES.map((entry) => entry.subcommand);
