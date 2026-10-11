# Chunk s5a: open points, assumptions, risks (S5 branding UI, components and data layer: T-A-210 to T-A-213)

Status: four tasks done. 86 tests in 4 files (`api` 21, `accent-picker` 17, `logo-slot` 28, `live-preview` 20), all green, written first and red for the missing module. `tsc -b`, `eslint --max-warnings 0` and `prettier --check` on `apps/web/{src/features/branding,test/branding}` clean; `pnpm i18n:check` 112 green; `single-implementation` and `repo-conventions` report nothing for `apps/web` (one failure is `apps/server/src/branding/shell.ts`, S2). Mutation pass: 7 one-edit mutants (CSSOM write replaced by `setAttribute('style')`, drag-over not cancelled, asset-url check removed, `If-Match` dropped, blur normalisation removed, logo plate colour removed), all killed.

## Interfaces for T-A-214 and T-A-215

- `features/branding/api.ts`: `createBrandingApi(client)` with `get`, `stage(slot, file, signal?)`, `apply(request, revision)`, `reset(revision)`, `importDocument(text, { dryRun, revision? })`; `BRANDING_EXPORT_PATH` (plain link); `BrandingConflictError` (subclass of `ApiError`, 412 `branding_conflict`), `isBrandingConflict`, `expectedOriginOf(error)`. Zod schemas are imported with `import()` inside the calls.
- `queries.ts`: `useApplyBranding`, `useResetBranding`, `useImportBranding`, `useStageAsset` (all take an optional `ApiClient`). Variables: `{ request, revision }`, `{ revision }`, `{ text, dryRun, revision? }`. After apply, reset and an applied import the cache gets the answer (`setQueryData`) and the branding query is invalidated; a dry run and a failure change nothing.
- `AccentPicker({ value, onChange, disabled?, error? })`: controlled by the text of the hex field; normalises on blur; has no say in saving. The form validates with `tools.accent.tryNormalizeAccent`.
- `LogoSlots({ value: {light, dark, compact}, compactDerived, disabled?, onChange(variant, asset|null), api? })` and `LogoSlot`. The compact slot with `derived` has no Remove. The form sends `logos.compact: null` for a derived compact logo (the slot only reports what the person changed).
- `LivePreview({ orgName, accent, logos })`: pure, no request.
- `tools.ts`: `loadBrandingTools()` / `useBrandingTools()` load accent, contrast, logo-plate, monogram, org-name and tokens lazily (one shared promise). Tests `await loadBrandingTools()` first so components render complete.
- Fragments `accent` (23 keys), `logo` (41), `preview` (12), both languages. `appearance` is T-A-214's. `pnpm i18n:merge` was run (locales regenerated).
- Test helpers: `test/branding/helpers.tsx` (`renderInLanguage`, `fakeApi`, `jsonResponse`, `problemResponse`).

## Deviations from the Files lines (all inside S5 territory)

Extra files: `features/branding/{tools.ts,ColourChip.tsx,use-css-properties.ts}`, `test/branding/helpers.tsx`. `T-A-001` lists them as additional controls (TA-08).

## Open points

| # | Point | Owner |
|---|---|---|
| OP-1 | **Upload progress is indeterminate.** `fetch` reports no upload progress and `lib/api.ts` is the only network code (`XMLHttpRequest` is refused by the guard in `api.test.ts`). The slot shows a progress bar without a value (`role="progressbar"`, text "Uploading and processing ...") and a Cancel button that aborts. A real percentage would need `XMLHttpRequest` inside `lib/api.ts` (S4) | S4 / owner |
| OP-2 | **The preview cannot use `OrgMark` itself.** `OrgMark` reads the global branding and theme (`useBranding`, `useTheme()` with the module controller), so it cannot draw a draft in a pane of the other theme, and `MonogramTile` and `LogoImage` are not exported. The preview reuses `pickLogo` (OrgMark), the S3 `Button` and the shared `logoPlateFor`, `monogramFor`; the monogram tile is a 25-line copy. Splitting a pure `OrgMarkView({ branding, theme, variant, showName })` out of `OrgMark` (S4) would let the preview and the shell share it | S4 |
| OP-3 | The preview forces hover, pressed and focus with the classes of the showcase (`bg-accent-hover` and so on), not the real pseudo-classes; a change of the button variants in S3 must be mirrored in `FORCED` of `LivePreview.tsx` (the showcase has the same coupling) | S3 / S5 |
| OP-4 | Swatch set (eight: the default blue, teal, green, orange, red, pink, purple, graphite) is computed from HSL, so no hex literal is in the web code. Colour wording ("Used", "Chosen", "adjusted slightly") is for the owner's review at G5 | owner |
| OP-5 | The CSSOM writes (`style.setProperty` on the pane, chips and plates) are proven in happy-dom only. Not run in Chromium under the production CSP (`style-src 'self' 'nonce-..'`); CSSOM writes are allowed by `style-src`, but the real run belongs to `e2e/branding.spec.ts` (S9) | S9 |
| OP-6 | The preview window sets only the colour variables of a theme. Shadows of the dark theme (`--shadow-*`) and the glass variables are not scoped to the pane, so the pane uses solid surfaces | none |

## Assumptions

A-1 `useStageAsset` is used by the slot, so the slot needs a `QueryClientProvider` (the page has one). A-2 The preview shows the default name for a name the rules refuse and keeps the last valid accent while the text is not a colour; the form shows the error. A-3 A file over `LIMITS.body.logoFileBytes` is refused in the browser with the `payload_too_large` message before any request; the server still decides. A-4 Retry is offered for errors that carry `Retry-After` (busy, rate limit, storage busy, shutting down) and for network errors; it waits out `Retry-After` with an interval timer (tests use fake timers). A-5 The browser never reads an uploaded file: no object URL, no `FileReader`, no markup (a source scan with a negative fixture guards it).

## Risks

R-1 `Intl.ListFormat` joins the removed-content categories; a browser without it is not supported by the product anyway. R-2 The hidden file input is `aria-hidden` with `tabindex=-1` and `sr-only`; axe has not been run on it (S9).
