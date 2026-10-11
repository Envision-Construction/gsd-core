'use strict';

/**
 * Ownership-runtime projection, verified against REAL isolated installs.
 *
 * The canonical quick/fast/quick-batch sources live in this repo; the runtime
 * hosts (Claude, OpenCode, Antigravity, Codex, …) receive them through the
 * existing installer. A marker-only source check cannot prove the emitted
 * surface actually carries the ownership block, so these tests run the real
 * installer into a sandboxed HOME and read the emitted files back.
 *
 * Gemini note (#1928): the Gemini CLI runtime was removed and `--gemini` is a
 * redirect stub with no runtime surface; Antigravity CLI is its successor. The
 * last test pins that so a future "verify Gemini" claim cannot silently pass
 * against a runtime that does not exist.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runMinimalInstall,
  RUNTIME_META,
  INSTALL_SCRIPT,
  installerEnv,
} = require('./helpers/install-shared.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const WORKFLOWS = ['gsd-core/workflows/quick.md', 'gsd-core/workflows/fast.md', 'gsd-core/workflows/quick-batch.md'];
const MARKER = /<!-- OWNERSHIP-RUNTIME-PREFLIGHT v(\d+) \(patch-gsd-ownership-runtime\) -->/;

function assertCompleteBlock(text, label) {
  const m = text.match(MARKER);
  assert.ok(m, `${label}: ownership-preflight marker absent`);
  assert.ok(text.includes(`<!-- /OWNERSHIP-RUNTIME-PREFLIGHT -->`), `${label}: end marker absent`);
  assert.ok(text.includes('<ownership_preflight>'), `${label}: open tag absent`);
  assert.ok(text.includes('</ownership_preflight>'), `${label}: close tag absent`);
  assert.ok(/gsd_run owner-context preflight/.test(text), `${label}: preflight invocation absent`);
  assert.ok(text.includes('quick_dir'), `${label}: core-resolved quick_dir absent`);
}

// One install per runtime, reused across the assertions below.
const emitted = new Map();
function installFor(runtime) {
  if (emitted.has(runtime)) return emitted.get(runtime);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-ownproj-${runtime}-`));
  let rec;
  try {
    runMinimalInstall({ runtime, scope: 'global', root });
    rec = {
      root,
      base: path.join(root, RUNTIME_META[runtime].globalSuffix),
    };
  } catch (err) {
    cleanup(root);
    throw err;
  }
  emitted.set(runtime, rec);
  return rec;
}

// These install roots are OWNED fixtures this file created — clean them up so a
// full run does not leak six temp trees. A failed-inspection run can preserve
// them by setting GSD_OWNPROJ_KEEP_ARTIFACTS=1 (the roots are printed).
after(() => {
  const keep = process.env.GSD_OWNPROJ_KEEP_ARTIFACTS === '1';
  for (const rec of emitted.values()) {
    if (keep) process.stdout.write(`ownership-runtime-projection: kept fixture ${rec.root}\n`);
    else cleanup(rec.root);
  }
  emitted.clear();
});

describe('ownership-runtime projection reaches real emitted surfaces', () => {
  test('the installed distribution includes the compiled owner-context module and the dispatch gate', () => {
    for (const runtime of ['claude', 'opencode', 'antigravity', 'codex', 'cursor', 'pi']) {
      const { base } = installFor(runtime);
      const modulePath = path.join(base, 'gsd-core', 'bin', 'lib', 'owner-context.cjs');
      assert.ok(fs.existsSync(modulePath), `${runtime}: compiled owner-context.cjs not installed`);
      // allow-test-rule: the installed gsd-tools.cjs IS the product surface under test (#4) — reading the emitted file is the assertion
      const tools = fs.readFileSync(path.join(base, 'gsd-core', 'bin', 'gsd-tools.cjs'), 'utf8');
      // allow-test-rule: asserting the emitted dispatch gate is present (#4) — the installed text is the product
      assert.ok(/assertOwnerContextForWrite/.test(tools),
        `${runtime}: installed gsd-tools.cjs has no owner-context dispatch gate`);
      // allow-test-rule: asserting the emitted classifier is present (#4) — the installed text is the product
      assert.ok(/isMutatingCommand/.test(tools),
        `${runtime}: installed gsd-tools.cjs has no mutating-command classifier`);
    }
  });

  for (const runtime of ['opencode', 'antigravity', 'codex', 'cursor', 'pi']) {
    test(`${runtime}: emitted quick/fast/quick-batch carry the complete ownership block`, () => {
      const { base } = installFor(runtime);
      for (const rel of WORKFLOWS) {
        const file = path.join(base, rel);
        assert.ok(fs.existsSync(file), `${runtime}: ${rel} not emitted`);
        assertCompleteBlock(fs.readFileSync(file, 'utf8'), `${runtime}:${rel}`);
      }
    });
  }

  test('emitted workflow bodies no longer hard-code a root .planning/quick path', () => {
    for (const runtime of ['opencode', 'antigravity', 'codex', 'cursor', 'pi']) {
      const { base } = installFor(runtime);
      for (const rel of WORKFLOWS) {
        const text = fs.readFileSync(path.join(base, rel), 'utf8');
        // The one allowed mention is the block's own explanatory sentence
        // ("A hard-coded `.planning/quick` bypasses …"), which is inside the
        // ownership block. Strip it, then assert no CODE-shaped literal
        // remains — prose in <purpose> may still describe where quick tasks
        // live, but no execution path may read or list the literal dir.
        const withoutBlock = text.replace(
          /<!-- OWNERSHIP-RUNTIME-PREFLIGHT[\s\S]{0,4000}?<!-- \/OWNERSHIP-RUNTIME-PREFLIGHT -->/g,
          '',
        );
        for (const bad of [
          'ls -d .planning/quick',
          'frontmatter.get .planning/quick',
          'Plan file: .planning/quick',
          'Resuming: .planning/quick',
        ]) {
          assert.ok(!withoutBlock.includes(bad),
            `${runtime}:${rel} still reaches a literal path via "${bad}"`);
        }
      }
    }
  });

  test('--gemini is a redirect stub: no gemini runtime surface is produced', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ownproj-gemini-'));
    try {
      const result = runNode([INSTALL_SCRIPT, '--gemini', '--global'], {
        cwd: root,
        env: installerEnv({ HOME: root, USERPROFILE: root }),
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      assert.notEqual(result.exitCode, 0, '--gemini alone must not silently install');
      assert.match(result.stderr || '', /Antigravity/i, 'redirect notice names the successor runtime');
      assert.equal(fs.existsSync(path.join(root, '.gemini', 'commands', 'gsd')), false,
        'no gemini commands surface is created');
    } finally {
      cleanup(root);
    }
  });
});
