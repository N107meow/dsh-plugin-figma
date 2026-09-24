/**
 * Credential handling: the thin token seam plus one place that scrubs secrets
 * out of everything the model or a log can see.
 *
 * Two rules live here:
 *
 * 1. **Resolution is per operation.** `resolve()` is called before every
 *    request and the result is never stored. That per-call read is what makes a
 *    rotated token take effect on the next call with no restart.
 * 2. **Anything that leaves this plugin is redacted.** The token travels in a
 *    request header and appears in no other place, and every outgoing string
 *    passes a redactor first.
 *
 * @module figma-mcp-dsh/core/auth
 */

import { createHash } from 'node:crypto'

/** What a secret becomes when it is scrubbed out of a message. */
export const REDACTED = 'figma_***'

/**
 * Shortest secret worth scrubbing. Below this a "secret" is likely to collide
 * with ordinary text and mangling unrelated output would be worse than the
 * leak it prevents.
 */
const MIN_REDACTABLE_LENGTH = 8

/**
 * A stable, non-reversible fingerprint of a credential value.
 *
 * Used as the in-process memo key for "this exact credential is known bad", so
 * the memo survives a token rotation without ever holding the token itself and
 * without depending on a clock.
 *
 * @param {string} value - Credential value.
 * @returns {string} Hex SHA-256 digest.
 */
export function hashSecret(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Collects secret values and removes them from outgoing text.
 *
 * A redactor is shared by the whole provider instance, so a token learned while
 * resolving a credential is scrubbed from HTTP errors, projection output, and
 * tool results without every call site remembering to do it.
 */
export class Redactor {
  /** @type {Set<string>} */
  #secrets = new Set()

  /**
   * Start scrubbing one value everywhere.
   *
   * @param {unknown} secret - Secret value; short or non-string values are ignored.
   * @returns {this} This redactor, for chaining.
   */
  remember(secret) {
    if (typeof secret === 'string' && secret.length >= MIN_REDACTABLE_LENGTH) this.#secrets.add(secret)
    return this
  }

  /**
   * Stop scrubbing one value — called when a credential is replaced, so a
   * rotated token does not keep mangling output that legitimately contains its
   * old text.
   *
   * @param {unknown} secret - Previously remembered value.
   * @returns {this} This redactor, for chaining.
   */
  forget(secret) {
    if (typeof secret === 'string') this.#secrets.delete(secret)
    return this
  }

  /** @returns {number} How many distinct values are currently scrubbed. */
  get size() {
    return this.#secrets.size
  }

  /**
   * Replace every remembered secret in one string.
   *
   * Both the raw and the percent-encoded spelling are replaced, because a
   * secret that reaches a URL query string is still the same secret.
   *
   * @param {unknown} text - Text about to leave the plugin.
   * @returns {string} Text with every known secret replaced by {@link REDACTED}.
   */
  redact(text) {
    let out = typeof text === 'string' ? text : String(text ?? '')
    for (const secret of this.#secrets) {
      out = replaceAll(out, secret, REDACTED)
      const encoded = encodeURIComponent(secret)
      if (encoded !== secret) out = replaceAll(out, encoded, REDACTED)
    }
    return out
  }
}

/**
 * Literal, non-regex replacement of every occurrence.
 *
 * @param {string} haystack - Text to scrub.
 * @param {string} needle - Literal to find.
 * @param {string} replacement - Replacement text.
 * @returns {string} Scrubbed text.
 */
function replaceAll(haystack, needle, replacement) {
  if (needle.length === 0 || !haystack.includes(needle)) return haystack
  return haystack.split(needle).join(replacement)
}

/**
 * The credential-reference grammar: a POSIX shell identifier.
 *
 * The host's credential seam accepts exactly this shape and rejects anything
 * else. Validating here means a malformed configured name produces a readable
 * remedy instead of an exception thrown from inside credential resolution —
 * and means the adapter needs no import beyond the tool registry and the config
 * schema.
 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Whether a raw string could name a credential reference.
 *
 * @param {unknown} value - Candidate name.
 * @returns {boolean} Whether it is a valid reference name.
 */
export function isCredentialRefName(value) {
  return typeof value === 'string' && CREDENTIAL_REF_PATTERN.test(value)
}

/**
 * Build the token source the provider consumes.
 *
 * @param {{ref: string, resolve: () => Promise<string|undefined>}} spec - Credential reference name and its resolver.
 * @returns {import('./types.js').TokenSource} Token source.
 */
export function createTokenSource(spec) {
  return {
    ref: spec.ref,
    resolve: spec.resolve,
  }
}

/**
 * The scope set this plugin actually needs, all read-only. Used verbatim in
 * remedy text so a user reissuing a token can copy one line.
 */
export const READ_ONLY_SCOPES = Object.freeze([
  'file_content:read',
  'file_metadata:read',
  'file_comments:read',
  'file_dev_resources:read',
])

/**
 * Every place a credential can be delivered, phrased as ordered steps.
 *
 * @param {string} ref - Credential reference name.
 * @returns {string} Remedy text.
 */
export function credentialDeliverySteps(ref) {
  return (
    `  1. Open https://www.figma.com/settings → Security → Personal access tokens → Generate new token\n` +
    `  2. Enable the read-only scopes: ${READ_ONLY_SCOPES.join(', ')}\n` +
    `  3. Write the new token into ~/.dsh/.credentials.yaml under refs.${ref} ` +
    `(saved and applied immediately — no restart needed), or export ${ref}=<token> in the launching shell\n`
  )
}
