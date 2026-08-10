/**
 * Host exposure patch mechanism (plan dsh-advisor-settings-n2, C-1 resolution).
 *
 * The dsh host's apiproxy only exposes model-provider namespaces plus
 * `permission` / `ui-onboarding` to web configuration clients, so the plugin's
 * `advisor` settings namespace is refused (`settings-not-exposed`). This repo
 * ships the FIX MECHANISM — a git patch that adds `advisor` to the host's
 * exposure allowlist (PRODUCT_SETTINGS_NAMESPACES in
 * packages/host/apiproxy/src/api-proxy.ts) plus apply/revert/verify scripts —
 * mirroring the verified dsh-llm-fallbacks role-patch pattern.
 *
 * These tests are sandbox-safe by construction: they only READ the dsh tree
 * (`git apply --check`, script `--check` modes, grep probes); they never write
 * outside this workspace. Against a reachable dsh tree the pinned-baseline
 * assertions (b)/(d) are gated on the tree being in the pinned UNPATCHED state
 * — if the operator already applied the patch (the documented happy path), the
 * unpatched-state assertions skip with a note instead of failing.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const patchesDir = resolve(repo, 'patches')
const scriptsDir = resolve(repo, 'scripts')

/** The single shipped patch (pnpm convention @scope+pkg@version.patch). */
const PATCH = '@deepseek-ai+dsh-host-apiproxy@0.0.1.patch'
const PATCH_FILE = resolve(patchesDir, PATCH)

/** The marker line the patch introduces (also the verify script's probe). */
const MARKER = "'ui-onboarding', 'advisor'"

/** Mirror of the scripts' runtime target resolution: $DSH_SOURCE_DIR → ${DSH_HOME}/source/current. */
function resolveTarget(): string | null {
  const target = process.env.DSH_SOURCE_DIR ?? `${process.env.DSH_HOME ?? ''}/source/current`
  if (!target || !existsSync(resolve(target, '.git'))) return null
  return target
}

function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): {
  status: number | null
  stdout: string
  stderr: string
} {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: opts.cwd ?? repo,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function sourceIsPatched(tree: string): boolean {
  const source = resolve(tree, 'packages/host/apiproxy/src/api-proxy.ts')
  if (!existsSync(source)) return false
  return readFileSync(source, 'utf8').includes(MARKER)
}

describe('host exposure patch artifact (C-1)', () => {
  it('ships the patch as a git diff with the expected allowlist change', () => {
    expect(existsSync(PATCH_FILE), `${PATCH} exists under patches/`).toBe(true)
    const patch = readFileSync(PATCH_FILE, 'utf8')
    expect(patch.startsWith('diff --git a/packages/host/apiproxy/src/api-proxy.ts'), 'git-diff format').toBe(true)
    expect(patch).toContain('--- a/packages/host/apiproxy/src/api-proxy.ts')
    expect(patch).toContain('+++ b/packages/host/apiproxy/src/api-proxy.ts')
    // The allowlist change itself: ui-onboarding stays, advisor is added.
    expect(patch).toContain("-const PRODUCT_SETTINGS_NAMESPACES = new Set(['ui-onboarding'])")
    expect(patch).toContain("+const PRODUCT_SETTINGS_NAMESPACES = new Set(['ui-onboarding', 'advisor'])")
    // The comment above the allowlist is updated in the same hunk.
    expect(patch).toContain('-/** Product settings intentionally exposed beside model-provider namespaces. */')
    expect(patch).toContain('+/** Product settings intentionally exposed beside model-provider namespaces (ui-onboarding, advisor). */')
  })

  it('ships the apply/revert/verify scripts and the autopatch opt-out', () => {
    for (const script of ['apply-dsh-patch.sh', 'revert-dsh-patch.sh', 'verify-dsh-patch.sh', 'autopatch-install.sh']) {
      expect(existsSync(resolve(scriptsDir, script)), `${script} exists under scripts/`).toBe(true)
      const text = readFileSync(resolve(scriptsDir, script), 'utf8')
      expect(text.includes('set -euo pipefail'), `${script} is set -euo pipefail`).toBe(true)
      // No local absolute paths may be baked into the scripts.
      expect(text).not.toContain('/Users/bibi')
      expect(text).not.toContain('/workspace/ai/deepseek')
    }
    // The autopatch env opt-out must be honored without touching anything.
    const out = run(['bash', 'scripts/autopatch-install.sh'], {
      env: { DSH_ADVISOR_AUTOPATCH: '0' },
    })
    expect(out.status, `autopatch opt-out exit 0 — stderr:\n${out.stderr}`).toBe(0)
  })

  const target = resolveTarget()

  describe.skipIf(!target)('against the reachable dsh source tree', () => {
    const tree = target as string
    const patched = sourceIsPatched(tree)

    it('apply-dsh-patch.sh --check exits 0 and modifies nothing (read-only)', () => {
      const before = run(['git', '-C', tree, 'status', '--porcelain']).stdout
      const out = run(['bash', 'scripts/apply-dsh-patch.sh', '--check', '-d', tree])
      expect(out.status, `apply --check exit 0 — stderr:\n${out.stderr}`).toBe(0)
      expect(out.stdout, 'reports a per-patch verdict').toContain(PATCH)
      const after = run(['git', '-C', tree, 'status', '--porcelain']).stdout
      expect(after, 'tree status unchanged by --check').toBe(before)
    })

    describe.skipIf(patched)('pinned unpatched baseline (b8343cb)', () => {
      it('git apply --check succeeds and --reverse --check fails (not yet applied)', () => {
        const forward = run(['git', '-C', tree, 'apply', '--check', PATCH_FILE])
        expect(forward.status, `forward apply --check exit 0 — stderr:\n${forward.stderr}`).toBe(0)
        const reverse = run(['git', '-C', tree, 'apply', '--reverse', '--check', PATCH_FILE])
        expect(reverse.status, 'reverse --check fails while unpatched').not.toBe(0)
      })

      it('verify-dsh-patch.sh --absent passes on the unpatched tree', () => {
        const out = run(['bash', 'scripts/verify-dsh-patch.sh', '--absent', '-d', tree])
        expect(out.status, `verify --absent exit 0 — stderr:\n${out.stderr}`).toBe(0)
      })
    })

    it('verify-dsh-patch.sh present/absent probes are sane and state-consistent', () => {
      // Source probe file must exist in a dsh tree; the marker must match the
      // tree's actual state (patched → present passes; unpatched → absent passes).
      const source = resolve(tree, 'packages/host/apiproxy/src/api-proxy.ts')
      expect(existsSync(source), 'dsh tree has the apiproxy source').toBe(true)
      const present = run(['bash', 'scripts/verify-dsh-patch.sh', '-q', '-d', tree])
      const absent = run(['bash', 'scripts/verify-dsh-patch.sh', '--absent', '-q', '-d', tree])
      expect([present.status, absent.status], 'exactly one of present/absent passes').toContain(0)
      expect(
        [present.status, absent.status].filter((s) => s === 0).length,
        'present and absent are mutually exclusive on a consistent tree',
      ).toBe(1)
    })
  })
})
