# Install guide

How to install `dsh-advisor` into a dsh profile, verify the install, and
uninstall. The quick version lives in the [README](../README.md#install).

## Prerequisites

- A dsh runtime environment (`$DSH_HOME`, default `~/.dsh`) whose source tree
  is at `$DSH_SOURCE_DIR` (default `${DSH_HOME}/source/current`) — needed by
  the dev-time link farm (the `prepare` build) and by dev-time type checking /
  tests.
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
  scripts/setup-dsh-links.mjs && pnpm build`) while installing — the dev-time
  link farm and the build. Dev-time resolution of the private
  `@deepseek-ai/dsh-*` packages (and the in-box `cordis` / `react` /
  `react-dom` identities) comes from the **local dsh source tree** via
  `$DSH_SOURCE_DIR` / `$DSH_HOME` — the same tree the host runs from — so no
  private-registry access is needed.
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

## 2. Local directory install (development / verification)

```sh
pnpm install                  # build the bundle (prepare self-build)
dsh plugin --profile web add .   # <name> = your profile name
```

`dsh plugin add` appends the bundle to the profile's `dsh.profile.bundles`
(the package declares `dsh.bundle`); the bundle inserts one plugin row —
`id: advisor`, `name: dsh-advisor` (see `cordis.patch.yml`). A local `add .`
goes through pnpm's `link:` dependency, for which pnpm does **not** run
prepare/postinstall — build the bundle with `pnpm install` (or `pnpm build`)
before adding. No host patching is involved: the plugin runs entirely from its
plugin config row (see [Web Settings exposure](#4-web-settings-exposure)).

## 3. Tarball install

```sh
pnpm pack
dsh plugin --profile web add dsh-advisor-0.0.1.tgz
```

A tarball ships the built artifacts (`lib/` + `cordis.patch.yml`), so no
`prepare` script runs and no build permission is needed. Runtime dependencies
(`cordis`, `schemastery`, and `@deepseek-ai/dsh-{session,agent,llm,commands,timeout}`)
are declared as peerDependencies and resolved by the dsh installation's flat
profile module fallback — no extra install step.

## 4. Web Settings exposure

The dsh web Settings page's **"插件配置" (Plugin Configuration)** page renders
one card per plugin that registers into the `settings.plugin.item` card slot.
The Advisor card (`id advisor`, rendered after the upstream bash / agent-loop /
web-search cards) reads and writes settings namespaces through the dsh host's
apiproxy, which exposes only an allowlist of namespaces to configuration
clients: model-provider namespaces plus product namespaces (locale /
permission / ui-conversation / ui-theme / ui-onboarding / agent-presets).
**Upstream dsh has no registration-level opt-in** (`exposeToWebClients` does
not exist in upstream `SettingsRegisterOptions` — verified against the
pristine 20da39e snapshot), so the `advisor` namespace is **not on the
apiproxy allowlist**. The Advisor card does not depend on that allowlist: it
talks to the host through the **official `GatewayService` RPC channel** — the
plugin registers `AdvisorConfigGateway` (a `GatewayService` with
`@Remote('get')`/`@Remote('set')` methods), the host's typertGateway claims
`/api/advisor/get` + `/api/advisor/set` (the same mechanism the dsh `goals`
service uses), and the card calls them via `connection.rpc`. The in-process
write (`ctx.settings.update`) carries no exposed-namespace check, so saving
works on any dsh build that ships the GatewayService channel. No host patching
is applied or required.

## 5. Verify

```sh
dsh --profile web --dump-config   # shows a "# == dsh-advisor" layer with the advisor row
dsh --profile web
```

After booting, the web Settings page's "插件配置" page renders the Advisor
card; it reads and writes the `advisor` namespace live through
`/api/advisor/get` + `/api/advisor/set` — saving applies to new sessions
immediately.

## 6. Uninstall

```sh
dsh plugin --profile web remove dsh-advisor
dsh --profile web --dump-config   # confirm the dsh-advisor layer is gone
```

Restart the dsh session to complete the uninstall.
