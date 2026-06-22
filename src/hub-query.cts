/**
 * Hub query verbs — deterministic JSON view of planning state for agents.
 *
 * Exposes:
 *   hub v1 milestone current       → current-milestone snapshot (from ROADMAP.md)
 *   hub v1 phase <id>              → phase-meta bundle (matches phase-meta.schema.json)
 *   hub v1 phases [filters]        → array of phase-meta bundles
 *   hub v1 manifest [filters]      → repo-manifest.json with optional filters
 *   hub v1 spoke <slug>            → single repo entry from the manifest
 *
 * Stable contract: all responses are JSON. Field shapes mirror the schemas
 * in capabilities/hub-mode/schemas/ — agents introspect those for the full
 * type contract.
 *
 * Versioning: routed under `hub v1`. Breaking changes get a new `v2`
 * namespace; additive changes stay in v1.
 *
 * ADR-457 build-at-publish: ported from the vendored hub-query.cjs to a typed
 * .cts source of truth (compiled by tsc to a gitignored .cjs). Behaviour is
 * preserved; only types are added. PORT FIX: extractCurrentMilestone is imported
 * from ./roadmap-parser.cjs (the retired ./core.cjs re-export spine, epic #1267).
 *
 * Synchronous by contract: capability routers dispatched via
 * dispatchCapabilityCommand must not return a Promise.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-parser.cjs is an export= CommonJS module
import roadmapParserMod = require('./roadmap-parser.cjs');
const { extractCurrentMilestone } = roadmapParserMod;

const GENERATOR_VERSION = '1.0.0';

interface PhaseArtifacts {
  context: string | null;
  research: string | null;
  plan: string | null;
  summary: string | null;
  validation: string | null;
  review: string | null;
  security: string | null;
  extras: string[];
}

interface PhaseBundle {
  id: string;
  number: number | null;
  slug: string;
  milestone: string | null;
  state: string;
  owner: string | null;
  dependencies: string[];
  spoke_repos: string[];
  artifacts: PhaseArtifacts;
  frontmatter: Record<string, unknown>;
  generated_at: string;
  generator_version: string;
}

interface PhaseRange {
  lo: number;
  hi: number;
}

type Frontmatter = Record<string, unknown>;

function parsePhaseDir(name: string): { number: number | null; slug: string } {
  const m = name.match(/^(\d+(?:\.\d+)?)-(.+)$/);
  if (!m) return { number: null, slug: name };
  const num = parseFloat(m[1]);
  return { number: Number.isFinite(num) ? num : null, slug: m[2] };
}

function findByPattern(files: string[], regex: RegExp): string[] {
  return files.filter((f) => regex.test(f));
}

function firstOrNull(arr: string[]): string | null {
  return arr.length > 0 ? arr[0] : null;
}

const STATUS_PASSTHROUGH = new Set([
  'planned', 'researched', 'in_progress', 'blocked',
  'verified', 'shipped', 'archived',
]);

function deriveState(frontmatter: Frontmatter, artifacts: PhaseArtifacts): string {
  const status = frontmatter['status'];
  if (typeof status === 'string' && STATUS_PASSTHROUGH.has(status)) {
    return status;
  }
  if (artifacts.summary && artifacts.validation) return 'verified';
  if (artifacts.summary) return 'in_progress';
  if (artifacts.plan && artifacts.research) return 'researched';
  if (artifacts.plan) return 'planned';
  return 'planned';
}

function loadPhaseBundle(planBase: string, phaseId: string): PhaseBundle | null {
  const phaseDir = path.join(planBase, 'phases', phaseId);
  if (!fs.existsSync(phaseDir) || !fs.statSync(phaseDir).isDirectory()) {
    return null;
  }
  const files = fs.readdirSync(phaseDir);
  const { number, slug } = parsePhaseDir(phaseId);

  const planFile = firstOrNull(findByPattern(files, /(?:^|-)PLAN\.md$/i).sort());
  const summaryFile = firstOrNull(findByPattern(files, /(?:^|-)SUMMARY\.md$/i).sort());
  const contextFile = firstOrNull(findByPattern(files, /CONTEXT\.md$/i));
  const researchFile = firstOrNull(findByPattern(files, /RESEARCH\.md$/i));
  const validationFile = firstOrNull(findByPattern(files, /VALIDATION\.md$/i));
  const reviewFile = firstOrNull(findByPattern(files, /REVIEW\.md$/i));
  const securityFile = firstOrNull(findByPattern(files, /SECURITY\.md$/i));

  const claimed = new Set(
    [planFile, summaryFile, contextFile, researchFile, validationFile, reviewFile, securityFile]
      .filter(Boolean) as string[],
  );
  const extras = files.filter((f) => f.endsWith('.md') && !claimed.has(f)).sort();

  const artifacts: PhaseArtifacts = {
    context:    contextFile    ? path.posix.join('phases', phaseId, contextFile)    : null,
    research:   researchFile   ? path.posix.join('phases', phaseId, researchFile)   : null,
    plan:       planFile       ? path.posix.join('phases', phaseId, planFile)       : null,
    summary:    summaryFile    ? path.posix.join('phases', phaseId, summaryFile)    : null,
    validation: validationFile ? path.posix.join('phases', phaseId, validationFile) : null,
    review:     reviewFile     ? path.posix.join('phases', phaseId, reviewFile)     : null,
    security:   securityFile   ? path.posix.join('phases', phaseId, securityFile)   : null,
    extras:     extras.map((f) => path.posix.join('phases', phaseId, f)),
  };

  let frontmatter: Frontmatter = {};
  if (planFile) {
    try {
      const raw = fs.readFileSync(path.join(phaseDir, planFile), 'utf-8');
      const fm: unknown = extractFrontmatter(raw);
      frontmatter = (fm && typeof fm === 'object' ? fm as Frontmatter : {});
    } catch { /* skip */ }
  }

  const deps = frontmatter['dependencies'];
  const dependsOn = frontmatter['depends_on'];
  const spokeRepos = frontmatter['spoke_repos'];

  return {
    id: phaseId,
    number,
    slug,
    milestone: (frontmatter['milestone'] as string | undefined) || null,
    state: deriveState(frontmatter, artifacts),
    owner: (frontmatter['owner'] as string | undefined) || null,
    dependencies: Array.isArray(deps) ? (deps as string[])
                : Array.isArray(dependsOn) ? (dependsOn as string[])
                : [],
    spoke_repos: Array.isArray(spokeRepos) ? (spokeRepos as string[]) : [],
    artifacts,
    frontmatter,
    generated_at: new Date().toISOString(),
    generator_version: GENERATOR_VERSION,
  };
}

function listPhaseDirs(planBase: string): string[] {
  const phasesDir = path.join(planBase, 'phases');
  if (!fs.existsSync(phasesDir)) return [];
  return fs.readdirSync(phasesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
}

// Read the current-milestone version from STATE.md frontmatter.
// extractCurrentMilestone() returns "preamble + section" which mixes summary
// bullets from earlier milestones into the slice — fine for its callers but not
// for deterministic per-milestone phase extraction. Here we slice from the
// matching milestone heading down to the next milestone heading instead.
function readStateMilestone(cwd: string): string | null {
  try {
    const statePath = path.join(planningDir(cwd), 'STATE.md');
    const raw = fs.readFileSync(statePath, 'utf-8');
    const m = raw.match(/^milestone:\s*(.+)/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function sliceCurrentMilestoneSection(roadmapContent: string, version: string | null): string | null {
  if (!version) return null;
  const escaped = version.replace(/\./g, '\\.');
  const re = new RegExp(`(^#{1,3})\\s+.*${escaped}[^\\n]*`, 'mi');
  const m = roadmapContent.match(re);
  if (!m || m.index === undefined) return null;
  const headingLevel = m[1].length;
  const sectionStart = m.index;
  const rest = roadmapContent.slice(sectionStart + m[0].length);
  // Next milestone-style heading at same-or-shallower depth ends the section.
  // Phase headings (e.g. "### Phase 12:") are explicitly excluded.
  const nextRe = new RegExp(
    `^#{1,${headingLevel}}\\s+(?!Phase\\s)(?:.*v\\d+\\.\\d+|✅|📋|🚧)`,
    'mi',
  );
  const nextMatch = rest.match(nextRe);
  const sectionEnd = nextMatch && nextMatch.index !== undefined
    ? sectionStart + m[0].length + nextMatch.index
    : roadmapContent.length;
  return roadmapContent.slice(sectionStart, sectionEnd);
}

function getCurrentMilestone(cwd: string): Record<string, unknown> {
  const planBase = planningDir(cwd);
  const roadmapPath = path.join(planBase, 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    return { error: 'ROADMAP.md not found', path: roadmapPath };
  }
  const raw = fs.readFileSync(roadmapPath, 'utf-8');
  const declared = readStateMilestone(cwd);

  // Prefer STATE.md's declared milestone; fall back to first 🚧 marker in ROADMAP.
  let version = declared;
  if (!version) {
    const m = raw.match(/🚧[^\n]*\*\*?(v\d+\.\d+(?:\.\d+)?)\b/);
    version = m ? m[1] : null;
  }

  const section = sliceCurrentMilestoneSection(raw, version);
  if (!section) {
    // Last resort: defer to core's extractor; phase list will be best-effort.
    const fallback: string = extractCurrentMilestone(raw, cwd);
    const phaseNums: string[] = [];
    const phaseRe = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:/gi;
    let mm: RegExpExecArray | null;
    while ((mm = phaseRe.exec(fallback)) !== null) phaseNums.push(mm[1]);
    return {
      version,
      title: null,
      phases: phaseNums,
      phase_range: null,
      roadmap_path: 'ROADMAP.md',
      degraded: 'milestone section not found; phases extracted from full roadmap',
      generated_at: new Date().toISOString(),
      generator_version: GENERATOR_VERSION,
    };
  }

  const titleMatch = section.match(/^#{1,3}\s+[^\n]+/);
  const titleLine = titleMatch ? titleMatch[0].replace(/^#{1,3}\s+/, '') : null;

  const phaseNums: string[] = [];
  const phaseRe = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:/gi;
  let mm: RegExpExecArray | null;
  while ((mm = phaseRe.exec(section)) !== null) phaseNums.push(mm[1]);
  // De-dup while preserving order
  const seen = new Set<string>();
  const uniquePhases = phaseNums.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));

  const intNums = uniquePhases.map((p) => parseFloat(p)).filter((n) => Number.isFinite(n));
  const range: PhaseRange | null = intNums.length > 0
    ? { lo: Math.min(...intNums), hi: Math.max(...intNums) }
    : null;

  return {
    version,
    title: titleLine,
    phases: uniquePhases,
    phase_range: range,
    roadmap_path: 'ROADMAP.md',
    generated_at: new Date().toISOString(),
    generator_version: GENERATOR_VERSION,
  };
}

function getPhase(cwd: string, phaseId: string | undefined): Record<string, unknown> {
  const planBase = planningDir(cwd);
  if (!phaseId) return { error: 'phase id is required' };
  const bundle = loadPhaseBundle(planBase, phaseId);
  if (!bundle) return { error: `phase not found: ${phaseId}`, id: phaseId };
  return bundle as unknown as Record<string, unknown>;
}

interface PhasesOpts { milestone?: string; state?: string }

function getPhases(cwd: string, opts: PhasesOpts = {}): Record<string, unknown> {
  const planBase = planningDir(cwd);
  let bundles = listPhaseDirs(planBase)
    .map((id) => loadPhaseBundle(planBase, id))
    .filter(Boolean) as PhaseBundle[];

  if (opts.milestone) {
    bundles = bundles.filter((b) => b.milestone === opts.milestone);
  }
  if (opts.state) {
    bundles = bundles.filter((b) => b.state === opts.state);
  }

  return {
    count: bundles.length,
    phases: bundles,
    generated_at: new Date().toISOString(),
    generator_version: GENERATOR_VERSION,
  };
}

function findRepoManifest(cwd: string): string | null {
  let dir = path.resolve(cwd);
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'repo-manifest.json');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

interface ManifestOpts { tier?: string; role?: string }
type RepoEntry = Record<string, unknown> & { tier?: number; role?: string };

function getManifest(cwd: string, opts: ManifestOpts = {}): Record<string, unknown> {
  const manifestPath = findRepoManifest(cwd);
  if (!manifestPath) {
    return { error: 'repo-manifest.json not found in cwd or ancestors' };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;

  let repos = (manifest['repos'] as Record<string, RepoEntry>) || {};
  if (opts.tier !== undefined && opts.tier !== null) {
    const t = parseInt(opts.tier, 10);
    const filtered: Record<string, RepoEntry> = {};
    for (const [slug, entry] of Object.entries(repos)) {
      if (entry && entry.tier === t) filtered[slug] = entry;
    }
    repos = filtered;
  }
  if (opts.role) {
    const filtered: Record<string, RepoEntry> = {};
    for (const [slug, entry] of Object.entries(repos)) {
      if (entry && entry.role === opts.role) filtered[slug] = entry;
    }
    repos = filtered;
  }

  return {
    version: manifest['version'],
    owner: manifest['owner'],
    owner_type: manifest['owner_type'],
    hub: manifest['hub'],
    updated: manifest['updated'],
    edge_semantics: manifest['edge_semantics'],
    repos,
    count: Object.keys(repos).length,
    manifest_path: path.relative(cwd, manifestPath),
    generated_at: new Date().toISOString(),
    generator_version: GENERATOR_VERSION,
  };
}

function getSpoke(cwd: string, slug: string | undefined): Record<string, unknown> {
  if (!slug) return { error: 'spoke slug is required' };
  const manifestPath = findRepoManifest(cwd);
  if (!manifestPath) {
    return { error: 'repo-manifest.json not found in cwd or ancestors' };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  const entry = ((manifest['repos'] as Record<string, RepoEntry>) || {})[slug];
  if (!entry) return { error: `spoke not found: ${slug}`, slug };
  return {
    slug,
    ...entry,
    manifest_path: path.relative(cwd, manifestPath),
    generated_at: new Date().toISOString(),
    generator_version: GENERATOR_VERSION,
  };
}

export = {
  getCurrentMilestone,
  getPhase,
  getPhases,
  getManifest,
  getSpoke,
  loadPhaseBundle,
  parsePhaseDir,
  deriveState,
  // exported for verify.cts hub-mode W007 scoping
  sliceCurrentMilestoneSection,
  readStateMilestone,
  GENERATOR_VERSION,
};
