# dsh-advisor

[English](README.md) | [中文](README.zh.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933.svg)
![dsh](https://img.shields.io/badge/dsh-DeepSeek%20Harness%20compatible-4B32C3.svg)
[![dshfind](https://dshfind.com/api/badge/omdsh-dev/dsh-advisor)](https://dshfind.com/plugins/omdsh-dev/dsh-advisor?ref=badge)

A standalone dsh (DeepSeek Harness) plugin bundle porting the omp "advisor" subsystem: a per-session independent reviewer model that observes the primary transcript, reviews each stepped turn with an explicitly configured model (provider + model are required), and injects severity-ranked advice (nit / concern / blocker) back into the session — without polluting or recursively reviewing itself.

**Advisory only.** The advisor never approves or rejects the primary agent's actions, and never issues commands as if it were the primary agent. Every delivered message is self-described advisory content, and a misbehaving reviewer is bounded end to end (emission guard, immuneTurns cooldown, failure policy) so it can never stall or pollute the primary loop.

Works in both dsh front ends: the **web** profile (Settings → 插件配置 → Advisor card) and the **dsh-tui** terminal profile (`/advisor` + `/advisor config`).

## Quick start

### Install

```sh
dsh plugin --profile web add dsh-advisor      # web profile (Settings → Advisor card)
dsh plugin --profile dsh-tui add dsh-advisor  # dsh-tui terminal profile
```

Same plugin, either front end — the only difference is the `--profile` flag. Pin a version with `@<version>` (e.g. `dsh-advisor@0.1.0`). A registry install fetches the published tarball, which ships the built artifacts (`lib/` + `cordis.patch.yml`) — nothing builds on the target machine, and runtime dependencies (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-*` peers) resolve through the dsh installation's flat profile module fallback — no extra install step. Registry / git / tarball / local-directory variants (local-dir from a built checkout: `dsh plugin --profile web add .` or `dsh plugin --profile dsh-tui add .`), web Settings exposure, uninstall, and `--dump-config` verification → [docs/install.md](docs/install.md).

### Configuration

Add an `advisor:` section to the global dsh settings document (default `$DSH_HOME/settings.yaml` — shared across profiles; the web Settings card writes to this same file):

```yaml
advisor:
  enabled: true                # master switch (default false) — set explicitly to enable
  provider: deepseek-official  # REQUIRED when enabled
  model: deepseek-v4-flash     # REQUIRED when enabled
  systemPrompt: ""             # optional; "" = built-in reviewer prompt
  immuneTurns: 3               # int ≥ 0, default 3 — cooldown after a delivered steer
  maxDeltaMessages: 60         # int ≥ 0, default 60 — delta window; 0 = unbounded
```

The advisor is off by default. When enabled, `provider` and `model` are **mandatory**: `enabled: true` without both is a hard gate — the advisor never starts a model call and reports a disabled-with-reason status; unknown config keys are rejected.

The same keys compose across **three surfaces** (later layers override earlier ones; every surface shares the same key set and the same hard gate, with the host-side gate as the final line of defense on every path):

1. **Plugin-row config** — the profile patch layer (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`). This is the composition base.
2. **dsh web Settings page — the "插件配置" (Plugin Configuration) page** — the Advisor **card** (id `advisor`) with the enabled toggle, provider / model selects restricted to system-configured providers and their models, and the optional fields. Saving writes into the `advisor` settings namespace and applies to new sessions immediately — no restart. The card requires a current dsh web build whose shell declares the `settings.plugin.item` card slot and loads packages that declare `dsh.client`; it reads and writes the namespace through the official `GatewayService` RPC channel (`/api/advisor/get` + `/api/advisor/set`), which is not gated by the settings exposure allowlist. It additionally blocks saving while enabled with a required field empty.
3. **`/advisor` command** — per-session and ephemeral: it flips a session override, never the persisted config (see [Verify](#verify)).

In a **dsh-tui** profile there is no settings page: the same two persisted surfaces (profile patch layer + global `$DSH_HOME/settings.yaml`) compose the config, and `/advisor config` prints the composed config as a read-only readback with edit hints. Full reference → [docs/configuration.md](docs/configuration.md).

![Advisor card on the dsh web Settings (插件配置) page](docs/screenshots/advisor-settings-card.webp)

### Verify

```sh
dsh --profile web --dump-config   # shows a "# == dsh-advisor" layer with the advisor row
```

With the advisor installed and enabled, control it in-session with the `/advisor` command (available when a command registry is composed):

```
/advisor            toggle the advisor for this session
/advisor on         enable the advisor for this session
/advisor off        disable the advisor for this session
/advisor status     show state, model, runtime status, pending count, last activity
```

`/advisor on|off|toggle` are session-scoped and ephemeral: they flip a per-session override, never the persisted config. Enabling a session whose config lacks `provider`/`model` starts no model call — `/advisor status` (and the `/advisor on` reply) shows the gate reason: the advisor runs only when enabled **with** both configured. `/advisor on` is also the manual recovery path: a session advisor paused by a quota/rate-limit (`quota_exhausted` — no auto-resume timer) resumes in place, and a halted advisor (permanent model error, e.g. invalid credentials) is rebuilt fresh for the session.

In a **dsh-tui** profile, `/advisor config` additionally reads back the composed configuration — read-only, with edit hints: the web Settings card is web-only, and the TUI has no settings page and no write command, so edit through the profile patch layer or `$DSH_HOME/settings.yaml`. The `/advisor` / `on|off|status|config` commands are listed in the TUI `/` menu with subcommand completion (command discovery requires the `dsh-tui-command-trees` row — the shipped dsh-tui bundle has it).

## Features

- **Independent reviewer per session**: a separate model call observes the primary transcript and reviews each stepped primary turn; advisor messages are excluded from later deltas, so the advisor never reads its own advice back.
- **Severity-ranked advice with inject/steer semantics**: at most one note per review — **nit** (a minor style, clarity, or quality suggestion; delivered via non-waking `agent.inject`, consumed at the next pre-step boundary), **concern** (a material risk or clearly better direction to weigh before continuing; delivered via waking `agent.steer`, subject to the `immuneTurns` cooldown), **blocker** (continuing clearly wastes work — contradicts an explicit user instruction, going in circles, fundamentally unsound; delivered via `agent.steer`). Delivered messages carry the `[advisor:{severity}]` prefix and are self-described advisory content:

  ```
  [advisor:concern] extract the helper into a module and unit-test it
  ```

- **Explicit model gate**: `enabled` defaults to off; `enabled: true` without `provider` + `model` never starts a model call — status reports disabled-with-reason. Unknown config keys are rejected.
- **Zero-tool minimal start**: the reviewer is an independent model call only — no advisor tools, nothing it can do to the session besides advisory messages.
- **No-stall failure policy**: a failing or quota-limited advisor only drops its own bounded backlog — it can never park or pollute the primary loop.
- **Session-scoped controls**: `/advisor on|off|status|config` work per session; the toggles are ephemeral overrides, never persisted config.

![Advisor note injected into the session stream](docs/screenshots/advisor-injected-note.webp)

## Mount-only (no dsh modification)

The plugin installs as a **pure mount**: bundle insert + client card (web Settings 插件配置) + its own gateway channel (`/api/advisor/get|set`, claimed by the host's typertGateway — the same mechanism the dsh `goals` service uses, not gated by the settings exposure allowlist) + the `/advisor` commands — no dsh patches, no postinstall step, and dsh upgrades never require re-patching.

## Development

**How it works** — the plugin subscribes to `session/event` and renders an incremental markdown delta of the primary transcript (own advisor messages excluded), queued on a per-session runtime: after each stepped `turn/end` in standard stepped sessions, and — in agentic/harness sessions that never emit `turn/end` — at each completed agent reply round (when a new human input arrives after an unreviewed assistant increment, inbox-spliced input included). The runtime calls the separately configured model via `ctx.llm.stream` — with reasoning off (`reasoningEffort: 'off'`, sent only when the configured model's adapter declares that effort; deepseek models do, other models get the option omitted automatically) and a **5120-token** output cap (a user-directed 20× supersession of the original 256); extracted notes are bounded (1000 chars) and the notice summary to 120 chars, so the raised budget cannot translate into an unbounded injection into the primary session. It extracts one `{note, severity}` from the JSON-framed reply, gates it through an emission guard (normalize / dedupe / content-free suppression / one-note-per-update), and routes it: nit → inject, concern/blocker → steer. The `[advisor:{severity}]` prefix is the only cue the primary model gets about how to treat it — the primary system prompt never mentions advisories. Compaction and surface rewrites reset the observer, the emission guard, and the immuneTurns latch; the drain is fully async with a bounded backlog, so a failing or quota'd advisor can only drop its own backlog — never park the primary loop.

**Limitations & roadmap** — the MVP deliberately drops full omp parity. Accepted gaps (tracked in the harness iteration roadmap):

- **Single advisor per session** — no parallel advisor roster or WATCHDOG-style file discovery (next iteration).
- **No advisor tools** — the reviewer is an independent model call only; it cannot verify claims itself (next-next iteration).
- **No in-session advisor panel** — advice surfaces only as tagged injected messages; the web Advisor card is a config surface, not a session view (next-next iteration).
- **No transcript persistence or cost stats** — no resumable advisor history or cost observability (next-next iteration).
- **No secret obfuscation of delta content** — secrets present in the transcript can reach the advisor model; mitigate by configuring a trusted reviewer model.
- **No quarantine of unsafe advisor output** — a misbehaving note can carry directive text; the JSON frame + validation + advisory-only framing are the only mitigation, and the note is delivered as-is (roadmap).
- **No `syncBacklog` catch-up wait** — a far-behind advisor does not wait for the primary loop; its backlog is bounded and dropped, so notes may arrive after the next primary turn started (roadmap: context-maintenance batch).
- **Bounded advisor context** — long-session full replays are truncated (`maxDeltaMessages`), so the advisor may lose early context after compaction (roadmap: next-next iteration).

**Build** — the bundle builds itself on install: `package.json` declares `"prepare": "pnpm build"` (the same build `prepack` runs), so any clone is immediately buildable. The private `@deepseek-ai/dsh-*` runtime dependencies are **peerDependencies only** (never `dependencies` / `devDependencies`); at dev time `pnpm-workspace.yaml` sets `autoInstallPeers: true` + `nodeLinker: hoisted` (pnpm 11+ ignores non-auth settings in `.npmrc`), so pnpm resolves the real `@deepseek-ai/*` packages from the npm registry using the auth token in your user-level `~/.npmrc` — there is no local link-farm and no `DSH_HOME` / `DSH_SOURCE_DIR` prerequisite for dependency resolution. The in-box `cordis` framework is declared as the scoped peer `@deepseek-ai/cordis` (never bare `cordis`), and prerelease peer ranges must carry the exact publish tag — the `@deepseek-ai/dsh-*` peers are pinned `^0.1.0-rc.6`, since per the node-semver prerelease-tuple rule a range like `^4.0.0-rc.7` never matches a `4.0.1-rc.1` publish. There is no `postinstall` step: already-built tarball installs skip the build entirely. `prepack` and `prepare` both run `pnpm build`, so `pnpm pack` builds twice — the documented tradeoff that keeps git-install builds working.

```sh
pnpm install              # registry deps incl. the @deepseek-ai/* peers (autoInstallPeers + ~/.npmrc auth)
pnpm test                 # vitest (unit + the composed integration loop)
pnpm typecheck            # tsc --noEmit (node) + tsc -p tsconfig.client.json --noEmit + tsc -p tsconfig.spec.json --noEmit
pnpm build                # tsc -p tsconfig.build.json emit to lib/ + node scripts/build-client.mjs (client bundle)
pnpm pack                 # build + produce dsh-advisor-0.0.1.tgz
```

## Documentation

| Doc | Content |
|---|---|
| [docs/install.md](docs/install.md) | profile install (web + dsh-tui) / registry / git / tarball / local-directory variants / web Settings exposure / uninstall / `--dump-config` verification |
| [docs/configuration.md](docs/configuration.md) | full `advisor` namespace reference: keys & defaults, explicit model gate (S4), settings surfaces (web card / patch layer / global settings.yaml), example YAML, live re-apply behavior |
| [docs/consumer-api.md](docs/consumer-api.md) | developer consumption contract: package-root library API, `dsh-advisor/client` entry, `/advisor` command surface, export inventory, lifecycle |
| [docs/verification.md](docs/verification.md) | verification records: test matrix (16 files / 319 cases), typecheck/build, CI contract, real-environment steps |
| [docs/release.md](docs/release.md) | release process: PR-driven Release prep + Release workflows, OIDC trusted publishing, version strategy, rollback |

## License

Released under the **MIT** License — see [LICENSE](LICENSE). The LICENSE file is authoritative for copyright and license terms.
