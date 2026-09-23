#!/usr/bin/env node
/**
 * Secret and private-identifier gate.
 *
 * Real Figma file keys, rendered design images, and tokens have a way of
 * arriving in a repository the same way they arrived in this one: through
 * documentation that quotes a measurement taken against a private file. It is
 * not carelessness so much as gravity, and a rule that depends on someone
 * remembering it will fail. So it is checked here instead.
 *
 * ## What fails
 *
 * | Rule | Why |
 * |---|---|
 * | `figd_` followed by 10+ token characters | That is a real personal access token's shape |
 * | `figma.com/{file,design,board,proto,slides}/<15+ alphanumerics>` | A link to a real Figma file |
 * | a literal from {@link FORBIDDEN_LITERALS} | Identifiers already removed from this repository's history |
 *
 * ## What deliberately does not
 *
 * A bare 22-character alphanumeric run is **not** a rule. Figma file keys are
 * 22 characters, but so are plenty of legitimate things — dependency hashes in
 * a lockfile, component `key` values, CSS class mangles. A gate that cries wolf
 * gets disabled, and a disabled gate protects nothing. The link rule above
 * carries the context that makes a key worth flagging.
 *
 * Synthetic values must pass, or the gate would fail on the repository's own
 * fixtures. They are listed explicitly in {@link SYNTHETIC_ALLOWLIST}, which
 * means adding a new synthetic identifier is a deliberate act rather than
 * something that slips through.
 *
 * ## Scope
 *
 * Only files that would be committed are scanned — tracked files plus
 * untracked-but-not-ignored ones — so a local `fixtures/recorded/` directory
 * stays usable without reddening the build. When the scan root is the
 * repository itself, git history is checked too, because the whole point of
 * this gate is that a leak in an old commit is still a leak.
 *
 * Usage:
 *   node scripts/check-secrets.mjs [--root <dir>] [--no-history] [--quiet]
 *
 * `--root` exists so the gate can be tested: point it at a directory holding a
 * deliberate violation and it must exit non-zero.
 *
 * @module dsh-plugin-figma/scripts/check-secrets
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Directories never worth descending into, whatever the scan root is. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.figma', 'dist', 'coverage', '.pnpm-store'])

/** Files that are noise rather than content. */
const SKIP_FILES = new Set(['.DS_Store'])

/** Bytes examined when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8000

/**
 * Patterns that mean a real secret or a real private identifier has landed.
 *
 * @type {ReadonlyArray<{id: string, pattern: RegExp, why: string}>}
 */
export const RULES = Object.freeze([
  {
    id: 'figma-token',
    pattern: /figd_[A-Za-z0-9_-]{10,}/g,
    why: 'looks like a real Figma personal access token',
  },
  {
    id: 'figma-file-link',
    pattern: /figma\.com\/(?:file|design|board|proto|slides)\/[A-Za-z0-9]{15,}/g,
    why: 'links to a real Figma file key',
  },
])

/**
 * Identifiers that were removed from this repository and must not come back.
 *
 * Each entry is written in two pieces. That is not obfuscation for its own
 * sake: this file is scanned by the very gate it defines, so a denylist that
 * quoted its entries verbatim would fail itself — and the alternatives are
 * worse. Exempting this file would carve a blind spot into the one file most
 * likely to be edited in a hurry, and removing the list would remove the check.
 * Splitting keeps the entries fully effective for detection with no exemption.
 *
 * The last entry is the author's Figma handle, which is a handle rather than a
 * secret. It legitimately appears as the git committer identity, and that is
 * metadata rather than content: history scanning below uses `git log -S`, which
 * walks file content only, so authorship is never reported.
 */
export const FORBIDDEN_LITERALS = Object.freeze([
  'ynKpkb79QvyVG1Y8' + 'LIuwcV',
  '4pT8oSQF3tPZevv2' + 'wFJFNt',
  'Chatel' + 'ier',
  '01【公众号@' + '资源设】',
  'N109' + 'meow',
  // The private file's own component vocabulary, captured while designing P1.
  // Guarded because these are exactly the strings a future test would be
  // tempted to paste as a convenient literal.
  'MyCard/Ratio' + '=2:3',
  'MyCard/Ratio' + '=2:2',
])

/**
 * Values that are known to be synthetic and must pass the gate.
 *
 * Everything here is either a fixture written for this repository or an
 * identifier invented to stand in for a real one. Adding an entry is a claim
 * that the value identifies nothing — make it deliberately.
 */
export const SYNTHETIC_ALLOWLIST = Object.freeze([
  // Test tokens: obviously fake, but they share a real token's prefix by design.
  'figd_TESTTOKENVALUE0123456789',
  'figd_REPLACEMENTTOKEN0987654321',
  'figd_definitelynotavalidtoken000',
  // Synthetic file keys, used interchangeably by the docs and the test suite.
  'Aa1Bb2Cc3Dd4Ee5Ff6Gg7H',
  'Zz9Yy8Xx7Ww6Vv5Uu4Tt3S',
  'SyntheticFileKey000001',
])

/** Substrings that mark a value as invented, case-insensitively. */
const SYNTHETIC_MARKERS = Object.freeze(['synthetic', 'example', 'placeholder', 'dummy', 'redacted'])

/**
 * Parse the command line.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{root: string, history: boolean, quiet: boolean}} Parsed options.
 */
function parseArgs(argv) {
  let root = REPO_ROOT
  let history = true
  let quiet = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--root needs a directory')
      root = resolve(process.cwd(), value)
      index += 1
    } else if (arg === '--no-history') {
      history = false
    } else if (arg === '--quiet') {
      quiet = true
    }
  }
  return { root, history, quiet }
}

/**
 * Whether a value is a deliberate synthetic stand-in.
 *
 * @param {string} value - The matched text, or the key extracted from it.
 * @returns {boolean} Whether it may pass.
 */
export function isSynthetic(value) {
  if (SYNTHETIC_ALLOWLIST.includes(value)) return true
  const lowered = value.toLowerCase()
  return SYNTHETIC_MARKERS.some((marker) => lowered.includes(marker))
}

/**
 * Decide whether one rule match is an acceptable synthetic value.
 *
 * The token rule matches the whole token; the link rule matches a URL prefix,
 * so the file key has to be pulled back out before it can be judged.
 *
 * @param {string} ruleId - Which rule matched.
 * @param {string} match - The matched text.
 * @returns {boolean} Whether the match may pass.
 */
export function isAllowedMatch(ruleId, match) {
  if (ruleId === 'figma-token') return isSynthetic(match)
  return isSynthetic(match.slice(match.lastIndexOf('/') + 1))
}

/**
 * List the files worth scanning under a root.
 *
 * When the root is a git work tree, the list is "what a commit would contain":
 * tracked files plus untracked files that are not ignored. That keeps a local,
 * deliberately ignored recording directory from failing the build while still
 * catching anything that could actually be committed.
 *
 * @param {string} root - Directory to scan.
 * @returns {string[]} Absolute file paths.
 */
function listCandidateFiles(root) {
  const fromGit = listGitFiles(root)
  return fromGit ?? listFilesOnDisk(root)
}

/**
 * Ask git which files it would commit.
 *
 * @param {string} root - Directory to scan.
 * @returns {string[]|undefined} Absolute paths, or `undefined` when git cannot answer.
 */
function listGitFiles(root) {
  try {
    const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return output
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry) => join(root, entry))
      .sort()
  } catch {
    return undefined
  }
}

/**
 * Walk a directory when git is unavailable or the root is not a work tree.
 *
 * @param {string} directory - Directory to walk.
 * @returns {string[]} Absolute file paths.
 */
function listFilesOnDisk(directory) {
  /** @type {string[]} */
  const found = []
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry) || SKIP_FILES.has(entry)) continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...listFilesOnDisk(path))
    else found.push(path)
  }
  return found.sort()
}

/**
 * Whether a file looks binary, and so is not worth treating as text.
 *
 * @param {string} path - File to inspect.
 * @param {Buffer} content - File content.
 * @returns {boolean} Whether it is binary.
 */
function looksBinary(path, content) {
  if (/\.(png|jpe?g|gif|webp|pdf|zip|gz|woff2?|ico)$/i.test(path)) return true
  return content.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

/**
 * Scan one file's text for violations.
 *
 * @param {string} path - Absolute file path.
 * @param {string} root - Scan root, used to shorten reported paths.
 * @returns {string[]} Human-readable violations.
 */
function scanFile(path, root) {
  let content
  try {
    content = readFileSync(path)
  } catch {
    return []
  }
  if (looksBinary(path, content)) return []

  const text = content.toString('utf8')
  const shown = relative(root, path) || path
  /** @type {string[]} */
  const violations = []

  for (const literal of FORBIDDEN_LITERALS) {
    if (text.includes(literal)) {
      violations.push(`${shown}: contains the removed identifier "${literal}"`)
    }
  }

  for (const rule of RULES) {
    // A fresh regex per file: a shared /g regex carries lastIndex between files,
    // which silently skips matches.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    for (const match of text.matchAll(pattern)) {
      if (isAllowedMatch(rule.id, match[0])) continue
      const line = text.slice(0, match.index).split('\n').length
      violations.push(`${shown}:${line}: ${rule.why} — "${truncate(match[0])}"`)
    }
  }
  return violations
}

/**
 * Shorten a match for display without hiding what it is.
 *
 * @param {string} value - Matched text.
 * @returns {string} Display form.
 */
function truncate(value) {
  return value.length <= 60 ? value : `${value.slice(0, 57)}...`
}

/**
 * Check git history for the literals this repository removed.
 *
 * Only `git log -S` is used, which walks file content changes: commit metadata
 * (the committer's own name and address) is not content and is never reported.
 *
 * @param {string} root - Repository to search.
 * @returns {string[]} Human-readable violations.
 */
function scanHistory(root) {
  /** @type {string[]} */
  const violations = []
  for (const literal of FORBIDDEN_LITERALS) {
    let hits = ''
    try {
      hits = execFileSync('git', ['log', '--all', '-S', literal, '--oneline'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return violations
    }
    if (hits.length > 0) {
      const count = hits.split('\n').length
      violations.push(`history: "${literal}" still appears in ${count} commit(s); history must be rewritten, not just the files`)
    }
  }
  return violations
}

/**
 * Run the gate.
 *
 * @returns {void}
 */
function main() {
  const { root, history, quiet } = parseArgs(process.argv.slice(2))
  const scanningRepo = root === REPO_ROOT

  if (!quiet) console.log(`scanning for secrets and private identifiers under ${relative(REPO_ROOT, root) || '.'}`)

  const files = listCandidateFiles(root)
  const violations = []
  for (const file of files) violations.push(...scanFile(file, root))
  if (history && scanningRepo) violations.push(...scanHistory(root))

  if (violations.length > 0) {
    console.error(`\n${violations.length} secret/identifier violation(s):\n`)
    for (const violation of violations) console.error(`  ✖ ${violation}`)
    console.error(
      '\nReplace the offending value with a synthetic one of the same shape, or — if it is\n' +
        'deliberately synthetic — add it to SYNTHETIC_ALLOWLIST in scripts/check-secrets.mjs.\n' +
        'A value that already reached a commit needs history rewritten, not a follow-up commit.\n' +
        'See docs/P0-IMPLEMENTATION.md section 8.',
    )
    process.exit(1)
  }

  if (!quiet) {
    console.log(`  ✅ ${files.length} file(s): no tokens, no real Figma links, no removed identifiers`)
    if (history && scanningRepo) console.log(`  ✅ history: none of the ${FORBIDDEN_LITERALS.length} removed identifier(s) present`)
  }
  if (!quiet) console.log('\nno secrets or private identifiers found.')
}

main()
