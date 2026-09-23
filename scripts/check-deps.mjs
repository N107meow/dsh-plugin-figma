#!/usr/bin/env node
/**
 * Check that the host packages this plugin imports are resolvable FROM THIS
 * REPOSITORY.
 *
 * Why this is needed: the plugin is installed into a DSH profile via
 * `link:`. Node resolves imports from the SYMLINK'S REAL PATH — this repo —
 * and NOT from the profile's node_modules. So these packages must be present
 * here, even though the host also supplies them at runtime.
 *
 * See docs/P0-IMPLEMENTATION.md §1.0.
 */
const MODULES = [
  ['@deepseek-ai/dsh-tools', 'defineTool — tool definitions'],
  ['@deepseek-ai/schemastery', 'Config schema for the plugin entry'],
  ['@deepseek-ai/cordis', 'Context type (types only)'],
]

let failed = 0
console.log('resolving host packages from this repository:\n')
for (const [name, why] of MODULES) {
  let version = ''
  try {
    const pkg = new URL(import.meta.resolve(`${name}/package.json`))
    const { readFileSync } = await import('node:fs')
    version = JSON.parse(readFileSync(pkg, 'utf8')).version
  } catch {
    // package.json may not be exported; fall through to a bare import check
  }
  try {
    await import(name)
    console.log(`  ✅ ${name.padEnd(30)} ${version.padEnd(12)} (${why})`)
  } catch (error) {
    failed++
    console.log(`  ❌ ${name.padEnd(30)} ${' '.repeat(12)} (${why})`)
    console.log(`     ${error.code ?? error.message}`)
  }
}

if (failed > 0) {
  console.error(`
${failed} host package(s) missing.

Fix (⚠️ pin the exact version — npm's \`latest\` tag for dsh-tools points at a
stale 0.0.1-rc.1 while deployments ship 0.1.5-rc.2):

  pnpm add -D @deepseek-ai/dsh-tools@0.1.5-rc.2 \\
             @deepseek-ai/schemastery@3.18.2 \\
             @deepseek-ai/cordis@4.0.2

Check what your running DSH actually uses:

  node -p "require('<dsh>/node_modules/@deepseek-ai/dsh-tools/package.json').version"
`)
  process.exit(1)
}

console.log('\nall host packages resolvable — safe to continue.')
