/**
 * Transport and retry policy.
 *
 * @module figma-mcp-dsh/test/core/http
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Redactor, hashSecret } from '../../src/core/auth.js'
import { HttpError, figmaFetch, figmaFetchBytes } from '../../src/core/http.js'
import { backoffDelay, withRetry } from '../../src/core/retry.js'
import { createFetchStub, jsonResponse } from '../support/harness.js'

test('redirects are never followed, and the policy cannot be overridden', async () => {
  const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ ok: true }))
  await figmaFetch({ url: 'https://api.figma.com/v1/files/k/meta', headers: { 'X-Figma-Token': 't' }, fetchImpl })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.redirect, 'error')

  await assert.rejects(
    figmaFetch({ url: 'https://api.figma.com/x', redirect: /** @type {any} */ ('follow'), fetchImpl }),
    /refuses redirect policy "follow"/,
  )
})

test('the caller signal reaches the transport', async () => {
  const controller = new AbortController()
  const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}))
  await figmaFetch({ url: 'https://api.figma.com/x', signal: controller.signal, fetchImpl })
  assert.ok(calls[0].init.signal instanceof AbortSignal)
})

test('the body is returned as text, so a non-JSON error body survives', async () => {
  const { fetchImpl } = createFetchStub(
    () => new Response('<html>gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
  )
  const response = await figmaFetch({ url: 'https://api.figma.com/x', fetchImpl })
  assert.equal(response.status, 502)
  assert.equal(response.body, '<html>gateway</html>')
  assert.equal(response.headers['content-type'], 'text/html')
})

test('a transport failure is classified rather than escaping raw', async () => {
  const { fetchImpl } = createFetchStub(() => {
    throw new Error('getaddrinfo ENOTFOUND api.figma.com')
  })
  await assert.rejects(figmaFetch({ url: 'https://api.figma.com/x', fetchImpl }), (error) => {
    assert.ok(error instanceof HttpError)
    assert.equal(error.code, 'NETWORK')
    assert.equal(error.aborted, false)
    return true
  })
})

test('a transport failure message is redacted before it escapes', async () => {
  const redactor = new Redactor().remember('supersecretvalue123')
  const { fetchImpl } = createFetchStub(() => {
    throw new Error('failed while sending header supersecretvalue123')
  })
  await assert.rejects(
    figmaFetch({ url: 'https://api.figma.com/x', fetchImpl, redact: (text) => redactor.redact(text) }),
    (error) => {
      assert.equal(String(error.message).includes('supersecretvalue123'), false)
      assert.match(String(error.message), /figma_\*\*\*/)
      return true
    },
  )
})

test('a stalled request hits its own deadline instead of hanging', async () => {
  const { fetchImpl } = createFetchStub(
    (_request) =>
      new Promise((_resolve, reject) => {
        // Never resolves; only aborts.
        setTimeout(() => reject(new Error('aborted')), 50)
        return undefined
      }),
  )
  await assert.rejects(
    figmaFetch({ url: 'https://api.figma.com/x', fetchImpl, timeoutMs: 5 }),
    (error) => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.code, 'TIMEOUT')
      return true
    },
  )
})

test('bytes are returned as bytes, with only the headers the caller supplied', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const { fetchImpl, calls } = createFetchStub(() => new Response(png, { status: 200 }))
  const response = await figmaFetchBytes({ url: 'https://s3.example.test/a.png', headers: {}, fetchImpl })
  assert.deepEqual([...response.bytes], [...png])
  assert.deepEqual(calls[0].init.headers, {})
})

test('the redactor scrubs raw and percent-encoded spellings of every known secret', () => {
  const redactor = new Redactor()
  redactor.remember('abcdefghijklmnop')
  assert.equal(redactor.redact('token=abcdefghijklmnop'), 'token=figma_***')
  assert.equal(redactor.redact('token=abcdefghijklmnop%3A'), 'token=figma_***%3A')
  assert.equal(redactor.redact('nothing here'), 'nothing here')
  redactor.forget('abcdefghijklmnop')
  assert.equal(redactor.redact('abcdefghijklmnop'), 'abcdefghijklmnop')
})

test('short values are not treated as secrets, so ordinary text is not mangled', () => {
  const redactor = new Redactor().remember('abc')
  assert.equal(redactor.size, 0)
  assert.equal(redactor.redact('abc def'), 'abc def')
})

test('credential fingerprints depend on the value, not on time', () => {
  assert.equal(hashSecret('one'), hashSecret('one'))
  assert.notEqual(hashSecret('one'), hashSecret('two'))
  assert.match(hashSecret('one'), /^[0-9a-f]{64}$/)
})

test('retry stops at maxAttempts and reports every delay', async () => {
  const delays = []
  let attempts = 0
  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1
        throw new Error('boom')
      },
      () => ({ retryable: true }),
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
      undefined,
      { sleepImpl: async (ms) => delays.push(ms), random: () => 0.5 },
    ),
    /boom/,
  )
  assert.equal(attempts, 3)
  assert.equal(delays.length, 2)
})

test('a non-retryable failure is not attempted again', async () => {
  let attempts = 0
  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1
        throw new Error('nope')
      },
      () => ({ retryable: false }),
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10 },
    ),
    /nope/,
  )
  assert.equal(attempts, 1)
})

test('a server-specified Retry-After wins over local backoff', async () => {
  const delays = []
  let attempts = 0
  await withRetry(
    async () => {
      attempts += 1
      if (attempts === 1) throw new Error('rate limited')
      return 'ok'
    },
    () => ({ retryable: true, retryAfterMs: 4_321 }),
    { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    undefined,
    { sleepImpl: async (ms) => delays.push(ms), random: () => 0.5 },
  )
  assert.deepEqual(delays, [4_321])
})

test('a pre-aborted signal stops before the first attempt', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  let attempts = 0
  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1
        return 'ok'
      },
      () => ({ retryable: true }),
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
      controller.signal,
    ),
    /cancelled/,
  )
  assert.equal(attempts, 0)
})

test('backoff grows exponentially and is capped', () => {
  const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000 }
  assert.equal(backoffDelay(policy, 0, () => 1), 100)
  assert.equal(backoffDelay(policy, 1, () => 1), 200)
  assert.equal(backoffDelay(policy, 2, () => 1), 400)
  assert.equal(backoffDelay(policy, 5, () => 1), 1_000)
  // Jitter never exceeds the computed step.
  assert.ok(backoffDelay(policy, 0, () => 0) < 100)
})
