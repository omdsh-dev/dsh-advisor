# Knowledge Index

| Document | Source | Description | Status |
|----------|--------|-------------|--------|
| `developer-experience/dsh-standalone-plugin-dev.md` | standalone bundle bring-up (peer-stubs → DSH_HOME link farm) | Standalone dsh plugin bundle development against private @deepseek-ai packages: committed peer-stubs (superseding the gitignored shim overlay), prepare-based git-URL installs, plural inject names, install smoke | active |
| `architecture-patterns/omp-advisor-dsh-port.md` | core MVP port | omp advisor → dsh mechanism map (cursor/delta/guard/delivery/failure) + MVP decisions + accepted gaps | active |
| `architecture-patterns/dsh-plugin-client-half.md` | client half + settings section work | dsh web client half for a standalone plugin: dsh.client declaration (nested under dsh, post-20da39e), closure-factory CJS bundle contract (frozen externals/purity/automatic JSX), CSS-modules inline injection + style-tag lifecycle + bundle hygiene, settings.section slot registration, settings namespace wiring | active |
| `architecture-patterns/dsh-settings-exposure-boundary.md` | settings exposure work (patch retirement) | dsh host settings exposure boundary — third-party namespaces join via the upstream `exposeToWebClients` registration opt-in (dsh ≥ 20da39e); no host patch; unexposed-namespace guidance for older hosts | active |
| `workflow-patterns/dsh-host-dispatch-concurrency.md` | core MVP port | dsh same-step tool-call scheduling: subagent calls are exclusive (serial) — isConcurrencySafe fail-closed | active |
| `workflow-patterns/dsh-upstream-bump-adaptation.md` | upstream bump + patch retirement | Surviving a dsh snapshot upgrade as a plugin bundle: probe discriminators (present/absent), dshClient → dsh.client migration (no fallback, negative-verdict cache), restart + runtime verification sequence; host-patch mechanism retired | active |
