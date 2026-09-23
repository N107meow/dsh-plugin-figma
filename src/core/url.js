/**
 * Figma URL and identifier parsing.
 *
 * The model is handed a **link**, not a file key, so this module absorbs the
 * whole class of "which path segment is the key?" and "why does the node id
 * have a dash?" failures before they reach the model's working memory.
 *
 * @module dsh-plugin-figma/core/url
 */

/**
 * A parsed Figma target. At least one of the two fields is always present; a
 * bare node id carries no file key of its own, so the caller is expected to
 * combine it with a file key it already has.
 *
 * @typedef {object} FigmaTarget
 * @property {string|undefined} fileKey - 22-character alphanumeric file key, when the input carried one.
 * @property {string|undefined} nodeId - Node id in API spelling (`12:345`), when the input carried one.
 */

/** Path segments that name a Figma design document. */
const DESIGN_PATH_SEGMENTS = new Set(['file', 'design', 'board', 'proto', 'slides'])

/**
 * A file key as it appears in a URL: alphanumeric, comfortably longer than any
 * English word that would otherwise be mistaken for one. Real Figma keys are
 * 22 characters.
 */
const FILE_KEY_PATTERN = /^[A-Za-z0-9]{16,64}$/

/** A node id written the way the API wants it (`12:345`) or the way a URL or a human writes it (`12-345`). */
const NODE_ID_PATTERN = /^(\d+)[-:](\d+)$/

/**
 * Decode one URI component without throwing on malformed input.
 *
 * @param {string} value - Possibly percent-encoded text.
 * @returns {string} Decoded text, or the input unchanged when decoding fails.
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Reject inputs that are obviously not a Figma target.
 *
 * @param {unknown} value - Candidate.
 * @returns {boolean} Whether the value is a non-empty string.
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Normalize a node id to the spelling the REST API uses.
 *
 * A Figma URL writes `?node-id=12-345`; every REST endpoint wants `12:345`.
 * Skipping this conversion is one of the easiest mistakes to make and one of
 * the hardest to notice, because the API simply answers "not found".
 *
 * @param {unknown} value - Node id in either spelling, possibly percent-encoded.
 * @returns {string|undefined} API spelling, or `undefined` when the input is not a node id.
 */
export function normalizeNodeId(value) {
  if (typeof value !== 'string') return undefined
  const decoded = safeDecode(value).trim()
  const match = NODE_ID_PATTERN.exec(decoded)
  if (match === null) return undefined
  return `${match[1]}:${match[2]}`
}

/**
 * Parse a Figma design link, a bare file key, or a bare node id.
 *
 * Returns `undefined` instead of throwing: the caller decides whether that is a
 * bad argument, an ignored hint, or a reason to fall back to another field.
 *
 * Accepted shapes:
 * - `https://www.figma.com/{file,design,board,proto,slides}/<key>/<name>?node-id=12-345`
 * - the same without a scheme (`www.figma.com/design/…`)
 * - a bare 22-character-alphanumeric file key
 * - a bare node id (`12:345` or `12-345`)
 *
 * Tracking parameters (`?t=…`), page parameters, and the document title after
 * the key are all ignored.
 *
 * @param {string} input - Raw user- or model-supplied text.
 * @returns {FigmaTarget|undefined} Parsed target, or `undefined` when the input is not a Figma target.
 */
export function parseFigmaUrl(input) {
  if (!isNonEmptyString(input)) return undefined
  const raw = input.trim()

  const bareNodeId = normalizeNodeId(raw)
  if (bareNodeId !== undefined) return { fileKey: undefined, nodeId: bareNodeId }

  if (FILE_KEY_PATTERN.test(raw)) return { fileKey: raw, nodeId: undefined }

  const url = toUrl(raw)
  if (url === undefined) return undefined

  const host = url.hostname.toLowerCase()
  if (host !== 'figma.com' && !host.endsWith('.figma.com')) return undefined

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length < 2) return undefined
  if (!DESIGN_PATH_SEGMENTS.has(segments[0].toLowerCase())) return undefined

  const fileKey = segments[1]
  if (!FILE_KEY_PATTERN.test(fileKey)) return undefined

  const nodeId = normalizeNodeId(url.searchParams.get('node-id') ?? undefined)
  return { fileKey, nodeId }
}

/**
 * Build a URL from text that may omit its scheme.
 *
 * @param {string} raw - Trimmed input.
 * @returns {URL|undefined} Parsed URL, or `undefined` when it is not URL-shaped.
 */
function toUrl(raw) {
  const candidates = raw.includes('://') ? [raw] : [`https://${raw}`]
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url
    } catch {
      // fall through to the next candidate
    }
  }
  return undefined
}

/**
 * Render a parse failure as text the model can act on.
 *
 * @param {string} input - The rejected input.
 * @returns {string} Remedy text.
 */
export function describeUnparsableTarget(input) {
  const shown = typeof input === 'string' ? input.slice(0, 200) : String(input)
  return (
    `"${shown}" is not a recognizable Figma target. Pass the full link copied from Figma ` +
    '(https://www.figma.com/design/<fileKey>/<name>?node-id=12-345), or a bare file key.'
  )
}
