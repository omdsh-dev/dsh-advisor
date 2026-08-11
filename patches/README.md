# Host exposure patch (`patches/`)

The dsh host's apiproxy only exposes **model-provider namespaces** plus
`permission`, `ui-onboarding`, and the agent-preset setting namespace to web
configuration clients. The plugin's `advisor` settings namespace is therefore
refused by the configuration client with `settings-not-exposed` — the web
Settings page cannot read or write it (C-1, the host-side blocker of the
Settings page round-trip). dsh itself is not shipped in this repo; this
directory carries the minimal git patch + the companion scripts
(`scripts/apply-dsh-patch.sh` / `revert-dsh-patch.sh` /
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
baseline (dsh snapshot 20da39e, after the upstream refactor) that allowlist is:

```ts
/**
 * Product settings intentionally exposed beside model-provider namespaces.
 *
 * The agent-preset namespace carries one field — which preset a session with
 * no explicit choice is composed from — and both browser surfaces that offer
 * that choice write it through `settings.update`, so it has to cross the
 * configuration boundary or the pickers silently fail to persist.
 */
const PRODUCT_SETTINGS_NAMESPACES = new Set(['ui-onboarding', AGENT_PRESET_SETTINGS_NAMESPACE])
```

(`AGENT_PRESET_SETTINGS_NAMESPACE` is imported from
`@deepseek-ai/dsh-agent-presets`; the 8-line JSDoc above the constant is the
patch's hunk context.)

The patch adds `'advisor'` (and mentions the advisor section in the comment):

```diff
- * Product settings intentionally exposed beside model-provider namespaces.
+ * Product settings intentionally exposed beside model-provider namespaces (ui-onboarding, advisor, agent-preset).
  *
  * The agent-preset namespace carries one field — which preset a session with
  * no explicit choice is composed from — and both browser surfaces that offer
  * that choice write it through `settings.update`, so it has to cross the
  * configuration boundary or the pickers silently fail to persist.
  */
-const PRODUCT_SETTINGS_NAMESPACES = new Set(['ui-onboarding', AGENT_PRESET_SETTINGS_NAMESPACE])
+const PRODUCT_SETTINGS_NAMESPACES = new Set(['ui-onboarding', 'advisor', AGENT_PRESET_SETTINGS_NAMESPACE])
```

That is the entire change: a one-element allowlist addition with no behavior
change elsewhere. After it is applied and the running host is restarted (see
[Runtime shape](#runtime-shape) below), the web Settings page can read and
write the `advisor` namespace, and the Advisor section's Apply round-trip
works against the real host.

## Runtime shape

The standard staged install runs the dsh CLI from a **snapshot**
(`$DSH_HOME/source/current`) whose `dsh` launcher executes the CLI **from
TypeScript source via tsx**, using the snapshot's own `tsconfig` paths —
`@deepseek-ai/dsh-host-apiproxy` resolves to `packages/host/apiproxy/src`
(not `lib/`). Consequences for this patch:

- The **source probe** (`src/api-proxy.ts`) is the runtime-relevant one:
  `git apply` alone makes the change effective — no build step is required for
  the tsx path.
- The **tsc/tsdown build artifacts** (`lib/types/api-proxy.js`,
  `lib/index.js`) are for consistency only — they matter for consumers that
  import the dsh packages outside the tsx-from-source install (e.g. `node`
  mode).
- **A restart of the `dsh web` process is required** for the change to load:
  applying the patch edits files on disk; the running process keeps the old
  source until restarted. `verify-dsh-patch.sh --runtime` detects exactly this
  case (file probes pass, runtime probe fails).
- After a **dsh upgrade** (a new `$DSH_HOME/source/current` staging) the patch
  must be re-applied — see [Re-run after a dsh upgrade](#re-run-after-a-dsh-upgrade).

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
scripts/verify-dsh-patch.sh                  # assert the marker is present (source + build artifacts)
scripts/verify-dsh-patch.sh --absent         # assert the marker is absent (after revert)
scripts/verify-dsh-patch.sh --runtime [URL]  # assert the RUNNING dsh web server exposes the namespace
```

Verify probes (existing files are checked; missing files are recorded as
SKIP):

- source: `packages/host/apiproxy/src/api-proxy.ts` contains
  `'ui-onboarding', 'advisor'`
- build: `packages/host/apiproxy/lib/types/api-proxy.js` contains
  `'ui-onboarding', 'advisor'`
- bundle: `packages/host/apiproxy/lib/index.js` is probed with TWO line-based
  probes — the new tsdown (rolldown) emits the `Set` multi-line, so a single
  context regex cannot span the newlines. Present mode checks the constant
  declaration line (`PRODUCT_SETTINGS_NAMESPACES = new Set(` — a fixed-string
  `grep -F` probe, **shape-agnostic**: its marker contains no regex
  metacharacters, so it matches the declaration regardless of the Set body's
  ordering or whitespace) **and** the advisor allowlist-entry line
  (`^[[:space:]]*["']advisor["']` — an **entry-line-based, quote-agnostic**
  regex: anchored at line start and accepting either quote character, since
  the tsdown printer's quote choice is not contractual). Absent
  mode keys on the advisor entry probe only: the constant declaration exists
  in the unpatched bundle too, so that probe is marked present-only and
  skipped — the advisor entry is the discriminator of the reverted state.

> The constant is module-private, so it never reaches the `.d.ts`; the compiled
> JS (`lib/types/api-proxy.js`, the tsc emit under `outDir: lib/types`) and the
> tsdown bundle (`lib/index.js`) are the build probes. After `--skip-build`
> these lib probes still hold the stale artifact, so the file verify only
> passes once the package is rebuilt — apply without `--skip-build`, or rebuild
> manually first (the source probe and `--runtime` are unaffected).

`--runtime` proves the patch is effective in the **running** server, not just
in the tree — the file probes cannot detect a server that was not restarted.
It POSTs `{url}/api/settings.describe` (envelope
`{"type":"client-request","rpcId":"verify","method":"settings.describe","payload":{}}`,
10s timeout) and asserts the response namespaces include `advisor` (with
`--absent`, that they exclude it). Both modes only trust a valid
`settings.describe` **success envelope** (`"ok":true` with a `namespaces`
result) — an HTTP error page, an error envelope, or garbage fails instead of
being read as "absent"/"not exposed". The URL defaults to
`http://127.0.0.1:3080` and may carry any number of trailing slashes
(normalized before concatenation). The script distinguishes a server-unreachable
failure (not running / not restarted) from a namespace-not-exposed failure, and
exits non-zero on either. The probe is **read-only** (a `settings.describe`
call) and sends **no credentials**; it bypasses proxies (`curl --noproxy`).

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

A dsh upgrade stages a new `$DSH_HOME/source/current` snapshot. Whether the
patch needs re-applying depends on where the snapshot came from:

- If the snapshot was staged from a **patched dsh-private tree** (this
  project's fix flow patches the private tree too, so future snapshots inherit
  the change), the host change is already present — `scripts/apply-dsh-patch.sh`
  detects this and skips idempotently (its reverse-apply check passes).
- If the snapshot is pristine (e.g. pulled from upstream), re-run
  `scripts/apply-dsh-patch.sh` (idempotent — applies when missing) and confirm
  the files with `scripts/verify-dsh-patch.sh`.

If the upgrade moved the context so the patch no longer applies, the script
reports the conflict; the patch may need regenerating against the new source
lines (the change itself is a one-element allowlist entry, so regeneration is
trivial). Note that upstream refactored `PRODUCT_SETTINGS_NAMESPACES` to also
carry `AGENT_PRESET_SETTINGS_NAMESPACE` (imported from
`@deepseek-ai/dsh-agent-presets`) with an 8-line JSDoc above it; this patch was
**regenerated for that refactored baseline** — its hunk context is that JSDoc
plus the constant line, taken verbatim from the current upstream source. When
regenerating, keep the agent-preset namespace in the allowlist and preserve the
JSDoc body (only the first JSDoc line gains the `(ui-onboarding, advisor,
agent-preset)` mention alongside the `'advisor'` addition).

Either way, file probes passing does not prove the running server has the
change: after (re-)applying, **restart `dsh web`** and prove the runtime state
with `scripts/verify-dsh-patch.sh --runtime`.

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
