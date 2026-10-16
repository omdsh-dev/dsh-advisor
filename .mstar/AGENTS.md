# AGENTS.md — `.mstar/` (Morning Star harness)

Harness-layer conventions for this repo (a standalone dsh plugin bundle porting the omp "advisor"
subsystem). Project-level rules (build, branch, security, specs routing) live in the root
`AGENTS.md`; this file covers the harness subtree only and is its SSOT.

## Source Priority

1. Current user instruction
2. Root `AGENTS.md`
3. This file
4. `mstar-*` skills (Morning Star harness; see `mstar-harness-core`)

## Authority

`.mstar/store.db` (SQLite, process-local, gitignored) is the harness's live authority:

| Domain | Surface |
|--------|---------|
| Execution rows — root register, workflows, plans, sessions, registered inputs | `mstar status validate`, `mstar plan show` |
| Open findings — the issue store | `mstar issue list` / `show`, `mstar status tech-debt` |
| Catalog — identity, path, kind and lifecycle of projects, iterations, plans, documents | `mstar catalog list` / `show` |
| Project roadmap and structured milestones | `mstar roadmap show`, `mstar milestone list` |
| Host ledger — dispatch/settle evidence | dashboard agent-flow projection |

Document bodies stay in files (`{SPECS_DIR}`, `{KNOWLEDGE_DIR}`, `{PLAN_DIR}`, iteration compasses);
the store holds their identity, lifecycle, relations and runtime state. Markdown index tables in
READMEs are prose navigation only — no row has to be maintained there.

## Path symbols

| Symbol | Path | Git |
|--------|------|-----|
| `{HARNESS_DIR}` | `.mstar/` | — |
| `store.db` | `.mstar/store.db` | gitignored (process) — live authority (see above) |
| `{SPECS_DIR}` | `.mstar/specs/` | tracked (frozen specs, ADRs) |
| `{KNOWLEDGE_DIR}` | `.mstar/knowledge/` | tracked |
| `{PLAN_DIR}` | `.mstar/plans/` | gitignored (process) |
| `{ITERATION_DIR}` | `.mstar/iterations/` | gitignored (process) |
| `{SDD_DIR}` | `.mstar/sdd/<plan-id>/` | gitignored (process) |
| `{WORKFLOW_DIR}` | `.mstar/workflows/<workflow-id>/` | gitignored (process) — retained bodies: `notes.jsonl`, delivery evidence |
| `{PROJECT_DIR}` | `.mstar/projects/<id>/` | gitignored (process) — `references/`, `reports/` |
| `archived/` | `.mstar/archived/` | gitignored (process) — retired bytes, kept for recovery |

## Content boundaries

- `{SPECS_DIR}` — long-lived, frozen specifications / ADRs; the SSOT for plan `primary_spec`. The current frozen spec is `advisor-plugin.md`.
- `{ITERATION_DIR}/<id>/` — iteration package: `delivery-compass.md` + `guides/` (exploration) + `specs/` (iteration-scoped drafts that mirror the frozen spec, never canonical).
- `{KNOWLEDGE_DIR}` — reusable implementation knowledge; written only via `mstar-compound` at iteration-close.
- `{PLAN_DIR}` — main plans and durable gate summaries.
- `{PROJECT_DIR}/<id>/` — project-layer material: `references/` (topic corpora) and `reports/` (e.g. `reports/pr-review/`); never specs or knowledge.
- `archived/` — files retired by a harness migration or cleanup. Archived bytes are kept as-is and never rewritten; moving anything back into a live path is an engine-supported migration, not a file move.

## Hard rules

- **No local machine paths** (absolute user-home or machine-specific paths) in any tracked document; references to the dsh repo are by repo name only. `$DSH_HOME` (environment variable) is acceptable.
- Process state lives in `store.db`; process artifacts (`plans/`, `iterations/`, `sdd/`, `workflows/`, `projects/`, `archived/`, `store.db`) stay gitignored. Results (`specs/`, `knowledge/`, this file) are tracked.
- Migration sources consumed by the store — legacy root `status.json` and `notes.json`, workflow `snapshot.json` + `sessions/`, and the project register `residuals.json` — are retired history: their bytes belong in `archived/`, never rewritten, and never re-registered as a live write target.
- Plan, iteration and issue status is owned by the project-manager; `Done` is set only by PM or QA, and an issue is retired only by the closure verbs (`mstar issue close | waive | duplicate | supersede`).
- Confirmed findings are captured as issues in `store.db` (plan-linked `mstar plan issue-add`, unscoped `mstar issue add`) — a confirmed finding is never parked in prose alone.
- Iteration drafts land in the iteration package, never directly in `{SPECS_DIR}`; `{KNOWLEDGE_DIR}` is never written during iteration-start — only at iteration-close via `mstar-compound`.

## Escalation Triggers

- Contradiction between this file and a tracked spec → the frozen spec (`{SPECS_DIR}`) wins; escalate to PM.
- Missing branch metadata (`iteration_base_branch` / `target_branch` / `spec_integration_branch`) → stop and confirm with PM; never default to `main` silently.
