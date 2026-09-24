/**
 * The budget stage.
 *
 * The two numbers that matter: the tightening refetch happens **at most once**,
 * and an oversized projection always leaves the model with something usable —
 * a skeleton plus a path, never a failure and never a context blowout.
 *
 * @module figma-mcp-dsh/test/core/budget
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { applyBudget } from '../../src/core/budget.js'
import { createMemorySpool } from '../../src/core/spool-sink.js'

/**
 * Build a payload whose projection is arbitrarily large.
 *
 * @param {number} nodeCount - How many children to attach.
 * @returns {{document: Record<string, unknown>}} Raw payload.
 */
function payload(nodeCount) {
  return {
    document: {
      id: '0:1',
      name: 'Page',
      type: 'CANVAS',
      children: Array.from({ length: nodeCount }, (_, index) => ({
        id: `1:${index}`,
        name: `Node ${index}`,
        type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
      })),
    },
  }
}

/**
 * A projector that mirrors the real one's shape closely enough for the budget.
 *
 * @param {unknown} raw - Raw payload.
 * @returns {Record<string, unknown>} Projected value.
 */
function project(raw) {
  const source = /** @type {{document: Record<string, unknown>}} */ (raw)
  return { source: 'file', roots: [source.document], palette: [], fonts: [], stats: { nodeCount: 1 } }
}

test('a projection inside the budget is returned as-is with no refetch', async () => {
  const spool = createMemorySpool()
  let fetches = 0
  const result = await applyBudget(
    async () => {
      fetches += 1
      return payload(1)
    },
    project,
    { depth: 4, budgetTokens: 8_000, minDepth: 1, spool, key: 'k' },
  )
  assert.equal(fetches, 1)
  assert.equal(result.tightened, false)
  assert.equal(result.skeletonOnly, false)
  assert.equal(result.depthUsed, 4)
  assert.equal(result.spooled, undefined)
})

test('an oversized projection refetches shallower exactly once', async () => {
  const spool = createMemorySpool()
  const depths = []
  const result = await applyBudget(
    async (depth) => {
      depths.push(depth)
      // depth 4 is enormous, depth 3 is tiny.
      return payload(depth >= 4 ? 4_000 : 1)
    },
    project,
    { depth: 4, budgetTokens: 8_000, minDepth: 1, spool, key: 'k' },
  )
  assert.deepEqual(depths, [4, 3])
  assert.equal(result.tightened, true)
  assert.equal(result.skeletonOnly, false)
  assert.equal(result.depthUsed, 3)
})

test('a projection that is still oversized after tightening returns a skeleton and spills to disk', async () => {
  const spool = createMemorySpool()
  const depths = []
  const result = await applyBudget(
    async (depth) => {
      depths.push(depth)
      return payload(40_000)
    },
    project,
    { depth: 4, budgetTokens: 8_000, minDepth: 1, spool, key: 'spill-key' },
  )
  assert.deepEqual(depths, [4, 3], 'the refetch must not repeat')
  assert.equal(result.skeletonOnly, true)
  assert.equal(result.tightened, true)
  assert.equal(typeof result.spooled?.path, 'string')
  assert.ok(result.spooled.bytes > 0)
  assert.equal(spool.files.size, 1)
  assert.equal(/** @type {Record<string, unknown>} */ (result.value).skeleton, true)
  assert.deepEqual(/** @type {Record<string, unknown>} */ (result.value).spooled, result.spooled)
})

test('the fetch count never exceeds two, even when the payload is enormous', async () => {
  const spool = createMemorySpool()
  let fetches = 0
  await applyBudget(
    async () => {
      fetches += 1
      return payload(50_000)
    },
    project,
    { depth: 8, budgetTokens: 1, minDepth: 1, spool, key: 'k' },
  )
  assert.equal(fetches, 2)
})

test('at the minimum depth there is nothing to tighten, so no refetch happens', async () => {
  const spool = createMemorySpool()
  let fetches = 0
  const result = await applyBudget(
    async () => {
      fetches += 1
      return payload(50_000)
    },
    project,
    { depth: 1, budgetTokens: 1, minDepth: 1, spool, key: 'k' },
  )
  assert.equal(fetches, 1)
  assert.equal(result.skeletonOnly, true)
  assert.equal(result.tightened, false)
})

test('with no filesystem the skeleton is still returned and says so', async () => {
  const result = await applyBudget(
    async () => payload(50_000),
    project,
    { depth: 4, budgetTokens: 1, minDepth: 1, key: 'k' },
  )
  assert.equal(result.skeletonOnly, true)
  assert.equal(result.spooled, undefined)
  assert.match(String(/** @type {Record<string, unknown>} */ (result.value).note), /narrower ids\/depth/)
})
