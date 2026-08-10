/**
 * Dev-time minimal functional stand-in for `@deepseek-ai/dsh-llm` — the
 * message vocabulary seam (`MessageSourceMap` merge target, `Message` /
 * `UserMessage` shapes, `createUserMessage`), the model-call vocabulary
 * (`GenerateOptions` / `StreamChunk` / `FinishReason` / `LlmFailure`), the
 * provider-failure taxonomy (`INVALID_CREDENTIAL_CODE` / `QUOTA_EXCEEDED_CODE`
 * / `isQuotaExceededError`), and the `LlmService` / `LlmAdapter` service shape
 * (`ctx.llm.stream` + `registerAdapter`) consumed by dsh-advisor's src and
 * tests.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface of the dsh-private
 * `packages/llm/llm` seam and implements just enough behavior for
 * real-composition tests: frozen message creators with stable random identity,
 * an adapter registry with provider dispatch, and the quota-wording
 * classifier. Pinned to dsh-private commit b8343cb (2026-08-09 snapshot).
 * Keep in sync when the dsh-private baseline moves.
 */

import { Service } from 'cordis'
import type { Context } from 'cordis'

/** Mirror of `@deepseek-ai/dsh-brand` `Branded<T>` (kept local so the stub stays standalone). */
export type Branded<B extends string> = string & { readonly __brand: B }

/** Stable identity preserved across every representation boundary. */
export type MessageId = Branded<'MessageId'>

/** Brand a string as a {@link MessageId}. For creator use only. */
export function MessageId(value: string): MessageId {
  return value as MessageId
}

/** Correlates a model-issued tool call with its result. */
export type CallId = Branded<'CallId'>

/** Brand a string as a {@link CallId}. */
export function CallId(value: string): CallId {
  return value as CallId
}

/** Plain text visible to the end user. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** Reasoning / thinking content, distinct from visible text. */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/** A tool invocation requested by the model. */
export interface ToolCallBlock {
  type: 'tool-call'
  /** Provider-issued call id; correlates with the matching tool result. */
  id: CallId
  name: string
  /** Raw JSON string as produced by the model. */
  arguments: string
}

/** The result of a tool invocation, sent back to the model. */
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: CallId
  content: ContentBlock[]
  isError?: boolean
}

/** Merge-extensible content blocks keyed by `type`. */
export interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}

/** The block `type` tag vocabulary; widens as plugins merge new shapes. */
export type ContentBlockType = keyof ContentBlockMap

/** Any known content block, derived from {@link ContentBlockMap}; switch on `type` and fall through unknowns. */
export type ContentBlock = ContentBlockMap[ContentBlockType]

/** Producer-declared context form and the fields that form requires (consumed subset). */
export type ContextFormed =
  | { readonly form?: never }
  | { readonly form: 'instructions' }
  | { readonly form: 'catalog' }
  | { readonly form: 'snapshot'; readonly sections: readonly { readonly name: string; readonly text: string }[] }
  | { readonly form: 'notice'; readonly summary: string }
  | { readonly form: 'relay' }
  | { readonly form: 'recall' }

/** Required source of an assistant message produced by a routed model. */
export interface ModelMessageSource {
  kind: 'model'
  provider: string
  model: string
  replayState?: unknown
}

/** Required source of a user-role message carrying one tool result. */
export interface ToolMessageSource {
  kind: 'tool'
  callId: CallId
}

/**
 * Where a message (or injected content) came from.
 * Merge-extensible sum type — plugins add their own `kind`s.
 */
export interface MessageSourceMap {
  user: { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string } & ContextFormed
  model: ModelMessageSource
  tool: ToolMessageSource
}

/** Any known message source, derived from {@link MessageSourceMap}; switch on `kind` and fall through unknowns. */
export type MessageSource = MessageSourceMap[keyof MessageSourceMap]

/** One immutable message representation shared by delivery, durable history, and model requests. */
export interface Message {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId
  /** Provider-neutral conversation role. */
  readonly role: 'system' | 'user' | 'assistant'
  /** Exact model-facing blocks. */
  readonly content: ContentBlock[]
  /** Required producer provenance. */
  readonly source: MessageSource
}

/** A user-role specialization of the one shared message representation. */
export interface UserMessage extends Message {
  readonly role: 'user'
}

/** A model-produced assistant specialization of the shared message representation. */
export interface AssistantMessage extends Message {
  readonly role: 'assistant'
  readonly source: ModelMessageSource
}

/** A tool-result specialization whose model-facing block retains call correlation. */
export interface ToolResultMessage extends Message {
  readonly role: 'user'
  readonly content: [ToolResultBlock]
  readonly source: ToolMessageSource
}

/** Detach and deep-freeze a message whose identity already exists. */
export function freezeMessage<T extends Message>(message: T): T {
  return deepFreeze(structuredClone(message))
}

/** Create one identified message and freeze it before publication. */
export function createMessage<T extends Omit<Message, 'id'>>(
  input: T & { readonly id?: never },
): T & Pick<Message, 'id'> {
  return freezeMessage({
    ...input,
    id: MessageId(crypto.randomUUID()),
  })
}

/** Create one identified user-role message and freeze it before publication. */
export function createUserMessage<T extends Omit<UserMessage, 'id' | 'role'>>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'> {
  return createMessage({
    ...input,
    role: 'user',
  })
}

/**
 * Deep-freeze a value in place with an iterative traversal, guarding cycles,
 * so later mutation throws without imposing a call-stack depth cap. Mirrors
 * the real seam (`call-config.ts`), including deliberately skipping
 * {@link AbortSignal} objects — freezing them would break the request's live
 * cancellation channel.
 */
function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: (
    | { kind: 'visit'; node: unknown }
    | { kind: 'property'; source: Record<string, unknown>; key: string }
  )[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      if (key === undefined) continue
      pending.push({ kind: 'property', source: node as Record<string, unknown>, key })
    }
  }
  return value
}

/** Serializable provider-boundary facts; policy decides whether they are retryable. */
export interface LlmFailure {
  /** Human-readable provider or transport failure. */
  readonly message: string
  /** Stable provider-neutral machine-routing code. */
  readonly code: string
  /** HTTP status observed at the provider boundary, when available. */
  readonly status?: number
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number
  /** Opaque provider-issued request identifier for diagnostics. */
  readonly requestId?: Branded<'ProviderRequestId'>
}

/** Token accounting for one model call (cache fields are optional). */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Why a model response stopped. Merge-extensible so adapters can surface provider-specific reasons. */
export interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: LlmFailure }
  'error': { kind: 'error'; failure: LlmFailure }
}

/** Any known finish reason, derived from {@link FinishReasonMap}; switch on `kind` and fall through unknowns. */
export type FinishReason = FinishReasonMap[keyof FinishReasonMap]

/** Raw streaming protocol emitted by adapters (consumed subset: text-delta + finish). */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }

/** JSON-schema description of a tool, as sent to the model. */
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}

/** A single model request, fully assembled. */
export interface GenerateOptions {
  /** Registered provider route selecting the adapter instance. */
  provider: string
  model: string
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: Branded<'ReasoningEffortId'>
  /** Ordered conversation messages, exactly as the provider sees them. */
  messages: Message[]
  /** System prompt text (adapters map to the provider's system slot). */
  system?: string
  /** Tool schemas (adapters map to the provider's `tools` field). */
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  /** Session identity stamped by the loop for listener routing. */
  sessionId?: Branded<'SessionId'>
  /** Provider-neutral classification for an auxiliary model call; ordinary requests leave it unset. */
  purpose?: 'compaction' | 'session-title'
}

/** Canonical provider-neutral code for an exhausted account quota or balance. */
export const QUOTA_EXCEEDED_CODE = 'QUOTA'

/** Canonical provider-neutral code for a credential that was supplied but cannot be used. */
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'

/**
 * Recognize provider wording that identifies an exhausted account quota rather
 * than a transient request-rate limit (mirror of the dsh-private classifier).
 */
export function isQuotaExceededError(detail: string): boolean {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
}

/** Display metadata for one registered provider route. */
export interface LlmProviderInfo {
  /** Provider route key used by {@link GenerateOptions.provider}. */
  id: string
  /** Human-readable provider name for selectors and diagnostics. */
  name: string
}

/** One adapter-discovered model; catalog membership is advisory. */
export interface LlmModelInfo {
  /** Provider route that owns this model entry. */
  provider: string
  /** Model id passed to {@link GenerateOptions.model}. */
  id: string
  /** Human-readable model name for selectors. */
  name: string
  /** Optional user-facing distinction from otherwise similar models. */
  description?: string
}

/** Exact-route model metadata resolved by its owning adapter. */
export interface LlmResolvedModelInfo extends LlmModelInfo {
  /** Provider-owned context capacity when known. */
  context?: { contextWindow: number }
  /** Adapter-configured per-request output cap materialized when callers omit one. */
  defaultMaxTokens?: number
}

/**
 * Provider-wire adapter for the harness message and stream vocabulary. The
 * default `providerInfo` / `resolveModel` metadata suffices for the consumed
 * surface (id/name = provider/model); only `stream` is required.
 */
export abstract class LlmAdapter {
  /** Describe one provider route owned by this adapter. */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /** Return the provider-owned retry policy captured with this route. */
  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  /** List models this adapter can currently advertise for one owned provider. */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return []
  }

  /** Resolve all metadata available for one exact model. */
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  /** Stream one model call as raw chunks. The only required method. */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

declare module 'cordis' {
  interface Context {
    llm: LlmService
  }
}

/**
 * The abstract `llm` service: an adapter registry plus a streaming model-call
 * surface. Minimal stand-in — registration + provider dispatch; topology
 * events and the `llm/stream` waterfall are outside the consumed surface.
 */
export class LlmService extends Service {
  private readonly adapters = new Map<string, LlmAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /**
   * Register an adapter for the given provider routes. Throws on a duplicate
   * provider (all-or-nothing); returns the disposer.
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): () => void {
    for (const provider of providers) {
      if (this.adapters.has(provider)) {
        throw new Error(`LlmService stub: duplicate adapter for provider "${provider}"`)
      }
      this.adapters.set(provider, adapter)
    }
    return () => {
      for (const provider of providers) this.adapters.delete(provider)
    }
  }

  /** Describe provider routes with a registered adapter, in registration order. */
  listProviders(): LlmProviderInfo[] {
    return [...this.adapters.keys()].map((provider) => ({ id: provider, name: provider }))
  }

  /**
   * Stream one model call as raw chunks: resolve the adapter owning
   * `options.provider` and forward the stream. An unresolvable route yields a
   * terminal `NO_ADAPTER` error finish (the real service normalizes adapter
   * failures to terminal finish chunks the same way).
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const adapter = this.adapters.get(options.provider)
    if (adapter === undefined) {
      const failure: LlmFailure = {
        message: `no adapter registered for provider "${options.provider}"`,
        code: 'NO_ADAPTER',
      }
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure } }
      })()
    }
    return adapter.stream(options)
  }
}

export default LlmService
