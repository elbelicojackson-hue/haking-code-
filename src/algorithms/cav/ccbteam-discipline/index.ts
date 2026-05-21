/**
 * Discipline Layer — barrel re-exports.
 *
 * The command layer imports R12/R13 surface from here exclusively. The
 * R5-3 static-scan whitelist treats this module as a "boundary entry"
 * (analogous to `ccbteam-math/sidecar.ts`). Math Layer internals are
 * NOT re-exported here.
 *
 * Cross-references:
 *   - .kiro/specs/super-agent-cluster/requirements.md → R12 / R13
 *   - .kiro/specs/super-agent-cluster/design.md → "Component 5 / 6"
 */

export {
  applyInvocationGate,
  renderInvocationGateSection,
  renderAntiPatternsSection,
  MAX_GATE_APPENDIX_BYTES,
} from './invocationGate.js'

export { buildEpistemicHonestyBlock } from './epistemicBlock.js'

export {
  EpistemicVerdictSchema,
  parseAndCheckEpistemic,
} from './epistemicParser.js'

export type {
  EpistemicParseResult,
  EpistemicPriorFlags,
  EpistemicVerdict,
  EpistemicViolation,
  EpistemicRuleId,
  KnowledgeZone,
} from '../ccbteam-math/types.js'
