# AGENTS.md — dsh-advisor

Project-level rules for coding agents in this repository. This file is the
**project layer**; the Morning Star harness lives under `.mstar/` (see
[Process artifacts](#process-artifacts)).

## Source priority

1. The current user instruction
2. This file (project rules)
3. `.mstar/` harness rules (`mstar-*` skills)
4. Role references (`mstar-roles`)

## Repository

`dsh-advisor` is a standalone TypeScript plugin bundle for dsh (DeepSeek
Harness), porting the omp "advisor" subsystem: a **per-session reviewer
model** that observes the primary transcript, reviews each stepped turn with
an explicitly configured model (provider + model are required), and injects
severity-ranked advice (nit / concern / blocker) back into the session —
without polluting or recursively reviewing itself. It is advisory only: it
never approves or rejects the primary agent's actions.

- Mounts into dsh as a **bundle** (`dsh.bundle.patch` → `cordis.patch.yml`)
  inserting one plugin row (`id: advisor`) — no host patching, no
  postinstall step.
- Runtime: Node ^22.19 || >=24, pnpm 11.21+ (project stack: pnpm 11.21.0 in
  CI). Private `@deepseek-ai/*` packages are `peerDependencies` ONLY,
  resolved from the npm registry (see [Code constraints](#code-constraints)).
- License: MIT (`LICENSE` is authoritative).

## Build & test interface

- `pnpm typecheck` — full typecheck (`tsc --noEmit` over the main, client,
  and spec tsconfigs).
- `pnpm build` — `tsc -p tsconfig.build.json` → `node scripts/build-client.mjs`.
- `pnpm test` — vitest run (full suite; includes the release-script
  contract tests in `tests/prepare-release.test.ts`).
- **Release prep — no `pnpm release:*` scripts**: the Release prep workflow
  (`.github/workflows/release-prep.yml`) runs
  `node scripts/prepare-release.mjs [version]` (see
  [Release flow](#release-flow)).
- Local workflow lint (not in CI): `actionlint .github/workflows/*.yml`
  (ci + release-prep + release).

## Changelog

`CHANGELOG.md` is **auto-generated from git log** by
`scripts/prepare-release.mjs` during release prep: it resolves the commit
range since the previous release tag and writes a `## [X.Y.Z] - YYYY-MM-DD`
section (existing sections are preserved; re-running the same version does
not duplicate it). There is **no `.changes/` fragment model** (unlike the
sibling dsh-llm-fallbacks) — nothing to write per change; the changelog
section is derived from the commits that ship in the release PR.

## Release flow

PR-driven, two steps — merging the release PR is the ONLY publish path
(no `push:tags` auto-publish):

1. **Release prep** (manual: Actions → Release prep → Run workflow): runs
   `scripts/prepare-release.mjs`, bumps `package.json` (+ lockfile sync),
   validates (typecheck + build + test), and opens/updates a
   `release vX.Y.Z` PR (base `main`, label `release`). Pass an explicit
   version (`X.Y.Z` or `X.Y.Z-alpha.N`) or leave the input empty for an
   auto bump that **stays on the current prerelease line**
   (`0.1.3-alpha.3` → `0.1.3-alpha.4`; it never silently drops the suffix
   to a formal version). An empty commit range (no releaseable content)
   or an already-tagged version fails the prep.
2. **Merge the PR** → `release.yml` runs on the merge commit: validate →
   sanity gate (typecheck + build + test) → `npm publish --provenance
   --access public` (OIDC trusted publishing, no npm secrets) → tag
   `vX.Y.Z` → GitHub Release. Prerelease versions publish to their
   prerelease dist-tag (`alpha`, never touching `latest`) and are marked
   Pre-release on GitHub; formal versions publish to `latest`.

> **Current policy (maintainer-owned; full callouts in `docs/release.md`):**
> release ONLY alpha prereleases (`X.Y.Z-alpha.N`) until further notice,
> and ONLY when the merged content carries substantive changes (code /
> behavior / user-visible docs or config). Trivial commits merge straight
> to `main` and ride the next substantive release.

Secrets: **zero long-term secrets**. npm auth is OIDC trusted publishing
(tokenless); workflows use only the built-in `GITHUB_TOKEN` (release-prep
additionally uses a PAT for the label/PR steps). Full SOP and rollback →
`docs/release.md`.

## Code constraints

- **Mount-only**: the plugin never modifies the dsh source tree (bundle
  insert only; no patches, no postinstall step). Keep it that way.
- **Peers from the public registry**: all `@deepseek-ai/*` packages are
  `peerDependencies` ONLY — resolved from the npm registry at dev time
  (`autoInstallPeers` in `pnpm-workspace.yaml` + user-level `~/.npmrc`
  token), never added to `dependencies`/`devDependencies`, never linked
  locally. `tests/peer-deps.test.ts` enforces this contract.
- **English commit messages**, conventional style (`feat:`, `fix:`,
  `docs:`, `chore:`, ...).
- **Feature branch → PR → main** for all changes; never commit directly to
  `main`.
- Match existing patterns and keep diffs surgical.

## Process artifacts

`.mstar/` is the Morning Star harness's local process SSOT: process artifacts
(`plans/`, `sdd/`, `status.json`, `iterations/`, ...) are **gitignored**;
tracked results are `.mstar/knowledge/` and `.mstar/specs/` (the frozen
`advisor-plugin.md` spec is the `primary_spec` anchor). Harness rules live
in the `mstar-*` skills; harness-layer details (path symbols, content
boundaries) are in `.mstar/AGENTS.md`. This file intentionally carries no
dynamic state, current progress, or review details.
