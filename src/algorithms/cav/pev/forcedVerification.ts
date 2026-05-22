/**
 * Forced Verification Module — PEV-driven mandatory fact-checking.
 *
 * Pure algorithm: scans AI response text for uncertainty signals, computes
 * an uncertainty score, and when the score exceeds a threshold, forces a
 * Firecrawl web search to verify claims against live documentation.
 *
 * Design principles:
 *   - Zero LLM-in-the-loop: detection is regex + lexical scoring only.
 *   - Deterministic: same input text → same score → same trigger decision.
 *   - No false negatives on version-specific claims: any mention of a
 *     version number + technology name forces verification regardless of
 *     hedging score.
 *   - Firecrawl is the single source of truth for live web docs.
 *
 * Integration:
 *   - Called as a post-response hook in the main conversation loop.
 *   - System prompt section injected via getSystemPrompt() to instruct
 *     the model that verification results are authoritative.
 */

import { firecrawlSearch } from '../../../services/firecrawl.js'

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Score threshold [0,1] above which Firecrawl is forced. */
const UNCERTAINTY_THRESHOLD = 0.4

/** Max queries per response to avoid API abuse. */
const MAX_QUERIES_PER_RESPONSE = 3

/** Hedging words/phrases that signal uncertainty. Weighted by strength. */
const HEDGING_SIGNALS: readonly { pattern: RegExp; weight: number }[] = [
  { pattern: /\b(I think|I believe|I'm not sure|I'm unsure)\b/gi, weight: 0.3 },
  { pattern: /\b(probably|possibly|might|may|could be|perhaps)\b/gi, weight: 0.15 },
  { pattern: /\b(if I recall|from memory|IIRC|as far as I know|AFAIK)\b/gi, weight: 0.4 },
  { pattern: /\b(not entirely sure|don't quote me|take this with)\b/gi, weight: 0.5 },
  { pattern: /\b(should work|should be|likely|presumably)\b/gi, weight: 0.1 },
  { pattern: /\b(据我所知|可能|大概|应该是|不太确定|如果没记错)\b/g, weight: 0.35 },
  { pattern: /\b(deprecated|removed in|changed in|breaking change)\b/gi, weight: 0.25 },
]

/** Patterns that indicate a version-specific technical claim. */
const VERSION_CLAIM_PATTERN = /(?:v?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\s*(?:of|in|for|以[来后]|开始|版本)?\s*\b/gi

/** Technology/framework names that warrant verification when combined with uncertainty. */
const TECH_PATTERNS: readonly RegExp[] = [
  /\b(React|Next\.?js|Vue|Angular|Svelte|Solid|Remix|Astro)\s*(?:v?\d+)?/gi,
  /\b(Node\.?js|Deno|Bun|TypeScript|ESLint|Vite|Webpack|Rollup)\s*(?:v?\d+)?/gi,
  /\b(Python|Django|Flask|FastAPI|pip|poetry|uv)\s*(?:v?\d+)?/gi,
  /\b(Rust|Cargo|tokio|axum|Go|gin|fiber)\s*(?:v?\d+)?/gi,
  /\b(Docker|Kubernetes|k8s|Terraform|AWS|GCP|Azure)\b/gi,
  /\b(PostgreSQL|MySQL|MongoDB|Redis|SQLite|Prisma|Drizzle)\s*(?:v?\d+)?/gi,
  /\b(TailwindCSS|Tailwind|shadcn|Radix)\s*(?:v?\d+)?/gi,
  /\b(OpenAI|Anthropic|Claude|GPT-?\d|Gemini|LLaMA|Mistral)\b/gi,
  /\b(API|SDK|CLI|endpoint|参数|接口|方法)\b/gi,
]

/** API/config patterns that are especially prone to staleness. */
const API_CLAIM_PATTERN = /\b(?:api|endpoint|header|param|config|flag|option|env)\s*[:=]\s*[`"']?[\w./-]+/gi

/* -------------------------------------------------------------------------- */
/* Core Algorithm                                                             */
/* -------------------------------------------------------------------------- */

export type UncertaintySignal = {
  readonly type: 'hedging' | 'version_claim' | 'tech_mention' | 'api_claim'
  readonly text: string
  readonly weight: number
}

export type UncertaintyResult = {
  readonly score: number
  readonly signals: readonly UncertaintySignal[]
  readonly shouldVerify: boolean
  readonly queries: readonly string[]
}

/**
 * Analyze text for uncertainty signals. Pure function — no side effects.
 */
export function analyzeUncertainty(text: string): UncertaintyResult {
  const signals: UncertaintySignal[] = []

  // 1. Hedging detection
  for (const { pattern, weight } of HEDGING_SIGNALS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      signals.push({ type: 'hedging', text: match[0], weight })
    }
  }

  // 2. Version-specific claims
  VERSION_CLAIM_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = VERSION_CLAIM_PATTERN.exec(text)) !== null) {
    signals.push({ type: 'version_claim', text: match[0], weight: 0.3 })
  }

  // 3. Technology mentions (lower weight alone, amplified by hedging)
  for (const pattern of TECH_PATTERNS) {
    pattern.lastIndex = 0
    while ((match = pattern.exec(text)) !== null) {
      signals.push({ type: 'tech_mention', text: match[0], weight: 0.05 })
    }
  }

  // 4. API/config claims
  API_CLAIM_PATTERN.lastIndex = 0
  while ((match = API_CLAIM_PATTERN.exec(text)) !== null) {
    signals.push({ type: 'api_claim', text: match[0], weight: 0.2 })
  }

  // Score: hedging signals amplify tech/version signals
  const hedgingScore = signals
    .filter(s => s.type === 'hedging')
    .reduce((sum, s) => sum + s.weight, 0)
  const claimScore = signals
    .filter(s => s.type !== 'hedging')
    .reduce((sum, s) => sum + s.weight, 0)

  // Multiplicative interaction: hedging + claims = high uncertainty
  // Pure claims without hedging still trigger at high enough density
  const score = Math.min(1, hedgingScore * 0.6 + claimScore * 0.4 + hedgingScore * claimScore * 0.5)

  const shouldVerify = score >= UNCERTAINTY_THRESHOLD
  const queries = shouldVerify ? buildSearchQueries(text, signals) : []

  return { score, signals, shouldVerify, queries }
}

/**
 * Build focused search queries from detected signals. Extracts the most
 * specific claims (version + tech combos) for targeted verification.
 */
function buildSearchQueries(text: string, signals: readonly UncertaintySignal[]): string[] {
  const queries: string[] = []

  // Priority 1: version + tech combinations (most specific)
  const techMentions = signals.filter(s => s.type === 'tech_mention').map(s => s.text)
  const versionClaims = signals.filter(s => s.type === 'version_claim').map(s => s.text)

  for (const tech of techMentions) {
    if (queries.length >= MAX_QUERIES_PER_RESPONSE) break
    // Find surrounding context (±60 chars) for a better query
    const idx = text.indexOf(tech)
    if (idx === -1) continue
    const ctx = text.slice(Math.max(0, idx - 30), Math.min(text.length, idx + tech.length + 40)).trim()
    const query = `${tech} latest documentation ${versionClaims[0] ?? ''}`.trim()
    if (!queries.includes(query)) queries.push(query)
  }

  // Priority 2: API claims
  if (queries.length < MAX_QUERIES_PER_RESPONSE) {
    const apiClaims = signals.filter(s => s.type === 'api_claim')
    for (const claim of apiClaims) {
      if (queries.length >= MAX_QUERIES_PER_RESPONSE) break
      const query = `${claim.text} official documentation`
      if (!queries.includes(query)) queries.push(query)
    }
  }

  // Fallback: if no specific queries, use hedging context
  if (queries.length === 0 && signals.length > 0) {
    const hedging = signals.find(s => s.type === 'hedging')
    if (hedging) {
      const idx = text.indexOf(hedging.text)
      const sentence = extractSentence(text, idx)
      if (sentence) queries.push(sentence.slice(0, 100))
    }
  }

  return queries.slice(0, MAX_QUERIES_PER_RESPONSE)
}

function extractSentence(text: string, pos: number): string | null {
  if (pos === -1) return null
  const start = text.lastIndexOf('.', pos)
  const end = text.indexOf('.', pos)
  return text.slice(start + 1, end === -1 ? undefined : end).trim() || null
}

/* -------------------------------------------------------------------------- */
/* Forced Verification Executor                                               */
/* -------------------------------------------------------------------------- */

export type VerificationResult = {
  readonly triggered: boolean
  readonly score: number
  readonly queries: readonly string[]
  readonly evidence: readonly string[]
}

/**
 * Execute forced verification. Analyzes the response text and, if
 * uncertainty exceeds threshold, calls Firecrawl to fetch live docs.
 *
 * Returns evidence strings that should be injected into the next turn
 * as authoritative context.
 */
export async function executeVerification(responseText: string): Promise<VerificationResult> {
  const analysis = analyzeUncertainty(responseText)

  if (!analysis.shouldVerify) {
    return { triggered: false, score: analysis.score, queries: [], evidence: [] }
  }

  const evidence: string[] = []
  for (const query of analysis.queries) {
    const results = await firecrawlSearch(query, 3)
    evidence.push(...results.filter(r => !r.startsWith('[Firecrawl')))
  }

  return {
    triggered: true,
    score: analysis.score,
    queries: analysis.queries,
    evidence,
  }
}

/* -------------------------------------------------------------------------- */
/* Context Budget Management (optimized for 1M token windows)                 */
/* -------------------------------------------------------------------------- */

/**
 * Citation injection strategy for large context windows (1M tokens):
 *
 * Problem: Citations accumulate across turns. At 50+ turns with security
 * discussion, injected [CVE-CITATION] and [RE-INTEL] blocks could reach
 * 20k+ tokens of "dead" data that's never referenced again.
 *
 * Solution: Ephemeral citations with deduplication.
 *
 * 1. Each citation block is marked `isMeta: true` so autocompact can
 *    aggressively summarize/drop them during context collapse.
 * 2. Citations are deduplicated — if the same CVE/hash was already cited
 *    in the last 3 turns, skip re-injection.
 * 3. Max budget per turn: 800 tokens of citation data. Excess is trimmed
 *    to the highest-confidence entries.
 * 4. Stale citations (>5 turns old) are candidates for context collapse
 *    with zero preservation priority.
 *
 * At 1M context, 800 tokens/turn × 100 turns = 80k tokens worst case
 * (8% of budget). With autocompact, actual usage stays under 5k.
 */

const CITATION_BUDGET_CHARS = 3200 // ~800 tokens
const DEDUP_WINDOW_TURNS = 3

/** Track recently cited items to avoid re-injection. */
const recentCitations = new Map<string, number>() // key → turn number
let currentTurn = 0

export function advanceCitationTurn(): void {
  currentTurn++
  // Evict entries older than DEDUP_WINDOW
  for (const [key, turn] of recentCitations) {
    if (currentTurn - turn > DEDUP_WINDOW_TURNS) {
      recentCitations.delete(key)
    }
  }
}

export function isDuplicate(citationKey: string): boolean {
  return recentCitations.has(citationKey)
}

export function markCited(citationKey: string): void {
  recentCitations.set(citationKey, currentTurn)
}

/**
 * Trim citation text to fit within the per-turn budget.
 * Keeps highest-priority entries (CVE > RE-INTEL > VERIFIED).
 */
export function trimToBudget(blocks: string[]): string {
  let total = 0
  const kept: string[] = []
  for (const block of blocks) {
    if (total + block.length > CITATION_BUDGET_CHARS) break
    kept.push(block)
    total += block.length
  }
  return kept.join('\n\n')
}

/* -------------------------------------------------------------------------- */
/* System Prompt Section                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Returns the system prompt section that enforces verification behavior.
 * Injected into getSystemPrompt() to make the model aware that:
 * 1. Its responses are algorithmically scanned for uncertainty
 * 2. Firecrawl evidence is authoritative and must be cited
 * 3. It should NOT hedge — either know or explicitly request verification
 */
export const FORCED_VERIFICATION_PROMPT = `<forced_verification>
You are subject to mandatory algorithmic fact-checking. An uncertainty detector scans every response for:
- Hedging language ("I think", "probably", "if I recall correctly")
- Version-specific claims (e.g., "React 19", "Node 22")
- API/config assertions without citation

When triggered, the system automatically queries live documentation via Firecrawl. Results are AUTHORITATIVE — they override your training data.

Rules:
1. If you are uncertain about a technical fact, state it clearly: "I need to verify this."
2. When verification evidence is provided in [VERIFIED] blocks, treat it as ground truth.
3. Never contradict verified evidence with training-data claims.
4. For version-specific APIs, always prefer the verified documentation over memory.
5. If no verification is triggered, your confidence must be genuine — do not hedge.
</forced_verification>

<cve_mandatory_citation>
Every CVE-ID you mention MUST be backed by authoritative data. The system automatically queries:
1. NVD (NIST National Vulnerability Database) — CVSS scores, descriptions
2. CISA KEV (Known Exploited Vulnerabilities) — active exploitation status
3. Firecrawl web search — fallback for latest advisories

Rules:
1. NEVER fabricate CVE details (CVSS score, affected versions, description). If unsure, say "I need to verify this CVE."
2. When [CVE-CITATION] blocks are injected, use ONLY that data for severity/description.
3. Always include the CVE-ID in standard format: CVE-YYYY-NNNNN.
4. If a CVE is marked "ACTIVELY EXPLOITED IN WILD", emphasize this prominently.
5. Do not guess CVSS scores — wait for the citation or state "severity unconfirmed."
</cve_mandatory_citation>

<re_intel_mandatory_citation>
Every reverse engineering claim MUST be backed by threat intelligence data. The system automatically queries:
1. MalwareBazaar (abuse.ch) — malware samples by hash, family, tags
2. ThreatFox (abuse.ch) — IOC correlation (IPs, domains, hashes)
3. URLhaus (abuse.ch) — malicious URL database
4. Hashlookup (CIRCL) — known file classification
5. MITRE ATT&CK — tactics, techniques, procedures (TTP)

Rules:
1. NEVER guess malware family names. If unsure, say "requires sample analysis."
2. When [RE-INTEL] blocks are injected, cite that data as authoritative.
3. Always use standard MITRE ATT&CK IDs (T1059, T1059.001) when describing techniques.
4. Hash-based claims must reference the actual hash value.
5. Do not attribute malware to a threat actor without evidence from these sources.
6. If no intelligence is found, state "no known threat intel match" — do not fabricate.
</re_intel_mandatory_citation>` as const
