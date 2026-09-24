/**
 * P1 real-data acceptance: components, component sets, styles, and style
 * references, against a live Figma file.
 *
 * Skipped unless `.env.local` supplies the material (run `npm run test:real`).
 * The identifiers live only there: this repository's `check-secrets` gate scans
 * for exactly those strings, and a real file key identifies someone's file.
 *
 * The numbers below are the ones measured when the phase was designed, kept as
 * constants so the assertions can state the comparison explicitly:
 * a whole-file read of the source file was 1,564,042 bytes, while the shallow
 * (`depth=2`) read these capabilities use was 6,338 bytes.
 *
 * @module figma-mcp-dsh/test/core/p1-real-data
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createTokenSource } from '../../src/core/auth.js'
import { createProvider } from '../../src/core/provider.js'
import {
  P1_COMPONENT_A,
  P1_COMPONENT_A_NAME,
  P1_COMPONENT_B,
  P1_COMPONENT_B_NAME,
  P1_INSTANCE_A,
  P1_INSTANCE_B,
  P1_SKIP_REASON,
  P1_STYLE,
  P1_STYLE_NAME,
  P1_STYLE_TYPE,
  P1_STYLED_NODE,
  REAL_FILE_KEY,
  hasP1Fixtures,
  realToken,
} from '../fixtures/real-file.js'
import { read as structuredRead } from '../fixtures/structured-read.js'

/** Measured size of a whole-file read of the source file, in bytes. */
const DOCUMENTED_FULL_FILE_BYTES = 1_564_042

/** Measured size of the shallow read these capabilities perform, in bytes. */
const DOCUMENTED_SHALLOW_BYTES = 6_338

const TOKEN = realToken()

/** Whether the live checks have everything they need. */
const live = hasP1Fixtures && Boolean(TOKEN)

const skip = live ? false : P1_SKIP_REASON

/** Response log shared by every check, so sizes are counted across the suite. */
const responses = /** @type {Array<{method: string, path: string, search: string, bytes: number}>} */ ([])

/**
 * The suite's single provider, wired to the live API and recording body sizes.
 *
 * **Exactly one provider for the whole suite, deliberately.** A provider holds
 * the rate-limit bucket, the TTL cache, and the single-flight map, and all three
 * are per-instance state. Handing each check its own provider resets that state
 * at every test boundary, which caused two distinct problems when this suite
 * first ran for real:
 *
 * 1. The client-side limiter — `tier1: {perMinute: 5, burst: 1}`, sized for the
 *    weakest plausible seat — never saw the suite's actual request count, so it
 *    could not throttle anything and Figma's 429s did the teaching instead.
 * 2. Every check paid full price. `components`, `component_sets`, and `styles`
 *    read the *same* payload (`/v1/files/:key?depth=2`), but the cache key leads
 *    with the capability name, so the entries never share: with a provider per
 *    check the suite spent four Tier 1 requests where one payload would do,
 *    against an allowance measured in tens per month.
 *
 * Sharing one provider fixes (1) outright and keeps (2) honest — it does **not**
 * collapse the three resource reads into one request, because the cache key is
 * `[spec.name, ...keyBy]` and cache entries are per capability. `structured-read
 * .test.js` asserts that three-fetch behaviour explicitly, so it cannot be
 * mistaken for a saving that does not exist.
 *
 * The size assertion is about the wire, not the projection, so bodies are
 * measured at the transport rather than inferred from `meta`.
 *
 * @returns {{provider: ReturnType<typeof createProvider>, responses: Array<{path: string, bytes: number}>}} Live provider and the shared response log.
 */
function liveProvider() {
  if (sharedProvider === undefined) {
    const recordingFetch = async (input, init) => {
      const response = await fetch(input, init)
      const body = await response.clone().text()
      const url = new URL(String(input))
      responses.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        search: url.search,
        bytes: Buffer.byteLength(body, 'utf8'),
      })
      return response
    }
    sharedProvider = createProvider({
      tokenSource: createTokenSource({ ref: 'FIGMA_TOKEN', resolve: async () => TOKEN }),
      config: { budgetTokens: 1_000_000, maxResultBytes: 8_388_608 },
      fetchImpl: /** @type {typeof fetch} */ (recordingFetch),
    })
  }
  return { provider: sharedProvider, responses }
}

/** @type {ReturnType<typeof createProvider>|undefined} */
let sharedProvider

/**
 * Read one capability and return its structured content, refusing to continue
 * on a failure the way the provider actually reports one.
 *
 * The body lives in `test/fixtures/structured-read.js` so that both live suites
 * share it — and so it can carry a regression test without importing a
 * `*.test.js`, which would execute that suite a second time against real quota.
 *
 * @type {typeof import('../fixtures/structured-read.js').read}
 */
const read = structuredRead

test('assertion 1+2: components come from the file map, and their variants parse out of the names', { skip }, async () => {
  const { provider } = liveProvider()
  const result = await read(provider, { op: 'components', args: { fileKey: REAL_FILE_KEY } })

  const value = /** @type {Record<string, any>} */ (result.value)
  assert.equal(value.total, 2, `expected 2 components, got ${JSON.stringify(value.components)}`)

  const byId = Object.fromEntries(value.components.map((entry) => [entry.id, entry]))
  const expected = [
    [P1_COMPONENT_A, P1_COMPONENT_A_NAME],
    [P1_COMPONENT_B, P1_COMPONENT_B_NAME],
  ]

  for (const [id, name] of expected) {
    const entry = byId[id]
    assert.ok(entry !== undefined, `component ${id} must be listed`)
    assert.equal(entry.name, name)
    assert.match(entry.key, /^[A-Za-z0-9]{40}$/, `component ${id} must carry a 40-character library key`)

    // The variant data has to come out of the NAME, because no structured field
    // exists. Rather than compare against a literal (which would put the
    // design's own vocabulary in this file), assert the parse is a lossless
    // decomposition: base plus the parsed properties must rebuild the name.
    assert.ok(entry.variants !== undefined, `component ${id} must expose parsed variants`)
    const pieces = [entry.base, ...Object.entries(entry.variants).map(([key, value]) => `${key}=${value}`)]
    assert.equal(pieces.join('/'), name, `component ${id} parse must rebuild the name exactly`)
    assert.equal(entry.base.length > 0 && entry.base.includes('='), false, `component ${id} base must not contain variant syntax`)
  }

  // Both members of a variant family share one base name, which is the whole
  // reason the base is parsed out at all.
  assert.equal(byId[P1_COMPONENT_A].base, byId[P1_COMPONENT_B].base)
  assert.notDeepEqual(byId[P1_COMPONENT_A].variants, byId[P1_COMPONENT_B].variants)

  console.log(
    `      ${value.components.map((c) => `${c.id} base="${c.base}" variants=${JSON.stringify(c.variants)}`).join('\n      ')}`,
  )
})

test('assertion 3: styles come from the file map, with styleType as the discriminant', { skip }, async () => {
  const { provider } = liveProvider()
  const result = await read(provider, { op: 'styles', args: { fileKey: REAL_FILE_KEY } })

  const value = /** @type {Record<string, any>} */ (result.value)
  assert.equal(value.total, 1, `expected 1 style, got ${JSON.stringify(value.styles)}`)

  const style = value.styles[0]
  assert.equal(style.id, P1_STYLE)
  assert.equal(style.name, P1_STYLE_NAME)
  assert.equal(style.styleType, P1_STYLE_TYPE)
  assert.match(style.key, /^[A-Za-z0-9]{40}$/, 'a published style must carry a library key')

  console.log(`      ${style.id} styleType=${style.styleType} key=${style.key.slice(0, 8)}…`)
})

test('assertion 4: an empty component set list is answered normally, not as a failure', { skip }, async () => {
  const { provider } = liveProvider()
  const result = await read(provider, { op: 'component_sets', args: { fileKey: REAL_FILE_KEY } })

  // The source file has variants but no Component Set, so the answer is empty.
  // What matters is that an empty answer arrives as a successful, well-formed
  // result rather than as an error or a crash.
  const value = /** @type {Record<string, any>} */ (result.value)
  assert.ok(Array.isArray(value.componentSets))
  assert.equal(value.total, value.componentSets.length)
  console.log(`      component_sets -> ${value.total} set(s), ok=${result.ok}`)
})

test('assertion 5: a styled node resolves its style reference to a name', { skip }, async () => {
  const { provider } = liveProvider()
  const result = await read(provider, {
    op: 'file_nodes',
    args: { fileKey: REAL_FILE_KEY, ids: [P1_STYLED_NODE], depth: 1 },
  })

  const root = /** @type {Record<string, any>} */ (result.value).roots[0]
  assert.ok(root !== undefined, 'the styled node must be returned')
  assert.deepEqual(root.styles, { fill: { id: P1_STYLE, name: P1_STYLE_NAME, styleType: P1_STYLE_TYPE } })
  console.log(`      ${P1_STYLED_NODE} styles=${JSON.stringify(root.styles)}`)
})

test('assertion 6: both instances keep the componentId that links them to their components', { skip }, async () => {
  const { provider } = liveProvider()
  const pairs = [
    [P1_INSTANCE_A, P1_COMPONENT_B],
    [P1_INSTANCE_B, P1_COMPONENT_A],
  ]

  // Both directions are asserted because the fixture names number the instances
  // and the components independently: `P1_INSTANCE_A` is an instance of
  // `P1_COMPONENT_B`. Pinning only one pair left that crossing invisible in the
  // variable names, which is the kind of detail that only surfaces once the
  // checks actually run.
  for (const [instanceId, componentId] of pairs) {
    const result = await read(provider, {
      op: 'file_nodes',
      args: { fileKey: REAL_FILE_KEY, ids: [instanceId], depth: 1 },
    })
    const root = /** @type {Record<string, any>} */ (result.value).roots[0]
    assert.equal(root.componentId, componentId, `instance ${instanceId} must name the component it uses`)
    console.log(`      ${instanceId} "${root.name}" componentId=${root.componentId}`)
  }
})

test('assertion 7: a resource read costs one Tier 1 request and stays far below a whole-file read', { skip }, async () => {
  const { provider, responses } = liveProvider()
  const before = responses.length

  // All three capabilities read the same URL with the same query, but the cache
  // key is `[spec.name, ...keyBy]` — the capability name leads it — so the entries
  // are per capability and **each one fetches**. Sharing a provider does not
  // collapse them; `structured-read.test.js` asserts the three-fetch behaviour
  // against a stub transport. Here the point is what each fetch costs on the
  // wire, so the assertion is about a resource read's size, not their number.
  for (const op of ['components', 'component_sets', 'styles']) {
    await read(provider, { op, args: { fileKey: REAL_FILE_KEY } })
  }

  const fresh = responses.slice(before)
  assert.equal(
    fresh.length,
    3,
    `each resource capability keeps its own cache entry, so each one fetches; got ${JSON.stringify(fresh)}`,
  )

  for (const response of fresh) {
    assert.equal(response.method, 'GET', 'a live check must never mutate Figma')
    assert.equal(response.path, `/v1/files/${REAL_FILE_KEY}`)
    assert.match(response.search, /depth=2/, 'the shallow depth is the whole reason this is affordable')
    assert.ok(
      response.bytes < DOCUMENTED_FULL_FILE_BYTES / 100,
      `a shallow read must stay far below the ${DOCUMENTED_FULL_FILE_BYTES}-byte whole file, got ${response.bytes}`,
    )
  }
  console.log(
    `      ${fresh.length} resource reads, ${fresh[0].bytes} B each, GET ${fresh[0].path}${fresh[0].search} ` +
      `(whole file ${DOCUMENTED_FULL_FILE_BYTES} B)`,
  )
})
