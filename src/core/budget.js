/**
 * The budget stage: what to do when a correct answer is still too big.
 *
 * A fixed depth cannot work across real files — the same `depth=4` produced 18
 * nodes on one file and 154 on another, a six-fold difference. So the strategy
 * is adaptive, and bounded:
 *
 * 1. Fetch at the requested depth and project.
 * 2. If it fits, return it.
 * 3. If not, **refetch once** at one level shallower.
 * 4. If it still does not fit, return a structure skeleton and write the full
 *    projection to disk, naming the path.
 *
 * Step 3 happening **only once** is a deliberate cost decision. Each retry
 * spends a rate-limit token from a bucket that may hold five of them per
 * minute, so an unbounded "keep tightening until it fits" loop could burn a
 * user's entire budget on one question. A skeleton plus a path is a better
 * answer than a burned quota.
 *
 * @module dsh-plugin-figma/core/budget
 */

import { spoolNameFor } from './cache.js'
import { buildSkeleton } from './projection.js'
import { estimateBytes, estimateTokens, serialize } from './tokens.js'

/** Default projection budget, in approximate tokens. */
export const DEFAULT_BUDGET_TOKENS = 8_000

/**
 * Apply the projection budget.
 *
 * @param {(depth: number) => Promise<unknown>} fetchOnce - Fetch and parse one depth. Called at most twice.
 * @param {(raw: unknown) => Record<string, unknown>} project - Project one raw payload.
 * @param {object} options - Budget options.
 * @param {number} options.depth - Requested depth.
 * @param {number} [options.budgetTokens] - Approximate token ceiling.
 * @param {number} [options.minDepth] - Shallowest depth worth retrying at.
 * @param {string} [options.key] - Cache key, used to name the spool file.
 * @param {import('./types.js').SpoolSink} [options.spool] - Where an oversized projection is persisted.
 * @param {AbortSignal} [options.signal] - Cancellation.
 * @param {string} [options.cwd] - Session workspace root for the spool write.
 * @param {(projected: Record<string, unknown>) => unknown} [options.skeleton] - Skeleton builder override.
 * @returns {Promise<import('./types.js').BudgetResult>} The value to return plus cost facts.
 */
export async function applyBudget(fetchOnce, project, options) {
  const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS
  const minDepth = Math.max(1, options.minDepth ?? 1)
  const buildSkeletonValue = options.skeleton ?? buildSkeleton

  let depthUsed = options.depth
  let projected = project(await fetchOnce(depthUsed))
  let text = serialize(projected)
  let tightened = false

  if (estimateTokens(text) <= budgetTokens) {
    return { value: projected, depthUsed, tightened, skeletonOnly: false }
  }

  if (depthUsed > minDepth) {
    tightened = true
    depthUsed -= 1
    projected = project(await fetchOnce(depthUsed))
    text = serialize(projected)
    if (estimateTokens(text) <= budgetTokens) {
      return { value: projected, depthUsed, tightened, skeletonOnly: false }
    }
  }

  const skeleton = /** @type {Record<string, unknown>} */ (buildSkeletonValue(projected))
  const bytes = estimateBytes(text)
  let spooled

  if (options.spool !== undefined) {
    const name = spoolNameFor(options.key ?? `budget:${depthUsed}`, 'json')
    const path = await options.spool.write(name, text, { cwd: options.cwd, signal: options.signal })
    if (typeof path === 'string' && path.length > 0) spooled = { path, bytes }
  }

  if (spooled !== undefined) skeleton.spooled = spooled
  else {
    skeleton.note =
      'This is a structure skeleton: container nodes with child counts, not the full detail. ' +
      'Full detail was too large for the budget and no filesystem was available to save it, so ask again for a ' +
      'narrower ids/depth to get detail inline.'
  }

  const fullTokens = estimateTokens(text)
  return {
    value: skeleton,
    depthUsed,
    tightened,
    skeletonOnly: true,
    ...(spooled === undefined ? {} : { spooled }),
    fullTokens,
    fullBytes: bytes,
  }
}
