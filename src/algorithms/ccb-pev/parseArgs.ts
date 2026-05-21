/**
 * `parseArgs` — pure CLI flag parser for the `/ccb-pev` slash command.
 *
 * Responsibility (R11-1, R11-2, R11-7):
 *   - Take the raw argument string the slash-command layer hands us
 *     (everything after `/ccb-pev `, already trimmed by the REPL).
 *   - Resolve a `targetBinary` (positional 1) plus an optional natural-
 *     language `goal` (every remaining unrecognised positional, joined
 *     by single spaces).
 *   - Resolve four numeric flags with bounded ranges:
 *       --max-rounds=N         range [1, 16],   default 8
 *       --max-tools=N          range [1, 64],   default 24
 *       --max-tokens=N         range [1000, 1_000_000], default 300_000
 *       --max-wallclock-min=N  range [1, 240],  default 30, converted
 *                              to `maxWallClockMs` in the output
 *   - Reject unknown flags with a clear error pointing at the first
 *     offending one.
 *   - Reject out-of-range numeric values with the bound + observed value.
 *   - Return a discriminated `{ ok: true; args }` / `{ ok: false; error }`
 *     so callers don't have to wrap every invocation in try/catch.
 *
 * Pure: no I/O, no env access, no filesystem checks. The command layer
 * does the binary existence + sha256 + provider checks separately
 * (ccb-pev.tsx).
 *
 * Cross-references:
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R11-1, R11-2,
 *     R11-7, R13-2
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 10
 */

/**
 * The 4-dimension PEV budget exposed to the runner. Field names mirror
 * `PevBudget` in `services/cav/pev/scheduler.ts` so the result of this
 * parser feeds straight into `runPev(opts.budget)` with no reshaping.
 */
export type CcbPevBudget = {
  readonly maxRounds: number
  readonly maxToolCalls: number
  readonly maxTokens: number
  readonly maxWallClockMs: number
}

/** Parsed argument struct surfaced to the command-layer call. */
export type CcbPevArgs = {
  /** Resolved positional 1 — the binary path. NOT validated for
   *  existence/readability here (the command layer does that with
   *  `fs.statSync`). */
  readonly targetBinary: string
  /**
   * Free-form natural-language goal. `null` when the user supplied only
   * a path. Normalised to single-spaced trimmed prose so the runner's
   * prompt builder doesn't have to re-tokenise.
   */
  readonly goal: string | null
  /** 4-dimension budget already converted to ms for wall-clock. */
  readonly budget: CcbPevBudget
}

/**
 * Discriminated result. Use `if (result.ok)` to narrow.
 *
 * The `error` string is meant to be displayed verbatim through
 * `onDone(result.error, { display: 'system' })` so it should be
 * self-contained (no embedded ANSI codes, no multi-line stack traces).
 */
export type ParseArgsResult =
  | { readonly ok: true; readonly args: CcbPevArgs }
  | { readonly ok: false; readonly error: string }

/**
 * Default values applied when a flag is missing. Matches the per-flag
 * documentation in the requirements doc (R11-2). Wall-clock is held in
 * minutes here for ergonomics; we convert to ms once at the end.
 */
const DEFAULTS = {
  maxRounds: 8,
  maxToolCalls: 24,
  maxTokens: 300_000,
  maxWallClockMin: 30,
} as const

/**
 * Inclusive integer ranges per flag. Centralised so the error formatter
 * can quote the exact bound used.
 */
const RANGES = {
  maxRounds: [1, 16] as const,
  maxToolCalls: [1, 64] as const,
  maxTokens: [1_000, 1_000_000] as const,
  maxWallClockMin: [1, 240] as const,
} as const

const USAGE =
  'Usage: /ccb-pev <targetBinary> [goal] [--max-rounds=N] [--max-tools=N] [--max-tokens=N] [--max-wallclock-min=N]'

/**
 * Map between flag spelling and the corresponding logical key.
 *
 * Why a separate table: the wire-format flag names are kebab-case (CLI
 * idiom) while the typed budget fields are camelCase (TS idiom). Keeping
 * the two perspectives in one place means the unknown-flag error path
 * can say "did you mean `--max-rounds` instead of `--maxRounds`?" by
 * checking against the known kebab keys.
 */
const FLAG_TO_KEY: Readonly<Record<string, keyof typeof RANGES>> = {
  'max-rounds': 'maxRounds',
  'max-tools': 'maxToolCalls',
  'max-tokens': 'maxTokens',
  'max-wallclock-min': 'maxWallClockMin',
}

/**
 * Parse a single `--key=value` flag token. Returns either the resolved
 * `(key, value)` or a parse error. Uses the kebab→camel map above so
 * the command layer never has to know both spellings.
 *
 * Implementation notes:
 *   - We require an `=` separator. `--max-rounds 8` (space-separated)
 *     is rejected so we never have to disambiguate against positional
 *     tokens. The user can quote the value if it has spaces (it
 *     never does for our four numeric flags).
 *   - The numeric parse uses a strict `^-?\d+$` regex first so values
 *     like `"4.5"` or `"4abc"` fail with a helpful message rather than
 *     getting silently floored by `parseInt`.
 */
function parseFlag(
  token: string,
):
  | { readonly ok: true; readonly key: keyof typeof RANGES; readonly value: number }
  | { readonly ok: false; readonly error: string } {
  // token shape: "--max-rounds=4". `--` already stripped by caller's
  // matcher, so we only see "max-rounds=4" here.
  const eq = token.indexOf('=')
  if (eq < 1) {
    return {
      ok: false,
      error: `Invalid flag --${token}: expected --<name>=<value>`,
    }
  }
  const flagName = token.slice(0, eq)
  const rawValue = token.slice(eq + 1)
  const camelKey = FLAG_TO_KEY[flagName]
  if (camelKey === undefined) {
    return {
      ok: false,
      error: `Unknown flag --${flagName}. Allowed: --max-rounds, --max-tools, --max-tokens, --max-wallclock-min`,
    }
  }
  if (!/^-?\d+$/.test(rawValue)) {
    return {
      ok: false,
      error: `--${flagName} expects an integer; got "${rawValue}"`,
    }
  }
  const value = Number.parseInt(rawValue, 10)
  const [lo, hi] = RANGES[camelKey]
  if (value < lo || value > hi) {
    return {
      ok: false,
      error: `--${flagName} must be in [${lo}, ${hi}]; got ${value}`,
    }
  }
  return { ok: true, key: camelKey, value }
}

/**
 * Tokenise the input on ASCII whitespace. We accept tab + space + CR/LF
 * for safety (Windows pasted commands occasionally smuggle a CR). The
 * tokenizer is intentionally simple: no quoting, no escapes — the slash
 * command interface doesn't pass through complex shells, and our flag
 * values are all unsigned integers.
 */
function tokenise(raw: string): readonly string[] {
  return raw.split(/[\s]+/u).filter(t => t.length > 0)
}

/**
 * Parse the full raw argument string. See module doc for the full
 * grammar. Always returns synchronously — no I/O.
 *
 * Algorithm:
 *   1. Trim + tokenise.
 *   2. Walk tokens left-to-right. Each `--…` is a flag; everything else
 *      is a positional. The first positional is `targetBinary`; all
 *      remaining positionals are joined as the `goal`.
 *   3. After all tokens are consumed, fill in defaults for any flag we
 *      didn't see, then convert `maxWallClockMin` → `maxWallClockMs`.
 *   4. If we never resolved a `targetBinary`, return the usage error.
 *
 * Mixed positional + flag interleaving is supported (e.g.
 * `--max-rounds=4 e:/path.exe --max-tools=8 the goal`), which keeps the
 * UX forgiving.
 */
export function parseArgs(rawArgs: string): ParseArgsResult {
  const trimmed = rawArgs.trim()
  if (!trimmed) {
    return { ok: false, error: USAGE }
  }

  const tokens = tokenise(trimmed)

  let targetBinary: string | null = null
  const goalParts: string[] = []
  // Flag values track the camelCase keys; populated from `parseFlag`.
  const flagValues: Partial<Record<keyof typeof RANGES, number>> = {}

  for (const tok of tokens) {
    if (tok.startsWith('--')) {
      const inner = tok.slice(2)
      const result = parseFlag(inner)
      if (!result.ok) {
        return { ok: false, error: result.error }
      }
      flagValues[result.key] = result.value
      continue
    }
    if (targetBinary === null) {
      targetBinary = tok
      continue
    }
    goalParts.push(tok)
  }

  if (targetBinary === null) {
    return { ok: false, error: USAGE }
  }

  const maxWallClockMin =
    flagValues.maxWallClockMin ?? DEFAULTS.maxWallClockMin
  const budget: CcbPevBudget = {
    maxRounds: flagValues.maxRounds ?? DEFAULTS.maxRounds,
    maxToolCalls: flagValues.maxToolCalls ?? DEFAULTS.maxToolCalls,
    maxTokens: flagValues.maxTokens ?? DEFAULTS.maxTokens,
    maxWallClockMs: maxWallClockMin * 60 * 1000,
  }

  return {
    ok: true,
    args: {
      targetBinary,
      goal: goalParts.length > 0 ? goalParts.join(' ') : null,
      budget,
    },
  }
}
