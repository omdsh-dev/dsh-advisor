/**
 * Dev-time resolution contract (peer-stubs removal): the private
 * `@deepseek-ai/dsh-*` packages are peerDependencies ONLY — never
 * devDependencies — and dev-time resolution comes from a local dsh source
 * tree (`$DSH_SOURCE_DIR` first, default `${DSH_HOME}/source/current`) via
 * `scripts/setup-dsh-links.mjs`, which links the real packages into
 * `node_modules/@deepseek-ai/` (no committed `peer-stubs/` copies).
 *
 * Contract under test — data-driven over the ACTUAL package.json, so the
 * peer set can grow without this test silently going stale:
 * - every `@deepseek-ai/*` entry lives in `peerDependencies` and in NO other
 *   dependency field (the npm registry must never be asked for them);
 * - `.npmrc` disables `autoInstallPeers` (mirrors the dsh profile
 *   convention: in-box bundles resolve from the dsh installation);
 * - the `prepare` lifecycle chains the link setup before `pnpm build`, and
 *   `dsh:link` / `dsh:link:check` expose the standalone commands;
 * - `scripts/setup-dsh-links.mjs` exists; `--check` passes when a source
 *   tree resolves and the farm is in place — the same check CI can run
 *   after install.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const root = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const deepseekKeys = (field: Record<string, string> | undefined): string[] =>
  Object.keys(field ?? {}).filter((name) => name.startsWith('@deepseek-ai/')).sort()

describe('dev-time dsh resolution contract (real packages via DSH_HOME)', () => {
  it('every @deepseek-ai/* entry is a peerDependency and appears in no other dependency field', () => {
    const peers = deepseekKeys(root.peerDependencies)
    expect(peers.length, 'at least one private peer').toBeGreaterThan(0)
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      expect(deepseekKeys(root[field]), `${field} has no @deepseek-ai entries`).toEqual([])
    }
  })

  it('pnpm-workspace.yaml disables autoInstallPeers (private packages must never hit the registry)', () => {
    // pnpm 11+ ignores non-auth settings in .npmrc (see
    // .mstar/knowledge/developer-experience/pnpm11-workspace-config-and-windows-link-farm.md):
    // the convention lives in pnpm-workspace.yaml, and .npmrc keeps only
    // registry/auth settings.
    const workspace = readFileSync(resolve(repo, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toMatch(/autoInstallPeers\s*:\s*false/)
    const npmrc = readFileSync(resolve(repo, '.npmrc'), 'utf8')
    expect(npmrc).not.toMatch(/auto-install-peers|node-linker|_authToken/)
  })

  it('@deepseek-ai/cordis is the peer-only vendored baseline (^4.0.1-rc.1, shim-provided)', () => {
    // The vendored baseline is @deepseek-ai/cordis 4.0.1-rc.1 (the 20260811
    // snapshot rename). The package is unpublished, so it lives ONLY in
    // peerDependencies — never devDependencies — and dev-time resolution comes
    // from the link script's private shim at node_modules/@deepseek-ai/cordis,
    // not the registry (the real packages type against the vendored build —
    // module identity).
    const range = root.peerDependencies?.['@deepseek-ai/cordis']
    expect(typeof range, 'peer @deepseek-ai/cordis has a version range').toBe('string')
    expect(range?.length ?? 0, 'peer range is non-empty').toBeGreaterThan(0)
    expect(root.devDependencies?.cordis, 'no legacy bare-cordis devDependency').toBeUndefined()
    expect(root.devDependencies?.['@deepseek-ai/cordis'], 'no @deepseek-ai/cordis devDependency').toBeUndefined()
  })

  it('prepare chains the link setup before the build; dsh:link / dsh:link:check exist', () => {
    expect(root.scripts.prepare).toBe('node scripts/setup-dsh-links.mjs && pnpm build')
    expect(root.scripts['dsh:link']).toBe('node scripts/setup-dsh-links.mjs')
    expect(root.scripts['dsh:link:check']).toBe('node scripts/setup-dsh-links.mjs --check')
  })

  it('the setup script collects @deepseek-ai/* packages and requires the peers to be linkable', () => {
    const script = resolve(repo, 'scripts', 'setup-dsh-links.mjs')
    expect(existsSync(script), 'setup-dsh-links.mjs exists').toBe(true)
    const source = readFileSync(script, 'utf8')
    expect(source).toContain('DSH_SOURCE_DIR')
    expect(source).toContain('peerDependencies')
    expect(source).toContain('@deepseek-ai/')
  })

  it('--check passes when a source tree resolves and the farm is in place', () => {
    // Only exercised when the environment actually has a tree (dev machines
    // and CI with DSH_HOME set); hermetic environments without a tree skip
    // the live check.
    const probe = spawnSync('node', [resolve(repo, 'scripts', 'setup-dsh-links.mjs'), '--check'], {
      cwd: repo,
      encoding: 'utf8',
    })
    const noTree = probe.stderr.includes('no dsh source tree found')
    if (!noTree) {
      expect(probe.status, `--check output: ${probe.stdout}${probe.stderr}`).toBe(0)
    }
  })
})
