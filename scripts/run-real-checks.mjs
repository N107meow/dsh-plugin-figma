#!/usr/bin/env node
/**
 * Run the live Figma acceptance checks and mask the private material on the way
 * out.
 *
 * ## Why this exists
 *
 * The live suites are useful precisely because they print what they measured —
 * a component's parsed variant, a style's type, a node's resolved reference.
 * Those lines are drawn from a real design file, so pasting the raw output into
 * a chat, an issue, or a commit message republishes exactly the identifiers
 * `check-secrets` was written to keep out of this repository.
 *
 * The material already lives in `.env.local`. So this wrapper loads that file,
 * runs the suite, and replaces every value it finds there with a placeholder
 * before printing. The result is a transcript you can share: the numbers and
 * pass/fail facts survive, the private vocabulary does not.
 *
 * ## What it does not hide
 *
 * Lengths, verdicts, timings, library keys, and byte counts pass through
 * untouched — none of them identify the file. `--raw` prints the transcript
 * unmasked when you are reading it locally and want the actual values.
 *
 * The token is masked unconditionally, including under `--raw`, because an
 * access token is a credential rather than an identifier and there is no local
 * reading that needs to see it.
 *
 * Usage:
 *   node scripts/run-real-checks.mjs [--raw] [-- <extra node --test args>]
 *
 * @module figma-mcp-dsh/scripts/run-real-checks
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ENV_FILE = resolve(REPO_ROOT, '.env.local')

const MASK = '«masked»'

/**
 * Suites that talk to the live API.
 *
 * @type {readonly string[]}
 */
const LIVE_SUITES = ['test/core/real-data.test.js', 'test/core/p1-real-data.test.js']

/**
 * Read `.env.local` into a plain object without mutating this process.
 *
 * Deliberately a small parser rather than `process.loadEnvFile`: the values are
 * needed as a masking list, and a masking list must not become the environment
 * the child inherits before the token is stripped out of it.
 *
 * @param {string} path - Env file path.
 * @returns {Record<string, string>} Parsed entries.
 */
function parseEnvFile(path) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      if (value.endsWith(value[0])) value = value.slice(1, -1)
    }
    if (value.length > 0) out[key] = value
  }
  return out
}

const raw = process.argv.includes('--raw')
const passthrough = process.argv.slice(2).filter((arg) => arg !== '--raw' && arg !== '--')

if (!existsSync(ENV_FILE)) {
  console.error(`No ${ENV_FILE}. Copy the variable names from test/fixtures/real-file.js and fill them in.`)
  process.exit(2)
}

const file = parseEnvFile(ENV_FILE)
const token = file.FIGMA_TOKEN
if (token === undefined || token.length === 0) {
  console.error(
    `FIGMA_TOKEN is not set in ${ENV_FILE}.\n` +
      'Without it every live check is skipped, and a skipped check is not a passed check.\n' +
      'Add the line `FIGMA_TOKEN=figd_...` and run this again.',
  )
  process.exit(2)
}

const suites = passthrough.length > 0 ? passthrough : LIVE_SUITES
const child = spawnSync(process.execPath, ['--test', ...suites], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  env: { ...process.env, ...file },
})

let transcript = `${child.stdout ?? ''}${child.stderr ?? ''}`

// Mask the credential first and unconditionally, then the identifiers.
transcript = transcript.split(token).join('«token»')
if (!raw) {
  const values = Object.values(file)
    // Longest first, so a value that contains another does not leave a fragment.
    .sort((left, right) => right.length - left.length)
    .filter((value) => value.length >= 3 && value !== token)
  for (const value of values) transcript = transcript.split(value).join(MASK)
}

process.stdout.write(transcript)

if (child.status !== 0) {
  console.error(`\nnode --test exited ${child.status}.`)
}
process.exit(child.status ?? 1)
