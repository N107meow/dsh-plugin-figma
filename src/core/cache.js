/**
 * A TTL cache with LRU eviction — and nothing else.
 *
 * ## What is deliberately absent, and why
 *
 * There is **no ETag and no conditional-request branch**. Figma's `/meta`
 * endpoint returns an `etag`, but re-requesting with `If-None-Match` answers
 * `200` with the full body rather than `304`, and it explicitly sends
 * `cache-control: no-cache, no-store`. The other two endpoints send no `etag`
 * at all. A `304` branch here would be dead code that looks like an
 * optimization, so it does not exist.
 *
 * Staleness is handled instead by a short TTL and by explicit invalidation when
 * `/meta` reports a new `version`.
 *
 * @module dsh-plugin-figma/core/cache
 */

/**
 * @template V
 */
export class TtlCache {
  /** @type {Map<string, {value: V, expiresAt: number}>} */
  #entries = new Map()
  /** @type {number} */
  #maxEntries
  /** @type {() => number} */
  #now

  /**
   * @param {{maxEntries?: number, now?: () => number}} [options] - Capacity and clock.
   */
  constructor(options = {}) {
    this.#maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 64))
    this.#now = options.now ?? Date.now
  }

  /** @returns {number} Live entry count, expired entries excluded. */
  get size() {
    this.#sweep()
    return this.#entries.size
  }

  /**
   * Read one entry, treating an expired one as absent.
   *
   * @param {string} key - Cache key.
   * @returns {V|undefined} The value, or `undefined`.
   */
  get(key) {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key)
      return undefined
    }
    // Re-insert to move this key to the most-recently-used end of the Map.
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  /**
   * Store one entry.
   *
   * @param {string} key - Cache key.
   * @param {V} value - Value to store.
   * @param {number} ttlMs - Lifetime in milliseconds.
   */
  set(key, value, ttlMs) {
    if (this.#entries.has(key)) this.#entries.delete(key)
    this.#entries.set(key, { value, expiresAt: this.#now() + Math.max(1, ttlMs) })
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
    }
  }

  /**
   * Drop one entry.
   *
   * @param {string} key - Cache key.
   * @returns {boolean} Whether an entry was removed.
   */
  delete(key) {
    return this.#entries.delete(key)
  }

  /**
   * Drop every entry whose key starts with a prefix.
   *
   * Cache keys are JSON arrays whose first element is the capability name and
   * whose second is the file key, so a prefix of `["file_nodes","<fileKey>"` is
   * exactly "everything cached for this file under this capability".
   *
   * @param {string} prefix - Key prefix.
   * @returns {number} How many entries were removed.
   */
  invalidatePrefix(prefix) {
    let removed = 0
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  /**
   * Drop every entry whose key satisfies a predicate.
   *
   * `invalidatePrefix` cannot express "every capability's entry for this one
   * file key", because the file key is not the last element of the key. This is
   * the exact form of the same operation.
   *
   * @param {(key: string) => boolean} predicate - Key test.
   * @returns {number} How many entries were removed.
   */
  invalidateWhere(predicate) {
    let removed = 0
    for (const key of [...this.#entries.keys()]) {
      if (predicate(key)) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  /** Remove every entry. */
  clear() {
    this.#entries.clear()
  }

  /** Drop expired entries. */
  #sweep() {
    const now = this.#now()
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key)
    }
  }
}

/**
 * Build the filesystem-safe name for one cached payload.
 *
 * @param {string} key - Cache key.
 * @param {string} extension - File extension without the dot.
 * @returns {string} Stable file name.
 */
export function spoolNameFor(key, extension) {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}-${key.length.toString(16)}.${extension}`
}
