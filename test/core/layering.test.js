/**
 * The layering gate has to be able to fail.
 *
 * A check that has never rejected anything is not known to work — it is only
 * known to be quiet. These tests run the real script against directories that
 * contain deliberate violations and require a non-zero exit.
 *
 * @module figma-mcp-dsh/test/core/layering
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = 'scripts/check-layering.mjs'

/**
 * Run the gate against one directory.
 *
 * @param {string} root - Directory to scan, relative to the repository root.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} Exit code and output.
 */
async function check(root) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, '--root', root], { cwd: REPO_ROOT })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = /** @type {{code?: number, stdout?: string, stderr?: string}} */ (error)
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

test('the real source tree passes', async () => {
  const { code, stdout } = await check('src/core')
  assert.equal(code, 0, stdout)
  assert.match(stdout, /no plugin-context reference/)
})

test('a clean fixture directory passes', async () => {
  const { code } = await check('test/fixtures/layering/clean')
  assert.equal(code, 0)
})

test('a host-package import is rejected', async () => {
  const { code, stderr } = await check('test/fixtures/layering/host-import')
  assert.equal(code, 1)
  assert.match(stderr, /imports a host package/)
  assert.match(stderr, /@deepseek-ai\/dsh-tools/)
})

test('a plugin-context reference is rejected', async () => {
  const { code, stderr } = await check('test/fixtures/layering/context-use')
  assert.equal(code, 1)
  assert.match(stderr, /references the plugin context/)
})

test('an injected violation inside the real tree is caught, and removing it restores the gate', async () => {
  const { writeFile, rm } = await import('node:fs/promises')
  const injected = new URL('../../src/core/__layering-probe.js', import.meta.url)
  try {
    await writeFile(
      injected,
      '// temporary probe written by the layering test\nexport function probe(ctx) {\n  return ctx.tools\n}\n',
      'utf8',
    )
    const failed = await check('src/core')
    assert.equal(failed.code, 1, 'a violation inside src/core must fail the gate')
    assert.match(failed.stderr, /references the plugin context/)
  } finally {
    await rm(injected, { force: true })
  }

  const restored = await check('src/core')
  assert.equal(restored.code, 0, 'the gate must pass again once the probe is gone')
})
