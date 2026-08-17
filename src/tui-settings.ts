/**
 * dsh-tui settings-section seam (plan dsh-advisor-tui-settings-n9, T1) — the
 * `tuiSettingsSections` Advisor section.
 *
 * dsh-tui ≥ v0.8.0 ships a `/settings` screen; optional plugins declare what
 * is editable there by registering a SECTION over their settings namespace on
 * the optional `tuiSettingsSections` host service
 * (`src/dsh-adapter/settings-sections.ts` in dsh-TUI — a small host-only
 * registry; storage + validation stay with the dsh settings service). The
 * screen then renders the section's fields, stages edits, and writes them on
 * save through the revision-fenced `settings.mutate` into the section's
 * namespace user layer — for the advisor that is the already-registered
 * `advisor` namespace (`src/settings.ts` `installAdvisorSettings`), so the
 * section is fully writable.
 *
 * This module is the advisor's settings-seam surface:
 * `installTuiSettingsSection` conditionally injects `tuiSettingsSections` and
 * registers {@link ADVISOR_TUI_SETTINGS_SECTION} when the service exists; a
 * profile without the `dsh-tui-settings-sections` row (dsh-tui < v0.8.0, or
 * any non-TUI host) gets a clean no-op. The provider shapes are minimal LOCAL
 * structural copies of the dsh-TUI types — the advisor MUST NOT import
 * `@deepseek-harness-tui/dsh-tui` (zero new peers, plan Global Constraint),
 * so drift against the upstream shape is bounded to the structural cast at
 * the inject boundary and pinned by `tests/tui-settings.test.ts`.
 *
 * Field subset (grill-me locked): the section covers the five SAFE §5.1 keys
 * (`enabled` / `provider` / `model` / `immuneTurns` / `maxDeltaMessages`).
 * `systemPrompt` is intentionally NOT a field — the TUI `text` control is
 * single-line, and editing a multi-line prompt there would truncate/replace
 * it (data loss). It stays editable via the web card or
 * `$DSH_HOME/settings.yaml`. The TUI seam has no cross-field validation
 * (upstream behavior, recorded): a save may set `enabled: true` with empty
 * `provider`/`model`, which the S4 explicit model gate (spec §5.2) resolves
 * to disabled-with-reason at runtime; the settings-service schema
 * re-validation on mutate is the value-level backstop (a non-schema value
 * fails the whole save before persist).
 *
 * @module dsh-advisor/tui-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { ADVISOR_SETTINGS_NAMESPACE } from './settings.js'

/** Localized (zh/en) descriptions — structural mirror of dsh-TUI's
 * `LocalizedDescriptions` (the `/settings` section + field labels/hints). */
export type TuiLocalizedDescriptions = Readonly<Partial<Record<'zh' | 'en', string>>>

/** One `kind: 'select'` choice — structural mirror of dsh-TUI's
 * `TuiSettingsFieldOption`. */
export interface TuiSettingsFieldOption {
  /** Stored value. */
  value: string
  /** Display label (English; also the fallback). */
  label: string
  /** Provider-owned translations for the label. */
  descriptions?: TuiLocalizedDescriptions
}

/** The write one field's draft stages when the section is saved — structural
 * mirror of dsh-TUI's `TuiSettingsFieldWrite`. */
export type TuiSettingsFieldWrite =
  | { kind: 'set'; value: unknown }
  | { kind: 'clear' }

/** One editable field inside a section — structural mirror of dsh-TUI's
 * `TuiSettingsField`. `path` uses the settings-service `mutate` path
 * vocabulary (object keys); the advisor's §5.1 flat keys map directly as
 * single-element paths. */
export interface TuiSettingsField {
  /** Key path from the section root, in the settings service's `mutate` path
   * vocabulary (object keys; dict keys name their entry directly). */
  path: readonly string[]
  /** Short field label (English; also the fallback). */
  label: string
  /** Provider-owned translations for the label. */
  descriptions?: TuiLocalizedDescriptions
  /** Optional one-line help rendered under the field. */
  hint?: string
  /** Provider-owned translations for the hint. */
  hintDescriptions?: TuiLocalizedDescriptions
  kind: 'text' | 'number' | 'boolean' | 'select'
  /** Choices for `kind: 'select'` (ignored otherwise). */
  options?: readonly TuiSettingsFieldOption[]
  /** Input placeholder for `kind: 'text' | 'number'`. */
  placeholder?: string
  /** Credential control (mirrors the web cards' CardSecretSpec). */
  secret?: { ref: string }
  /** Render a stored value as draft text (defaults to the kind's conversion). */
  format?(value: unknown): string
  /** The write this draft text stages, or `undefined` when the text is not a
   * value this field accepts (defaults to the kind's conversion — an empty
   * text/number draft stages a clear, re-inheriting the composition layer). */
  parse?(text: string): TuiSettingsFieldWrite | undefined
}

/** One plugin's section inside the TUI `/settings` screen — structural mirror
 * of dsh-TUI's `TuiSettingsSection`. */
export interface TuiSettingsSection {
  /** Settings namespace this section edits; the screen marks the section
   * unavailable when the composition serves no such namespace. */
  ns: string
  /** Section title (English; also the fallback). */
  title: string
  /** Provider-owned translations for the title. */
  descriptions?: TuiLocalizedDescriptions
  /** Editable fields, in display order. */
  fields: readonly TuiSettingsField[]
}

/** Test-friendly alias for the section namespace (`'advisor'`). The section
 * itself reuses the shared {@link ADVISOR_SETTINGS_NAMESPACE} brand — a
 * mismatched ns would silently render the section "unavailable" in the host
 * screen (the alias exists so tests can pin the value without importing the
 * settings module's brand). */
export const ADVISOR_TUI_SETTINGS_NS = 'advisor'

/** The declared "Advisor" section for the dsh-tui `/settings` screen: the
 * five safe §5.1 keys (enabled/provider/model/immuneTurns/maxDeltaMessages)
 * with zh/en labels + hints. Field paths are single-element §5.1 flat keys,
 * so staged edits map 1:1 onto the namespace `mutate` paths. */
export const ADVISOR_TUI_SETTINGS_SECTION: TuiSettingsSection = {
  ns: ADVISOR_SETTINGS_NAMESPACE,
  title: 'Advisor',
  descriptions: {
    zh: '顾问评审设置',
    en: 'Advisor settings',
  },
  fields: [
    {
      path: ['enabled'],
      kind: 'boolean',
      label: 'Enabled',
      descriptions: { zh: '启用', en: 'Enabled' },
      hint: 'Master switch for the advisor.',
      hintDescriptions: { zh: '顾问总开关。', en: 'Master switch for the advisor.' },
    },
    {
      path: ['provider'],
      kind: 'text',
      label: 'Provider',
      descriptions: { zh: 'Provider', en: 'Provider' },
      hint: 'Provider route; required (non-empty) when enabled.',
      hintDescriptions: { zh: 'Provider 路由；启用时必须非空。', en: 'Provider route; required (non-empty) when enabled.' },
      placeholder: 'e.g. deepseek-official',
    },
    {
      path: ['model'],
      kind: 'text',
      label: 'Model',
      descriptions: { zh: 'Model', en: 'Model' },
      hint: 'Model id; required (non-empty) when enabled.',
      hintDescriptions: { zh: '模型 ID；启用时必须非空。', en: 'Model id; required (non-empty) when enabled.' },
      placeholder: 'e.g. deepseek-v4-flash',
    },
    {
      path: ['immuneTurns'],
      kind: 'number',
      label: 'Immune turns',
      descriptions: { zh: '免疫轮数', en: 'Immune turns' },
      hint: 'Cooldown after a delivered interrupt (integer ≥ 0).',
      hintDescriptions: { zh: '投递一次建议后的冷却轮数（整数 ≥ 0）。', en: 'Cooldown after a delivered interrupt (integer ≥ 0).' },
    },
    {
      path: ['maxDeltaMessages'],
      kind: 'number',
      label: 'Max delta messages',
      descriptions: { zh: '最大增量消息数', en: 'Max delta messages' },
      hint: 'Delta window (integer ≥ 0; 0 = unbounded).',
      hintDescriptions: { zh: '增量窗口（整数 ≥ 0；0 = 不限）。', en: 'Delta window (integer ≥ 0; 0 = unbounded).' },
    },
  ],
}

/**
 * Install the advisor's TUI settings-section surface: register the "Advisor"
 * section on `tuiSettingsSections` when the host service exists (conditional
 * inject; absent service → clean no-op). Called from `apply()` AFTER the
 * single-reviewer claim (next to `installTuiClient`), so the section registers
 * at most once per process. The structural accessor keeps the inject key in
 * the standard position: the cordis Context has no `tuiSettingsSections`
 * augmentation in this repo, so the service is read through a local
 * structural cast. The inject child's return value (the registry disposer)
 * is the child's own effect disposer, so the section withdraws when this
 * fiber (or the service) goes away; a duplicate-ns registration is contained
 * (debug log + no-op disposer, never throws — multi-fiber dedupe).
 */
export function installTuiSettingsSection(ctx: Context): void {
  ctx.inject(['tuiSettingsSections'], (tctx) => {
    const sections = (tctx as unknown as { tuiSettingsSections?: { register(s: TuiSettingsSection): () => void } }).tuiSettingsSections
    if (sections === undefined) return
    try {
      return sections.register(ADVISOR_TUI_SETTINGS_SECTION)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already registered')) throw error
      tctx.logger('advisor').debug('advisor tui settings section already registered — no section on this fiber (multi-fiber dedupe)')
      return () => {}
    }
  })
}
