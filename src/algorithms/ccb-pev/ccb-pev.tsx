/**
 * `/ccb-pev` command entry point — PEV (Plan-Execute-Verify) loop for
 * reverse engineering. T12 ships a MINIMAL implementation: argument
 * parsing, binary existence + sha256, provider loading, and a small
 * Ink wrapper that drives `runPev` from the existing CCB-Arena
 * dispatcher. The rich UI (hypothesis tree view, evidence log,
 * per-agent status bar) is owned by T13 (PevSession.tsx); the real
 * tool routing (ReverseCli wired to canonical plans) is owned by T14.
 *
 * Cross-references:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 10
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R11, R13-2
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

import { dispatchArena } from '../../services/cav/arena/dispatcher.js'
import { loadCcbArenaDotEnv } from '../../services/cav/arena/loadDotEnv.js'
import {
  loadArenaProviders,
  type ArenaProvider,
} from '../../services/cav/arena/providers.js'
import {
  type PevRunOpts,
  type ProviderAdapterResult,
  type ToolAdapterResult,
} from '../cav/pev/pevRunner.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

import { parseArgs, type CcbPevBudget } from './parseArgs.js'
import { PevSession } from './PevSession.js'

/* -------------------------------------------------------------------------- */
/* call entry-point                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Slash-command entry. Five preflight checks (R11, R13-2):
 *   1. `CCB_PEV_DISABLED=1` short-circuit (R13-2)
 *   2. argument parse (R11-1, R11-2, R11-7)
 *   3. binary existence + read permission (R11-1)
 *   4. sha256 hash of the binary (audit trail in PevEvalLog.targetBinary)
 *   5. CCB-Arena provider load — ≥ 2 providers required, otherwise the
 *      arena would be a no-op
 *
 * Each failure path calls `onDone(string, { display: 'system' })` with a
 * human-readable explanation and returns null (no Ink render). Success
 * mounts `<PevSession />` which drives `runPev` end-to-end.
 */
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  // 1. Disable kill-switch (R13-2). Honour either the literal '1' or
  //    'true' so docs/scripts can use either.
  const disabled = process.env.CCB_PEV_DISABLED ?? ''
  if (disabled === '1' || disabled.toLowerCase() === 'true') {
    onDone('PEV is disabled (CCB_PEV_DISABLED is set).', {
      display: 'system',
    })
    return null
  }

  // 2. Argument parse.
  const parsed = parseArgs(args ?? '')
  if (!parsed.ok) {
    onDone(parsed.error, { display: 'system' })
    return null
  }

  // 3. Binary existence + read permission. We deliberately do NOT
  //    follow symlinks specially — `statSync` follows by default and
  //    `readFileSync` will error if the linked target isn't readable.
  let size: number
  try {
    const st = statSync(parsed.args.targetBinary)
    if (!st.isFile()) {
      onDone(
        `目标二进制不存在或不可读: ${parsed.args.targetBinary} (not a regular file)`,
        { display: 'system' },
      )
      return null
    }
    size = st.size
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onDone(
      `目标二进制不存在或不可读: ${parsed.args.targetBinary} (${msg})`,
      { display: 'system' },
    )
    return null
  }

  // 4. SHA-256. We use sync I/O because the slash command is already
  //    blocking the user's REPL turn — adding async streaming here just
  //    complicates the UX without measurable wins (RE binaries are
  //    typically < 50MB, well under the 1s threshold for a sync hash).
  let sha256: string
  try {
    const buf = readFileSync(parsed.args.targetBinary)
    sha256 = createHash('sha256').update(buf).digest('hex')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onDone(`无法读取目标二进制以计算 sha256: ${msg}`, {
      display: 'system',
    })
    return null
  }

  // 5. CCB-Arena providers. Re-uses the existing `.env.ccb-arena`
  //    loader (idempotent — calling it twice in a session is fine).
  loadCcbArenaDotEnv()
  const providers = loadArenaProviders()
  if (providers.length < 1) {
    onDone(
      `Recon 需要至少 1 个 LLM provider。请设置 ANTHROPIC_API_KEY 环境变量。`,
      { display: 'system' },
    )
    return null
  }

  return (
    <PevSession
      targetBinary={{
        path: parsed.args.targetBinary,
        sha256,
        size,
      }}
      goal={parsed.args.goal}
      budget={parsed.args.budget}
      providers={providers}
      onDone={onDone}
      providerAdapter={buildProviderAdapter()}
      toolAdapter={buildStubToolAdapter()}
    />
  )
}

/* -------------------------------------------------------------------------- */
/* Adapters                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build a `providerAdapter` that wraps the existing `dispatchArena`.
 *
 * `dispatchArena` is multi-provider: we drive it one provider at a time
 * by passing a single-element array. This costs us no parallelism (the
 * runner already kicks off all providers in `Promise.all`) and gives us
 * the same retry / timeout / redaction behaviour for free.
 *
 * Failures are mapped to an empty `content` string so the parser can
 * surface a `json-parse-failed` result rather than the runner having to
 * special-case provider errors.
 */
function buildProviderAdapter(): NonNullable<PevRunOpts['providerAdapter']> {
  return async (provider, systemPrompt, userPrompt, signal) => {
    const responses = await dispatchArena(
      [provider],
      {
        system: systemPrompt,
        user: userPrompt,
        temperature: 0.7,
        maxTokens: 4096,
      },
      signal,
    )
    const r = responses[0]
    if (!r || r.kind !== 'ok') {
      return { content: '' } satisfies ProviderAdapterResult
    }
    return { content: r.text } satisfies ProviderAdapterResult
  }
}

/**
 * T12 stub `toolAdapter`. Real wiring (route to ReverseCli / Bash / Read
 * / Grep / WebSearch / Firecrawl through the builtin-tools API) is the
 * scope of T14. Here we just emit a clear inconclusive marker so any
 * agent that picks `next_action: tool_call` sees a non-success exit and
 * reports `inconclusive` evidence — the runner keeps making progress,
 * just slower.
 */
function buildStubToolAdapter(): NonNullable<PevRunOpts['toolAdapter']> {
  return async (_plan, _args, _signal) => {
    return {
      stdout:
        '[ccb-pev] tool execution not implemented; T14 will wire ReverseCli',
      exitCode: 1,
      durationMs: 0,
    } satisfies ToolAdapterResult
  }
}
