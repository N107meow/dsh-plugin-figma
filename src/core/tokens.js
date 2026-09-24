/**
 * Size accounting for the budget stage.
 *
 * ## This is an approximation, and it says so on purpose
 *
 * There is no offline-callable tokenizer for the target model in this
 * deployment, so `CHARS_PER_TOKEN` is an engineering approximation
 * (docs/PLAN.md section 10 records it as such). Use these numbers to **decide**
 * (tighten depth, spill to disk, report cost to the model) — never to
 * **assert** exactness in a test or a user-facing claim.
 *
 * @module figma-mcp-dsh/core/tokens
 */

/**
 * Approximate characters per token.
 *
 * Measured against the shapes this plugin produces (compact JSON with a lot of
 * hex colors and short identifiers). CJK text tokenizes worse than this, which
 * errs on the safe side: the budget tightens earlier than strictly necessary.
 */
export const CHARS_PER_TOKEN = 3.6

/**
 * Approximate token count of a string.
 *
 * @param {string} s - Text to measure.
 * @returns {number} Rounded-up token estimate; `0` for empty input.
 */
export function estimateTokens(s) {
  if (typeof s !== 'string' || s.length === 0) return 0
  return Math.ceil(s.length / CHARS_PER_TOKEN)
}

/**
 * Exact UTF-8 byte length of a string.
 *
 * @param {string} s - Text to measure.
 * @returns {number} Byte length.
 */
export function estimateBytes(s) {
  if (typeof s !== 'string') return 0
  return Buffer.byteLength(s, 'utf8')
}

/**
 * Compact, stable JSON text used everywhere a payload is measured or cached.
 *
 * Key order follows insertion order, so callers that build the same object the
 * same way produce byte-identical text — which is what makes cached sizes and
 * spool names reproducible.
 *
 * @param {unknown} value - Any lossless JSON value.
 * @returns {string} Compact JSON.
 */
export function serialize(value) {
  return JSON.stringify(value) ?? 'null'
}
