import type { Command } from '../../commands.js'

/**
 * `/recon <target> [goal]` — Automated reconnaissance & reverse engineering.
 *
 * Haking Code's built-in recon engine powered by the PEV (Plan-Execute-Verify)
 * hypothesis-driven loop. Agents propose hypotheses about the target, dispatch
 * canonical security tools, and a verdict engine auto-judges results.
 *
 * Hypothesis kinds: file-class, packer, compiler, family, algorithm,
 * anti-analysis, capability, protocol.
 *
 * Usage:
 *   /recon ./malware.exe
 *   /recon ./suspicious.dll "identify C2 protocol"
 *   /recon ./packed.bin --max-rounds=10
 */
const recon = {
  type: 'local-jsx',
  name: 'recon',
  aliases: ['pev', 'reverse'],
  description:
    'Automated recon — hypothesis-driven reverse engineering with canonical security tools',
  load: () => import('./ccb-pev.js'),
} satisfies Command

export default recon
