/**
 * DeepSeek direct route — bypasses @anthropic-ai/sdk entirely (Zod v4 schema
 * validation + private response fields like `_idmap` blow up against
 * DeepSeek's compat layer).
 *
 * v1.1 rewrite (针对 DeepSeek 全面优化):
 *   - SSE streaming (stream:true) emitting Anthropic-format events
 *     (message_start / content_block_* / message_delta / message_stop) so the
 *     existing partial-message rendering pipeline shows tokens incrementally
 *   - Real tool input_schema (zodToJsonSchema or tool.inputJSONSchema) — no
 *     more empty `{type:'object', properties:{}}` stubs that left DeepSeek
 *     guessing every argument
 *   - All tools are sent (no silent slice(0, 20))
 *   - max_tokens from getModelMaxOutputTokens / env override (default 64K
 *     for DeepSeek V4 instead of the old hardcoded 8K)
 *   - temperature pass-through
 *   - thinking mode toggle (DeepSeek V4 supports `thinking: {type:'enabled', ...}`
 *     via the Anthropic-compat endpoint)
 *   - cache_control: ephemeral markers on system blocks, last user message,
 *     and tool list tail — cuts repeated-input cost ~50× on cache hit
 *   - Exponential-backoff retry on 429 / 5xx / network errors
 *   - Structured error reporting (parses {error:{type,message}} bodies)
 *   - tool_use blocks are emitted (previous code parsed but never yielded
 *     them — Agent tool calls were silently broken on the direct path)
 *   - Pushes usage into addToTotalSessionCost so /cost, StatusLine and
 *     ModelStatsPanel see live token counts
 */
import type { Message, StreamEvent, AssistantMessage, SystemAPIErrorMessage } from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import type { SystemPrompt } from '@ant/model-provider'
import { addToTotalSessionCost } from '../../cost-tracker.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { getModelMaxOutputTokens } from '../../utils/context.js'

type Options = { model?: string; temperature?: number; [k: string]: any }

const RETRY_BASE_MS = 800
const MAX_RETRIES = 3
const DEEPSEEK_DEFAULT_MAX_TOKENS = 64_000

class DeepSeekApiError extends Error {
  constructor(
    public status: number,
    public errorType: string,
    msg: string,
  ) {
    super(msg)
    this.name = 'DeepSeekApiError'
  }
}

export function useDirectRoute(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || ''
  return baseUrl.includes('deepseek.com') || !!process.env.ANTHROPIC_DISABLE_STREAMING
}

function isRetryable(err: unknown): boolean {
  if (err instanceof DeepSeekApiError) {
    return err.status === 429 || err.status >= 500
  }
  if (err instanceof Error) {
    // Network errors typically surface as TypeError (fetch) or AbortError (we DO NOT retry abort)
    if (err.name === 'AbortError') return false
    if (err.name === 'TypeError') return true
    return /ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(err.message)
  }
  return false
}

function classifyErrorMessage(err: unknown): string {
  if (err instanceof DeepSeekApiError) {
    if (err.status === 401) {
      return `Authentication failed (401 ${err.errorType}). Run /setup to update your API key.`
    }
    if (err.status === 429) {
      return `Rate limited (429 ${err.errorType}): ${err.message}. The client retried ${MAX_RETRIES}× with backoff.`
    }
    if (err.status === 400) {
      return `Bad request (400 ${err.errorType}): ${err.message}`
    }
    if (err.status >= 500) {
      return `DeepSeek server error (${err.status} ${err.errorType}): ${err.message}. Retried ${MAX_RETRIES}×.`
    }
    return `${err.status} ${err.errorType}: ${err.message}`
  }
  if (err instanceof Error) return err.message
  return String(err)
}

async function buildToolDefs(
  tools: Tools,
  options: Options,
): Promise<Array<Record<string, unknown>> | undefined> {
  if (!tools || tools.length === 0) return undefined

  // Lightweight fallback for Tool.prompt() — most tool prompts only consult
  // tool name/agents to render their description, so a minimal stub is fine
  // when options.getToolPermissionContext is missing (e.g. ad-hoc callers).
  const stubCtx = async () => ({}) as any

  const defs: Array<Record<string, unknown>> = []
  for (const t of tools) {
    if (!t) continue
    let description: string
    try {
      description = await t.prompt({
        getToolPermissionContext:
          (options as any).getToolPermissionContext ?? stubCtx,
        tools,
        agents: (options as any).agents ?? [],
        allowedAgentTypes: (options as any).allowedAgentTypes,
      })
    } catch {
      // If prompt() throws (e.g. requires a context this tool can't get
      // from a stub), fall back to the tool name. Better than dropping the
      // tool entirely.
      description = t.name
    }

    let input_schema: Record<string, unknown>
    try {
      const inj = (t as any).inputJSONSchema as
        | Record<string, unknown>
        | undefined
      if (inj && typeof inj === 'object') {
        input_schema = inj
      } else {
        input_schema = zodToJsonSchema((t as any).inputSchema) as Record<
          string,
          unknown
        >
      }
    } catch {
      input_schema = { type: 'object', properties: {} }
    }

    defs.push({
      name: t.name,
      description: String(description || t.name),
      input_schema,
    })
  }

  // Cache the entire (large) tool list — it changes only when the tool
  // registry mutates, which is rare within a session.
  if (defs.length > 0) {
    ;(defs[defs.length - 1] as any).cache_control = { type: 'ephemeral' }
  }
  return defs
}

function buildSystemBlocks(
  systemPrompt: SystemPrompt | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!systemPrompt) return undefined
  // SystemPrompt is a branded readonly string[] — each entry is a separate
  // logical block (instructions, tool list preamble, etc.). Build a
  // text-block array and tag the last block with cache_control so the
  // entire system prompt becomes cacheable across turns.
  const arr = systemPrompt as readonly string[]
  if (arr.length === 0) return undefined
  return arr
    .filter(s => typeof s === 'string' && s.length > 0)
    .map((text, i, kept) => ({
      type: 'text',
      text,
      ...(i === kept.length - 1
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
    }))
}

function extractMessageContent(m: any): unknown {
  if (m == null) return ''
  if ('content' in m && m.content !== undefined) return m.content
  if (m.message?.content !== undefined) return m.message.content
  if (m.message?.text !== undefined) return m.message.text
  return ''
}

// Block types DeepSeek's /anthropic endpoint doesn't understand
const UNSUPPORTED_BLOCK_TYPES = new Set([
  'advisor_tool_result', 'server_tool_use', 'mcp_tool_use',
  'server_tool_result', 'mcp_tool_result', 'redacted_thinking',
])

function sanitizeBlocks(content: unknown[]): unknown[] {
  return content
    .filter(b => {
      if (typeof b === 'string') return true
      const type = (b as any)?.type
      return !UNSUPPORTED_BLOCK_TYPES.has(type)
    })
    .map(b => {
      if (typeof b !== 'object' || b == null) return b
      // Strip 'citations' field — DeepSeek rejects unknown fields on blocks
      const { citations, ...rest } = b as Record<string, unknown>
      return rest
    })
}

function buildApiMessages(messages: Message[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if ((m as any).type !== 'user' && (m as any).type !== 'assistant') continue
    const role = (m as any).type as 'user' | 'assistant'
    const content = extractMessageContent(m)
    if (typeof content === 'string') {
      out.push({ role, content })
    } else if (Array.isArray(content)) {
      out.push({ role, content: sanitizeBlocks(content) })
    } else if (content && typeof content === 'object') {
      out.push({ role, content: sanitizeBlocks([content]) })
    } else {
      out.push({ role, content: '' })
    }
  }

  // Mark the LAST user message's last text/tool_result block with
  // cache_control so the conversation prefix becomes cacheable across turns.
  // Only mutate user messages (assistant ones can have signed thinking
  // blocks that shouldn't be touched).
  // IMPORTANT: only add cache_control to 'text' blocks. DeepSeek's
  // /anthropic endpoint rejects cache_control on tool_result blocks.
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i] as any
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') {
      m.content = [
        {
          type: 'text',
          text: m.content,
          cache_control: { type: 'ephemeral' },
        },
      ]
    } else if (Array.isArray(m.content) && m.content.length > 0) {
      // Find the last text block (skip tool_result blocks)
      for (let j = m.content.length - 1; j >= 0; j--) {
        const block = m.content[j]
        if (block && typeof block === 'object' && block.type === 'text') {
          ;(block as any).cache_control = { type: 'ephemeral' }
          break
        }
      }
    }
    break
  }
  return out
}

function computeMaxTokens(model: string, options: Options): number {
  const envOverride = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  if (envOverride) {
    const n = parseInt(envOverride, 10)
    if (!isNaN(n) && n > 0) return n
  }
  if ((options as any).maxOutputTokensOverride) {
    return (options as any).maxOutputTokensOverride as number
  }
  if (model.toLowerCase().includes('deepseek')) {
    return DEEPSEEK_DEFAULT_MAX_TOKENS
  }
  try {
    return getModelMaxOutputTokens(model).default
  } catch {
    return DEEPSEEK_DEFAULT_MAX_TOKENS
  }
}

function buildThinkingPayload(
  thinkingConfig: ThinkingConfig | undefined,
): Record<string, unknown> | undefined {
  if (!thinkingConfig) return undefined
  // ThinkingConfig shape from src/utils/thinking.ts: { type: 'enabled' | 'disabled', budget_tokens?: number }
  // DeepSeek's anthropic-compat endpoint accepts the same shape.
  if ((thinkingConfig as any).type !== 'enabled') return undefined
  const budget = (thinkingConfig as any).budget_tokens
  return {
    type: 'enabled',
    budget_tokens: typeof budget === 'number' && budget > 0 ? budget : 8000,
  }
}

export async function* queryModelDeepSeekDirect(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig | undefined,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const baseUrl =
    process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic'
  const apiKey = process.env.ANTHROPIC_API_KEY || ''
  const model =
    options.model || process.env.ANTHROPIC_MODEL || 'deepseek-v4-pro'
  const stream = !process.env.ANTHROPIC_DISABLE_STREAMING

  let toolDefs: Array<Record<string, unknown>> | undefined
  try {
    toolDefs = await buildToolDefs(tools, options)
  } catch {
    // If tool serialization throws entirely, continue without tools rather
    // than aborting the request.
    toolDefs = undefined
  }

  const apiMessages = buildApiMessages(messages)
  const apiSystem = buildSystemBlocks(systemPrompt)
  const max_tokens = computeMaxTokens(model, options)
  const thinking = buildThinkingPayload(thinkingConfig)
  const temperature =
    typeof options.temperature === 'number' ? options.temperature : undefined

  const body: Record<string, unknown> = {
    model,
    max_tokens,
    messages: apiMessages,
    stream,
  }
  if (apiSystem) body.system = apiSystem
  if (toolDefs) body.tools = toolDefs
  if (thinking) body.thinking = thinking
  if (temperature !== undefined) body.temperature = temperature

  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) return
    try {
      yield* doRequest(body, baseUrl, apiKey, signal, model, stream)
      return
    } catch (err) {
      lastErr = err
      if (signal.aborted) return
      if (attempt < MAX_RETRIES && isRetryable(err)) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      break
    }
  }

  yield {
    type: 'system',
    message: {
      type: 'api_error',
      error: classifyErrorMessage(lastErr),
    },
  } as any as SystemAPIErrorMessage
}

async function* doRequest(
  body: Record<string, unknown>,
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal,
  model: string,
  stream: boolean,
): AsyncGenerator<StreamEvent | AssistantMessage, void> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      accept: stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const errText = await res.text()
    let errorType = 'api_error'
    let errorMsg = errText
    try {
      const errJson = JSON.parse(errText)
      errorType = errJson.error?.type || errJson.type || 'api_error'
      errorMsg = errJson.error?.message || errJson.message || errText
    } catch {
      // Body wasn't JSON — leave raw text.
    }
    throw new DeepSeekApiError(res.status, errorType, errorMsg)
  }

  if (stream && res.body) {
    yield* streamSSE(res.body, model)
  } else {
    const json = (await res.json()) as any
    yield* synthesizeFromNonStream(json, model)
  }
}

type BlockKind = 'text' | 'thinking' | 'tool_use'
type BlockState = {
  kind: BlockKind
  text: string
  thinking: string
  toolId: string
  toolName: string
  toolJsonAcc: string
}

async function* streamSSE(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
): AsyncGenerator<StreamEvent | AssistantMessage, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  let finalUsage: any = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
  let finalStopReason: string | null = null
  let messageId = ''
  let messageModel = fallbackModel
  const contentBlocks: any[] = []
  const blockStates: { [index: number]: BlockState } = {}

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE framing: events are separated by a blank line (\n\n).
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)

      let dataLine: string | null = null
      for (const line of rawEvent.split('\n')) {
        // RFC: "data: " (one space) or "data:" (no space)
        if (line.startsWith('data: ')) {
          dataLine = line.slice(6)
          break
        } else if (line.startsWith('data:')) {
          dataLine = line.slice(5)
          break
        }
      }
      if (dataLine === null) continue
      if (dataLine === '[DONE]') continue

      let evt: any
      try {
        evt = JSON.parse(dataLine)
      } catch {
        continue
      }

      // Forward the raw event; downstream pipeline (claude.ts SDK path)
      // is keyed on these Anthropic SSE event types.
      yield evt as StreamEvent

      // Accumulate state for the final AssistantMessage.
      switch (evt.type) {
        case 'message_start':
          messageId = evt.message?.id || messageId
          messageModel = evt.message?.model || messageModel
          if (evt.message?.usage) {
            mergeUsage(finalUsage, evt.message.usage)
          }
          break
        case 'content_block_start': {
          const idx = evt.index as number
          const cb = evt.content_block || {}
          if (cb.type === 'text') {
            blockStates[idx] = newBlock('text')
          } else if (cb.type === 'thinking') {
            blockStates[idx] = newBlock('thinking')
          } else if (cb.type === 'tool_use') {
            const s = newBlock('tool_use')
            s.toolId = cb.id || ''
            s.toolName = cb.name || ''
            blockStates[idx] = s
          }
          break
        }
        case 'content_block_delta': {
          const idx = evt.index as number
          const s = blockStates[idx]
          if (!s) break
          const d = evt.delta || {}
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            s.text += d.text
          } else if (
            d.type === 'thinking_delta' &&
            typeof d.thinking === 'string'
          ) {
            s.thinking += d.thinking
          } else if (
            d.type === 'input_json_delta' &&
            typeof d.partial_json === 'string'
          ) {
            s.toolJsonAcc += d.partial_json
          }
          break
        }
        case 'content_block_stop': {
          const idx = evt.index as number
          const s = blockStates[idx]
          if (!s) break
          if (s.kind === 'text') {
            contentBlocks.push({ type: 'text', text: s.text })
          } else if (s.kind === 'thinking') {
            contentBlocks.push({ type: 'thinking', thinking: s.thinking })
          } else if (s.kind === 'tool_use') {
            let input: any = {}
            try {
              input = s.toolJsonAcc ? JSON.parse(s.toolJsonAcc) : {}
            } catch {
              // Malformed partial JSON — keep empty so downstream tool_use
              // executor surfaces a clean validation error rather than
              // crashing on JSON.parse.
              input = {}
            }
            contentBlocks.push({
              type: 'tool_use',
              id: s.toolId,
              name: s.toolName,
              input,
            })
          }
          delete blockStates[idx]
          break
        }
        case 'message_delta': {
          if (evt.delta?.stop_reason) finalStopReason = evt.delta.stop_reason
          if (evt.usage) mergeUsage(finalUsage, evt.usage)
          break
        }
        case 'message_stop':
          break
        // ping / error / unknown — let them pass through to consumer
      }
    }
  }

  // Push usage into cost-tracker (cost=0; modelCost.ts USD tiers are wrong
  // for DeepSeek so we keep STATE.totalCostUSD untouched. The CNY panel
  // computes from raw token counts independently.)
  try {
    addToTotalSessionCost(0, finalUsage, messageModel)
  } catch {
    // Cost tracking is best-effort.
  }

  // If DeepSeek returned zero content blocks AND zero output tokens, the
  // model effectively refused to answer (context too long, malformed
  // tool_result, or internal error that surfaced as empty response).
  // Yield a visible error instead of a silent empty message.
  if (contentBlocks.length === 0 && (finalUsage.output_tokens ?? 0) === 0) {
    const hint = (finalUsage.input_tokens ?? 0) > 900_000
      ? ' (input tokens near 1M limit — try /compact or start a new session)'
      : ' (possible malformed tool_result or server-side refusal)'
    yield {
      type: 'assistant',
      uuid: messageId || 'msg_' + Date.now(),
      message: {
        id: messageId || 'msg_' + Date.now(),
        type: 'message',
        role: 'assistant',
        model: messageModel,
        content: [{ type: 'text', text: `[DeepSeek returned empty response${hint}]` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: finalUsage,
      },
      costUSD: 0,
      durationMs: 0,
      requestId: messageId || 'msg_' + Date.now(),
    } as any as AssistantMessage
    return
  }

  const msgUuid = messageId || 'msg_' + Date.now()
  yield {
    type: 'assistant',
    uuid: msgUuid,
    message: {
      id: msgUuid,
      type: 'message',
      role: 'assistant',
      model: messageModel,
      content: contentBlocks,
      stop_reason: finalStopReason || 'end_turn',
      stop_sequence: null,
      usage: finalUsage,
    },
    costUSD: 0,
    durationMs: 0,
    requestId: msgUuid,
  } as any as AssistantMessage
}

function newBlock(kind: BlockKind): BlockState {
  return {
    kind,
    text: '',
    thinking: '',
    toolId: '',
    toolName: '',
    toolJsonAcc: '',
  }
}

function mergeUsage(into: any, incoming: any): void {
  if (!incoming) return
  if (typeof incoming.input_tokens === 'number') into.input_tokens = incoming.input_tokens
  if (typeof incoming.output_tokens === 'number') into.output_tokens = incoming.output_tokens
  if (typeof incoming.cache_read_input_tokens === 'number')
    into.cache_read_input_tokens = incoming.cache_read_input_tokens
  if (typeof incoming.cache_creation_input_tokens === 'number')
    into.cache_creation_input_tokens = incoming.cache_creation_input_tokens
}

async function* synthesizeFromNonStream(
  json: any,
  fallbackModel: string,
): AsyncGenerator<StreamEvent | AssistantMessage, void> {
  // For providers / configurations where stream:true was rejected, build
  // SSE-equivalent events from the full JSON so downstream rendering still
  // works the same way (including incremental block_stop for tool_use).
  const id = json?.id || 'msg_' + Date.now()
  const model = json?.model || fallbackModel
  const usage = json?.usage || { input_tokens: 0, output_tokens: 0 }
  const blocks: any[] = Array.isArray(json?.content) ? json.content : []

  yield {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  } as any as StreamEvent

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const startCb =
      b.type === 'text'
        ? { type: 'text', text: '' }
        : b.type === 'thinking'
          ? { type: 'thinking', thinking: '' }
          : b.type === 'tool_use'
            ? { type: 'tool_use', id: b.id, name: b.name, input: {} }
            : { type: b.type }
    yield { type: 'content_block_start', index: i, content_block: startCb } as any as StreamEvent

    if (b.type === 'text' && typeof b.text === 'string') {
      yield {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'text_delta', text: b.text },
      } as any as StreamEvent
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      yield {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'thinking_delta', thinking: b.thinking },
      } as any as StreamEvent
    } else if (b.type === 'tool_use') {
      yield {
        type: 'content_block_delta',
        index: i,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(b.input ?? {}),
        },
      } as any as StreamEvent
    }
    yield { type: 'content_block_stop', index: i } as any as StreamEvent
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: json?.stop_reason || 'end_turn' },
    usage,
  } as any as StreamEvent
  yield { type: 'message_stop' } as any as StreamEvent

  try {
    addToTotalSessionCost(0, usage, model)
  } catch {
    // best-effort
  }

  yield {
    type: 'assistant',
    uuid: id,
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: blocks.length ? blocks : [{ type: 'text', text: '' }],
      stop_reason: json?.stop_reason || 'end_turn',
      stop_sequence: null,
      usage,
    },
    costUSD: 0,
    durationMs: 0,
    requestId: id,
  } as any as AssistantMessage
}
