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
 * npm run test:real          # loads .env.local, which is gitignored
 * ```
 *
 * `.env.local` holds the identifiers; exporting the variables by hand works too.
 * Nothing from that file may appear in a tracked file — `check-secrets` scans
 * for exactly these strings.
 *
 * @module figma-mcp-dsh/test/fixtures/real-file
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
 * P1 material: the two variant components of one component family.
 *
 * Measured on the source file: each is a `COMPONENT` node whose name encodes
 * its variants encoded in the name, with no structured variant field anywhere.
 */
export const P1_COMPONENT_A = process.env.FIGMA_P1_COMPONENT_A
export const P1_COMPONENT_B = process.env.FIGMA_P1_COMPONENT_B

/** P1 material: instances of those components, whose `componentId` names the component they use. */
export const P1_INSTANCE_A = process.env.FIGMA_P1_INSTANCE_A
export const P1_INSTANCE_B = process.env.FIGMA_P1_INSTANCE_B

/**
 * P1 material: the names those resources carry. They live here rather than in a
 * test literal because they are the private file's own content.
 *
 * The variant *shape* is asserted from these strings, never from a literal, so
 * the checks stay exact without publishing the design's vocabulary.
 */
export const P1_COMPONENT_A_NAME = process.env.FIGMA_P1_COMPONENT_A_NAME
export const P1_COMPONENT_B_NAME = process.env.FIGMA_P1_COMPONENT_B_NAME

/** P1 material: a style with a type — FILL, TEXT, EFFECT, or GRID. */
export const P1_STYLE_NAME = process.env.FIGMA_P1_STYLE_NAME

/** P1 material: the style's type, which is Figma's own enum vocabulary. */
export const P1_STYLE_TYPE = process.env.FIGMA_P1_STYLE_TYPE

/** P1 material: the style resource id. */
export const P1_STYLE = process.env.FIGMA_P1_STYLE

/** P1 material: a rectangle whose `styles.fill` points at {@link P1_STYLE}. */
export const P1_STYLED_NODE = process.env.FIGMA_P1_STYLED_NODE

/** Whether the file and the P1 material are both configured. */
export const hasP1Fixtures = Boolean(
  REAL_FILE_KEY &&
    P1_COMPONENT_A &&
    P1_COMPONENT_B &&
    P1_COMPONENT_A_NAME &&
    P1_COMPONENT_B_NAME &&
    P1_INSTANCE_A &&
    P1_STYLE &&
    P1_STYLE_NAME &&
    P1_STYLE_TYPE &&
    P1_STYLED_NODE,
)

/** Why the P1 checks are being skipped, phrased so a reader can enable them. */
export const P1_SKIP_REASON =
  'needs FIGMA_TEST_FILE_KEY plus the FIGMA_P1_* material (put them in .env.local and run npm run test:real)'

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
