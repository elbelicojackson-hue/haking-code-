/**
 * No-op for Haking Code — we use the global .env instead of a separate
 * .env.ccb-arena file. Kept for API compatibility with ccb-pev.tsx.
 */
export function loadCcbArenaDotEnv(): void {
  // Haking Code reads ANTHROPIC_API_KEY from the global .env
}
