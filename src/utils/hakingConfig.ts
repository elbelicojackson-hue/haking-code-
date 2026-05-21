/**
 * Haking Code 配置管理
 * 持久化存储到 ~/.haking/config.json，启动时自动加载到 process.env
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const HAKING_DIR = join(homedir(), '.haking')
const CONFIG_PATH = join(HAKING_DIR, 'config.json')

export type ProviderEntry = {
  id: string
  apiKey: string
  baseUrl: string
  model: string
}

export type HakingConfig = {
  /** 主 API（用于聊天） */
  apiKey?: string
  baseUrl?: string
  model?: string
  fastModel?: string
  /** Recon/PEV 多 agent providers */
  providers?: ProviderEntry[]
}

export function loadHakingConfig(): HakingConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {}
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

export function saveHakingConfig(config: HakingConfig): void {
  if (!existsSync(HAKING_DIR)) {
    mkdirSync(HAKING_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}

/**
 * 启动时调用：将持久化配置注入 process.env（不覆盖已有值）
 */
export function applyHakingConfig(): void {
  const config = loadHakingConfig()
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
}

/**
 * 获取 Recon 用的多 provider 列表。
 * 优先用 config.providers，否则从主 API key 生成 2 个虚拟 agent。
 */
export function getReconProviders(): ProviderEntry[] {
  const config = loadHakingConfig()

  // 用户显式配置了多 provider
  if (config.providers && config.providers.length > 0) {
    return config.providers
  }

  // Fallback：用主 key 生成 2 个虚拟 agent
  const apiKey = process.env.ANTHROPIC_API_KEY ?? config.apiKey ?? ''
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? config.baseUrl ?? 'https://api.deepseek.com/anthropic'
  if (!apiKey) return []

  return [
    { id: 'analyst-alpha', apiKey, baseUrl, model: process.env.ANTHROPIC_MODEL ?? config.model ?? 'deepseek-v4-pro' },
    { id: 'analyst-beta', apiKey, baseUrl, model: process.env.ANTHROPIC_SMALL_FAST_MODEL ?? config.fastModel ?? 'deepseek-v4-flash' },
  ]
}

export function isConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY || !!loadHakingConfig().apiKey
}
