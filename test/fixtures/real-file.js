/**
 * Real-data fixtures: environment-gated, never committed.
 *
 * The project's measured baselines (projection ratios, palette membership) were
 * taken against real Figma files. Reproducing them needs a real file key, and a
 * real file key belongs to whoever owns that file — so it is read from the
 * environment and every check that needs it is skipped when it is absent.
 *
 * Run the real-data checks with:
 *
 * ```
 * FIGMA_TEST_FILE_KEY=<key> FIGMA_TEST_NODE_ID=<id> node --test test/
 * ```
 *
 * @module dsh-plugin-figma/test/fixtures/real-file
 */

/** File key from the environment, if one was provided. */
export const REAL_FILE_KEY = process.env.FIGMA_TEST_FILE_KEY

/** Node id from the environment, if one was provided. */
export const REAL_NODE_ID = process.env.FIGMA_TEST_NODE_ID

/** Second node id, for the theme-pair comparison. */
export const REAL_NODE_ID_B = process.env.FIGMA_TEST_NODE_ID_B

/** Whether a live file is configured well enough to run the real-data checks. */
export const hasLiveFixtures = Boolean(REAL_FILE_KEY && REAL_NODE_ID)

/**
 * A skip reason that explains how to enable the check.
 *
 * @param {string} what - What is being skipped.
 * @returns {string} Skip message.
 */
export function skipReason(what) {
  return `${what} needs FIGMA_TEST_FILE_KEY and FIGMA_TEST_NODE_ID (real data is never committed)`
}

/**
 * Read one credential from the environment for a manual check.
 *
 * @returns {string|undefined} Token value, when one is configured.
 */
export function realToken() {
  return process.env.FIGMA_TOKEN
}
