# AGENTS.md — `.mstar/` (Morning Star harness)

Harness-layer conventions for this repo (a standalone dsh plugin bundle porting the omp "advisor" subsystem). Project-level rules (build, branch, security, specs routing) belong in the root `AGENTS.md` when one is created; this file covers the harness subtree only and is the harness SSOT for it.

## Source Priority

1. Current user instruction
2. Root `AGENTS.md` (when created)
3. This file
4. `mstar-*` skills (Morning Star harness; see `mstar-harness-core`)

## Path symbols

| Symbol | Path | Git |
|--------|------|-----|
| `{HARNESS_DIR}` | `.mstar/` | — |
| `{SPECS_DIR}` | `.mstar/specs/` | tracked (frozen specs, ADRs) |
| `{PLAN_DIR}` | `.mstar/plans/` | gitignored (process) |
| `{ITERATION_DIR}` | `.mstar/iterations/` | gitignored (process) |
| `{KNOWLEDGE_DIR}` | `.mstar/knowledge/` | tracked (once populated) |
| `{SDD_DIR}` | `.mstar/sdd/<plan-id>/` | gitignored (process) |
| status / notes | `.mstar/status.json`, `.mstar/notes.json` | gitignored (process) |

## Content boundaries

- `{SPECS_DIR}` — long-lived, frozen specifications / ADRs; the SSOT for plan `primary_spec`. The current frozen spec is `advisor-plugin.md`.
- `{ITERATION_DIR}/<id>/` — iteration package: `delivery-compass.md` (iteration status SSOT, frontmatter `status`) + `guides/` (exploration) + `specs/` (iteration-scoped drafts that mirror the frozen spec, never canonical).
- `{KNOWLEDGE_DIR}` — reusable implementation knowledge; written only via `mstar-compound` at iteration-close.
- `{PLAN_DIR}` — main plans and durable gate summaries.

## Hard rules

- **No local machine paths** (absolute user-home or machine-specific paths) in any tracked document; references to the dsh repo are by repo name only. `$DSH_HOME` (environment variable) is acceptable.
- Process artifacts (plans, iterations, status.json, notes.json, sdd/) stay gitignored; results (specs, knowledge, this file) are tracked.
- Iteration drafts land in the iteration package, never directly in `{SPECS_DIR}`; `{KNOWLEDGE_DIR}` is never written during iteration-start — only at iteration-close via `mstar-compound`.
- Plan and iteration status (`status.json`, compass frontmatter) are owned by the project-manager; `Done` is set only by PM or QA.

## Escalation Triggers

- Contradiction between this file and a tracked spec → the frozen spec (`{SPECS_DIR}`) wins; escalate to PM.
- Missing branch metadata (`iteration_base_branch` / `target_branch` / `spec_integration_branch`) → stop and confirm with PM; never default to `main` silently.
