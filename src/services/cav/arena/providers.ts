/**
 * Arena provider adapter — reads from ~/.haking/config.json
 */
import { getReconProviders, type ProviderEntry } from '../../../utils/hakingConfig.js'

/** Default base URL when an entry is missing one (matches DeepSeek Anthropic-compatible endpoint). */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'

export type ArenaProvider = {
  readonly id: string
  /** Human-readable label shown in PEV/arena UIs. Defaults to `id` when not configured. */
  readonly displayName: string
  readonly model: string
  readonly apiKey: string
  readonly baseUrl: string
  /** Optional metadata reserved for future scheduling — not consumed by the dispatcher today. */
  readonly role?: string
  readonly wireFormat?: 'openai' | 'anthropic'
}

/** Normalise a raw {@link ProviderEntry} into a fully-populated {@link ArenaProvider}. */
function fromEntry(entry: ProviderEntry): ArenaProvider {
  return {
    id: entry.id,
    displayName: entry.displayName ?? entry.id,
    model: entry.model,
    apiKey: entry.apiKey,
    baseUrl: entry.baseUrl ?? DEFAULT_BASE_URL,
  }
}

export function loadArenaProviders(): ArenaProvider[] {
  return getReconProviders().map(fromEntry)
}
