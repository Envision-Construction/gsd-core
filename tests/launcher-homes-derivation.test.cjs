'use strict';

/**
 * The shell launcher's runtime-home candidate list is DERIVED from the runtime
 * descriptors, the same registry the JS resolver reads (#5169, ADR-5057 §5 "one
 * resolver", #4347).
 *
 * `_gsd_homes` used to be a hand-written copy of the JS resolver's list. It
 * drifted: it kept probing GEMINI_CONFIG_DIR after the gemini runtime was
 * retired, and it omitted zcode, pi, kimi and kimi-code. The sync script now
 * renders the function from the registry; this file proves
 *   - the committed snippet is exactly that rendering (drift fails here),
 *   - no retired-runtime env var survives anywhere the preamble ships,
 *   - and, by executing the real shell function, that for EVERY registered
 *     runtime the launcher finds the very install directory the JS resolver
 *     resolves — so the two resolvers cannot pick different installs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'gsd-core', 'bin', 'lib');
const registry = require(path.join(LIB, 'capability-registry.cjs'));
const { resolveConfigHomeFromDescriptor } = require(path.join(LIB, 'runtime-homes.cjs'));
const { LEGACY_NON_REGISTRY_RUNTIME_HOMES } = require(path.join(LIB, 'runtime-name-policy.cjs'));
const sync = require(path.join(ROOT, 'scripts', 'sync-runtime-launcher.cjs'));

const SNIPPET = path.join(ROOT, 'gsd-core', 'workflows', '_runtime-launcher.snippet.sh');
const snippetText = fs.readFileSync(SNIPPET, 'utf8');
const RUNTIMES = Object.keys(registry.runtimes);

describe('the sync only rewrites lines that are genuinely the launcher preamble', () => {
  const canonical = splitLines(snippetText).find((l) => sync.PREAMBLE_LINE_RE.test(l));

  test('the marker matches the snippet preamble line', () => {
    assert.ok(canonical, 'the snippet carries a line the marker recognizes');
  });

  test('a stale preamble line is replaced by the canonical one', () => {
    const stale = '_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="old"; echo stale';
    assert.equal(sync.replaceResolverLines(`a\n${stale}\nb`, canonical), `a\n${canonical}\nb`);
  });

  test('a line that merely starts with the variable name is left untouched', () => {
    const divergent = '_GSD_SHIM_NAME=other-tool.cjs # intentionally different';
    const doc = `a\n${divergent}\nb`;
    assert.equal(sync.replaceResolverLines(doc, canonical), doc);
  });
});

describe('_gsd_homes is rendered from the descriptors', () => {
  test('the committed snippet equals the registry rendering (no hand edits, no stale descriptors)', () => {
    const found = sync.extractHomesFunction(snippetText);
    assert.ok(found, 'the snippet carries a _gsd_homes function');
    assert.equal(found.text, sync.loadDerivedHomes());
  });

  test('rendering is deterministic and independent of registry key order', () => {
    const reversed = { runtimes: {} };
    for (const id of Object.keys(registry.runtimes).reverse()) reversed.runtimes[id] = registry.runtimes[id];
    assert.equal(
      sync.renderHomesFunction(reversed, LEGACY_NON_REGISTRY_RUNTIME_HOMES),
      sync.renderHomesFunction(registry, LEGACY_NON_REGISTRY_RUNTIME_HOMES),
    );
  });

  test('an explicit CODEX_HOME is probed first, claude next, the legacy non-registry home last', () => {
    const text = sync.loadDerivedHomes();
    const list = text.slice(text.indexOf('set -- ') + 'set -- '.length, text.indexOf('; for _h; do '));
    // The operator's own CODEX_HOME outranks the descriptor defaults
    // (#ownership-v4); when it is unset/empty the token expands to the empty
    // string and is skipped, so claude stays the first REAL home.
    assert.ok(
      list.startsWith('"${CODEX_HOME:-}" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "'),
      'explicit CODEX_HOME, then claude',
    );
    assert.ok(list.slice(list.lastIndexOf(' "')).includes('GROK_AGENTS_HOME'), 'the legacy home is the last element');
    // The registry's own codex entry keeps its id-order slot; it is NOT hoisted
    // (that would change other-host precedence when CODEX_HOME is unset).
    const claudeDefault = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
    const codexDefault = '"${CODEX_HOME:-$HOME/.codex}"';
    assert.equal(list.split(codexDefault).length - 1, 1, 'the codex descriptor default appears exactly once');
    assert.ok(
      list.indexOf(codexDefault) > list.indexOf(claudeDefault),
      'the codex descriptor default stays after claude',
    );
  });

  test('the shim suffix is written once, in the loop body, not once per home (the preamble ships in ~240 files)', () => {
    const text = sync.loadDerivedHomes();
    assert.equal(text.split('/gsd-core/bin/').length - 1, 1);
    // The probe path is built per non-empty home only: an empty candidate (the
    // unset/blank CODEX_HOME probe) is skipped BEFORE `"$_h/gsd-core/bin/…"` is
    // constructed, so it can never collapse to `/gsd-core/bin/gsd-tools.cjs`.
    assert.ok(
      text.endsWith(
        '; for _h; do [ -n "$_h" ] || continue; _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }',
      ),
    );
    // No `for x in <list>` header: the #4109 structural lint flags any such list containing a `$`.
    assert.ok(!/\bfor\s+\w+\s+in\s/.test(text));
  });

  test('every registered runtime with a file-projected home contributes its env override', () => {
    const text = sync.loadDerivedHomes();
    let contributing = 0;
    for (const id of RUNTIMES) {
      const configHome = registry.runtimes[id].runtime.configHome;
      if (!configHome || configHome.kind === 'none') continue;
      assert.ok(configHome.env.length > 0, `${id} declares an env override`);
      assert.ok(text.includes('${' + configHome.env[0] + ':-'), `${id} (${configHome.env[0]}) must be probed`);
      contributing += 1;
    }
    assert.ok(contributing >= 18);
  });

  test('a runtime with no file-projected home (kind "none") contributes nothing', () => {
    const fake = { runtimes: { ide: { runtime: { configHome: { kind: 'none', name: 'ide', env: [] } } } } };
    const text = sync.renderHomesFunction(fake, {});
    const list = text.slice(text.indexOf('set -- ') + 'set -- '.length, text.indexOf('; for _h; do '));
    // The descriptor contributes no home: the only element is the mandated
    // explicit-CODEX_HOME probe, which expands to the empty string when unset,
    // so "kind: none" still probes nothing.
    assert.equal(list, `"${sync.EXPLICIT_CODEX_HOME_PROBE}"`);
    assert.ok(!text.includes('$HOME'), 'kind "none" must not synthesize a default home');
  });

  test('every descriptor value rendered into shell is a plain identifier or path segment (no shell metacharacters)', () => {
    // renderHomesFunction does not shell-escape: it is safe because the registry is first-party
    // and these fields are plain tokens. This pins that precondition so a descriptor edit that
    // introduced a quote, `$(`, backtick or `;` fails here instead of reaching every workflow.
    const ENV = /^[A-Z][A-Z0-9_]*$/;
    const SEGMENT = /^[A-Za-z0-9._~/-]+$/;
    for (const id of RUNTIMES) {
      const configHome = registry.runtimes[id].runtime.configHome;
      if (!configHome || configHome.kind === 'none') continue;
      for (const name of configHome.env) assert.match(name, ENV, `${id} env ${name}`);
      for (const field of [configHome.name, configHome.parent, ...(configHome.probe || [])]) {
        if (field === undefined) continue;
        assert.match(field, SEGMENT, `${id} path segment ${field}`);
      }
    }
    for (const [id, legacy] of Object.entries(LEGACY_NON_REGISTRY_RUNTIME_HOMES)) {
      assert.match(legacy.env, ENV, `${id} env`);
      for (const segment of legacy.dir) assert.match(segment, SEGMENT, `${id} dir ${segment}`);
    }
  });

  test('the retired gemini runtime is no longer probed (#4347)', () => {
    assert.ok(!snippetText.includes('GEMINI_CONFIG_DIR'));
    for (const id of RUNTIMES) assert.ok(!registry.runtimes[id].runtime.configHome.env.includes('GEMINI_CONFIG_DIR'));
  });

  test('the resolver reference and every command template carry the canonical preamble line (no older fixed-list copy)', () => {
    const preambleLine = sync.loadPreamble()[0];
    const offenders = [];
    const check = (file) => {
      for (const line of splitLines(fs.readFileSync(file, 'utf8'))) {
        if (/^_GSD_SHIM_NAME=/.test(line) && line !== preambleLine) offenders.push(path.relative(ROOT, file));
      }
    };
    check(path.join(ROOT, 'gsd-core', 'references', 'gsd-run-resolver.md'));
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md')) check(full);
      }
    };
    walk(path.join(ROOT, 'commands'));
    assert.deepEqual(offenders, []);
  });

  test('no shipped workflow, agent or command carries the retired env var', () => {
    const offenders = [];
    for (const dir of ['gsd-core/workflows', 'agents', 'commands']) {
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.md') || entry.name.endsWith('.sh')) {
            if (fs.readFileSync(full, 'utf8').includes('GEMINI_CONFIG_DIR')) offenders.push(path.relative(ROOT, full));
          }
        }
      };
      walk(path.join(ROOT, dir));
    }
    assert.deepEqual(offenders, []);
  });
});

describe('the launcher finds the install the JS resolver resolves, for every runtime', () => {
  const homesPrefix = (() => {
    const end = snippetText.indexOf('; if _gsd_at');
    return snippetText.slice(0, end + 1);
  })();

  function runLauncher(home) {
    const script = `${homesPrefix} _gsd_homes && printf '%s' "$GSD_TOOLS"`;
    return spawnSync('sh', ['-c', script], {
      cwd: home,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      // A minimal environment: no *_CONFIG_DIR / *_HOME override, so the
      // descriptor defaults (`$HOME/.<dir>`) are what is probed.
      env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH || '/usr/bin:/bin' },
    });
  }

  const skipShell = process.platform === 'win32' ? 'POSIX shell launcher' : false;

  for (const id of RUNTIMES) {
    const configHome = registry.runtimes[id].runtime.configHome;
    if (!configHome || configHome.kind === 'none') continue;
    test(`${id}: _gsd_homes resolves ${configHome.kind} home identically to the JS resolver`, { skip: skipShell }, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
      try {
        // Make the descriptor's own probe marker true so the JS resolver picks this dir
        // (probeExists is `gsd-core/VERSION` or `skills`, depending on the kind).
        const jsDir = resolveConfigHomeFromDescriptor(configHome, {
          env: {},
          home,
          existsSync: (p) => fs.existsSync(p),
        });
        fs.mkdirSync(path.join(jsDir, 'gsd-core', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(jsDir, 'gsd-core', 'bin', 'gsd-tools.cjs'), '// fixture\n');
        fs.writeFileSync(path.join(jsDir, 'gsd-core', 'VERSION'), '0.0.0\n');
        if (configHome.probeExists) {
          // The resolver only tests existence of `<dir>/<probeExists>`; a marker FILE satisfies it for
          // both the `gsd-core/VERSION` and the `skills` spellings (mkdir would collide with VERSION).
          const marker = path.join(jsDir, configHome.probeExists);
          fs.mkdirSync(path.dirname(marker), { recursive: true });
          if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
        }
        // Re-resolve now that the markers exist: the JS resolver and the launcher must agree.
        const jsAfter = resolveConfigHomeFromDescriptor(configHome, { env: {}, home, existsSync: (p) => fs.existsSync(p) });
        const result = runLauncher(home);
        assert.equal(result.status, 0, `launcher exited ${result.status}: ${result.stderr}`);
        assert.equal(
          fs.realpathSync(result.stdout),
          fs.realpathSync(path.join(jsAfter, 'gsd-core', 'bin', 'gsd-tools.cjs')),
        );
      } finally {
        cleanup(home);
      }
    });
  }

  for (const [id, legacy] of Object.entries(LEGACY_NON_REGISTRY_RUNTIME_HOMES)) {
    test(`${id}: the legacy non-registry home is probed`, { skip: skipShell }, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
      try {
        const dir = path.join(home, ...legacy.dir);
        fs.mkdirSync(path.join(dir, 'gsd-core', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'gsd-core', 'bin', 'gsd-tools.cjs'), '// fixture\n');
        const result = runLauncher(home);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.realpathSync(result.stdout), fs.realpathSync(path.join(dir, 'gsd-core', 'bin', 'gsd-tools.cjs')));
      } finally {
        cleanup(home);
      }
    });
  }

  test('with no install anywhere the function reports failure (a miss is not a silent success)', { skip: skipShell }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
    try {
      const result = runLauncher(home);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.includes('gsd-tools.cjs') && fs.existsSync(result.stdout), false);
    } finally {
      cleanup(home);
    }
  });

  test('an env override wins over the default home (the same precedence as the JS resolver)', { skip: skipShell }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
    try {
      const custom = path.join(home, 'custom-claude');
      fs.mkdirSync(path.join(custom, 'gsd-core', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(custom, 'gsd-core', 'bin', 'gsd-tools.cjs'), '// fixture\n');
      const script = `${homesPrefix} _gsd_homes && printf '%s' "$GSD_TOOLS"`;
      const result = spawnSync('sh', ['-c', script], {
        cwd: home,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH || '/usr/bin:/bin', CLAUDE_CONFIG_DIR: custom },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.realpathSync(result.stdout), fs.realpathSync(path.join(custom, 'gsd-core', 'bin', 'gsd-tools.cjs')));
    } finally {
      cleanup(home);
    }
  });

  // The explicit-CODEX_HOME probe renders an element that is EMPTY when
  // CODEX_HOME is unset or blank. `"$_h/gsd-core/bin/…"` would then collapse to
  // the filesystem-root probe `/gsd-core/bin/gsd-tools.cjs`, which is a real
  // directory on some images. This test records the ACTUAL candidate paths the
  // loop attempts, so the bogus root probe is caught even though `/gsd-core`
  // does not exist on the test host (an existence probe could never see it).
  test('unset/empty CODEX_HOME never attempt a filesystem-root /gsd-core candidate', { skip: skipShell }, () => {
    const attempted = (env) => {
      const script = [
        homesPrefix,
        '_gsd_at() { for _p; do printf \'%s\\n\' "$_p"; done; return 1; }',
        '_gsd_homes || true',
      ].join('\n');
      const result = spawnSync('sh', ['-c', script], {
        cwd: os.tmpdir(),
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        env: {
          HOME: '/nonexistent-gsd-home',
          USERPROFILE: '/nonexistent-gsd-home',
          PATH: process.env.PATH || '/usr/bin:/bin',
          ...env,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.split('\n').filter(Boolean);
    };

    const claudeCandidate = path.join('/nonexistent-gsd-home', '.claude', 'gsd-core', 'bin', 'gsd-tools.cjs');
    for (const [label, env] of [['unset', {}], ['empty', { CODEX_HOME: '' }]]) {
      const paths = attempted(env);
      assert.ok(paths.length > 0, `${label}: _gsd_homes must still attempt the descriptor homes`);
      for (const p of paths) {
        assert.notEqual(p, '/gsd-core/bin/gsd-tools.cjs', `${label}: empty home collapsed to the filesystem-root probe`);
        assert.ok(!p.startsWith('/gsd-core/'), `${label}: filesystem-root candidate leaked: ${p}`);
        assert.ok(!p.includes('//'), `${label}: malformed doubled-slash candidate: ${p}`);
      }
      assert.equal(paths[0], claudeCandidate, `${label}: claude remains the first real candidate`);
    }

    // A SET CODEX_HOME is still attempted first, before claude.
    const codex = path.join(os.tmpdir(), 'gsd-codex-home-fixture');
    const withCodex = attempted({ CODEX_HOME: codex });
    assert.equal(
      withCodex[0],
      path.join(codex, 'gsd-core', 'bin', 'gsd-tools.cjs'),
      'an explicit CODEX_HOME must remain the first attempted candidate',
    );
  });
});
