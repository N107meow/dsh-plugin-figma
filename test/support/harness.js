/**
 * Test seams shared by the core suites.
 *
 * Everything here exists so a core test never needs a network, a real clock, or
 * real elapsed time: transport, time, sleeping, and jitter are all injected.
 *
 * @module dsh-plugin-figma/test/support/harness
 */

import { createProvider } from '../../src/core/provider.js'
import { createMemorySpool } from '../../src/core/spool-sink.js'
import { createTokenSource } from '../../src/core/auth.js'

/** A token value that is long enough for the redactor to treat it as a secret. */
export const TEST_TOKEN = 'figd_TESTTOKENVALUE0123456789'

/**
 * Wrap a payload as an HTTP response.
 *
 * @param {unknown} payload - JSON payload.
 * @param {{status?: number, headers?: Record<string, string>}} [options] - Response options.
 * @returns {Response} Response object.
 */
export function jsonResponse(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
}

/**
 * Build a transport stub that records every call.
 *
 * @param {(request: {url: string, path: string, search: URLSearchParams, init: RequestInit, index: number}) => Response|Promise<Response>} handler
 *   Response factory.
 * @returns {{fetchImpl: typeof fetch, calls: Array<{url: string, path: string, search: URLSearchParams, init: RequestInit}>}} Stub and its call log.
 */
export function createFetchStub(handler) {
  /** @type {Array<{url: string, path: string, search: URLSearchParams, init: RequestInit}>} */
  const calls = []
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = new URL(url)
    const record = { url, path: parsed.pathname, search: parsed.searchParams, init }
    calls.push(record)
    return handler({ ...record, index: calls.length - 1 })
  }
  return { fetchImpl, calls }
}

/**
 * A clock that only advances when a test says so.
 *
 * @param {number} [start] - Initial epoch milliseconds.
 * @returns {{now: () => number, advance: (ms: number) => void}} Clock.
 */
export function createFakeClock(start = 1_700_000_000_000) {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

/**
 * A sleeper that advances a fake clock instead of waiting.
 *
 * @param {{advance: (ms: number) => void}} clock - The clock to advance.
 * @returns {(ms: number) => Promise<void>} Sleeper.
 */
export function createInstantSleep(clock) {
  return async (ms) => {
    clock.advance(ms)
  }
}

/**
 * Build a provider wired for deterministic tests.
 *
 * @param {object} [overrides] - Dependency overrides.
 * @param {typeof fetch} [overrides.fetchImpl] - Transport stub.
 * @param {Record<string, unknown>} [overrides.config] - Provider configuration.
 * @param {import('../../src/core/types.js').TokenSource} [overrides.tokenSource] - Credential seam.
 * @param {import('../../src/core/types.js').SpoolSink} [overrides.spool] - Persistence seam.
 * @param {() => number} [overrides.now] - Clock.
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [overrides.sleepImpl] - Sleeper.
 * @param {readonly import('../../src/core/types.js').CapabilitySpec[]} [overrides.specs] - Capability table.
 * @param {string} [overrides.token] - Token value the default token source resolves to.
 * @returns {{provider: ReturnType<typeof createProvider>, spool: ReturnType<typeof createMemorySpool>, clock: {now: () => number, advance: (ms: number) => void}, setToken: (value: string|undefined) => void, setFetch: (impl: typeof fetch) => void}} Harness.
 */
export function createHarness(overrides = {}) {
  const clock = createFakeClock()
  const spool = overrides.spool ?? createMemorySpool()
  let token = 'token' in overrides ? overrides.token : TEST_TOKEN
  let fetchImpl = overrides.fetchImpl ?? (async () => jsonResponse({}))

  const tokenSource =
    overrides.tokenSource ??
    createTokenSource({
      ref: 'FIGMA_TOKEN',
      resolve: async () => token,
    })

  const provider = createProvider({
    tokenSource,
    spool,
    config: {
      cacheTtlMs: 60_000,
      maxResultBytes: 262_144,
      budgetTokens: 8_000,
      ...overrides.config,
    },
    fetchImpl: (input, init) => fetchImpl(input, init),
    now: overrides.now ?? clock.now,
    sleepImpl: overrides.sleepImpl ?? createInstantSleep(clock),
    random: () => 0.5,
    ...(overrides.specs === undefined ? {} : { specs: overrides.specs }),
  })

  return {
    provider,
    spool,
    clock,
    setToken: (value) => {
      token = value
    },
    setFetch: (impl) => {
      fetchImpl = impl
    },
  }
}

/**
 * Concatenate every text block of a tool value.
 *
 * @param {{content: Array<Record<string, unknown>>}} value - Provider result.
 * @returns {string} Joined text.
 */
export function textOf(value) {
  return value.content
    .filter((block) => block.type === 'text')
    .map((block) => String(block.text))
    .join('\n')
}

/**
 * Parse the structured content of a tool value out of its text block.
 *
 * @param {{structuredContent: Record<string, unknown>}} value - Provider result.
 * @returns {Record<string, unknown>} Structured content.
 */
export function structuredOf(value) {
  return value.structuredContent
}
