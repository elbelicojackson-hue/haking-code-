/**
 * DeepSeek direct route — completely bypasses Anthropic SDK and Zod.
 * Raw fetch → parse → yield StreamEvent/AssistantMessage.
 */
import type { Message, StreamEvent, AssistantMessage, SystemAPIErrorMessage } from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import { addToTotalSessionCost } from '../../cost-tracker.js'

type SystemPrompt = string | Array<{ type: string; text: string; [k: string]: any }>
type Options = { model: string; [k: string]: any }

export function useDirectRoute(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || ''
  return baseUrl.includes('deepseek.com') || !!process.env.ANTHROPIC_DISABLE_STREAMING
}

export async function* queryModelDeepSeekDirect(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic'
  const apiKey = process.env.ANTHROPIC_API_KEY || ''
  const model = process.env.ANTHROPIC_MODEL || options.model || 'deepseek-v4-pro'

  // Convert messages to Anthropic format
  const apiMessages = messages
    .filter(m => m.type === 'user' || m.type === 'assistant')
    .map(m => {
      if (m.type === 'user') {
        const content = 'content' in m ? m.content : (m as any).message?.content
        if (typeof content === 'string') return { role: 'user' as const, content }
        if (Array.isArray(content)) return { role: 'user' as const, content }
        // Fallback: extract text from user message
        const text = (m as any).message?.text || (m as any).text || ''
        return { role: 'user' as const, content: text }
      }
      // assistant
      const content = (m as any).content || (m as any).message?.content || ''
      return { role: 'assistant' as const, content }
    })

  // Build system prompt string
  const sysStr = typeof systemPrompt === 'string'
    ? systemPrompt
    : Array.isArray(systemPrompt)
      ? systemPrompt.map(s => s.text || '').join('\n')
      : ''

  // Build tool definitions (simplified)
  const toolDefs = tools.length > 0
    ? (await Promise.all(tools.filter(Boolean).slice(0, 20).map(async t => {
        try {
          const desc = typeof t.description === 'function' ? await t.description() : (t.description || '')
          return { name: t.name, description: String(desc || t.name), input_schema: { type: 'object' as const, properties: {} } }
        } catch { return null }
      }))).filter(Boolean)
    : undefined

  const body: any = {
    model,
    max_tokens: 8192,
    messages: apiMessages,
  }
  if (sysStr) body.system = sysStr
  if (toolDefs) body.tools = toolDefs

  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!res.ok) {
      const errText = await res.text()
      yield {
        type: 'system',
        message: { type: 'api_error', error: `${res.status}: ${errText}` },
      } as any as SystemAPIErrorMessage
      return
    }

    const json = await res.json() as any

    // Push usage into the global cost-tracker state so UI panels (e.g.
    // ModelStatsPanel below the input box) can render accumulating token
    // counts. Pass cost=0 because src/utils/modelCost.ts still uses Claude
    // USD tiers for `deepseek-v4-*` (wrong by a factor of ~5×); the panel
    // computes CNY from raw token counts independently and we don't want
    // to pollute STATE.totalCostUSD with garbage.
    if (json && json.usage) {
      try {
        addToTotalSessionCost(0, json.usage, json.model || model)
      } catch {
        // Cost tracking is best-effort — never fail the response on it.
      }
    }

    // Extract text content
    const textBlocks = (json.content || []).filter((b: any) => b.type === 'text')
    const thinkingBlocks = (json.content || []).filter((b: any) => b.type === 'thinking')
    const toolUseBlocks = (json.content || []).filter((b: any) => b.type === 'tool_use')

    // Yield thinking as stream events
    for (const block of thinkingBlocks) {
      yield {
        type: 'stream',
        event: 'thinking',
        data: block.thinking || '',
      } as any as StreamEvent
    }

    // Yield text as stream events
    const fullText = textBlocks.map((b: any) => b.text).join('')
    if (fullText) {
      yield {
        type: 'stream',
        event: 'text',
        data: fullText,
      } as any as StreamEvent
    }

    // Build and yield the final AssistantMessage
    const msgId = json.id || 'msg_' + Date.now()
    const assistantMessage: AssistantMessage = {
      type: 'assistant',
      uuid: msgId,
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: json.model || model,
        content: json.content || [{ type: 'text', text: fullText }],
        stop_reason: json.stop_reason || 'end_turn',
        stop_sequence: null,
        usage: json.usage || { input_tokens: 0, output_tokens: 0 },
      },
      costUSD: 0,
      durationMs: 0,
      requestId: msgId,
    } as any

    yield assistantMessage
  } catch (err) {
    if (signal.aborted) return
    yield {
      type: 'system',
      message: { type: 'api_error', error: err instanceof Error ? err.message : String(err) },
    } as any as SystemAPIErrorMessage
  }
}
