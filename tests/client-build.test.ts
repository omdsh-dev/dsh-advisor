/**
 * Client bundle contract (plan dsh-advisor-settings-n2, task 2 — KD-S5).
 * The build script (`scripts/build-client.mjs`) emits the closure-factory CJS
 * artifact the dsh web loader consumes; this test re-runs the build and
 * asserts the artifact contract:
 * - `lib/client.js` exists after the build;
 * - it calls `window.__ModuleLoader__.load({ id: 'dsh-advisor', factory })`;
 * - it is classic-script-safe: no `import.meta` and no top-level ESM
 *   `import`/`export` statements (the loader executes bundles as classic
 *   scripts, where either is a parse-time SyntaxError);
 * - purity: every `require('@deepseek-ai/…')` it emits names one of the
 *   frozen `CLIENT_EXTERNALS` entries (the platform seed table + the
 *   documented `@deepseek-ai/dsh-client-runtime/client` exemption) — any
 *   other `@deepseek-ai/*` VALUE import is a build error by contract
 *   (cross-plugin collaboration goes through cordis services; type-only
 *   imports are erased before resolution and never reach the bundle).
 *
 * The frozen table is deliberately restated here: it is the contract the
 * artifact is pinned to, independent of the build script's own copy.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

/** Frozen loader module table (mirror of dsh-private `web/src/platform.ts` + the runtime/client exemption). */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Bundled entry id stamped into the load handoff. */
const BUNDLE_ID = 'dsh-advisor'

/** True when the client program contains `.tsx` sources (JSX must then compile to the automatic runtime). */
function programHasTsx(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && programHasTsx(resolve(dir, entry.name))) return true
    if (entry.isFile() && entry.name.endsWith('.tsx')) return true
  }
  return false
}

describe('client bundle contract (scripts/build-client.mjs)', () => {
  it('builds lib/client.js from src/client/index.ts', () => {
    const result = spawnSync('node', ['scripts/build-client.mjs'], {
      cwd: repo,
      encoding: 'utf8',
    })
    expect(result.status, `build exit 0 — stderr:\n${result.stderr}`).toBe(0)
    const artifact = resolve(repo, 'lib/client.js')
    expect(existsSync(artifact), 'lib/client.js exists after the build').toBe(true)
  })

  it('emits the closure-factory load handoff with the dsh-advisor id', () => {
    const bundle = readFileSync(resolve(repo, 'lib/client.js'), 'utf8')
    expect(bundle).toContain('window.__ModuleLoader__.load(')
    expect(bundle).toContain(BUNDLE_ID)
  })

  it('is classic-script-safe: no import.meta and no top-level ESM statements', () => {
    const bundle = readFileSync(resolve(repo, 'lib/client.js'), 'utf8')
    expect(bundle).not.toContain('import.meta')
    expect(/(^|\n)\s*(import|export)\s/.test(bundle), 'no ESM import/export statements').toBe(false)
  })

  it('keeps the @deepseek-ai purity boundary: requires only name CLIENT_EXTERNALS entries', () => {
    const bundle = readFileSync(resolve(repo, 'lib/client.js'), 'utf8')
    const requires = [...bundle.matchAll(/require\(\s*["'](@deepseek-ai\/[^"']+)["']\s*\)/g)]
      .map((match) => match[1] as string)
    const offenders = [...new Set(requires)].filter((specifier) => !CLIENT_EXTERNALS.includes(specifier))
    expect(offenders, 'no @deepseek-ai value import outside the frozen externals table').toEqual([])
    // The type-only packages must never surface as runtime requires.
    for (const forbidden of [
      'dsh-client-connection', 'dsh-client-locale', 'dsh-client-ui-settings', 'dsh-client-ui-plugin-config',
    ]) {
      expect(bundle, `no require of @deepseek-ai/${forbidden}`).not.toContain(`require("@deepseek-ai/${forbidden}`)
    }
  })

  it('compiles .tsx with the automatic JSX runtime: requires react/jsx-runtime, no free React global', () => {
    // T2 review Critical-1: the CLASSIC transform emits a free
    // `React.createElement` global that the loader module table does not
    // provide (it answers `react/jsx-runtime`, frozen in CLIENT_EXTERNALS,
    // but never a `React` global) -> `ReferenceError: React is not defined`
    // on first render. Whenever the program contains .tsx sources, the
    // bundle MUST require the automatic runtime and MUST NOT reference the
    // free-global pattern.
    const bundle = readFileSync(resolve(repo, 'lib/client.js'), 'utf8')
    if (!programHasTsx(resolve(repo, 'src/client'))) return // no JSX in program: nothing to assert
    expect(bundle, 'bundle requires react/jsx-runtime (automatic JSX runtime)').toMatch(
      /require\(\s*["']react\/jsx-runtime["']\s*\)/,
    )
    expect(bundle, 'no free-global React.createElement in the bundle').not.toMatch(/React\.createElement/)
  })

  it('inlines CSS Modules: style-injection wiring and hashed class-map export reach the bundle', () => {
    // plan dsh-advisor-plugin-config-card, task 2: the dsh-css-modules-inline
    // plugin compiles `*.module.css` (the advisor card imports
    // src/client/advisor-card.module.css) with lightningcss ([hash]_[local]
    // pattern, minified) and emits a guarded `<style data-plugin>` injection
    // stub that runs at factory execution. The loader cleans up plugin-owned
    // tags by `style[data-plugin=<id>]` + per-module `data-plugin-css`, so
    // the bundle MUST carry that wiring or the card renders unstyled.
    const bundle = readFileSync(resolve(repo, 'lib/client.js'), 'utf8')
    // F-1 regression (QC consolidated): the artifact must carry neither a raw
    // NUL byte nor the builder's absolute machine path — esbuild's virtual
    // CSS-module comment (`// dsh-css-modules:\0<abs path>.mjs`) leaks both and
    // the build script strips it before writing the artifact.
    expect(bundle, 'no raw NUL byte in the artifact (virtual-module comment stripped)').not.toContain('\u0000')
    expect(bundle, 'no builder machine path leak in the artifact').not.toContain('/Users/')
    // Idempotent injection: one <style> per module file, guarded by a
    // data-plugin-css presence check. Quote-agnostic: esbuild's printer
    // normalizes JS string quotes, so accept both.
    expect(bundle).toMatch(/document\.createElement\(['"]style['"]\)/)
    expect(bundle).toContain('data-plugin')
    expect(bundle).toContain('document.head.appendChild')
    // F-2 (QC consolidated): pin the attribution the loader cleanup keys on —
    // the web shell removes plugin-owned tags by `style[data-plugin=<id>]`, so
    // the stub must actually assign tag.dataset.plugin, not merely contain the
    // literal "data-plugin". Quote/whitespace-normalized assignment form.
    expect(bundle, 'tag.dataset.plugin attribution (loader cleanup key)').toMatch(/tag\.dataset\.plugin\s*=/)
    // tagId wiring: dsh-advisor/<basename> (the card css replaced the removed
    // section css — same commit, else the build gate fails).
    expect(bundle).toContain('dsh-advisor/advisor-card.module.css')
    // Hashed class-map export ([hash]_[local]): the card classes reach the
    // bundle as hashed names, and the map keys preserve the local names.
    expect(bundle).toMatch(/_card/)
    expect(bundle).toMatch(/_(card|title|intro|field|input|selectInput)/)
    expect(bundle).toMatch(/"card": "[A-Za-z0-9]+_card"/)
    expect(bundle).toContain('"card"')
    expect(bundle).toContain('"title"')
  })

  it('declares the dsh.client client-bundle contract', () => {
    // plan dsh-advisor-settings-ui-n3, task 3 (T3-1.5): the upstream host
    // reads the client-bundle declaration from `pkg.dsh.client` with NO
    // `dshClient` backward-compat fallback — the legacy top-level field must
    // stay gone or the advisor client half would not load after restart.
    const pkg = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as {
      dsh?: { client?: { inject?: string[]; platform?: string } }
      dshClient?: unknown
    }
    expect(pkg.dsh?.client, 'pkg.dsh.client exists').toBeTruthy()
    expect(typeof pkg.dsh?.client, 'pkg.dsh.client is an object').toBe('object')
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(pkg.dsh?.client?.inject).toEqual(
      expect.arrayContaining([
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-settings',
        '@deepseek-ai/dsh-client-locale',
      ]),
    )
    expect(pkg.dshClient, 'legacy top-level dshClient field is gone').toBeUndefined()
  })
})
