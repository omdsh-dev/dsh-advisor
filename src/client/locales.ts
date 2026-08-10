/**
 * Copy dictionaries for the Advisor settings section (namespace
 * `settings.advisor`). The English dictionary is the key-set source of truth
 * for the pair; the Chinese dictionary mirrors it exactly. Task 3 extends the
 * key set with the full form copy (enabled/provider/model/apply/errors…).
 */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Advisor',
  title: 'Advisor',
  intro: 'Configure the advisor reviewer model that observes the primary transcript and injects severity-ranked advice.',
  loadFailed: 'Loading advisor settings failed',
  retry: 'Retry',
  skeleton: 'The advisor settings form is coming soon.',
}

/** The settings.advisor namespace key union. */
export type AdvisorKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: typeof en = {
  nav: '顾问',
  title: '顾问',
  intro: '配置顾问审阅模型：它观察主会话记录，并注入按严重程度排序的建议。',
  loadFailed: '加载顾问设置失败',
  retry: '重试',
  skeleton: '顾问设置表单即将推出。',
}
