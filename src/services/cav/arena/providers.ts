/**
 * Arena provider adapter — reads from ~/.haking/config.json
 */
import { getReconProviders, type ProviderEntry } from '../../utils/hakingConfig.js'

export type ArenaProvider = {
  readonly id: string
  readonly model: string
  readonly apiKey: string
  readonly baseUrl: string
}

export function loadArenaProviders(): ArenaProvider[] {
  return getReconProviders()
}
