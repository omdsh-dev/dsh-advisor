# dsh-advisor

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/github/license/dsh-external/dsh-advisor)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![GitHub stars](https://img.shields.io/github/stars/dsh-external/dsh-advisor)](https://github.com/dsh-external/dsh-advisor)
[![GitHub release](https://img.shields.io/github/v/release/dsh-external/dsh-advisor)](https://github.com/dsh-external/dsh-advisor/releases)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/dsh-external/dsh-advisor)](https://github.com/dsh-external/dsh-advisor/pulls)

A standalone dsh plugin bundle porting the omp "advisor"
subsystem: a per-session reviewer model that observes the primary transcript,
reviews each stepped turn with an explicitly configured model (provider +
model are required), and injects severity-ranked advice (nit / concern /
blocker) back into the session — without polluting or recursively reviewing
itself.

```sh
dsh plugin --profile <name> add github:dsh-external/dsh-advisor   # pin a commit with #<sha>
```

pnpm ≥ 10 blocks a git dependency's `prepare` and `postinstall` scripts by
default: if the first `add` fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`,
add the allowlist entry in the profile's `pnpm-workspace.yaml`
(`onlyBuiltDependencies`, or `allowBuilds` on pnpm ≥ 10.26) and re-run the
`add` — see [From a git URL](#from-a-git-url-one-command).

**Advisory only.** The advisor never approves or rejects the primary agent's
actions; it never issues commands as if it were the primary agent. Every
delivered message is self-described advisory content, and a misbehaving
reviewer is bounded end to end (emission guard, immuneTurns cooldown, failure
policy) so it can never stall or pollute the primary loop.

## Install

### From a git URL (one command)

```sh
dsh plugin --profile <name> add github:dsh-external/dsh-advisor   # pin a commit with #<sha>
```

A git install fetches sources, so pnpm runs the bundle's lifecycle scripts
while installing: `prepare` (the dev-time link farm from `$DSH_SOURCE_DIR` /
`$DSH_HOME`, then `pnpm build`) and `postinstall`
(`bash scripts/autopatch-install.sh` — the host patch autopatch, see
[Host patch (Settings page)](#host-patch-settings-page)). pnpm ≥ 10 refuses to
run a git dependency's `prepare` until it is explicitly allowed, so the first
`add` fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`; pnpm points at the
fix — copy the exact package key it printed into the profile's
`pnpm-workspace.yaml`:

```yaml
# $DSH_HOME/profiles/<name>/pnpm-workspace.yaml
onlyBuiltDependencies:
  - dsh-advisor
# pnpm ≥ 10.26 also accepts the allowBuilds form:
# allowBuilds:
#   dsh-advisor: true
```

and re-run the `add`. Treat that allowance as what it is: permission to
execute the package's code on your machine at install time, outside any
sandbox the agent runs under. Only allow packages whose source you trust, and
pin a commit (`github:dsh-external/dsh-advisor#<sha>`) so a later push cannot
silently change what runs.

### From a tarball

Pack the bundle and install it into a profile:

```sh
pnpm pack
dsh plugin --profile <name> add dsh-advisor-0.0.1.tgz
```

A tarball ships the built artifacts (`lib/` + `cordis.patch.yml` + the
`patches/` and `scripts/` host-patch mechanism), so no `prepare` script runs
and no build permission is needed. The first `dsh
plugin` use initializes the profile (with `@deepseek-ai/dsh-base` as its first
bundle); `dsh` appends `dsh-advisor` to the profile's `dsh.profile.bundles`
because the package declares `dsh.bundle`. The bundle inserts one plugin row —
`id: advisor`, `name: dsh-advisor` (see `cordis.patch.yml`). The runtime
dependencies (`cordis`, `schemastery`, and
`@deepseek-ai/dsh-{session,agent,llm,commands,timeout}`) are declared as
peerDependencies and resolved by the dsh installation's flat profile module
fallback — no extra install step. (Tarball installs do not run the autopatch:
apply the host patch manually with `scripts/apply-dsh-patch.sh` when the host
does not yet expose the `advisor` namespace.)

### Building from a git install

A git install (above) fetches **sources, not built artifacts**, so the bundle
builds itself from source: `package.json` declares `"prepare": "node
scripts/setup-dsh-links.mjs && pnpm build && bash
scripts/autopatch-install.sh"` — the dev-time link farm, the same build
`prepack` runs when packing a tarball, and the install-time host-patch
autopatch — and pnpm runs it automatically after installing devDependencies.
Dev-time resolution of the private `@deepseek-ai/dsh-*` packages (and the
in-box `cordis` / `react` / `react-dom` identities) comes from the **local dsh
source tree** via `$DSH_SOURCE_DIR` / `$DSH_HOME` (see
[Development](#development)) — the same tree the host runs from, so no
`peer-stubs/` copies exist and every developer resolves the real packages.
A git install therefore requires that tree (it is needed anyway for the
host-patch autopatch); with it, `pnpm install` is self-contained in any clone
— no access to private registry packages.

### Host patch (Settings page)

The web Settings page reads and writes settings namespaces through the dsh
host's apiproxy, which only exposes model-provider namespaces plus
`permission` and `ui-onboarding` to configuration clients. The `advisor`
namespace is outside that boundary, so against such a host the page cannot
round-trip the Advisor section — the store detects the unexposed namespace and
shows an explicit notice instead of a writable form (the shipped
plugin-side mitigation).

The bundle ships the **fix mechanism** for this host-side gap (C-1), mirroring
the verified `dsh-llm-fallbacks` pattern: a minimal git patch that adds
`advisor` to the host's exposure allowlist
(`PRODUCT_SETTINGS_NAMESPACES` in `packages/host/apiproxy/src/api-proxy.ts`),
plus apply / revert / verify scripts and an install-time autopatch — see
[`patches/README.md`](patches/README.md). It is needed when the host does not
yet expose `advisor` (the pinned baseline dsh-private b8343cb does not);
re-run after every dsh upgrade, which resets host changes.

```sh
export DSH_SOURCE_DIR="$DSH_HOME/source/current"   # or just set DSH_HOME
scripts/apply-dsh-patch.sh --check   # read-only applicability check
scripts/apply-dsh-patch.sh           # apply + rebuild the host package
scripts/verify-dsh-patch.sh          # assert source + build artifact markers
scripts/revert-dsh-patch.sh          # roll back (e.g. before a dsh upgrade)
```

Git installs run the autopatch automatically (`postinstall` and `prepare`);
opt out with `DSH_ADVISOR_AUTOPATCH=0`. The autopatch only warns and never
fails the install; tarball installs apply manually as above. **Security:** the
apply/revert scripts (and the autopatch) run the target tree's build code
(`tsc` / `tsdown`) at apply/install time, outside any sandbox the agent runs
under — only point them at a dsh source tree you trust, and treat the
`onlyBuiltDependencies` allowance (above) as permission to execute this
package's install-time code.

### Verify

Verify the row without booting, then boot:

```sh
dsh --profile <name> --dump-config   # shows a "# == dsh-advisor" layer with the advisor row
dsh --profile <name>
```

## Config

The advisor is off by default. When enabled, `provider` and `model` are
**mandatory**: `enabled: true` without both is a hard gate — the advisor never
starts a model call and reports a disabled-with-reason status. Unknown config
keys are rejected.

Configuration composes across **three surfaces** (later layers override earlier
ones; every surface uses the same key set):

1. **Plugin-row config** — `$DSH_HOME/profiles/<name>/cordis.patch.yml`
   (below). This is the composition base.
2. **dsh web Settings page** — the Advisor section (enabled toggle, provider /
   model selects restricted to system-configured providers and their models,
   optional fields) saves into the `advisor` settings namespace and overrides
   the plugin-row config without editing it. Saving applies to new sessions
   immediately — no restart (the runtime reads the composed value live).
   Requires a current dsh web build whose shell loads `dshClient` packages and
   renders `settings.section` slots.
3. **`/advisor` command** — per-session and ephemeral: it flips a session
   override, never the persisted config (see [Usage](#usage)).

Both persisted surfaces share the same hard gate: `enabled: true` with empty
`provider`/`model` never starts a model call (disabled-with-reason). The
Settings page additionally blocks saving while enabled with a required field
empty; the host-side gate stays the final line of defense on every path.

Plugin-row config:

```yaml
# profiles/<name>/cordis.patch.yml — the profile's user patch layer
- id: advisor
  config:
    enabled: true              # master switch (default false)
    provider: deepseek         # REQUIRED when enabled
    model: deepseek-chat       # REQUIRED when enabled
    systemPrompt: ""           # optional; "" = built-in reviewer prompt
    immuneTurns: 3             # int ≥ 0, default 3 — cooldown after a delivered interrupt
    maxDeltaMessages: 60       # int ≥ 0, default 60 — delta window; 0 = unbounded
```

| Key | Type / default | Meaning |
|---|---|---|
| `enabled` | bool, `false` | Master switch. |
| `provider` | string, optional | Provider route. Required (non-empty) when `enabled: true`. |
| `model` | string, optional | Model id. Required (non-empty) when `enabled: true`. |
| `systemPrompt` | string, `""` | Overrides the built-in reviewer prompt (severity definitions + JSON-frame output contract). |
| `immuneTurns` | int ≥ 0, `3` | After a concern/blocker is actually steered, the next N stepped primary turns must complete before another interrupting note may steer; notes inside the window downgrade to inject. |
| `maxDeltaMessages` | int ≥ 0, `60` | Bounded advisor input window. Deltas beyond N are truncated with a `… <earlier messages omitted>` marker; `0` = unbounded. |

## Usage

Once installed and enabled, the advisor observes every session. Control it per
session with the `/advisor` command (available when a command registry is
composed):

```
/advisor            toggle the advisor for this session
/advisor on         enable the advisor for this session
/advisor off        disable the advisor for this session
/advisor status     show state, model, runtime status, pending count, last activity
```

`/advisor on|off|toggle` are session-scoped and ephemeral: they flip a
per-session override, never the persisted config. Enabling a session whose
config lacks `provider`/`model` starts no model call — `/advisor status` (and
the `/advisor on` reply) shows the gate reason.

`/advisor on` is also the manual recovery path: a session advisor paused by a
quota/rate-limit (`quota_exhausted` — KD-5 has no auto-resume timer) resumes in
place, and a halted advisor (permanent model error, e.g. invalid credentials)
is rebuilt fresh for the session.

After each stepped primary turn that ends normally (`completed`, `max-tokens`,
or `error`), the advisor reviews the incremental transcript delta and emits at
most one note, ranked by severity:

- **nit** — a minor style, clarity, or quality suggestion; delivered via
  `agent.inject` (non-waking, consumed at the next pre-step boundary).
- **concern** — a material risk or clearly better direction to weigh before
  continuing; delivered via `agent.steer` (waking), subject to the
  `immuneTurns` cooldown.
- **blocker** — continuing clearly wastes work (contradicts an explicit user
  instruction, going in circles, fundamentally unsound); delivered via
  `agent.steer`.

Injected advice appears in the session stream as a user-role message carrying
the advisor source kind and self-describing content, e.g.:

```
[advisor:concern] extract the helper into a module and unit-test it
```

The `[advisor:{severity}]` prefix is the only cue the primary model gets about
how to treat it — the primary system prompt never mentions advisories. Advisor
messages are excluded from later advisor deltas, so the advisor never reads
its own advice back.

## How it works

The plugin subscribes to `session/event`; after each stepped `turn/end` it
renders an incremental markdown delta of the primary transcript (own
advisor messages excluded) and queues it on a per-session runtime. The runtime
calls a separately configured model via `ctx.llm.stream`, extracts one
`{note, severity}` from the JSON-framed reply, gates it through an emission
guard (normalize / dedupe / content-free suppression / one-note-per-update),
and routes it: nit → inject, concern/blocker → steer. Compaction and surface
rewrites reset the observer, the emission guard, and the immuneTurns latch
(KD-5); the drain is fully async with a bounded backlog, so a failing or
quota'd advisor can only drop its own backlog — never park the primary loop.

## Limitations & roadmap

The MVP deliberately drops full omp parity. Accepted gaps (tracked in the
harness iteration roadmap):

- **Single advisor per session** — no parallel advisor roster or WATCHDOG-style
  file discovery (next iteration).
- **No advisor tools** — the reviewer is an independent model call only; it
  cannot verify claims itself (next-next iteration).
- **No in-session advisor panel** — advice surfaces only as tagged injected
  messages (the Advisor **Settings** section is a config surface, not a
  session view; an in-session card is next-next iteration).
- **No transcript persistence or cost stats** — no resumable advisor history or
  cost observability (next-next iteration).
- **No secret obfuscation of delta content** — secrets present in the transcript
  can reach the advisor model; mitigate by configuring a trusted reviewer model.
- **No quarantine of unsafe advisor output** — a misbehaving note can carry
  directive text; the JSON frame + validation + advisory-only framing
  (`[advisor:…]`, "weigh, don't blindly obey") are the only mitigation, and the
  note is delivered as-is into the primary transcript (roadmap).
- **No `syncBacklog` catch-up wait** — a far-behind advisor does not wait for
  the primary loop; its backlog is bounded and dropped (never parks the
  primary), so advisor notes may arrive after the next primary turn started
  (roadmap: context-maintenance batch).
- **Bounded advisor context** — long-session full replays are truncated
  (`maxDeltaMessages`), so the advisor may lose early context after compaction;
  advisor context maintenance is roadmap (next-next iteration).

## Development

The bundle builds itself on install: `package.json` declares `"prepare": "node
scripts/setup-dsh-links.mjs && pnpm build && bash
scripts/autopatch-install.sh"` (the dev-time link farm, the same build
`prepack` runs, plus the install-time host-patch autopatch), so any clone is
immediately buildable **once `DSH_HOME` points at a dsh home whose
`source/current` is a dsh source tree** (or `DSH_SOURCE_DIR` points at such a
tree directly — the same resolution the host-patch scripts use). The private
`@deepseek-ai/dsh-*` runtime dependencies are **peerDependencies only**; at dev
time `scripts/setup-dsh-links.mjs` (wired into `prepare`, standalone as
`pnpm dsh:link`, verified with `pnpm dsh:link:check`) links the REAL packages
from that tree into `node_modules/@deepseek-ai/` — every `@deepseek-ai/*`
package the tree declares (tool CLIs with a `bin` are skipped: linking them
would make pnpm write their bins into the shared tree), a bin-less shim for
the in-box `cordis` framework, and the tree's own `react`/`react-dom` copies
(node resolution — including externalized CJS deps — must see ONE react
identity, the identity the real client packages use; `.npmrc` sets
`node-linker=hoisted`, the dsh profile convention, so no `.pnpm` per-package
dirs shadow those links). The farm is idempotent, prunes stale entries, and
fails with guidance when the tree is missing or a peer cannot be linked.
`.npmrc` also sets `auto-install-peers=false` (dsh profile convention): the
private peers must never be fetched from the npm registry.

```sh
export DSH_HOME=~/.dsh    # a dsh home with source/current (or set DSH_SOURCE_DIR)
pnpm install              # registry deps + link farm (via prepare), no private-registry access
pnpm test                 # vitest (unit + the composed integration loop)
pnpm typecheck            # tsc --noEmit (node) + tsc -p tsconfig.client.json --noEmit + tsc -p tsconfig.spec.json --noEmit
pnpm build                # tsc -p tsconfig.build.json emit to lib/ + node scripts/build-client.mjs (client bundle)
pnpm pack                 # build + produce dsh-advisor-0.0.1.tgz
```

`cordis` is declared as a deterministic devDependency (`^4.0.0-rc.7` — the npm
registry tops out at exactly that version, so the range pins the baseline the
dsh host vendors); after install the link farm's bin-less cordis shim still
overrides `node_modules/cordis` with the vendored files, because the real
packages type and run against the vendored build and module identity requires
dev-time `import 'cordis'` to resolve to the same files. The other public
devDependencies (`schemastery`, `react`, …) resolve from the npm registry as
usual.

`prepack` runs `pnpm build`; `prepare` runs the link farm, the build, and the
host-patch autopatch (`bash scripts/autopatch-install.sh`), so `pnpm pack`
runs the build twice (once per lifecycle) — the documented tradeoff that keeps
git-install builds working. `postinstall` runs only the autopatch
(already-built tarball installs skip the build entirely).

The integration test (`tests/integration.test.ts`) composes the plugin into a
real cordis context with a stub LLM adapter and drives the full
turn → delta → advisor call → inject/steer cycle.

## License

MIT
