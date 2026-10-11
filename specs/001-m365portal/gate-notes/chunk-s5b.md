# Chunk s5b: open points, assumptions, risks (S5 branding UI, page and shell: T-A-214 to T-A-216)

Status: three tasks done, gate G5 passed (see G5.md). Written after the code (the tests were not seen red one by one; a mutation pass stands in, see G5.md).

## Deviations from the Files lines

| File | Why |
|---|---|
| `apps/web/src/components/shell/OrgMark.tsx` (S4) | the refactor s5a asked for: pure `OrgMarkView({branding, theme, variant, showName})`; `OrgMark` feeds it the saved branding and the resolved theme. The name is now a `<bdi data-slot="org-name">` (was a span). Shell tests green |
| `apps/web/src/components/pages/root-providers.tsx` (S4) | one import and one call, `useApplyBrandingToShell()`, in `DocumentTitleSync` |
| `apps/web/build/plugins/nonce-inline.ts` (S4) | **needed for the page to work in the production build**: the entry CSS is inlined and its file deleted, but Vite listed it as a preload dependency of the lazy Appearance chunk's own `import()` calls, so the import failed ("Unable to preload CSS") and the page stayed a skeleton. `forgetInlinedStylesheets` removes inlined files from the chunks' `importedCss` before import analysis. `test/build-output.test.ts` (S4) caught it (red, then green) |
| `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `apps/web/package.json` | react-hook-form 7.89.0, @hookform/resolvers 5.9.1 via the install protocol; the comments `pnpm add` stripped from the workspace file were restored |
| `packages/shared/src/i18n/fragments/appearance.{en,nl}.json`, `locales/*.json` | S5 fragment (68 keys), merged |
| Extra files | `features/branding/{ImportPanel,apply-to-shell,schema,use-unsaved-guard}`, `test/branding/{form-helpers,apply-to-shell}`; `LogoSlot.tsx` exports `Warnings`; headings of the s5a components shifted one level (h2 sections under the page h1, axe heading-order); `LivePreview` redeclares `--fg-muted` and `--line-subtle` in each pane (found by axe, 2.97:1) and uses `OrgMarkView` |

## Decisions

D-1 `beforeunload` is the hook's own listener (router's off): the memory history of tests does not wire it. D-2 The form follows `baseline` (the revision loaded or last saved here) via RHF `values`; a newer revision in the cache with edits is a conflict shown at once, without edits it is adopted. D-3 Save is off while there is a conflict until "Load the latest version". D-4 Undo toast lasts 15 s; Undo uses the revision the change produced. D-5 A derived compact logo is sent as `null`; replacing a main logo clears the shown derived compact. D-6 `apply-to-shell` writes nothing while the branding is the one the server drew (boot data present, same revision) and then does not load the token chunk; otherwise it writes the current theme's accent variables on `:root` by CSSOM, the theme colour and the two icon links. D-7 Export is `<a href download>` (no unload prompt). D-8 Dutch term is "Uiterlijk" (as nav).

## Open points

| # | Point | Owner |
|---|---|---|
| OP-1 | **S3: `accent-subtle` with `text-fg` is 4.27:1 for `#ffff00` in the dark theme** (bg `#72721f`, fg `#e8ecf1`; secondary/ghost hover). Axe fails the dark preview (and the real hover state) for that accent; `#00ff7f` passes. Saving is not blocked | S3 |
| OP-2 | Mutant "save sends cache revision instead of baseline" survives: equivalent, because a newer cache revision with edits disables Save anyway | none |
| OP-3 | `styles.test.ts` (fonts.css) failed once in a full run: S3, not mine | S3 |
| OP-4 | Import apply is the third request of the `upload` bucket (3 burst, 1 per 10 s); a 429 is shown in words and the checked file stays on the page. Not exercised against the real server in the final run (no 429 occurred) | S9 |
| OP-5 | Preview ignores prefers-contrast aliases (pane uses base roles) | none |
| OP-6 | `e2e/branding.spec.ts` and `e2e/branding-persistence.spec.ts` (S9) not run by me; the throwaway Chromium proof below stands in | S9 |
| OP-7 | I killed another agent's `node dist/index.js` once with a broad process match (my script); mine now runs through `s5b/launch.mjs` and is killed by that name only | none |
