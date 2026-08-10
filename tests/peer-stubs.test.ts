/**
 * Packaging contract for the git-install chain (plan dsh-advisor-readme-n2,
 * task 1): every private `@deepseek-ai/dsh-*` devDependency resolves to a
 * committed `peer-stubs/` package (`file:./peer-stubs/<name>`), the `prepare`
 * script builds the package during git-dependency install, and the 5 transitive
 * private devDeps that only existed for the real d.ts closure are gone.
 *
 * Contract under test — data-driven over the ACTUAL devDependencies, so the
 * stub set can grow (the settings plan adds more stubs) without this test
 * silently going stale:
 * - every `@deepseek-ai/*` devDependency is a `file:./peer-stubs/<name>` spec
 *   with a matching stub directory (no exact-count pin — the count is whatever
 *   the dependent plans add);
 * - `@deepseek-ai/dsh-{brand,invariants,scope,system-prompt,type-meta}` no
 *   longer appear in devDependencies (the historical transitive closure);
 * - each stub `package.json` matches its package (name, private, type module,
 *   `description` present and recording the mirrored dsh-private snapshot id
 *   `b8343cb`) and declares a resolvable entry shape — runtime stand-ins carry
 *   `main` + `types`, the type-only stub carries `types` only;
 * - `package.json` declares `scripts.prepare` = `pnpm build && bash
 *   scripts/autopatch-install.sh` (build + the host-patch autopatch) and
 *   `scripts.postinstall` = the autopatch only.
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

/** The private devDependency set — derived from package.json, so dependent plans can extend it. */
const privateDevDeps = Object.keys(root.devDependencies)
  .filter((name) => name.startsWith('@deepseek-ai/'))
  .sort()

/** The 5 transitive devDeps removed with the real d.ts closure (historical pin). */
const REMOVED_TRANSITIVE = [
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-type-meta',
] as const

/** The dsh-private snapshot every stub mirrors (KD-R1 drift-tracking token). */
const MIRROR_COMMIT = 'b8343cb'

const stubDir = (name: string): string =>
  resolve(repo, 'peer-stubs', name.replace('@deepseek-ai/', ''))

describe('peer-stubs packaging contract (git install chain)', () => {
  it('every private devDep resolves via a file: peer-stubs spec', () => {
    expect(privateDevDeps.length, 'at least one private devDep').toBeGreaterThan(0)
    for (const name of privateDevDeps) {
      expect(root.devDependencies[name], `${name} resolves via file:`).toBe(
        `file:./peer-stubs/${name.replace('@deepseek-ai/', '')}`,
      )
    }
  })

  it('the 5 removed transitive packages no longer appear in devDependencies', () => {
    for (const name of REMOVED_TRANSITIVE) {
      expect(root.devDependencies[name], `${name} removed`).toBeUndefined()
    }
  })

  it('each private devDep has a matching peer-stubs package.json (name/private/type/description + mirror commit)', () => {
    for (const name of privateDevDeps) {
      const pkgPath = resolve(stubDir(name), 'package.json')
      expect(existsSync(pkgPath), `${name} stub package.json exists`).toBe(true)
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
      expect(pkg.name, `${name} name matches`).toBe(name)
      expect(pkg.private, `${name} is private`).toBe(true)
      expect(pkg.type, `${name} is ESM`).toBe('module')
      expect(typeof pkg.description, `${name} records the mirrored dsh-private snapshot`).toBe('string')
      expect((pkg.description as string).length).toBeGreaterThan(0)
      expect(pkg.description as string, `${name} records mirror commit ${MIRROR_COMMIT}`).toMatch(
        new RegExp(MIRROR_COMMIT),
      )
    }
  })

  it('each stub declares a resolvable entry shape (runtime: main+types; type shim: types only)', () => {
    for (const name of privateDevDeps) {
      const pkg = JSON.parse(readFileSync(resolve(stubDir(name), 'package.json'), 'utf8')) as Record<string, unknown>
      const main = pkg.main
      const types = pkg.types
      if (main !== undefined) {
        expect(main, `${name} runtime stub main`).toBe('index.ts')
        expect(types, `${name} runtime stub types`).toBe('index.ts')
        expect(existsSync(resolve(stubDir(name), 'index.ts')), `${name} index.ts exists`).toBe(true)
      } else {
        expect(types, `${name} type-only stub types`).toBe('index.d.ts')
        expect(existsSync(resolve(stubDir(name), 'index.d.ts')), `${name} index.d.ts exists`).toBe(true)
      }
    }
  })

  it('declares prepare (build + host-patch autopatch) and postinstall (autopatch) for the git-dep install chain', () => {
    expect(root.scripts.prepare).toBe('pnpm build && bash scripts/autopatch-install.sh')
    expect(root.scripts.postinstall).toBe('bash scripts/autopatch-install.sh')
  })
})
