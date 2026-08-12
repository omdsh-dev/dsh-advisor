---
module: install toolchain (pnpm + dev-time link farm)
date: 2026-08-12
problem_type: developer_experience
category: developer-experience
severity: high
title: pnpm 11 workspace-config migration and Windows-safe link farm (dsh plugin bundle)
description: Verified cross-platform install fix for the dsh-advisor bundle: pnpm 11+ silently ignores non-auth settings in .npmrc (autoInstallPeers / nodeLinker must live in pnpm-workspace.yaml), peerDependencies ranges must match published prerelease tags (^0.0.1 never matches 0.0.1-rc.1), and the link-farm script needs Windows handling (USERPROFILE, junction-vs-file link kinds, separator normalization).
tags:
  - pnpm
  - pnpm-workspace-yaml
  - npmrc
  - windows
  - node-linker
  - link-farm
  - peer-dependencies
  - prerelease
  - junction
  - dsh
last_updated: 2026-08-12
applies_when:
  - Running pnpm install with pnpm 11.x in a repo whose pnpm settings live in .npmrc
  - Making a symlink-based dev-time link farm work on Windows
  - Declaring peerDependencies against @deepseek-ai packages published only as prereleases
---

# pnpm 11 workspace-config migration and Windows-safe link farm

## Context

`pnpm install` was broken on Windows under pnpm 11.8 for the dsh-advisor bundle (PR #11, `fix/install` branch). Five distinct issues blocked it; three are general pnpm-11 behaviors, two are Windows-specific gaps in the committed link-farm script. Fixed in commit `cdee4a2`, merged as PR #11, and re-verified on macOS (pnpm 10.28.1): `prepare` links 217 entries from the dsh source tree and the build passes.

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

4. **Windows has no `HOME`.** Resolve the dsh source tree with `process.env.HOME ?? process.env.USERPROFILE`.

5. **Windows link kinds are per-target, not global.** Junctions are directory-only (and need no privileges); file symlinks need Developer Mode or an admin shell. Pick per target: `statSync(target).isDirectory() ? 'junction' : 'file'` — otherwise the cordis shim's file entries (`index.js` / `index.d.ts`) get broken junctions.

6. **Normalize path separators before comparing managed keys.** Windows `readdir` returns backslash-separated paths; strip the `node_modules` prefix with `^node_modules[/\\]` and convert `\` → `/` so stale-prune keys match the managed Map.

## Why This Matters

The pnpm-11 `.npmrc` ignore is the dangerous failure mode: it fails the *design invariant* (private peers must never come from the registry) while the install still reports success on the surface — the breakage surfaces later as wrong module identities or missing peer versions, or an ERESOLVE only when the peer range also mismatches. The Windows link issues are plain install blockers (EPERM / broken junctions) that make the bundle uninstallable on the platform where its users actually run `pnpm 11` (the dsh profile convention is hoisted + no-auto-peers, so both settings matter on every platform).

## When to Apply

- Any pnpm ≥ 11 repo: verify pnpm settings live in `pnpm-workspace.yaml`, not `.npmrc` (pnpm ≥ 10.26 also accepts `allowBuilds` there).
- Any repo declaring peers against packages published only as prereleases: write the range with the prerelease tag.
- Any link/symlink script that must run on Windows: per-target link kind, `USERPROFILE` fallback, separator normalization.
- Extending the dsh-advisor link farm (`scripts/setup-dsh-links.mjs`) or porting the recipe to another standalone dsh plugin.

## Examples

### Before (broken)

`.npmrc` held `auto-install-peers=false` + `node-linker=hoisted` + `_authToken=${NPM_TOKEN}`; `package.json` peers at `^0.0.1`; link script used `process.env.HOME`, a single `'junction'` kind on win32, and forward-slash-only key comparisons.

### After (verified)

Settings migrated to `pnpm-workspace.yaml` (snippet above), peers at `^0.0.1-rc.1`, auth token removed, and the script uses per-target link kinds + `HOME ?? USERPROFILE` + separator normalization. Verified on Windows (pnpm 11.8) by the fix commit and on macOS (pnpm 10.28.1) by a fresh `pnpm i` → `prepare` links 217 entries → `pnpm build` green.

### Known stale reference

`README.md` (Development section) still describes `node-linker=hoisted` / `auto-install-peers=false` as `.npmrc` settings — update it to point at `pnpm-workspace.yaml` when the README is next touched.
