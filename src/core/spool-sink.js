/**
 * The oversize-persistence seam.
 *
 * Core defines *where* oversized payloads go but never touches a filesystem —
 * the adapter supplies the implementation. This module therefore contains the
 * interface's shared helpers: name validation, and two sinks that tests and
 * degraded deployments can use.
 *
 * @module dsh-plugin-figma/core/spool-sink
 */

/** Directory name used when nothing else is configured. */
export const DEFAULT_SPOOL_DIR = '.figma'

/**
 * Reject a spool name that could escape the spool directory.
 *
 * Names are generated (a hash plus an extension), never taken from model input,
 * but this guard exists so that stays true if a future caller passes something
 * else: a write that escapes its directory would land outside the session
 * workspace, which is the one thing this seam must never do.
 *
 * @param {string} name - Candidate relative name.
 * @returns {string} The validated name.
 * @throws {TypeError} When the name is absolute or contains a parent traversal.
 */
export function assertSafeSpoolName(name) {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('spool name must be a non-empty string')
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) {
    throw new TypeError(`spool name must be relative, got "${name}"`)
  }
  const segments = name.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) {
    throw new TypeError(`spool name must not contain a parent traversal, got "${name}"`)
  }
  return name
}

/**
 * A sink that persists nothing.
 *
 * Used when no filesystem is mounted: oversized results still degrade to a
 * skeleton, they simply carry no path to read later. Degrading is the point —
 * the alternative would be to keep an oversized payload in context or fail the
 * call.
 *
 * @returns {import('./types.js').SpoolSink} A no-op sink.
 */
export function createNullSpool() {
  return {
    async write() {
      return undefined
    },
    async writeImage() {
      return undefined
    },
    async saveImage() {
      return undefined
    },
  }
}

/**
 * An in-memory sink, for tests.
 *
 * @param {{basePath?: string}} [options] - Path prefix reported back to callers.
 * @returns {import('./types.js').SpoolSink & {files: Map<string, string>, images: Map<string, Uint8Array>, attachments: Array<{name: string, mediaType: string, bytes: number}>}} A recording sink.
 */
export function createMemorySpool(options = {}) {
  const basePath = options.basePath ?? '/memory'
  /** @type {Map<string, string>} */
  const files = new Map()
  /** @type {Map<string, Uint8Array>} */
  const images = new Map()
  /** @type {Array<{name: string, mediaType: string, bytes: number}>} */
  const attachments = []

  return {
    files,
    images,
    attachments,
    async write(name, content) {
      const safe = assertSafeSpoolName(name)
      files.set(safe, content)
      return `${basePath}/${safe}`
    },
    async writeImage(name, bytes) {
      const safe = assertSafeSpoolName(name)
      images.set(safe, bytes)
      return `${basePath}/${safe}`
    },
    async saveImage(input) {
      attachments.push({ name: input.name, mediaType: input.mediaType, bytes: input.bytes.byteLength })
      return {
        attachmentId: `mem-${attachments.length}`,
        mediaType: input.mediaType,
        bytes: input.bytes.byteLength,
        width: 1,
        height: 1,
        name: input.name,
      }
    },
  }
}
