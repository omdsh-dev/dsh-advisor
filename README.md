# dsh-advisor

A standalone dsh plugin bundle porting the omp "advisor"
subsystem: a per-session reviewer model that observes the primary transcript,
reviews each stepped turn with an explicitly configured model (provider +
model are required), and injects severity-ranked advice (nit / concern /
blocker) back into the session — without polluting or recursively reviewing
itself.

**Advisory only.** The advisor never approves or rejects the primary agent's
actions; it never issues commands as if it were the primary agent. Every
delivered message is self-described advisory content, and a misbehaving
reviewer is bounded end to end (emission guard, immuneTurns cooldown, failure
policy) so it can never stall or pollute the primary loop.

## Install

Pack the bundle and install it into a profile:

```sh
pnpm pack
dsh plugin --profile <name> add dsh-advisor-0.0.1.tgz
```

The first `dsh plugin` use initializes the profile (with `@deepseek-ai/dsh-base`
as its first bundle); `dsh` appends `dsh-advisor` to the profile's
`dsh.profile.bundles` because the package declares `dsh.bundle`. Verify the
row without booting, then boot:

```sh
dsh --profile <name> --dump-config   # shows a "# == dsh-advisor" layer with the advisor row
dsh --profile <name>
```

The bundle inserts one plugin row — `id: advisor`, `name: dsh-advisor` (see
`cordis.patch.yml`). The runtime dependencies (`cordis` +
`@deepseek-ai/dsh-{session,agent,llm,commands}`) are declared as
peerDependencies and resolved by the dsh installation's flat profile module
fallback, which also provides `schemastery` for the config schema — no extra
install step.

### Installing from a git host: the build-script catch

A tarball (or npm-published) install ships built artifacts and needs no build
permission. Installing straight from a git host is different: a git install
fetches **sources, not built artifacts**, so a TypeScript package arrives
without its `lib/` output and fails to load unless the author ships a
`prepare` script that builds from source. This bundle currently ships built
artifacts via `prepack` and does **not** define a `prepare` script — install it
from a tarball (`pnpm pack`) or from npm, not from git, until a `prepare`
script lands.

For packages that do ship a `prepare` script, pnpm ≥ 10 refuses to run a git
dependency's `prepare` script until it is explicitly allowed, so the first
`add` fails; `dsh` points at the fix — copy the exact package key pnpm printed
into the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  <package-key>: true
```

and re-run the `add`. Treat that allowance as what it is: permission to
execute the package's code on your machine at install time, outside any
sandbox the agent runs under. Only allow packages whose source you trust, and
pin a commit (`github:you/plugin#<sha>`) so a later push cannot silently
change what runs.

## Config

The advisor is off by default. When enabled, `provider` and `model` are
**mandatory**: `enabled: true` without both is a hard gate — the advisor never
starts a model call and reports a disabled-with-reason status. Unknown config
keys are rejected.

Configure it in the profile's own patch layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`):

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
- **No Web UI panel** — advice surfaces only as tagged injected messages
  (next-next iteration).
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

The runtime dependencies (`cordis` + `@deepseek-ai/dsh-{session,agent,llm,commands}`)
are private; at dev time they resolve through a gitignored shim overlay
(`dev/`, generated by `scripts/dev-link.mjs`). The committed files contain no
local paths; all machine-specific paths live only in the generated `dev/`
directory.

```sh
# point at a dsh source tree (default: sibling directory `dsh-private`)
DSH_SOURCE=<path-to-dsh-checkout> pnpm dev:link
pnpm install
```

Then:

```sh
pnpm test        # vitest (unit + the composed integration loop)
pnpm typecheck   # tsc --noEmit (strict, moduleResolution: bundler)
pnpm build       # tsc emit to lib/ (runs automatically via prepack on pack)
pnpm pack        # build + produce dsh-advisor-<version>.tgz
```

The integration test (`tests/integration.test.ts`) composes the plugin into a
real cordis context with a stub LLM adapter and drives the full
turn → delta → advisor call → inject/steer cycle.

## License

MIT
