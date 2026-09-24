/**
 * The plugin entry point: the only module in this package that imports a host
 * package.
 *
 * Everything the model can reach is registered here, and every side effect is
 * owned by the plugin's fiber through `ctx.effect()` or `ctx.tools.register()`
 * — which is what makes unloading this plugin leave nothing behind.
 *
 * @module figma-mcp-dsh/adapter
 */

import { createTokenSource, isCredentialRefName } from '../core/auth.js'
import { createProvider } from '../core/provider.js'
import { Config } from './config.js'
import { createSpoolSink } from './spool-fs.js'
import { registerFigmaTools } from './tools.js'

/** Cordis plugin name, used in loader diagnostics. */
export const name = 'figma'

/**
 * Hard dependencies.
 *
 * Without a tool registry there is nothing to register into, and without the
 * credential seam there is no token to read. Declaring both means the plugin
 * stays dormant rather than half-applied in a composition that lacks them.
 *
 * The filesystem and attachment services are deliberately **not** here: they
 * are optional, and depending on them would keep this plugin pending in a
 * profile that has no filesystem, for no good reason.
 */
export const inject = ['tools', 'credentials']

/** The tools this plugin contributes, in registration order. */
const TOOL_NAMES = ['figma_capabilities', 'figma_call']

/**
 * Register the Figma read-only tools.
 *
 * @param {any} ctx - Plugin context.
 * @param {object} config - Validated configuration (see {@link Config}).
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const authScheme = settings.authScheme === 'bearer' ? 'bearer' : 'token'
  if (settings.authScheme !== undefined && settings.authScheme !== 'token' && settings.authScheme !== 'bearer') {
    throw new Error(`figma: authScheme must be "token" or "bearer", got ${JSON.stringify(settings.authScheme)}`)
  }

  const credentialName = String(settings.credentialRef)

  if (!isCredentialRefName(credentialName)) {
    console.warn(
      `[figma-mcp-dsh] credentialRef ${JSON.stringify(settings.credentialRef)} is not a valid credential name ` +
        '(expected a POSIX identifier such as FIGMA_TOKEN); the plugin is loaded but every read will report an ' +
        'unconfigured credential.',
    )
  }

  const tokenSource = createTokenSource({
    ref: credentialName,
    // Resolved per operation and never cached. That per-call read is the entire
    // mechanism behind "rotate the token and the next call uses it, no restart".
    //
    // The reference is passed as a plain string: the seam's branded type is a
    // compile-time device, and the name has already been checked against the
    // seam's grammar above.
    resolve: async () => {
      if (!isCredentialRefName(credentialName)) return undefined
      const hit = await ctx.credentials.resolve(credentialName)
      return hit?.value
    },
  })

  const spool = createSpoolSink({
    getFs: () => ctx.get('fs'),
    getAttachments: () => ctx.get('attachments'),
    spoolDir: String(settings.spoolDir),
    warn: (message) => console.warn(`[figma-mcp-dsh] ${message}`),
  })

  const provider = createProvider({
    tokenSource,
    spool,
    config: {
      cacheTtlMs: settings.cacheTtlMs,
      cacheMaxEntries: settings.cacheMaxEntries,
      maxResultBytes: settings.maxResultBytes,
      budgetTokens: settings.budgetTokens,
      requestTimeoutMs: settings.requestTimeoutMs,
      maxTextChars: settings.maxTextChars,
      endpointBase: settings.endpointBase,
      authScheme,
      rateLimits: settings.rateLimits,
    },
  })

  registerFigmaTools(ctx, { provider })

  ctx.effect(() => {
    console.log(`[figma-mcp-dsh] active — registered ${confirmRegistered(ctx).join(', ')}`)
    return () => {
      console.log('[figma-mcp-dsh] inactive')
    }
  })
}

/**
 * Read the tool names back out of the registry.
 *
 * `scripts/verify-wiring.sh` greps the activation line, and a line that only
 * echoed a constant would say nothing about whether registration happened.
 * Asking the registry makes the log evidence — with a fallback so a registry
 * that cannot answer never breaks activation.
 *
 * @param {any} ctx - Plugin context.
 * @returns {string[]} Tool names the registry confirms, or the declared list.
 */
function confirmRegistered(ctx) {
  try {
    const confirmed = TOOL_NAMES.filter((toolName) => ctx.tools.get(toolName) !== undefined)
    return confirmed.length > 0 ? confirmed : TOOL_NAMES
  } catch {
    return TOOL_NAMES
  }
}

export { Config }
