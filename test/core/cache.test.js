/**
 * Cache behaviour.
 *
 * The last test is the interesting one: it asserts that the conditional-request
 * machinery is *absent*. Figma returns `200` with a full body for a conditional
 * request, so a `304` branch would be unreachable code that looks like an
 * optimization — and someone would eventually "fix" it back in.
 *
 * @module figma-mcp-dsh/test/core/cache
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TtlCache, spoolNameFor } from '../../src/core/cache.js'
import { createFakeClock } from '../support/harness.js'

test('an entry survives inside its TTL and disappears after it', () => {
  const clock = createFakeClock()
  const cache = new TtlCache({ now: clock.now })
  cache.set('k', 'v', 1_000)
  assert.equal(cache.get('k'), 'v')
  clock.advance(999)
  assert.equal(cache.get('k'), 'v')
  clock.advance(1)
  assert.equal(cache.get('k'), undefined)
  assert.equal(cache.size, 0)
})

test('an expired entry is deleted on read, not merely hidden', () => {
  const clock = createFakeClock()
  const cache = new TtlCache({ now: clock.now })
  cache.set('k', 'v', 10)
  clock.advance(11)
  cache.get('k')
  assert.equal(cache.size, 0)
})

test('the least recently used entry is evicted past the capacity', () => {
  const clock = createFakeClock()
  const cache = new TtlCache({ maxEntries: 2, now: clock.now })
  cache.set('a', 1, 1_000)
  cache.set('b', 2, 1_000)
  // Touch 'a' so 'b' becomes the eviction candidate.
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3, 1_000)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('c'), 3)
})

test('a prefix invalidation removes matching entries only', () => {
  const cache = new TtlCache({ now: createFakeClock().now })
  cache.set('["file_nodes","k1",["1:2"]]', 1, 1_000)
  cache.set('["file_nodes","k1",["3:4"]]', 2, 1_000)
  cache.set('["file_meta","k1"]', 3, 1_000)
  assert.equal(cache.invalidatePrefix('["file_nodes","k1"'), 2)
  assert.equal(cache.get('["file_meta","k1"]'), 3)
})

test('a predicate invalidation drops exactly one file\'s entries', () => {
  const cache = new TtlCache({ now: createFakeClock().now })
  cache.set('["file_nodes","k1",["1:2"]]', 1, 1_000)
  cache.set('["file_nodes","k2",["1:2"]]', 2, 1_000)
  cache.set('["file_meta","k1"]', 3, 1_000)
  const removed = cache.invalidateWhere((key) => JSON.parse(key)[1] === 'k1')
  assert.equal(removed, 2)
  assert.equal(cache.get('["file_nodes","k2",["1:2"]]'), 2)
})

test('the cache offers no conditional-request or entity-tag machinery', () => {
  const cache = new TtlCache()
  for (const absent of ['etag', 'getEtag', 'setEtag', 'notModified', 'isFresh', 'revalidate']) {
    assert.equal(absent in cache, false, `TtlCache must not expose ${absent}`)
  }
})

test('spool names are stable and filesystem-safe', () => {
  const name = spoolNameFor('["file_nodes","k1",["1:2"],2]', 'json')
  assert.match(name, /^[0-9a-f]{8}-[0-9a-f]+\.json$/)
  assert.equal(name, spoolNameFor('["file_nodes","k1",["1:2"],2]', 'json'))
  assert.notEqual(name, spoolNameFor('["file_nodes","k1",["1:2"],3]', 'json'))
})
