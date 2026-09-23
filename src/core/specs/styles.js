/**
 * Capability declaration for styles.
 *
 * Like the component capabilities, this reads the `/v1/files/:key` payload's
 * own `styles` map rather than the dedicated `/v1/files/:key/styles` endpoint:
 * the dedicated endpoint lists only what a team published to a library, and a
 * file's own styles need not be published.
 *
 * @module dsh-plugin-figma/core/specs/styles
 */

import { READ_ONLY_METHOD } from '../capability.js'

/**
 * Depth used to read the styles map. Same reasoning as the component
 * capabilities: `depth=1` returns the map empty, `depth=2` fills it cheaply.
 */
const MAP_DEPTH = '2'

/**
 * @type {import('../types.js').CapabilitySpec}
 */
export const styles = {
  name: 'styles',
  description:
    'List the styles defined in this file: id, name, type (FILL / TEXT / EFFECT / GRID), library key, and description. ' +
    'Pair it with file_nodes to see which style a particular layer uses. Style ids are what a node\'s `styles` map points at.',
  group: 'style',
  scopes: ['file_content:read'],
  transport: 'rest',
  method: READ_ONLY_METHOD,
  path: '/v1/files/:fileKey',
  params: {
    fileKey: {
      type: 'string',
      required: true,
      description: 'Figma file key, or pass the whole link as "target".',
    },
  },
  query: { depth: MAP_DEPTH },
  tier: 1,
  cache: { ttlMs: 60_000, keyBy: ['fileKey'] },
  project: 'styles',
  weight: 'small',
}

/** Every style-side capability, in listing order. */
export const styleSpecs = [styles]
