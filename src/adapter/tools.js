/**
 * The two model-facing tools.
 *
 * Two, not one hundred and thirty. A tool definition is a tax paid on **every**
 * request: the model reads every visible schema before it reads the user's
 * question. Turning Figma's REST surface into one tool per endpoint would add
 * tens of thousands of tokens to each request and buy nothing, because the
 * expensive part was never the wiring — it was knowing what to ask for.
 *
 * So the model gets a directory it can search (`figma_capabilities`, with the
 * parameter schemas hidden until asked for) and one execution entry point
 * (`figma_call`). Adding a Figma capability costs a row in `core/specs`, not a
 * new tool and not a context tax.
 *
 * @module dsh-plugin-figma/adapter/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { ALL_GROUPS } from '../core/specs/index.js'

/**
 * Register both tools, and return the disposer.
 *
 * `ctx.tools.register` is itself an effect, so unregistering is automatic when
 * the plugin unloads — there is nothing to clean up by hand.
 *
 * @param {any} ctx - Plugin context (host side).
 * @param {object} options - Wiring options.
 * @param {ReturnType<import('../core/provider.js').createProvider>} options.provider - The capability provider.
 * @returns {() => void} Disposer for both registrations.
 */
export function registerFigmaTools(ctx, options) {
  const provider = options.provider
  const disposers = [ctx.tools.register(defineTool(capabilitiesTool(provider))), ctx.tools.register(defineTool(callTool(provider)))]

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * The capability directory tool.
 *
 * @param {ReturnType<import('../core/provider.js').createProvider>} provider - Capability provider.
 * @returns {Parameters<typeof defineTool>[0]} Tool definition.
 */
function capabilitiesTool(provider) {
  return {
    name: 'figma_capabilities',
    description:
      'List the Figma capabilities this plugin offers, and the parameters each one takes. ' +
      'Call it before figma_call whenever you are unsure which operation reads what you need, or when you need the exact ' +
      'parameter names for one operation. The default listing is names and one line each; ask for detail="full" (ideally ' +
      'with a query) to get the parameter schema for the capabilities you actually intend to use.',
    parameters: {
      query: {
        type: 'string',
        description: 'Keywords to filter by, matched against capability names, groups, descriptions, and parameter names. Example: "nodes" or "export".',
      },
      group: {
        type: 'string',
        enum: [...ALL_GROUPS],
        description: 'Restrict the listing to one group.',
      },
      detail: {
        type: 'string',
        enum: ['names', 'full'],
        default: 'names',
        description:
          'names returns one line per capability and costs very little. full returns the complete parameter schema for ' +
          'each match, so use it once you have narrowed the list.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return provider.listCapabilities({ query: args.query, group: args.group, detail: args.detail }).text
    },
  }
}

/**
 * The execution tool.
 *
 * @param {ReturnType<import('../core/provider.js').createProvider>} provider - Capability provider.
 * @returns {Parameters<typeof defineTool>[0]} Tool definition.
 */
function callTool(provider) {
  return {
    name: 'figma_call',
    description:
      'Read from a Figma design: file structure, frames and layers, colors, type styles, and rendered images. Read-only; ' +
      'it cannot change anything in Figma. Pass a Figma link as "target" and it resolves the file key and node id for you. ' +
      'Prefer reading one node with file_nodes over reading a whole file — a full document can be larger than the context ' +
      'window. Use figma_capabilities to see every available op and its parameters.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        description:
          'Which capability to run — for example file_meta (cheap: name, version, last modified), file (a shallow page and ' +
          'frame outline), file_nodes (one or more node subtrees; the usual choice), or image_render (export a frame as an ' +
          'image you can look at). Call figma_capabilities for the full list.',
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description:
          'Arguments for the capability, as declared by figma_capabilities with detail="full". The most common are fileKey, ' +
          'ids (node ids such as "12:345"; a URL\'s "12-345" is accepted), and depth (how deep to read; depth, not ids, is ' +
          'what bounds the response).',
      },
      target: {
        type: 'string',
        description:
          'A Figma link, a bare file key, or a bare node id. Paste the link the user gave you — resolving it here saves you ' +
          'from guessing which part of the URL is the file key. Explicit args win if both are supplied.',
      },
      max_bytes: {
        type: 'number',
        description: 'Override the size ceiling for this result, in bytes. Raise it only when you specifically need a larger inline answer.',
      },
      format: {
        type: 'string',
        enum: ['summary', 'full'],
        description:
          'summary (default) projects the payload and tightens depth if the answer is too large. full keeps every level and ' +
          'every character of the projection, and spills to a file instead of shrinking when it still does not fit.',
      },
    },
    output: {
      schema: { type: 'json' },
      // The provider already built the exact content blocks — text, plus image
      // blocks for a render. Rebuilding them here would lose the images.
      render: (_args, value) => contentOf(value),
      presentationMeta: (_args, value) => presentationMetaOf(value),
    },
    async execute(args, exec) {
      // Fields are forwarded one by one on purpose: `args` is model input and
      // `exec.signal` is execution context, and merging them would hand the
      // provider keys no capability ever declared.
      return provider.call({
        op: args.op,
        args: args.args,
        target: args.target,
        max_bytes: args.max_bytes,
        format: args.format,
        signal: exec.signal,
        cwd: sessionCwdOf(exec),
      })
    },
  }
}

/**
 * Extract the model-facing content blocks from a provider value.
 *
 * A renderer must be total: it runs on both a live call and a session replay,
 * where the value may come from an older shape.
 *
 * @param {unknown} value - Provider value.
 * @returns {Array<Record<string, unknown>>} Content blocks.
 */
function contentOf(value) {
  if (value !== null && typeof value === 'object') {
    const blocks = /** @type {{content?: unknown}} */ (value).content
    if (Array.isArray(blocks) && blocks.length > 0) {
      return blocks.map((block) => ({ .../** @type {Record<string, unknown>} */ (block) }))
    }
  }
  return [{ type: 'text', text: JSON.stringify(value ?? null) }]
}

/**
 * Project a provider value into replayable presentation metadata.
 *
 * @param {unknown} value - Provider value.
 * @returns {Record<string, unknown>} Metadata safe for the client.
 */
function presentationMetaOf(value) {
  if (value === null || typeof value !== 'object') return {}
  const meta = /** @type {{meta?: unknown}} */ (value).meta
  return meta !== null && typeof meta === 'object' ? /** @type {Record<string, unknown>} */ (meta) : {}
}

/**
 * The session workspace root a spill file resolves against.
 *
 * @param {any} exec - Tool execution context.
 * @returns {string|undefined} Workspace root, when the host exposes one.
 */
function sessionCwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}
