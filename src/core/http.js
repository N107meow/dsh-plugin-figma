/**
 * The one place that talks to Figma over HTTP.
 *
 * Three properties here are load-bearing:
 *
 * 1. **Redirects are never followed.** The credential travels in a request
 *    header, and following a redirect would hand it to whatever host the
 *    response names. This is a security requirement, not a style preference, so
 *    a caller cannot opt out of it.
 * 2. **The body comes back as a string.** Error bodies are not always JSON, and
 *    deciding how to parse is the caller's business, not this module's.
 * 3. **Every outgoing diagnostic is redacted.** A network failure message can
 *    echo a URL; a redactor is applied before the message escapes.
 *
 * @module dsh-plugin-figma/core/http
 */

/**
 * A transport failure: DNS, TLS, timeout, or an aborted caller. Distinct from a
 * `FigmaError`, which describes a response Figma actually sent.
 */
export class HttpError extends Error {
  /**
   * @param {string} message - Redacted, human-readable message.
   * @param {{code: string, aborted: boolean, timedOut: boolean, cause?: unknown}} details - Classified failure facts.
   */
  constructor(message, details) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'HttpError'
    this.code = details.code
    this.aborted = details.aborted
    this.timedOut = details.timedOut
  }
}

/** Default per-request deadline. A tool call must not be able to hang on a stalled socket. */
export const DEFAULT_TIMEOUT_MS = 20_000

/**
 * @typedef {object} HttpRequest
 * @property {string} url - Absolute request URL.
 * @property {Record<string, string>} [headers] - Request headers, already including any credential.
 * @property {AbortSignal} [signal] - Caller cancellation (the tool-call signal).
 * @property {typeof fetch} [fetchImpl] - Injected transport, for deterministic tests.
 * @property {number} [timeoutMs] - Deadline for this request; defaults to {@link DEFAULT_TIMEOUT_MS}.
 * @property {'error'} [redirect] - Only `'error'` is accepted; anything else is refused.
 * @property {(text: string) => string} [redact] - Scrubber applied to transport error messages.
 * @property {string} [operation] - Short label used in error messages.
 */

/**
 * @typedef {object} HttpResponse
 * @property {number} status - HTTP status code.
 * @property {Record<string, string>} headers - Lower-cased response headers.
 * @property {string} body - Response body as text (empty string when there is none).
 */

/**
 * @typedef {object} HttpBytesResponse
 * @property {number} status - HTTP status code.
 * @property {Record<string, string>} headers - Lower-cased response headers.
 * @property {Uint8Array} bytes - Response body as raw bytes.
 */

/**
 * Refuse any redirect policy other than `'error'`.
 *
 * @param {unknown} redirect - Requested policy.
 */
function assertRedirectPolicy(redirect) {
  if (redirect !== undefined && redirect !== 'error') {
    throw new TypeError(
      `figmaFetch refuses redirect policy "${String(redirect)}": following a redirect would send the Figma ` +
        'credential to a host Figma did not name. Only "error" is accepted.',
    )
  }
}

/**
 * Flatten a `Headers` object into a lower-cased plain record.
 *
 * @param {Headers} headers - Response headers.
 * @returns {Record<string, string>} Plain record.
 */
export function headersToRecord(headers) {
  /** @type {Record<string, string>} */
  const out = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

/**
 * Combine the caller's signal with this request's own deadline.
 *
 * @param {AbortSignal|undefined} signal - Caller signal.
 * @param {number} timeoutMs - Deadline in milliseconds.
 * @returns {{signal: AbortSignal, cleanup: () => void, timedOut: () => boolean}} Combined signal and teardown.
 */
function withDeadline(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('timeout'))
  }, timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()

  const onAbort = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * Perform one Figma request and read the response as text.
 *
 * @param {HttpRequest} request - Request description.
 * @returns {Promise<HttpResponse>} Status, headers, and body text.
 */
export async function figmaFetch(request) {
  assertRedirectPolicy(request.redirect)
  const response = await perform(request)
  const body = await readBody(response, request)
  return { status: response.status, headers: headersToRecord(response.headers), body }
}

/**
 * Perform one request and read the response as raw bytes.
 *
 * Used for rendered images. Those URLs are short-lived signed links on a
 * third-party host, so callers must **not** attach the Figma credential to
 * them; this function sends only what the caller passes in `headers`.
 *
 * @param {HttpRequest} request - Request description.
 * @returns {Promise<HttpBytesResponse>} Status, headers, and body bytes.
 */
export async function figmaFetchBytes(request) {
  assertRedirectPolicy(request.redirect)
  const response = await perform(request)
  let bytes
  try {
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    throw transportError(error, request, false)
  }
  return { status: response.status, headers: headersToRecord(response.headers), bytes }
}

/**
 * Issue the request itself, normalizing transport failures.
 *
 * @param {HttpRequest} request - Request description.
 * @returns {Promise<Response>} Raw response.
 */
async function perform(request) {
  const fetchImpl = request.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new HttpError('no fetch implementation is available in this runtime', {
      code: 'NO_FETCH',
      aborted: false,
      timedOut: false,
    })
  }

  const deadline = withDeadline(request.signal, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    return await fetchImpl(request.url, {
      method: 'GET',
      headers: request.headers ?? {},
      redirect: 'error',
      signal: deadline.signal,
    })
  } catch (error) {
    throw transportError(error, request, deadline.timedOut())
  } finally {
    deadline.cleanup()
  }
}

/**
 * Read a response body as text without letting a read failure escape unclassified.
 *
 * @param {Response} response - Raw response.
 * @param {HttpRequest} request - Originating request, for the error message.
 * @returns {Promise<string>} Body text.
 */
async function readBody(response, request) {
  try {
    return await response.text()
  } catch (error) {
    throw transportError(error, request, false)
  }
}

/**
 * Turn any thrown transport failure into a classified {@link HttpError}.
 *
 * @param {unknown} error - Thrown value.
 * @param {HttpRequest} request - Originating request.
 * @param {boolean} timedOut - Whether this request's own deadline fired.
 * @returns {HttpError} Classified failure.
 */
function transportError(error, request, timedOut) {
  const scrub = request.redact ?? ((text) => text)
  const operation = request.operation ?? 'request'
  const callerAborted = request.signal?.aborted === true && !timedOut
  const rawMessage = error instanceof Error ? error.message : String(error)

  if (timedOut) {
    return new HttpError(
      scrub(`Figma did not respond within ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms (${operation}).`),
      { code: 'TIMEOUT', aborted: false, timedOut: true, cause: error },
    )
  }
  if (callerAborted) {
    return new HttpError(scrub(`The ${operation} was cancelled before Figma answered.`), {
      code: 'ABORTED',
      aborted: true,
      timedOut: false,
      cause: error,
    })
  }
  return new HttpError(scrub(`Could not reach Figma (${operation}): ${rawMessage}`), {
    code: 'NETWORK',
    aborted: false,
    timedOut: false,
    cause: error,
  })
}
