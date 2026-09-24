#!/usr/bin/env node
/**
 * Check that the host packages this plugin imports are resolvable **from this
 * repository**, and that their versions line up with the deployment's.
 *
 * Why resolvability matters: the plugin is installed into a DSH profile via
 * `link:`. Node resolves imports from the symlink's REAL PATH — this repo — and
 * NOT from the profile's `node_modules`. So these packages must be present here
 * even though the host also supplies them at runtime.
 *
 * Why the version check matters more than it looks: `defineTool`, the config
 * schema contract, and the credential seam all come from the host. Installing a
 * different version does not fail at load — it fails later, at tool-call time,
 * as a type or behaviour mismatch. So the release triple is compared against
 * `peerDependencies` and a mismatch fails the check instead of becoming a
 * footnote.
 *
 * See docs/P0-IMPLEMENTATION.md §1.0.
 *
 * @module figma-mcp-dsh/scripts/check-deps
 */

import { readFileSync } from 'node:fs'

const MODULES = [
  ['@deepseek-ai/dsh-tools', 'defineTool — tool definitions'],
  ['@deepseek-ai/schemastery', 'Config schema for the plugin entry'],
  ['@deepseek-ai/cordis', 'Context type (types only)'],
]

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const peers = manifest.peerDependencies ?? {}

/**
 * Reduce a version to its release triple, dropping any prerelease tag.
 *
 * `0.1.5-rc.2` and `0.1.5-rc.3` share a triple; `0.1.5` and `0.2.0` do not. The
 * host's prerelease cadence moves the tag far more often than the triple, so the
 * triple is the part worth failing on.
 *
 * @param {string} version - Version or range.
 * @returns {string|undefined} `major.minor.patch`, when one can be read.
 */
function releaseTriple(version) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(version))
  return match === null ? undefined : `${match[1]}.${match[2]}.${match[3]}`
}

let failed = 0
console.log('resolving host packages from this repository:\n')

for (const [name, why] of MODULES) {
  let version = '(unknown)'
  try {
    const resolved = new URL(import.meta.resolve(`${name}/package.json`))
    version = JSON.parse(readFileSync(resolved, 'utf8')).version
  } catch {
    // package.json may not be exported; fall through to a bare import check
  }

  try {
    await import(name)
    console.log(`  ✅ ${name.padEnd(30)} ${version.padEnd(12)} (${why})`)
    const expected = peers[name]
    const actualTriple = releaseTriple(version)
    const expectedTriple = releaseTriple(expected ?? '')
    if (expected !== undefined && actualTriple !== undefined && expectedTriple !== undefined && actualTriple !== expectedTriple) {
      failed++
      console.log(`     ❌ version mismatch: resolved ${version}, but peerDependencies asks for ${expected}`)
    }
  } catch (error) {
    failed++
    console.log(`  ❌ ${name.padEnd(30)} ${' '.repeat(12)} (${why})`)
    console.log(`     ${error.code ?? error.message}`)
  }
}

if (failed > 0) {
  console.error(`
${failed} host package problem(s).

Fix — read the version off your own deployment rather than trusting npm's
\`latest\` tag, which lags behind what ships:

  D=<deployment>/node_modules/@deepseek-ai
  node -p "require('$D/dsh-tools/package.json').version"     # e.g. 0.1.5-rc.3

  pnpm add -D @deepseek-ai/dsh-tools@<that version> \\
             @deepseek-ai/schemastery@3.18.2 \\
             @deepseek-ai/cordis@4.0.2
`)
  process.exit(1)
}

console.log(`\npeer ranges: ${MODULES.map(([name]) => `${name}@${peers[name] ?? '—'}`).join('  ')}`)
console.log('all host packages resolvable and version-aligned — safe to continue.')
