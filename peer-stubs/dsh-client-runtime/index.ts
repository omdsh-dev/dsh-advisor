/**
 * Dev-time stand-in for `@deepseek-ai/dsh-client-runtime/client` — the browser
 * runtime services consumed by the dsh-advisor client half.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface pinned to dsh-private commit
 * b8343cb (2026-08-09 snapshot):
 *
 * - `ClientContext` = cordis `Context` with the merged service faces the
 *   advisor entry consumes (`ctx.slots` here; `ctx.locale` merges in the
 *   `@deepseek-ai/dsh-client-locale` stub — same merge topology as the real
 *   packages) and the pushed invalidation events the section subscribes to
 *   (`settings/changed`, `models/changed`);
 * - a minimal `SlotsService` twin (register/inject/entries/subscribe/
 *   getVersion over the ui-slots `SlotCore`);
 * - `SnapshotStore` / `createSnapshotStore` — the snapshot-store engine the
 *   advisor store is built on (getSnapshot/subscribe/update/set;
 *   `update` mutates the draft in place in this stand-in).
 *
 * Deliberate simplifications vs the real runtime: no connection stream, no
 * sessions/workspaces services, no fiber-effect wiring on the service
 * (dev-time composition only needs the typed faces below).
 *
 * @module @deepseek-ai/dsh-client-runtime/client
 */

import type { Context } from 'cordis'
import type {
  HostObservable, ObservableSnapshot, RegisterOptions, SlotComponent, SlotLabel,
  SlotMap, SlotSpec, StoredEntry,
} from '@deepseek-ai/dsh-client-ui-slots'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

/** Writable snapshot store (bare data face; React selector hooks are synthesized in web-react). */
export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  /**
   * Mutate the state through a draft. In the real runtime the draft is an
   * immer proxy and the commit swaps the stored snapshot; this dev-time
   * stand-in mutates the current snapshot in place and notifies.
   * @param mutator - draft mutator.
   */
  update(mutator: (draft: T) => void): void
  /** Replace the state wholesale. */
  set(next: T): void
}

/**
 * Create a snapshot store — minimal observable stand-in for the runtime's
 * `createSnapshotStore` (the single documented client-bundle exemption).
 * @param init - initial state.
 * @returns the store.
 */
export function createSnapshotStore<T>(init: T): SnapshotStore<T> {
  let current = init
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    update: (mutator) => {
      mutator(current)
      for (const fn of [...listeners]) fn()
    },
    set: (next) => {
      current = next
      for (const fn of [...listeners]) fn()
    },
  }
}

/**
 * Minimal twin of the runtime `SlotsService` (the real layer wraps `SlotCore`
 * with caller-fiber effects and `slots/changed` bridging; the stub keeps the
 * consumed faces — `register` / `inject` / `entries` / `subscribe` /
 * `getVersion` — synchronous and fiber-free).
 */
export class SlotsService {
  private readonly _core: SlotCore

  constructor(core?: SlotCore) {
    this._core = core ?? new SlotCore()
  }

  /** Contribute a component to a declared slot (load-time validation lives in the core). */
  register<
    K extends keyof SlotMap & string,
    I extends object = object,
    N extends (keyof import('@deepseek-ai/dsh-client-ui-slots').LocaleNamespaceMap & string) | undefined = undefined,
  >(
    options: RegisterOptions<K, I, N>,
    component: SlotComponent<import('@deepseek-ai/dsh-client-ui-slots').PropsRuntime<K> & import('@deepseek-ai/dsh-client-ui-slots').PropsLocale<N> & I>,
  ): () => void {
    return this._core.register(options, component)
  }

  /**
   * Wait for a slot's declaration lifetime, then run the callback (synchronously
   * when already declared; otherwise at the next declaration commit). The
   * disposer removes the contribution and cancels the pending wait.
   */
  inject(key: keyof SlotMap & string, callback: () => (() => void) | Iterable<() => void, void, void>): () => void {
    let active: (() => void) | undefined
    let stopped = false
    let unsubscribe = (): void => {}
    const stop = (): void => {
      if (stopped) return
      stopped = true
      unsubscribe()
      const dispose = active
      active = undefined
      dispose?.()
    }
    const reconcile = (): void => {
      if (stopped) return
      if (this._core.specDynamic(key) === undefined) return
      const effects = callback()
      const disposers = typeof effects === 'function' ? [effects] : [...effects]
      active = () => { for (const dispose of [...disposers].reverse()) dispose() }
    }
    unsubscribe = this._core.subscribeDeclaration(key, reconcile)
    reconcile()
    return stop
  }

  /** Snapshot the registered entries for a key (stable reference between mutations). */
  entries(key: keyof SlotMap & string): readonly StoredEntry[] {
    return this._core.entries(key)
  }

  /** Subscribe to a key's registration changes. */
  subscribe(key: keyof SlotMap & string, fn: () => void): () => void {
    return this._core.subscribe(key, fn)
  }

  /** Version counter for uSES pairing. */
  getVersion(key: keyof SlotMap & string): number {
    return this._core.getVersion(key)
  }
}

declare module 'cordis' {
  interface Events {
    /** One settings namespace's resolved value changed on the host. */
    'settings/changed'(ns: string): void
    /** The host provider topology changed. */
    'models/changed'(): void
  }
  interface Context {
    /** The slot registry service (register + declaration-waiting inject). */
    slots: SlotsService
  }
}

/** The cordis context a client plugin's `apply(ctx)` receives (mirrors `ClientContext = Context`). */
export type ClientContext = Context

export type { HostObservable, ObservableSnapshot, SlotLabel }
