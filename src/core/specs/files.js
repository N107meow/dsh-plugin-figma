/**
 * Capability declarations for the file and node endpoints.
 *
 * These are data, not code. Adding a Figma endpoint means adding a row here.
 *
 * @module figma-mcp-dsh/core/specs/files
 */

import { READ_ONLY_METHOD } from '../capability.js'

/** Depth used whenever `ids` is present and `depth` is absent. See the note on `fileNodes`. */
export const DEFAULT_DEPTH = 2

/**
 * Reading a whole file.
 *
 * This is the expensive capability: the complete document of a real design file
 * measured 1.19 MB, which is roughly the entire context window. `depth` is
 * therefore defaulted here too, so the first call returns pages and their
 * immediate children rather than the file.
 *
 * @type {import('../types.js').CapabilitySpec}
 */
export const file = {
  name: 'file',
  description:
    'Read a Figma file\'s document tree. Use it once to learn the page and top-level frame structure; ' +
    'then use file_nodes to drill into one frame. Always shallow by default because the whole document does not fit in context.',
  group: 'file',
  scopes: ['file_content:read'],
  transport: 'rest',
  method: READ_ONLY_METHOD,
  path: '/v1/files/:fileKey',
  params: {
    fileKey: {
      type: 'string',
      required: true,
      description: 'Figma file key. Any figma.com design link resolves to it, so passing the link as "target" is usually easier.',
    },
    ids: {
      type: 'array',
      items: 'string',
      format: 'nodeId',
      description: 'Optional node ids to start from instead of the document root. Without depth this would return every descendant, so depth is filled in automatically.',
    },
    depth: {
      type: 'integer',
      min: 1,
      max: 8,
      default: DEFAULT_DEPTH,
      description: 'How many levels below the starting nodes to return. This, not ids, is what bounds the response size.',
    },
    geometry: {
      type: 'string',
      enum: ['paths'],
      description: 'Pass "paths" only when vector path data is genuinely needed; it inflates the response substantially.',
    },
  },
  tier: 1,
  cache: { ttlMs: 60_000, keyBy: ['fileKey', 'ids', 'depth', 'geometry'] },
  project: 'nodeTree',
  weight: 'huge',
}

/**
 * Reading specific nodes.
 *
 * `ids` and `depth` are a pair, and that pairing is the single most important
 * behaviour in this plugin: `ids` only says **where to start**, while `depth`
 * says **how much to take**. Requesting one frame without `depth` returned
 * 48,659 bytes; with `depth=1` the same frame returned 2,491 bytes.
 *
 * @type {import('../types.js').CapabilitySpec}
 */
export const fileNodes = {
  name: 'file_nodes',
  description:
    'Read one or more node subtrees by node id. This is the preferred way to read a design: far cheaper than the whole file, ' +
    'and the only way to answer "what is inside this frame?". Pass ids from a link\'s node-id or from a previous shallow read.',
  group: 'node',
  scopes: ['file_content:read'],
  transport: 'rest',
  method: READ_ONLY_METHOD,
  path: '/v1/files/:fileKey/nodes',
  params: {
    fileKey: {
      type: 'string',
      required: true,
      description: 'Figma file key, or pass the whole link as "target".',
    },
    ids: {
      type: 'array',
      items: 'string',
      format: 'nodeId',
      required: true,
      description: 'Node ids such as "12:345". A comma-separated string and a URL\'s "12-345" spelling are both accepted.',
    },
    depth: {
      type: 'integer',
      min: 1,
      max: 8,
      default: DEFAULT_DEPTH,
      description: 'Subtree depth. Defaults to 2 whenever ids are given, because omitting it returns every descendant — one root node is the entire file.',
    },
    geometry: {
      type: 'string',
      enum: ['paths'],
      description: 'Pass "paths" only for vector path data; it inflates the response substantially.',
    },
  },
  tier: 1,
  cache: { ttlMs: 60_000, keyBy: ['fileKey', 'ids', 'depth', 'geometry'] },
  project: 'nodeTree',
  weight: 'large',
}

/**
 * Reading file metadata.
 *
 * The cheapest endpoint available and the only one that reports the file
 * `version`, so it is both the "did this file change?" probe and the self-check
 * endpoint. It needs `file_metadata:read` rather than `file_content:read`, and
 * it sits in the highest rate-limit tier.
 *
 * @type {import('../types.js').CapabilitySpec}
 */
export const fileMeta = {
  name: 'file_meta',
  description:
    'Read cheap file metadata: name, last modified time, version, and the caller\'s role. ' +
    'Use it to confirm a link points at a readable file, or to see whether a file changed since the last read.',
  group: 'file',
  scopes: ['file_metadata:read'],
  transport: 'rest',
  method: READ_ONLY_METHOD,
  path: '/v1/files/:fileKey/meta',
  params: {
    fileKey: {
      type: 'string',
      required: true,
      description: 'Figma file key, or pass the whole link as "target".',
    },
  },
  tier: 3,
  cache: { ttlMs: 60_000, keyBy: ['fileKey'] },
  project: 'fileMeta',
  weight: 'tiny',
}

/** Every file-side capability, in listing order. */
export const fileSpecs = [file, fileNodes, fileMeta]
