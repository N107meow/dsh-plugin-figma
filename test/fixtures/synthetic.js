/**
 * Synthetic Figma payloads.
 *
 * Hand-written on purpose: every case here exists because some real file made
 * it matter, and a recorded payload from a real file would drag private file
 * keys and author handles into the repository. The real-data checks live in
 * `test/fixtures/real-file.js` and only run when an environment variable names
 * a file.
 *
 * @module dsh-plugin-figma/test/fixtures/synthetic
 */

/** A node id that appears nowhere real. */
export const SYNTHETIC_FILE_KEY = 'SyntheticFileKey000001'
export const SYNTHETIC_PAGE_ID = '0:1'
export const SYNTHETIC_FRAME_ID = '10:20'

/**
 * One SOLID paint.
 *
 * @param {{r: number, g: number, b: number, a?: number}} color - Figma 0–1 float color.
 * @param {Record<string, unknown>} [extra] - Extra paint fields such as `opacity`.
 * @returns {Record<string, unknown>} Raw paint.
 */
export function solid(color, extra = {}) {
  return { blendMode: 'NORMAL', type: 'SOLID', color: { a: 1, ...color }, ...extra }
}

/**
 * A minimal document tree that exercises every projection case.
 *
 * Covered on purpose: an opaque fill, a semi-transparent fill (the silent
 * color bug), a fill with its own `opacity`, three levels of nesting, a hidden
 * node, a text node with a style, a text node whose copy exceeds the cap, and a
 * fractional bounding box.
 *
 * @returns {Record<string, unknown>} Raw `/v1/files/:key` payload.
 */
export function syntheticFile() {
  return {
    name: 'Synthetic file',
    lastModified: '2026-01-01T00:00:00Z',
    version: '1',
    role: 'owner',
    editorType: 'figma',
    document: {
      id: SYNTHETIC_PAGE_ID,
      name: 'Page 1',
      type: 'CANVAS',
      children: [
        {
          id: SYNTHETIC_FRAME_ID,
          name: 'Card',
          type: 'FRAME',
          layoutMode: 'VERTICAL',
          itemSpacing: 8,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 12,
          paddingBottom: 12,
          cornerRadius: 8,
          strokeWeight: 1,
          // Fractional on purpose: the projector must round it.
          absoluteBoundingBox: { x: 10.4, y: 20.6, width: 320.5, height: 180.4 },
          fills: [solid({ r: 1, g: 1, b: 1 })],
          strokes: [solid({ r: 0.7686, g: 0.8, b: 0.7843 })],
          constraints: { horizontal: 'MIN', vertical: 'MIN' },
          relativeTransform: [[1, 0, 10.4], [0, 1, 20.6]],
          clipsContent: true,
          children: [
            {
              id: '10:21',
              name: 'Title',
              type: 'TEXT',
              characters: 'Welcome',
              style: {
                fontFamily: 'Inter',
                fontWeight: 700,
                fontSize: 18,
                textAlignHorizontal: 'LEFT',
                lineHeightPx: 24,
                letterSpacing: -0.2,
                fontPostScriptName: 'Inter-Bold',
                textAutoResize: 'HEIGHT',
                lineHeightPercent: 133,
                lineHeightUnit: 'PIXELS',
              },
              absoluteBoundingBox: { x: 26.5, y: 32.5, width: 100.2, height: 25.0 },
              fills: [
                // Semi-transparent color: 50% grey at 30% alpha. The hex must be
                // #808080, not the #4D4D4D that using `a` as opacity would give.
                solid({ r: 0.5, g: 0.5, b: 0.5, a: 0.3 }),
              ],
            },
            {
              id: '10:22',
              name: 'Body',
              type: 'TEXT',
              characters: 'A sentence long enough to matter.',
              style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 13, lineHeightPx: 18 },
              fills: [solid({ r: 0.0667, g: 0.0941, b: 0.1529 })],
              absoluteBoundingBox: { x: 26, y: 60, width: 280, height: 36 },
              children: [
                {
                  id: '10:23',
                  name: 'Nested note',
                  type: 'TEXT',
                  characters: 'nested',
                  style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 10.5 },
                  // Base layer transparency, which is a different field from
                  // the paint's opacity and must be reported separately.
                  opacity: 0.6,
                  absoluteBoundingBox: { x: 26, y: 100, width: 60, height: 12 },
                  fills: [solid({ r: 0.6118, g: 0.6392, b: 0.6863 })],
                },
              ],
            },
            {
              id: '10:24',
              name: 'Badge',
              type: 'FRAME',
              // Paint-level opacity: the only place layer transparency may be read from.
              fills: [solid({ r: 0.1608, g: 0.7961, b: 0.5922 }, { opacity: 0.5 })],
              absoluteBoundingBox: { x: 260, y: 30, width: 40, height: 20 },
              effects: [
                { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 0, y: 2 }, radius: 4, spread: 0, visible: true },
              ],
            },
            {
              id: '10:25',
              name: 'Hidden layer',
              type: 'RECTANGLE',
              visible: false,
              fills: [solid({ r: 0, g: 0, b: 0 })],
              absoluteBoundingBox: { x: 0, y: 0, width: 4, height: 4 },
            },
            {
              id: '10:26',
              name: 'Long copy',
              type: 'TEXT',
              characters: 'x'.repeat(900),
              style: { fontFamily: 'Roboto', fontWeight: 400, fontSize: 14 },
              absoluteBoundingBox: { x: 26, y: 140, width: 280, height: 20 },
            },
          ],
        },
      ],
    },
    components: {},
    componentSets: {},
    styles: {},
    schemaVersion: 0,
  }
}

/**
 * The same content in the `/v1/files/:key/nodes` response shape.
 *
 * @param {Record<string, unknown>} [document] - Document to wrap; defaults to the synthetic frame.
 * @returns {Record<string, unknown>} Raw nodes payload.
 */
export function syntheticNodes(document) {
  const root = document ?? /** @type {Record<string, unknown>} */ (syntheticFile().document).children[0]
  return { nodes: { [SYNTHETIC_FRAME_ID]: { document: root, components: {}, componentSets: {}, styles: {}, schemaVersion: 0 } } }
}

/**
 * A `/v1/files/:key/meta` payload in the shape the endpoint really returns.
 *
 * Copied from a live response's *structure* — nested under `file`, snake_case
 * timestamps, a creator object — with every value synthetic. A hand-written
 * flat fixture is what let a whitelist that matched nothing ship, so the
 * regression fixture mirrors reality instead of the documentation.
 *
 * @returns {Record<string, unknown>} Raw meta payload.
 */
export function syntheticFileMeta() {
  return {
    file: {
      name: 'Synthetic file',
      folder_name: '',
      last_touched_at: '2026-01-02T03:04:05.678Z',
      creator: { id: '1', handle: 'some-designer', img_url: 'https://example.test/avatar.png' },
      last_touched_by: { id: '1', handle: 'some-designer', img_url: 'https://example.test/avatar.png' },
      thumbnail_url: 'https://example.test/thumb.png?X-Amz-Signature=deadbeef',
      editorType: 'figma',
      version: '2401639081863745236',
      link_access: 'view',
      url: 'https://www.figma.com/file/SyntheticFileKey000001/Synthetic',
      role: 'owner',
    },
  }
}

/**
 * A raw paint carrying a known semi-transparent color, for the regression test.
 *
 * @returns {Record<string, unknown>} Raw paint.
 */
export function semiTransparentPaint() {
  return solid({ r: 0.5, g: 0.5, b: 0.5, a: 0.3 })
}
