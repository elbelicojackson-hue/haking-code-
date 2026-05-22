/**
 * CVE Data Source Service — mandatory citation framework.
 *
 * Three-tier data source with automatic fallback:
 *   1. NVD API (NIST) — authoritative, structured JSON
 *   2. CISA KEV — Known Exploited Vulnerabilities catalog
 *   3. Firecrawl web search — fallback for latest/unpublished CVEs
 *
 * Design:
 *   - Every CVE mention in AI responses MUST be backed by a citation
 *   - Citations include source URL, severity, and description
 *   - Integrated into the forcedVerification pipeline
 */

import { firecrawlSearch } from './firecrawl.js'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type CveSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'

export type CveCitation = {
  readonly id: string
  readonly source: 'NVD' | 'CISA_KEV' | 'Firecrawl'
  readonly url: string
  readonly description: string
  readonly severity: CveSeverity
  readonly cvss?: number
  readonly datePublished?: string
  readonly exploitedInWild?: boolean
}

export type CveQueryResult = {
  readonly found: boolean
  readonly citations: readonly CveCitation[]
  readonly errors: readonly string[]
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const NVD_API_BASE = 'https://services.nvd.nist.gov/rest/json/cves/2.0'
const CISA_KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'

/** CVE-ID pattern: CVE-YYYY-NNNNN+ */
export const CVE_PATTERN = /CVE-\d{4}-\d{4,}/gi

/* -------------------------------------------------------------------------- */
/* NVD API (Tier 1)                                                           */
/* -------------------------------------------------------------------------- */

async function queryNVD(cveId: string): Promise<CveCitation | null> {
  const apiKey = process.env.NVD_API_KEY ?? ''
  const headers: Record<string, string> = { 'Accept': 'application/json' }
  if (apiKey) headers['apiKey'] = apiKey

  try {
    const res = await fetch(`${NVD_API_BASE}?cveId=${cveId}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null

    const json = await res.json() as any
    const vuln = json?.vulnerabilities?.[0]?.cve
    if (!vuln) return null

    const metrics = vuln.metrics?.cvssMetricV31?.[0] ?? vuln.metrics?.cvssMetricV2?.[0]
    const cvss = metrics?.cvssData?.baseScore
    const severity = mapSeverity(cvss)
    const desc = vuln.descriptions?.find((d: any) => d.lang === 'en')?.value ?? ''

    return {
      id: cveId,
      source: 'NVD',
      url: `https://nvd.nist.gov/vuln/detail/${cveId}`,
      description: desc.slice(0, 300),
      severity,
      cvss,
      datePublished: vuln.published?.slice(0, 10),
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* CISA KEV (Tier 2)                                                          */
/* -------------------------------------------------------------------------- */

let kevCache: Map<string, any> | null = null
let kevCacheTime = 0
const KEV_CACHE_TTL = 3600_000 // 1 hour

async function queryCISA_KEV(cveId: string): Promise<CveCitation | null> {
  try {
    if (!kevCache || Date.now() - kevCacheTime > KEV_CACHE_TTL) {
      const res = await fetch(CISA_KEV_URL, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return null
      const json = await res.json() as any
      kevCache = new Map()
      for (const v of json.vulnerabilities ?? []) {
        kevCache.set(v.cveID, v)
      }
      kevCacheTime = Date.now()
    }

    const entry = kevCache.get(cveId)
    if (!entry) return null

    return {
      id: cveId,
      source: 'CISA_KEV',
      url: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog`,
      description: (entry.shortDescription ?? entry.vulnerabilityName ?? '').slice(0, 300),
      severity: 'HIGH', // KEV = actively exploited = at least HIGH
      exploitedInWild: true,
      datePublished: entry.dateAdded,
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Firecrawl Fallback (Tier 3)                                                */
/* -------------------------------------------------------------------------- */

async function queryFirecrawl(cveId: string): Promise<CveCitation | null> {
  const results = await firecrawlSearch(`${cveId} vulnerability details`, 3)
  const valid = results.filter(r => !r.startsWith('[Firecrawl'))
  if (valid.length === 0) return null

  return {
    id: cveId,
    source: 'Firecrawl',
    url: `https://www.google.com/search?q=${cveId}`,
    description: valid[0]!.slice(0, 300),
    severity: 'UNKNOWN',
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Query a single CVE across all tiers. Returns the best available citation.
 */
export async function queryCVE(cveId: string): Promise<CveCitation | null> {
  // Tier 1: NVD
  const nvd = await queryNVD(cveId)
  if (nvd) return nvd

  // Tier 2: CISA KEV
  const kev = await queryCISA_KEV(cveId)
  if (kev) return kev

  // Tier 3: Firecrawl
  return queryFirecrawl(cveId)
}

/**
 * Extract all CVE-IDs from text and query each. Returns citations for all found.
 */
export async function extractAndQueryCVEs(text: string): Promise<CveQueryResult> {
  const ids = [...new Set(text.match(CVE_PATTERN) ?? [])]
  if (ids.length === 0) return { found: false, citations: [], errors: [] }

  const results = await Promise.allSettled(ids.map(id => queryCVE(id.toUpperCase())))

  const citations: CveCitation[] = []
  const errors: string[] = []

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    if (r.status === 'fulfilled' && r.value) {
      citations.push(r.value)
    } else if (r.status === 'rejected') {
      errors.push(`${ids[i]}: ${r.reason}`)
    }
  }

  return { found: citations.length > 0, citations, errors }
}

/**
 * Format citations into a block suitable for system message injection.
 */
export function formatCveCitations(citations: readonly CveCitation[]): string {
  if (citations.length === 0) return ''

  const lines = citations.map(c => {
    const parts = [
      `${c.id} [${c.severity}${c.cvss ? ` CVSS:${c.cvss}` : ''}]`,
      c.description,
      `Source: ${c.source} — ${c.url}`,
      c.exploitedInWild ? '⚠️ ACTIVELY EXPLOITED IN WILD (CISA KEV)' : '',
    ].filter(Boolean)
    return parts.join('\n  ')
  })

  return [
    '[CVE-CITATION — Authoritative data sources]',
    ...lines.map((l, i) => `[${i + 1}] ${l}`),
    '[/CVE-CITATION]',
  ].join('\n')
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function mapSeverity(cvss: number | undefined): CveSeverity {
  if (cvss == null) return 'UNKNOWN'
  if (cvss >= 9.0) return 'CRITICAL'
  if (cvss >= 7.0) return 'HIGH'
  if (cvss >= 4.0) return 'MEDIUM'
  return 'LOW'
}
