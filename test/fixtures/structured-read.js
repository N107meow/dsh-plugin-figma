/**
 * Shared read helper for the live Figma suites.
 *
 * ## Why this is a module rather than a function in each suite
 *
 * A live failure arrives as a **successful** call carrying a structured error —
 * channel A, where the tool never throws so the model always gets an executable
 * remedy. A check that asserts `result.ok` therefore reports `false !== true`
 * and discards the reason.
 *
 * That is not hypothetical. On this project's first live P1 run, a spent Tier 1
 * allowance made two checks fail in exactly that shape: two bare assertion
 * failures, while the `rate_limited` verdict — carrying `Retry-After`, the
 * seat-tier hint, and Figma's upgrade link — was thrown away. The failure was
 * diagnosable only because a 20-second duration happened to be visible.
 *
 * Turning that shape into a descriptive failure is the whole job here, which
 * also means it needs its own regression test. That test cannot import a
 * `*.test.js` to reach the helper: importing one *executes* it, re-registering
 * every live check and spending real quota a second time. So the helper lives in
 * a module with no test registrations at import time, and both suites import it.
 *
 * @module figma-mcp-dsh/test/fixtures/structured-read
 */

import assert from 'node:assert/strict'

/**
 * Read one capability and return its structured content, refusing to continue
 * on a failure the way the provider actually reports one.
 *
 * @param {{call: (input: object) => Promise<{structuredContent: unknown}>}} provider - Provider, or a stub with the same shape.
 * @param {object} input - Call input, at least `{op}`.
 * @returns {Promise<Record<string, any>>} Structured content.
 */
export async function read(provider, input) {
  const result = await provider.call(input)
  const content = /** @type {Record<string, any>} */ (result.structuredContent)
  if (content.ok === false) {
    // Channel-A errors have no `message`; `remedy` holds the actionable part,
    // including a 429's wait, the seat-tier hint, and the upgrade link.
    const error = /** @type {Record<string, any>} */ (content.error ?? {})
    assert.fail(
      `${input.op} did not succeed: kind=${error.kind} status=${error.status ?? '-'} ` +
        `retryAfterSec=${error.retryAfterSec ?? '-'} :: ${error.message ?? error.remedy ?? '(no detail)'}`,
    )
  }
  return content
}
