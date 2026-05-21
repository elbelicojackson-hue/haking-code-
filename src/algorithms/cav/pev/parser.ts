/**
 * PEV Output Parser — three-layer fault-tolerant parsing.
 *
 * The parser is the boundary between **untrusted LLM free-form text** and
 * the deterministic state machine downstream. Its job is to extract the
 * `pev` fenced block, repair common formatting drift, and (only as a last
 * resort) request a single retry from the agent. Anything that survives
 * all three layers is guaranteed to satisfy {@link PevOutputSchema} +
 * {@link validatePevOutput} — i.e. shape AND referential integrity.
 *
 * Layer cascade:
 *   1. **strict**  — ` ```pev ` block → JSON.parse → zod → validator.
 *      Hits when the LLM produces compliant output. Counted as
 *      `parseStats.layer1Hits`.
 *   2. **repair**  — strip `//` and `/* … *\u002f` comments + trailing commas,
 *      inject `schema_version: "1.0"` if missing, run a small lenient JSON5
 *      parser (no npm dep — see R13-4), then normalise camelCase keys back
 *      to canonical snake_case. Counted as `parseStats.layer2Hits`.
 *   3. **retry**   — call `retryFn(feedback)` exactly once with a directive
 *      that names the failing kind + detail. Re-run Layer 1 then Layer 2
 *      against the fresh response. Counted as `parseStats.layer3Hits`.
 *
 * Hard rules:
 *   - Pure side-effect-free except for the optional `retryFn` and the
 *     optional mutable {@link ParseStats} counter the caller threads
 *     through.
 *   - All error `detail` strings are run through {@link redactSecrets} so
 *     a stray `Authorization: Bearer …` from a fetch error never leaves
 *     this module verbatim (R5-8).
 *   - **No external JSON5 dependency**. The Layer-2 lenient parser is
 *     implemented inline (~80 lines) below; it handles the exact failure
 *     modes we see from real LLM output (single quotes, unquoted keys,
 *     `//` comments, trailing commas) and nothing more — it is *not* a
 *     general JSON5 implementation.
 *
 * See:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 3 / 算法 3
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R5-1 ~ R5-8
 */

import {
  PevOutputSchema,
  type PevOutput,
} from './protocol.js'
import {
  validatePevOutput,
  type LedgerView,
  type ParseErrorKind,
  type ValidatorContext,
} from './validator.js'

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Parse outcome. Mirrors the shape used by `validator.ts` so callers can
 * pattern-match across both layers uniformly.
 */
export type ParseResult =
  | { ok: true; parsed: PevOutput; layerHit: 1 | 2 | 3 }
  | { ok: false; errorKind: ParseErrorKind; detail: string }

/**
 * Parser context. Re-exported alias of {@link ValidatorContext} so the
 * runner does not have to reach into validator.ts for the type name.
 */
export type ParserContext = ValidatorContext

/**
 * Mutable counter the runner threads through `parsePevOutput` so it can
 * aggregate L1/L2/L3 hit rates across all agents in a session. The struct
 * matches `SharedLedger.parseStats` (T4) so it can be moved verbatim once
 * T4 lands.
 */
export type ParseStats = {
  layer1Hits: number
  layer2Hits: number
  layer3Hits: number
  parseFailures: number
}

/** Build a fresh zero-counter. */
export function createEmptyParseStats(): ParseStats {
  return { layer1Hits: 0, layer2Hits: 0, layer3Hits: 0, parseFailures: 0 }
}

/* -------------------------------------------------------------------------- */
/* parsePevOutput — public entry                                              */
/* -------------------------------------------------------------------------- */

/**
 * Three-layer fault-tolerant PEV-block parser.
 *
 * @param rawAgentOutput  Full agent reply (markdown with three sections).
 * @param ctx             Parser context (selfAgentId, round, ledger,
 *                        optional findToolPlan).
 * @param retryFn         Optional async callback invoked at most once
 *                        when Layer 1 + Layer 2 both fail. Should redrive
 *                        the agent with the supplied feedback string and
 *                        return the new full reply (markdown).
 * @param stats           Optional counter — incremented in place.
 */
export async function parsePevOutput(
  rawAgentOutput: string,
  ctx: ParserContext,
  retryFn?: (feedback: string) => Promise<string>,
  stats?: ParseStats,
): Promise<ParseResult> {
  // -- Layer 1 -------------------------------------------------------------
  const layer1 = tryStrict(rawAgentOutput, ctx)
  if (layer1.ok) {
    if (stats) stats.layer1Hits += 1
    return { ok: true, parsed: layer1.parsed, layerHit: 1 }
  }
  // 'no-fenced-block' has no JSON body to repair; jump straight to retry.
  const isFencedBlockMissing = layer1.errorKind === 'no-fenced-block'

  // -- Layer 2 -------------------------------------------------------------
  let layer2: TryResult = layer1
  if (!isFencedBlockMissing) {
    layer2 = tryRepair(rawAgentOutput, ctx)
    if (layer2.ok) {
      if (stats) stats.layer2Hits += 1
      return { ok: true, parsed: layer2.parsed, layerHit: 2 }
    }
  }

  // -- Layer 3 -------------------------------------------------------------
  // Only enter when the runner provided a retry callback. Without one the
  // parser stops at the best Layer-1/2 error it has so far.
  if (!retryFn) {
    if (stats) stats.parseFailures += 1
    return {
      ok: false,
      errorKind: layer2.errorKind,
      detail: redactSecrets(layer2.detail),
    }
  }

  const feedback = buildErrorFeedback(layer2.errorKind, layer2.detail)
  let retryRaw: string
  try {
    retryRaw = await retryFn(feedback)
  } catch (err) {
    if (stats) stats.parseFailures += 1
    return {
      ok: false,
      errorKind: 'retry-exhausted',
      detail: redactSecrets(
        `retryFn threw: ${err instanceof Error ? err.message : String(err)}`,
      ),
    }
  }

  // Re-run Layer 1 then Layer 2 on the retry response. We do NOT recurse
  // into a second retry — R5-3 caps retries at exactly one.
  const retryStrict = tryStrict(retryRaw, ctx)
  if (retryStrict.ok) {
    if (stats) stats.layer3Hits += 1
    return { ok: true, parsed: retryStrict.parsed, layerHit: 3 }
  }
  if (retryStrict.errorKind !== 'no-fenced-block') {
    const retryRepair = tryRepair(retryRaw, ctx)
    if (retryRepair.ok) {
      if (stats) stats.layer3Hits += 1
      return { ok: true, parsed: retryRepair.parsed, layerHit: 3 }
    }
    if (stats) stats.parseFailures += 1
    return {
      ok: false,
      errorKind: 'retry-exhausted',
      detail: redactSecrets(
        `retry still failed: ${retryRepair.errorKind} — ${retryRepair.detail}`,
      ),
    }
  }
  if (stats) stats.parseFailures += 1
  return {
    ok: false,
    errorKind: 'retry-exhausted',
    detail: redactSecrets(
      `retry still failed: ${retryStrict.errorKind} — ${retryStrict.detail}`,
    ),
  }
}

/* -------------------------------------------------------------------------- */
/* Internal: layered try-functions                                            */
/* -------------------------------------------------------------------------- */

type TryResult =
  | { ok: true; parsed: PevOutput }
  | { ok: false; errorKind: ParseErrorKind; detail: string }

/**
 * Layer 1 — strict path: extract block → JSON.parse → zod → validator.
 * Any failure is reported with the most specific errorKind we can pin
 * down, so Layer 2 / Layer 3 don't have to re-derive it.
 */
function tryStrict(raw: string, ctx: ParserContext): TryResult {
  const block = extractFencedBlock(raw, 'pev')
  if (block == null) {
    return {
      ok: false,
      errorKind: 'no-fenced-block',
      detail: 'no ```pev fenced block found',
    }
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(block)
  } catch (err) {
    return {
      ok: false,
      errorKind: 'json-parse-failed',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  const zod = PevOutputSchema.safeParse(parsedJson)
  if (!zod.success) {
    return {
      ok: false,
      errorKind: 'schema-mismatch',
      detail: summariseZodError(zod.error),
    }
  }
  const valid = validatePevOutput(zod.data, ctx)
  if (!valid.ok) {
    return { ok: false, errorKind: valid.errorKind, detail: valid.detail }
  }
  return { ok: true, parsed: zod.data }
}

/**
 * Layer 2 — repair path. Operates on the *raw* fenced-block contents,
 * applying a fixed sequence of textual repairs and then trying our
 * lenient parser. Any field-level fix-ups are applied **after** parsing
 * via {@link normaliseKeys}.
 */
function tryRepair(raw: string, ctx: ParserContext): TryResult {
  const block = extractFencedBlock(raw, 'pev')
  if (block == null) {
    return {
      ok: false,
      errorKind: 'no-fenced-block',
      detail: 'no ```pev fenced block found',
    }
  }

  // Stage 1: textual cleanup.
  let cleaned = removeJsCommentsAndTrailingCommas(block)
  if (!hasSchemaVersionKey(cleaned)) {
    cleaned = injectSchemaVersion(cleaned)
  }

  // Stage 2: lenient parse. We try strict JSON.parse first because it's
  // ~10x faster and the cleanup step often makes the input plain JSON.
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(cleaned)
  } catch {
    try {
      parsedJson = parseLenientJson(cleaned)
    } catch (err) {
      return {
        ok: false,
        errorKind: 'json-parse-failed',
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // Stage 3: key normalisation (recursively).
  const normalised = normaliseKeys(parsedJson)

  const zod = PevOutputSchema.safeParse(normalised)
  if (!zod.success) {
    return {
      ok: false,
      errorKind: 'schema-mismatch',
      detail: summariseZodError(zod.error),
    }
  }
  const valid = validatePevOutput(zod.data, ctx)
  if (!valid.ok) {
    return { ok: false, errorKind: valid.errorKind, detail: valid.detail }
  }
  return { ok: true, parsed: zod.data }
}

/* -------------------------------------------------------------------------- */
/* Fenced-block extraction                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Extract the body of a ` ```<lang>…``` ` fenced block. Handles:
 *   - CRLF + LF line endings
 *   - leading whitespace before the opening fence
 *   - mixed-language tags (` ```pev json `, ` ```pev   ` with extra info)
 *   - trailing whitespace before the closing fence
 *
 * Returns the inner text (without the fence lines themselves) or `null`
 * when no matching block is present. Always returns the **first** match —
 * agents that ship multiple `pev` blocks in one reply are doing something
 * wrong.
 */
export function extractFencedBlock(raw: string, lang: string): string | null {
  // Tolerate any extra info after the lang tag (` ```pev json `,
  // ` ```pev   trailing `) by anchoring on a word-boundary.
  const escaped = lang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(
    `\`\`\`\\s*${escaped}\\b[^\\n]*\\r?\\n([\\s\\S]*?)\\r?\\n\\s*\`\`\``,
    'i',
  )
  const m = raw.match(re)
  if (!m || m[1] == null) return null
  return m[1]
}

/* -------------------------------------------------------------------------- */
/* Layer-2 textual cleanup                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Strip JS-style `//` line comments and `/* … *\u002f` block comments and
 * remove trailing commas before `]` / `}`. String-aware: we track whether
 * we're currently inside a `"…"` or `'…'` literal and skip rewrites
 * there.
 */
export function removeJsCommentsAndTrailingCommas(input: string): string {
  let out = ''
  let i = 0
  let inString: '"' | "'" | null = null

  while (i < input.length) {
    const ch = input[i]!
    const next = i + 1 < input.length ? input[i + 1]! : ''

    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < input.length) {
        // Preserve escapes verbatim; do not look for comment boundaries inside.
        out += input[i + 1]
        i += 2
        continue
      }
      if (ch === inString) inString = null
      i += 1
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'"
      out += ch
      i += 1
      continue
    }

    if (ch === '/' && next === '/') {
      // Line comment — skip until newline (newline kept).
      i += 2
      while (i < input.length && input[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      // Block comment — skip until `*/`.
      i += 2
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        i += 1
      }
      i += 2 // past `*/`
      continue
    }
    out += ch
    i += 1
  }

  // Trailing-comma elision pass. Run on the comment-stripped text. We only
  // consider commas that, ignoring whitespace + newlines, are immediately
  // followed by `]` or `}`.
  return out.replace(/,(\s*[\]}])/g, '$1')
}

/** Does the JSON text already contain a `"schema_version"` key? */
function hasSchemaVersionKey(input: string): boolean {
  return /["']schema_version["']\s*:/.test(input)
}

/**
 * Inject `"schema_version": "1.0"` immediately after the first `{` of the
 * top-level object. This is intentionally textual rather than parse-and-
 * stringify because the input may not be parseable yet (we run this
 * before lenient parsing).
 */
function injectSchemaVersion(input: string): string {
  // Find the first opening brace of the top-level object. Tolerant of
  // leading whitespace.
  const m = input.match(/^\s*\{/)
  if (!m) return input
  const idx = (m.index ?? 0) + m[0].length
  const head = input.slice(0, idx)
  const tail = input.slice(idx)
  // If the body is empty/just-whitespace before the close brace, no comma
  // is needed.
  const needsComma = /\S/.test(tail.replace(/^\s*[}\n\r]/, ''))
  return `${head}\n  "schema_version": "1.0"${needsComma ? ',' : ''}${tail}`
}

/* -------------------------------------------------------------------------- */
/* Tiny lenient JSON parser ("JSON5-lite")                                    */
/* -------------------------------------------------------------------------- */

/**
 * Recursive-descent parser for the subset of JSON5 we actually see in
 * misformatted LLM output:
 *   - `'single'` and `"double"` quoted strings (string escapes per JSON)
 *   - unquoted object keys matching `[A-Za-z_$][A-Za-z0-9_$-]*`
 *   - trailing commas in arrays/objects
 *   - `//` line comments and `/* … *\u002f` block comments
 *
 * Anything beyond that (hex literals, NaN, +Infinity, multi-line strings)
 * is intentionally NOT supported — those would mask real bugs.
 *
 * Throws an `Error` on unrecoverable syntax errors with a column index.
 */
export function parseLenientJson(input: string): unknown {
  const ctx = { src: input, i: 0 }
  skipWs(ctx)
  const value = parseValue(ctx)
  skipWs(ctx)
  if (ctx.i !== ctx.src.length) {
    throw new Error(
      `lenient-json: unexpected trailing input at offset ${ctx.i}`,
    )
  }
  return value
}

type ParseCtx = { src: string; i: number }

function skipWs(c: ParseCtx): void {
  for (;;) {
    while (c.i < c.src.length && /\s/.test(c.src[c.i]!)) c.i += 1
    if (c.src[c.i] === '/' && c.src[c.i + 1] === '/') {
      c.i += 2
      while (c.i < c.src.length && c.src[c.i] !== '\n') c.i += 1
      continue
    }
    if (c.src[c.i] === '/' && c.src[c.i + 1] === '*') {
      c.i += 2
      while (
        c.i < c.src.length &&
        !(c.src[c.i] === '*' && c.src[c.i + 1] === '/')
      ) {
        c.i += 1
      }
      c.i += 2
      continue
    }
    break
  }
}

function parseValue(c: ParseCtx): unknown {
  skipWs(c)
  const ch = c.src[c.i]
  if (ch === '{') return parseObject(c)
  if (ch === '[') return parseArray(c)
  if (ch === '"' || ch === "'") return parseString(c)
  if (ch === 't' || ch === 'f') return parseBoolean(c)
  if (ch === 'n') return parseNull(c)
  if (ch === '-' || (ch != null && ch >= '0' && ch <= '9')) return parseNumber(c)
  throw new Error(`lenient-json: unexpected char "${ch}" at offset ${c.i}`)
}

function parseObject(c: ParseCtx): Record<string, unknown> {
  c.i += 1 // past '{'
  const obj: Record<string, unknown> = {}
  for (;;) {
    skipWs(c)
    if (c.src[c.i] === '}') {
      c.i += 1
      return obj
    }
    const key = parseObjectKey(c)
    skipWs(c)
    if (c.src[c.i] !== ':') {
      throw new Error(
        `lenient-json: expected ':' after key "${key}" at offset ${c.i}`,
      )
    }
    c.i += 1
    const value = parseValue(c)
    obj[key] = value
    skipWs(c)
    if (c.src[c.i] === ',') {
      c.i += 1
      continue
    }
    if (c.src[c.i] === '}') {
      c.i += 1
      return obj
    }
    throw new Error(
      `lenient-json: expected ',' or '}' in object at offset ${c.i}`,
    )
  }
}

function parseObjectKey(c: ParseCtx): string {
  const ch = c.src[c.i]
  if (ch === '"' || ch === "'") return parseString(c)
  // Unquoted key.
  const start = c.i
  while (c.i < c.src.length && /[A-Za-z0-9_$-]/.test(c.src[c.i]!)) c.i += 1
  if (c.i === start) {
    throw new Error(
      `lenient-json: expected object key at offset ${c.i}, found "${c.src[c.i] ?? 'EOF'}"`,
    )
  }
  return c.src.slice(start, c.i)
}

function parseArray(c: ParseCtx): unknown[] {
  c.i += 1 // past '['
  const arr: unknown[] = []
  for (;;) {
    skipWs(c)
    if (c.src[c.i] === ']') {
      c.i += 1
      return arr
    }
    arr.push(parseValue(c))
    skipWs(c)
    if (c.src[c.i] === ',') {
      c.i += 1
      continue
    }
    if (c.src[c.i] === ']') {
      c.i += 1
      return arr
    }
    throw new Error(
      `lenient-json: expected ',' or ']' in array at offset ${c.i}`,
    )
  }
}

function parseString(c: ParseCtx): string {
  const quote = c.src[c.i]
  if (quote !== '"' && quote !== "'") {
    throw new Error(`lenient-json: expected string at offset ${c.i}`)
  }
  c.i += 1
  let out = ''
  while (c.i < c.src.length) {
    const ch = c.src[c.i]!
    if (ch === '\\') {
      const esc = c.src[c.i + 1]
      switch (esc) {
        case 'n':
          out += '\n'
          break
        case 't':
          out += '\t'
          break
        case 'r':
          out += '\r'
          break
        case 'b':
          out += '\b'
          break
        case 'f':
          out += '\f'
          break
        case '\\':
          out += '\\'
          break
        case '/':
          out += '/'
          break
        case '"':
          out += '"'
          break
        case "'":
          out += "'"
          break
        case 'u': {
          const hex = c.src.slice(c.i + 2, c.i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new Error(
              `lenient-json: invalid unicode escape at offset ${c.i}`,
            )
          }
          out += String.fromCharCode(parseInt(hex, 16))
          c.i += 4
          break
        }
        default:
          throw new Error(
            `lenient-json: invalid escape "\\${esc}" at offset ${c.i}`,
          )
      }
      c.i += 2
      continue
    }
    if (ch === quote) {
      c.i += 1
      return out
    }
    out += ch
    c.i += 1
  }
  throw new Error(`lenient-json: unterminated string starting at quote ${quote}`)
}

function parseBoolean(c: ParseCtx): boolean {
  if (c.src.startsWith('true', c.i)) {
    c.i += 4
    return true
  }
  if (c.src.startsWith('false', c.i)) {
    c.i += 5
    return false
  }
  throw new Error(`lenient-json: expected boolean at offset ${c.i}`)
}

function parseNull(c: ParseCtx): null {
  if (c.src.startsWith('null', c.i)) {
    c.i += 4
    return null
  }
  throw new Error(`lenient-json: expected null at offset ${c.i}`)
}

function parseNumber(c: ParseCtx): number {
  const start = c.i
  if (c.src[c.i] === '-') c.i += 1
  while (c.i < c.src.length && /[0-9]/.test(c.src[c.i]!)) c.i += 1
  if (c.src[c.i] === '.') {
    c.i += 1
    while (c.i < c.src.length && /[0-9]/.test(c.src[c.i]!)) c.i += 1
  }
  if (c.src[c.i] === 'e' || c.src[c.i] === 'E') {
    c.i += 1
    if (c.src[c.i] === '+' || c.src[c.i] === '-') c.i += 1
    while (c.i < c.src.length && /[0-9]/.test(c.src[c.i]!)) c.i += 1
  }
  const text = c.src.slice(start, c.i)
  const n = Number(text)
  if (Number.isNaN(n)) {
    throw new Error(`lenient-json: invalid number "${text}" at offset ${start}`)
  }
  return n
}

/* -------------------------------------------------------------------------- */
/* Key normalisation (camelCase → snake_case alias map)                       */
/* -------------------------------------------------------------------------- */

/**
 * Recognised camelCase aliases the model occasionally emits. Mapped to
 * the canonical snake_case names declared in protocol.ts. The map is
 * **closed** — unknown keys pass through untouched and trip strictObject
 * down the line. That's the desired behaviour: silent renames would mask
 * real protocol drift.
 */
const KEY_ALIAS_MAP: Readonly<Record<string, string>> = {
  evidenceId: 'evidence_id',
  nextAction: 'next_action',
  hypothesisUpdates: 'hypothesis_updates',
  schemaVersion: 'schema_version',
  agentId: 'agent_id',
  parentId: 'parent_id',
  newId: 'new_id',
  newConfidence: 'new_confidence',
  rationaleShort: 'rationale_short',
  counterEvidenceId: 'counter_evidence_id',
  hypothesisId: 'hypothesis_id',
  toolPlanId: 'tool_plan_id',
  argsOverride: 'args_override',
}

/**
 * Recursively rename any object key that matches {@link KEY_ALIAS_MAP}.
 * Arrays are walked, primitives pass through. Returns a new object — the
 * input is not mutated.
 */
export function normaliseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normaliseKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const canonical = KEY_ALIAS_MAP[k] ?? k
      out[canonical] = normaliseKeys(v)
    }
    return out
  }
  return value
}

/* -------------------------------------------------------------------------- */
/* Layer-3 retry feedback                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build the retry directive given to the agent. We name the failing kind
 * + the redacted detail and remind the agent of the three protocol
 * invariants that account for ~90% of real failures (literal
 * `schema_version`, snake_case keys, no comments / trailing commas).
 *
 * Critically we do NOT echo the agent's previous non-conforming output —
 * that would invite the model to repeat the same defect.
 */
export function buildErrorFeedback(
  errorKind: ParseErrorKind,
  detail: string,
): string {
  const safeDetail = redactSecrets(detail)
  return [
    '你上轮的 pev fenced block 解析失败:',
    `errorKind: ${errorKind}`,
    `detail: ${safeDetail}`,
    '请重发完整的 ```pev``` fenced block(其他两段保持不变)。注意:',
    '- schema_version 必须是字符串 "1.0"',
    '- 字段名使用 snake_case',
    '- 不要包含注释或 trailing comma',
  ].join('\n')
}

/* -------------------------------------------------------------------------- */
/* Secret redaction                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Remove obvious provider-secret patterns from any string we might echo
 * back into a prompt or log. Conservative by design: false positives are
 * cheap (you lose a fragment of an error message), false negatives are
 * expensive (a key leaks into model context). Mirrors the dispatcher's
 * own `redactSecrets` function in shape (R5-8).
 */
export function redactSecrets(input: string): string {
  return (
    input
      // OAuth bearer tokens — case-insensitive scheme, generous token-shape.
      .replace(/Bearer\s+[A-Za-z0-9._\-=]+/gi, 'Bearer ***')
      // OpenAI-style `sk-…` keys (incl. `sk-proj-…`, `sk-ant-…` siblings).
      .replace(/sk-[A-Za-z0-9_\-]{10,}/g, 'sk-***')
      // x-api-key / api-key headers.
      .replace(/(api[-_]?key\s*[:=]\s*)[A-Za-z0-9._\-]+/gi, '$1***')
  )
}

/* -------------------------------------------------------------------------- */
/* zod error → 1-line summary                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Compress a zod ZodError into a single-line, human-readable summary
 * suitable for {@link buildErrorFeedback}. zod's default message tree is
 * great for humans staring at it but extremely verbose to ship to a
 * model — we keep the first issue's path + message, plus a count of how
 * many issues remain.
 */
function summariseZodError(err: unknown): string {
  // We avoid a static import of the ZodError class to keep this resilient
  // across zod minor versions; we just feature-test the shape.
  const issues =
    err && typeof err === 'object' && 'issues' in err
      ? (err as { issues: ReadonlyArray<{ path: ReadonlyArray<unknown>; message: string }> }).issues
      : null
  if (!issues || issues.length === 0) {
    return 'zod schema mismatch'
  }
  const first = issues[0]!
  const path = first.path.length > 0 ? first.path.join('.') : '<root>'
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : ''
  return `${path}: ${first.message}${more}`
}
