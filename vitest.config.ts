import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/**
 * Resolve the dsh source tree the dev-time link farm was built from — the
 * same order as scripts/setup-dsh-links.mjs ($DSH_SOURCE_DIR first, then
 * $DSH_HOME/source/current, then the default home location).
 */
function resolveSourceRoot(): string {
  const candidates = [
    process.env.DSH_SOURCE_DIR,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'source', 'current') : undefined,
    join(homedir(), '.dsh', 'source', 'current'),
  ].filter((candidate): candidate is string => candidate !== undefined)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

const sourceRoot = resolveSourceRoot()

export default defineConfig({
  // Component specs compile JSX with the automatic runtime (react/jsx-runtime),
  // mirroring tsconfig.spec.json — the spec files never import React.
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: sourceRoot
      ? [
          // The real packages' `./client` entries are browser loader artifacts
          // (`window.__ModuleLoader__.load(...)` — served to the web shell at
          // runtime); dev-time tests resolve the client half of
          // dsh-client-runtime to its SOURCE instead (dsh-private's own tests
          // do the same via tsconfig paths). Its value import graph is
          // node-safe: cross-package imports are type-only, and the value
          // imports (ui-slots, zustand, immer) resolve from the linked
          // packages / the registry.
          //
          // react / react-dom need no alias here: the link farm
          // (scripts/setup-dsh-links.mjs) puts the source tree's copies in
          // node_modules, so node — including externalized CJS deps such as
          // testing-library — resolves one react identity (the same identity
          // the real client packages use; the web loader hands every bundle
          // the same react at runtime).
          {
            find: '@deepseek-ai/dsh-client-runtime/client',
            replacement: join(sourceRoot, 'packages', 'client', 'runtime', 'src', 'client', 'index.ts'),
          },
        ]
      : [],
  },
  test: {
    // .tsx: client component specs run under jsdom via the per-file
    // `// @vitest-environment jsdom` pragma (dsh-private convention).
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
  },
})
