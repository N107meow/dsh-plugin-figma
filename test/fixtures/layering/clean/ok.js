/**
 * A module that respects the layering rule: no host import, no plugin context.
 * Used as the passing case for the layering gate's own test.
 *
 * @module figma-mcp-dsh/test/fixtures/layering/clean
 */

export const greeting = 'host-independent'
