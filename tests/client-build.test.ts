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
import { existsSync, readFileSync } from 'node:fs'
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
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Bundled entry id stamped into the load handoff. */
const BUNDLE_ID = 'dsh-advisor'

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
    for (const forbidden of ['dsh-client-connection', 'dsh-client-locale', 'dsh-client-ui-settings']) {
      expect(bundle, `no require of @deepseek-ai/${forbidden}`).not.toContain(`require("@deepseek-ai/${forbidden}`)
    }
  })
})
