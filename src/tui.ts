/**
 * dsh-tui client surface (plan dsh-advisor-tui-client-n8, T1) — the
 * `tuiCommandTrees` /advisor provider.
 *
 * In a `dsh --profile dsh-tui` terminal session the plugin's `/advisor`
 * command (registered through the conditional `ctx.inject(['commands'], ...)`
 * child) already lands in the TUI `/` menu via the command-registry merge.
 * What the TUI cannot infer is the LOCALIZED row description and the typed
 * subcommand COMPLETION — those come from the optional `tuiCommandTrees`
 * host service (`src/dsh-adapter/command-trees.ts` in dsh-TUI): a provider
 * declares `root`, zh/en `descriptions`, and a `children(canonicalPath)`
 * completion tree (root at index 0; the TUI asks at depth 2 when completing
 * `/advisor <sub> ⋯`).
 *
 * This module is the advisor's TUI seam: `installTuiClient` conditionally
 * injects `tuiCommandTrees` and registers the `/advisor` tree when the
 * service exists; a profile without the `dsh-tui-command-trees` row (or any
 * non-TUI host) gets a clean no-op. The provider shapes are minimal LOCAL
 * structural copies of the dsh-TUI types — the advisor MUST NOT import
 * `@deepseek-harness-tui/dsh-tui` (zero new peers, plan Global Constraint),
 * so drift against the upstream shape is bounded to the structural cast at
 * the inject boundary and pinned by `tests/tui-client.test.ts`.
 *
 * @module dsh-advisor/tui
 */

import type { Context } from '@deepseek-ai/cordis'

/** Localized (zh/en) descriptions — structural mirror of dsh-TUI's
 * `LocalizedDescriptions` (the TUI `/` row + completion descriptions). */
export type TuiLocalizedDescriptions = Readonly<Partial<Record<'zh' | 'en', string>>>

/** One completion node — structural mirror of dsh-TUI's
 * `CommandCompletionNode` (`src/commands.ts` in dsh-TUI). */
export interface TuiCommandCompletionNode {
  name: string
  aliases?: readonly string[]
  description: string
  descriptions?: TuiLocalizedDescriptions
  tag?: string
  descriptionKey?: string
}

/** A `/`-menu command tree provider — structural mirror of dsh-TUI's
 * `TuiCommandTreeProvider`. `children` receives the canonical path with the
 * root at index 0. */
export interface TuiCommandTreeProvider {
  root: string
  descriptions?: TuiLocalizedDescriptions
  children(canonicalPath: readonly string[]): readonly TuiCommandCompletionNode[]
}

/** The `/advisor` tree root (matches the command registry name). */
export const ADVISOR_TUI_ROOT = 'advisor'

/** The four typed `/advisor` subcommands surfaced as completion children.
 * Bare `/advisor` (toggle) is the empty-argument default, not a completion
 * child (compass S1); `USAGE` is the unknown-subcommand fallback, not a
 * named command. */
const ADVISOR_SUBCOMMANDS = ['on', 'off', 'status', 'config'] as const

type AdvisorSubcommand = (typeof ADVISOR_SUBCOMMANDS)[number]

/** zh/en copy for the `/` menu row (shown via the host's `descriptions(root)`). */
const ADVISOR_TUI_DESCRIPTIONS: TuiLocalizedDescriptions = {
  zh: '按会话运行的评审顾问：开启 / 关闭 / 状态 / 配置',
  en: 'Per-session advisor: enable, disable, status, or config',
}

/** zh/en copy per completion node. `description` is the plain fallback the
 * node carries; `descriptions` is the localized map the TUI prefers. */
const SUBCOMMAND_DESCRIPTIONS: Readonly<Record<AdvisorSubcommand, { description: string; descriptions: TuiLocalizedDescriptions }>> = {
  on: {
    description: 'Enable the advisor for this session',
    descriptions: {
      zh: '为本会话启用顾问',
      en: 'Enable the advisor for this session',
    },
  },
  off: {
    description: 'Disable the advisor for this session',
    descriptions: {
      zh: '为本会话禁用顾问',
      en: 'Disable the advisor for this session',
    },
  },
  status: {
    description: 'Show per-session advisor status (state, model, runtime, pending, last activity)',
    descriptions: {
      zh: '查看本会话顾问状态（开关、模型、运行态、待处理、最近活动）',
      en: 'Show per-session advisor status (state, model, runtime, pending, last activity)',
    },
  },
  config: {
    description: 'Show the composed advisor config (settings readback)',
    descriptions: {
      zh: '查看组合后的顾问配置（设置回读）',
      en: 'Show the composed advisor config (settings readback)',
    },
  },
}

/** The `/advisor` completion tree. `children` NEVER throws: unknown paths and
 * a bare `[]` return an empty list (leaves have no deeper completion — the
 * TUI asks at depth 2). */
const advisorTree: TuiCommandTreeProvider = {
  root: ADVISOR_TUI_ROOT,
  descriptions: ADVISOR_TUI_DESCRIPTIONS,
  children(canonicalPath: readonly string[]): readonly TuiCommandCompletionNode[] {
    // Root at index 0: only `['advisor']` asks for the subcommand list.
    if (canonicalPath.length !== 1 || canonicalPath[0] !== ADVISOR_TUI_ROOT) return []
    return ADVISOR_SUBCOMMANDS.map((name) => ({
      name,
      description: SUBCOMMAND_DESCRIPTIONS[name].description,
      descriptions: SUBCOMMAND_DESCRIPTIONS[name].descriptions,
    }))
  },
}

/**
 * Install the advisor's TUI client surface: register the `/advisor`
 * `tuiCommandTrees` provider when the host service exists (conditional
 * inject; absent service → clean no-op). Called from `apply()` AFTER the
 * single-reviewer claim, so the tree registers at most once per process
 * (a duplicate-root registration would throw in the host registry). The
 * structural accessor keeps the inject key in the standard position: the
 * cordis Context has no `tuiCommandTrees` augmentation in this repo, so the
 * service is read through a local structural cast.
 */
export function installTuiClient(ctx: Context): void {
  ctx.inject(['tuiCommandTrees'], (tctx) => {
    const trees = (tctx as unknown as { tuiCommandTrees?: { register(p: TuiCommandTreeProvider): () => void } }).tuiCommandTrees
    if (trees === undefined) return
    try {
      return trees.register(advisorTree)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already registered')) throw error
      tctx.logger('advisor').debug('advisor tui tree already registered — no tree on this fiber (multi-fiber dedupe)')
      return () => {}
    }
  })
}
