#!/usr/bin/env node
/**
 * Ask whether the Figma rate-limit window is currently open.
 *
 * ## Why this is worth a script
 *
 * Figma reports a rate limit only on the response that hits it. A success
 * carries **no** rate-limit headers at all — measured: `X-Figma-Plan-Tier`,
 * `X-Figma-Rate-Limit-Type`, and `X-Figma-Upgrade-Link` appear only on a 429 —
 * so there is no way to ask "how much budget is left". The only answerable
 * question is "am I shut out right now", and answering it costs one request
 * against a Tier 1 allowance that can be as small as **20 per month**.
 *
 * Running the acceptance suite blind therefore has a bad failure mode: it can
 * spend four requests discovering what one request would have said, and — with
 * per-check providers, before that was fixed — it did exactly that and drained
 * the window.
 *
 * So this probes once, and reports in the provider's own vocabulary, because a
 * probe that disagrees with the tool it is probing is worse than no probe.
 *
 * It uses the provider rather than a bare `fetch` on purpose: the retry policy,
 * the error taxonomy, and the `remedy` text are the things under test. A raw
 * request would report an HTTP status while the client would report something
 * subtly different.
 *
 * ## Cost
 *
 * One Tier 1 request (`/v1/files/:key/meta`). If it is refused, it cost
 * nothing, because a refused request is not counted against the window.
 *
 * Usage:
 *   node scripts/probe-quota.mjs            # loads .env.local
 *
 * Exit codes:
 *   0 — the window is open; the acceptance suite is worth running
 *   1 — still rate-limited; running the suite now would fail the same way
 *   2 — configuration is missing
 *
 * @module figma-mcp-dsh/scripts/probe-quota
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTokenSource } from '../src/core/auth.js'
import { createProvider } from '../src/core/provider.js'
import { createMemorySpool } from '../src/core/spool-sink.js'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ENV_FILE = resolve(REPO_ROOT, '.env.local')

if (!existsSync(ENV_FILE)) {
  console.error(`No ${ENV_FILE}. Real-data checks need it; see test/fixtures/real-file.js for the names.`)
  process.exit(2)
}

process.loadEnvFile(ENV_FILE)

const fileKey = process.env.FIGMA_TEST_FILE_KEY
const token = process.env.FIGMA_TOKEN
if (fileKey === undefined || token === undefined) {
  console.error(`FIGMA_TEST_FILE_KEY and FIGMA_TOKEN must both be in ${ENV_FILE}.`)
  process.exit(2)
}

const provider = createProvider({
  tokenSource: createTokenSource({ ref: 'FIGMA_TOKEN', resolve: async () => token }),
  spool: createMemorySpool(),
  config: { budgetTokens: 1_000_000, maxResultBytes: 4_194_304 },
})

const started = Date.now()
const result = await provider.call({ op: 'file_meta', args: { fileKey } })
const elapsed = ((Date.now() - started) / 1000).toFixed(1)
const content = /** @type {Record<string, any>} */ (result.structuredContent)

if (content.ok === true) {
  console.log(`✅ The window is open — file_meta answered in ${elapsed}s.`)
  console.log('   The acceptance suite is worth running now:')
  console.log('     node scripts/run-real-checks.mjs test/core/p1-real-data.test.js')
  console.log('')
  console.log('   Expect roughly 70–90 seconds: every check shares one rate-limit bucket at')
  console.log('   5/min burst 1, so requests queue about 12 seconds apart by design.')
  process.exit(0)
}

const error = /** @type {Record<string, any>} */ (content.error ?? {})
console.log(`⛔ Not usable yet after ${elapsed}s.`)
console.log(`   kind: ${error.kind ?? '(none)'}`)
if (error.retryAfterSec !== undefined) console.log(`   retryAfterSec: ${error.retryAfterSec}`)
if (error.limitType !== undefined) console.log(`   limitType: ${error.limitType}  (low = view/collaborator seat)`)
if (error.upgradeUrl !== undefined) console.log(`   upgradeUrl: ${error.upgradeUrl}`)
if (error.remedy !== undefined) console.log(`   remedy: ${error.remedy}`)

if (error.kind === 'rate_limited') {
  console.log('')
  console.log('   Tier 1 is 20/month on a personal seat and 10–20/min on Professional.')
  console.log('   A monthly window has no short wait: retry after the reset, or run against')
  console.log('   a file on a plan with a per-minute budget.')
  process.exit(1)
}

console.log('')
console.log('   This is not a rate limit. Fix the cause above before running the suite.')
process.exit(1)
