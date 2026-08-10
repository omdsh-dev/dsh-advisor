/**
 * Dev-time stand-in for `@deepseek-ai/dsh-client-web-react` — the React
 * bindings consumed by the dsh-advisor client half.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface pinned to dsh-private commit
 * b8343cb (2026-08-09 snapshot): `bindSnapshotSelector` (the ONE hook
 * constructor in the client stack — turns a bare observable snapshot source
 * into a typed selector hook) and the `SnapshotSelectorHook` type re-export.
 *
 * Deliberate simplification vs the real `bind.ts`: the real one routes
 * through `useSyncExternalStoreWithSelector`; this dev-time stand-in returns
 * a selector that reads the current snapshot at call time (no React
 * subscription) — adequate for typechecking and store-driven dev tests, where
 * the section is rendered with a mocked inject face. Keep in sync when the
 * dsh-private baseline moves.
 *
 * @module @deepseek-ai/dsh-client-web-react
 */

import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Bind a bare observable source to a typed selector hook (dev-time stand-in:
 * reads the current snapshot per call, no React subscription).
 * @param w - snapshot source (engine store, Session object, store instance).
 * @returns the selector hook.
 */
export function bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T> {
  return function useSelector<S>(sel: (s: T) => S, _eq?: (a: S, b: S) => boolean): S {
    return sel(w.getSnapshot())
  }
}

export type { HostObservable, SnapshotSelectorHook }
