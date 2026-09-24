/**
 * Retry policy.
 *
 * The rule is narrow on purpose: **only 429 and 5xx are retried.** A 401, 403,
 * or 404 will produce exactly the same answer the second time — retrying a
 * credential failure burns a rate-limit token and, worse, makes the model think
 * the problem was transient.
 *
 * @module figma-mcp-dsh/core/retry
 */

/**
 * @typedef {object} RetryPolicy
 * @property {number} maxAttempts - Total attempts including the first.
 * @property {number} baseDelayMs - First backoff step, before jitter.
 * @property {number} maxDelayMs - Ceiling on locally computed backoff.
 */

/** Default policy: three attempts, 500ms first step, capped at 30s. */
export const DEFAULT_RETRY_POLICY = Object.freeze({ maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000 })

/**
 * @typedef {object} RetryVerdict
 * @property {boolean} retryable - Whether another attempt is allowed.
 * @property {number} [retryAfterMs] - Server-specified delay, which wins over local backoff.
 */

/**
 * Wait for a delay, honoring cancellation.
 *
 * @param {number} ms - Milliseconds to wait.
 * @param {AbortSignal} [signal] - Cancellation.
 * @param {(ms: number) => Promise<void>} [sleepImpl] - Injected sleeper, for deterministic tests.
 * @returns {Promise<void>} Resolves after the delay.
 */
async function sleep(ms, signal, sleepImpl) {
  if (signal?.aborted === true) throw abortReason(signal)
  if (ms <= 0) return
  if (sleepImpl !== undefined) {
    await sleepImpl(ms)
    if (signal?.aborted === true) throw abortReason(signal)
    return
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Build the value to throw when a wait is cancelled.
 *
 * @param {AbortSignal|undefined} signal - The aborted signal.
 * @returns {Error} Abort reason.
 */
function abortReason(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error('aborted while waiting to retry')
  error.name = 'AbortError'
  return error
}

/**
 * Run an attempt function with bounded, jittered retries.
 *
 * `classify` inspects whatever the attempt threw and decides whether another
 * try is warranted. It is injected rather than hard-coded so the retry loop
 * knows nothing about Figma status codes.
 *
 * @template T
 * @param {() => Promise<T>} attempt - One attempt.
 * @param {(result: unknown) => RetryVerdict} classify - Retry decision for the thrown value.
 * @param {RetryPolicy} [policy] - Retry policy.
 * @param {AbortSignal} [signal] - Cancellation.
 * @param {{sleepImpl?: (ms: number) => Promise<void>, random?: () => number, onRetry?: (info: {attempt: number, delayMs: number}) => void}} [options] - Test seams.
 * @returns {Promise<T>} The first successful result.
 */
export async function withRetry(attempt, classify, policy = DEFAULT_RETRY_POLICY, signal, options = {}) {
  const random = options.random ?? Math.random
  let lastError

  for (let index = 0; index < policy.maxAttempts; index += 1) {
    if (signal?.aborted === true) throw abortReason(signal)
    try {
      return await attempt()
    } catch (error) {
      lastError = error
      const verdict = classify(error)
      const isLast = index === policy.maxAttempts - 1
      if (!verdict.retryable || isLast) break

      const delayMs = verdict.retryAfterMs ?? backoffDelay(policy, index, random)
      options.onRetry?.({ attempt: index + 1, delayMs })
      await sleep(delayMs, signal, options.sleepImpl)
    }
  }

  throw lastError
}

/**
 * Compute the local backoff step with full jitter.
 *
 * Jitter matters because the token bucket deliberately lets several requests
 * through at once; without it they would all retry on the same tick and trip
 * the same limit again.
 *
 * @param {RetryPolicy} policy - Retry policy.
 * @param {number} attemptIndex - Zero-based attempt that just failed.
 * @param {() => number} random - Random source in `[0, 1)`.
 * @returns {number} Delay in milliseconds.
 */
export function backoffDelay(policy, attemptIndex, random = Math.random) {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attemptIndex)
  return Math.round(exponential * (0.5 + 0.5 * random()))
}
