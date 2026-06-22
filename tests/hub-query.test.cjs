#!/usr/bin/env node
'use strict';

/**
 * Integration tests for hub query verbs (lib/hub-query.cjs via `hub v1 *`).
 *
 * Ported from the deferred get-shit-done-cc spec
 * (claude-code-memory/global/gsd-hub-mode-deferred/tests/hub-query.test.cjs).
 * Adjustment vs the spec source: invokes the engine via tests/helpers.cjs
 * runGsdTools (resolves ../gsd-core/bin/gsd-tools.cjs) instead of a hardcoded
 * SDK bin path.
 *
 * Self-contained — builds a synthetic .planning/ + repo-manifest.json per
 * scenario, exercises one verb, asserts on the JSON shape. Exits non-zero on
 * failure.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runGsdTools, cleanup } = require('./helpers.cjs');

let passes = 0;
let failures = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  ok:   ${msg}`); passes++; }
  else { console.error(`  FAIL: ${msg}`); failures++; }
}

function mkRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-hub-q-'));
  const planning = path.join(tmpDir, '.planning');
  fs.mkdirSync(path.join(planning, 'phases'), { recursive: true });
  fs.writeFileSync(path.join(planning, 'PROJECT.md'),
    '# X\n\n## What This Is\nx\n\n## Core Value\nx\n\n## Requirements\nx\n');
  fs.writeFileSync(path.join(planning, 'STATE.md'),
    '---\ngsd_state_version: 1.0\nmilestone: v2.0\nstatus: executing\n---\n\n**Current Phase:** 10\n');
  return { tmpDir, planning };
}

function writeRoadmap(planning, body) {
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), body);
}

function writePhase(planning, id, planFrontmatter = null) {
  const dir = path.join(planning, 'phases', id);
  fs.mkdirSync(dir, { recursive: true });
  const fm = planFrontmatter
    ? `---\n${Object.entries(planFrontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n`
    : '';
  fs.writeFileSync(path.join(dir, `${id.replace(/-.*$/, '')}-01-PLAN.md`), `${fm}# Plan\n\nbody\n`);
}

function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}

function writeManifest(tmpDir, manifest) {
  fs.writeFileSync(path.join(tmpDir, 'repo-manifest.json'), JSON.stringify(manifest, null, 2));
}

function run(cwd, ...verb) {
  const res = runGsdTools(['hub', 'v1', ...verb], cwd);
  return JSON.parse(res.output);
}

function rmrf(p) { cleanup(p); }

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT1: hub v1 milestone current');
{
  const { tmpDir, planning } = mkRepo();
  writeRoadmap(planning,
    '# Roadmap\n\n## Milestones\n\n' +
    '### v1.0 Old Milestone — SHIPPED 2026-01-01\n' +
    '### Phase 1: thing\nx\n\n' +
    '### v2.0 Current Milestone (Phases 10-12)\n' +
    '### Phase 10: A\nx\n### Phase 11: B\nx\n### Phase 12: C\nx\n');
  const r = run(tmpDir, 'milestone', 'current');
  assert(r.version === 'v2.0', `version is v2.0 (got ${r.version})`);
  assert(r.phases.length === 3, `3 phases returned (got ${r.phases.length})`);
  assert(r.phases.join(',') === '10,11,12', 'phases are 10,11,12');
  assert(r.phase_range && r.phase_range.lo === 10 && r.phase_range.hi === 12, 'range 10..12');
  assert(r.generator_version, 'generator_version present');
  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT2: hub v1 phase <id> — bundle shape');
{
  const { tmpDir, planning } = mkRepo();
  writeRoadmap(planning, '## Milestones\n\n### v2.0 (Phases 10-10)\n### Phase 10: A\n');
  writePhase(planning, '10-foo', { milestone: 'v2.0', owner: 'avi', dependencies: ['09-bar'] });
  // Add a SUMMARY to push state forward
  writeFile(path.join(planning, 'phases', '10-foo'), '10-01-SUMMARY.md', '# Summary\nx\n');
  const r = run(tmpDir, 'phase', '10-foo');
  assert(r.id === '10-foo', 'id matches');
  assert(r.number === 10, 'number=10');
  assert(r.slug === 'foo', 'slug=foo');
  assert(r.milestone === 'v2.0', 'milestone from frontmatter');
  assert(r.owner === 'avi', 'owner from frontmatter');
  assert(Array.isArray(r.dependencies) && r.dependencies.length === 1, 'deps array');
  assert(r.state === 'in_progress', `state=in_progress (got ${r.state})`);
  assert(r.artifacts.plan && r.artifacts.plan.includes('PLAN.md'), 'plan artifact present');
  assert(r.artifacts.summary && r.artifacts.summary.includes('SUMMARY.md'), 'summary artifact present');
  assert(r.artifacts.validation === null, 'validation absent → null');
  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT3: hub v1 phase — missing phase returns error');
{
  const { tmpDir } = mkRepo();
  const r = run(tmpDir, 'phase', 'does-not-exist');
  assert(r.error && r.error.includes('not found'), 'error message returned');
  assert(r.id === 'does-not-exist', 'id echoed back');
  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT4: hub v1 phases — filters');
{
  const { tmpDir, planning } = mkRepo();
  writeRoadmap(planning, '## Milestones\n\n### v2.0\n');
  writePhase(planning, '10-a', { milestone: 'v2.0' });
  writePhase(planning, '11-b', { milestone: 'v1.0' });
  writePhase(planning, '12-c', { milestone: 'v2.0' });
  const all = run(tmpDir, 'phases');
  assert(all.count === 3, `unfiltered count=3 (got ${all.count})`);
  const v2 = run(tmpDir, 'phases', '--milestone', 'v2.0');
  assert(v2.count === 2, `v2.0 filter count=2 (got ${v2.count})`);
  const planned = run(tmpDir, 'phases', '--state', 'planned');
  assert(planned.count === 3, 'all are state=planned (no SUMMARYs)');
  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT5: hub v1 manifest — tier + role filters');
{
  const { tmpDir } = mkRepo();
  writeManifest(tmpDir, {
    version: '2.0',
    owner: 'test-org',
    owner_type: 'organization',
    hub: 'test-hub',
    updated: '2026-01-01T00:00:00Z',
    edge_semantics: {
      depends_on: 'runtime', data_depends_on: 'schema', governed_by: 'hub',
    },
    repos: {
      'a': { path: '~/a', github: 'org/a', tier: 1, role: 'service' },
      'b': { path: '~/b', github: 'org/b', tier: 1, role: 'gateway' },
      'c': { path: '~/c', github: 'org/c', tier: 2, role: 'frontend' },
      'd': { path: null,  github: 'org/d', tier: 4, role: 'external' },
    },
  });
  const all = run(tmpDir, 'manifest');
  assert(all.count === 4, `unfiltered=4 (got ${all.count})`);
  const t1 = run(tmpDir, 'manifest', '--tier', '1');
  assert(t1.count === 2, `tier-1=2 (got ${t1.count})`);
  const gw = run(tmpDir, 'manifest', '--role', 'gateway');
  assert(gw.count === 1 && Object.keys(gw.repos)[0] === 'b', 'role=gateway → b');
  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT6: hub v1 spoke <slug>');
{
  const { tmpDir } = mkRepo();
  writeManifest(tmpDir, {
    version: '2.0', owner: 'org', owner_type: 'organization', hub: 'h',
    updated: '2026-01-01T00:00:00Z',
    edge_semantics: { depends_on: '', data_depends_on: '', governed_by: '' },
    repos: { 'svc-x': { path: '~/svc-x', github: 'org/svc-x', tier: 2, role: 'service' } },
  });
  const r = run(tmpDir, 'spoke', 'svc-x');
  assert(r.slug === 'svc-x', 'slug echoed');
  assert(r.tier === 2 && r.role === 'service', 'fields passed through');
  const missing = run(tmpDir, 'spoke', 'does-not-exist');
  assert(missing.error && missing.error.includes('not found'), 'missing → error');
  rmrf(tmpDir);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
