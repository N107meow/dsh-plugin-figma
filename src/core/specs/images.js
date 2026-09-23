/**
 * Capability declaration for image rendering.
 *
 * Figma's image endpoint returns a **short-lived signed URL**, not bytes, so
 * this capability is only half a feature on its own: the provider downloads the
 * URL immediately, persists the bytes, and attaches the image to the tool
 * result. A URL handed to the model and read later would simply 403.
 *
 * @module dsh-plugin-figma/core/specs/images
 */

import { READ_ONLY_METHOD } from '../capability.js'

/** Default render scale. 2x is the readable-but-affordable point for UI screenshots. */
export const DEFAULT_SCALE = 2

/**
 * @type {import('../types.js').CapabilitySpec}
 */
export const imageRender = {
  name: 'image_render',
  description:
    'Export one or more nodes as images and see them in this turn. Use it to look at a frame the way a designer sees it, ' +
    'for layout or spacing questions that node data answers poorly. The rendered files are saved locally and attached to the result.',
  group: 'image',
  scopes: ['file_content:read'],
  transport: 'rest',
  method: READ_ONLY_METHOD,
  path: '/v1/images/:fileKey',
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
      description: 'Node ids to render, such as "12:345". Pass a frame id, not a text or vector child, for a full screenshot.',
    },
    format: {
      type: 'string',
      enum: ['png', 'jpg', 'svg', 'pdf'],
      default: 'png',
      description: 'png is the default and the only raster format attached to the result as a viewable image; svg and pdf are returned as files only.',
    },
    scale: {
      type: 'number',
      min: 0.01,
      max: 4,
      default: DEFAULT_SCALE,
      description: 'Render scale between 0.01 and 4. Higher is more legible and larger; 2 is the sensible default for UI frames.',
    },
  },
  tier: 1,
  cache: { ttlMs: 60_000, keyBy: ['fileKey', 'ids', 'format', 'scale'] },
  project: 'imageUrls',
  weight: 'small',
}

/** Every image-side capability, in listing order. */
export const imageSpecs = [imageRender]
