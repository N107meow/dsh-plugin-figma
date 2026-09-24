/**
 * Public entry point of the `figma-mcp-dsh` package.
 *
 * ## Why this file exists, and why it is committed
 *
 * Two constraints meet here:
 *
 * 1. **`pnpm add github:<user>/<repo>` runs no build step.** The package must
 *    be loadable exactly as it sits in git, so the entry point cannot be
 *    generated — it has to be checked in and correct.
 * 2. **The internal layout should stay free to move.** `package.json`'s `main`
 *    points here, so reorganizing `src/` does not change the public entry.
 *
 * There is deliberately **no bundler and no compilation step**: the sources are
 * plain JavaScript with JSDoc types, so this file is a real re-export rather
 * than a build artifact. It also means the package loads on the oldest Node
 * version the manifest claims support, instead of depending on type stripping.
 *
 * `test/adapter/adapter.test.js` asserts this re-export keeps matching the
 * adapter, because a stale forwarding layer fails silently and completely: the
 * package would load and register nothing.
 *
 * @module figma-mcp-dsh
 */

export { Config, apply, inject, name } from '../src/adapter/index.js'
