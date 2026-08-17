---
module: dsh plugin development (standalone bundle)
date: 2026-08-11
problem_type: developer_experience
category: developer-experience
severity: medium
title: Building a standalone dsh plugin bundle against private @deepseek-ai packages
description: Verified recipe for a path-free standalone dsh plugin repo: dev-time resolution of private @deepseek-ai packages from the npm registry via autoInstallPeers + registry auth (superseding the committed link-farm script, peer-stubs, and gitignored shim overlay), prepare-based git-URL installs, bundle packaging, and install smoke testing.
tags:
  - dsh
  - plugin
  - bundle
  - link-farm
  - peer-dependencies
  - git-install
  - prepare
last_updated: 2026-08-15
applies_when:
  - Creating a new standalone dsh plugin package outside the dsh monorepo
  - Debugging module-resolution failures for @deepseek-ai imports in a plugin
  - Packaging a dsh bundle for `dsh plugin add` distribution (tarball or git URL)
  - Making a plugin installable from a git URL (needs a prepare build)
---

# Standalone dsh plugin development (verified recipe)

## Context

dsh (DeepSeek Harness) is Cordis-based: a plugin is a module exporting `apply(ctx)`, shipped as an npm bundle declaring a dsh.bundle manifest pointing at a `cordis.patch.yml`; the patch inserts loader rows (`- insert: - id: <row> name: <package>`). Users install with `dsh plugin --profile <name> add <spec>`.

The blocker for out-of-tree development: the `@deepseek-ai/dsh-*` packages are **private on npm** — dev-time typecheck/build needs them resolvable from the registry (auth token in `~/.npmrc`), while runtime resolution comes from the dsh installation itself (two-anchor bundle resolution: installation first, then profile dir; a flat fallback under `$DSH_HOME` profiles' `node_modules` makes every in-box package Node-resolvable from any profile via parent-walk). Runtime imports therefore belong in **peerDependencies**.

## Guidance

1. **Committed files stay path-free.** All machine-local paths live only in gitignored scratch. The earlier gitignored dev-overlay shims were retired (see "What Didn't Work").
2. **Dev-time resolution from the npm registry via `autoInstallPeers` (current, verified).** The private packages stay **peerDependencies only**; dev-time typecheck/build/tests resolve the REAL packages from the npm registry. `pnpm-workspace.yaml` sets `autoInstallPeers: true` + `nodeLinker: hoisted` (pnpm 11+ ignores non-auth settings in `.npmrc`), and the user-level `~/.npmrc` carries the registry auth token; `prepare` runs `pnpm build` only, so any clone is immediately buildable with no source-tree prerequisite. The cordis peer is scoped `@deepseek-ai/cordis` (never bare `cordis`); peer ranges against prerelease publishes carry the exact tag (`^0.1.0-rc.7` for the dsh-* peers). This supersedes the earlier source-tree linking approach (see "What Didn't Work").
3. **`moduleResolution: bundler` is required** (cordis's published d.ts has extensionless relative imports; `node16` unusable). For client halves, split tsconfigs (node build excludes `src/client`; `tsconfig.client.json` adds jsx/DOM; `tsconfig.spec.json` for component tests).
4. **Build with `prepack` AND `prepare`.** `prepack` runs at `pnpm pack` time (tarball contains `lib/` + manifest only). `prepare` (`pnpm build`) is what makes **git-URL installs** work: pnpm ≥10 runs a git dependency's `prepare` inside a temp clone, gated behind `onlyBuiltDependencies` (the profile workspace manifest) or `allowBuilds` (pnpm ≥10.26); the first `add` fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and prints the fix. Tarball installs never run `prepare` (ships built artifacts).
5. **Install smoke without touching the real installation**: workspace-local `DSH_HOME` → `dsh plugin --profile <scratch> add <spec>` → `dsh --profile <scratch> --dump-config` (row present, 0 stderr). For git-spec verification use a real git spec (`git+file://...#<branch>` reproduces the git-dep semantics; a bare directory path is treated as a link and does NOT run prepare). The profile must add `onlyBuiltDependencies` once.
6. **Cordis inject service names are plural**: `sessions`, `agents`, `llm`, `commands` (singular names leave the plugin PENDING forever). `commands` should be injected conditionally (`ctx.inject(['commands'], ...)`).
7. **`skipLibCheck: true` may still be needed** for registry-schemastery/cordis d.ts interplay; keep the flag, drop the stale rationale comment when the reason no longer applies.

## Why This Matters

The naive approaches all fail in confusing ways: `file:` devDeps with absolute paths are uncommittable; a gitignored overlay requires `DSH_SOURCE` pointing at a local dsh checkout (impossible in a git clone — so **git-URL installs fail**); tsconfig `paths` split the runtime cordis identity; symlinks silently destroy type augmentations. Registry resolution keeps installs buildable with a single documented prerequisite (a `~/.npmrc` registry token), removes the stub and prior source-tree drift surfaces, and is drift-bounded by the plugin's own typecheck/build/tests (which type and run against the registry peer versions the plugin declares).

## When to Apply

Any standalone dsh plugin repo (this repo is the reference implementation: `dsh-advisor`). For plugins developed inside the dsh monorepo, none of this applies.

## What Didn't Work

- **Gitignored dev-overlay shims**: worked for local dev but made git-URL install impossible (the clone lacks the overlay and `DSH_SOURCE`), and the 10-package transitive devDeps existed only for the real d.ts closure. Replaced by committed peer-stubs; the overlay files and the workspace manifest were deleted.
- **Committed peer-stubs**: one stub package per directly-consumed private package (type-only stubs for types-only use; minimal-but-honest runtime stand-ins for value imports; a mirror-commit pin in each stub description, enforced mechanically by a test). Hermetic installs, but maintained a parallel stub surface that could drift from the real packages. Superseded by the dev-time **link farm** (see below), which removed the stub copies entirely.
- **`prepare` as a no-op / build-only**: git installs fail to load unless `prepare` actually builds (`pnpm build`), and pnpm ≥10 gates it behind the allowlist — both must be documented for the operator.
- **Committed dev-time link farm (2026-08-10 PR #3 → removed 2026-08-13, registry-rc.5 peers / PR #13)**: `scripts/setup-dsh-links.mjs` (wired into `prepare` before `pnpm build`; standalone as `pnpm dsh:link`, checked with `pnpm dsh:link:check`) symlinked every `@deepseek-ai/*` package a local dsh source tree declared into `node_modules/@deepseek-ai/` — skipping tool CLIs with a `bin`, providing a bin-less shim for the in-box `cordis` framework, and copying the tree's `react`/`react-dom` for a single module identity. Worked for local dev but made every clone depend on a local dsh source tree (`$DSH_SOURCE_DIR` / `${DSH_HOME}/source/current`) and needed Windows Developer Mode for file symlinks; the registry move (PR #13 / commit `95fc050`, see `CHANGELOG.md`) removed it entirely.

## Examples

- Historical evidence (peer-stubs era): `pnpm install` (no `DSH_SOURCE`) exit 0 → typecheck/build/test green → tarball AND a pinned-sha install of the repo's git URL verified (literal command, allowlist fix, `--dump-config` row present).
- Current (registry-peer era): the dsh-advisor `prepare` (`pnpm build`) is exercised on every clone with Node ≥ 22 + a `~/.npmrc` registry token; `tests/peer-deps.test.ts` is the CI-able assertion that the registry-peer contract holds (peer-only, rc.7 pins, `autoInstallPeers`, scoped schemastery, prepare build-only).
