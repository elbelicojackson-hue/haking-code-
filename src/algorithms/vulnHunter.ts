/**
 * VulnHunter — Autonomous Vulnerability Discovery Engine (sandbox-free)
 *
 * Level 2 implementation: given a target (repo/file/endpoint), autonomously
 * identify attack surfaces, generate vulnerability hypotheses, and verify
 * through code analysis + request-based testing.
 *
 * No sandbox required — focuses on logic vulnerabilities that can be
 * verified through:
 *   1. Static code pattern matching (dangerous patterns)
 *   2. HTTP request probing (for live services)
 *   3. LLM semantic reasoning (understanding intent vs implementation)
 *
 * Architecture:
 *   AttackSurfaceMapper → HypothesisGenerator → Verifier → Reporter
 *
 * Integrates with PEV loop: each vulnerability hypothesis is a PEV
 * hypothesis, verification uses existing tool chain.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type VulnClass =
  | 'auth_bypass'
  | 'idor'
  | 'sqli'
  | 'xss'
  | 'ssrf'
  | 'path_traversal'
  | 'command_injection'
  | 'deserialization'
  | 'info_disclosure'
  | 'race_condition'
  | 'logic_flaw'
  | 'hardcoded_secret'
  | 'broken_crypto'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export type AttackSurface = {
  readonly type: 'api_endpoint' | 'input_parser' | 'auth_check' | 'file_operation' | 'db_query' | 'command_exec' | 'crypto_operation' | 'config_value'
  readonly location: string // file:line
  readonly description: string
  readonly riskScore: number // 0-1
}

export type VulnHypothesis = {
  readonly id: string
  readonly surface: AttackSurface
  readonly vulnClass: VulnClass
  readonly reasoning: string
  readonly confidence: number // 0-1
  readonly testStrategy: string
}

export type VulnFinding = {
  readonly hypothesis: VulnHypothesis
  readonly verified: boolean
  readonly severity: Severity
  readonly evidence: string
  readonly poc?: string
  readonly remediation: string
}

/* -------------------------------------------------------------------------- */
/* Dangerous Code Patterns (static detection)                                 */
/* -------------------------------------------------------------------------- */

export const DANGEROUS_PATTERNS: {
  readonly vulnClass: VulnClass
  readonly patterns: readonly RegExp[]
  readonly severity: Severity
  readonly description: string
}[] = [
  // SQL Injection
  {
    vulnClass: 'sqli',
    patterns: [
      /(?:query|execute|raw)\s*\(\s*[`"'].*\$\{/gi,
      /(?:query|execute)\s*\(\s*['"].*['"]\s*\+\s*(?:req|input|param|user|body)/gi,
      /f["'](?:SELECT|INSERT|UPDATE|DELETE).*\{.*\}/gi,
      /\.format\s*\(.*\).*(?:SELECT|INSERT|UPDATE|DELETE)/gi,
    ],
    severity: 'critical',
    description: 'String concatenation/interpolation in SQL query — classic SQLi vector',
  },
  // Command Injection
  {
    vulnClass: 'command_injection',
    patterns: [
      /(?:exec|spawn|system|popen|shell_exec)\s*\(.*(?:req|input|param|user|body|query)/gi,
      /child_process.*(?:exec|spawn)\s*\(\s*[`"'].*\$\{/gi,
      /os\.(?:system|popen)\s*\(.*(?:request|input|param)/gi,
      /subprocess\.(?:call|run|Popen)\s*\(.*(?:request|input|f["'])/gi,
    ],
    severity: 'critical',
    description: 'User input flows into command execution without sanitization',
  },
  // Path Traversal
  {
    vulnClass: 'path_traversal',
    patterns: [
      /(?:readFile|readFileSync|open|createReadStream)\s*\(.*(?:req|input|param|query)/gi,
      /path\.(?:join|resolve)\s*\(.*(?:req|input|param|body)/gi,
      /(?:sendFile|download|serve)\s*\(.*(?:req|param|query)/gi,
    ],
    severity: 'high',
    description: 'User-controlled path in file operation without traversal check',
  },
  // SSRF
  {
    vulnClass: 'ssrf',
    patterns: [
      /(?:fetch|axios|request|http\.get|urllib)\s*\(.*(?:req|input|param|body|url)/gi,
      /new\s+URL\s*\(.*(?:req|input|param|body)/gi,
    ],
    severity: 'high',
    description: 'User-controlled URL in server-side request',
  },
  // Auth Bypass
  {
    vulnClass: 'auth_bypass',
    patterns: [
      /if\s*\(\s*(?:req\.headers|token|jwt|session).*(?:==|!=)\s*(?:null|undefined|['"])/gi,
      /(?:isAdmin|isAuth|checkAuth|verify)\s*=.*(?:true|false)/gi,
      /(?:skip|bypass|disable).*(?:auth|check|verify)/gi,
    ],
    severity: 'critical',
    description: 'Weak or bypassable authentication check',
  },
  // IDOR
  {
    vulnClass: 'idor',
    patterns: [
      /(?:findById|findOne|get)\s*\(\s*(?:req\.params|req\.query|req\.body)\./gi,
      /(?:where|filter).*(?:id|userId|user_id)\s*[:=]\s*(?:req|params|query)/gi,
    ],
    severity: 'high',
    description: 'Direct object reference from user input without ownership check',
  },
  // Hardcoded Secrets
  {
    vulnClass: 'hardcoded_secret',
    patterns: [
      /(?:password|secret|api_key|apikey|token|private_key)\s*[:=]\s*['"][^'"]{8,}/gi,
      /(?:AWS_SECRET|PRIVATE_KEY|DATABASE_URL)\s*[:=]\s*['"][^'"]+/gi,
    ],
    severity: 'high',
    description: 'Hardcoded credential or secret in source code',
  },
  // Broken Crypto
  {
    vulnClass: 'broken_crypto',
    patterns: [
      /(?:md5|sha1|DES|RC4|ECB)\s*\(/gi,
      /createCipher\s*\(\s*['"](?:des|rc4|aes-128-ecb)/gi,
      /Math\.random\s*\(\s*\).*(?:token|secret|key|nonce|salt)/gi,
    ],
    severity: 'medium',
    description: 'Weak cryptographic algorithm or insecure randomness',
  },
  // Info Disclosure
  {
    vulnClass: 'info_disclosure',
    patterns: [
      /(?:console\.log|print|logger).*(?:password|secret|token|key|credential)/gi,
      /(?:res\.json|res\.send|response).*(?:stack|trace|error\.message)/gi,
      /(?:DEBUG|VERBOSE)\s*[:=]\s*(?:true|1|['"]true)/gi,
    ],
    severity: 'medium',
    description: 'Sensitive information exposed in logs or responses',
  },
  // Deserialization
  {
    vulnClass: 'deserialization',
    patterns: [
      /(?:unserialize|pickle\.loads|yaml\.load|eval)\s*\(.*(?:req|input|body|data)/gi,
      /JSON\.parse\s*\(.*(?:req|body|data)\).*(?:constructor|__proto__|prototype)/gi,
    ],
    severity: 'critical',
    description: 'Untrusted data deserialization — potential RCE',
  },
  // Race Condition
  {
    vulnClass: 'race_condition',
    patterns: [
      /(?:balance|stock|quantity|count).*(?:update|decrement|subtract)(?!.*(?:lock|mutex|transaction|atomic))/gi,
    ],
    severity: 'medium',
    description: 'State modification without locking — potential TOCTOU race',
  },
]

/* -------------------------------------------------------------------------- */
/* Attack Surface Mapper                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Scan source code for attack surfaces. Returns locations ranked by risk.
 */
export function mapAttackSurfaces(code: string, filePath: string): AttackSurface[] {
  const surfaces: AttackSurface[] = []
  const lines = code.split('\n')

  for (const pattern of DANGEROUS_PATTERNS) {
    for (const regex of pattern.patterns) {
      regex.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = regex.exec(code)) !== null) {
        const lineNum = code.slice(0, match.index).split('\n').length
        surfaces.push({
          type: inferSurfaceType(pattern.vulnClass),
          location: `${filePath}:${lineNum}`,
          description: `${pattern.description} — matched: "${match[0].slice(0, 60)}"`,
          riskScore: severityToScore(pattern.severity),
        })
      }
    }
  }

  // Deduplicate by location
  const seen = new Set<string>()
  return surfaces
    .filter(s => { const k = s.location; if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => b.riskScore - a.riskScore)
}

/**
 * Generate vulnerability hypotheses from attack surfaces.
 */
export function generateHypotheses(surfaces: AttackSurface[]): VulnHypothesis[] {
  return surfaces.slice(0, 20).map((surface, i) => {
    const vulnClass = inferVulnClass(surface)
    return {
      id: `VH-${i + 1}`,
      surface,
      vulnClass,
      reasoning: `Dangerous pattern detected at ${surface.location}: ${surface.description}`,
      confidence: surface.riskScore,
      testStrategy: getTestStrategy(vulnClass),
    }
  })
}

/**
 * Format findings into a security report.
 */
export function formatVulnReport(findings: VulnFinding[]): string {
  if (findings.length === 0) return '[No vulnerabilities confirmed]'

  const confirmed = findings.filter(f => f.verified)
  const suspicious = findings.filter(f => !f.verified)

  const lines: string[] = ['# 🔴 Vulnerability Report\n']

  if (confirmed.length > 0) {
    lines.push(`## Confirmed (${confirmed.length})\n`)
    for (const f of confirmed) {
      lines.push(`### [${f.severity.toUpperCase()}] ${f.hypothesis.vulnClass} — ${f.hypothesis.surface.location}`)
      lines.push(`**Evidence:** ${f.evidence}`)
      if (f.poc) lines.push(`**PoC:** \`${f.poc}\``)
      lines.push(`**Fix:** ${f.remediation}\n`)
    }
  }

  if (suspicious.length > 0) {
    lines.push(`## Suspicious (${suspicious.length}) — needs manual review\n`)
    for (const f of suspicious) {
      lines.push(`- [${f.severity}] ${f.hypothesis.vulnClass} at ${f.hypothesis.surface.location}`)
      lines.push(`  Reason: ${f.hypothesis.reasoning.slice(0, 100)}`)
    }
  }

  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function inferSurfaceType(vulnClass: VulnClass): AttackSurface['type'] {
  switch (vulnClass) {
    case 'sqli': return 'db_query'
    case 'command_injection': return 'command_exec'
    case 'path_traversal': return 'file_operation'
    case 'ssrf': return 'api_endpoint'
    case 'auth_bypass': case 'idor': return 'auth_check'
    case 'hardcoded_secret': return 'config_value'
    case 'broken_crypto': return 'crypto_operation'
    default: return 'input_parser'
  }
}

function inferVulnClass(surface: AttackSurface): VulnClass {
  if (surface.description.includes('SQL')) return 'sqli'
  if (surface.description.includes('command')) return 'command_injection'
  if (surface.description.includes('path') || surface.description.includes('file')) return 'path_traversal'
  if (surface.description.includes('URL') || surface.description.includes('request')) return 'ssrf'
  if (surface.description.includes('auth') || surface.description.includes('bypass')) return 'auth_bypass'
  if (surface.description.includes('object reference')) return 'idor'
  if (surface.description.includes('secret') || surface.description.includes('credential')) return 'hardcoded_secret'
  if (surface.description.includes('crypto') || surface.description.includes('random')) return 'broken_crypto'
  if (surface.description.includes('deserializ')) return 'deserialization'
  return 'logic_flaw'
}

function severityToScore(s: Severity): number {
  switch (s) {
    case 'critical': return 0.95
    case 'high': return 0.8
    case 'medium': return 0.5
    case 'low': return 0.3
    case 'info': return 0.1
  }
}

function getTestStrategy(vulnClass: VulnClass): string {
  const strategies: Record<VulnClass, string> = {
    sqli: "Inject ' OR 1=1-- in the parameter and check for altered response/error",
    command_injection: "Inject ; id or | whoami and check for command output in response",
    path_traversal: "Request ../../etc/passwd or ..\\windows\\system32\\drivers\\etc\\hosts",
    ssrf: "Point URL to internal metadata (169.254.169.254) or collaborator",
    auth_bypass: "Send request without auth header or with empty/null token",
    idor: "Access resource with another user's ID, check if data returned",
    hardcoded_secret: "Verify the secret is valid by attempting authentication with it",
    broken_crypto: "Check if MD5/SHA1 is used for passwords or if Math.random for tokens",
    info_disclosure: "Trigger an error and check if stack trace/secrets are in response",
    deserialization: "Send crafted serialized payload and check for code execution",
    race_condition: "Send concurrent requests to the same endpoint and check for inconsistency",
    logic_flaw: "Analyze the business logic flow and find state that can be skipped",
  }
  return strategies[vulnClass]
}
