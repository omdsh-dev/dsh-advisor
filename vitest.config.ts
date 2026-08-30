import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Component specs compile JSX with the automatic runtime (react/jsx-runtime),
  // mirroring tsconfig.spec.json — the spec files never import React.
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: [
      // The published @deepseek-ai/dsh-client-store entry is served to the
      // web shell through the loader table (`CLIENT_EXTERNALS`) rather than
      // bundled; dev-time tests resolve the one VALUE import the client
      // store makes (`createSnapshotStore`) to a node-safe local double
      // instead of pulling zustand/immer into the suite. Every other
      // `@deepseek-ai/*` import is type-only (erased at runtime) and resolves
      // from the registry package.
      {
        find: '@deepseek-ai/dsh-client-store',
        replacement: resolve(here, 'tests', 'support', 'snapshot-store.ts'),
      },
    ],
  },
  test: {
    // .tsx: client component specs run under jsdom via the per-file
    // `// @vitest-environment jsdom` pragma (dsh-private convention).
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    // The client-build suite re-runs the full build (esbuild bundle + tsc
    // declarations) per run — ~6s, over the 5s default; the margin protects
    // slower machines from spurious timeouts.
    testTimeout: 15000,
    server: {
      deps: {
        // dsh-client-ui-primitives (registry) does `import "katex/dist/katex.min.css"`
        // as a side effect; inline it so vite stubs the CSS import instead of
        // handing the .css path to Node's ESM loader (Unknown file extension).
        inline: [/dsh-client-ui-primitives/],
      },
    },
  },
})
