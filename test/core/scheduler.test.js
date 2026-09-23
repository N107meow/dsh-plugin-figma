/**
 * Rate limiting and request collapsing.
 *
 * Every clock here is fake. The bucket's whole job is to make a caller *wait*,
 * so a test that used real time would either be slow or flaky — and both are
 * worse than an injected clock.
 *
 * @module dsh-plugin-figma/test/core/scheduler
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_RATE_LIMITS, SingleFlight, TokenBucket } from '../../src/core/scheduler.js'
import { createFakeClock, createInstantSleep } from '../support/harness.js'

test('the default Tier 1 budget is the weakest seat, not this machine\'s seat', () => {
  assert.deepEqual(DEFAULT_RATE_LIMITS.tier1, { perMinute: 5, burst: 1 })
  const bucket = new TokenBucket(DEFAULT_RATE_LIMITS.tier1)
  assert.equal(bucket.limit, 5)
  assert.equal(bucket.capacity, 1)
})

test('every default tier is stated explicitly', () => {
  assert.equal(DEFAULT_RATE_LIMITS.tier2.perMinute, 10)
  assert.equal(DEFAULT_RATE_LIMITS.tier2.burst, 2)
  assert.equal(DEFAULT_RATE_LIMITS.tier3.perMinute, 20)
  assert.equal(DEFAULT_RATE_LIMITS.tier3.burst, 3)
})

test('the first request is immediate when a token is available', async () => {
  const clock = createFakeClock()
  const bucket = new TokenBucket({ perMinute: 60, burst: 2 }, clock.now, createInstantSleep(clock))
  const result = await bucket.acquire()
  assert.equal(result.waitedMs, 0)
})

test('an empty bucket queues instead of dropping, and reports how long it queued', async () => {
  const clock = createFakeClock()
  const bucket = new TokenBucket({ perMinute: 60, burst: 1 }, clock.now, createInstantSleep(clock))
  await bucket.acquire()
  const second = await bucket.acquire()
  // 60/min is one per second.
  assert.ok(second.waitedMs >= 1000, `expected a real wait, got ${second.waitedMs}ms`)
  assert.ok(clock.now() >= 1_700_000_001_000)
})

test('calibration from a 429 widens the bucket when Figma reports a full seat', () => {
  const bucket = new TokenBucket({ perMinute: 5, burst: 1 })
  assert.equal(bucket.limit, 5)
  bucket.calibrate('high')
  assert.equal(bucket.limit, 20)
  assert.equal(bucket.capacity, 2)
  assert.deepEqual([...bucket.calibrations], ['high'])
})

test('calibration from a 429 tightens the bucket when Figma reports a weak seat', () => {
  const bucket = new TokenBucket({ perMinute: 10, burst: 4 })
  bucket.calibrate('low')
  assert.equal(bucket.limit, 5)
  assert.equal(bucket.capacity, 1)
})

test('a 429 with no rate-limit-type header records the calibration without changing the rate', () => {
  const bucket = new TokenBucket({ perMinute: 5, burst: 1 })
  bucket.calibrate(undefined)
  assert.equal(bucket.limit, 5)
  assert.deepEqual([...bucket.calibrations], [undefined])
})

test('an aborted wait rejects rather than hanging', async () => {
  const clock = createFakeClock()
  const bucket = new TokenBucket({ perMinute: 1, burst: 1 }, clock.now, (ms, signal) => {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
  await bucket.acquire()
  const controller = new AbortController()
  const pending = bucket.acquire(controller.signal)
  controller.abort()
  await assert.rejects(pending, /aborted/)
})

test('five concurrent calls for one key reach the work once', async () => {
  const flight = new SingleFlight()
  let calls = 0
  const work = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return 'value'
  }
  const results = await Promise.all(Array.from({ length: 5 }, () => flight.run('same-key', work)))
  assert.equal(calls, 1)
  assert.deepEqual(results, ['value', 'value', 'value', 'value', 'value'])
  assert.equal(flight.size, 0)
})

test('different keys are not collapsed, and a settled key can run again', async () => {
  const flight = new SingleFlight()
  let calls = 0
  const work = async () => {
    calls += 1
    return calls
  }
  await Promise.all([flight.run('a', work), flight.run('b', work)])
  assert.equal(calls, 2)
  await flight.run('a', work)
  assert.equal(calls, 3)
})

test('a rejecting flight settles and does not poison later callers', async () => {
  const flight = new SingleFlight()
  let calls = 0
  const failing = async () => {
    calls += 1
    throw new Error('nope')
  }
  await assert.rejects(
    Promise.all([flight.run('k', failing), flight.run('k', failing)]),
    /nope/,
  )
  assert.equal(calls, 1)
  assert.equal(flight.size, 0)
})
