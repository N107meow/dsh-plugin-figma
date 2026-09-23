/**
 * Capability declarations for components and component sets.
 *
 * Both read the `/v1/files/:key` payload's own resource maps, **not** the
 * dedicated `/v1/files/:key/components` and `/component_sets` endpoints. See
 * the warning on {@link components}: those endpoints answer from the published
 * team library, so they report nothing for a file whose local components
 * plainly exist. Mixing the two views into one capability would make the model
 * confidently say "this file has no components" about a file that has them.
 *
 * @module dsh-plugin-figma/core/specs/components
 */

import { READ_ONLY_METHOD } from '../capability.js'

/**
 * Depth used to read the resource maps.
 *
 * Not exposed to the model, and deliberately not 1. Measured: at `depth=1` the
 * maps come back empty, while `depth=2` fills them and still answers in 6,338
 * bytes against 1,564,042 for the whole file.
 */
const MAP_DEPTH = '2'

/**
 * Shared shape for the two resource-map capabilities.
 *
 * @type {import('../types.js').CapabilitySpec}
 */
export const components = {
  name: 'components',
  description:
    'List the components defined in this file: id, name, library key, and description. ' +
    'Names may encode variants (for example "Card/Ratio=2:3"); the REST API carries no structured variant field, ' +
    'so variants are read out of the name. Use it before proposing a component-based structure.',
  group: 'component',
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
  // Fixed internally: the maps are populated from depth 2 up, and a shallow read
  // is what keeps this capability cheap. The model never chooses it.
  query: { depth: MAP_DEPTH },
  tier: 1,
  cache: { ttlMs: 60_000, keyBy: ['fileKey'] },
  project: 'components',
  weight: 'small',
}

/**
 * Component sets — the variant groups a component belongs to.
 *
 * A file with variants but no published set reports an empty list here, which
 * is a real answer rather than a failure: the set only exists once the designer
 * creates one.
 *
 * @type {import('../types.js').CapabilitySpec}
 */
export const componentSets = {
  name: 'component_sets',
  description:
    'List the component sets (variant groups) defined in this file. An empty list is a real answer: ' +
    'individual components can exist without ever being grouped into a set.',
  group: 'component',
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
  project: 'componentSets',
  weight: 'small',
}

/** Every component-side capability, in listing order. */
export const componentSpecs = [components, componentSets]
