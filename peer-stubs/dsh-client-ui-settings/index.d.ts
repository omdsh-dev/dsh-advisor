/**
 * Dev-time type-only shim for `@deepseek-ai/dsh-client-ui-settings/client` — the
 * settings shell slot contract consumed (type-only) by the dsh-advisor client
 * half.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface pinned to dsh-private commit
 * b8343cb (2026-08-09 snapshot): the `settings.section` slot declaration on
 * the ui-slots `SlotMap` (kind `list`, scope `root`, empty owner share) that
 * the advisor entry registers into, plus the `SettingsSectionOwnerProps`
 * share. A type-only `import type {}` in the client entry pulls this merge
 * into the program — no runtime value crosses the bundle boundary.
 *
 * @module @deepseek-ai/dsh-client-ui-settings/client
 */

/**
 * Owner share of a settings section entry. The shell owns modal visibility
 * and navigation; sections receive nothing but the render site (their data
 * arrives through their own inject faces and stores).
 */
export interface SettingsSectionOwnerProps {
  /** Marker field: section owner props are intentionally empty for now. */
  children?: never
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One settings page per list entry. Registrant options carry the nav
     * identity: `id` (section key, drives `only` filtering), `order` (nav
     * position), `label` (registrant-localized display text). Sections render
     * inside the panel content column.
     */
    'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
  }
}
