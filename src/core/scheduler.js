/**
 * Request scheduling: a token bucket per rate-limit tier, and single-flight
 * collapsing so a repeated request costs one HTTP call instead of five.
 *
 * ## Why the defaults are this conservative
 *
 * Figma's budget is the product of **seat type**, **endpoint tier**, and **the
 * plan the file lives in**. A full seat on a Starter-plan file gets a budget
 * measured in requests per *month*, and the plugin cannot tell which of those
 * a given token is before it has already spent a request finding out.
 *
 * So the defaults are the weakest seat's numbers, and the bucket only widens
 * after Figma itself says so on a 429 response header. Being slow for the first
 * few calls is recoverable; exhausting someone's monthly budget is not.
 *
 * @module dsh-plugin-figma/core/scheduler
 */

/**
 * One tier's budget.
 *
 * @typedef {object} RateLimitConfig
 * @property {number} perMinute - Sustained requests per minute.
 * @property {number} burst - Tokens available at once.
 * @property {number} [highPerMinute] - Widened rate applied after Figma reports a full/dev seat.
 * @property {number} [highBurst] - Widened burst for the same case.
 * @property {number} [lowPerMinute] - Tightened rate applied after Figma reports a view/collaborator seat.
 * @property {number} [lowBurst] - Tightened burst for the same case.
 */

/**
 * Default budgets, deliberately set for the weakest seat rather than the one
 * this machine happens to have.
 *
 * @type {Readonly<{tier1: RateLimitConfig, tier2: RateLimitConfig, tier3: RateLimitConfig}>}
 */
export const DEFAULT_RATE_LIMITS = Object.freeze({
  tier1: Object.freeze({ perMinute: 5, burst: 1 }),
  tier2: Object.freeze({ perMinute: 10, burst: 2 }),
  tier3: Object.freeze({ perMinute: 20, burst: 3 }),
})

/**
 * Wait for a delay, honoring cancellation.
 *
 * @param {number} ms - Milliseconds to wait.
 * @param {AbortSignal} [signal] - Cancellation.
 * @returns {Promise<void>} Resolves after the delay.
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * A token bucket that queues instead of dropping.
 *
 * Queueing is the point: the tool result reports how long it waited, and the
 * model learns to ask for less. Dropping the request would look like a failure.
 */
export class TokenBucket {
  /** @type {RateLimitConfig} */
  #configured
  /** @type {number} */
  #perMinute
  /** @type {number} */
  #capacity
  /** @type {number} */
  #tokens
  /** @type {number} */
  #updatedAt
  /** @type {() => number} */
  #now
  /** @type {(ms: number, signal?: AbortSignal) => Promise<void>} */
  #sleep
  /** @type {Array<'high'|'low'|undefined>} */
  #calibrations = []

  /**
   * @param {RateLimitConfig} config - Tier budget.
   * @param {() => number} [now] - Clock, injectable so tests need no real time.
   * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [sleepImpl] - Sleeper, injectable for the same reason.
   */
  constructor(config, now = Date.now, sleepImpl = defaultSleep) {
    const perMinute = Math.max(1, Math.floor(config.perMinute))
    const burst = Math.max(1, Math.floor(config.burst))
    this.#configured = {
      perMinute,
      burst,
      highPerMinute: Math.max(perMinute, Math.floor(config.highPerMinute ?? Math.min(60, perMinute * 4))),
      highBurst: Math.max(burst, Math.floor(config.highBurst ?? Math.max(burst, 2))),
      lowPerMinute: Math.max(1, Math.floor(config.lowPerMinute ?? Math.max(1, Math.floor(perMinute / 2)))),
      lowBurst: Math.max(1, Math.floor(config.lowBurst ?? 1)),
    }
    this.#now = now
    this.#sleep = sleepImpl
    this.#perMinute = this.#configured.perMinute
    this.#capacity = this.#configured.burst
    this.#tokens = this.#capacity
    this.#updatedAt = now()
  }

  /** @returns {number} The rate currently in force, in requests per minute. */
  get limit() {
    return this.#perMinute
  }

  /** @returns {number} The burst currently in force. */
  get capacity() {
    return this.#capacity
  }

  /** @returns {number} Tokens available right now, after refilling. */
  get available() {
    this.#refill()
    return this.#tokens
  }

  /** @returns {readonly ('high'|'low'|undefined)[]} Every calibration Figma has triggered, in order. */
  get calibrations() {
    return this.#calibrations
  }

  /**
   * Take one token, waiting when the bucket is empty.
   *
   * @param {AbortSignal} [signal] - Cancellation.
   * @returns {Promise<{waitedMs: number}>} How long the caller queued.
   */
  async acquire(signal) {
    const startedAt = this.#now()
    for (;;) {
      if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      this.#refill()
      if (this.#tokens >= 1) {
        this.#tokens -= 1
        return { waitedMs: Math.max(0, this.#now() - startedAt) }
      }
      const ratePerMs = this.#perMinute / 60_000
      const waitMs = Math.max(1, Math.ceil((1 - this.#tokens) / ratePerMs))
      await this.#sleep(waitMs, signal)
    }
  }

  /**
   * Correct the bucket from a 429 response.
   *
   * These headers appear **only** on a 429, so this is the sole moment the real
   * budget can be observed; during normal operation the local numbers are all
   * there is.
   *
   * @param {'high'|'low'|undefined} limitType - `X-Figma-Rate-Limit-Type`, when present.
   */
  calibrate(limitType) {
    if (limitType === 'high') {
      this.#perMinute = this.#configured.highPerMinute ?? this.#perMinute
      this.#capacity = this.#configured.highBurst ?? this.#capacity
    } else if (limitType === 'low') {
      this.#perMinute = this.#configured.lowPerMinute ?? this.#perMinute
      this.#capacity = this.#configured.lowBurst ?? this.#capacity
    }
    this.#tokens = Math.min(this.#tokens, this.#capacity)
    this.#calibrations.push(limitType)
  }

  /** Add the tokens the elapsed time has earned, capped at the burst size. */
  #refill() {
    const now = this.#now()
    const elapsed = Math.max(0, now - this.#updatedAt)
    this.#updatedAt = now
    if (elapsed === 0) return
    this.#tokens = Math.min(this.#capacity, this.#tokens + (elapsed * this.#perMinute) / 60_000)
  }
}

/**
 * Collapse concurrent identical requests into one.
 *
 * Directly valuable under a rate limit: three components asking for the same
 * frame in one turn should cost one request, not three.
 */
export class SingleFlight {
  /** @type {Map<string, Promise<unknown>>} */
  #inflight = new Map()

  /** @returns {number} How many distinct requests are in flight. */
  get size() {
    return this.#inflight.size
  }

  /**
   * Run `fn` once per key while a call for that key is in flight.
   *
   * @template T
   * @param {string} key - Request identity.
   * @param {() => Promise<T>} fn - The work to collapse.
   * @returns {Promise<T>} The shared result.
   */
  run(key, fn) {
    const existing = this.#inflight.get(key)
    if (existing !== undefined) return /** @type {Promise<T>} */ (existing)

    const promise = fn().finally(() => {
      this.#inflight.delete(key)
    })
    this.#inflight.set(key, promise)
    return promise
  }
}
