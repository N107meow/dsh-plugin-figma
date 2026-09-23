/**
 * Projection: raw Figma node trees to something a design engineer can read.
 *
 * This module is where the single most dangerous silent bug in the project
 * lives, so it is stated plainly:
 *
 * > A paint's `color.a` is the **color's alpha channel**, not the layer's
 * > transparency. Layer transparency is a **different field**, `fill.opacity`.
 *
 * Mixing them up does not fail. It produces a plausible-looking hex that is
 * simply wrong, and it is invisible on any file whose fills all happen to be
 * opaque — which is most of them. So: the hex is computed from `r`/`g`/`b`
 * only, and transparency is read from `fill.opacity` and emitted only when it
 * is not 1.
 *
 * Everything else here is a whitelist. A Figma node object carries close to a
 * hundred fields and almost none of them help the model; the discarded ones are
 * listed in `DISCARDED_NODE_FIELDS` so the next reader does not have to guess
 * whether an omission was deliberate.
 *
 * @module dsh-plugin-figma/core/projection
 */

/** Node fields kept verbatim. Everything not listed here or handled explicitly is dropped. */
export const KEPT_NODE_FIELDS = Object.freeze([
  'id',
  'name',
  'type',
  'layoutMode',
  'itemSpacing',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'primaryAxisSizingMode',
  'counterAxisSizingMode',
  'cornerRadius',
  'strokeWeight',
  'componentId',
])

/**
 * Node fields deliberately dropped, recorded so their absence reads as a
 * decision rather than an oversight. Kept as documentation, not as a runtime
 * filter — the projector is a whitelist, so it never consults this list.
 */
export const DISCARDED_NODE_FIELDS = Object.freeze([
  'constraints',
  'relativeTransform',
  'absoluteRenderBounds',
  'blendMode',
  'background',
  'backgroundColor',
  'clipsContent',
  'complexStrokeProperties',
  'exportSettings',
  'interactions',
  'layoutAlign',
  'layoutGrow',
  'layoutSizingHorizontal',
  'layoutSizingVertical',
  'scrollBehavior',
  'strokeAlign',
  'strokeJoin',
  'strokesIncludedInLayout',
  'layoutGrids',
])

/** Text style fields kept; the rest are rendering implementation details. */
export const KEPT_TEXT_STYLE_FIELDS = Object.freeze([
  'fontFamily',
  'fontWeight',
  'fontSize',
  'textAlignHorizontal',
  'lineHeightPx',
  'letterSpacing',
])

/** Default cap on retained `characters` per text node. */
export const DEFAULT_MAX_TEXT_CHARS = 500

/** Default cap on palette entries returned. */
export const DEFAULT_PALETTE_LIMIT = 32

/**
 * Convert a Figma color to an uppercase hex string.
 *
 * **Only `r`, `g`, and `b` are read.** The alpha channel is not part of a hex
 * color, and treating it as opacity is the trap this function exists to close.
 *
 * @param {{r?: number, g?: number, b?: number}} color - Figma 0–1 float color.
 * @returns {string} Uppercase `#RRGGBB`.
 */
export function toHex(color) {
  const channel = (key) => {
    const value = typeof color?.[key] === 'number' ? color[key] : 0
    return Math.min(255, Math.max(0, Math.round(255 * value)))
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel('r')}${channel('g')}${channel('b')}`.toUpperCase()
}

/**
 * Project one paint (an entry of `fills` or `strokes`).
 *
 * @param {unknown} paint - Raw Figma paint.
 * @returns {Record<string, unknown>|undefined} Projected paint, or `undefined` when unusable.
 */
export function projectPaint(paint) {
  if (paint === null || typeof paint !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (paint)
  const type = typeof source.type === 'string' ? source.type : undefined
  if (type === undefined) return undefined

  /** @type {Record<string, unknown>} */
  const out = { type }

  const color = source.color
  if (color !== null && typeof color === 'object') {
    out.hex = toHex(/** @type {{r?: number, g?: number, b?: number}} */ (color))
  }
  // Transparency, read from the paint's own opacity field — never from color.a.
  if (typeof source.opacity === 'number' && source.opacity !== 1) out.opacity = source.opacity
  if (source.visible === false) out.hidden = true
  if (type === 'IMAGE' && typeof source.imageRef === 'string') out.imageRef = source.imageRef
  if (typeof source.scaleMode === 'string') out.scaleMode = source.scaleMode
  return out
}

/**
 * Project one effect.
 *
 * @param {unknown} effect - Raw Figma effect.
 * @returns {Record<string, unknown>|undefined} Projected effect, or `undefined` when unusable.
 */
export function projectEffect(effect) {
  if (effect === null || typeof effect !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (effect)
  if (typeof source.type !== 'string') return undefined

  /** @type {Record<string, unknown>} */
  const out = { type: source.type }
  const color = source.color
  if (color !== null && typeof color === 'object') {
    out.hex = toHex(/** @type {{r?: number, g?: number, b?: number}} */ (color))
  }
  const offset = source.offset
  if (offset !== null && typeof offset === 'object') {
    const raw = /** @type {{x?: number, y?: number}} */ (offset)
    out.offset = { x: Math.round(raw.x ?? 0), y: Math.round(raw.y ?? 0) }
  }
  if (typeof source.radius === 'number') out.radius = source.radius
  if (typeof source.spread === 'number' && source.spread !== 0) out.spread = source.spread
  if (source.visible === false) out.hidden = true
  return out
}

/**
 * Project `absoluteBoundingBox` into a rounded `box`, dropping the original.
 *
 * @param {unknown} box - Raw `absoluteBoundingBox`.
 * @returns {{x: number, y: number, w: number, h: number}|undefined} Rounded box.
 */
export function projectBox(box) {
  if (box === null || typeof box !== 'object') return undefined
  const source = /** @type {{x?: number, y?: number, width?: number, height?: number}} */ (box)
  if (typeof source.width !== 'number' || typeof source.height !== 'number') return undefined
  return {
    x: Math.round(source.x ?? 0),
    y: Math.round(source.y ?? 0),
    w: Math.round(source.width),
    h: Math.round(source.height),
  }
}

/**
 * Project a text style, keeping only what a designer would name.
 *
 * @param {unknown} style - Raw `style` object.
 * @returns {Record<string, unknown>|undefined} Projected style.
 */
export function projectTextStyle(style) {
  if (style === null || typeof style !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (style)
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const field of KEPT_TEXT_STYLE_FIELDS) {
    const value = source[field]
    if (value !== undefined && value !== null) out[field] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Project component property values, keeping scalars only.
 *
 * @param {unknown} properties - Raw `componentProperties`.
 * @returns {Record<string, unknown>|undefined} Projected properties.
 */
export function projectComponentProperties(properties) {
  if (properties === null || typeof properties !== 'object') return undefined
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [name, raw] of Object.entries(/** @type {Record<string, unknown>} */ (properties))) {
    const entry = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : undefined
    const value = entry !== undefined && 'value' in entry ? entry.value : raw
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[name] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Strip a node subtree down to the whitelist.
 *
 * @param {unknown} node - Raw Figma node.
 * @param {{maxTextChars?: number, includeGeometry?: boolean}} [options] - Projection options.
 * @returns {Record<string, unknown>|undefined} Projected node, or `undefined` for a non-object.
 */
export function projectNode(node, options = {}) {
  if (node === null || typeof node !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (node)
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS

  /** @type {Record<string, unknown>} */
  const out = {}
  for (const field of KEPT_NODE_FIELDS) {
    const value = source[field]
    if (value !== undefined && value !== null) out[field] = value
  }

  // Geometry is the answer to "are these two things aligned?", so the absolute
  // box is kept by default and the original raw field is dropped.
  const box = projectBox(source.absoluteBoundingBox ?? (options.includeGeometry === true ? source.boundingBox : undefined))
  if (box !== undefined) out.box = box

  const fills = projectPaintList(source.fills)
  if (fills !== undefined) out.fills = fills
  const strokes = projectPaintList(source.strokes)
  if (strokes !== undefined) out.strokes = strokes
  const effects = projectEffectList(source.effects)
  if (effects !== undefined) out.effects = effects

  if (typeof source.opacity === 'number' && source.opacity !== 1) out.opacity = source.opacity
  if (source.visible === false) out.visible = false

  if (typeof source.characters === 'string') {
    if (source.characters.length > maxTextChars) {
      out.characters = source.characters.slice(0, maxTextChars)
      // Never truncate silently: the model has to know the text continues.
      out.textTruncatedAt = source.characters.length
    } else {
      out.characters = source.characters
    }
    const style = projectTextStyle(source.style)
    if (style !== undefined) out.style = style
  } else if (source.style !== undefined) {
    const style = projectTextStyle(source.style)
    if (style !== undefined) out.style = style
  }

  const componentProperties = projectComponentProperties(source.componentProperties)
  if (componentProperties !== undefined) out.componentProperties = componentProperties

  if (Array.isArray(source.children) && source.children.length > 0) {
    const children = []
    for (const child of source.children) {
      const projected = projectNode(child, options)
      if (projected !== undefined) children.push(projected)
    }
    if (children.length > 0) out.children = children
  }

  return out
}

/**
 * Project a paint list, dropping entries that carry nothing usable.
 *
 * @param {unknown} list - Raw `fills` or `strokes`.
 * @returns {Array<Record<string, unknown>>|undefined} Projected list.
 */
function projectPaintList(list) {
  if (!Array.isArray(list) || list.length === 0) return undefined
  const out = []
  for (const paint of list) {
    const projected = projectPaint(paint)
    if (projected !== undefined) out.push(projected)
  }
  return out.length === 0 ? undefined : out
}

/**
 * Project an effect list.
 *
 * @param {unknown} list - Raw `effects`.
 * @returns {Array<Record<string, unknown>>|undefined} Projected list.
 */
function projectEffectList(list) {
  if (!Array.isArray(list) || list.length === 0) return undefined
  const out = []
  for (const effect of list) {
    const projected = projectEffect(effect)
    if (projected !== undefined) out.push(projected)
  }
  return out.length === 0 ? undefined : out
}

/**
 * Project a `/v1/files/:key/meta` payload.
 *
 * ## Two shapes, and why this reads both
 *
 * The documented examples show a flat object, but the endpoint actually
 * returns everything **nested under `file`**, and it uses snake_case for the
 * timestamp fields (`last_touched_at`) while `name`, `version`, `role`, and
 * `editorType` stay camel-free. A whitelist written from the documentation
 * therefore matches nothing and answers `{}` — a silent wrong answer, which is
 * the worst possible outcome, so both spellings and both nestings are read.
 *
 * `version` is the field that makes explicit cache invalidation possible: when
 * it changes, everything cached for that file is stale.
 *
 * `thumbnailUrl` is deliberately dropped. It is a signed URL roughly four
 * hundred characters long, it is not needed by anything this plugin does, and
 * `image_render` is the supported way to look at a design.
 *
 * @param {unknown} raw - Raw meta payload.
 * @returns {Record<string, unknown>} Projected metadata.
 */
export function projectFileMeta(raw) {
  if (raw === null || typeof raw !== 'object') return {}
  const outer = /** @type {Record<string, unknown>} */ (raw)
  // Real responses nest under `file`; flat payloads are accepted too.
  const inner = outer.file
  const source = inner !== null && typeof inner === 'object' ? /** @type {Record<string, unknown>} */ (inner) : outer

  /**
   * First present value among alternative spellings.
   *
   * @param {string[]} names - Candidate field names.
   * @returns {unknown} The value, or `undefined`.
   */
  const pick = (...names) => {
    for (const name of names) {
      const value = source[name]
      if (value !== undefined && value !== null) return value
    }
    return undefined
  }

  /** @type {Record<string, unknown>} */
  const out = {}
  const fields = {
    name: pick('name'),
    folder: pick('folder', 'folder_name'),
    lastModified: pick('lastModified', 'last_modified'),
    lastTouchedAt: pick('lastTouchedAt', 'last_touched_at'),
    version: pick('version'),
    role: pick('role'),
    editorType: pick('editorType'),
    linkAccess: pick('linkAccess', 'link_access'),
  }
  for (const [key, value] of Object.entries(fields)) {
    // An empty string here is an absent value, not information.
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }

  const creator = source.creator
  if (creator !== null && typeof creator === 'object') {
    const handle = /** @type {Record<string, unknown>} */ (creator).handle
    if (typeof handle === 'string' && handle.length > 0) out.creator = handle
  }
  return out
}

/**
 * Project a `/v1/images/:key` payload.
 *
 * The values are short-lived signed URLs, never bytes.
 *
 * @param {unknown} raw - Raw image payload.
 * @returns {{images: Record<string, string>, missing: string[], err?: string}} Signed URLs by node id.
 */
export function projectImageUrls(raw) {
  if (raw === null || typeof raw !== 'object') return { images: {}, missing: [] }
  const source = /** @type {Record<string, unknown>} */ (raw)
  /** @type {Record<string, string>} */
  const images = {}
  /** @type {string[]} */
  const missing = []
  const rawImages = source.images
  if (rawImages !== null && typeof rawImages === 'object') {
    for (const [nodeId, url] of Object.entries(/** @type {Record<string, unknown>} */ (rawImages))) {
      if (typeof url === 'string' && url.length > 0) images[nodeId] = url
      else missing.push(nodeId)
    }
  }
  const err = typeof source.err === 'string' && source.err.length > 0 ? source.err : undefined
  return { images, missing, ...(err === undefined ? {} : { err }) }
}

/**
 * Project a whole document-tree payload.
 *
 * Handles both shapes the two node endpoints return: `/v1/files/:key` puts the
 * tree under `document`, while `/v1/files/:key/nodes` returns a map of
 * requested node id to `{document}`.
 *
 * @param {unknown} raw - Raw response payload.
 * @param {{maxTextChars?: number, includeGeometry?: boolean}} [options] - Projection options.
 * @returns {Record<string, unknown>} Projected tree with palette, fonts, and statistics.
 */
export function projectNodeTree(raw, options = {}) {
  const source = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}

  /** @type {Array<Record<string, unknown>>} */
  const roots = []
  /** @type {Array<{id: string, error: string}>} */
  const missing = []
  /** @type {Record<string, unknown>|undefined} */
  let file

  const nodes = source.nodes
  if (nodes !== null && typeof nodes === 'object') {
    for (const [id, entry] of Object.entries(/** @type {Record<string, unknown>} */ (nodes))) {
      const record = entry !== null && typeof entry === 'object' ? /** @type {Record<string, unknown>} */ (entry) : {}
      const document = record.document
      if (document === undefined) {
        const error = typeof record.err === 'string' ? record.err : 'node not returned'
        missing.push({ id, error })
        continue
      }
      const projected = projectNode(document, options)
      if (projected !== undefined) roots.push(projected)
    }
  } else if (source.document !== undefined) {
    const projected = projectNode(source.document, options)
    if (projected !== undefined) roots.push(projected)
    file = {}
    for (const field of ['name', 'lastModified', 'version', 'editorType']) {
      const value = source[field]
      if (value !== undefined && value !== null) /** @type {Record<string, unknown>} */ (file)[field] = value
    }
  }

  const palette = collectPaletteMany(roots)
  const fonts = collectFontsMany(roots)
  const stats = collectStats(roots)

  return {
    source: nodes !== null && typeof nodes === 'object' ? 'nodes' : 'file',
    ...(file === undefined ? {} : { file }),
    roots,
    ...(missing.length === 0 ? {} : { missing }),
    palette,
    fonts,
    stats,
  }
}

/**
 * Count color usage across a projected forest.
 *
 * @param {readonly unknown[]} roots - Projected roots.
 * @param {{limit?: number}} [options] - Collection options.
 * @returns {import('./types.js').PaletteEntry[]} Palette, most-used first.
 */
export function collectPaletteMany(roots, options = {}) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const root of roots) collectPaletteInto(root, counts)
  const limit = options.limit ?? DEFAULT_PALETTE_LIMIT
  return [...counts.entries()]
    .map(([hex, count]) => ({ hex, count }))
    .sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex))
    .slice(0, limit)
}

/**
 * Count color usage in one projected node tree.
 *
 * @param {unknown} node - Projected node.
 * @param {{limit?: number}} [options] - Collection options.
 * @returns {import('./types.js').PaletteEntry[]} Palette, most-used first.
 */
export function collectPalette(node, options = {}) {
  return collectPaletteMany([node], options)
}

/**
 * Accumulate paint colors from one projected node into a counter.
 *
 * @param {unknown} node - Projected node.
 * @param {Map<string, number>} counts - Counter to update.
 */
function collectPaletteInto(node, counts) {
  if (node === null || typeof node !== 'object') return
  const record = /** @type {Record<string, unknown>} */ (node)
  for (const field of ['fills', 'strokes']) {
    const list = record[field]
    if (!Array.isArray(list)) continue
    for (const paint of list) {
      if (paint === null || typeof paint !== 'object') continue
      const hex = /** @type {Record<string, unknown>} */ (paint).hex
      if (typeof hex === 'string') counts.set(hex, (counts.get(hex) ?? 0) + 1)
    }
  }
  const effects = record.effects
  if (Array.isArray(effects)) {
    for (const effect of effects) {
      if (effect === null || typeof effect !== 'object') continue
      const hex = /** @type {Record<string, unknown>} */ (effect).hex
      if (typeof hex === 'string') counts.set(hex, (counts.get(hex) ?? 0) + 1)
    }
  }
  const children = record.children
  if (Array.isArray(children)) for (const child of children) collectPaletteInto(child, counts)
}

/**
 * Collect the typographic scale across a projected forest.
 *
 * @param {readonly unknown[]} roots - Projected roots.
 * @returns {string[]} Entries such as `Inter 600 13px`, sorted.
 */
export function collectFontsMany(roots) {
  /** @type {Set<string>} */
  const fonts = new Set()
  for (const root of roots) collectFontsInto(root, fonts)
  return [...fonts].sort()
}

/**
 * Collect the typographic scale in one projected node tree.
 *
 * @param {unknown} node - Projected node.
 * @returns {string[]} Entries such as `Inter 600 13px`, sorted.
 */
export function collectFonts(node) {
  return collectFontsMany([node])
}

/**
 * Accumulate one node's text style into a set.
 *
 * @param {unknown} node - Projected node.
 * @param {Set<string>} fonts - Set to update.
 */
function collectFontsInto(node, fonts) {
  if (node === null || typeof node !== 'object') return
  const record = /** @type {Record<string, unknown>} */ (node)
  const style = record.style
  if (style !== null && typeof style === 'object') {
    const { fontFamily, fontWeight, fontSize } = /** @type {Record<string, unknown>} */ (style)
    if (typeof fontFamily === 'string' && typeof fontSize === 'number') {
      fonts.add(`${fontFamily} ${fontWeight ?? 400} ${fontSize}px`)
    }
  }
  const children = record.children
  if (Array.isArray(children)) for (const child of children) collectFontsInto(child, fonts)
}

/**
 * Count nodes, types, and depth across a projected forest.
 *
 * @param {readonly unknown[]} roots - Projected roots.
 * @returns {{nodeCount: number, maxDepth: number, byType: Record<string, number>}} Statistics.
 */
export function collectStats(roots) {
  let nodeCount = 0
  let maxDepth = 0
  /** @type {Record<string, number>} */
  const byType = {}
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object') return
    const record = /** @type {Record<string, unknown>} */ (node)
    nodeCount += 1
    if (depth > maxDepth) maxDepth = depth
    if (typeof record.type === 'string') byType[record.type] = (byType[record.type] ?? 0) + 1
    const children = record.children
    if (Array.isArray(children)) for (const child of children) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 1)
  return { nodeCount, maxDepth, byType }
}

/** Default number of children a skeleton keeps per node. */
export const DEFAULT_SKELETON_CHILDREN = 40

/**
 * Build the structure skeleton used when a projection still does not fit.
 *
 * The skeleton keeps the shape a model needs to navigate — container nodes,
 * their sizes, and how many children each one has — plus the palette and font
 * summary. The full projection goes to disk instead of into the context.
 *
 * It is bounded in **both** directions. Capping depth alone is not enough: one
 * frame with three thousand children would still produce a skeleton larger than
 * the budget it was supposed to relieve, so each level keeps only the first
 * {@link DEFAULT_SKELETON_CHILDREN} children and reports the rest as a count.
 *
 * @param {Record<string, unknown>} projected - A value produced by {@link projectNodeTree}.
 * @param {{maxDepth?: number, maxChildren?: number}} [options] - Skeleton options.
 * @returns {Record<string, unknown>} Skeleton value.
 */
export function buildSkeleton(projected, options = {}) {
  const maxDepth = options.maxDepth ?? 2
  const maxChildren = options.maxChildren ?? DEFAULT_SKELETON_CHILDREN
  const roots = Array.isArray(projected.roots) ? projected.roots : []
  const skeletonNode = (node, depth) => {
    if (node === null || typeof node !== 'object') return undefined
    const record = /** @type {Record<string, unknown>} */ (node)
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const field of ['id', 'name', 'type', 'layoutMode', 'box']) {
      if (record[field] !== undefined) out[field] = record[field]
    }
    const children = Array.isArray(record.children) ? record.children : []
    out.childCount = children.length
    if (depth < maxDepth && children.length > 0) {
      const kept = []
      for (const child of children.slice(0, maxChildren)) {
        const projected = skeletonNode(child, depth + 1)
        if (projected !== undefined) kept.push(projected)
      }
      if (kept.length > 0) out.children = kept
      if (children.length > maxChildren) out.omittedChildren = children.length - maxChildren
    }
    return out
  }

  return {
    skeleton: true,
    note:
      'This is a structure skeleton: container nodes with child counts, not the full detail. ' +
      'The complete projection was written to the path in "spooled". Read that file, or call again with a narrower ' +
      'ids/depth to get detail inline.',
    source: projected.source,
    ...(projected.file === undefined ? {} : { file: projected.file }),
    ...(projected.missing === undefined ? {} : { missing: projected.missing }),
    roots: roots.map((root) => skeletonNode(root, 1)).filter((node) => node !== undefined),
    palette: projected.palette,
    fonts: projected.fonts,
    stats: projected.stats,
  }
}
