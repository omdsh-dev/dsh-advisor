---
module: install toolchain (pnpm + dev-time link farm)
date: 2026-08-12
problem_type: developer_experience
category: developer-experience
severity: high
title: pnpm 11 workspace-config migration and Windows-safe link farm (dsh plugin bundle)
description: Verified cross-platform install fix for the dsh-advisor bundle: pnpm 11+ silently ignores non-auth settings in .npmrc (autoInstallPeers / nodeLinker must live in pnpm-workspace.yaml), peerDependencies ranges must match published prerelease tags (^0.0.1 never matches 0.0.1-rc.1), the node-semver prerelease-tuple rule (^4.0.0-rc.7 never matches 4.0.1-rc.1), cordis peers must use the scoped @deepseek-ai/cordis name (shim location, requiredPeers exemption, legacy cleanup), and the link-farm script needs Windows handling (USERPROFILE, junction-vs-file link kinds, separator normalization).
tags:
  - pnpm
  - pnpm-workspace-yaml
  - npmrc
  - windows
  - node-linker
  - link-farm
  - peer-dependencies
  - prerelease
  - semver
  - cordis
  - junction
  - dsh
last_updated: 2026-08-12
applies_when:
  - Running pnpm install with pnpm 11.x in a repo whose pnpm settings live in .npmrc
  - Making a symlink-based dev-time link farm work on Windows
  - Declaring peerDependencies against @deepseek-ai packages published only as prereleases
  - Declaring a cordis peer or generating the cordis shim (must use the @deepseek-ai/cordis scoped name)
---

# pnpm 11 workspace-config migration and Windows-safe link farm

> **Superseded (2026-08-15):** the dev-time link farm this doc describes was removed — private `@deepseek-ai/*` peers now resolve from the npm registry via `autoInstallPeers: true` + the `~/.npmrc` auth token (see `developer-experience/dsh-standalone-plugin-dev.md`). The pnpm-11 settings-migration and Windows symlink-junction lessons below remain valid history; the `autoInstallPeers: false` guidance in item 1 no longer applies.

## Context

`pnpm install` was broken on Windows under pnpm 11.8 for the dsh-advisor bundle (PR #11, `fix/install` branch). Five distinct issues blocked it; three are general pnpm-11 behaviors, two are Windows-specific gaps in the committed link-farm script. Fixed in commit `cdee4a2`, merged as PR #11, and re-verified on macOS (pnpm 10.28.1): `prepare` links 217 entries from the dsh source tree and the build passes.

The same lessons were independently re-verified and extended by the dsh-llm-fallbacks self-check (commit `ac994ea`), which surfaced two additional lessons folded in below: the **node-semver prerelease-tuple rule** for peer ranges against prerelease publishes, and the **cordis scoped-name alignment** (peer, shim, imports, externals all `@deepseek-ai/cordis`).

Related recipe: `developer-experience/dsh-standalone-plugin-dev.md` covers the link-farm design itself (peer-only runtime deps, two-anchor resolution, cordis shim, react identity); this doc records the version-migration and cross-platform failure modes.

## Guidance

1. **pnpm 11+ reads non-auth settings from `pnpm-workspace.yaml`, not `.npmrc`.** `autoInstallPeers` / `nodeLinker` left in `.npmrc` are **silently ignored** — no warning, no error. The visible symptom is the design's worst case: pnpm resolves the private `@deepseek-ai/*` peers from the registry instead of leaving them for the link farm, and the node_modules layout loses the hoisted convention. Put `autoInstallPeers: false`, `nodeLinker: hoisted`, and build approvals in `pnpm-workspace.yaml`:

```yaml
# pnpm-workspace.yaml
autoInstallPeers: false
nodeLinker: hoisted

allowBuilds:
  esbuild: true
```

2. **`.npmrc` keeps only registry/auth settings.** Keep `@deepseek-ai:registry=…`; drop the committed `_authToken=${NPM_TOKEN}` line — nothing in the install path fetches from the private registry (peers come from the link farm), so the token was dead weight that made installs depend on a secret env var.

3. **peerDependencies ranges must match the published version, including prerelease tags.** Semver rule: a range without a prerelease (`^0.0.1`) never matches a prerelease version (`0.0.1-rc.1`). All 19 `@deepseek-ai/*` peers moved from `^0.0.1` to `^0.0.1-rc.1`. This is the last line of defense whenever `autoInstallPeers` is accidentally on (e.g. the silent .npmrc ignore above) — with the correct range, pnpm can at least resolve the peers instead of failing ERESOLVE.

4. **The node-semver prerelease-tuple rule (dsh-llm-fallbacks empirical finding).** `^4.0.0-rc.7` **never matches** `4.0.1-rc.1`: a comparator with a prerelease only accepts prereleases of the **same `[major, minor, patch]` tuple**, so same-series-looking ranges silently exclude the actual publish. The range must carry the exact publish tag — the vendored cordis is `4.0.1-rc.1`, so the peer must be `^4.0.1-rc.1`, not the superficially-safe `^4.0.0-rc.7`. The failure only surfaces when pnpm actually resolves that peer, so it is easy to ship broken.

5. **cordis peers must be scoped: `@deepseek-ai/cordis`, never bare `cordis`.** All dsh plugin bundles declare the in-box framework under the scoped name; the bare name is the migration leftover. Four pieces move together:
   - **Shim location and name**: `node_modules/@deepseek-ai/cordis` with `name: '@deepseek-ai/cordis'` (the vendored snapshot only accepts the scoped name; legacy bare shims are no longer supported).
   - **requiredPeers exemption**: the vendored package declares a `bin` → `collectDeepseekPackages()` skips it → without the exemption it lands in missingPeers. `filter(name => name.startsWith('@deepseek-ai/') && name !== '@deepseek-ai/cordis')`.
   - **Legacy cleanup**: `write` removes the bare `node_modules/cordis` shim; `--check` flags it (`legacy node_modules/cordis shim present`) so no stale bare-cordis resolution survives.
   - **Imports and externals**: `src` / `tests` import `@deepseek-ai/cordis`; client externals tables carry only the scoped entry (a dead bare `'cordis'` entry in a frozen table is a wrong contract declaration).

6. **Windows has no `HOME`.** Resolve the dsh source tree with `process.env.HOME ?? process.env.USERPROFILE`.

7. **Windows link kinds are per-target, not global.** Junctions are directory-only (and need no privileges); file symlinks need Developer Mode or an admin shell. Pick per target: `statSync(target).isDirectory() ? 'junction' : 'file'` — otherwise the cordis shim's file entries (`index.js` / `index.d.ts`) get broken junctions.

8. **Normalize path separators before comparing managed keys.** Windows `readdir` returns backslash-separated paths; strip the `node_modules` prefix with `^node_modules[/\\]` and convert `\` → `/` so stale-prune keys match the managed Map.

## Why This Matters

The pnpm-11 `.npmrc` ignore is the dangerous failure mode: it fails the *design invariant* (private peers must never come from the registry) while the install still reports success on the surface — the breakage surfaces later as wrong module identities or missing peer versions, or an ERESOLVE only when the peer range also mismatches. Lesson 4 is the subtlest of the range rules — the range "looks right" (same 4.x series) yet never matches, and only surfaces when pnpm actually resolves that peer. Lesson 5 is plugin-ecosystem consistency: every dsh plugin must declare cordis under the scoped name, bare-name shims and imports are migration leftovers. The Windows link issues are plain install blockers (EPERM / broken junctions) that make the bundle uninstallable on the platform where its users actually run `pnpm 11` (the dsh profile convention is hoisted + no-auto-peers, so both settings matter on every platform).

## When to Apply

- Any pnpm ≥ 11 repo: verify pnpm settings live in `pnpm-workspace.yaml`, not `.npmrc` (pnpm ≥ 10.26 also accepts `allowBuilds` there).
- Any repo declaring peers against packages published only as prereleases: write the range with the exact publish tag (lesson 3), and match the `[major, minor, patch]` tuple for comparator prereleases (lesson 4).
- Creating or porting a standalone dsh plugin bundle: cordis peer, shim, imports, and externals tables all use `@deepseek-ai/cordis` (lesson 5).
- Bumping the dsh source tree's vendored cordis: sync the `package.json` peer range to the new publish tag (lessons 3–4).
- Any link/symlink script that must run on Windows: per-target link kind, `USERPROFILE` fallback, separator normalization.
- Extending the dsh-advisor link farm (`scripts/setup-dsh-links.mjs`) or porting the recipe to another standalone dsh plugin.

## Examples

### Before (broken)

`.npmrc` held `auto-install-peers=false` + `node-linker=hoisted` + `_authToken=${NPM_TOKEN}`; `package.json` peers at `^0.0.1` with `cordis: ^4.0.0-rc.7` (bare `cordis` shim at `node_modules/cordis`); link script used `process.env.HOME`, a single `'junction'` kind on win32, and forward-slash-only key comparisons.

### After (verified)

Settings migrated to `pnpm-workspace.yaml` (snippet above), peers at `^0.0.1-rc.1` with `@deepseek-ai/cordis: ^4.0.1-rc.1`, auth token removed, shim at `node_modules/@deepseek-ai/cordis` publishing the scoped name (legacy bare shim removed in `write` and flagged in `--check`), and the script uses per-target link kinds + `HOME ?? USERPROFILE` + separator normalization. Verified on Windows (pnpm 11.8) by the fix commit and on macOS (pnpm 10.28.1) by a fresh `pnpm i` → `prepare` links 217 entries → `pnpm build` green; dsh-llm-fallbacks re-verified the extended set (215 packages + cordis shim, `dsh:link:check` OK, 319/319 tests).

### Stale references

Resolved: `README.md` (Development section) described `node-linker=hoisted` / `auto-install-peers=false` as `.npmrc` settings and cordis as a `^4.0.0-rc.7` devDependency overriding a bare `node_modules/cordis` — both paragraphs now point at `pnpm-workspace.yaml` and the scoped `@deepseek-ai/cordis` peer.
