'use strict';

/**
 * Ownership preflight v4 projection + optional JEV advisory entry.
 *
 * Pins:
 *   1. ONE compact, workflow-neutral v4 block per ownership-gated entry, placed
 *      AFTER that workflow's own `gsd_run` resolver so the resolver always
 *      precedes the preflight and every side effect.
 *   2. The quick-path advice is the ONLY quick-specific fragment.
 *   3. The optional JEV fragment (FULL on commands, LAZY ref on workflows) follows
 *      the ownership block, is offline-first, and is never an authority.
 *   4. The frozen v3 predecessor bytes and the vendored JEV full bytes.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const gen = require('../scripts/gen-ownership-preflight.cjs');
const oc = require('../gsd-core/bin/lib/owner-context.cjs');
const { cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { loadPreamble } = require('../scripts/sync-runtime-launcher.cjs');
const { buildOwnerContext } = require('../gsd-core/bin/lib/owner-context.cjs');

const ROOT = path.join(__dirname, '..');
const V3_SHA256 = '1907ca2ce4318325ed6303b5b734ab9bc8f50bff7c615879827398ca2f00561e';
const JEV_SHA256 = 'be775c97de7d2e4097a618afbc60181875db0a3020b7fdad30231da9162df572';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const count = (hay, needle) => hay.split(needle).length - 1;

const jevCarriers = (kind) => gen.CARRIERS.filter((c) => c.jev === kind);

describe('ownership preflight v4 projection', () => {
  test('every carrier carries exactly one v4 ownership region', () => {
    for (const c of gen.CARRIERS) {
      const text = read(c.path);
      assert.equal(count(text, gen.OWN_START), 1, `${c.path}: ownership start marker count`);
      assert.equal(count(text, gen.OWN_END), 1, `${c.path}: ownership end marker count`);
      assert.equal(count(text, '<ownership_preflight>'), 1, c.path);
      assert.equal(count(text, '</ownership_preflight>'), 1, c.path);
      assert.ok(text.includes('gsd_run owner-context preflight'), c.path);
      assert.ok(text.includes('owner_context_refused'), c.path);
      assert.ok(!/OWNERSHIP-RUNTIME-PREFLIGHT v3/.test(text), `${c.path}: v3 marker must be gone`);
    }
  });

  test('a workflow resolver precedes the ownership block, and the block names it', () => {
    for (const c of gen.CARRIERS.filter((x) => x.kind === 'workflow')) {
      const text = read(c.path);
      const block = text.indexOf(gen.OWN_START);
      const inline = text.indexOf('_GSD_SHIM_NAME=');
      const ref = text.indexOf('gsd-run-resolver.md');
      const resolver = inline >= 0 ? inline : ref;
      assert.ok(resolver >= 0, `${c.path}: no gsd_run resolver bootstrap found`);
      assert.ok(resolver < block, `${c.path}: resolver must resolve before the ownership preflight`);
      assert.ok(
        text.includes('Resolve `gsd_run` (this workflow\'s bootstrap) first'),
        `${c.path}: block must name the bootstrap ordering`,
      );
    }
  });

  test('quick-path advice is the only quick-specific fragment', () => {
    for (const c of gen.CARRIERS) {
      const text = read(c.path);
      const hasQuick = text.includes('Quick tasks: read `quick_dir`');
      assert.equal(hasQuick, c.quick === true, `${c.path}: quick advice placement`);
      if (!c.quick) assert.ok(!text.includes('`.planning/quick`'), `${c.path}: leaked quick advice`);
    }
  });

  test('JEV fragment placement: FULL on commands, LAZY ref on workflows, absent elsewhere', () => {
    for (const c of gen.CARRIERS) {
      const text = read(c.path);
      assert.equal(count(text, gen.JEV_START), c.jev ? 1 : 0, `${c.path}: JEV region count`);
      if (!c.jev) continue;
      assert.equal(count(text, gen.JEV_END), 1, c.path);
      assert.ok(text.indexOf(gen.JEV_START) > text.indexOf(gen.OWN_END), `${c.path}: JEV must follow ownership`);
      assert.ok(text.includes('gsd_run jev-advisory prepare --scenario <id> --entry <'), `${c.path}: prepare spelling`);
      assert.match(text, /offline/i, `${c.path}: prepare must be documented offline`);
      assert.match(text, /never changes owner\s+selection/, c.path);
      assert.ok(text.includes('advisory-only') || text.includes('advisory_only'), c.path);
      if (c.jev === 'full') {
        assert.ok(text.includes('gsd_run jev-advisory evaluate --scenario <id> --entry <entry-kind>'), `${c.path}: full needs evaluate`);
        assert.ok(text.includes('authorizes_mutation: false'), c.path);
      } else {
        assert.ok(text.includes('`authorizes_mutation: false`'), `${c.path}: ref keeps the authority line`);
        assert.ok(text.includes('entry-guidance.md'), `${c.path}: ref points at the canonical fragment`);
      }
    }
    assert.equal(jevCarriers('full').length, 4, 'FULL JEV on the quick/fast/plan-phase/execute-phase commands');
    assert.equal(jevCarriers('ref').length, 4, 'LAZY JEV on the quick/fast/execute-phase/execute-plan workflows');
  });

  test('committed carriers match the templates', () => {
    for (const [rel, want] of gen.buildFresh()) {
      assert.equal(read(rel), want, `${rel}: run node scripts/gen-ownership-preflight.cjs --write`);
    }
  });

  test('v3 predecessor bytes are preserved for downstream migration (single accepted hash)', () => {
    const b = fs.readFileSync(gen.OWN_TEMPLATE_V3);
    // The file IS the exact predecessor block bytes: no trailing newline, so the
    // file hash and the block hash are the SAME single hash (1907ca2c…). This
    // reconciles the earlier file-with-LF hash (669775…) that was reported; only
    // the 1907ca2c… predecessor is accepted (no broadening).
    assert.notEqual(b[b.length - 1], 10, 'v3 template must not carry a trailing newline');
    assert.equal(b.toString('utf8').length, 1217, 'v3 predecessor character length');
    assert.equal(crypto.createHash('sha256').update(b).digest('hex'), V3_SHA256, 'v3 predecessor bytes changed');
    assert.ok(b.toString('utf8').startsWith('<!-- OWNERSHIP-RUNTIME-PREFLIGHT v3'), 'v3 marker');
  });

  test('JEV full fragment is vendored byte-exact', () => {
    const b = fs.readFileSync(gen.JEV_TEMPLATE);
    assert.equal(crypto.createHash('sha256').update(b).digest('hex'), JEV_SHA256, 'JEV snippet bytes changed');
  });

  test('generated skills inherit the region for their command carriers', () => {
    for (const c of gen.CARRIERS.filter((x) => x.kind === 'command')) {
      const skill = path.join(ROOT, 'skills', `gsd-${path.basename(c.path, '.md')}`, 'SKILL.md');
      if (!fs.existsSync(skill)) continue;
      const text = fs.readFileSync(skill, 'utf8');
      assert.ok(text.includes(gen.OWN_START), `${c.path}: generated skill missing ownership region`);
      assert.equal(count(text, gen.JEV_START), c.jev ? 1 : 0, `${c.path}: generated skill JEV placement`);
    }
  });
});

describe('ownership entry coverage and JEV entry negativity', () => {
  test('existing CLI classification is unchanged (entry launchers stay non-mutating)', () => {
    assert.equal(oc.isMutatingCommand('quick', []), false);
    assert.equal(oc.isMutatingCommand('fast', []), false);
    assert.equal(oc.isMutatingCommand('plan-phase', []), false);
    assert.equal(oc.isMutatingCommand('execute-phase', []), false);
    assert.equal(oc.isMutatingCommand('progress', []), false);
    assert.equal(oc.isMutatingCommand('commit', []), true);
  });

  test('the normal entry path resolves gsd_run, then preflight, then refuses before a write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-own-entry-'));
    const stateFile = path.join(dir, '.planning', 'STATE.md');
    try {
      fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
      fs.writeFileSync(stateFile, '# STATE\n');
      fs.writeFileSync(
        path.join(dir, '.planning', 'owner-policy.json'),
        JSON.stringify({ policy_version: '1.0.0', mode: 'enforce', known_owners: [{ repo_id: 'local:not-this-repo' }] }),
      );
      const tools = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
      // 1) The resolved-runtime preflight (the step every entry block names).
      let preflightRefused = false;
      let preflightErr = '';
      try {
        execFileSync('node', [tools, 'owner-context', 'preflight', '--json-errors'], {
          cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS,
        });
      } catch (err) {
        preflightRefused = true;
        preflightErr = String(err.stderr || err.stdout || '');
      }
      assert.ok(preflightRefused, 'the entry preflight must refuse under mismatched enforce');
      assert.ok(preflightErr.includes('owner_context_refused'), `preflight: ${preflightErr.slice(0, 200)}`);
      // 2) A writer the plan/execute entry invokes must then refuse BEFORE any write.
      let writerRefused = false;
      let writerErr = '';
      try {
        execFileSync('node', [tools, 'state', 'update', 'last_action', 'x', '--json-errors'], {
          cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS,
        });
      } catch (err) {
        writerRefused = true;
        writerErr = String(err.stderr || err.stdout || '');
      }
      assert.ok(writerRefused, 'the writer must refuse under mismatched enforce');
      assert.ok(writerErr.includes('owner_context_refused'), `writer: ${writerErr.slice(0, 200)}`);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), '# STATE\n', 'refusal must precede any write');
    } finally {
      cleanup(dir);
    }
  });

  test('projecting/reading the carriers performs zero provider requests', () => {
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => { calls += 1; throw new Error('no network during projection'); };
    try {
      const g = require('../scripts/gen-ownership-preflight.cjs');
      g.buildFresh();
      for (const c of g.CARRIERS) read(c.path);
      buildOwnerContext(ROOT, { deps: { execGit: () => ({ exitCode: 1, stdout: '' }) } });
    } finally {
      globalThis.fetch = orig;
    }
    assert.equal(calls, 0, 'projection/read must make zero network calls');
  });

  test('explicit CODEX_HOME wins over a conflicting valid Claude home at normal entry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-resolver-order-'));
    try {
      const project = path.join(root, 'project');
      fs.mkdirSync(project); // no local gsd-core → the resolver must use the homes
      const claude = path.join(root, 'claude-home');
      const codex = path.join(root, 'codex-home');
      for (const home of [claude, codex]) {
        const tools = path.join(home, 'gsd-core', 'bin', 'gsd-tools.cjs');
        fs.mkdirSync(path.dirname(tools), { recursive: true });
        fs.writeFileSync(tools, 'console.log(JSON.stringify({packageName:"@opengsd/gsd-core"}));');
      }
      const shell = `${loadPreamble().join('\n')}\nprintf "%s" "$GSD_TOOLS"`;
      const baseEnv = {
        PATH: process.env.PATH,
        HOME: path.join(root, 'home'),
        RUNTIME_DIR: project,
        CLAUDE_CONFIG_DIR: claude,
      };
      const claudeTools = path.join(claude, 'gsd-core', 'bin', 'gsd-tools.cjs');
      const codexTools = path.join(codex, 'gsd-core', 'bin', 'gsd-tools.cjs');

      // (1) An EXPLICIT CODEX_HOME wins over the equally-valid Claude home.
      const withCodex = runHook('-c', [shell], {
        interpreter: 'bash', cwd: project, env: { ...baseEnv, CODEX_HOME: codex },
      });
      assert.equal(withCodex.exitCode, 0, withCodex.stderr);
      assert.equal(withCodex.stdout.replace(/\\/g, '/').replace(/\/+$/, ''), codexTools.replace(/\\/g, '/'), 'explicit CODEX_HOME must win');

      // (2) Unset OR empty CODEX_HOME leaves the other-host precedence unchanged.
      for (const env of [baseEnv, { ...baseEnv, CODEX_HOME: '' }]) {
        const noCodex = runHook('-c', [shell], { interpreter: 'bash', cwd: project, env });
        assert.equal(noCodex.exitCode, 0, noCodex.stderr);
        assert.equal(
          noCodex.stdout.replace(/\\/g, '/').replace(/\/+$/, ''),
          claudeTools.replace(/\\/g, '/'),
          'unset/empty CODEX_HOME must not change other-host precedence',
        );
      }
    } finally {
      cleanup(root);
    }
  });
});
