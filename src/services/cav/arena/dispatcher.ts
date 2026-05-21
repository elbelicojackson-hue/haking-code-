/**
 * Arena dispatcher — 自动检测 Anthropic / OpenAI 协议并调用。
 */
import type { ArenaProvider } from './providers.js'

type DispatchOpts = {
  system: string
  user: string
  temperature?: number
  maxTokens?: number
}

type DispatchResult =
  | { kind: 'ok'; text: string }
  | { kind: 'error'; error: string }

/**
 * 判断 provider 使用哪种协议：
 * - 包含 deepseek.com/anthropic → Anthropic
 * - 其他（openai, yunwu, dashscope, volces, xiaomimimo）→ OpenAI
 */
function isAnthropicProtocol(baseUrl: string): boolean {
  return baseUrl.includes('/anthropic') || baseUrl.includes('api.anthropic.com')
}

async function callAnthropic(
  provider: ArenaProvider,
  opts: DispatchOpts,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  try {
    const res = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': provider.apiKey,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.7,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      }),
      signal,
    })
    if (!res.ok) {
      return { kind: 'error', error: `${res.status}: ${await res.text()}` }
    }
    const json = await res.json() as any
    const text = json.content
      ?.filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('') ?? ''
    return { kind: 'ok', text }
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

async function callOpenAI(
  provider: ArenaProvider,
  opts: DispatchOpts,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  // 拼接 endpoint：baseUrl 可能已经带 /v1 也可能不带
  const base = provider.baseUrl.replace(/\/+$/, '')
  const endpoint = base.endsWith('/v1')
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.7,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }),
      signal,
    })
    if (!res.ok) {
      return { kind: 'error', error: `${res.status}: ${await res.text()}` }
    }
    const json = await res.json() as any
    const text = json.choices?.[0]?.message?.content ?? ''
    return { kind: 'ok', text }
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function dispatchArena(
  providers: readonly ArenaProvider[],
  opts: DispatchOpts,
  signal?: AbortSignal,
): Promise<DispatchResult[]> {
  return Promise.all(
    providers.map(provider =>
      isAnthropicProtocol(provider.baseUrl)
        ? callAnthropic(provider, opts, signal)
        : callOpenAI(provider, opts, signal),
    ),
  )
}
