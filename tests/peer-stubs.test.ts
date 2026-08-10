/**
 * Packaging contract for the git-install chain (plan dsh-advisor-readme-n2,
 * task 1): private `@deepseek-ai/dsh-*` devDependencies resolve to committed
 * `peer-stubs/` packages (`file:./peer-stubs/<name>`), the `prepare` script
 * builds the package during git-dependency install, and the 5 transitive
 * private devDeps that only existed for the real d.ts closure are gone.
 *
 * Contract under test:
 * - devDependencies carry EXACTLY the 5 directly-consumed private packages
 *   (`@deepseek-ai/dsh-{agent,commands,llm,session,timeout}`), each as a
 *   `file:./peer-stubs/<name>` spec;
 * - `@deepseek-ai/dsh-{brand,invariants,scope,system-prompt,type-meta}` no
 *   longer appear in devDependencies;
 * - each stub directory has a matching `package.json` (name match, private,
 *   type module, `description` present) and the declared entry shape —
 *   runtime stand-ins (`llm/session/commands/timeout`) carry `main` +
 *   `types`, the type-only `agent` stub carries `types` only;
 * - `package.json` declares `scripts.prepare` = `pnpm build`.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const root = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  devDependencies: Record<string, string>
}

/** The exact 5 directly-consumed private packages (KD-R1 decision). */
const PRIVATE_PACKAGES = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-timeout',
] as const

/** The 5 transitive devDeps removed with the real d.ts closure. */
const REMOVED_TRANSITIVE = [
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-type-meta',
] as const

/** Runtime stand-ins: `main` + `types` pointing at `index.ts`. */
const RUNTIME_STUBS = new Set([
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-timeout',
])

const stubDir = (name: string): string =>
  resolve(repo, 'peer-stubs', name.replace('@deepseek-ai/', ''))

describe('peer-stubs packaging contract (git install chain)', () => {
  it('devDependencies carry exactly the 5 private packages, each as a file: stub spec', () => {
    const privateDeps = Object.entries(root.devDependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/'))
      .map(([name]) => name)
      .sort()
    expect(privateDeps).toEqual([...PRIVATE_PACKAGES].sort())
    for (const name of PRIVATE_PACKAGES) {
      expect(root.devDependencies[name], `${name} resolves via file:`).toMatch(/^file:\.\/peer-stubs\//)
    }
  })

  it('the 5 removed transitive packages no longer appear in devDependencies', () => {
    for (const name of REMOVED_TRANSITIVE) {
      expect(root.devDependencies[name], `${name} removed`).toBeUndefined()
    }
  })

  it('each private devDep has a matching peer-stubs package.json (name/private/type/description)', () => {
    for (const name of PRIVATE_PACKAGES) {
      const pkgPath = resolve(stubDir(name), 'package.json')
      expect(existsSync(pkgPath), `${name} stub package.json exists`).toBe(true)
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
      expect(pkg.name, `${name} name matches`).toBe(name)
      expect(pkg.private, `${name} is private`).toBe(true)
      expect(pkg.type, `${name} is ESM`).toBe('module')
      expect(typeof pkg.description, `${name} records the mirrored dsh-private snapshot`).toBe('string')
      expect((pkg.description as string).length).toBeGreaterThan(0)
    }
  })

  it('runtime stand-ins declare main+types; the type-only agent stub declares types only', () => {
    for (const name of PRIVATE_PACKAGES) {
      const pkg = JSON.parse(readFileSync(resolve(stubDir(name), 'package.json'), 'utf8')) as Record<string, unknown>
      if (RUNTIME_STUBS.has(name)) {
        expect(pkg.main, `${name} main`).toBe('index.ts')
        expect(pkg.types, `${name} types`).toBe('index.ts')
        expect(existsSync(resolve(stubDir(name), 'index.ts')), `${name} index.ts exists`).toBe(true)
      } else {
        expect(pkg.main, `${name} is type-only (no main)`).toBeUndefined()
        expect(pkg.types, `${name} types`).toBe('index.d.ts')
        expect(existsSync(resolve(stubDir(name), 'index.d.ts')), `${name} index.d.ts exists`).toBe(true)
      }
    }
  })

  it('declares a prepare script that runs the build (git-dep install chain)', () => {
    expect(root.scripts.prepare).toBe('pnpm build')
  })
})
