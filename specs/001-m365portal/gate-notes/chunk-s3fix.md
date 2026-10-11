# Chunk s3fix: Radix Select Trusted Types sink and link-button hover contrast (closes chunk-s4c OP-1, OP-2)

## OP-1 Radix Select injected `<style dangerouslySetInnerHTML>`
- Cause: `@radix-ui/react-select@2.3.8` (installed through `radix-ui@1.7.0`) renders the scrollbar-hiding rule as an inline style in `SelectViewport`. Under `require-trusted-types-for 'script'` that is a TrustedHTML sink, so every Select crashed into the route error boundary.
- Fix: `patches/@radix-ui__react-select@2.3.8.patch` (`patchedDependencies` in `pnpm-workspace.yaml`, via `pnpm patch` / `patch-commit` under the flock; lockfile diff is the patch hash only, the `libc:` lines are untouched) removes the element in `dist/index.js` and `dist/index.mjs`. The same rule is in `apps/web/src/styles/app.css` (`@layer base`).
- Test (red first): `apps/web/test/csp-sinks.test.ts`, 3 tests. Scans the built source of every Radix package whose `radix-ui` namespace `apps/web/src` imports for `dangerouslySetInnerHTML`, `innerHTML =`, `insertAdjacentHTML` and a style element without a nonce; detector has a negative fixture (the original Radix text); a third test requires the CSS rule. Mutation: appending `dangerouslySetInnerHTML` to the patched file turns it red naming the package. Unused `react-scroll-area` still has the same sink; it is not imported and tree-shaken, so it is exempt by construction (importing `ScrollArea` later turns the test red).
- Real Chromium 141, production build (`apps/web` `vite build`) served by the scratchpad harness (`s3fix-serve.mjs`, plan 8.1 CSP with nonce and Trusted Types): all 5 enabled comboboxes on `/design` (including the DataTable page-size select) opened with the keyboard: **0 `securitypolicyviolation`, 0 page errors, no error boundary**. Negative: the pre-patch s4c build on the same harness: error boundary, 2 violations (`trusted-types-sink`, `[data-radix-select-viewport]{scrollbar-w...`).

## OP-2 `link` button hover
- Cause: `accent-hover` is derived as a fill colour against the on-accent text; as text it is below 4.5:1 on the dark surfaces.
- Fix (`components/ui/button.tsx`): the link keeps `text-accent-text` on hover (guaranteed 4.5:1 on all four surfaces and on `accent-subtle`, `shared/accent.property.test.ts`, every accent) and shows hover with `hover:bg-accent-subtle` plus `hover:decoration-2`. No token or derivation change, so the existing property test is the guarantee (180 shared tests green).
- Showcase edit in S4's territory: `features/showcase/ControlsSection.tsx` only: removed the filter that omitted `link` from the forced hover row and changed its forced class to `bg-accent-subtle decoration-2`.
- Test: `apps/web/test/ui/button-link-hover.test.ts` (4 tests, red first): no `text-accent-hover`, the `accent-text` + `accent-subtle` pair, primary still uses `accent-hover` as a fill, showcase has no omission.
- Real Chromium (pointer hover on a link button plus the forced specimens, axe wcag2a/2aa/21aa/22aa): 0 violations in light and dark for accents `#0078d4`, `#ffd800`, `#00ff7f`, `#7a1fff`.

## Counts
Web suite 37 files, 993 tests green; shared `accent.property` + `tokens` 180 green; eslint clean on touched files; `tsc -b` 0.

## Open points
- The Dockerfile (not in the tree yet) must `COPY patches/` before `pnpm install --frozen-lockfile`, and `scripts/version_guard_paths.py` should list `patches/` as a protected path (outside my territory).
- The `/design` showcase toast stays on screen and covers the DataTable page-size select in a 900 px viewport (a pointer click is intercepted; keyboard works). A showcase concern for S4.
- `pnpm-workspace.yaml` comments restored by hand after `patch-commit` (it drops them); the patched block carries its own comment.
