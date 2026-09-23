/**
 * Shared type vocabulary for the Figma capability core.
 *
 * This module is **types only** — it holds no runtime logic and has no imports.
 * Keeping the vocabulary in one place is what lets every other core module stay
 * a small, independently testable unit.
 *
 * Layering rule (enforced by `scripts/check-layering.mjs`): nothing under
 * `src/core/**` may import a host package or take a plugin context. This file
 * is the vocabulary half of that boundary.
 *
 * @module dsh-plugin-figma/core/types
 */

/**
 * One declared capability parameter.
 *
 * `description` is mandatory because it is what the model reads when
 * `figma_capabilities` expands a capability with `detail: 'full'`.
 *
 * @typedef {object} ParamSpec
 * @property {'string'|'number'|'integer'|'boolean'|'array'} type - Wire type accepted for this parameter.
 * @property {'string'} [items] - Element type; only `'string'` is declared today.
 * @property {boolean} [required] - Whether the caller must supply it.
 * @property {unknown} [default] - Value substituted when the caller omits it.
 * @property {number} [min] - Inclusive lower bound for `number`/`integer`.
 * @property {number} [max] - Inclusive upper bound for `number`/`integer`.
 * @property {readonly string[]} [enum] - Closed set of accepted strings.
 * @property {'nodeId'} [format] - Declared wire shape: `nodeId` accepts `12:345` or a URL's `12-345` and normalizes to the API spelling.
 * @property {string} description - What it is and when to supply it.
 */

/**
 * One declared Figma capability. Capabilities are **data**: adding a Figma
 * endpoint means adding a row here (plus a projector when the shape is new),
 * never touching scheduling, auth, or the context pipeline.
 *
 * @typedef {object} CapabilitySpec
 * @property {string} name - Stable identifier and the `op` value of `figma_call`.
 * @property {string} description - One line telling the model what it does and when to use it.
 * @property {'file'|'node'|'image'|'comment'|'component'|'variable'|'project'} group - Filter group for capability listing.
 * @property {readonly string[]} [scopes] - Figma scopes this capability needs.
 * @property {'rest'|'plugin'} transport - `'rest'` calls Figma directly; `'plugin'` needs the canvas bridge (P3).
 * @property {'GET'} method - Read-only. **P0 declares `GET` only**; the union is kept narrow on purpose so the
 *   runtime assertion in `capability.js` keeps meaning something. Do not add `POST`/`DELETE` here: this plugin
 *   never mutates Figma data (docs/PLAN.md section 9.2).
 * @property {string} path - REST path template; `:name` segments are filled from parameters.
 * @property {Record<string, ParamSpec>} params - Declared parameters, path and query alike.
 * @property {Record<string, string>} [query] - Fixed query values injected on every request.
 * @property {1|2|3} tier - Rate-limit tier, which selects the token bucket.
 * @property {{ttlMs: number, keyBy: readonly string[]}} [cache] - TTL caching and the parameters that make up the key.
 * @property {ProjectorName} project - Which projector turns the raw payload into a model-facing value.
 * @property {'tiny'|'small'|'large'|'huge'} weight - Rough result-size expectation.
 * @property {number} [minDepth] - Lowest depth the budget stage may tighten to for this capability.
 */

/**
 * Available projectors. Each one turns one raw Figma payload shape into a
 * model-friendly value and drops everything the model cannot use.
 *
 * @typedef {'fileMeta'|'nodeTree'|'imageUrls'|'raw'} ProjectorName
 */

/**
 * A resolved Figma credential value. `resolve()` is called before **every**
 * operation: that per-operation read is the mechanism that makes a rotated
 * token take effect without restarting anything, so implementations must not
 * cache across operations.
 *
 * @typedef {object} TokenSource
 * @property {() => Promise<string|undefined>} resolve - Current token value, or `undefined` while unconfigured.
 * @property {string} ref - Credential reference name, used in remedy text.
 */

/**
 * Where an oversized payload is persisted so the model can read it on demand.
 *
 * `context.cwd` is the session workspace root, supplied per call because the
 * same provider serves every session.
 *
 * @typedef {object} SpoolContext
 * @property {string} [cwd] - Session workspace root that relative names resolve against.
 * @property {AbortSignal} [signal] - Cancellation for the write.
 */

/**
 * Oversize persistence seam. Core defines it and never touches a filesystem;
 * the adapter implements it against whatever filesystem service is mounted.
 *
 * @typedef {object} SpoolSink
 * @property {(name: string, content: string, context?: SpoolContext) => Promise<string|undefined>} write
 *   Persist UTF-8 text under a relative name and return the path to show the model, or `undefined` when nothing was persisted.
 * @property {(name: string, bytes: Uint8Array, context?: SpoolContext) => Promise<string|undefined>} [writeImage]
 *   Persist raw bytes (a rendered PNG) and return the path; omitted sinks simply do not persist images.
 * @property {(input: {name: string, bytes: Uint8Array, mediaType: string}) => Promise<ImageRef|undefined>} [saveImage]
 *   Commit bytes to the durable attachment store and return a reference the tool can attach as an image block.
 */

/**
 * A durable image reference as it crosses the core boundary: plain JSON, with
 * no host object identity. The adapter turns it into an image content block.
 *
 * @typedef {object} ImageRef
 * @property {string} attachmentId - Opaque storage identifier.
 * @property {string} mediaType - Verified media type.
 * @property {number} bytes - Exact byte length.
 * @property {number} width - Decoded width in pixels.
 * @property {number} height - Decoded height in pixels.
 * @property {string} [name] - Display name.
 */

/**
 * One color usage collected from a projected tree.
 *
 * @typedef {object} PaletteEntry
 * @property {string} hex - Uppercase `#RRGGBB`, computed from the RGB channels only.
 * @property {number} count - How many paints used it.
 */

/**
 * Result of the budget stage.
 *
 * @typedef {object} BudgetResult
 * @property {unknown} value - The value to hand back to the model.
 * @property {number} depthUsed - Depth the returned value actually reflects.
 * @property {{path: string, bytes: number}} [spooled] - Where the untruncated projection was persisted.
 * @property {boolean} tightened - Whether depth was reduced after the first attempt.
 * @property {boolean} skeletonOnly - Whether the value is a structure skeleton rather than the projection.
 */

export {}
