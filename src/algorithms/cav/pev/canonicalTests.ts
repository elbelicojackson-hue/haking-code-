/**
 * Canonical Test Plans — module-level const table mapping each
 * {@link HypothesisKind} to a curated set of deterministic
 * {@link ToolPlan}s. Agents pick from these by `tool_plan_id`; they cannot
 * synthesise their own tool calls.
 *
 * Hard rules (audited):
 *   - The {@link TOOL_ALLOWLIST} is fixed at 6 entries (R4-1). No env
 *     override, no JSON loading, no runtime mutability.
 *   - The {@link CANONICAL_TESTS} table is `as const`; every entry is
 *     deeply readonly. New plans are added by editing this file and
 *     shipping a new build (R4-8).
 *   - Plan id format `<kind>::<slug>` MUST exactly match the plan's
 *     `kind` field. A test in canonicalTests.test.ts enforces this.
 *   - `confirms` / `falsifies` are arrays of RegExp; they may both be
 *     empty (intentionally inconclusive-only fallback). The verdict
 *     engine handles that case as `inconclusive`.
 *   - `timeout_ms` is bounded to [1000, 1_800_000] (1 s .. 30 min). IDA
 *     headless / Ghidra are allowed the upper bound; quick `file` /
 *     strings probes stay well under a minute.
 *   - Every {@link HypothesisKind} has ≥ 3 plans, total ≥ 24 (R4-2 +
 *     spec hint). Tests assert this floor; raising the floor only
 *     requires adding more plans, never editing the assertion.
 *
 * Cross-references:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 5,
 *     Model 3, Property 4
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R4-1 ..
 *     R4-9, R14-4
 */

import type { HypothesisKind } from './protocol.js'

/* -------------------------------------------------------------------------- */
/* ToolName + Allowlist                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The 6 tools PEV is allowed to invoke. The list is closed: introducing a
 * new tool requires editing this union and adding a corresponding plan.
 * Validators and verdict-engine code assume this is exhaustive.
 */
export type ToolName =
  | 'ReverseCli'
  | 'Bash'
  | 'Read'
  | 'Grep'
  | 'WebSearch'
  | 'Firecrawl'

/**
 * Runtime mirror of {@link ToolName} for set-membership checks. Frozen
 * implicitly via `as const`; tests assert that every plan's `tool` field
 * is included here.
 */
export const TOOL_ALLOWLIST: readonly ToolName[] = [
  'ReverseCli',
  'Bash',
  'Read',
  'Grep',
  'WebSearch',
  'Firecrawl',
] as const

/* -------------------------------------------------------------------------- */
/* ToolPlan shape                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One canonical test plan. The model receives the `id`/`description`/
 * `overridable_fields` triple in its prompt, then proposes a
 * `next_action.tool_call` referencing the id. The runner merges
 * `base_args` with the agent-supplied `args_override` (filtered to
 * `overridable_fields`) before invoking the tool.
 *
 * `confirms` / `falsifies` are RegExp arrays scanned over the tool's
 * stdout by the verdict engine (T6). First match wins; pattern conflict
 * (both lists hit) yields `inconclusive`.
 */
export type ToolPlan = {
  /** Unique id, lowercase, format `<kind>::<slug>` (e.g. `packer::diec`). */
  readonly id: string
  /** Hypothesis kind the plan targets; MUST equal the id's prefix. */
  readonly kind: HypothesisKind
  /** Backing tool — must be in {@link TOOL_ALLOWLIST}. */
  readonly tool: ToolName
  /** Default arguments passed to the tool when the agent omits overrides. */
  readonly base_args: Readonly<Record<string, unknown>>
  /**
   * White-list of `base_args` keys the agent may override via
   * `next_action.tool_call.args_override`. Empty array means the plan is
   * fully fixed.
   */
  readonly overridable_fields: readonly string[]
  /** Patterns whose match in stdout flips the verdict to `confirms`. */
  readonly confirms: readonly RegExp[]
  /** Patterns whose match in stdout flips the verdict to `falsifies`. */
  readonly falsifies: readonly RegExp[]
  /** Hard wall-clock cap. Bounded to [1000, 1_800_000] ms (R4-9). */
  readonly timeout_ms: number
  /** Coarse cost hint — used by the scheduler/UI, not by verdict engine. */
  readonly cost_estimate: 'tiny' | 'small' | 'medium' | 'large'
  /** Human-readable one-liner for the prompt + UI. */
  readonly description: string
}

/* -------------------------------------------------------------------------- */
/* CANONICAL_TESTS table                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The full registry of canonical test plans, keyed by plan id.
 *
 * Coverage targets (asserted by tests):
 *   - 8 hypothesis kinds × ≥ 3 plans each → ≥ 24 entries.
 *   - Every `tool` is in {@link TOOL_ALLOWLIST}.
 *   - Every id matches `^<kind>::<slug>$` and the kind prefix equals
 *     `kind`.
 *   - Every `timeout_ms` is in `[1000, 1_800_000]`.
 *
 * Adding a new plan: pick a free `<kind>::<slug>` id, fill all fields,
 * commit. There is no runtime registration path.
 */
export const CANONICAL_TESTS: Readonly<Record<string, ToolPlan>> = {
  /* ------------------------------ file-class ------------------------------ */

  'file-class::file-cmd': {
    id: 'file-class::file-cmd',
    kind: 'file-class',
    tool: 'Bash',
    base_args: { command: 'file "$TARGET"' },
    overridable_fields: ['command'],
    confirms: [
      /PE32\+?\s+executable/i,
      /ELF\s+(?:32|64)-bit/i,
      /Mach-O\s+(?:64-bit|universal|fat)/i,
    ],
    falsifies: [
      /ASCII\s+text/i,
      /(?:UTF-8|UTF-16)\s+Unicode\s+text/i,
      /empty/i,
    ],
    timeout_ms: 5_000,
    cost_estimate: 'tiny',
    description: 'Run libmagic `file` on the target to identify the binary container format.',
  },

  'file-class::pe-header-read': {
    id: 'file-class::pe-header-read',
    kind: 'file-class',
    tool: 'ReverseCli',
    base_args: { action: 'pe-header' },
    overridable_fields: ['targetPath'],
    confirms: [/Machine:\s*(?:0x14c|0x8664|i386|AMD64)/i, /PE\s+signature\s+OK/i],
    falsifies: [/not\s+a\s+PE\s+file/i, /invalid\s+DOS\s+header/i],
    timeout_ms: 10_000,
    cost_estimate: 'tiny',
    description: 'Parse the PE header (DOS stub + NT headers) to confirm the file is a valid PE binary.',
  },

  'file-class::elf-readelf': {
    id: 'file-class::elf-readelf',
    kind: 'file-class',
    tool: 'Bash',
    base_args: { command: 'readelf -h "$TARGET"' },
    overridable_fields: ['command'],
    confirms: [/ELF\s+Header:/i, /Class:\s+ELF(?:32|64)/i],
    falsifies: [/Not\s+an\s+ELF\s+file/i, /Error:\s+not\s+an\s+ELF/i],
    timeout_ms: 5_000,
    cost_estimate: 'tiny',
    description: 'Run `readelf -h` to dump the ELF header and confirm Linux/BSD container format.',
  },

  /* -------------------------------- packer -------------------------------- */

  'packer::diec': {
    id: 'packer::diec',
    kind: 'packer',
    tool: 'ReverseCli',
    base_args: { action: 'diec', diecArgs: ['-e', '-r'] },
    overridable_fields: ['targetPath', 'diecArgs'],
    confirms: [/UPX|VMProtect|Themida|Enigma|MoleBox|ASPack|MPRESS|PECompact|Petite/i],
    falsifies: [/^\s*$/, /not\s+packed/i, /no\s+packer\s+detected/i],
    timeout_ms: 30_000,
    cost_estimate: 'small',
    description: 'Detect It Easy: enumerate packer/protector signatures via -e -r.',
  },

  'packer::upx-test': {
    id: 'packer::upx-test',
    kind: 'packer',
    tool: 'ReverseCli',
    base_args: { action: 'upx', upxArgs: ['-t'] },
    overridable_fields: ['targetPath', 'upxArgs'],
    confirms: [/tested\s+ok/i],
    falsifies: [/not\s+packed\s+by\s+upx/i, /can(?:'|)t\s+unpack/i, /NotPackedException/i],
    timeout_ms: 60_000,
    cost_estimate: 'small',
    description: 'UPX self-test: `upx -t` confirms the binary is a valid UPX-packed file.',
  },

  'packer::vmprotect-probe': {
    id: 'packer::vmprotect-probe',
    kind: 'packer',
    tool: 'Bash',
    base_args: { command: 'strings "$TARGET" | grep -iE "vmprotect|themida|winlicense"' },
    overridable_fields: ['command'],
    confirms: [/VMProtect/i, /Themida/i, /WinLicense/i],
    falsifies: [/^\s*$/],
    timeout_ms: 30_000,
    cost_estimate: 'small',
    description: 'Probe stringified binary for VMProtect/Themida marker strings.',
  },

  /* ------------------------------ compiler -------------------------------- */

  'compiler::diec-probe': {
    id: 'compiler::diec-probe',
    kind: 'compiler',
    tool: 'ReverseCli',
    base_args: { action: 'diec', diecArgs: ['-e'] },
    overridable_fields: ['targetPath', 'diecArgs'],
    confirms: [
      /Compiler:\s*(?:Microsoft Visual C\/C\+\+|MinGW|GCC|Clang|Rust|Go|MSVC)/i,
      /Linker:\s*Microsoft Linker/i,
    ],
    falsifies: [/^\s*$/, /unknown\s+compiler/i],
    timeout_ms: 30_000,
    cost_estimate: 'small',
    description: 'Detect It Easy compiler/linker fingerprint pass.',
  },

  'compiler::dnspy-probe': {
    id: 'compiler::dnspy-probe',
    kind: 'compiler',
    tool: 'Bash',
    base_args: { command: 'file "$TARGET"' },
    overridable_fields: ['command'],
    confirms: [/Mono\/\.Net\s+assembly/i, /\.NET\s+assembly/i],
    falsifies: [/PE32\+?\s+executable\s+\(console\)\s+Intel\s+80386/i],
    timeout_ms: 5_000,
    cost_estimate: 'tiny',
    description: 'Identify a .NET / Mono assembly via libmagic signature.',
  },

  'compiler::go-probe': {
    id: 'compiler::go-probe',
    kind: 'compiler',
    tool: 'Bash',
    base_args: {
      command: "strings \"$TARGET\" | grep -E 'Go build ID|runtime\\.goexit|go\\.buildinfo'",
    },
    overridable_fields: ['command'],
    confirms: [/Go\s+build\s+ID/i, /runtime\.goexit/i, /go\.buildinfo/i],
    falsifies: [/^\s*$/],
    timeout_ms: 30_000,
    cost_estimate: 'small',
    description: 'Search for Go runtime markers (`Go build ID`, `runtime.goexit`).',
  },

  /* -------------------------------- family -------------------------------- */

  'family::strings-grep': {
    id: 'family::strings-grep',
    kind: 'family',
    tool: 'ReverseCli',
    base_args: { action: 'strings', stringsArgs: ['-n', '8'] },
    overridable_fields: ['targetPath', 'stringsArgs'],
    confirms: [
      /Emotet|TrickBot|Qakbot|IcedID|Cobalt\s*Strike|Mimikatz|LokiBot|AgentTesla/i,
    ],
    falsifies: [],
    timeout_ms: 60_000,
    cost_estimate: 'small',
    description: 'Extract printable strings (≥ 8 chars) and look for known malware family markers.',
  },

  'family::yara-scan': {
    id: 'family::yara-scan',
    kind: 'family',
    tool: 'Bash',
    base_args: { command: 'yara -r "$RULES" "$TARGET"' },
    overridable_fields: ['command'],
    confirms: [/^\S+\s+\S+\s*$/m],
    falsifies: [/^\s*$/, /no\s+rules\s+matched/i],
    timeout_ms: 120_000,
    cost_estimate: 'medium',
    description: 'Run YARA rule-set against the target; any match implies family attribution.',
  },

  'family::imphash-lookup': {
    id: 'family::imphash-lookup',
    kind: 'family',
    tool: 'ReverseCli',
    base_args: { action: 'imphash' },
    overridable_fields: ['targetPath'],
    confirms: [/[a-f0-9]{32}/i],
    falsifies: [/no\s+import\s+table/i, /imphash:\s*$/i],
    timeout_ms: 15_000,
    cost_estimate: 'tiny',
    description: 'Compute the PE imphash and emit it for VirusTotal/MalwareBazaar pivot.',
  },

  /* ------------------------------- algorithm ------------------------------ */

  'algorithm::ida-script-dump': {
    id: 'algorithm::ida-script-dump',
    kind: 'algorithm',
    tool: 'Bash',
    base_args: {
      command: 'ida64 -A -S"$SCRIPT" -L"$LOG" "$TARGET" && cat "$LOG"',
    },
    overridable_fields: ['command'],
    confirms: [
      /AES_(?:encrypt|decrypt)/i,
      /RC4_(?:init|crypt)/i,
      /ChaCha20|Salsa20/i,
      /MD5|SHA-?1|SHA-?256|SHA-?512/i,
    ],
    falsifies: [/IDA\s+script\s+failed/i],
    timeout_ms: 1_800_000,
    cost_estimate: 'large',
    description: 'IDA Pro headless run that dumps function names + xrefs for crypto primitives.',
  },

  'algorithm::ghidra-headless': {
    id: 'algorithm::ghidra-headless',
    kind: 'algorithm',
    tool: 'Bash',
    base_args: {
      command:
        'analyzeHeadless "$PROJECT_DIR" pevTmp -import "$TARGET" -postScript ListCrypto.java',
    },
    overridable_fields: ['command'],
    confirms: [/CRYPTO_FOUND:\s*(?:AES|RSA|RC4|ChaCha|SHA|MD5)/i],
    falsifies: [/CRYPTO_FOUND:\s*NONE/i, /Headless\s+analysis\s+failed/i],
    timeout_ms: 1_800_000,
    cost_estimate: 'large',
    description: 'Ghidra `analyzeHeadless` with a post-script that lists detected crypto routines.',
  },

  'algorithm::strings-crypto-tokens': {
    id: 'algorithm::strings-crypto-tokens',
    kind: 'algorithm',
    tool: 'Grep',
    base_args: {
      pattern: 'AES|RSA|RC4|ChaCha20|Salsa20|XSalsa|MD5|SHA-?(?:1|256|512)|Blowfish|Twofish',
    },
    overridable_fields: ['pattern'],
    confirms: [/AES|RSA|RC4|ChaCha20|Salsa20|MD5|SHA-?(?:1|256|512)|Blowfish|Twofish/i],
    falsifies: [],
    timeout_ms: 30_000,
    cost_estimate: 'tiny',
    description: 'Grep for crypto primitive tokens across extracted strings.',
  },

  /* ----------------------------- anti-analysis ---------------------------- */

  'anti-analysis::strings-grep': {
    id: 'anti-analysis::strings-grep',
    kind: 'anti-analysis',
    tool: 'Bash',
    base_args: {
      command:
        'strings "$TARGET" | grep -iE "IsDebuggerPresent|CheckRemoteDebuggerPresent|NtQueryInformationProcess|OutputDebugString|ZwSetInformationThread"',
    },
    overridable_fields: ['command'],
    confirms: [
      /IsDebuggerPresent/i,
      /CheckRemoteDebuggerPresent/i,
      /NtQueryInformationProcess/i,
      /ZwSetInformationThread/i,
    ],
    falsifies: [/^\s*$/],
    timeout_ms: 30_000,
    cost_estimate: 'small',
    description: 'Look for classic anti-debug API name strings in the binary.',
  },

  'anti-analysis::ida-anti-debug-scan': {
    id: 'anti-analysis::ida-anti-debug-scan',
    kind: 'anti-analysis',
    tool: 'Bash',
    base_args: {
      command: 'ida64 -A -S"$ANTIDEBUG_SCRIPT" -L"$LOG" "$TARGET" && cat "$LOG"',
    },
    overridable_fields: ['command'],
    confirms: [
      /ANTIDEBUG:\s*(?:PEB\.BeingDebugged|RDTSC|GetTickCount|NtGlobalFlag)/i,
    ],
    falsifies: [/ANTIDEBUG:\s*NONE/i],
    timeout_ms: 1_800_000,
    cost_estimate: 'large',
    description: 'IDA headless scan for PEB.BeingDebugged, NtGlobalFlag, RDTSC timing patterns.',
  },

  'anti-analysis::tls-callback-check': {
    id: 'anti-analysis::tls-callback-check',
    kind: 'anti-analysis',
    tool: 'ReverseCli',
    base_args: { action: 'pe-header', peHeaderArgs: ['--tls'] },
    overridable_fields: ['targetPath', 'peHeaderArgs'],
    confirms: [/TLS\s+Directory:\s*(?!0x0+\b)/i, /TLS\s+callback\s+address:/i],
    falsifies: [/TLS\s+Directory:\s*0x0+\b/i, /no\s+TLS\s+directory/i],
    timeout_ms: 10_000,
    cost_estimate: 'tiny',
    description: 'Read the PE TLS directory; non-zero RVA → TLS callback present.',
  },

  /* ------------------------------- capability ----------------------------- */

  'capability::imports-table': {
    id: 'capability::imports-table',
    kind: 'capability',
    tool: 'ReverseCli',
    base_args: { action: 'imports' },
    overridable_fields: ['targetPath'],
    confirms: [
      /WS2_32\.dll|WININET\.dll|URLMON\.dll|CRYPT32\.dll|ADVAPI32\.dll|WINHTTP\.dll/i,
    ],
    falsifies: [/no\s+imports/i, /^\s*$/],
    timeout_ms: 15_000,
    cost_estimate: 'tiny',
    description: 'Dump the PE/ELF import table to enumerate API capabilities (network, crypto, registry).',
  },

  'capability::tshark-traffic': {
    id: 'capability::tshark-traffic',
    kind: 'capability',
    tool: 'Bash',
    base_args: { command: 'tshark -r "$CAPTURE" -q -z io,phs' },
    overridable_fields: ['command'],
    confirms: [/(?:tcp|udp|http|tls|dns)\b\s+frames:\s*\d+/i],
    falsifies: [/^\s*$/, /0\s+packets/i],
    timeout_ms: 120_000,
    cost_estimate: 'medium',
    description: 'Run tshark protocol-hierarchy stats on a recorded pcap to enumerate traffic capabilities.',
  },

  'capability::syscall-trace': {
    id: 'capability::syscall-trace',
    kind: 'capability',
    tool: 'Bash',
    base_args: { command: 'strace -f -e trace=network,file -o "$LOG" "$TARGET" || cat "$LOG"' },
    overridable_fields: ['command'],
    confirms: [/(?:socket|connect|sendto|openat|execve)\(/],
    falsifies: [/^\s*$/, /No\s+such\s+file\s+or\s+directory/i],
    timeout_ms: 600_000,
    cost_estimate: 'large',
    description: 'strace network + file syscalls; long-running, used for dynamic capability inventory.',
  },

  /* -------------------------------- protocol ------------------------------ */

  'protocol::tshark': {
    id: 'protocol::tshark',
    kind: 'protocol',
    tool: 'Bash',
    base_args: { command: 'tshark -r "$CAPTURE" -Y "http or http2 or tls" -T fields -e _ws.col.Protocol' },
    overridable_fields: ['command'],
    confirms: [/HTTP\/(?:1\.1|2)/i, /TLSv1\.[23]/i, /QUIC/i],
    falsifies: [/^\s*$/, /No\s+packets\s+matched/i],
    timeout_ms: 120_000,
    cost_estimate: 'medium',
    description: 'Filter pcap on application protocols with tshark to confirm wire format.',
  },

  'protocol::mitm-capture': {
    id: 'protocol::mitm-capture',
    kind: 'protocol',
    tool: 'Bash',
    base_args: {
      command: 'mitmdump -r "$FLOWS" --set console_eventlog_verbosity=info -n',
    },
    overridable_fields: ['command'],
    confirms: [
      /\bGET\s+\//i,
      /\bPOST\s+\//i,
      /Content-Type:\s*application\/(?:json|grpc|x-protobuf)/i,
    ],
    falsifies: [/^\s*$/, /no\s+flows\s+to\s+replay/i],
    timeout_ms: 300_000,
    cost_estimate: 'medium',
    description: 'Replay a mitmproxy flow file to inspect HTTP/gRPC payload shape.',
  },

  'protocol::strings-protocol-tokens': {
    id: 'protocol::strings-protocol-tokens',
    kind: 'protocol',
    tool: 'Grep',
    base_args: {
      pattern: 'HTTP/(?:1\\.0|1\\.1|2)|gRPC|MQTT|AMQP|XMPP|SMTP|IMAP|FTP|SOCKS5|WebSocket',
    },
    overridable_fields: ['pattern'],
    confirms: [/HTTP\/(?:1\.0|1\.1|2)/i, /gRPC|MQTT|AMQP|XMPP|SMTP|SOCKS5|WebSocket/i],
    falsifies: [],
    timeout_ms: 30_000,
    cost_estimate: 'tiny',
    description: 'Grep extracted strings for application-protocol tokens.',
  },
} as const

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * All known plan ids as a frozen set, useful for fast membership checks
 * (e.g. validator.ts cross-checking `next_action.tool_plan_id`).
 *
 * Computed once at module load — the set is `as const` opaque to callers.
 */
export const ALL_TOOL_PLAN_IDS: ReadonlySet<string> = new Set(
  Object.keys(CANONICAL_TESTS),
)

/**
 * Return all plans for a given hypothesis kind, in declaration order.
 *
 * @param kind  One of the 8 {@link HypothesisKind} values.
 * @returns     Readonly array of every plan whose `kind` matches; empty
 *              array if the table somehow has none (tests assert ≥ 1).
 */
export function getToolPlansForKind(
  kind: HypothesisKind,
): readonly ToolPlan[] {
  const out: ToolPlan[] = []
  for (const plan of Object.values(CANONICAL_TESTS)) {
    if (plan.kind === kind) out.push(plan)
  }
  return out
}

/**
 * Look up a plan by its id. Returns `undefined` if unknown — callers
 * (validator, runner) treat that as `errorKind: 'unknown-tool-plan'`.
 *
 * Implementation note: a `Record` lookup is O(1) and keeps the table the
 * single source of truth (no parallel index to drift).
 */
export function findToolPlan(id: string): ToolPlan | undefined {
  return Object.prototype.hasOwnProperty.call(CANONICAL_TESTS, id)
    ? CANONICAL_TESTS[id]
    : undefined
}
