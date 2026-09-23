/**
 * A deliberate layering violation: this module reaches for the plugin context.
 * The layering gate must reject it. Never import this file.
 *
 * @module dsh-plugin-figma/test/fixtures/layering/context-use
 */

export function apply(ctx) {
  ctx.tools.register({ name: 'nope' })
}
