#!/usr/bin/env node
/**
 * Layering gate for `src/core/**`.
 *
 * Three checks, each of which exists because the alternative is a promise
 * nobody can keep by memory:
 *
 * 1. **No host-package import.** `src/core` must stay free of `@deepseek-ai/…`
 *    imports. That is the entire reason a second adapter (an MCP server, say)
 *    can be added later without restructuring anything: the core is already
 *    independent of the host it runs under.
 * 2. **No plugin context.** `ctx` is the host's ambient capability object.
 *    Reaching for it from core would weld the core to one runtime just as
 *    surely, and it would do so invisibly.
 * 3. **Every capability is a GET.** The plugin is read-only, and the runtime
 *    assertion in `src/core/capability.js` is only meaningful while the
 *    declarations agree with it. Checking the declarations here means a
 *    write capability cannot be added accidentally and still pass CI.
 *
 * Discipline decays; CI does not.
 *
 * Usage:
 *   node scripts/check-layering.mjs [--root <dir>]
 *
 * `--root` exists so the gate itself can be tested: point it at a directory
 * containing a deliberate violation and it must exit non-zero.
 *
 * @module figma-mcp-dsh/scripts/check-layering
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_ROOT = join(REPO_ROOT, 'src', 'core')

/** The marker that must never appear in a host-independent module. */
const HOST_PACKAGE_MARKER = '@deepseek-ai/'

/** The ambient capability object that must never appear in a host-independent module. */
const CONTEXT_PATTERN = /\bctx\b/

/**
 * Parse the command line.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{root: string}} Parsed options.
 */
function parseArgs(argv) {
  let root = DEFAULT_ROOT
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--root needs a directory')
      root = resolve(process.cwd(), value)
      index += 1
    }
  }
  return { root }
}

/**
 * List every JavaScript file under a directory.
 *
 * @param {string} directory - Directory to walk.
 * @returns {string[]} Absolute file paths, sorted.
 */
function listSourceFiles(directory) {
  /** @type {string[]} */
  const found = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...listSourceFiles(path))
    else if (entry.endsWith('.js')) found.push(path)
  }
  return found.sort()
}

/**
 * Find every line of a file matching a test.
 *
 * @param {string} file - File path.
 * @param {(line: string) => boolean} matches - Line test.
 * @returns {Array<{line: number, text: string}>} Matches.
 */
function findLines(file, matches) {
  const lines = readFileSync(file, 'utf8').split('\n')
  /** @type {Array<{line: number, text: string}>} */
  const hits = []
  lines.forEach((text, index) => {
    if (matches(text)) hits.push({ line: index + 1, text: text.trim() })
  })
  return hits
}

/**
 * Check every file under the root for host-package imports and context use.
 *
 * @param {string} root - Directory to scan.
 * @returns {string[]} Violation reports.
 */
function checkSourceLayering(root) {
  const violations = []
  for (const file of listSourceFiles(root)) {
    const shown = relative(REPO_ROOT, file)
    for (const hit of findLines(file, (line) => line.includes(HOST_PACKAGE_MARKER))) {
      violations.push(`${shown}:${hit.line}: imports a host package — ${hit.text}`)
    }
    for (const hit of findLines(file, (line) => CONTEXT_PATTERN.test(line))) {
      violations.push(`${shown}:${hit.line}: references the plugin context — ${hit.text}`)
    }
  }
  return violations
}

/**
 * Check that every declared capability is a read-only GET.
 *
 * @returns {Promise<string[]>} Violation reports.
 */
async function checkReadOnlyDeclarations() {
  const { ALL_SPECS } = await import(new URL('../src/core/specs/index.js', import.meta.url).href)
  const violations = []
  for (const spec of ALL_SPECS) {
    if (spec.method !== 'GET') violations.push(`capability "${spec.name}" declares method "${spec.method}", not "GET"`)
  }
  if (ALL_SPECS.length === 0) violations.push('the capability table is empty')
  return violations
}

/**
 * Run the gate.
 *
 * @returns {Promise<void>} Resolves on success; exits non-zero on violation.
 */
async function main() {
  const { root } = parseArgs(process.argv.slice(2))
  const scanningDefault = root === DEFAULT_ROOT

  console.log(`checking layering under ${relative(REPO_ROOT, root) || root}`)
  const violations = checkSourceLayering(root)

  if (scanningDefault) {
    violations.push(...(await checkReadOnlyDeclarations()))
  } else {
    console.log('  (--root given: the read-only declaration check is skipped)')
  }

  if (violations.length > 0) {
    console.error(`\n${violations.length} layering violation(s):\n`)
    for (const violation of violations) console.error(`  ✖ ${violation}`)
    console.error(
      '\nsrc/core must stay host-independent (no host imports, no plugin context), and every\n' +
        'declared capability must be a read-only GET. See docs/P0-IMPLEMENTATION.md section 8.',
    )
    process.exit(1)
  }

  const files = listSourceFiles(root).length
  console.log(`  ✅ ${files} file(s): no host-package imports`)
  console.log('  ✅ no plugin-context reference')
  if (scanningDefault) console.log('  ✅ every declared capability is a read-only GET')
  console.log('\nlayering OK.')
}

await main()
