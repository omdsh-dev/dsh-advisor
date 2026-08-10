# Install guide

How to install `dsh-advisor` into a dsh profile, verify the install, and
uninstall. The quick version lives in the [README](../README.md#install).

## Prerequisites

- A dsh runtime environment (`$DSH_HOME`, default `~/.dsh`) whose source tree
  is at `$DSH_SOURCE_DIR` (default `${DSH_HOME}/source/current`) — needed by
  the host-patch scripts and by dev-time type checking / tests.
- Builds need **node** (≥ 22) and **pnpm** (≥ 10) — the bundle self-builds in
  `prepare` (`tsc`, no bun).
- The target profile (e.g. `web`) is writable; restart the dsh session after
  installing.

## 1. One-line git install

```sh
dsh plugin --profile web add github:dsh-external/dsh-advisor   # <name> = your profile name; pin a commit with #<sha>
# The full URL form works equivalently:
# dsh plugin --profile web add https://github.com/dsh-external/dsh-advisor.git
```

A git install fetches **sources, not built artifacts**, so the bundle builds
itself on install. Points to note:

- **prepare self-build**: pnpm runs the package's `prepare` script (`node
  scripts/setup-dsh-links.mjs && pnpm build && bash
  scripts/autopatch-install.sh`) while installing — the dev-time link farm, the
  build, and the install-time host-patch autopatch. Dev-time resolution of the
  private `@deepseek-ai/dsh-*` packages (and the in-box `cordis` / `react` /
  `react-dom` identities) comes from the **local dsh source tree** via
  `$DSH_SOURCE_DIR` / `$DSH_HOME` — the same tree the host runs from — so no
  `peer-stubs/` copies exist and no private-registry access is needed.
- **pnpm ≥ 10 build allowlist (every first `add`)**: pnpm ≥ 10 refuses to run a
  git dependency's `prepare` / `postinstall` by default. The first `add` fails
  with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and prints the exact package key
  (`dsh-advisor`). Add it to the profile's `pnpm-workspace.yaml`:

  ```yaml
  # $DSH_HOME/profiles/web/pnpm-workspace.yaml
  onlyBuiltDependencies:
    - dsh-advisor
  # pnpm ≥ 10.26 also accepts the allowBuilds form:
  # allowBuilds:
  #   dsh-advisor: true
  ```

  then re-run the `add`; alternatively `dsh plugin --profile web
  approve-builds` selects it interactively. Treat that allowance as what it is:
  permission to execute the package's code on your machine at install time,
  outside any sandbox the agent runs under. Only allow packages whose source
  you trust, and pin a commit (`#<sha>`) so a later push cannot silently change
  what runs.
- **Transport**: the `github:` shorthand is resolved by pnpm (HTTPS preferred,
  SSH fallback on probe failure); the explicit https URL form pins HTTPS.
  `#<ref>` version pinning works in both forms.
- **Autopatch**: git installs run `scripts/autopatch-install.sh` from both
  `prepare` and `postinstall` — it idempotently applies the host exposure patch
  to the local dsh source tree and warns, never fails, on failure. Opt out
  entirely with `DSH_ADVISOR_AUTOPATCH=0` (the `onlyBuiltDependencies` entry
  above gates both lifecycle scripts).

## 2. Local directory install (development / verification)

```sh
pnpm install                  # build the bundle (prepare self-build)
dsh plugin --profile web add .   # <name> = your profile name
```

`dsh plugin add` appends the bundle to the profile's `dsh.profile.bundles`
(the package declares `dsh.bundle`); the bundle inserts one plugin row —
`id: advisor`, `name: dsh-advisor` (see `cordis.patch.yml`). A local `add .`
goes through pnpm's `link:` dependency, for which pnpm does **not** run
prepare/postinstall — so the autopatch does not trigger on this path. If the
host does not yet expose the `advisor` namespace, apply the host patch once
manually:

```sh
bash scripts/autopatch-install.sh    # idempotent: skips when applied / natively supported; warns only
# or explicitly: scripts/apply-dsh-patch.sh && scripts/verify-dsh-patch.sh
```

## 3. Tarball install

```sh
pnpm pack
dsh plugin --profile web add dsh-advisor-0.0.1.tgz
```

A tarball ships the built artifacts (`lib/` + `cordis.patch.yml` + the
`patches/` and `scripts/` host-patch mechanism), so no `prepare` script runs
and no build permission is needed. Runtime dependencies (`cordis`,
`schemastery`, and `@deepseek-ai/dsh-{session,agent,llm,commands,timeout}`)
are declared as peerDependencies and resolved by the dsh installation's flat
profile module fallback — no extra install step. Tarball installs do not run
the autopatch: apply the host patch manually (below) when the host does not
yet expose `advisor`.

## 4. Host patch (web Settings page)

The web Settings page reads and writes settings namespaces through the dsh
host's apiproxy, which only exposes model-provider namespaces plus
`permission` and `ui-onboarding` to configuration clients. The `advisor`
namespace is outside that boundary: without the patch the page cannot
round-trip the Advisor section — the store detects the unexposed namespace and
shows an explicit notice instead of a writable form (the shipped plugin-side
mitigation).

The bundle ships the **fix mechanism** for this host-side gap (C-1): a minimal
git patch that adds `advisor` to the host's exposure allowlist
(`PRODUCT_SETTINGS_NAMESPACES` in
`packages/host/apiproxy/src/api-proxy.ts`), plus apply / revert / verify
scripts and the install-time autopatch — see
[`patches/README.md`](../patches/README.md). It is needed when the host does
not yet expose `advisor` (the pinned baseline dsh-private b8343cb does not);
re-run after every dsh upgrade, which resets host changes.

```sh
export DSH_SOURCE_DIR="$DSH_HOME/source/current"   # or just set DSH_HOME
scripts/apply-dsh-patch.sh --check   # read-only applicability check
scripts/apply-dsh-patch.sh           # apply + rebuild the host package
scripts/verify-dsh-patch.sh          # assert source + build artifact markers
scripts/revert-dsh-patch.sh          # roll back (e.g. before a dsh upgrade)
```

Git installs run the autopatch automatically (`postinstall` and `prepare`);
opt out with `DSH_ADVISOR_AUTOPATCH=0`. **Security:** the apply/revert scripts
(and the autopatch) run the target tree's build code (`tsc` / `tsdown`) at
apply/install time, outside any sandbox the agent runs under — only point them
at a dsh source tree you trust, and treat the `onlyBuiltDependencies`
allowance as permission to execute this package's install-time code.

## 5. Verify

```sh
dsh --profile web --dump-config   # shows a "# == dsh-advisor" layer with the advisor row
dsh --profile web
```

After booting, the web Settings page renders the Advisor section; once the
host exposes the namespace (patch applied), the section reads and writes the
`advisor` settings namespace live — saving applies to new sessions
immediately.

## 6. Uninstall

```sh
dsh plugin --profile web remove dsh-advisor
dsh --profile web --dump-config   # confirm the dsh-advisor layer is gone
```

Restart the dsh session to complete the uninstall.
