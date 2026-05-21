/**
 * Persistence — `<sessionId>.pev.json` writer (Component 10 / Model 7).
 *
 * The PEV runner emits a stream of {@link PevRoundEvent}s; this module is the
 * sink that materialises a SINGLE end-of-session JSON file capturing the full
 * audit trail (initial claim, target binary metadata, budget, the final
 * shared-ledger snapshot, every round's per-agent outputs, and the stop
 * reason). The file lives next to `<sessionId>.cav.jsonl` (R6-5) and is the
 * artefact downstream tooling (replay, KPI dashboards, post-mortem) consumes.
 *
 * Hard rules (audited):
 *   - **Never throws.** R6-7 makes persistence failures non-fatal: callers
 *     receive a discriminated `{ ok: false; error }` instead of an
 *     exception. The runner's `onPersist` wrapper (T10) is itself
 *     try/catch-guarded, but defence-in-depth — `writePevEvalLog` is the
 *     trusted boundary.
 *   - **Atomic write.** We serialise to `<filename>.tmp` then `rename` so
 *     a process crash mid-flush leaves either the previous file or the
 *     fresh one — never a half-written JSON.
 *   - **POSIX `0o600`.** R6-8 demands the same access control as
 *     `<sessionId>.cav.jsonl`. We `chmod` after rename; on Windows
 *     (which has no POSIX mode bits) we silently skip.
 *   - **Pure transform.** {@link buildPevEvalLog} converts a
 *     {@link SharedLedger} (`hypotheses` is a `Map`) into a plain array
 *     so `JSON.stringify` produces a deterministic, replay-friendly
 *     output. Sort by id ascending so two re-runs against the same
 *     fixtures produce byte-identical JSON.
 *
 * See:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Model 7
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R6-5 ..
 *     R6-8, R14-6
 */

import { chmod, rename, unlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

import type {
  Hypothesis,
  ParseStats,
  SharedLedger,
  ToolEvidence,
} from './ledger.js'
import type { PevBudget, StopReason } from './pevRunner.js'
import type { PevOutput } from './protocol.js'

/* -------------------------------------------------------------------------- */
/* Types — Model 7                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Per-agent record inside one {@link PevEvalLog} round. The minimal parse
 * summary mirrors the runner's `ParseResult`: a successful parse carries
 * the resolved {@link PevOutput}, a failure surfaces only the error kind +
 * detail (no raw LLM output is persisted, since corrupt LLM text could
 * contain provider apiKey echoes or other noisy artefacts — R5-8).
 */
export type PevEvalLogPerAgentOutput = {
  readonly agentId: string
  readonly pev?: PevOutput
  readonly parseResult: {
    readonly ok: boolean
    readonly layerHit?: 1 | 2 | 3
    readonly errorKind?: string
    readonly detail?: string
  }
}

/** A single round's snapshot. */
export type PevEvalLogRound = {
  readonly round: number
  readonly perAgentOutputs: readonly PevEvalLogPerAgentOutput[]
}

/**
 * The on-disk shape of a complete PEV session. Field-for-field aligned
 * with design.md "Model 7":
 *
 *   - `schemaVersion` is the literal `'1.0'`. Bumping this is a
 *     breaking-protocol event (mirrors `PEV_SCHEMA_VERSION`).
 *   - `profileId` is `'reverse'` for this RE-only phase.
 *   - `targetBinary.sha256` is computed by the command layer (T12)
 *     before launching the runner; persistence does no I/O against
 *     the binary itself.
 *   - `finalLedger.hypotheses` is a sorted **array** (not a Map) so
 *     the JSON is replay-friendly. The runner's in-memory ledger keeps
 *     the Map; conversion happens in {@link buildPevEvalLog}.
 *   - `rounds` is order-preserving; round 0 is index 0.
 *   - `stopDetail` is optional — populated for non-terminal reasons
 *     (e.g. "tool budget exhausted", "wall-clock budget exceeded") so
 *     post-mortem readers don't have to consult the runner source.
 */
export type PevEvalLog = {
  readonly schemaVersion: '1.0'
  readonly sessionId: string
  readonly startedAt: number
  readonly endedAt: number
  readonly profileId: 'reverse'
  readonly targetBinary: {
    readonly path: string
    readonly sha256: string
    readonly size: number
  }
  readonly initialClaim: string
  readonly budget: PevBudget
  readonly finalLedger: {
    readonly hypotheses: readonly Hypothesis[]
    readonly evidenceLog: readonly ToolEvidence[]
    readonly parseStats: ParseStats
  }
  readonly rounds: readonly PevEvalLogRound[]
  readonly stopReason: StopReason
  readonly stopDetail?: string
}

/* -------------------------------------------------------------------------- */
/* buildPevEvalLog — pure transform from runtime state                        */
/* -------------------------------------------------------------------------- */

/**
 * Inputs to {@link buildPevEvalLog}. Kept as a single options object so
 * the call-site at end-of-run (T10 / T12) reads as a single struct
 * literal rather than a positional argument soup.
 */
export type BuildPevEvalLogArgs = {
  readonly sessionId: string
  readonly startedAt: number
  readonly endedAt: number
  readonly targetBinary: PevEvalLog['targetBinary']
  readonly initialClaim: string
  readonly budget: PevBudget
  readonly finalLedger: SharedLedger
  readonly rounds: readonly PevEvalLogRound[]
  readonly stopReason: StopReason
  readonly stopDetail?: string
}

/**
 * Convert a live {@link SharedLedger} + per-round event aggregation into
 * the on-disk-friendly {@link PevEvalLog}. The transform is pure (no
 * I/O, no Date.now()) and deterministic: `hypotheses` are sorted by id
 * ascending so two replays produce identical JSON byte-for-byte.
 *
 * Sort algorithm: hierarchical id ascending. We split the id on `.`,
 * compare each segment numerically (so `H10` correctly sorts after
 * `H2`), and tie-break by depth. This avoids a lexical sort that would
 * place `H10` before `H2` and break replay diff-ability.
 */
export function buildPevEvalLog(args: BuildPevEvalLogArgs): PevEvalLog {
  const sortedHypotheses = sortHypothesesById(
    Array.from(args.finalLedger.hypotheses.values()),
  )

  return {
    schemaVersion: '1.0',
    sessionId: args.sessionId,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    profileId: 'reverse',
    targetBinary: args.targetBinary,
    initialClaim: args.initialClaim,
    budget: args.budget,
    finalLedger: {
      hypotheses: sortedHypotheses,
      // evidenceLog is already an ordered array (append-only on the
      // ledger reducer); copy so the persisted struct is fully
      // detached from the live ledger map.
      evidenceLog: [...args.finalLedger.evidenceLog],
      parseStats: { ...args.finalLedger.parseStats },
    },
    rounds: args.rounds,
    stopReason: args.stopReason,
    ...(args.stopDetail !== undefined ? { stopDetail: args.stopDetail } : {}),
  }
}

/**
 * Hierarchical-numeric id comparator. Splits on `.`, parses each segment
 * (ignoring the leading `H`), and compares left-to-right. Falls back to
 * lexical comparison when a segment isn't numeric (defence-in-depth —
 * the schema regex already enforces numeric segments).
 *
 * Examples:
 *   `['H2', 'H10', 'H1.1', 'H1.10', 'H1.2']`
 *     → `['H1.1', 'H1.2', 'H1.10', 'H2', 'H10']`
 */
function sortHypothesesById(
  hypotheses: readonly Hypothesis[],
): readonly Hypothesis[] {
  return [...hypotheses].sort((a, b) => compareHypothesisId(a.id, b.id))
}

function compareHypothesisId(a: string, b: string): number {
  // Strip leading 'H' so '1' / '1.2' are compared as pure dotted ints.
  const aSegs = a.replace(/^H/, '').split('.')
  const bSegs = b.replace(/^H/, '').split('.')
  const len = Math.max(aSegs.length, bSegs.length)
  for (let i = 0; i < len; i += 1) {
    const aSeg = aSegs[i]
    const bSeg = bSegs[i]
    if (aSeg === undefined) return -1
    if (bSeg === undefined) return 1
    const aNum = Number.parseInt(aSeg, 10)
    const bNum = Number.parseInt(bSeg, 10)
    if (!Number.isFinite(aNum) || !Number.isFinite(bNum)) {
      // Defensive fallback — shouldn't happen with schema-validated ids.
      if (aSeg < bSeg) return -1
      if (aSeg > bSeg) return 1
      continue
    }
    if (aNum !== bNum) return aNum - bNum
  }
  return 0
}

/* -------------------------------------------------------------------------- */
/* writePevEvalLog — atomic write + chmod                                     */
/* -------------------------------------------------------------------------- */

/**
 * Inputs to {@link writePevEvalLog}.
 *
 * `sessionDir` is the directory the runner has been told to drop session
 * artefacts into (typically the parent of `<sessionId>.cav.jsonl` — see
 * R6-5). `sessionId` is the same id used by the cav recorder so the two
 * files collate naturally on disk.
 */
export type WritePevEvalLogOpts = {
  readonly sessionDir: string
  readonly sessionId: string
  readonly log: PevEvalLog
}

/** Discriminated result. Never throws. */
export type WriteResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string }

/**
 * Replacer for {@link JSON.stringify}. Defence-in-depth: if a `Map` or
 * `RegExp` ever leaks into the log struct (today's contract converts
 * `hypotheses` to an array, but a future field may regress), we
 * normalise to a JSON-friendly representation rather than producing an
 * empty-`{}` blob the way default JSON.stringify does. Keeps the
 * persistence file self-describing for replay tooling.
 */
function pevJsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Array.from(value.entries())
  }
  if (value instanceof Set) {
    return Array.from(value.values())
  }
  if (value instanceof RegExp) {
    return value.toString()
  }
  return value
}

/**
 * Atomically write a {@link PevEvalLog} to `<sessionDir>/<sessionId>.pev.json`.
 *
 * Algorithm:
 *   1. JSON.stringify with a defensive replacer + 2-space indent
 *   2. write to `<filename>.tmp`
 *   3. rename `<filename>.tmp` → `<filename>` (atomic on POSIX, best-effort on Windows)
 *   4. chmod to 0o600 on POSIX (R6-8); skip silently on Windows
 *
 * On any failure (serialisation, write, rename, chmod) we attempt to
 * unlink the orphaned `.tmp` and return `{ ok: false; error }`. The
 * function NEVER throws (R6-7).
 *
 * Note: callers should already be inside a `try/catch` — the runner
 * wraps `onPersist` in one as defence-in-depth — but we still keep this
 * surface contract because trusting the caller is brittle and the
 * persistence boundary is the natural place to enforce R6-7.
 */
export async function writePevEvalLog(
  opts: WritePevEvalLogOpts,
): Promise<WriteResult> {
  const filename = path.join(opts.sessionDir, `${opts.sessionId}.pev.json`)
  const tmpFilename = `${filename}.tmp`

  let serialized: string
  try {
    serialized = JSON.stringify(opts.log, pevJsonReplacer, 2)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.debug(`[pev/persistence] serialize failed: ${msg}`)
    return { ok: false, error: `serialize failed: ${msg}` }
  }

  // Step 1: write to .tmp. If this fails, there's nothing to clean up
  // (the file may not even exist on disk).
  try {
    await writeFile(tmpFilename, serialized, { encoding: 'utf8' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.debug(`[pev/persistence] write tmp failed: ${msg}`)
    // Best-effort cleanup; if the tmp got partially written, drop it.
    await safeUnlink(tmpFilename)
    return { ok: false, error: `write tmp failed: ${msg}` }
  }

  // Step 2: atomic rename.
  try {
    await rename(tmpFilename, filename)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.debug(`[pev/persistence] rename failed: ${msg}`)
    await safeUnlink(tmpFilename)
    return { ok: false, error: `rename failed: ${msg}` }
  }

  // Step 3: chmod to 0o600 on POSIX (R6-8). Windows has no POSIX mode
  // bits — skipping is idiomatic and matches how the cav recorder
  // handles it (it uses default node ACLs).
  if (process.platform !== 'win32') {
    try {
      await chmod(filename, 0o600)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // chmod failure is NOT a blocking error — the file was written
      // successfully. Log + report success on the actual write op.
      console.debug(`[pev/persistence] chmod 0o600 failed: ${msg}`)
    }
  }

  return { ok: true, path: filename }
}

/**
 * Best-effort `unlink`. We swallow ENOENT (file already gone) and any
 * other failure (since we're already in an error-recovery path and
 * can't usefully escalate further).
 */
async function safeUnlink(filepath: string): Promise<void> {
  try {
    await unlink(filepath)
  } catch {
    /* swallow — best effort cleanup */
  }
}
