/**
 * Public entry point of the `dsh-figma-plugin` package.
 *
 * A thin re-export of the DSH adapter. It exists as a stable indirection so
 * `package.json` → `main` does not have to change when the internal layout
 * moves, and so the package stays installable straight from git (git installs
 * run no build step, so this file must always be committed).
 *
 * ⚠️ PLACEHOLDER — the implementation lands in P0 (see docs/PLAN.md §9.1.3).
 * Until then this package intentionally exports a no-op plugin so that the
 * install and wiring paths stay verifiable end to end.
 */
export const name = 'figma'
export const inject = []

export function apply(ctx) {
  ctx.effect(() => {
    console.log('[dsh-figma-plugin] placeholder loaded — implementation pending (P0)')
    return () => console.log('[dsh-figma-plugin] placeholder unloaded')
  })
}
