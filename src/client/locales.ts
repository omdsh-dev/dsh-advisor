/**
 * Copy dictionaries for the Advisor settings card (namespace
 * `settings.advisor`). The English dictionary is the key-set source of truth
 * for the pair; the Chinese dictionary mirrors it exactly.
 *
 * Flat rebuild (2026-09-26): the page title/intro moved to the plugin meta
 * locale files (`locale/en.json` / `locale/zh.json` — the host plugin manager
 * renders them), and the collapsible chrome copy (`collapse`/`expand`/
 * `unsaved`) and the `enabled` checkbox label died with the config-level
 * switch. `providerRequired`/`modelRequired` are unconditional now — there is
 * no enable checkbox to make the pair gate conditional.
 */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  loadFailed: 'Loading advisor settings failed',
  retry: 'Retry',
  provider: 'Provider',
  providerPlaceholder: 'Select a provider',
  providerRequired: 'Provider is required.',
  model: 'Model',
  modelPlaceholder: 'Select a model',
  modelRequired: 'Model is required.',
  noProviders: 'No configured providers. Configure one on the Models page first.',
  noModels: 'This provider has no available models. Configure models for it on the Models page.',
  staleProvider: 'The stored provider is no longer configured. Reselect one or keep the stored value.',
  staleModel: 'The stored model is no longer available for this provider. Reselect one or keep the stored value.',
  systemPrompt: 'System prompt',
  systemPromptHint: 'Leave empty to use the default system prompt',
  immuneTurns: 'Immune turns',
  maxDeltaMessages: 'Max delta messages',
  proseFallback: 'Prose fallback',
  proseFallbackHint: 'When no JSON frame is found, deliver the prose reply as a low-severity note — for models that answer in prose instead of JSON.',
  reasoningEffort: 'Thinking effort',
  reasoningEffortAuto: 'Automatic (smallest)',
  reasoningEffortHint: 'Leave empty to use the smallest thinking effort the selected model declares.',
  reasoningEffortUnavailable: 'Thinking-effort options are currently unavailable for the selected model — only automatic is available.',
  reasoningEffortStale: 'The stored thinking effort is not declared by the selected model. Reselect one or keep the stored value.',
  // The select's own option for a stored value the selected model does not
  // declare — one key per capability state, so a pending lookup never reads
  // as "unavailable" (task-3 review R2 + the copy nit). {id} interpolates the
  // stored effort id.
  reasoningEffortStored: 'Stored: {id} (unavailable)',
  reasoningEffortStoredStale: 'Stored: {id} (not declared)',
  reasoningEffortStoredPending: 'Stored: {id}',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saved: 'Advisor settings saved. New sessions pick them up immediately.',
  readOnly: 'Settings are read-only in this environment.',
  namespaceUnavailable: 'The advisor configuration channel is not available yet — the settings gateway is not ready on this host. Configure the advisor via the plugin config row — `- id: advisor` whose `config:` map sets `provider`/`model` (e.g. `config: { provider: …, model: … }`) in `$DSH_HOME/profiles/<name>/cordis.patch.yml`. The advisor plugin runs fully from its plugin config row; the web settings form becomes available again on the next load once the gateway is reachable. Note: `/advisor` only toggles the advisor per session; it cannot supply provider/model.',
  // Session header action (B2): the control lives on the session header and
  // drives the live-session reviewer route only.
  sessionTrigger: 'Advisor',
  sessionExpand: 'Open the advisor controls for this session',
  sessionCollapse: 'Close the advisor controls for this session',
  sessionLoading: 'Loading…',
  sessionModelHeading: 'Reviewer model for this session',
  sessionSourceSession: 'session override',
  sessionSourceGlobal: 'global default',
  sessionNoPair: 'No reviewer model — the global default has no provider/model.',
  sessionLifetime: 'Lives for this session only — never persisted; cleared on dispose or restart. A new or forked session inherits the global defaults.',
  sessionAdvisorOff: 'The advisor is off for this session.',
  sessionGateBlocked: 'No model call can start: {reason}',
  sessionPinAction: 'Pin this model',
  sessionPending: 'Applying…',
  sessionReset: 'Use global default',
  sessionUnavailable: 'The advisor session control surface is not available on this host. Use /advisor model in the session, or configure the global defaults on the Plugins page.',
  // Next-prompt suggestion tip (plan dsh-advisor-next-prompt-n12, T3;
  // dock-tip rework e2e-n13): the config-card checkbox copy + the tip row's
  // prefix and accept copy. The old `nextPromptBadge` key died with the
  // overlay form's → badge (no remaining reference).
  nextPrompt: 'Next-prompt suggestion',
  nextPromptHint: 'Show the reviewer’s suggested next prompt as a tip below the composer; press → to insert it.',
  nextPromptPrefix: 'Suggestion',
  nextPromptAccept: '→ Accept',
  // Session default switch (GitHub issue #124): new sessions start enabled;
  // turning this off makes the advisor opt-in per session via /advisor on.
  defaultEnabled: 'Enabled by default',
  defaultEnabledHint: 'New sessions start with the advisor on; turn it off to make the advisor opt-in per session (enable with /advisor on).',
}

/** The settings.advisor namespace key union. */
export type AdvisorKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: typeof en = {
  loadFailed: '加载顾问设置失败',
  retry: '重试',
  provider: '提供商',
  providerPlaceholder: '选择提供商',
  providerRequired: '提供商不能为空。',
  model: '模型',
  modelPlaceholder: '选择模型',
  modelRequired: '模型不能为空。',
  noProviders: '没有已配置的提供商。请先在 Models 页面配置。',
  noModels: '该提供商没有可用模型。请到 Models 页面为其配置模型。',
  staleProvider: '存储的提供商已不在配置中。请重新选择，或保留存储的值。',
  staleModel: '存储的模型在该提供商下已不可用。请重新选择，或保留存储的值。',
  systemPrompt: '系统提示词',
  systemPromptHint: '留空则使用默认系统提示词',
  immuneTurns: '免疫轮次',
  maxDeltaMessages: '最大增量消息数',
  proseFallback: '散文回退',
  proseFallbackHint: '未找到 JSON 帧时，将散文回复作为低严重级建议投递——适用于以散文而非 JSON 作答的模型。',
  reasoningEffort: '思考权重',
  reasoningEffortAuto: '自动（最小）',
  reasoningEffortHint: '留空则使用所选模型声明的最小思考权重。',
  reasoningEffortUnavailable: '所选模型当前无法提供思考权重选项——仅可使用自动。',
  reasoningEffortStale: '存储的思考权重不在所选模型的声明列表中。请重新选择，或保留存储的值。',
  reasoningEffortStored: '已存储：{id}（所选模型不可用）',
  reasoningEffortStoredStale: '已存储：{id}（未在声明列表中）',
  reasoningEffortStoredPending: '已存储：{id}',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  saved: '顾问设置已保存。新会话立即生效。',
  readOnly: '当前环境中的设置为只读。',
  namespaceUnavailable: '顾问配置通道暂不可用——本宿主上的设置网关尚未就绪。请通过插件配置行配置顾问——在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 中写 `- id: advisor`，其 `config:` 映射中设置 `provider`/`model`（例如 `config: { provider: …, model: … }`）。顾问插件完全通过插件配置行运行；网关可用后，web 设置表单将在下次加载时重新显示。注意：`/advisor` 仅切换当前会话的顾问开关，无法提供 provider/model。',
  sessionTrigger: '顾问',
  sessionExpand: '打开本会话的顾问控制',
  sessionCollapse: '关闭本会话的顾问控制',
  sessionLoading: '加载中…',
  sessionModelHeading: '本会话的审阅模型',
  sessionSourceSession: '会话覆盖',
  sessionSourceGlobal: '全局默认',
  sessionNoPair: '暂无审阅模型——全局默认未配置 provider/model。',
  sessionLifetime: '仅在本会话内有效——从不持久化；会话销毁或重启后清除。新建或分叉的会话继承全局默认值。',
  sessionAdvisorOff: '本会话的顾问已关闭。',
  sessionGateBlocked: '无法发起模型调用：{reason}',
  sessionPinAction: '固定此模型',
  sessionPending: '应用中…',
  sessionReset: '使用全局默认',
  sessionUnavailable: '本宿主上的顾问会话控制面不可用。请在会话中使用 /advisor model，或在 Plugins 页配置全局默认值。',
  nextPrompt: '下一条提示建议',
  nextPromptHint: '在输入框下方以提示条显示审阅者建议的下一条提示；按 → 插入。',
  nextPromptPrefix: '建议',
  nextPromptAccept: '→ 采纳',
  defaultEnabled: '默认启用',
  defaultEnabledHint: '新会话默认开启顾问；关闭后改为按会话手动启用（用 /advisor on）。',
}
