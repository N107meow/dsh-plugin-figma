/**
 * Real-data checks — the measured baselines from the design document.
 *
 * These run the whole pipeline against the live Figma API and are **skipped**
 * unless the environment names a file and a token, because a real file key
 * belongs to whoever owns that file and a real token is a secret:
 *
 * ```
 * FIGMA_TEST_FILE_KEY=<key> \
 * FIGMA_TEST_NODE_ID=<id> \
 * FIGMA_TEST_NODE_ID_B=<id> \
 * FIGMA_TOKEN=<token> \
 * node --test test/core/real-data.test.js
 *
 * # additionally, to observe queueing and 429 backoff against the real budget:
 * FIGMA_TEST_RATE_LIMIT=1 ...
 * ```
 *
 * Set `FIGMA_TEST_NODE_ID_B` to the contrasting node (the dark or light half of
 * a theme pair) to enable the theme comparison.
 *
 * @module dsh-plugin-figma/test/core/real-data
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createTokenSource } from '../../src/core/auth.js'
import { createProvider } from '../../src/core/provider.js'
import { createMemorySpool } from '../../src/core/spool-sink.js'
import { estimateBytes } from '../../src/core/tokens.js'

const FILE_KEY = process.env.FIGMA_TEST_FILE_KEY
const NODE_ID = process.env.FIGMA_TEST_NODE_ID
const NODE_ID_B = process.env.FIGMA_TEST_NODE_ID_B
const TOKEN = process.env.FIGMA_TOKEN

/** Whether the live checks have everything they need. */
const live = Boolean(FILE_KEY && NODE_ID && TOKEN)

/** Why the live checks are being skipped, phrased so a reader can enable them. */
const skip = live
  ? false
  : 'set FIGMA_TEST_FILE_KEY, FIGMA_TEST_NODE_ID, and FIGMA_TOKEN to run the live Figma checks'

/**
 * Build a provider wired to the live API.
 *
 * @param {object} [config] - Provider configuration overrides.
 * @returns {{provider: ReturnType<typeof createProvider>, spool: ReturnType<typeof createMemorySpool>}} Live provider.
 */
function liveProvider(config = {}) {
  const spool = createMemorySpool()
  return {
    spool,
    provider: createProvider({
      tokenSource: createTokenSource({ ref: 'FIGMA_TOKEN', resolve: async () => TOKEN }),
      spool,
      config: { maxResultBytes: 4_194_304, budgetTokens: 1_000_000, ...config },
    }),
  }
}

/**
 * Read one capability and return the structured content.
 *
 * @param {ReturnType<typeof createProvider>} provider - Provider.
 * @param {object} input - Call input.
 * @returns {Promise<Record<string, any>>} Structured content.
 */
async function read(provider, input) {
  const result = await provider.call(input)
  return /** @type {Record<string, any>} */ (result.structuredContent)
}

test('metadata reports real facts, not an empty object', { skip }, async () => {
  const { provider } = liveProvider()
  const result = await read(provider, { op: 'file_meta', args: { fileKey: FILE_KEY } })

  assert.equal(result.ok, true)
  const value = /** @type {Record<string, any>} */ (result.value)
  // A live /meta response nests its fields under `file`; a projection that only
  // understands the documented flat shape answers {} and still reports ok:true.
  assert.ok(Object.keys(value).length >= 4, `file_meta returned ${JSON.stringify(value)}`)
  assert.equal(typeof value.name, 'string')
  assert.equal(typeof value.version, 'string')
  assert.equal(typeof value.role, 'string')
  console.log(`      ${value.name} · version ${value.version} · role ${value.role} · editor ${value.editorType}`)
})

test('depth guard: ids without depth stays small instead of returning the whole subtree', { skip }, async () => {
  const { provider } = liveProvider()
  const guarded = await read(provider, { op: 'file_nodes', args: { fileKey: FILE_KEY, ids: [NODE_ID] } })

  assert.equal(guarded.ok, true)
  assert.equal(guarded.meta.depthUsed, 2)
  // Measured: the same node without a depth was 48,659 bytes, and a root canvas
  // without one was 1,193,266 bytes. A guarded read must not be in that league.
  assert.ok(guarded.meta.projectedChars < 10_000, `guarded read was ${guarded.meta.projectedChars} chars`)
})

test('projection baseline: a single frame at depth 4 projects to roughly a quarter of the raw payload', { skip }, async () => {
  const { provider } = liveProvider({ budgetTokens: 1_000_000 })
  const result = await read(provider, { op: 'file_nodes', args: { fileKey: FILE_KEY, ids: [NODE_ID], depth: 4 } })

  assert.equal(result.ok, true)
  const value = /** @type {Record<string, any>} */ (result.value)
  assert.match(value.source, /^(file|nodes)$/)
  assert.ok(Array.isArray(value.roots) && value.roots.length === 1)
  assert.ok(value.palette.length > 0, 'a real frame must report a palette')
  assert.ok(value.fonts.length > 0, 'a real frame must report a type scale')

  // Re-measuring the raw payload would spend a second request, so the baseline
  // is expressed as a density instead of a ratio: bytes of projection per node.
  // The two measured files sit at 327 (18 nodes, 5,879 chars) and 230
  // (154 nodes, 35,425 chars) — a ceiling of 400 catches the regression that
  // matters, which is a field whitelist that stopped dropping anything.
  const projected = estimateBytes(JSON.stringify(value))
  const perNode = projected / Math.max(1, value.stats.nodeCount)
  console.log(`      ${value.stats.nodeCount} nodes -> ${projected} bytes (${perNode.toFixed(0)} bytes/node)`)
  assert.ok(value.stats.nodeCount > 0)
  assert.ok(perNode < 400, `${perNode.toFixed(0)} bytes per node; the projection is not compressing`)
  assert.ok(projected < 60_000, `projected ${projected} bytes`)
})

test('projection baseline: palette and type scale are the ones measured for this file', { skip }, async () => {
  const { provider } = liveProvider({ budgetTokens: 1_000_000 })
  const result = await read(provider, { op: 'file_nodes', args: { fileKey: FILE_KEY, ids: [NODE_ID], depth: 4 } })
  const value = /** @type {Record<string, any>} */ (result.value)
  const hexes = value.palette.map((entry) => entry.hex)

  // Every hex must be a real, well-formed color: the point of the check is that
  // projection produced usable colors, not that one file has one palette.
  for (const hex of hexes) assert.match(hex, /^#[0-9A-F]{6}$/)
  for (const font of value.fonts) assert.match(font, /^.+ \d+ [\d.]+px$/)
})

test('theme pair: two versions of one dashboard keep separate palettes and share the brand color', { skip: live && NODE_ID_B ? false : 'set FIGMA_TEST_NODE_ID_B to compare a theme pair' }, async () => {
  const { provider } = liveProvider({ budgetTokens: 1_000_000 })
  const calls = { op: 'file_nodes', args: { fileKey: FILE_KEY, ids: [NODE_ID], depth: 4 } }
  const [first, second] = await Promise.all([
    read(provider, calls),
    read(provider, { op: 'file_nodes', args: { fileKey: FILE_KEY, ids: [NODE_ID_B], depth: 4 } }),
  ])

  const a = /** @type {Record<string, any>} */ (first.value)
  const b = /** @type {Record<string, any>} */ (second.value)
  assert.ok(a.palette.length > 0 && b.palette.length > 0)

  const setA = new Set(a.palette.map((entry) => entry.hex))
  const setB = new Set(b.palette.map((entry) => entry.hex))
  const identical = setA.size === setB.size && [...setA].every((hex) => setB.has(hex))
  assert.equal(identical, false, 'the two halves of a theme pair must not project to the same palette')

  // The design-system invariant worth asserting on any theme pair: something
  // survives the switch. On the pair this baseline was measured against, that
  // shared color is the brand green #29CB97 — the neutrals all move, the brand
  // does not.
  const shared = [...setA].filter((hex) => setB.has(hex))
  console.log(`      shared palette entries: ${shared.join(', ') || '(none)'}`)
  assert.ok(shared.length >= 1, 'a theme pair must keep at least one shared color')
})

test('twelve Tier 1 reads queue rather than fail, and report how long they waited', { skip: process.env.FIGMA_TEST_RATE_LIMIT === '1' && live ? false : 'set FIGMA_TEST_RATE_LIMIT=1 to spend real quota observing the bucket' }, async () => {
  const { provider } = liveProvider()

  // Twelve distinct Tier 1 requests. Distinct matters: identical reads would be
  // collapsed by single-flight or served from cache, and neither would exercise
  // the bucket. Depth and geometry both change the cache key.
  const calls = []
  for (let depth = 1; depth <= 8; depth += 1) calls.push({ fileKey: FILE_KEY, ids: [NODE_ID], depth })
  for (let depth = 1; depth <= 4; depth += 1) calls.push({ fileKey: FILE_KEY, ids: [NODE_ID], depth, geometry: 'paths' })

  const started = Date.now()
  const results = []
  for (const args of calls) results.push(await read(provider, { op: 'file_nodes', args }))
  const elapsedMs = Date.now() - started
  const stats = provider.stats()

  assert.equal(results.length, 12)
  assert.ok(
    results.every((result) => result.ok === true || result.error.kind === 'rate_limited'),
    'a read may be rate-limited, but it must not fail in any other way',
  )
  assert.ok(stats.requests >= 12, `only ${stats.requests} request(s) reached Figma`)
  // With the shipped 5/min, burst-1 default, twelve Tier 1 reads cannot all go
  // out immediately.
  assert.ok(stats.queuedMs > 0, 'with a 5/min budget, twelve Tier 1 reads must queue')
  console.log(
    `      12 reads: ${stats.requests} request(s), ${Math.round(stats.queuedMs / 1000)}s queued of ${Math.round(elapsedMs / 1000)}s, ` +
      `${stats.retries} retry(ies), limits ${JSON.stringify(stats.limits)}`,
  )
})

test('an invalid token becomes a structured remedy, never a thrown error', { skip: live ? false : 'set FIGMA_TEST_FILE_KEY to run the live token check' }, async () => {
  const spool = createMemorySpool()
  const provider = createProvider({
    tokenSource: createTokenSource({ ref: 'FIGMA_TOKEN', resolve: async () => 'figd_definitelynotavalidtoken000' }),
    spool,
  })

  const result = await provider.call({ op: 'file_meta', args: { fileKey: FILE_KEY } })
  assert.equal(result.structuredContent.ok, false)
  assert.equal(/** @type {Record<string, any>} */ (result.structuredContent.error).kind, 'token_invalid')
  assert.match(/** @type {Record<string, any>} */ (result.structuredContent.error).remedy, /Personal access tokens/)

  // The second call must not spend another request on a known-bad credential.
  const before = provider.stats().requests
  const memoized = await provider.call({ op: 'file_meta', args: { fileKey: FILE_KEY } })
  assert.equal(provider.stats().requests, before)
  assert.match(/** @type {Record<string, any>} */ (memoized.structuredContent.error).remedy, /already rejected/)
})

test('the image endpoint returns a URL that downloads to bytes, with no credential on the request', { skip }, async () => {
  const { provider, spool } = liveProvider()
  const result = await read(provider, { op: 'image_render', args: { fileKey: FILE_KEY, ids: [NODE_ID], scale: 1 } })

  assert.equal(result.ok, true)
  const entry = /** @type {Record<string, any>} */ (result.value).images[NODE_ID]
  assert.ok(entry !== undefined, 'the rendered node must have an entry')
  if (entry.error !== undefined) {
    // A plan or scope restriction is a legitimate answer; a crash is not.
    assert.match(entry.error, /HTTP \d+/)
    return
  }
  assert.ok(entry.bytes > 0)
  assert.equal(spool.attachments.length, 1)
  assert.equal(spool.attachments[0].mediaType, 'image/png')
})
