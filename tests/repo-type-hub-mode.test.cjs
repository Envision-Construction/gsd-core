#!/usr/bin/env node
'use strict';

/**
 * Integration tests for repo_type hub mode (see verify.cts W002/W005/W006/W007/W019
 * + the W022 invalid-repo_type warning).
 *
 * Ported from the deferred get-shit-done-cc spec
 * (claude-code-memory/global/gsd-hub-mode-deferred/tests/repo-type-hub-mode.test.cjs).
 * Adjustments vs the spec source:
 *   - invokes the engine via tests/helpers.cjs runGsdTools (resolves
 *     ../gsd-core/bin/gsd-tools.cjs) instead of a hardcoded SDK bin path;
 *   - the invalid-repo_type warning is W022, not W021 (W021 is already used twice
 *     in verify.cts: phase-prefix mismatch + STATE-complete mismatch), so T5
 *     asserts W022.
 *
 * Self-contained — builds a synthetic .planning/ tree per test, runs
 * `validate health`, asserts on the JSON warnings. Exits non-zero on failure.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runGsdTools, cleanup } = require('./helpers.cjs');

let failures = 0;
let passes = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failures++;
  } else {
    console.log(`  ok:   ${msg}`);
    passes++;
  }
}

function mkTmpRepo(milestone = 'v1.0') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-hub-test-'));
  const planning = path.join(tmpDir, '.planning');
  fs.mkdirSync(path.join(planning, 'phases'), { recursive: true });

  fs.writeFileSync(path.join(planning, 'PROJECT.md'),
    '# Project\n\n## What This Is\n\nx\n\n## Core Value\n\nx\n\n## Requirements\n\nx\n');
  // Real GSD STATE.md has frontmatter with milestone field — required for
  // hub-mode W007 section-scoping to work.
  fs.writeFileSync(path.join(planning, 'STATE.md'),
    `---\ngsd_state_version: 1.0\nmilestone: ${milestone}\nstatus: executing\n---\n\n**Current Phase:** 260\n**Status:** in-progress\n`);

  return { tmpDir, planning };
}

function writeRoadmap(planning, currentMilestone, phaseNums) {
  const phaseSections = phaseNums.map(n => `### Phase ${n}: Test phase ${n}\nbody\n`).join('\n');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'),
    `# Roadmap\n\n## Milestones\n\n### ${currentMilestone}\n\n${phaseSections}\n`);
}

function writeConfig(planning, obj) {
  fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify(obj, null, 2));
}

function writePhaseDir(planning, dirname) {
  fs.mkdirSync(path.join(planning, 'phases', dirname), { recursive: true });
}

function runHealth(tmpDir) {
  const res = runGsdTools(['validate', 'health'], tmpDir);
  return JSON.parse(res.output);
}

function rmrf(dir) {
  cleanup(dir);
}

function countByCode(result, code) {
  return (result.warnings || []).filter(w => w.code === code).length;
}

function hasCode(result, code) {
  return countByCode(result, code) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: standalone (default) — W005 phase-dir naming.
// RECONCILED vs the deferred spec: the live gsd-core phaseDirNameRe accepts
// \d{2,} prefixes (2+ digits, incl. 999.1-foo sub-phases) by upstream contract
// (tests/26-w005-w006-i001-cjs-drift-regression.test.cjs asserts 3-digit dirs
// are ACCEPTED in standalone). The original spec's "standalone flags 3-digit"
// premise pre-dates that drift and would regress the upstream test, so T1 here
// asserts the engine's real behavior: standalone accepts valid multi-digit
// numeric prefixes and flags only genuinely malformed (non-numeric-prefix) dirs.
// Hub-mode's W005 relaxation is the '_'-prefix skip (T2/T6), not digit-width.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT1: standalone mode — W005 flags malformed dirs, accepts multi-digit prefixes');
{
  const { tmpDir, planning } = mkTmpRepo();
  writeRoadmap(planning, 'v1.0 Test', ['250']);
  writePhaseDir(planning, '250-three-digit-phase');
  writePhaseDir(planning, '01-two-digit-phase');
  writePhaseDir(planning, 'bad-no-prefix');
  // no repo_type set — defaults to standalone

  const r = runHealth(tmpDir);
  const w005Names = (r.warnings || []).filter(w => w.code === 'W005').map(w => w.message);
  assert(w005Names.some(m => m.includes('bad-no-prefix')), 'standalone flags non-numeric-prefix dir');
  assert(!w005Names.some(m => m.includes('250-three-digit-phase')), 'standalone accepts multi-digit prefix (upstream contract)');
  assert(!w005Names.some(m => m.includes('01-two-digit-phase')), 'standalone accepts 2-digit prefix');

  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: hub mode — relaxed regex allows 3-digit; _-prefixed dir skipped
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT2: hub mode — relaxed NNNN regex + _-prefix skip');
{
  const { tmpDir, planning } = mkTmpRepo('v1.0');
  writeRoadmap(planning, 'v1.0 Test', ['250']);
  writePhaseDir(planning, '250-three-digit-phase');
  writePhaseDir(planning, '_archive');
  writePhaseDir(planning, 'bad-no-prefix');
  writeConfig(planning, { repo_type: 'hub' });

  const r = runHealth(tmpDir);
  const w005Names = (r.warnings || []).filter(w => w.code === 'W005').map(w => w.message);
  assert(!w005Names.some(m => m.includes('250-three-digit-phase')), 'hub does NOT flag 250-three-digit-phase');
  assert(!w005Names.some(m => m.includes('_archive')), 'hub does NOT flag _-prefixed dir');
  assert(w005Names.some(m => m.includes('bad-no-prefix')), 'hub still flags non-numeric prefix');

  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: hub mode — W007 scoped to current milestone numeric range
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT3: hub mode — W007 scoped to current-milestone range');
{
  const { tmpDir, planning } = mkTmpRepo('v47.0');
  writeRoadmap(planning, 'v47.0 (Phases 280-285)', ['280', '281', '283', '285']);
  for (const n of [250, 280, 281, 282, 283, 284, 285, 290]) {
    writePhaseDir(planning, `${n}-x`);
  }
  writeConfig(planning, { repo_type: 'hub' });

  const r = runHealth(tmpDir);
  const w007Names = (r.warnings || []).filter(w => w.code === 'W007').map(w => w.message);
  assert(!w007Names.some(m => m.includes('Phase 250')), 'hub does NOT flag historical Phase 250 (below range lo)');
  assert(!w007Names.some(m => m.includes('Phase 290')), 'hub does NOT flag future Phase 290 (above range hi)');
  assert(w007Names.some(m => m.includes('Phase 282')), 'hub DOES flag in-range gap Phase 282');
  assert(w007Names.some(m => m.includes('Phase 284')), 'hub DOES flag in-range gap Phase 284');

  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: hub mode — .gsdrootallow whitelists non-canonical root files
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT4: hub mode — .gsdrootallow whitelist for W019');
{
  const { tmpDir, planning } = mkTmpRepo();
  writeRoadmap(planning, 'v1.0', ['10']);
  writePhaseDir(planning, '10-x');
  fs.writeFileSync(path.join(planning, 'DECISIONS.md'), '# decisions\n');
  fs.writeFileSync(path.join(planning, 'GCP-PROJECT-MAP.md'), '# gcp\n');
  fs.writeFileSync(path.join(planning, 'ROGUE.md'), '# rogue\n');
  fs.writeFileSync(path.join(planning, '.gsdrootallow'),
    '# Hub-specific docs\nDECISIONS.md\nGCP-PROJECT-MAP.md\n');
  writeConfig(planning, { repo_type: 'hub' });

  const r = runHealth(tmpDir);
  const w019Names = (r.warnings || []).filter(w => w.code === 'W019').map(w => w.message);
  assert(!w019Names.some(m => m.includes('DECISIONS.md')), 'hub whitelists DECISIONS.md');
  assert(!w019Names.some(m => m.includes('GCP-PROJECT-MAP.md')), 'hub whitelists GCP-PROJECT-MAP.md');
  assert(w019Names.some(m => m.includes('ROGUE.md')), 'hub still flags non-whitelisted ROGUE.md');

  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: invalid repo_type → W022 (W021 is already taken in verify.cts)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT5: invalid repo_type → W022');
{
  const { tmpDir, planning } = mkTmpRepo();
  writeRoadmap(planning, 'v1.0', ['10']);
  writePhaseDir(planning, '10-x');
  writeConfig(planning, { repo_type: 'galaxy' });

  const r = runHealth(tmpDir);
  assert(hasCode(r, 'W022'), 'invalid repo_type fires W022');
  // Also: since invalid value falls back to standalone, W005 / W019 strictness still applies
  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: explicit repo_type='standalone' matches default — the hub '_'-prefix
// skip is hub-ONLY. RECONCILED vs spec (which asserted "standalone flags 3-digit"):
// the engine accepts multi-digit prefixes in standalone (see T1), so the
// observable standalone-vs-hub W005 difference is the '_'-dir skip. Standalone
// flags a '_'-prefixed dir (fails phaseDirNameRe); hub skips it (see T2).
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT6: explicit standalone does NOT skip _-prefixed dirs (hub-only relaxation)');
{
  const { tmpDir, planning } = mkTmpRepo();
  writeRoadmap(planning, 'v1.0', ['250']);
  writePhaseDir(planning, '250-x');
  writePhaseDir(planning, '_archive');
  writeConfig(planning, { repo_type: 'standalone' });
  const r = runHealth(tmpDir);
  const w005Names = (r.warnings || []).filter(w => w.code === 'W005').map(w => w.message);
  assert(w005Names.some(m => m.includes('_archive')), 'explicit standalone flags _-prefixed dir (no hub skip)');
  assert(!w005Names.some(m => m.includes('250-x')), 'explicit standalone accepts multi-digit prefix');
  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: hub mode W002 — cross-repo phase refs skipped via negative lookbehind
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT7: hub mode — W002 skips cross-repo phase refs');
{
  const { tmpDir, planning } = mkTmpRepo('v1.0');
  writeRoadmap(planning, 'v1.0 Test', ['10']);
  writePhaseDir(planning, '10-x');
  fs.writeFileSync(path.join(planning, 'STATE.md'),
    `---\ngsd_state_version: 1.0\nmilestone: v1.0\nstatus: executing\n---\n\n` +
    `**Current Phase:** 10\n\n` +
    `Track A (SDK Migration, Envision-MCP Phase 27 plans 27-01 through 27-04).\n` +
    `Local follow-up needed: Phase 99.\n`);
  writeConfig(planning, { repo_type: 'hub' });

  const r = runHealth(tmpDir);
  const w002Msgs = (r.warnings || []).filter(w => w.code === 'W002').map(w => w.message);
  assert(!w002Msgs.some(m => /references phase 27\b/.test(m)),
    'hub skips cross-repo "Envision-MCP Phase 27" ref');
  assert(w002Msgs.some(m => /references phase 99\b/.test(m)),
    'hub still flags local "Phase 99" ref');
  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: hub mode W002 — plan-code refs "Phase N-M" skipped
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT9: hub mode — W002 skips plan-code refs (Phase N-M)');
{
  const { tmpDir, planning } = mkTmpRepo('v1.0');
  writeRoadmap(planning, 'v1.0 Test', ['10']);
  writePhaseDir(planning, '10-x');
  fs.writeFileSync(path.join(planning, 'STATE.md'),
    `---\ngsd_state_version: 1.0\nmilestone: v1.0\nstatus: executing\n---\n\n` +
    `**Current Phase:** 10\n\n` +
    `Wave 1 = Phase 27-01/27-02 (cross-repo plan codes — skip).\n` +
    `Local follow-up: Phase 99 (bare local ref — flag).\n`);
  writeConfig(planning, { repo_type: 'hub' });

  const r = runHealth(tmpDir);
  const w002Msgs = (r.warnings || []).filter(w => w.code === 'W002').map(w => w.message);
  assert(!w002Msgs.some(m => /references phase 27\b/.test(m)),
    'hub skips "Phase 27-01" plan-code ref');
  assert(w002Msgs.some(m => /references phase 99\b/.test(m)),
    'hub still flags bare local "Phase 99" ref');
  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: hub mode W006 — archived phase dirs satisfy "on disk" check
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT10: hub mode — W006 accepts archived phase dirs');
{
  const { tmpDir, planning } = mkTmpRepo('v2.0');
  writeRoadmap(planning, 'v2.0',
    ['10', '11', '50'].map(String));
  writePhaseDir(planning, '10-x');
  writePhaseDir(planning, '11-y');
  // Phase 50 is in roadmap but archived (not in phases/ top-level).
  fs.mkdirSync(path.join(planning, 'phases', '_archive', 'v1.0', '50-old'), { recursive: true });
  writeConfig(planning, { repo_type: 'hub' });

  const r = runHealth(tmpDir);
  const w006Msgs = (r.warnings || []).filter(w => w.code === 'W006').map(w => w.message);
  assert(!w006Msgs.some(m => /Phase 50\b/.test(m)),
    'hub does NOT W006 archived Phase 50');
  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: hub mode W002 — archived phase refs (phases/_archive/) treated as valid
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nT8: hub mode — W002 accepts archived phase refs');
{
  const { tmpDir, planning } = mkTmpRepo('v2.0');
  writeRoadmap(planning, 'v2.0 Test', ['20']);
  writePhaseDir(planning, '20-x');
  // Archive structure: phases/_archive/v1.0/270-old-phase/
  fs.mkdirSync(path.join(planning, 'phases', '_archive', 'v1.0', '270-old-phase'), { recursive: true });
  fs.writeFileSync(path.join(planning, 'STATE.md'),
    `---\ngsd_state_version: 1.0\nmilestone: v2.0\nstatus: executing\n---\n\n` +
    `**Current Phase:** 20\n\n` +
    `Phase 270 was archived 2026-04-26 to phases/_archive/v1.0/.\n`);
  writeConfig(planning, { repo_type: 'hub' });

  const r = runHealth(tmpDir);
  const w002Msgs = (r.warnings || []).filter(w => w.code === 'W002').map(w => w.message);
  assert(!w002Msgs.some(m => /references phase 270\b/.test(m)),
    'hub treats archived phase 270 as valid (not W002)');
  rmrf(tmpDir);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
