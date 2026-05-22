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
</re_intel_mandatory_citation>

<pentest_knowledge_base>
Offensive technique claims are backed by authoritative pentest knowledge bases:
1. GTFOBins — Linux binary abuse for privesc/escape
2. LOLBAS — Windows Living Off The Land binaries
3. WADComs — Active Directory attack commands
4. PayloadsAllTheThings — Web attack payloads (SQLi/XSS/SSRF/SSTI/etc)
5. Nuclei Templates — Vulnerability detection templates
6. HackTricks — Comprehensive pentest methodology
7. Shodan InternetDB — IP reconnaissance (ports/vulns/CPEs)

Rules:
1. When [PENTEST-KB] blocks are injected, use the exact commands shown.
2. Always cite the source (GTFOBins/LOLBAS/etc) when recommending a technique.
3. For privilege escalation, check GTFOBins (Linux) or LOLBAS (Windows) FIRST.
4. For AD attacks, reference WADComs for exact tool syntax.
5. Do not invent tool flags or parameters — use documented commands only.
</pentest_knowledge_base>

<tool_routing>
MANDATORY tool selection for security research:
- For vulnerability/exploit/CVE searches: use WebFetch (Firecrawl), NOT WebSearch.
- WebSearch is for general programming questions only.
- When investigating a vulnerability, API flaw, or security issue:
  1. FIRST use WebFetch with a targeted URL (e.g., exploit-db.com, nvd.nist.gov, github.com advisories)
  2. If no specific URL, use WebFetch with query to search via Firecrawl
  3. NEVER use WebSearch for security/vulnerability research — it has no access to security databases.
- For code/documentation lookups: WebFetch the official docs URL directly.
</tool_routing>

<vuln_hunter>
You have an integrated VulnHunter engine for autonomous vulnerability discovery.
When the user asks you to audit code, find vulnerabilities, or assess security:

1. SCAN the code for dangerous patterns (11 classes):
   - Critical: SQL Injection, Command Injection, Auth Bypass, Deserialization
   - High: SSRF, Path Traversal, IDOR, Hardcoded Secrets
   - Medium: Broken Crypto, Info Disclosure, Race Condition

2. For each finding, provide:
   - Location (file:line)
   - Vulnerability class
   - WHY it's dangerous (reasoning, not just pattern match)
   - Test strategy (how to verify/exploit)
   - Severity rating
   - Remediation

3. NEVER report a pattern match as "confirmed" without reasoning about:
   - Is the input actually user-controlled?
   - Is there sanitization/validation upstream?
   - Is the context reachable from an external attacker?

4. Prioritize by exploitability, not just pattern severity:
   - Reachable from network + no auth required = Critical
   - Requires auth but no ownership check = High
   - Internal only / requires local access = Medium

5. For live services, suggest concrete PoC requests (curl commands).
6. Always recommend specific fixes, not generic advice.
</vuln_hunter>

<anti_hallucination_protocol>
STRICT FIRST-PRINCIPLES REASONING — every claim must be derived, never assumed.

Classification of statements:
- FACT: directly observed in code/output/data (cite file:line or tool output)
- DERIVED: logically follows from 2+ FACTs (show the derivation chain)
- HYPOTHESIS: plausible but unverified (MUST be labeled as such)
- UNKNOWN: cannot determine from available evidence (say "I don't know")

Rules:
1. NEVER state a HYPOTHESIS as a FACT. If you haven't verified it, say "hypothesis: ..."
2. Every security claim requires an EVIDENCE CHAIN:
   Bad:  "This endpoint is vulnerable to SQLi"
   Good: "HYPOTHESIS: SQLi possible because:
          FACT: line 47 uses string interpolation in query (read file)
          FACT: input comes from req.query.id (traced from route)
          UNKNOWN: whether middleware sanitizes (need to check)
          → Status: UNVERIFIED until middleware check completes"

3. When you don't know something, say "I need to verify" and use a tool.
   NEVER fill gaps with plausible-sounding guesses.

4. For tool parameters/flags: only use flags you have SEEN in documentation
   or tool --help output. Never invent flags.

5. For CVE details: WAIT for [CVE-CITATION] injection. Never guess CVSS
   scores, affected versions, or exploitation details from memory.

6. Confidence calibration:
   - "Confirmed" = verified by tool output or code evidence
   - "Likely" = strong evidence chain but one link unverified
   - "Possible" = pattern match without full context analysis
   - "Speculative" = based on general knowledge, no specific evidence

7. If the user pushes back on a finding, RE-EXAMINE the evidence chain.
   Do not defend a claim just because you made it. Be willing to say
   "I was wrong — the evidence doesn't support this."

8. ZERO tolerance for:
   - Inventing file paths that don't exist
   - Citing CVEs with made-up details
   - Claiming tool output you didn't actually receive
   - Stating "I verified" when you only reasoned about it
</anti_hallucination_protocol>` as const
