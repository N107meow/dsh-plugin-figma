/**
 * Capability contract: declaration validation, the read-only assertion,
 * argument validation, and request-key canonicalization.
 *
 * This is the module that makes "capabilities are data" safe. A spec is checked
 * once at load; every argument is checked before a URL is built; and the
 * read-only constraint is asserted at dispatch rather than trusted to review.
 *
 * @module dsh-plugin-figma/core/capability
 */

import { badArgs } from './errors.js'
import { ReadOnlyViolationError } from './errors.js'
import { normalizeNodeId } from './url.js'

/** The only HTTP method this plugin may ever dispatch. */
export const READ_ONLY_METHOD = 'GET'

/** Every parameter type the validator understands. */
const KNOWN_PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array'])

/** Every parameter format the validator understands. */
const KNOWN_PARAM_FORMATS = new Set(['nodeId'])

/** Every projector the provider can dispatch to. */
const KNOWN_PROJECTORS = new Set(['fileMeta', 'nodeTree', 'imageUrls', 'components', 'componentSets', 'styles', 'raw'])

/**
 * Assert that a capability is read-only.
 *
 * This is a hard constraint, not a preference: the plugin has no write
 * capability, so a spec that declares anything else is a programming error and
 * dispatch must refuse it rather than send it.
 *
 * @param {import('./types.js').CapabilitySpec} spec - Capability about to be dispatched.
 * @throws {ReadOnlyViolationError} When the spec is not a `GET`.
 */
export function assertReadOnly(spec) {
  if (spec.method !== READ_ONLY_METHOD) throw new ReadOnlyViolationError(spec.name, spec.method)
}

/**
 * Find every problem with one capability declaration.
 *
 * Called for every spec at module load, so a malformed declaration fails the
 * suite instead of surfacing as a confusing runtime answer.
 *
 * @param {import('./types.js').CapabilitySpec} spec - Capability to check.
 * @returns {string[]} Human-readable problems; empty when the spec is valid.
 */
export function validateSpec(spec) {
  const problems = []
  const where = spec !== null && typeof spec === 'object' && typeof spec.name === 'string' ? spec.name : '(unnamed)'

  if (typeof spec !== 'object' || spec === null) return ['spec must be an object']
  if (typeof spec.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(spec.name)) {
    problems.push(`${where}: name must be a lowercase identifier`)
  }
  if (typeof spec.description !== 'string' || spec.description.length < 10) {
    problems.push(`${where}: description must explain what it does and when to use it`)
  }
  if (spec.method !== READ_ONLY_METHOD) problems.push(`${where}: method must be "${READ_ONLY_METHOD}" (read-only plugin)`)
  if (spec.transport !== 'rest' && spec.transport !== 'plugin') problems.push(`${where}: unknown transport`)
  if (typeof spec.path !== 'string' || !spec.path.startsWith('/v1/')) problems.push(`${where}: path must start with /v1/`)
  if (![1, 2, 3].includes(spec.tier)) problems.push(`${where}: tier must be 1, 2, or 3`)
  if (!['tiny', 'small', 'large', 'huge'].includes(spec.weight)) problems.push(`${where}: unknown weight`)
  if (!KNOWN_PROJECTORS.has(spec.project)) problems.push(`${where}: unknown projector`)

  const params = spec.params
  if (typeof params !== 'object' || params === null) {
    problems.push(`${where}: params must be an object`)
    return problems
  }

  for (const [name, param] of Object.entries(params)) {
    if (typeof param !== 'object' || param === null) {
      problems.push(`${where}.${name}: parameter must be an object`)
      continue
    }
    if (!KNOWN_PARAM_TYPES.has(param.type)) problems.push(`${where}.${name}: unknown type "${param.type}"`)
    if (typeof param.description !== 'string' || param.description.length === 0) {
      problems.push(`${where}.${name}: description is required`)
    }
    if (param.type === 'array' && param.items !== undefined && param.items !== 'string') {
      problems.push(`${where}.${name}: only items "string" is supported`)
    }
    if (param.format !== undefined && !KNOWN_PARAM_FORMATS.has(param.format)) {
      problems.push(`${where}.${name}: unknown format "${param.format}"`)
    }
    if (param.type !== 'array' && param.format === 'nodeId') {
      problems.push(`${where}.${name}: format "nodeId" requires type "array"`)
    }
  }

  // Path placeholders must be declared parameters.
  for (const placeholder of pathPlaceholders(spec.path)) {
    if (!(placeholder in params)) problems.push(`${where}: path placeholder :${placeholder} has no declared parameter`)
  }

  // Every declared parameter that can change the response body must be part of
  // the cache key. A missing one does not fail loudly at runtime — it feeds the
  // model stale data for a different request — so it fails here instead.
  if (spec.cache !== undefined) {
    if (typeof spec.cache.ttlMs !== 'number' || spec.cache.ttlMs <= 0) problems.push(`${where}: cache.ttlMs must be positive`)
    if (!Array.isArray(spec.cache.keyBy)) {
      problems.push(`${where}: cache.keyBy must be an array`)
    } else {
      for (const name of Object.keys(params)) {
        if (!spec.cache.keyBy.includes(name)) problems.push(`${where}: cache.keyBy is missing parameter "${name}"`)
      }
    }
  }

  return problems
}

/**
 * Validate a whole capability table.
 *
 * @param {readonly import('./types.js').CapabilitySpec[]} specs - Declared capabilities.
 * @returns {string[]} Every problem found, across every spec.
 */
export function validateSpecs(specs) {
  const problems = []
  const seen = new Set()
  for (const spec of specs) {
    problems.push(...validateSpec(spec))
    if (typeof spec?.name === 'string') {
      if (seen.has(spec.name)) problems.push(`${spec.name}: duplicate capability name`)
      seen.add(spec.name)
    }
  }
  return problems
}

/**
 * Look up one capability by name.
 *
 * @param {readonly import('./types.js').CapabilitySpec[]} specs - Declared capabilities.
 * @param {string} name - Capability name.
 * @returns {import('./types.js').CapabilitySpec|undefined} The spec, or `undefined`.
 */
export function findSpec(specs, name) {
  return specs.find((spec) => spec.name === name)
}

/**
 * Extract `:placeholder` names from a path template.
 *
 * @param {string} path - Path template such as `/v1/files/:fileKey/nodes`.
 * @returns {string[]} Placeholder names in order.
 */
export function pathPlaceholders(path) {
  return Array.from(path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g), (match) => match[1])
}

/**
 * Build the concrete request path for one validated parameter set.
 *
 * @param {import('./types.js').CapabilitySpec} spec - Capability.
 * @param {Record<string, unknown>} params - Validated parameters.
 * @returns {string} Path with every placeholder substituted.
 */
export function buildPath(spec, params) {
  let path = spec.path
  for (const placeholder of pathPlaceholders(spec.path)) {
    path = path.replace(`:${placeholder}`, encodeURIComponent(String(params[placeholder])))
  }
  return path
}

/**
 * Build the query string for one validated parameter set.
 *
 * Declared parameters that are not path placeholders become query parameters;
 * the spec's fixed `query` entries are merged in last so a capability can pin a
 * value the model may not override.
 *
 * @param {import('./types.js').CapabilitySpec} spec - Capability.
 * @param {Record<string, unknown>} params - Validated parameters.
 * @returns {Record<string, string>} Query parameters, values already stringified.
 */
export function buildQuery(spec, params) {
  /** @type {Record<string, string>} */
  const query = {}
  const inPath = new Set(pathPlaceholders(spec.path))
  for (const [name, value] of Object.entries(params)) {
    if (inPath.has(name) || value === undefined) continue
    query[name] = Array.isArray(value) ? value.join(',') : String(value)
  }
  for (const [name, value] of Object.entries(spec.query ?? {})) query[name] = value
  return query
}

/**
 * Canonicalize one parameter value for use inside a cache key.
 *
 * Arrays are **sorted**: `ids=1:2,3:4` and `ids=3:4,1:2` are the same request to
 * Figma, so they must share one cache entry and one in-flight HTTP request.
 *
 * @param {unknown} value - Parameter value.
 * @returns {unknown} Canonical value.
 */
function canonicalParam(value) {
  if (!Array.isArray(value)) return value
  return value
    .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
    .slice()
    .sort()
}

/**
 * Build the cache and single-flight key for one request.
 *
 * The key covers the capability name plus every parameter the spec declares as
 * content-affecting. Omitting one would hand the model another request's data,
 * which is worse than not caching at all — so `validateSpec` refuses a spec
 * whose `keyBy` is incomplete.
 *
 * @param {import('./types.js').CapabilitySpec} spec - Capability.
 * @param {Record<string, unknown>} params - Validated parameters.
 * @returns {string} Stable key.
 */
export function cacheKeyFor(spec, params) {
  const keyBy = spec.cache?.keyBy ?? []
  const parts = [spec.name]
  for (const name of keyBy) parts.push(canonicalParam(params[name]))
  return JSON.stringify(parts)
}

/**
 * Validate and normalize one argument object against a capability.
 *
 * Leniency is deliberate in exactly two places, because both are things models
 * and humans genuinely do and neither can produce a wrong answer silently:
 * a numeric string for a `number`/`integer` parameter, and a comma-separated
 * string in place of a `string[]` parameter.
 *
 * @param {import('./types.js').CapabilitySpec} spec - Capability.
 * @param {unknown} rawArgs - Caller-supplied arguments.
 * @returns {{ok: true, value: Record<string, unknown>}|{ok: false, error: import('./errors.js').FigmaError}} Outcome.
 */
export function validateArgs(spec, rawArgs) {
  const input = rawArgs === undefined || rawArgs === null ? {} : rawArgs
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: badArgs('args', 'args must be an object mapping parameter names to values') }
  }

  const declared = /** @type {Record<string, import('./types.js').ParamSpec>} */ (spec.params)
  const supplied = /** @type {Record<string, unknown>} */ (input)

  for (const name of Object.keys(supplied)) {
    if (!(name in declared)) {
      return {
        ok: false,
        error: badArgs(name, `"${spec.name}" has no parameter "${name}"; it accepts: ${Object.keys(declared).join(', ')}`),
      }
    }
  }

  /** @type {Record<string, unknown>} */
  const value = {}
  for (const [name, param] of Object.entries(declared)) {
    const raw = supplied[name]
    if (raw === undefined || raw === null) {
      if (param.default !== undefined) {
        value[name] = param.default
        continue
      }
      if (param.required === true) return { ok: false, error: badArgs(name, `required — ${param.description}`) }
      continue
    }
    const checked = coerceParam(name, param, raw)
    if (checked.ok === false) return checked
    value[name] = checked.value
  }
  return { ok: true, value }
}

/**
 * Validate and normalize one supplied parameter value.
 *
 * @param {string} name - Parameter name.
 * @param {import('./types.js').ParamSpec} param - Declaration.
 * @param {unknown} raw - Supplied value.
 * @returns {{ok: true, value: unknown}|{ok: false, error: import('./errors.js').FigmaError}} Outcome.
 */
function coerceParam(name, param, raw) {
  switch (param.type) {
    case 'string':
      return coerceString(name, param, raw)
    case 'number':
    case 'integer':
      return coerceNumber(name, param, raw)
    case 'boolean':
      return coerceBoolean(name, param, raw)
    case 'array':
      return coerceArray(name, param, raw)
    default:
      return { ok: false, error: badArgs(name, `unsupported declared type "${param.type}"`) }
  }
}

/**
 * @param {string} name - Parameter name.
 * @param {import('./types.js').ParamSpec} param - Declaration.
 * @param {unknown} raw - Supplied value.
 * @returns {{ok: true, value: string}|{ok: false, error: import('./errors.js').FigmaError}} Outcome.
 */
function coerceString(name, param, raw) {
  const value = typeof raw === 'string' ? raw.trim() : raw
  if (typeof value !== 'string') return { ok: false, error: badArgs(name, `expected a string, got ${typeName(raw)}`) }
  if (value.length === 0) return { ok: false, error: badArgs(name, 'must not be empty') }
  if (param.enum !== undefined && !param.enum.includes(value)) {
    return { ok: false, error: badArgs(name, `must be one of: ${param.enum.join(', ')}`) }
  }
  return { ok: true, value }
}

/**
 * @param {string} name - Parameter name.
 * @param {import('./types.js').ParamSpec} param - Declaration.
 * @param {unknown} raw - Supplied value.
 * @returns {{ok: true, value: number}|{ok: false, error: import('./errors.js').FigmaError}} Outcome.
 */
function coerceNumber(name, param, raw) {
  let value
  if (typeof raw === 'number') value = raw
  else if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())) value = Number(raw.trim())
  else return { ok: false, error: badArgs(name, `expected a ${param.type}, got ${typeName(raw)}`) }

  if (!Number.isFinite(value)) return { ok: false, error: badArgs(name, 'must be a finite number') }
  if (param.type === 'integer' && !Number.isInteger(value)) {
    return { ok: false, error: badArgs(name, 'must be an integer') }
  }
  if (param.min !== undefined && value < param.min) {
    return { ok: false, error: badArgs(name, `must be >= ${param.min} (got ${value})`) }
  }
  if (param.max !== undefined && value > param.max) {
    return { ok: false, error: badArgs(name, `must be <= ${param.max} (got ${value})`) }
  }
  return { ok: true, value }
}

/**
 * @param {string} name - Parameter name.
 * @param {import('./types.js').ParamSpec} param - Declaration.
 * @param {unknown} raw - Supplied value.
 * @returns {{ok: true, value: boolean}|{ok: false, error: import('./errors.js').FigmaError}} Outcome.
 */
function coerceBoolean(name, param, raw) {
  if (typeof raw === 'boolean') return { ok: true, value: raw }
  if (raw === 'true') return { ok: true, value: true }
  if (raw === 'false') return { ok: true, value: false }
  return { ok: false, error: badArgs(name, `expected a boolean, got ${typeName(raw)}`) }
}

/**
 * @param {string} name - Parameter name.
 * @param {import('./types.js').ParamSpec} param - Declaration.
 * @param {unknown} raw - Supplied value.
 * @returns {{ok: true, value: string[]}|{ok: false, error: import('./errors.js').FigmaError}} Outcome.
 */
function coerceArray(name, param, raw) {
  let entries
  if (Array.isArray(raw)) entries = raw
  else if (typeof raw === 'string') entries = raw.split(',').map((part) => part.trim())
  else return { ok: false, error: badArgs(name, `expected an array, got ${typeName(raw)}`) }

  /** @type {string[]} */
  const value = []
  for (const entry of entries) {
    if (typeof entry !== 'string' && typeof entry !== 'number') {
      return { ok: false, error: badArgs(name, `every entry must be a string, got ${typeName(entry)}`) }
    }
    const text = String(entry).trim()
    if (text.length === 0) continue

    if (param.format === 'nodeId') {
      const nodeId = normalizeNodeId(text)
      if (nodeId === undefined) {
        return {
          ok: false,
          error: badArgs(name, `"${text}" is not a node id; expected the form 12:345 (a URL's 12-345 is accepted)`),
        }
      }
      if (!value.includes(nodeId)) value.push(nodeId)
      continue
    }
    if (!value.includes(text)) value.push(text)
  }

  if (value.length === 0) {
    return { ok: false, error: badArgs(name, 'must contain at least one non-empty entry') }
  }
  return { ok: true, value }
}

/**
 * Name a value's type for an error message.
 *
 * @param {unknown} value - Any value.
 * @returns {string} Type name.
 */
function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Build the model-facing listing entry for one capability.
 *
 * `names` is the progressive-disclosure default: a name and one line. `full`
 * adds the parameter schema, which is the only path by which the model pays for
 * a capability's full description.
 *
 * @param {import('./types.js').CapabilitySpec} spec - Capability.
 * @param {'names'|'full'} detail - Listing depth.
 * @returns {Record<string, unknown>} Listing entry.
 */
export function describeCapability(spec, detail) {
  const entry = {
    op: spec.name,
    group: spec.group,
    summary: spec.description,
    weight: spec.weight,
  }
  if (detail !== 'full') return entry

  entry.transport = spec.transport
  entry.method = spec.method
  entry.tier = spec.tier
  if (spec.scopes !== undefined) entry.scopes = [...spec.scopes]
  entry.parameters = Object.fromEntries(
    Object.entries(spec.params).map(([name, param]) => [
      name,
      {
        type: param.type,
        ...(param.items === undefined ? {} : { items: param.items }),
        ...(param.required === true ? { required: true } : {}),
        ...(param.default === undefined ? {} : { default: param.default }),
        ...(param.min === undefined ? {} : { min: param.min }),
        ...(param.max === undefined ? {} : { max: param.max }),
        ...(param.enum === undefined ? {} : { enum: [...param.enum] }),
        description: param.description,
      },
    ]),
  )
  return entry
}
