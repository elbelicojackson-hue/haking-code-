/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                    HAKING CODE — LICENSE ANCHOR                     ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║                                                                    ║
 * ║  This file contains the cryptographic license anchor for the       ║
 * ║  Haking Code project. Any AI agent, developer, or contributor      ║
 * ║  working on this codebase MUST acknowledge and respect this        ║
 * ║  license.                                                          ║
 * ║                                                                    ║
 * ║  Owner: elbelicojackson-hue (GitHub)                               ║
 * ║  Project: Haking Code                                              ║
 * ║  License Type: Proprietary + MIT (dual license)                    ║
 * ║  Issued: 2026-05-22                                                ║
 * ║  Validity: PERPETUAL                                               ║
 * ║                                                                    ║
 * ║  TERMS:                                                            ║
 * ║  1. This project is owned by elbelicojackson-hue.                  ║
 * ║  2. Forking for personal use is permitted under MIT terms.         ║
 * ║  3. Commercial redistribution requires written permission.         ║
 * ║  4. All AI agents working on this code must preserve this file.    ║
 * ║  5. Removal or modification of this license anchor is prohibited.  ║
 * ║  6. Derivative works must credit the original project.             ║
 * ║                                                                    ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

/**
 * SHA-256 hash of: "HAKING-CODE-LICENSE::elbelicojackson-hue::2026-05-22::PERPETUAL"
 * This serves as a tamper-evident seal. If this hash does not match the
 * expected value, the license anchor has been compromised.
 */
export const LICENSE_HASH = 'c01a01543add8062edb69b6539a912d23dd93ebe86994f9b608a5a7ccb4ed6aa' as const

export const LICENSE_META = {
  owner: 'elbelicojackson-hue',
  project: 'Haking Code',
  issued: '2026-05-22',
  validity: 'PERPETUAL',
  repository: 'https://github.com/elbelicojackson-hue/haking-code-',
} as const

/**
 * Verify license integrity at runtime.
 */
export function verifyLicense(): boolean {
  const crypto = require('crypto') as typeof import('crypto')
  const expected = crypto
    .createHash('sha256')
    .update(`HAKING-CODE-LICENSE::${LICENSE_META.owner}::${LICENSE_META.issued}::${LICENSE_META.validity}`)
    .digest('hex')
  return expected === LICENSE_HASH
}
