/**
 * A deliberate layering violation: this module imports a host package.
 * The layering gate must reject it. Never import this file.
 *
 * @module figma-mcp-dsh/test/fixtures/layering/host-import
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

export const violation = defineTool
