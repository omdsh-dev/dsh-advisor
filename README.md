# dsh-advisor

[English](README.md) | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/dt/dsh-advisor)](https://www.npmjs.com/package/dsh-advisor)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933.svg)
![dsh](https://img.shields.io/badge/dsh-0.1.7--rc.2-4B32C3.svg)
![dsh tui](https://img.shields.io/badge/dsh%20tui-compatible-4B32C3.svg)
[![dshfind](https://dshfind.com/api/badge/omdsh-dev/dsh-advisor)](https://dshfind.com/plugins/omdsh-dev/dsh-advisor?ref=badge)

A standalone dsh (DeepSeek Harness) plugin bundle porting the omp "advisor" subsystem: a per-session independent reviewer model that observes the primary transcript, reviews each stepped turn with an explicitly configured model (provider + model are required), and injects severity-ranked advice (nit / concern / blocker) back into the session — without polluting or recursively reviewing itself.

**Advisory only.** The advisor never approves or rejects the primary agent's actions, and never issues commands as if it were the primary agent. Every delivered message is self-described advisory content, and a misbehaving reviewer is bounded end to end (emission guard, immuneTurns cooldown, failure policy) so it can never stall or pollute the primary loop.

Works in both dsh front ends: the **web** profile (sidebar → Plugins → dsh-advisor → Advisor card) and the **dsh-tui** terminal profile (`/advisor` + `/advisor config`).

## Quick start

### Install

```sh
dsh plugin --profile web add dsh-advisor      # web profile (Settings → Advisor card)
dsh plugin --profile dsh-tui add dsh-advisor  # dsh-tui terminal profile
```

Same plugin, either front end — the only difference is the `--profile` flag. Pin a version with `@<version>` (e.g. `dsh-advisor@0.1.0`). A registry install fetches the published tarball, which ships the built artifacts (`lib/` + `cordis.patch.yml`) — nothing builds on the target machine, and runtime dependencies (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-*` peers) resolve through the dsh installation's flat profile module fallback — no extra install step. Registry / git / tarball / local-directory variants (local-dir from a built checkout: `dsh plugin --profile web add .` or `dsh plugin --profile dsh-tui add .`), web Settings exposure, uninstall, and `--dump-config` verification → [docs/install.md](docs/install.md).

### Configuration

Edit the `config` of the `advisor` row in your profile's patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`). All six fields are schema-volatile live fields (dsh ≥ 0.1.7-rc.1): the web card and the TUI `/settings` screen write this same entry config — persisted in the profile patch, committed without a remount. (A pre-0.1.7 `$DSH_HOME/settings.yaml` `advisor:` section no longer exists: dsh imports it into the active profile once and renames the file `.imported`.)

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml — the advisor row's config
- id: advisor
  config:
    enabled: true                # master switch (default false) — set explicitly to enable
    provider: deepseek-official  # REQUIRED when enabled
    model: deepseek-flash        # REQUIRED when enabled; fallback: deepseek-v4-flash (or another V4 id) until the gateway enables the V41 route
    systemPrompt: ""             # optional; "" = built-in reviewer prompt
    immuneTurns: 3               # int ≥ 0, default 3 — cooldown after a delivered steer
    maxDeltaMessages: 60         # int ≥ 0, default 60 — delta window; 0 = unbounded
```

The advisor is off by default. When enabled, `provider` and `model` are **mandatory**: `enabled: true` without both is a hard gate — the advisor never starts a model call and reports a disabled-with-reason status; unknown config keys are rejected.

The same keys are read and edited from **three surfaces** (one store — the advisor entry config above; every surface shares the same key set and the same hard gate, with the host-side gate as the final line of defense on every path):

1. **Plugin-row config** — the profile patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`). This is where the config lives.
2. **dsh web Plugins page — the dsh-advisor bundle's own page** — the Advisor **card** (bundle key `dsh-advisor`) with the enabled toggle, provider / model selects restricted to system-configured providers and their models, and the optional fields. Saving writes the advisor entry's config (landed through the config editor into the profile patch) and applies to running sessions immediately — no restart. The card requires a dsh web build whose shell declares the `plugins.bundle.config` card slot (dsh ≥ 0.1.7-rc.1) and loads packages that declare `dsh.client`; it reads and writes the config through the official `GatewayService` RPC channel (`/api/advisor/get` + `/api/advisor/set`), which is not gated by the settings exposure allowlist. It additionally blocks saving while enabled with a required field empty.
3. **`/advisor` command** — per-session and ephemeral: it flips a session override and pins a per-session reviewer model, never the persisted config (see [Verify](#verify)).

In a **dsh-tui** profile the same five keys are editable in the TUI `/settings` screen: run `dsh --profile dsh-tui`, open `/settings`, and edit the **Advisor** section (`enabled` / `provider` / `model` / `immuneTurns` / `maxDeltaMessages`, each with zh/en label + hint). Edits are staged and written on save through the revision-fenced `settings.mutate` into the same advisor entry config the web card writes, and re-apply live without a restart. `systemPrompt` is NOT a TUI field (the TUI text control is single-line; a multi-line prompt would be truncated) — edit it via the web card or the profile patch layer. The section requires dsh-tui ≥ v0.8.0 (shipped in the `dsh-tui-settings-sections` row of the v0.8.0+ bundle); older dsh-tui versions no-op it cleanly and the profile patch layer remains the edit path. `/advisor config` stays a read-only readback whose edit hint names the `/settings` screen when the seam is mounted. Save behavior differs from the web card: the TUI seam has no cross-field validation, so a save may set `enabled: true` with empty `provider`/`model` — the explicit model gate resolves that to disabled-with-reason at runtime (visible via `/advisor status` and `/advisor config`); the web card blocks such a save outright. Full reference → [docs/configuration.md](docs/configuration.md).

![Advisor card on the dsh web Plugins page (the dsh-advisor bundle page)](docs/screenshots/advisor-settings-card.webp)

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
/advisor model      show the effective reviewer model and its source (session override or global default)
/advisor model set <provider> <model>   pin a reviewer model for this session only
/advisor model reset    drop the session pin and re-inherit the global defaults
```

`/advisor on|off|toggle` are session-scoped and ephemeral: they flip a per-session override, never the persisted config. Enabling a session whose config lacks `provider`/`model` starts no model call — `/advisor status` (and the `/advisor on` reply) shows the gate reason: the advisor runs only when enabled **with** both configured. `/advisor on` is also the manual recovery path: a session advisor paused by a quota/rate-limit (`quota_exhausted` — no auto-resume timer) resumes in place, and a halted advisor (permanent model error, e.g. invalid credentials) is rebuilt fresh for the session.

`/advisor model set` pins a reviewer model for the **invoking session only** — an in-memory, atomic `provider + model` pair that lives for the live session (cleared on dispose, owner teardown, cold resume, or restart; a forked/new session inherits the global defaults). It rides above the persisted global defaults without rewriting them: a complete session pair is used even when the global config has no pair yet, a malformed global config still blocks every session, half-pairs are never merged, and setting/resetting never touches the enable switch. Validation resolves the pair through the LLM service before commit (60 s bound, cancellable, no auto-retry); on failure the previous selection stays untouched. `/advisor config` remains the readback of the **global defaults**, not the session state.

In a **dsh-tui** profile, `/advisor config` additionally reads back the composed configuration — the global defaults, read-only, with edit hints naming the real write paths: the TUI `/settings` screen (Advisor section, dsh-tui ≥ v0.8.0) and the profile patch layer. The `/advisor` / `on|off|status|config|model` commands are listed in the TUI `/` menu with subcommand completion (command discovery requires the `dsh-tui-command-trees` row — the shipped dsh-tui bundle has it).

On the **web**, the same session model controls ride the session header's **Advisor action** (requires a dsh web build whose shell declares the `conversation.session.header.actions` slot — dsh ≥ 0.1.7-rc.1). The action is bound to the session it sits on: it shows the effective reviewer pair, its source (`session override` / `global default`), and the live-session lifetime; **Pin this model** pins a provider + model for that session, and **Use global default** drops the pin (the reset path). It writes ONLY through the plugin's session endpoints (`/api/advisor/getSession` + `/api/advisor/setSessionModel`) — the same controller, validation, and fencing as `/advisor model`, never the persisted config — and it never falls back to the global config write when the session surface is unavailable. The control refreshes when you open it (plus on reconnect/focus while open); there is no background polling. The global card on the Plugins page stays global-only.

## Features

- **Independent reviewer per session**: a separate model call observes the primary transcript and reviews each stepped primary turn; advisor messages are excluded from later deltas, so the advisor does not read its own advice back. The exclusion recognizes the advisor's current producer kind (`advisor`) AND both historical shapes a still-openable log can carry: the prehistoric direct `{ kind: 'advisor' }` note and the 0.1.6-era note as the V3→V4 in-memory migration rewrote it (`kind: 'plugin:advisor'`) — no generation of persisted notes is orphaned by the identity migration.
- **Severity-ranked advice with inject/steer semantics**: at most one note per review — **nit** (a minor style, clarity, or quality suggestion; delivered via non-waking `agent.inject`, consumed at the next pre-step boundary), **concern** (a material risk or clearly better direction to weigh before continuing; delivered via waking `agent.steer`, subject to the `immuneTurns` cooldown), **blocker** (continuing clearly wastes work — contradicts an explicit user instruction, going in circles, fundamentally unsound; delivered via `agent.steer`). Delivered messages carry the `[advisor:{severity}]` prefix and are self-described advisory content:

  ```
  [advisor:concern] extract the helper into a module and unit-test it
  ```

- **Explicit model gate**: `enabled` defaults to off; `enabled: true` without `provider` + `model` never starts a model call — status reports disabled-with-reason. The gate applies to the *effective* route after session resolution: a complete per-session override pair satisfies it for that session; a malformed global config cannot be bypassed. Unknown config keys are rejected.
- **Zero-tool minimal start**: the reviewer is an independent model call only — no advisor tools, nothing it can do to the session besides advisory messages.
- **No-stall failure policy**: a failing or quota-limited advisor only drops its own bounded backlog — it can never park or pollute the primary loop.
- **Session-scoped controls**: `/advisor on|off|status|config|model` work per session; the toggles and the per-session model pin are ephemeral overrides, never persisted config — `/advisor config` always reports the global defaults. On the web, the session header's **Advisor action** drives the same per-session pin through dedicated session endpoints (see [Verify](#verify)).

![Advisor note injected into the session stream](docs/screenshots/advisor-injected-note.webp)

## Mount-only (no dsh modification)

The plugin installs as a **pure mount**: bundle insert + client card (the web Plugins page) + its own gateway channel (`/api/advisor/get|set` for the global config plus `/api/advisor/getSession|setSessionModel` for the per-session model surface, claimed by the host's typertGateway — the same mechanism the dsh `goals` service uses, not gated by the settings exposure allowlist) + the `/advisor` commands — no dsh patches, no postinstall step, and dsh upgrades never require re-patching.

## Limitations & roadmap

The MVP deliberately drops full omp parity. Accepted gaps (tracked in the harness iteration roadmap):

- **Single advisor per session** — no parallel advisor roster or WATCHDOG-style file discovery (next iteration).
- **No advisor tools** — the reviewer is an independent model call only; it cannot verify claims itself (next-next iteration).
- **No in-session advisor panel** — advice surfaces only as tagged injected messages; the web Advisor card is a config surface, not a session view (next-next iteration).
- **No transcript persistence or cost stats** — no resumable advisor history or cost observability (next-next iteration).
- **No secret obfuscation of delta content** — secrets present in the transcript can reach the advisor model; mitigate by configuring a trusted reviewer model.
- **No quarantine of unsafe advisor output** — a misbehaving note can carry directive text; the JSON frame + validation + advisory-only framing are the only mitigation, and the note is delivered as-is (roadmap).
- **No `syncBacklog` catch-up wait** — a far-behind advisor does not wait for the primary loop; its backlog is bounded and dropped, so notes may arrive after the next primary turn started (roadmap: context-maintenance batch).
- **Bounded advisor context** — long-session full replays are truncated (`maxDeltaMessages`), so the advisor may lose early context after compaction (roadmap: next-next iteration).

**Sessions written by earlier versions — pre-V3 logs are not repaired here.** Advisor notes in them carry the former custom `source.kind` (`kind: 'advisor'`), which the dsh V2→V3 session-format edge refuses, so those **pre-V3** logs cannot be migrated (the raw file is intact, only unopenable). Logs already at V3 still open — they are affected only by the self-review caveat above. Repairing the pre-V3 logs is upstream work: a unified pass over this defect class is being developed in [`omdsh-dev/dsh-llm-fallbacks`](https://github.com/omdsh-dev/dsh-llm-fallbacks) and is **not yet available**. Logs written from this version onward are unaffected.

## Documentation

| Doc | Content |
|---|---|
| [docs/install.md](docs/install.md) | profile install (web + dsh-tui) / registry / git / tarball / local-directory variants / web Settings exposure / uninstall / `--dump-config` verification |
| [docs/configuration.md](docs/configuration.md) | full advisor config reference: keys & defaults, explicit model gate (S4), config surfaces (web card / TUI `/settings` / patch layer), example YAML, live re-apply behavior |
| [docs/consumer-api.md](docs/consumer-api.md) | developer consumption contract: package-root library API, `dsh-advisor/client` entry, `/advisor` command surface, export inventory, lifecycle |
| [docs/verification.md](docs/verification.md) | verification records: test matrix (16 files / 319 cases), typecheck/build, CI contract, real-environment steps |
| [docs/release.md](docs/release.md) | release process: PR-driven Release prep + Release workflows, OIDC trusted publishing, version strategy, rollback |

## License

Released under the **MIT** License — see [LICENSE](LICENSE). The LICENSE file is authoritative for copyright and license terms.
