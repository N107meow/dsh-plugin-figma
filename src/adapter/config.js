/**
 * Plugin configuration, validated by the host before `apply` runs.
 *
 * Every default is deliberately the **weakest plausible** value rather than
 * this machine's value: another DSH user may be on a view/collaborator seat
 * looking at a Starter-plan file, and Figma gives that combination a budget
 * measured in requests per month. Starting slow is recoverable; spending
 * someone's monthly quota is not.
 *
 * @module dsh-plugin-figma/adapter/config
 */

import Schema from '@deepseek-ai/schemastery'

import { DEFAULT_BUDGET_TOKENS } from '../core/budget.js'
import { DEFAULT_TIMEOUT_MS } from '../core/http.js'
import { DEFAULT_MAX_TEXT_CHARS } from '../core/projection.js'
import {
  DEFAULT_CACHE_ENTRIES,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_ENDPOINT_BASE,
  DEFAULT_MAX_RESULT_BYTES,
} from '../core/provider.js'
import { DEFAULT_RATE_LIMITS } from '../core/scheduler.js'
import { DEFAULT_SPOOL_DIR } from '../core/spool-sink.js'

/**
 * One rate-limit tier's schema.
 *
 * @param {import('../core/scheduler.js').RateLimitConfig} defaults - Weakest-seat defaults.
 * @returns {ReturnType<typeof Schema.object>} Tier schema.
 */
function tierSchema(defaults) {
  return Schema.object({
    perMinute: Schema.number().default(defaults.perMinute),
    burst: Schema.number().default(defaults.burst),
  })
}

export const Config = Schema.object({
  credentialRef: Schema.string().default('FIGMA_TOKEN'),
  cacheTtlMs: Schema.number().default(DEFAULT_CACHE_TTL_MS),
  cacheMaxEntries: Schema.number().default(DEFAULT_CACHE_ENTRIES),
  maxResultBytes: Schema.number().default(DEFAULT_MAX_RESULT_BYTES),
  budgetTokens: Schema.number().default(DEFAULT_BUDGET_TOKENS),
  requestTimeoutMs: Schema.number().default(DEFAULT_TIMEOUT_MS),
  maxTextChars: Schema.number().default(DEFAULT_MAX_TEXT_CHARS),
  endpointBase: Schema.string().default(DEFAULT_ENDPOINT_BASE),
  /** `token` sends `X-Figma-Token` (what both Figma token types document); `bearer` sends `Authorization`. */
  authScheme: Schema.string().default('token'),
  /** Directory for spill files, relative to the session workspace. */
  spoolDir: Schema.string().default(DEFAULT_SPOOL_DIR),
  rateLimits: Schema.object({
    tier1: tierSchema(DEFAULT_RATE_LIMITS.tier1),
    tier2: tierSchema(DEFAULT_RATE_LIMITS.tier2),
    tier3: tierSchema(DEFAULT_RATE_LIMITS.tier3),
  }),
})

export default Config
