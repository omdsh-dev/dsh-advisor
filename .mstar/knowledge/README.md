# Knowledge Index

| Document | Source | Description | Status |
|----------|--------|-------------|--------|
| `developer-experience/dsh-standalone-plugin-dev.md` | iteration:iter-20260810-dsh-advisor (plan dsh-advisor-mvp); updated iteration:iter-20260810-dsh-advisor-n2 (plan dsh-advisor-settings-n2) | Standalone dsh plugin bundle development against private @deepseek-ai packages: committed peer-stubs (superseding the gitignored shim overlay), prepare-based git-URL installs, plural inject names, install smoke | active |
| `architecture-patterns/omp-advisor-dsh-port.md` | iteration:iter-20260810-dsh-advisor (plan dsh-advisor-mvp) | omp advisor → dsh mechanism map (cursor/delta/guard/delivery/failure) + MVP decisions + accepted gaps | active |
| `architecture-patterns/dsh-plugin-client-half.md` | iteration:iter-20260810-dsh-advisor-n2 (plan dsh-advisor-settings-n2) | dsh web client half for a standalone plugin: dshClient declaration, closure-factory CJS bundle contract (frozen externals/purity/automatic JSX), settings.section slot registration, settings namespace wiring | active |
| `architecture-patterns/dsh-settings-exposure-boundary.md` | iteration:iter-20260810-dsh-advisor-n2 (plan dsh-advisor-settings-n2) | dsh host settings exposure allowlist — third-party namespaces refused (settings-not-exposed); fix path: plugin-shipped host patch (dsh-llm-fallbacks pattern) + unexposed-namespace guidance + blocker-defer residual | active |
| `workflow-patterns/dsh-host-dispatch-concurrency.md` | iteration:iter-20260810-dsh-advisor (plan dsh-advisor-mvp) | dsh same-step tool-call scheduling: subagent calls are exclusive (serial) — isConcurrencySafe fail-closed | active |
