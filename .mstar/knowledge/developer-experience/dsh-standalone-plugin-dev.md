---
module: dsh plugin development (standalone bundle)
date: 2026-08-10
problem_type: developer_experience
category: developer-experience
severity: medium
title: Building a standalone dsh plugin bundle against private @deepseek-ai packages
description: Verified recipe for a path-free standalone dsh plugin repo: dev-time resolution of private @deepseek-ai packages via committed peer-stubs (superseding the gitignored shim overlay), prepare-based git-URL installs, bundle packaging, and install smoke testing.
plan_id: dsh-advisor-settings-n2
tags:
  - dsh
  - plugin
  - bundle
  - peer-stubs
  - peer-dependencies
  - git-install
  - prepare
last_updated: 2026-08-10
applies_when:
  - Creating a new standalone dsh plugin package outside the dsh monorepo
  - Debugging module-resolution failures for @deepseek-ai imports in a plugin
  - Packaging a dsh bundle for `dsh plugin add` distribution (tarball or git URL)
  - Making a plugin installable from a git URL (needs a prepare build)
---

# Standalone dsh plugin development (verified recipe)

## Context

dsh (DeepSeek Harness) is Cordis-based: a plugin is a module exporting `apply(ctx)`, shipped as an npm bundle declaring a dsh.bundle manifest pointing at a `cordis.patch.yml`; the patch inserts loader rows (`- insert: - id: <row> name: <package>`). Users install with `dsh plugin --profile <name> add <spec>`.

The blocker for out-of-tree development: the `@deepseek-ai/dsh-*` packages are **private (not on npm)** — dev-time typecheck/build needs them locally, while runtime resolution comes from the dsh installation itself (two-anchor bundle resolution: installation first, then profile dir; a flat fallback under `$DSH_HOME` profiles' `node_modules` makes every in-box package Node-resolvable from any profile via parent-walk). Runtime imports therefore belong in **peerDependencies**.

## Guidance

1. **Committed files stay path-free.** All machine-local paths live only in gitignored scratch. The earlier gitignored dev-overlay shims was retired in iter-20260810-dsh-advisor-n2 (see "What Didn't Work").
2. **Committed peer-stubs replace the dev overlay (KD-R1, verified).** One stub package per DIRECTLY-consumed private package, wired as file-prefixed stub specs pointing at the peer-stubs directory devDependencies (peerDependencies keep the plain `^0.0.1` range for runtime). Stub `package.json` shape: name, version 0.0.1, private, `type: module`, main/types, and a description carrying the mirrored dsh-private commit. Taxonomy:
   - **Type-only stubs** (types only): packages consumed only as types (e.g. `dsh-agent` when only `Agent`/events are used).
   - **Minimal runtime stand-ins** (main + types pointing at the stub's index.ts): packages with value imports (e.g. `dsh-llm` LlmService/LlmAdapter plus `createUserMessage`/quota codes, `dsh-session` surface helpers, `dsh-commands` CommandId, `dsh-timeout` deadline/timeoutOf). They must be **minimal-but-honest** — implement what the plugin's own tests exercise, throw loudly outside the consumed surface, and mirror the real semantics where tests depend on them (quota-wording classifier, fold range validation, real-timer hang protection). A no-op lie is worse than a missing stub.
   - **Mirror-commit pin enforced mechanically**: every stub description carries the mirrored dsh-private commit token; `tests/peer-stubs.test.ts` asserts each stub description matches the token and every `@deepseek-ai/*` devDep is a file-prefixed stub specs pointing at the peer-stubs directory spec (data-driven — no hard-coded count, so growing the stub set never breaks the test).
   - `cordis`/`schemastery` stay **registry** devDeps (public npm) — do not stub them. Only the private `@deepseek-ai/*` need stubs; do NOT add transitive private packages that exist only for the real d.ts closure (e.g. `dsh-brand`/`dsh-invariants`/`dsh-scope`/`dsh-system-prompt`/`dsh-type-meta` were dropped when the overlay was retired).
3. **`moduleResolution: bundler` is required** (cordis's published d.ts has extensionless relative imports; `node16` unusable). For client halves, split tsconfigs (node build excludes `src/client`; `tsconfig.client.json` adds jsx/DOM; `tsconfig.spec.json` for component tests).
4. **Build with `prepack` AND `prepare` (n2 change).** `prepack` runs at `pnpm pack` time (tarball contains `lib/` + patch + manifest only). `prepare` (same `pnpm build`) is what makes **git-URL installs** work: pnpm ≥10 runs a git dependency's `prepare` inside a temp clone (with devDeps installed — `file:` stubs included), gated behind `onlyBuiltDependencies` (the profile workspace manifest) or `allowBuilds` (pnpm ≥10.26); the first `add` fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and prints the fix. Tarball installs never run `prepare` (ships built artifacts).
5. **Install smoke without touching the real installation**: workspace-local `DSH_HOME` → `dsh plugin --profile <scratch> add <spec>` → `dsh --profile <scratch> --dump-config` (row present, 0 stderr). For git-spec verification use a real git spec (`git+file://...#<branch>` reproduces the git-dep semantics; a bare directory path is treated as a link and does NOT run prepare). The profile must add `onlyBuiltDependencies` once.
6. **Cordis inject service names are plural**: `sessions`, `agents`, `llm`, `commands` (singular names leave the plugin PENDING forever). `commands` should be injected conditionally (`ctx.inject(['commands'], ...)`).
7. **`skipLibCheck: true` may still be needed** for registry-schemastery/cordis d.ts interplay; keep the flag, drop the stale rationale comment when the reason no longer applies.

## Why This Matters

The naive approaches all fail in confusing ways: `file:` devDeps with absolute paths are uncommittable; a gitignored overlay requires `DSH_SOURCE` pointing at a local dsh checkout (impossible in a git clone — so **git-URL installs fail** without committed stubs); tsconfig `paths` split the runtime cordis identity; symlinks silently destroy type augmentations. Committed peer-stubs keep installs hermetic (any clone: `pnpm install` exit 0, no env), enable git-URL installs, and stay drift-bounded by the mirror-commit pin + the plugin's own tests.

## When to Apply

Any standalone dsh plugin repo (this repo is the reference implementation: `dsh-advisor`). For plugins developed inside the dsh monorepo, none of this applies.

## What Didn't Work (iter-20260810-dsh-advisor-n2 KD-R1 supersession)

- **Gitignored dev-overlay shims (KD-1, MVP)**: worked for local dev but made git-URL install impossible (the clone lacks the overlay and `DSH_SOURCE`), and the 10-package transitive devDeps existed only for the real d.ts closure. Replaced by committed peer-stubs in n2; the overlay files and the workspace manifest were deleted.
- **`prepare` as a no-op / build-only**: git installs fail to load unless `prepare` actually builds (`pnpm build`), and pnpm ≥10 gates it behind the allowlist — both must be documented for the operator.

## Examples

- `dsh-advisor` n2 (evidence of record): peer-stubs → `pnpm install` (no `DSH_SOURCE`) exit 0 → typecheck/build/test green → tarball AND a pinned-sha install of the repo's git URL verified (literal command, allowlist fix, `--dump-config` row present).
