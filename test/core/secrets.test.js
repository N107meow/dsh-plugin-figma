/**
 * The secret gate has to be able to fail.
 *
 * A check that has never rejected anything is not known to work — it is only
 * known to be quiet. So each rule is exercised against a real violation.
 *
 * ## Why the violations are written to a temporary directory
 *
 * A committed fixture containing a realistic token would be scanned by the very
 * gate it tests, and the repository would fail its own check. The alternatives
 * are both worse: exempting a fixture directory carves a blind spot exactly
 * where realistic-looking secrets are meant to live, and weakening the pattern
 * defeats the rule. So the violations are materialized at run time, outside the
 * repository, and the gate is pointed at them with `--root`.
 *
 * For the same reason the removed identifiers below are assembled from pieces:
 * quoting one verbatim would make this file fail the scan it is testing.
 *
 * @module figma-mcp-dsh/test/core/secrets
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import { FORBIDDEN_LITERALS, isAllowedMatch, isSynthetic } from '../../scripts/check-secrets.mjs'

const run = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = 'scripts/check-secrets.mjs'

/**
 * Run the gate against one directory.
 *
 * @param {string} root - Directory to scan, relative to the repository root or absolute.
 * @param {string[]} [extraArgs] - Additional arguments.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} Exit code and output.
 */
async function check(root, extraArgs = []) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, '--root', root, ...extraArgs], { cwd: REPO_ROOT })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = /** @type {{code?: number, stdout?: string, stderr?: string}} */ (error)
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

/**
 * Write one file into a fresh temporary directory and hand both to a callback.
 *
 * @param {string} name - File name to create.
 * @param {string} content - File content.
 * @param {(directory: string) => Promise<void>} body - Callback receiving the directory.
 * @returns {Promise<void>} Resolves when the callback and cleanup finish.
 */
async function withTempFile(name, content, body) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-secrets-'))
  try {
    await writeFile(join(directory, name), content, 'utf8')
    await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('the real repository passes, including its history', async () => {
  const { code, stdout } = await check('.')
  assert.equal(code, 0, stdout)
  assert.match(stdout, /no tokens, no real Figma links, no removed identifiers/)
  assert.match(stdout, /history: none of the/)
})

test('a clean directory passes', async () => {
  await withTempFile('ok.js', 'export const greeting = "hello"\n', async (directory) => {
    const { code } = await check(directory)
    assert.equal(code, 0)
  })
})

test('a real-looking Figma token is rejected', async () => {
  // Assembled at run time so this test file does not itself trip the gate.
  const token = ['figd', 'A1b2C3d4E5f6G7h8I9j0'].join('_')
  await withTempFile('leak.js', `export const token = "${token}"\n`, async (directory) => {
    const { code, stderr } = await check(directory)
    assert.equal(code, 1)
    assert.match(stderr, /personal access token/)
    assert.match(stderr, /leak\.js:1/)
  })
})

test('a link to a real Figma file is rejected', async () => {
  // Also assembled at run time: see the note at the top of this file.
  const link = `https://www.figma.com/design/${'Qq7Ww8Ee9Rr0Tt1' + 'Yy2Uu3I'}x/Somewhere`
  await withTempFile('doc.md', `See ${link}\n`, async (directory) => {
    const { code, stderr } = await check(directory)
    assert.equal(code, 1)
    assert.match(stderr, /real Figma file key/)
  })
})

test('a bare 22-character run is not treated as a file key, so hashes and ids survive', async () => {
  // The rule carries link context on purpose: a bare alphanumeric run of this
  // length is a dependency hash or a component key as often as it is a secret.
  await withTempFile('lock.yaml', '  resolution: {integrity: sha512-Aa1Bb2Cc3Dd4Ee5Ff6Gg7H}\n', async (directory) => {
    const { code } = await check(directory)
    assert.equal(code, 0)
  })
})

test('every removed identifier is still detected in file content', async () => {
  for (const literal of FORBIDDEN_LITERALS) {
    await withTempFile('doc.md', `measured against ${literal} today\n`, async (directory) => {
      const { code, stderr } = await check(directory)
      assert.equal(code, 1, `"${literal}" must be rejected`)
      assert.match(stderr, /removed identifier/)
    })
  }
})

test('synthetic values pass, including the ones this repository actually uses', async () => {
  const content = [
    'const key = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7H"',
    'const other = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3S"',
    'const fixture = "SyntheticFileKey000001"',
    'const token = "figd_TESTTOKENVALUE0123456789"',
    'const replacement = "figd_REPLACEMENTTOKEN0987654321"',
    'const invalid = "figd_definitelynotavalidtoken000"',
  ].join('\n')
  await withTempFile('fixtures.js', content, async (directory) => {
    const { code, stderr } = await check(directory)
    assert.equal(code, 0, stderr)
  })
})

test('the allow list is a deliberate claim, not a wildcard', () => {
  // Values with the shape of a real secret, assembled at run time rather than
  // written out, so this file keeps passing the gate it is testing.
  const realToken = ['figd', 'A1b2C3d4E5f6G7h8I9j0'].join('_')
  const realKey = 'Qq7Ww8Ee9Rr0Tt1' + 'Yy2Uu3I'

  // Allow-listed values and marked values pass; anything else does not.
  assert.equal(isSynthetic('figd_TESTTOKENVALUE0123456789'), true)
  assert.equal(isSynthetic('Aa1Bb2Cc3Dd4Ee5Ff6Gg7H'), true)
  assert.equal(isSynthetic('SyntheticFileKey000001'), true)
  assert.equal(isSynthetic('ExampleKey0000000000001'), true)
  assert.equal(isSynthetic(realToken), false)
  assert.equal(isSynthetic(realKey), false)

  // The link rule matches a URL, so the key has to be pulled back out of it.
  assert.equal(isAllowedMatch('figma-file-link', 'figma.com/design/Aa1Bb2Cc3Dd4Ee5Ff6Gg7H'), true)
  assert.equal(isAllowedMatch('figma-file-link', `figma.com/design/${realKey}`), false)
})

test('history is skipped for a scan root that is not this repository', async () => {
  await withTempFile('ok.md', 'nothing to see\n', async (directory) => {
    const { code, stdout } = await check(directory)
    assert.equal(code, 0)
    assert.equal(stdout.includes('history:'), false)
  })
})
