# Gate note G3a (T-A-120, T-A-121, T-A-122): design tokens, `renderTokenCss`, accent derivation

**Date**: 2026-10-10. **Stream**: S3 (design system, shared core), chunk label `s3a`. **Gate**: G3a = token modules, `renderTokenCss`, `deriveAccentTokens`, `normalizeAccent`. Consumers: S2 (`T-A-085`, `T-A-090`, `T-A-091`, and the luminance helper for `T-A-078`/`T-A-082`), S4, S5, and the web half of S3 (`T-A-123` onward). Open points, assumptions and risks are also in `chunk-s3a.md` for S8 to consolidate.

## 1. Verdict

**Passed. The WCAG AA guarantee holds for every one of the 16,777,216 possible `#rrggbb` inputs, in both themes** (section 5: an exhaustive one-off sweep with an independent oracle, on the very files that are committed, plus the committed property test over 24,630 colours). No defect is open. Three design questions for the owner or S8 are listed in section 8 (the 3 % margin band, a barely visible hover step on near-black accents, black text on mid-tone brand colours); none affects the guarantee.

- `T-A-120`, `T-A-121`, `T-A-122` are done; every "Done when" was checked by running commands (section 3).
- Order of work: `T-A-120`, `T-A-122`, `T-A-121`. `T-A-121` lists `T-A-120` as its only need, but `renderTokenCss()` without an accent emits the derived tokens of the default accent, so it imports `deriveAccentTokens`. Nothing else differs from the task text.
- The checks ran on the live tree and on two clean copies (section 2). The shared package is green in the first copy (lint, typecheck, 1,105 tests in 11 files, `pnpm tokens:check`). In the second copy, taken after more of S1's work had landed, 1,105 of 1,106 tests pass; the one failure is outside this chunk (section 8, OP-11).

## 2. What was run, and on which state

| Item | Value |
|---|---|
| Live tree | `/home/user/M365Portal`, uncommitted work of several streams. Only S3-shared files were written by this chunk (section 9) |
| Clean copies | `scratchpad/g3a-copy`: `git ls-files -co --exclude-standard` tarred (231 files the first time, 239 the second), plus `.git`, then `flock /tmp/m365portal-pnpm.lock pnpm install --frozen-lockfile` (exit 0, 3 s, warm store) |
| Toolchain | Node 22.22.0, pnpm 10.28.0, Vitest 5.0.3, TypeScript 6.0.3, ESLint 10.12.0, Prettier 3.9.10 |
| Package gates, first copy | `pnpm --filter @m365portal/shared lint` exit 0 (20 s), `typecheck` exit 0 (8 s), `test` **11 files, 1,105 tests, 0 failed, 0 skipped** (28 s) |
| Package gates, second copy (after the last test changes) | `lint` exit 0, `typecheck` exit 0, `test` 11 files, 1,106 tests, **1 failed, 0 skipped**: `repo-conventions.test.ts` check 5 reports `apps/server/src/config/env.ts:81` (a comment in S1's new file contains the literal port 8080). Not this chunk's file; retried once on the live tree after a minute, still present |
| Root scripts (clean copy and live tree) | `pnpm tokens:generate` writes `apps/web/src/styles/tokens.generated.css`; `pnpm tokens:check` exits 0 ("up to date"); the file the clean copy writes is byte-identical to the live one |
| Format | `prettier --check packages/shared apps/web/src/styles` clean |
| Guards over the new files | `exports.test.ts` (14), `guard-helper.test.ts` (15), `index.test.ts` (2), `repo-conventions.test.ts` (250), `single-implementation.test.ts` (232): **513 passed**, the same as at G0. `exports.test.ts` compiles every new file under NodeNext and under bundler resolution. `tools/workspace-deps` (31) passed |
| Sources behind the sweep | `accent.ts`, `contrast.ts`, `colours.ts` hashed before the sweep started (`sha256sum -c` OK after it): the sweep verified the committed code, not an earlier draft |

All pnpm commands ran under `flock /tmp/m365portal-pnpm.lock`. Vitest and `tsx` ran directly from `packages/shared/node_modules/.bin` where no dependency change was involved.

## 3. Task by task

| Task | Verdict | Evidence |
|---|---|---|
| `T-A-120` token modules | done | Red first: `tokens.test.ts` failed with `THEMES` undefined (`Cannot read properties of undefined (reading 'every')`) before the modules existed. Now 58 tests (part 1) green: surfaces and neutral/status roles equal plan 10.2 (a second copy in the test), the independent formula reproduces the **measured minima of plan 10.2 to two decimals** (14.86/13.32, 6.72/8.33, 5.33/6.33, 3.92/4.40, 1.19/1.20, status 5.28 to 5.79 and 6.92 to 8.62), spacing in multiples of 4, radius 4/6/8 with `full` only for three named uses, every duration at most 200 ms (spring included), layers strictly ascending, text-bearing glass alpha at least 0.92, the precondition of accent step 2, no colour literal outside `tokens/colours.ts`. Negative fixtures through `expectGuardFails`: four role-contrast breakages, a 250 ms duration, six colour-literal plants |
| `T-A-121` `renderTokenCss` and stylesheet | done | Red first: `renderStaticTokenCss is not a function`. Now 46 tests (part 2) green: `:root` and `:root[data-theme="dark"]` blocks with all 20 colour roles and `color-scheme`; 16 hostile values (including `red;}</style><script>alert(1)</script>`) refused in each of the 7 colour fields of both themes, the error names the field and never echoes the value; output restricted to a safe character set (checked for the default and 300 derived accents); `tokens:check` fails on a stale value, an empty file, a file with an extra rule and a missing file (the real script is spawned with `--file <fixture>`) |
| `T-A-122` accent derivation and normaliser | done | Red first: `deriveAccentTokens is not a function` (and the other missing exports of `accent.ts` and `contrast.ts`). Now 76 tests green (section 5). `deriveAccentTokens`, `normalizeAccent` and the contrast helpers exist once (`single-implementation.test.ts` green); the examples of plan 10.4 hold exactly (`#0078d4` unchanged with white text in both themes; `#3b82f6` unchanged with black text; `#ffff00` becomes `#8a8a00` in light only; `#ffffff` becomes `#868686` in light); the implementation uses bisection, a verified walk and a precomputed linearisation table with precomputed surface luminances (bounded luminance memo for the string helper), not a linear scan |

## 4. Frozen interfaces (G3a)

Import paths: `@m365portal/shared/tokens` (the barrel; the only subpath that reaches `css.ts`), `@m365portal/shared/branding/accent`, `@m365portal/shared/branding/contrast`. Everything is platform-neutral (no DOM, no Node), pure, and has no work at import time, so a bundler can drop what a page does not use.

### 4.1 Accent (C9)

```ts
interface AccentTokenSet { accent; accentHover; accentActive; accentSubtle; onAccent; accentText; focusRing: string; adjusted: boolean }   // colours are lowercase #rrggbb
interface AccentTokens { light: AccentTokenSet; dark: AccentTokenSet }
deriveAccentTokens(hex: string): AccentTokens        // frozen result; accepts #rgb/#rrggbb in any case; else throws InvalidAccentError
normalizeAccent(input: unknown): string              // '#ABC' -> '#aabbcc'; else throws InvalidAccentError
tryNormalizeAccent(input: unknown): string | null    // the same without throwing (form validation)
class InvalidAccentError extends RangeError { code: 'accent_invalid' }   // message never contains the input
ACCENT_RULES                                          // nonText 3, text 4.5, margin 1.03, epsilon 0.002, minStep 0.03, hoverStep 0.045, activeStep 0.09, subtleShare
```

- `adjusted` is true when `accent` differs from the normalised input. `focusRing` equals `accent`. `onAccent` is only ever `#ffffff` or `#000000`.
- S2: `GET /branding` returns `tokens: deriveAccentTokens(accent)` as is (it has the shape C10 asks for). Map `InvalidAccentError` (or `tryNormalizeAccent() === null`) to `accent_invalid`, 422. The service normalises with `normalizeAccent` after the schema pattern check, as the contract says.
- S5: the live preview calls the same function in the browser (import it lazily). See risk R3 about the last bit.

### 4.2 Contrast helpers (`branding/contrast.ts`)

`WCAG_TEXT_CONTRAST` (4.5), `WCAG_NON_TEXT_CONTRAST` (3), `READABLE_TEXT_MARGIN`, `isHexColour`, `parseHexColour`, `formatHexColour`, `srgbChannelToLinear(channel8)`, `relativeLuminance(hex)`, `relativeLuminanceOfChannels(r, g, b)`, `contrastRatio(foreground, background)`, `contrastRatioOfLuminances(a, b)`, `readableTextColour(background)`, `readableTextOnLuminance(luminance)`, type `Channels`.

**This closes G0 decision 6 without an exemption.** The server's image pipeline (plan section 8, step 8) can weigh pixels with `srgbChannelToLinear` and `relativeLuminanceOfChannels` from this module and stays clear of `single-implementation.test.ts`. `tasks.md` still lists neither `T-A-078` nor `T-A-082` as depending on `T-A-122`; the orchestrator should add `T-A-122` to their `Needs` (I may not edit `tasks.md`).

### 4.3 Tokens (`@m365portal/shared/tokens`)

- **Colours**: `THEMES`, `SURFACE_NAMES`, `SURFACES` (the four opaque surfaces per theme), `NEUTRAL_ROLES` (text, border and status roles per theme), `surfaceColours(theme)`, `WHITE`, `BLACK`, `DEFAULT_ACCENT` (`#0078d4`, assumption A-42), `inkColour(ink, alpha)`. All tables are frozen.
- **Scales**: `SPACING_PX`, `pxToRem`, `CONTROL_HEIGHT_PX`, `TABLE_ROW_HEIGHT_PX`, `MIN_TARGET_PX`, `BREAKPOINTS_PX`, `CONTENT_MAX_PX`, `RADIUS_PX`, `RADIUS_FULL_PX`, `RADIUS_FULL_USES`, `SHADOWS`, `TYPE_SCALE`, `FONT_FAMILIES`, `FONT_STACK_SANS`, `FONT_WEIGHTS`, `trackingFor`, `DURATION_MS`, `MAX_DURATION_MS`, `EASING`, `SPRING_MOTION`, `cubicBezier`, `Z_LAYERS`, `GLASS`, `MIN_TEXT_GLASS_ALPHA`, `FOCUS`.
- **CSS**: `renderTokenCss({ accent? })` (the colour part), `renderStaticTokenCss()`, `renderTokensStylesheet()`, and the variable vocabulary `SURFACE_VARIABLES`, `NEUTRAL_VARIABLES`, `ACCENT_VARIABLES`, `COLOUR_VARIABLES`.
- **For `T-A-124`** (`lib/motion.ts`): durations in milliseconds in `DURATION_MS`, the Motion spring in `SPRING_MOTION` (`durationMs` 200, `bounce` 0.2; Motion takes seconds), easings as `[x1, y1, x2, y2]` in `EASING`.

### 4.4 The CSS contract

`renderTokenCss({ accent? })` returns exactly two blocks, `:root` (light) and `:root[data-theme="dark"]`, each with `color-scheme` and these 20 variables: `--surface-page`, `--surface-raised`, `--surface-sidebar`, `--surface-overlay`, `--text-primary`, `--text-secondary`, `--text-muted`, `--border-control`, `--border-subtle`, `--danger`, `--warning`, `--success`, `--info`, `--accent`, `--accent-hover`, `--accent-active`, `--accent-subtle`, `--on-accent`, `--accent-text`, `--focus-ring`. Without `accent` it carries the default accent. Every colour is validated as `#rrggbb` before anything is written (`TypeError` naming `<theme>.<field>`, value never echoed); the output uses only letters, digits, space, newline and `# - . , : ; % ( ) / { } [ ] = "` (no `<`, `>`, `&`, quote, backslash).

`renderStaticTokenCss()` carries the rest, all on `:root` unless noted: `--space-{1,2,3,4,5,6,8,10,12,16}` (rem), `--radius-{sm,md,lg,full}`, `--font-sans`, `--font-size-<style>` and `--line-height-<style>` for the nine styles (`caption`, `body-sm`, `body`, `body-lg`, `subtitle`, `title-3`, `title-2`, `title-1`, `display`), `--font-weight-{regular,medium,semibold}`, `--tracking-tight`, `--duration-{instant,fast,base,slow}`, `--ease-{standard,spring}`, `--z-{base,sticky,chrome,menu,scrim,dialog,toast,tooltip}`, `--control-height` (2.5rem inside `@media (pointer: coarse)`), `--table-row-{compact,comfortable}`, `--target-min`, `--focus-width`, `--focus-offset`, `--content-max`, `--breakpoint-{sm,md,lg,xl,2xl}`, `--glass-header`, `--glass-sidebar` (a `color-mix` of a surface variable at 92 %), `--blur-{header,sidebar,scrim}`, `--scrim`, `--shadow-{1,2,3}` (and the dark overrides on `:root[data-theme="dark"]`). The static part contains no hex colour.

Notes for the owners of the web half (`T-A-123` and later):

- Tailwind's own `--text-*` namespace is for font sizes, so font sizes are `--font-size-*`; map them in `@theme` as `--text-body: var(--font-size-body)` and the colours as `--color-text-primary: var(--text-primary)`. No `@theme` mapping exists yet; `tokens.generated.css` is not imported by anything until `T-A-123`.
- `tokens.generated.css` = static part + the default colours. The default colour blocks are written as `:where(:root)` and `:where(:root[data-theme="dark"])` (specificity 0), so the `<style>` the server injects (plain `:root` rules) wins whether it sits before or after the stylesheet link. Vite appends the stylesheet link at the end of `<head>`, so this matters for `T-A-164` (shell template) and `T-A-091` (filler).
- The dark theme is `data-theme="dark"` on `<html>`; the boot script resolves "system" to light or dark before first paint (FR-A-121). There is no `prefers-color-scheme` rule in the tokens.

## 5. The WCAG guarantee: evidence

**Property test** (`shared/accent.property.test.ts`, 76 tests, main case about 6 s of a 60 s timeout). Oracle written in the test: an 8-bit linearisation folded into constants (`value / 3294.6` and `((value + 14.025) / 269.025) ** 2.4`) and an OKLab lightness by a different route (XYZ then Ottosson's M1), sharing no code with `contrast.ts` or `accent.ts`. Surfaces come from `@m365portal/shared/tokens` (package self-reference, resolved by Vitest and TypeScript).

| Colour group | Count |
|---|---|
| 16 x 16 x 16 lattice (every `#rgb` short hex) | 4,096 |
| cube corners | 8 |
| all greys | 256 |
| WCAG boundary colours (greys where a bound flips, for each surface and each threshold of the derivation, with neighbours; the white/black crossover; `#767676` and neighbours; the same levels on single channels) | 360 |
| edge colours (`#ffff00`, `#ffffff`, `#000000`, near-white, near-black, the surfaces, brand colours, hue extremes) | 55 |
| seeded PRNG (mulberry32, seed `0x5eed1234`, printed on failure, `ACCENT_SEED` replays another) | 20,000 |
| **unique, each in both themes** | **24,630** (SC-A-007 asks for 24,096) |

Checked per colour and theme: every bound of FR-A-101 on all four surfaces; `onAccent` is pure black or white; hover and active at least 0.03 OKLab lightness from the accent (the exhaustive sweep reports the real minimum, see below); honest `adjusted` flag in both directions; a colour with at least 3 x 1.03 on every surface comes back unchanged and a colour below 3:1 is adjusted. **Stricter than the spec on purpose**: the documented 3 % margins (accent 3.09, text 4.635, text on the accent 4.502) are asserted, and an adjusted accent must sit within 3 % of its target (real maximum 1.4 %), so a derivation that simply jumped to pure black or white, or one that stopped one 8-bit step short, fails. Further tests: purity (a source scan for clock, randomness, I/O, environment; `Date.now`, `Math.random` and `performance.now` throwing during a derivation), determinism, frozen output, `accentSubtle` equals an independent linear-light mix within one level, the examples of plan 10.4, `normalizeAccent` (25 rejected spellings including a trailing newline, fullwidth digits and hostile strings, and an error text that must not contain the input), the contrast helpers against the oracle.

**Negative fixtures** (through `expectGuardFails`, same checker): no adjustment, a bisection result nudged a hair back toward the failing side, text colour never walked, hover equal to accent, always-white text, a pale focus ring, a lying `adjusted` flag, a changed compliant colour, a non-hex value, and a check that the seed is printed.

**Mutation checks on a scratch copy** (the implementation itself was broken, not the output; 14 mutations, each turns the main case "holds every bound ..." red together with other tests; the unmodified control copy passes all 76):

| Mutation of `accent.ts` / `contrast.ts` | Main case |
|---|---|
| bisection midpoint returned without the verified walk | red |
| bisection result from the failing side of the bracket, no walk | red |
| coarse 5-step bisection trusted without the walk | red |
| bisection and walk disabled (jump to the end of the axis) | red (not minimal) |
| accent never adjusted | red |
| accentText not walked | red |
| hover and active returned without the check | red |
| onAccent always white | red |
| text target lowered to 4.0 | red |
| non-text target lowered to 2.5 | red |
| wrong walk direction | red |
| focus ring replaced by a pale grey | red |
| `adjusted` always false | red |
| luminance coefficient typo in `contrast.ts` | red |

The first run showed a weakness: with only the bare 3:1 and 4.5:1 bounds, the midpoint and the failing-side mutants were caught by the example test alone, because a one-level error stays above the bound (the derivation's 3 % margin absorbs it), and the jump-to-the-end mutant passed the main case altogether (it is a valid but crude derivation). The margin and minimality assertions above were added for that reason; the table is from the final test.

**Equivalence with the plan's prototype** (Appendix B, extracted to the scratchpad, run unchanged): 34,096 colours (the lattice and 30,000 seeded) in both themes, **0 differences** in any field. The port is about 2.6 times faster (0.24 ms per colour for both themes, against 0.63 ms).

**Exhaustive sweep** (one-off, not committed, three low-priority processes, the oracle copied into the script): all 16,777,216 `#rrggbb` colours in both themes (33,554,432 token sets; three ranges of about 5.59 million, 20 to 27 minutes each at low priority): **0 violations** of the bounds of FR-A-101 on all four surfaces, of the honest `adjusted` flag in both directions, of unchanged-when-compliant and adjusted-when-failing, of the pure black or white text colour and of the hover and active step; the smallest values below also show that the 3 % margins hold for every input. The minimal-adjustment check of the committed test (an adjusted accent within 3 % of its target) was not part of the sweep. Adjusted: 8,800,099 in light (52.4 %) and 5,123,569 in dark (30.5 %), 41.5 % overall (the plan estimated 42 %). Smallest values over all inputs: accent 3.0900002 (target 3.09), focus ring 3.0900002, accent text 4.6350011 (target 4.635), accent text on accentSubtle 4.6350000, onAccent on accent, hover and active 4.5020006 (target 4.502), and a hover or active step of 0.029998 OKLab lightness by the independent route (the implementation's own route guarantees at least 0.03; the two routes differ by about 2e-6 at the minimum, and the check allows 0.029). The sources were hashed before the run and match the committed files after it.

## 6. Test counts

| File | Tests |
|---|---|
| `shared/tokens.test.ts` | 104 (part 1: 58, part 2: 46) |
| `shared/accent.property.test.ts` | 76 |
| Package `@m365portal/shared`, second clean copy | 1,106 in 11 files, 1,105 passed (this chunk 180; the S0 guards 513; the other 413 are S1's test files that were in the tree at the time) |
| Skipped, todo | 0 |

## 7. Decisions and deviations from the task text

1. **Order**: `T-A-122` was done before `T-A-121` (dependency, see section 1).
2. **`normalizeAccent` throws** (`InvalidAccentError`, code `accent_invalid`), as the task's "rejects" and the guard style suggest; `tryNormalizeAccent` is the non-throwing sibling for forms. Both take `unknown`. The task did not fix the failure mode.
3. **`AccentTokenSet` lives in `branding/accent.ts`**; `tokens/css.ts` imports it and `deriveAccentTokens` (a token module that depends on the branding module, one direction only, no cycle). The alternative, `renderTokenCss()` without a default accent, would have left "every role" untrue for the generated file.
4. **`renderStaticTokenCss` and `renderTokensStylesheet` are additions to C9**, which only names `renderTokenCss`. The split follows PD-13 (the server injects the colour part, the build writes the static part).
5. **Default colours are zero-specificity** (`:where`) in the generated stylesheet (section 4.4).
6. **Default accent `#0078d4`** is the plan's own example. It is "a calm blue" (A-42), clears every bound unchanged in both themes with white text, and coincides with a well-known brand blue; see OP-4.
7. **Tests import `@m365portal/shared/tokens` by package name** (self-reference) so the test goes through the same exports map the app uses (FR-A-102). Works in Vitest, `tsc` and `workspace-deps`.
8. **`scripts/gen-tokens-css.ts` accepts `--file <path>`**: the only way to test `tokens:check` against a stale fixture without touching the committed file.
9. **Lazy initialisation**: the linearisation table and the per-theme surface luminances are built on first use, not at import, and white luminance is the constant 1 (the three coefficients add up to exactly 1). Reason: the tokens barrel now reaches the derivation, and a module with work at import time cannot be dropped from a bundle that does not use it.
10. **Hover and active fallback** searches opposite-direction offsets up to 1.0 where the prototype stops at 0.4. The extra range was never needed in the 34,096-colour comparison with the prototype (0 differences); it exists so that an impossible case ends in a named error after a complete search.
11. **Outputs are frozen** and JSON-serialisable.

## 8. Open points, assumptions, risks

Open points (owner or other streams; the numbers are those of `chunk-s3a.md`, which also lists OP-8 to OP-10: documentation to write, spec wording, a named CI step):

- **OP-1 The 3 % margin band.** FR-A-101 says a colour that satisfies the bounds "is used unchanged". The plan (10.4 step 2) uses the bounds with a 3 % margin for that decision, so a colour at 3.00 to 3.09:1 against a surface is adjusted (minimally) although it would be allowed. The test encodes the plan. Either the spec row gets the margin sentence or the plan drops it (S8 / owner).
- **OP-2 Barely visible hover on near-black accents.** A near-pure-black accent in the light theme gets hover `#010101` and active `#020202` (`#000000`), because 0.045 OKLab lightness is below one 8-bit step at the dark end. AA is unaffected. 3 of 24,096 sampled colours are within seven levels; the dark theme has none. A visible floor needs a design decision (what is the hover of black?).
- **OP-3 Black text on mid-tone brands.** On uniformly random colours 63 % get black text on the accent (plan 10.4 "design consequence"; the owner decision of plan section 18 about a "darken for white text" mode is still open). 52 % (light) and 31 % (dark) of random colours are adjusted; the plan estimated 42 % over both.
- **OP-4 Default accent.** `#0078d4` equals a vendor brand colour. Fine for a default that the organisation replaces, but the owner may prefer a neutral blue; the choice is one constant (`DEFAULT_ACCENT`) and the generated stylesheet.
- **OP-5 Two orchestrator edits.** Add `T-A-122` to the `Needs` of `T-A-078` and `T-A-082` (section 4.2); optionally `"sideEffects": false` in `packages/shared/package.json` (S0's file) if `pnpm bundle:check` shows the tokens barrel pulling the derivation into the entry chunk (R2).
- **OP-6 `RADIUS_FULL_USES` is a list, not a control.** Nothing scans the web code for `rounded-full` outside avatars, switch thumbs and status dots; `T-A-123`'s `styles.test.ts` can add it.
- **OP-7 Sweep and property test are not a CI job.** The exhaustive sweep is a one-off; CI runs the committed property test (24,630 colours). Re-run the sweep (recipe in `chunk-s3a.md`) after any change to a surface, to `accent.ts` or to `contrast.ts`.
- **OP-11 A failure outside this chunk.** `shared/repo-conventions.test.ts` check 5 fails on `apps/server/src/config/env.ts:81`, a doc comment of S1's in-progress file that spells the literal port 8080 (the guard reads comments too; G0 section 13 warned about this). S1 owns the file; reword the comment (for example "`[::1]:<port>`").

Assumptions: A-42 (default accent is a calm blue defined once) as above; the neutral and status colours of plan 10.2 are used as written; the text of an accent is pure black or white (a softer black would break the 4.583 bound); glass layers that carry text keep alpha at least 0.92, which is what lets the derivation work against opaque surfaces only.

Risks:

- **R1 Engine rounding.** `**` and `Math.cbrt` are only approximately specified, so the same colour may come out one 8-bit level apart on another engine or CPU (arm64 image, Firefox, Safari). The guarantee is unaffected because each engine verifies its own result before returning it; only the exact hex can differ. Tokens are derived on demand and never stored, so nothing persistent can disagree. The sweep ran on x64 V8 only.
- **R2 Bundle weight.** The tokens barrel now imports `css.ts`, which imports the derivation (about 13 kB of source before minification, comments excluded). Modules have no work at import, so a bundler should drop them from pages that use only constants; unverified until `T-A-259` measures the entry chunk (OP-5).
- **R3 Preview versus server.** The live preview computes in the browser, the stored truth is the server's `tokens`. After saving, show the server's values; the two can differ by one level (R1).
- **R4 Per-request cost.** One derivation is 0.24 ms; the server memoises `renderTokenCss` per branding revision, so this is not on the request path.

## 9. Files of this chunk

Created: `packages/shared/src/tokens/{colours,spacing,radius,shadow,type,motion,layers,glass,focus,css}.ts`, `packages/shared/scripts/gen-tokens-css.ts`, `apps/web/src/styles/tokens.generated.css`, `packages/shared/test/{tokens,accent.property}.test.ts`, this note and `chunk-s3a.md`. Changed (stub filled in): `packages/shared/src/tokens/index.ts`, `packages/shared/src/branding/{accent,contrast}.ts`. No dependency, `package.json`, lockfile or `VERSION` change; no other stream's file touched; no git state changed.

## 10. Not verified here

Any browser (nothing in this chunk renders: the CSS is checked as text), arm64, the effect of the `:where` ordering in a real document (tested textually; `T-A-164` and the e2e specs will show it), bundle size (OP-5), screen readers and forced-colors rendering (`T-A-123` and the e2e forced-colors spec).

## 11. Re-run recipe

```text
cd packages/shared
./node_modules/.bin/vitest run test/tokens.test.ts test/accent.property.test.ts     # 180 tests, about 15 s
./node_modules/.bin/vitest run test/exports.test.ts test/single-implementation.test.ts test/repo-conventions.test.ts   # 513 tests
ACCENT_SEED=7 ./node_modules/.bin/vitest run test/accent.property.test.ts           # another seed
pnpm tokens:generate && pnpm tokens:check                                           # from the repository root
```
