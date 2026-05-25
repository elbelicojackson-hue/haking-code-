/**
 * Haking config reader/writer — manages ~/.haking/config.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

export interface ProviderEntry {
  id: string
  model: string
  apiKey: string
  baseUrl?: string
  /** Optional human-readable name shown in PEV/arena UIs. Defaults to `id`. */
  displayName?: string
}

export interface HakingConfig {
  /** Main API key (used as ANTHROPIC_API_KEY default). */
  apiKey?: string
  /** Main API base URL (used as ANTHROPIC_BASE_URL default). */
  baseUrl?: string
  /** Main model alias (used as ANTHROPIC_MODEL default). */
  model?: string
  /** Fast/small model alias (used as ANTHROPIC_SMALL_FAST_MODEL default). */
  fastModel?: string
  /** Multi-LLM providers used by /recon and /arena. */
  providers: ProviderEntry[]
  defaultProvider?: string
  theme?: string
}

const CONFIG_PATH = join(homedir(), '.haking', 'config.json')

export function loadHakingConfig(): HakingConfig {
  if (!existsSync(CONFIG_PATH)) return { providers: [] }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return { providers: [] }
  }
}

export function saveHakingConfig(config: HakingConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

export function getReconProviders(): ProviderEntry[] {
  return loadHakingConfig().providers
}


export function applyHakingConfig(): void {
  const config = loadHakingConfig()

  // Top-level defaults: only fill if env not already set (env wins).
  if (config.apiKey && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = config.apiKey
  }
  if (config.baseUrl && !process.env.ANTHROPIC_BASE_URL) {
    process.env.ANTHROPIC_BASE_URL = config.baseUrl
  }
  if (config.model && !process.env.ANTHROPIC_MODEL) {
    process.env.ANTHROPIC_MODEL = config.model
  }
  if (config.fastModel && !process.env.ANTHROPIC_SMALL_FAST_MODEL) {
    process.env.ANTHROPIC_SMALL_FAST_MODEL = config.fastModel
  }

  // Default provider override (lower precedence than top-level + env)
  if (config.defaultProvider) {
    const provider = config.providers.find(p => p.id === config.defaultProvider)
    if (provider?.apiKey && !process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = provider.apiKey
    }
    if (provider?.baseUrl && !process.env.ANTHROPIC_BASE_URL) {
      process.env.ANTHROPIC_BASE_URL = provider.baseUrl
    }
  }
}
