/**
 * Reverse Engineering Intelligence Database — mandatory citation framework.
 *
 * Provides authoritative data sources for ALL 8 PEV hypothesis kinds:
 *   - file-class  → Hashlookup (CIRCL)
 *   - packer      → MalwareBazaar + DIE signatures
 *   - compiler    → MalwareBazaar metadata
 *   - family      → MalwareBazaar + ThreatFox
 *   - algorithm   → MITRE ATT&CK (techniques)
 *   - anti-analysis → MITRE ATT&CK (defense evasion)
 *   - capability  → MITRE ATT&CK (tactics)
 *   - protocol    → ThreatFox IOC + URLhaus
 *
 * All APIs are FREE, no key required.
 * This module enforces: "never claim without evidence."
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type REIntelSource =
  | 'MalwareBazaar'
  | 'ThreatFox'
  | 'URLhaus'
  | 'Hashlookup'
  | 'MITRE_ATTACK'
  | 'YARA'

export type RECitation = {
  readonly source: REIntelSource
  readonly url: string
  readonly data: string
  readonly confidence: 'high' | 'medium' | 'low'
}

export type HashType = 'md5' | 'sha1' | 'sha256'

/* -------------------------------------------------------------------------- */
/* MalwareBazaar (abuse.ch) — family, packer, compiler                        */
/* -------------------------------------------------------------------------- */

const MB_API = 'https://mb-api.abuse.ch/api/v1/'

export async function queryMalwareBazaar(
  hash: string,
  hashType: HashType = 'sha256',
): Promise<RECitation | null> {
  try {
    const body = new URLSearchParams({ query: 'get_info', hash })
    const res = await fetch(MB_API, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as any
    if (json.query_status !== 'ok' || !json.data?.[0]) return null

    const d = json.data[0]
    const info = [
      d.file_type && `Type: ${d.file_type}`,
      d.signature && `Family: ${d.signature}`,
      d.tags?.length && `Tags: ${d.tags.join(', ')}`,
      d.delivery_method && `Delivery: ${d.delivery_method}`,
      d.intelligence?.clamav?.length && `ClamAV: ${d.intelligence.clamav[0]}`,
    ]
      .filter(Boolean)
      .join(' | ')

    return {
      source: 'MalwareBazaar',
      url: `https://bazaar.abuse.ch/sample/${d.sha256_hash}/`,
      data: info || `Known malware sample (${hashType}: ${hash})`,
      confidence: 'high',
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* ThreatFox (abuse.ch) — IOC lookup (IPs, domains, hashes)                   */
/* -------------------------------------------------------------------------- */

const TF_API = 'https://threatfox-api.abuse.ch/api/v1/'

export async function queryThreatFox(ioc: string): Promise<RECitation | null> {
  try {
    const body = JSON.stringify({ query: 'search_ioc', search_term: ioc })
    const res = await fetch(TF_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as any
    if (json.query_status !== 'ok' || !json.data?.[0]) return null

    const d = json.data[0]
    const info = [
      d.malware && `Malware: ${d.malware}`,
      d.malware_alias && `Alias: ${d.malware_alias}`,
      d.threat_type && `Threat: ${d.threat_type}`,
      d.confidence_level && `Confidence: ${d.confidence_level}%`,
    ]
      .filter(Boolean)
      .join(' | ')

    return {
      source: 'ThreatFox',
      url: `https://threatfox.abuse.ch/ioc/${d.id}/`,
      data: info,
      confidence: d.confidence_level >= 75 ? 'high' : 'medium',
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* URLhaus (abuse.ch) — malicious URL database                                */
/* -------------------------------------------------------------------------- */

const UH_API = 'https://urlhaus-api.abuse.ch/v1/'

export async function queryURLhaus(url: string): Promise<RECitation | null> {
  try {
    const body = new URLSearchParams({ url })
    const res = await fetch(`${UH_API}url/`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as any
    if (json.query_status !== 'ok') return null

    return {
      source: 'URLhaus',
      url: `https://urlhaus.abuse.ch/url/${json.id}/`,
      data: `Threat: ${json.threat ?? 'malware_download'} | Tags: ${json.tags?.join(', ') ?? 'none'} | Status: ${json.url_status}`,
      confidence: 'high',
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Hashlookup (CIRCL) — known file classification                             */
/* -------------------------------------------------------------------------- */

const HL_API = 'https://hashlookup.circl.lu'

export async function queryHashlookup(hash: string): Promise<RECitation | null> {
  const hashType = hash.length === 32 ? 'md5' : hash.length === 40 ? 'sha1' : 'sha256'
  try {
    const res = await fetch(`${HL_API}/lookup/${hashType}/${hash}`, {
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as any

    const info = [
      json.FileName && `File: ${json.FileName}`,
      json.FileSize && `Size: ${json.FileSize}`,
      json.ProductName && `Product: ${json.ProductName}`,
      json.CompanyName && `Company: ${json.CompanyName}`,
      json.KnownMalicious !== undefined && `Malicious: ${json.KnownMalicious}`,
    ]
      .filter(Boolean)
      .join(' | ')

    return {
      source: 'Hashlookup',
      url: `${HL_API}/lookup/${hashType}/${hash}`,
      data: info || `Known file (${hashType}: ${hash.slice(0, 16)}...)`,
      confidence: json.KnownMalicious ? 'high' : 'medium',
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* MITRE ATT&CK — tactics, techniques, procedures                             */
/* -------------------------------------------------------------------------- */

const ATTACK_API = 'https://raw.githubusercontent.com/mitre/cti/master/enterprise-attack/enterprise-attack.json'

let attackCache: Map<string, any> | null = null
let attackCacheTime = 0
const ATTACK_CACHE_TTL = 86400_000 // 24h

export async function queryMITRE(techniqueId: string): Promise<RECitation | null> {
  try {
    if (!attackCache || Date.now() - attackCacheTime > ATTACK_CACHE_TTL) {
      const res = await fetch(ATTACK_API, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) return null
      const json = (await res.json()) as any
      attackCache = new Map()
      for (const obj of json.objects ?? []) {
        if (obj.external_references?.[0]?.external_id) {
          attackCache.set(obj.external_references[0].external_id, obj)
        }
      }
      attackCacheTime = Date.now()
    }

    const technique = attackCache.get(techniqueId.toUpperCase())
    if (!technique) return null

    return {
      source: 'MITRE_ATTACK',
      url: `https://attack.mitre.org/techniques/${techniqueId.replace('.', '/')}/`,
      data: `${technique.name}: ${(technique.description ?? '').slice(0, 200)}`,
      confidence: 'high',
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Unified Query — auto-detect input type and route to correct source         */
/* -------------------------------------------------------------------------- */

export type REQueryResult = {
  readonly found: boolean
  readonly citations: readonly RECitation[]
}

/** Detect what kind of indicator this is and query appropriate sources. */
export async function queryREIntel(indicator: string): Promise<REQueryResult> {
  const citations: RECitation[] = []

  // SHA-256 / SHA-1 / MD5 hash
  if (/^[a-f0-9]{64}$/i.test(indicator) || /^[a-f0-9]{40}$/i.test(indicator) || /^[a-f0-9]{32}$/i.test(indicator)) {
    const [mb, hl] = await Promise.allSettled([
      queryMalwareBazaar(indicator),
      queryHashlookup(indicator),
    ])
    if (mb.status === 'fulfilled' && mb.value) citations.push(mb.value)
    if (hl.status === 'fulfilled' && hl.value) citations.push(hl.value)
  }

  // MITRE ATT&CK technique ID (T1059, T1059.001)
  if (/^T\d{4}(\.\d{3})?$/i.test(indicator)) {
    const mitre = await queryMITRE(indicator)
    if (mitre) citations.push(mitre)
  }

  // URL
  if (/^https?:\/\//i.test(indicator)) {
    const uh = await queryURLhaus(indicator)
    if (uh) citations.push(uh)
  }

  // IP / domain → ThreatFox
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(indicator) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(indicator)) {
    const tf = await queryThreatFox(indicator)
    if (tf) citations.push(tf)
  }

  return { found: citations.length > 0, citations }
}

/* -------------------------------------------------------------------------- */
/* Format for system message injection                                        */
/* -------------------------------------------------------------------------- */

export function formatRECitations(citations: readonly RECitation[]): string {
  if (citations.length === 0) return ''
  const lines = citations.map(
    (c, i) => `[${i + 1}] [${c.source}] (${c.confidence}) ${c.data}\n    → ${c.url}`,
  )
  return [
    '[RE-INTEL — Reverse Engineering Intelligence]',
    ...lines,
    '[/RE-INTEL]',
  ].join('\n')
}

/* -------------------------------------------------------------------------- */
/* Pattern detection in text — extract hashes, IPs, MITRE IDs, URLs           */
/* -------------------------------------------------------------------------- */

export const RE_INDICATORS = {
  sha256: /\b[a-f0-9]{64}\b/gi,
  sha1: /\b[a-f0-9]{40}\b/gi,
  md5: /\b[a-f0-9]{32}\b/gi,
  mitre: /\bT\d{4}(?:\.\d{3})?\b/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  domain: /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|net|org|io|ru|cn|xyz|top|cc|tk|ml)\b/gi,
} as const

/** Extract all RE-relevant indicators from text. */
export function extractIndicators(text: string): string[] {
  const indicators = new Set<string>()
  for (const [, pattern] of Object.entries(RE_INDICATORS)) {
    for (const match of text.matchAll(pattern)) {
      indicators.add(match[0])
    }
  }
  return [...indicators].slice(0, 10) // cap at 10 to avoid API abuse
}
