# Host exposure patch (`patches/`)

The dsh host's apiproxy only exposes **model-provider namespaces** plus
`permission` and `ui-onboarding` to web configuration clients. The plugin's
`advisor` settings namespace is therefore refused by the configuration client
with `settings-not-exposed` — the web Settings page cannot read or write it
(C-1, the host-side blocker of the Settings page round-trip). dsh itself is
not shipped in this repo; this directory carries the minimal git patch + the
companion scripts (`scripts/apply-dsh-patch.sh` / `revert-dsh-patch.sh` /
`verify-dsh-patch.sh`) that apply the change to the **local dsh source tree**
(the same mechanism `dsh-llm-fallbacks` ships for its role patch).

## Patch list

| File | Target package | Change |
|------|----------------|--------|
| `@deepseek-ai+dsh-host-apiproxy@0.0.1.patch` | `@deepseek-ai/dsh-host-apiproxy` | `PRODUCT_SETTINGS_NAMESPACES` (`packages/host/apiproxy/src/api-proxy.ts`) gains `'advisor'`; the doc comment above it is updated to mention the advisor section |

> The file name follows the pnpm `patchedDependencies` convention
> `@scope+pkg@version.patch` (version 0.0.1 matches the package's
> `package.json`). This repo applies the patch to the dsh source tree directly
> via `scripts/*.sh` (diff paths are repo-root-relative, so
> `git -C "$DSH_SOURCE_DIR" apply` works as-is); if you switch to the pnpm
> `patchedDependencies` mechanism instead, the diff paths must be re-prefixed
> to be package-directory-relative — this repo does not depend on that
> mechanism.

## Why the patch exists (the exact change)

The dsh host's `exposedNamespaces()` is the union of the model-provider
namespaces, `permission`, and `PRODUCT_SETTINGS_NAMESPACES`. At the pinned
baseline (dsh-private b8343cb) that allowlist is:

```ts
/** Product settings intentionally exposed beside model-provider namespaces. */
const PRODUCT_SETTINGS_NAMESPACES = new Set(['ui-onboarding'])
```

The patch adds `'advisor'` (and mentions the advisor section in the comment):

```diff
-/** Product settings intentionally exposed beside model-provider namespaces. */
-const PRODUCT_SETTINGS_NAMESPACES = new Set(['ui-onboarding'])
+/** Product settings intentionally exposed beside model-provider namespaces (ui-onboarding, advisor). */
+const PRODUCT_SETTINGS_NAMESPACES = new Set(['ui-onboarding', 'advisor'])
```

That is the entire change: a one-element allowlist addition with no behavior
change elsewhere. After it is applied (and the host rebuilt), the web Settings
page can read and write the `advisor` namespace, and the Advisor section's
Apply round-trip works against the real host.

## Relationship to the plugin's Settings section

Without the patch, the Advisor section still renders, but the store detects
that the `advisor` namespace is **not exposed** (`advisorPresent: false`) and
shows an explicit unexposed-namespace notice instead of a writable-looking
form; Apply is never offered. That guidance is the shipped plugin-side
mitigation (qc2 W-2) and stays in place even with the patch — it only flips to
the live form once the host actually exposes the namespace.

## Usage

All scripts resolve the target directory **at runtime**; the scripts contain
no local absolute paths:

```sh
# Target resolution: $DSH_SOURCE_DIR first, default ${DSH_HOME}/source/current
export DSH_SOURCE_DIR=/path/to/dsh-source   # or just set DSH_HOME
```

### Apply

```sh
scripts/apply-dsh-patch.sh            # git apply --check → apply → incremental build
scripts/apply-dsh-patch.sh --check    # only check applicability (modifies nothing)
scripts/apply-dsh-patch.sh --skip-build  # apply without building (no pnpm environment)
```

Idempotent: an already-applied patch is skipped automatically. Build step =
`tsc -b packages/host/apiproxy` (incremental) + `tsdown --env.DSH_BUILD_FACE
host` (the dsh monorepo has no per-package build script; this is the
repo-consistent build entry). If the target tree has no pnpm environment, the
script prints a clear message, skips the build, and exits non-zero.

### Revert

```sh
scripts/revert-dsh-patch.sh           # git apply --reverse → rebuild
scripts/revert-dsh-patch.sh --check
```

### Verify

```sh
scripts/verify-dsh-patch.sh           # assert the marker is present (source + build artifact)
scripts/verify-dsh-patch.sh --absent  # assert the marker is absent (after revert)
```

Verify probes (existing files are checked; missing files are recorded as
SKIP):

- source: `packages/host/apiproxy/src/api-proxy.ts` contains
  `'ui-onboarding', 'advisor'`
- build: `packages/host/apiproxy/lib/types/api-proxy.js` contains
  `'ui-onboarding', 'advisor'`

> The constant is module-private, so it never reaches the `.d.ts`; the compiled
> JS (`lib/types/api-proxy.js`, the tsc emit under `outDir: lib/types`) is the
> build probe. After `--skip-build` the build probe still holds the stale
> artifact, so verify only passes once the package is rebuilt — apply without
> `--skip-build`, or rebuild manually first.

### Install-time autopatch

The plugin wires the autopatch into its install lifecycle (`postinstall` and
`prepare`): it detects the target dsh source tree and idempotently applies the
patch, then best-effort rebuilds; any failure only warns and **never fails the
install**. Opt out entirely with:

```sh
DSH_ADVISOR_AUTOPATCH=0 pnpm install
```

(pnpm ≥ 10 gates a dependency's `postinstall`/`prepare` behind
`onlyBuiltDependencies` — the same allowlist entry the README documents for
`prepare` covers both.)

## Re-run after a dsh upgrade

A dsh upgrade (a new `$DSH_HOME/source/current` staging) **resets** the host
change: after upgrading, re-run `scripts/apply-dsh-patch.sh` (idempotent —
skips when already applied) and confirm with `scripts/verify-dsh-patch.sh`. If
the upgrade moved the context so the patch no longer applies, the script
reports the conflict; the patch may need regenerating against the new source
lines (the change itself is a one-line allowlist entry, so regeneration is
trivial).

## Security note

- `apply`/`revert` run a **build** in the target tree (`pnpm exec tsc` /
  `tsdown`) — i.e. they execute that tree's install-time code. Run them only
  against a trusted dsh source tree; the target is chosen explicitly via
  `$DSH_SOURCE_DIR` / `$DSH_HOME`, so confirm its provenance.
- The patch only adds one namespace to an allowlist; it changes no defaults or
  other behavior. `revert` rolls it back in one step and the rebuild restores
  the artifacts.
- The autopatch runs from `postinstall`/`prepare` — i.e. at install time,
  outside any sandbox the agent runs under. That is exactly why the
  `DSH_ADVISOR_AUTOPATCH=0` opt-out exists and why installs never fail on it.
