/**
 * Copy dictionaries for the Advisor settings card (namespace
 * `settings.advisor`). The English dictionary is the key-set source of truth
 * for the pair; the Chinese dictionary mirrors it exactly.
 */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  title: 'Advisor',
  intro: 'Configure the advisor reviewer model that observes the primary transcript and injects severity-ranked advice.',
  collapse: 'Hide settings',
  expand: 'Show settings',
  unsaved: 'Unsaved',
  loadFailed: 'Loading advisor settings failed',
  retry: 'Retry',
  enabled: 'Enable the advisor',
  provider: 'Provider',
  providerPlaceholder: 'Select a provider',
  providerRequired: 'Provider is required when the advisor is enabled.',
  model: 'Model',
  modelPlaceholder: 'Select a model',
  modelRequired: 'Model is required when the advisor is enabled.',
  noProviders: 'No configured providers. Configure one on the Models page first.',
  noModels: 'This provider has no available models. Configure models for it on the Models page.',
  staleProvider: 'The stored provider is no longer configured. Reselect one or keep the stored value.',
  staleModel: 'The stored model is no longer available for this provider. Reselect one or keep the stored value.',
  systemPrompt: 'System prompt',
  systemPromptPlaceholder: 'Leave empty to use the default system prompt',
  immuneTurns: 'Immune turns',
  maxDeltaMessages: 'Max delta messages',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saved: 'Advisor settings saved. New sessions pick them up immediately.',
  readOnly: 'Settings are read-only in this environment.',
  namespaceUnavailable: 'The advisor configuration channel is not available yet — the settings gateway is not ready on this host. Configure the advisor via the plugin config row — `- id: advisor` whose `config:` map sets `enabled`/`provider`/`model` (e.g. `config: { enabled: true, provider: …, model: … }`) in `$DSH_HOME/profiles/<name>/cordis.patch.yml`. The advisor plugin runs fully from its plugin config row; the web settings form becomes available again on the next load once the gateway is reachable. Note: `/advisor` only toggles the advisor per session; it cannot supply provider/model.',
}

/** The settings.advisor namespace key union. */
export type AdvisorKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: typeof en = {
  title: '顾问',
  intro: '配置顾问审阅模型：它观察主会话记录，并注入按严重程度排序的建议。',
  collapse: '收起设置',
  expand: '展开设置',
  unsaved: '未保存',
  loadFailed: '加载顾问设置失败',
  retry: '重试',
  enabled: '启用顾问',
  provider: '提供商',
  providerPlaceholder: '选择提供商',
  providerRequired: '启用顾问时必须选择提供商。',
  model: '模型',
  modelPlaceholder: '选择模型',
  modelRequired: '启用顾问时必须选择模型。',
  noProviders: '没有已配置的提供商。请先在 Models 页面配置。',
  noModels: '该提供商没有可用模型。请到 Models 页面为其配置模型。',
  staleProvider: '存储的提供商已不在配置中。请重新选择，或保留存储的值。',
  staleModel: '存储的模型在该提供商下已不可用。请重新选择，或保留存储的值。',
  systemPrompt: '系统提示词',
  systemPromptPlaceholder: '留空则使用默认系统提示词',
  immuneTurns: '免疫轮次',
  maxDeltaMessages: '最大增量消息数',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  saved: '顾问设置已保存。新会话立即生效。',
  readOnly: '当前环境中的设置为只读。',
  namespaceUnavailable: '顾问配置通道暂不可用——本宿主上的设置网关尚未就绪。请通过插件配置行配置顾问——在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 中写 `- id: advisor`，其 `config:` 映射中设置 `enabled`/`provider`/`model`（例如 `config: { enabled: true, provider: …, model: … }`）。顾问插件完全通过插件配置行运行；网关可用后，web 设置表单将在下次加载时重新显示。注意：`/advisor` 仅切换当前会话的顾问开关，无法提供 provider/model。',
}
