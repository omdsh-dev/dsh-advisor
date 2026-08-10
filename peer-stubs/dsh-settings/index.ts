/**
 * Dev-time minimal functional stand-in for `@deepseek-ai/dsh-settings` — the
 * user-settings capability seam (`ctx.settings`) consumed by dsh-advisor's
 * settings namespace wiring (`installAdvisorSettings`).
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface of the dsh-private
 * `packages/settings/settings` seam (settingsNamespace branding, the
 * `installSettingsSection` optional-settings consumer wiring with its
 * entry-fallback semantics, and the SettingsScope / SettingsDescriptor /
 * SettingsSectionHooks types) and implements a minimal in-memory settings
 * service (`MemorySettings`) with the schema-defaults → composition-base →
 * user-layer resolution, revision bumping, and watcher notification — honest
 * enough for real-composition tests. Pinned to dsh-private commit b8343cb
 * (2026-08-09 snapshot). Keep in sync when the dsh-private baseline moves.
 *
 * @module @deepseek-ai/dsh-settings
 */

import { Context, Service } from 'cordis'
import type z from 'schemastery'

/** Nominal id of one registered settings namespace. */
export type SettingsNamespace = string & { readonly __settingsNamespace: unique symbol }

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Brand a raw string as a {@link SettingsNamespace}; lowercase kebab-case, as
 * in plugin short names.
 */
export function settingsNamespace(value: string): SettingsNamespace {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
  }
  return value as SettingsNamespace
}

/** When a namespace's changes take effect for its owner. */
export type SettingsApplies = 'live' | 'restart'

/** Registration options beyond the namespace schema. */
export interface SettingsRegisterOptions<T> {
  /** Composition-layer values resolved below the user layer (entry-config subset). */
  base?: Partial<T>
  /** Owner's effect timing, surfaced to configuration UIs; defaults to `live`. */
  applies?: SettingsApplies
  /** Reject a resolved section the owner could not act on (cross-field checks). */
  validate?: (value: T) => void
}

/** Owner-facing handle for one registered settings namespace. */
export interface SettingsScope<T> {
  /** Current resolved value: schema defaults, then `base`, then the user layer. */
  get(): T
  /** Observe committed changes to the resolved value; returns the disposer. */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  /** Merge a partial patch into this namespace's user layer and persist it. */
  update(patch: object): Promise<void>
  /** Replace this namespace's user section wholesale (`replace({})` resets all). */
  replace(section: object): Promise<void>
}

/** One registered namespace as surfaced to configuration UIs. */
export interface SettingsDescriptor {
  /** The registered namespace. */
  ns: SettingsNamespace
  /** Serialized schemastery schema (`schema.toJSON()`). */
  schema: unknown
  /** Current resolved value. */
  value: unknown
  /** Monotonic revision of the raw user section this descriptor was read at. */
  revision: number
  /** Registrant's composition `base` layer (detached), when one was declared. */
  base?: unknown
  /** Raw user section from the stored document (detached), when one exists. */
  user?: unknown
  /** Owner's declared effect timing. */
  applies: SettingsApplies
}

/** Hooks a consumer hands to {@link installSettingsSection}. */
export interface SettingsSectionHooks<T> {
  /** Receive the active configuration source (scope thunk while attached, entry otherwise). */
  setSource(current: () => T): void
  /** Re-judge anything derived from the source after an attach, a detach, or a committed change. */
  onChange(): void
  /** Reject a resolved section this consumer could not act on. */
  validate?: (value: T) => void
}

/** Value mirror of the `FiberState` members {@link isUnloading} compares against. */
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

/** Whether the consumer's own fiber is tearing down (not just losing the settings service). */
function isUnloading(ctx: Context): boolean {
  const state: number = ctx.fiber.state
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

/**
 * Install the canonical optional-settings consumer wiring: while a settings
 * service exists, register `ns` with the consumer's composition entry as the
 * `base` layer and point the source thunk at the resolved scope; when the
 * service goes away (disposal, provider reload), fall back to the entry so
 * the consumer keeps working exactly as composed. The registration rides the
 * scoped fiber, so no settings service ever mounted means none of this runs.
 * Mirrors dsh-private `packages/settings/settings` (b8343cb).
 * @param ctx - consumer plugin context owning the wiring.
 * @param ns - the consumer-owned settings namespace.
 * @param schema - schema resolving the namespace (typically the plugin Config).
 * @param entry - the consumer's composition entry config, used as `base`.
 * @param hooks - source sink and change notification.
 */
export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(ns, schema, {
      base: entry,
      ...hooks.validate === undefined ? {} : { validate: hooks.validate },
    })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      // This disposer runs for two different reasons. A settings provider
      // detaching leaves the consumer running, so it must fall back to its
      // composition entry and re-judge what it derived. The consumer's own
      // unload runs it too — and there `onChange` would re-apply against
      // resources the teardown is releasing, so the fallback is pointless
      // and the notification actively harmful.
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
  })
}

/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Layer `over` onto `under`: plain objects merge recursively, every other
 * value (arrays included) replaces the lower layer wholesale.
 */
function mergeLayers(under: unknown, over: unknown): unknown {
  if (over === undefined) return under
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in merged ? mergeLayers(merged[key], value) : value
  }
  return merged
}

/** Deep equality over JSON-shaped data — the change-detection predicate. */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqualJson(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => key in right && deepEqualJson(left[key], right[key]))
}

/** Recursively freeze one resolved value so handed-out snapshots stay immutable. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

/** One registered watcher. */
interface MemoryWatcher {
  callback: (next: unknown, prev: unknown) => void | Promise<void>
}

/** One live namespace registration owned by a registrant fiber. */
interface MemoryRegistration {
  ns: SettingsNamespace
  schema: z<unknown>
  base: unknown
  applies: SettingsApplies
  validate?: (value: unknown) => void
  resolved: unknown
  revision: number
  watchers: Set<MemoryWatcher>
}

/**
 * Minimal in-memory settings service: namespace registration with the
 * schema-defaults → base → user-layer resolution, describe/get, and the
 * scope write paths (update/replace) with revision bumping and watcher
 * notification. Providers (persistence, external publish) are out of scope
 * for the dev-time stand-in.
 */
export class MemorySettings extends Service {
  private readonly registrations = new Map<SettingsNamespace, MemoryRegistration>()
  /** Raw user sections, keyed by namespace. */
  private readonly sections = new Map<SettingsNamespace, Record<string, unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  /**
   * Register a namespace schema and receive its owner scope. The registration
   * is an effect on the calling fiber: disposing that fiber removes the
   * namespace and its observers. A duplicate registration fails loud.
   */
  register<T>(ns: SettingsNamespace, schema: z<T>, options?: SettingsRegisterOptions<T>): SettingsScope<T> {
    if (this.registrations.has(ns)) {
      throw new Error(`settings namespace "${ns}" is already registered`)
    }
    const registration: MemoryRegistration = {
      ns,
      schema: schema as z<unknown>,
      base: options?.base,
      applies: options?.applies ?? 'live',
      ...options?.validate === undefined
        ? {}
        : { validate: options.validate as (value: unknown) => void },
      resolved: deepFreeze(this.resolve(schema, options?.base, this.sections.get(ns), options?.validate)),
      revision: 0,
      watchers: new Set(),
    }
    this.registrations.set(ns, registration)
    this.ctx.effect(() => () => this.registrations.delete(ns), `settings.register(${JSON.stringify(String(ns))})`)
    return {
      get: () => registration.resolved as T,
      watch: (callback) => {
        const watcher: MemoryWatcher = {
          callback: callback as (next: unknown, prev: unknown) => void | Promise<void>,
        }
        registration.watchers.add(watcher)
        return () => {
          registration.watchers.delete(watcher)
        }
      },
      update: (patch) => this.update(ns, patch),
      replace: (section) => this.replace(ns, section),
    }
  }

  /** Describe every registered namespace for configuration surfaces, in registration order. */
  describe(): SettingsDescriptor[] {
    return [...this.registrations.values()].map((registration) => {
      const user = this.sections.get(registration.ns)
      const base = registration.base === undefined ? undefined : structuredClone(registration.base)
      const detachedUser = user === undefined ? undefined : structuredClone(user)
      return {
        ns: registration.ns,
        schema: registration.schema.toJSON(),
        value: registration.resolved,
        revision: registration.revision,
        ...base === undefined ? {} : { base },
        ...detachedUser === undefined ? {} : { user: detachedUser },
        applies: registration.applies,
      }
    })
  }

  /** Read one registered namespace's resolved value, or `undefined` while unregistered. */
  get(ns: SettingsNamespace): unknown {
    return this.registrations.get(ns)?.resolved
  }

  /** Merge a patch into one registered namespace's user layer and commit. */
  async update(ns: SettingsNamespace, patch: object): Promise<void> {
    const registration = this.requireRegistration(ns)
    if (!isPlainObject(patch)) throw new TypeError(`settings update for "${ns}" must be a plain object`)
    const section = mergeLayers(this.sections.get(ns) ?? {}, patch) as Record<string, unknown>
    this.commit(registration, section)
  }

  /** Replace one registered namespace's user section wholesale and commit. */
  async replace(ns: SettingsNamespace, section: object): Promise<void> {
    const registration = this.requireRegistration(ns)
    if (!isPlainObject(section)) throw new TypeError(`settings replace for "${ns}" must be a plain object`)
    this.commit(registration, section)
  }

  private requireRegistration(ns: SettingsNamespace): MemoryRegistration {
    const registration = this.registrations.get(ns)
    if (registration === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
    return registration
  }

  /** Commit one user section: resolve, persist, bump the revision, notify watchers. */
  private commit(registration: MemoryRegistration, section: Record<string, unknown>): void {
    const before = this.sections.get(registration.ns)
    const next = deepFreeze(this.resolve(registration.schema, registration.base, section, registration.validate))
    const prev = registration.resolved
    this.sections.set(registration.ns, section)
    if (!deepEqualJson(before, section)) registration.revision += 1
    if (deepEqualJson(next, prev)) return
    registration.resolved = next
    for (const watcher of [...registration.watchers]) {
      try {
        const returned = watcher.callback(next, prev)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<void>).then(undefined, (error: unknown) => {
            this.warnWatcherFailure(registration.ns, error)
          })
        }
      } catch (error) {
        this.warnWatcherFailure(registration.ns, error)
      }
    }
  }

  /** Contained-watcher diagnostic (a failing watcher must not wedge the commit path). */
  private warnWatcherFailure(ns: SettingsNamespace, error: unknown): void {
    this.ctx.logger.warn('settings: watcher for "%s" failed', ns)
    this.ctx.logger.warn(error)
  }

  /** Resolve one namespace value: schema defaults, then `base`, then the user layer. */
  private resolve<T>(
    schema: z<T>,
    base: unknown,
    section: Record<string, unknown> | undefined,
    validate?: (value: T) => void,
  ): T {
    // The merged candidate is untyped by construction; the schema call is the
    // runtime validation that admits it into T (mirrors the real service).
    const value = schema(mergeLayers(base, section) as never)
    validate?.(value)
    return value
  }
}

declare module 'cordis' {
  interface Context {
    settings: MemorySettings
  }
}
