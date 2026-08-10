import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Component specs compile JSX with the automatic runtime (react/jsx-runtime),
  // mirroring tsconfig.spec.json — the spec files never import React.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // .tsx: client component specs run under jsdom via the per-file
    // `// @vitest-environment jsdom` pragma (dsh-private convention).
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
  },
})
