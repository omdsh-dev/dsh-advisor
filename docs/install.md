# Install guide

How to install `dsh-advisor` into a dsh profile, verify the install, and
uninstall. The quick version lives in the [README](../README.md#install).

## Prerequisites

- A dsh runtime environment (`$DSH_HOME`, default `~/.dsh`) and a writable
  target profile (e.g. `web`); restart the dsh session after installing.
- A registry install needs only pnpm on PATH (`dsh plugin` is a pnpm
  forwarder). Building from source (git / local / tarball installs below)
  additionally needs **node** (≥ 22) and registry auth for the private
  `@deepseek-ai/*` peers — `prepare` runs `pnpm build` only (no `DSH_HOME`
  source-tree prerequisite for dependency resolution; the peers resolve from
  the npm registry via `autoInstallPeers` + the `~/.npmrc` auth token).

## 1. One-line registry install

```sh
dsh plugin --profile web add dsh-advisor   # <name> = your profile name
# Pin an exact version for reproducibility:
# dsh plugin --profile web add dsh-advisor@0.1.0
```

A registry install fetches the published tarball, which ships the built
artifacts (`lib/` + `cordis.patch.yml`) and has no `install` / `postinstall`
scripts — no `prepare` build runs and no build permission is needed. Runtime
dependencies (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, and the `@deepseek-ai/dsh-*`
peers) are declared as peerDependencies and resolved by the dsh installation's
flat profile module fallback — no extra install step.

- **Version pinning**: append `@<version>` to pin (e.g. `dsh-advisor@0.1.0`).
  Registry packages have no commit pinning; use the [local directory
  install](#2-local-directory-install-development--verification) to test
  un-released changes.

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
plugin config row (see [Web Settings exposure](#5-web-settings-exposure)).

## 3. Tarball install

```sh
pnpm pack
dsh plugin --profile web add dsh-advisor-0.1.0.tgz
```

A tarball ships the built artifacts (`lib/` + `cordis.patch.yml`), so no
`prepare` script runs and no build permission is needed. Runtime dependencies
(`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, and `@deepseek-ai/dsh-{session,agent,llm,commands,timeout}`)
are declared as peerDependencies and resolved by the dsh installation's flat
profile module fallback — no extra install step.

## 4. dsh-tui profile install

The advisor also installs into the terminal TUI profile (`dsh --profile
dsh-tui`) with the same commands as the web profile:

```sh
dsh plugin --profile dsh-tui add dsh-advisor   # <name> = your profile name
# Pin an exact version for reproducibility:
# dsh plugin --profile dsh-tui add dsh-advisor@0.1.0
# Local-dir variant (from a built checkout):
dsh plugin --profile dsh-tui add .
```

The bundle inserts the same `- insert: id: advisor` row into the dsh-tui
profile's patch layer (`~/.dsh/profiles/dsh-tui/cordis.patch.yml`). Each
profile carries its own advisor entry config there — the row's `config`
fields are schema-volatile live fields (dsh ≥ 0.1.7-rc.1), committed by the
Loader without a remount; there is no global settings.yaml section anymore
(a pre-0.1.7 one is imported into the active profile and renamed
`.imported` on first boot). On dsh-tui ≥ v0.8.0 the TUI `/settings` screen
also edits the same five keys (`enabled` / `provider` / `model` /
`immuneTurns` / `maxDeltaMessages`) in its Advisor section — edits are
staged and written on save through the revision-fenced `settings.mutate`
into the same advisor entry config (persisted in the profile patch),
re-applying live without a restart. The section ships with the
`dsh-tui-settings-sections` row in the v0.8.0+ bundle; on older dsh-tui
versions it is a clean no-op and the profile patch layer remains the edit
path. `systemPrompt` is not a TUI field (single-line input) — edit it via
the web card or the profile patch layer. `/advisor config` is the readback
(read-only, with edit hints naming the `/settings` screen when the seam is
mounted), and `/advisor` / `on|off|status|config` surface in the TUI `/`
menu with subcommand completion (requires the `dsh-tui-command-trees` row,
shipped in the dsh-tui bundle).

Verify:

```sh
dsh --profile dsh-tui --dump-config   # shows a "# == dsh-advisor" layer with the advisor row
dsh --profile dsh-tui
```

Uninstall:

```sh
dsh plugin --profile dsh-tui remove dsh-advisor
dsh --profile dsh-tui --dump-config   # confirm the dsh-advisor layer is gone
```

## 5. Web Settings exposure

The dsh web **Plugins** page renders a bundle's own configuration on that
bundle's page, contributed through the `plugins.bundle.config` card slot (keyed
by the bundle's package name). The Advisor card (key `dsh-advisor`) reads the
provider directory through the dsh host's apiproxy
`describe` (the exposed `llm-*` namespaces), but reads and writes the advisor
config EXCLUSIVELY through the **official `GatewayService` RPC channel** — it
does not depend on the apiproxy allowlist, which exposes only an allowlist of
namespaces to configuration clients: model-provider namespaces plus product
namespaces (locale / permission / ui-conversation / ui-theme / ui-onboarding /
agent-presets). **Upstream dsh has no registration-level opt-in**
(`exposeToWebClients` does not exist in upstream `SettingsRegisterOptions` —
verified against the pristine 20da39e snapshot), so the advisor config is
**not on the apiproxy allowlist**. The plugin registers `AdvisorConfigGateway`
(a `GatewayService` with `@Remote('get')`/`@Remote('set')` methods), the
host's typertGateway claims `/api/advisor/get` + `/api/advisor/set` (the same
mechanism the dsh `goals` service uses), and the card calls them via
`connection.rpc`. The in-process write (`settings.update` on the advisor
entry id) carries no exposed-namespace check, so saving works on any dsh
build that ships the GatewayService channel. No host patching is applied or
required.

## 6. Verify

```sh
dsh --profile web --dump-config   # shows a "# == dsh-advisor" layer with the advisor row
dsh --profile web
```

After booting, the web Plugins page renders the Advisor card on the dsh-advisor
bundle's page; it reads and writes the advisor entry config live through
`/api/advisor/get` + `/api/advisor/set` — saving applies to running sessions
immediately.

## 7. Uninstall

```sh
dsh plugin --profile web remove dsh-advisor
dsh --profile web --dump-config   # confirm the dsh-advisor layer is gone
```

Restart the dsh session to complete the uninstall.
