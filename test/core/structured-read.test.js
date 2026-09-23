/**
 * The shared `read` helper, checked without spending quota.
 *
 * Live failures arrive as a successful call carrying a structured error
 * (channel A), so a check that asserts `result.ok` reports `false !== true` and
 * throws the reason away. That is not hypothetical: when a Tier 1 allowance ran
 * out, two P1 checks failed exactly that way and the `rate_limited` verdict —
 * with its `Retry-After`, seat-tier hint, and upgrade link — was lost. The
 * helper turns that shape into a descriptive failure, and this is its
 * regression test.
 *
 * The providers here are stubs, so nothing touches the network and these checks
 * belong to the always-on suite. This file imports only the fixture: importing a
 * `*.test.js` would execute that suite and spend real quota.
 *
 * @module dsh-plugin-figma/test/core/structured-read
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createTokenSource } from '../../src/core/auth.js'
import { createProvider } from '../../src/core/provider.js'
import { createMemorySpool } from '../../src/core/spool-sink.js'
import { read } from '../fixtures/structured-read.js'

/**
 * A provider stub whose call resolves to one fixed structured content.
 *
 * @param {unknown} content - Structured content to resolve with.
 * @returns {any} Provider stub.
 */
function providerReturning(content) {
  return { call: async () => ({ structuredContent: content }) }
}

test('a channel-A failure is reported with its kind and remedy, not as "false !== true"', async () => {
  const provider = providerReturning({
    ok: false,
    error: {
      kind: 'rate_limited',
      retryAfterSec: 42,
      remedy: 'Figma rate-limited the request (HTTP 429). Wait 42s before retrying.',
    },
  })

  await assert.rejects(
    () => read(provider, { op: 'styles' }),
    (error) => {
      assert.ok(error instanceof assert.AssertionError, 'must fail as an assertion')
      assert.match(error.message, /kind=rate_limited/)
      assert.match(error.message, /retryAfterSec=42/)
      assert.match(error.message, /Wait 42s/)
      assert.doesNotMatch(error.message, /false !== true/)
      return true
    },
  )
})

test('a failure carrying only a remedy still surfaces the remedy', async () => {
  const provider = providerReturning({
    ok: false,
    error: { kind: 'token_invalid', remedy: 'Personal access tokens expire after 90 days.' },
  })

  await assert.rejects(
    () => read(provider, { op: 'file_meta' }),
    (error) => {
      assert.match(error.message, /kind=token_invalid/)
      assert.match(error.message, /90 days/)
      return true
    },
  )
})

test('a successful result passes through unchanged', async () => {
  const content = { ok: true, value: { total: 2 } }
  assert.equal(await read(providerReturning(content), { op: 'components' }), content)
})

test('a failure carrying neither message nor remedy still names the op', async () => {
  const provider = providerReturning({ ok: false })
  await assert.rejects(
    () => read(provider, { op: 'component_sets' }),
    (error) => {
      assert.match(error.message, /component_sets did not succeed/)
      assert.match(error.message, /no detail/)
      return true
    },
  )
})

/**
 * The three resource-map capabilities read one identical URL — and each one
 * costs a request.
 *
 * `components`, `component_sets`, and `styles` all fetch
 * `/v1/files/:key?depth=2`; only the projector differs. But the cache key is
 * `[spec.name, ...keyBy]` (see `cacheKeyFor`), so the capability name leads every
 * key and the three entries never share. Three capabilities therefore mean three
 * identical requests and three full copies of the same payload held in the cache.
 *
 * This is asserted as-is on purpose. It is measured behaviour, it is the largest
 * remaining quota cost in the extension, and a test that claimed the opposite —
 * "one request, two cache hits" — would pass on a stubbed transport while the
 * real allowance drained three times as fast. Do not weaken this to a looser
 * assertion; change the cache key and update the number deliberately.
 *
 * On a Tier 1 allowance of tens of requests per month, one call is fine and three
 * are wasteful. Reading all three maps from one capability, or grouping the cache
 * by request rather than by capability name, are the two candidate fixes; both
 * change shipped contracts, so neither is taken here.
 */
test('three resource capabilities issue three identical requests, because the cache key leads with the capability name', async () => {
  let calls = 0
  /** @type {string[]} */
  const urls = []
  const provider = createProvider({
    tokenSource: createTokenSource({ ref: 'FIGMA_TOKEN', resolve: async () => 'figd_TESTTOKENVALUE0123456789' }),
    spool: createMemorySpool(),
    config: { budgetTokens: 1_000_000, maxResultBytes: 4_194_304 },
    fetchImpl: /** @type {typeof fetch} */ (
      async (input) => {
        calls += 1
        urls.push(String(input))
        return new Response(
          JSON.stringify({
            name: 'Stub',
            document: { id: '0:0', name: 'Document', type: 'DOCUMENT' },
            components: { '1:2': { key: 'k'.repeat(40), name: 'Card/Ratio=1:1', remote: false } },
            componentSets: {},
            styles: { '3:4': { key: 's'.repeat(40), name: 'Surface', styleType: 'FILL', remote: false } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
    ),
  })

  const fileKey = 'StubFileKey0000000001'
  const components = await read(provider, { op: 'components', args: { fileKey } })
  const sets = await read(provider, { op: 'component_sets', args: { fileKey } })
  const styles = await read(provider, { op: 'styles', args: { fileKey } })

  assert.equal(calls, 3, 'each capability keeps its own cache entry, so each one fetches')

  // The depth is what makes these capabilities affordable at all: measured, the
  // whole-file read is 1,564,042 bytes while `depth=2` answers in 6,338. It is
  // also fixed internally rather than exposed, because a model-chosen depth is
  // exactly how this would become expensive. Asserted here so the guarantee
  // holds without spending a request.
  assert.equal(new Set(urls).size, 1, 'all three must read one identical URL')
  assert.match(urls[0], /depth=2/, `the shallow depth must be on the wire, got ${urls[0]}`)

  // Each capability still projects its own slice out of its own copy.
  assert.equal(components.value.total, 1)
  assert.equal(sets.value.total, 0)
  assert.equal(styles.value.total, 1)
  assert.equal(components.value.components[0].name, 'Card/Ratio=1:1')
  assert.equal(styles.value.styles[0].name, 'Surface')
})
