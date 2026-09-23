/**
 * The capability registry.
 *
 * `ALL_SPECS` is the whitelist the model is held to: `figma_call` refuses any
 * `op` that is not in this table, so a hallucinated endpoint cannot turn into an
 * arbitrary URL.
 *
 * The table is validated at module load. A malformed declaration — including a
 * non-`GET` method or an incomplete cache key — fails immediately at import
 * rather than at the moment a user asks a question.
 *
 * @module dsh-plugin-figma/core/specs
 */

import { validateSpecs } from '../capability.js'
import { componentSpecs } from './components.js'
import { fileSpecs } from './files.js'
import { imageSpecs } from './images.js'
import { styleSpecs } from './styles.js'

/**
 * Every capability this plugin declares, in listing order.
 *
 * @type {readonly import('../types.js').CapabilitySpec[]}
 */
export const ALL_SPECS = Object.freeze([...fileSpecs, ...imageSpecs, ...componentSpecs, ...styleSpecs])

/** Every capability name, in listing order. */
export const ALL_OP_NAMES = Object.freeze(ALL_SPECS.map((spec) => spec.name))

/** Capability groups, in listing order, for `figma_capabilities` filtering. */
export const ALL_GROUPS = Object.freeze([...new Set(ALL_SPECS.map((spec) => spec.group))])

const problems = validateSpecs(ALL_SPECS)
if (problems.length > 0) {
  throw new Error(`invalid Figma capability declarations:\n  - ${problems.join('\n  - ')}`)
}
