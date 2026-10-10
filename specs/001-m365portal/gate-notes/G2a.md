# Gate note G2a (T-A-070 to T-A-074): branding pure units and wire schemas

**Date**: 2026-10-10. **Stream**: S2 (branding backend, pure units and schemas), chunk label `s2a`. **Gate**: G2a freezes the Zod wire schemas of the branding API (`BrandingSchema`, `ApplyBrandingRequestSchema`, `UploadAssetResponseSchema`, `BrandingExportSchema`, `ImportResultSchema`, `WebManifestSchema` and their parts, contract C10) for S5, and with them the shared units the schemas and the server call: the organisation-name normaliser, the glyph table, initials and monogram, the logo plate rule. Consumers: S2b (`T-A-082` icons, `T-A-085` service, `T-A-087` to `T-A-091` routes), S5, S4 (shell tile), S9. Open points, assumptions and risks are also in [`chunk-s2a.md`](chunk-s2a.md) for S8 to consolidate.

## 1. Verdict

**Passed.** All five tasks are done and every "Done when" was checked by running commands, on the live tree and in a clean copy (section 2). No test was skipped, weakened or left red. 615 tests in 5 new files, all green; the whole `@m365portal/shared` package is green in the clean copy (20 files, 1,938 tests), as are the repository tool tests (10 files, 806 tests).

- Order of work: `T-A-070`, `T-A-071`, `T-A-072`, `T-A-073`, `T-A-074`, as ordered. `T-A-073` needed `T-A-120` (G3a): the tokens and `branding/contrast.ts` were there.
- Every task was test first: the test was written, run, and seen red for the right reason (section 3), then the code.
- Four things are for the orchestrator or for S8 (section 7, OP-1 to OP-4): the dependency change and the `pnpm-workspace.yaml` comments, the VERSION bump at commit time, the plate thresholds (owner review), and the Inter licence notice.

## 2. What was run, and on which state

| Item | Value |
|---|---|
| Live tree | `/home/user/M365Portal`, uncommitted work of several streams. Only S2-shared files were written by this chunk (section 9) |
| Clean copy | `scratchpad/s2a/g2a-copy`: `git ls-files -co --exclude-standard` tarred plus `.git`, then `flock /tmp/m365portal-pnpm.lock pnpm install --frozen-lockfile` (exit 0, 2 s: the lockfile agrees with the three new dependencies) |
| Toolchain | Node 22.22.0 (ICU 77.1, Unicode 16.0), pnpm 10.28.0, Vitest 5.0.3, TypeScript 6.0.3, ESLint 10.12.0, Prettier 3.9.10, opentype.js 2.0.0, @fontsource/inter 5.3.0, Zod 4.6.5 |
| Package gates, clean copy | `pnpm --filter @m365portal/shared lint` exit 0 (21 s), `typecheck` exit 0 (9 s), `test` **20 files, 1,938 tests, 0 failed, 0 skipped** (31 s) |
| Repository tool tests, clean copy | `pnpm test:tools`: 10 files, 806 tests passed (`tools/workspace-deps` included: the font tools are declared in the package that imports them) |
| This chunk's files | `org-name` 71, `glyphs` 30, `initials` 86, `logo-plate` 52, `schemas-branding` 376 = **615 passed, 0 failed, 0 skipped** |
| Guards over the new files | `single-implementation.test.ts` (232), `exports.test.ts` (14, compiles every new file under NodeNext and bundler resolution), `repo-conventions.test.ts` (250): green with the new files in the tree. The script `gen-glyphs.ts` is scanned as code outside `packages/shared/src`: no look-alike name, no tell-tale |
| Format | `prettier --check` clean on every new or changed file (the generated table is in `.prettierignore` on purpose) |
| Reproducibility | `pnpm glyphs:generate` in the clean copy (another path) writes a table that is byte-identical to the committed one (`cmp`) |
| Lazy import | from `apps/web` (workspace link): `await import('@m365portal/shared/schemas/branding')` and the three siblings resolve and parse (12 + 8 + 5 + 2 schemas). Bundled alone with esbuild (Zod external): 5.7 to 7.5 kB minified per module, no glyph table, no accent derivation; with Zod, 460 kB, 95 kB gzip (the Zod chunk is lazy by plan) |
| Mutation checks | 43 mutations of the real code in a scratch copy (section 6): 42 killed, 1 equivalent |

## 3. Task by task

| Task | Red first (reason) | Green | Negative fixtures |
|---|---|---|---|
| `T-A-070` org name | `org-name.test.ts`: 44 of 71 failed with `normalizeOrgName is not a function` (the module was the stub `export {};`); the 27 that passed are the independent model and its mutants | 71 tests | A second implementation of FR-A-081 inside the test, with one switch per rule (`makeModel(flags)`): with every switch right it passes the same 17 rules as the module; 18 mutants (no NFC, no trim, no collapse, UTF-16 count, no cluster cap, no byte cap, control characters allowed, separators allowed, bidi only, every invisible allowed, joiners refused, braille allowed, nothing-visible allowed, coercion, no surrogate check, cut by code point, cut by code unit, space left at the cut) each break the rule that guards the switch (`expectGuardFails` with the rule id as the reason) |
| `T-A-071` glyph table | `glyphs.test.ts` failed at load: `Cannot read properties of undefined (reading 'A')` (stub table); the generator did not exist | 30 tests | Guards (`assertTable`, `assertFileText`, `assertMatchesFont`) run on 40 broken tables: missing, extra and reordered glyphs; 15 malformed path strings (exponent, decimal, plus sign, leading zero, implicit repetition, arc, cubic, unknown command, lower-case `m`, spaces, newline, empty); unclosed and nested contours; outlines outside the box; bad advances; a box of another size; no pictogram; file over 15,000 bytes; header without generator, font version, package version or licence; an `import`, a re-export and a `require`; a glyph replaced by another, a shifted outline. `--check` fails on a stale digit, a missing file, an empty file, an extra export and a truncated file |
| `T-A-072` initials, monogram | 80 of 86 failed (the two modules were stubs) | 86 tests | Nine naive implementations (split on spaces, emoji as a word, first UTF-16 unit, no case, first two words, every word, no NFD, no table, no pictogram) each fail the example that guards the behaviour (`expectGuardFails` with the example as the reason) |
| `T-A-073` logo plate | 47 of 52 failed (stub) | 52 tests | Nine wrong rules (never plates, always plates, plates swapped, ignores the theme, 4.5:1, 2:1, plates an unknown luminance, clamps out-of-range values, coerces strings) each fail their row; one test swaps the sidebar surface of the token module with `vi.doMock` and shows the thresholds move |
| `T-A-074` schemas | 308 of 320 failed (four stubs) | 376 tests | The transform guard and the light-imports guard each run on fixtures that must fail; every row of every `it.each` is a refusal |

### 3.1 `T-A-070`: done

- `normalizeOrgName(input: unknown): string` throws `InvalidOrgNameError` (a `RangeError`, `code: 'org_name_invalid'`, `reason`, never the name in the message). `tryNormalizeOrgName` returns `null` instead of throwing (forms, `refine`). `shortOrgName(name)`, `DEFAULT_ORG_NAME` ("M365Portal"), `isDefaultName(name)` and `SHORT_ORG_NAME_MAX_GRAPHEMES` (12) are exported once, from `branding/org-name.ts`; `single-implementation.test.ts` is green.
- The sweep: every Unicode code point (all 1,112,064 scalar values) is tried between two letters and compared with an oracle written from the Unicode data in the test (a hard-coded `Default_Ignorable_Code_Point` table that is also compared with the engine's property, so a drift of the engine's data fails first). 1.5 s.
- `LIMITS.orgName` (64 graphemes, 256 bytes) is read from `limits.ts`; the byte count is by hand with an early exit (no encoder), so a 2 MB input is refused cheaply.

### 3.2 `T-A-071`: done

- `packages/shared/scripts/gen-glyphs.ts` reads the static Inter Bold `.woff` (`inter-latin-700-normal.woff` of `@fontsource/inter` 5.3.0, "Version 4.001;git-66647c0bb") with opentype.js 2.0.0 and writes `src/branding/glyphs.generated.ts`: **12,495 bytes** (limit 15,000), 36 glyphs and one pictogram. `tsx scripts/gen-glyphs.ts [--check] [--file <path>]`; `pnpm glyphs:generate` is the script of the contract. The header names the generator, the command, the font and its version, the package version, the reader and the licence.
- The table is checked against the font by an oracle in the test that reads the `.woff` itself: advance, outline bounds (control points included), contour count and ink area of all 36 glyphs.
- I looked at the 36 glyphs and the pictogram drawn with sharp from the committed paths (a contact sheet in the scratchpad, not committed): they read as Inter Bold and the pictogram as a building with windows and a door.
- The format and units are in section 4.1.

### 3.3 `T-A-072`: done

- `deriveInitials(name)` in `branding/initials.ts` and `monogramGlyphs(initials)` in `branding/monogram.ts`, plus `monogramFor(name)` (their composition, what the service and the preview call). The examples of E-13: "Acme Corp" gives AC, "élan vital" gives É V (drawn as E V), "Ørsted" gives Ø (drawn as O), "🚀 Rocket" gives R, "株式会社" gives the pictogram, "3M" gives 3.
- 4,000 seeded names (mulberry32, seed `0xac3e1234`) in several scripts, emoji sequences and hostile text keep every invariant: at most two clusters, no lone surrogate or joiner, NFC, one or two glyphs, the pictogram only alone, `fallback` true exactly then, offsets starting at 0 and following the advances.

### 3.4 `T-A-073`: done

- `logoPlateFor(luminance, theme)`, `iconPlateFor(luminance)`, `logoPlateColour(plate)`, `LOGO_PLATE_MIN_CONTRAST` in `branding/logo-plate.ts`. The thresholds, the rationale and the limit of the method are written in the file header (a test parses the two numbers from it and compares them with the computed ones). They are in section 7 as OP-3.
- A sweep of luminance from 0 to 1 in 2,000 steps per theme shows: plate exactly when the contrast with the sidebar is below 3:1; one switch per theme (dark theme: `light` then `none`; light theme: `none` then `dark`); the plate always has at least 3:1 with the logo and beats the bare sidebar.

### 3.5 `T-A-074`: done

- Four modules, 27 schemas (the 21 of contract 8.1 and six additions, section 4.5). Every schema has `.meta({ id })` equal to its name without the suffix, converts to JSON Schema in both directions, and none uses a transform, pipe or coercion (source scan with its own negative fixture). Parsing a valid value returns it unchanged. The modules import only Zod, each other, `branding/org-name.js` and `limits.js`.
- "Done when": the schemas are importable lazily from the web package (verified from `apps/web`, section 2); the contract for S5 is section 4.

## 4. Frozen interfaces (G2a)

Import paths: `@m365portal/shared/schemas/{branding,assets,export-import,manifest}` (wildcard subpath, no barrel: TA-05) and `@m365portal/shared/branding/{org-name,initials,monogram,glyphs.generated,logo-plate}`. Everything is platform-neutral (no DOM, no Node), pure, and does no work at import time (the segmenters are built on first use).

### 4.1 Glyph table (`branding/glyphs.generated`)

```ts
GLYPH_CAP_HEIGHT = 1000
GLYPH_KEYS: readonly ['A'..'Z', '0'..'9']        // letters first, then digits; type GlyphKey
GLYPHS: Readonly<Record<GlyphKey, { advance: number; path: string }>>
PICTOGRAM: { advance: 800; path: string }         // a building: outline, door notch, six windows
```

Units: the cap height is 1000. x grows to the right from the left edge of the advance box, **y grows downward: y = 0 is the cap line, y = 1000 the baseline**; round glyphs overshoot both by about 14 units, the tail of Q reaches y = 1083. Advance widths only (no kerning), at most 1,426. Path data starts every contour with an absolute `M`, goes on with relative `h`, `v`, `l`, `q` on integers (a space between two numbers, none before a minus sign) and ends with `z`; a hole has the opposite winding of its outline, so the default non-zero fill rule leaves it open (the pictogram's windows too). Longest path 613 characters. `Object.keys(GLYPHS)` lists the digits first (integer keys); use `GLYPH_KEYS` for the order.

### 4.2 Organisation name (`branding/org-name`)

```ts
normalizeOrgName(input: unknown): string          // throws InvalidOrgNameError { code: 'org_name_invalid', reason }
tryNormalizeOrgName(input: unknown): string | null
shortOrgName(name: string): string                // first 12 grapheme clusters, never inside one, trailing space dropped
isDefaultName(name: string): boolean              // name === DEFAULT_ORG_NAME, exact
DEFAULT_ORG_NAME = 'M365Portal';  SHORT_ORG_NAME_MAX_GRAPHEMES = 12
type OrgNameProblem = 'not_a_string' | 'unpaired_surrogate' | 'control_character' | 'line_separator'
  | 'invisible_character' | 'empty' | 'too_many_bytes' | 'too_many_graphemes' | 'no_visible_character'
```

The rule (FR-A-081): a string; no unpaired surrogate; NFC; refused wherever they stand, **before** trimming: every control character (Cc, so tab and line breaks too), U+2028 and U+2029, every `Default_Ignorable_Code_Point` except U+200C, U+200D, U+FE00 to U+FE0F and U+E0100 to U+E01EF, and U+2800; then runs of space separators (Zs: space, no-break space, ideographic space, en, em, thin spaces and so on) become one U+0020 and one at either end is dropped; at most 256 bytes and 64 grapheme clusters (bytes are checked first); at least one letter, number, punctuation mark or symbol.

### 4.3 Initials and monogram (`branding/initials`, `branding/monogram`)

```ts
deriveInitials(name: string): string               // at most 2 clusters, upper case, accents kept, NFC; '' when nothing word-like
splitGraphemes(text: string): string[]             // the one grapheme splitter of the package (monogram uses it)
monogramGlyphs(initials: string): readonly MonogramGlyph[]   // 1 or 2 glyphs, frozen
monogramFor(name: string): Monogram                // { initials, fallback, glyphs }, frozen
interface MonogramGlyph { key: GlyphKey | 'pictogram'; x: number; advance: number; path: string }
MONOGRAM_PICTOGRAM_KEY = 'pictogram';  MONOGRAM_MAX_GLYPHS = 2
```

- A cluster is drawn as a letter or digit when it is one after NFD with combining marks and joiners removed (É as E), or through the table of letters with no decomposition: Ø ø Æ æ Œ œ Ł ł Đ đ Ð ð Þ þ ß ẞ ſ ı Ĳ ĳ Ħ ħ Ŧ ŧ Ŀ ŀ ŉ ĸ. Anything else (Cyrillic, Greek, CJK, Arabic, Hebrew, Thai, emoji, `_`) cannot be drawn.
- When no cluster can be drawn the result is the single pictogram (`x` 0, `advance` 800). When some can, those are drawn (assumption A-1).
- **Layout is part of the contract**: glyphs go left to right in the glyph box; `x` is the sum of the advances before; the width of the whole is `x + advance` of the last glyph; the height is `GLYPH_CAP_HEIGHT`. The server's icon renderer and the web tile must use this `x`, nothing else.
- Typing note for S2b: `monogramFor` returns readonly arrays; the schema-inferred `Monogram` has a mutable array, so put it into a `Branding` with `monogram: { ...m, glyphs: [...m.glyphs] }`.

### 4.4 Logo plate (`branding/logo-plate`)

```ts
logoPlateFor(luminance: number | null | undefined, theme: Theme): 'none' | 'light' | 'dark'
iconPlateFor(luminance: number | null | undefined): 'light' | 'dark'     // an icon always has a plate (PD-11)
logoPlateColour(plate: 'light' | 'dark'): string                         // '#ffffff' (light.raised) or '#161b22' (dark.raised), from the tokens
LOGO_PLATE_MIN_CONTRAST = 3
```

`luminance` is the alpha-weighted mean relative luminance of the visible pixels, 0 to 1 (the `luminance` column of `branding_asset`, `AssetRef.luminance`). Computing it needs `srgbChannelToLinear` and `relativeLuminanceOfChannels` of `branding/contrast.ts`; this chunk does not compute it. A logo is never recoloured or inverted: the only outcome is a plate. T-A-082 uses `iconPlateFor` for the icons (light plate for a dark logo, dark plate for a light one, light when unknown) and `logoPlateColour` for the plate colour.

### 4.5 Wire schemas (the contract for S5)

All strict (an unknown member is refused), none transforms; the type of each is `z.infer` under the name without `Schema`.

`schemas/branding.ts`

| Schema | Shape and rules |
|---|---|
| `OrgNameInputSchema` (addition) | a string the normaliser accepts, returned unchanged; every failure has message `org_name_invalid` |
| `OrgNameSchema` (addition) | the stored form: the normaliser leaves it as it is |
| `AccentTokenSetSchema` | `{ accent, accentHover, accentActive, accentSubtle, onAccent, accentText, focusRing }` lower-case `#rrggbb`, `adjusted: boolean` |
| `ThemeTokensSchema` | `{ light, dark }` of the above |
| `AssetRefSchema` | `{ hash, url, width 1..1024, height 1..1024, luminance 0..1 or null }`; `url` must equal `/branding/<hash>.png` (issue at path `url`) |
| `IconRefSchema` / `IconSetSchema` | `{ hash, url }` with the same url rule; the set is `{ favicon32, appleTouch180, pwa192, pwa512, maskable512 }` |
| `MonogramGlyphSchema` | `{ key: A-Z, 0-9 or pictogram, x 0..4096, advance 1..4096, path }`; `path` at most 2,048 characters, only `M h v l q z`, digits, space and minus, from `M` to `z` |
| `MonogramSchema` | `{ initials (at most 256 characters), fallback, glyphs (1 or 2) }`; `fallback` true exactly when the single glyph is the pictogram (issue at `fallback`); the layout rule `x[0] = 0`, `x[i+1] = x[i] + advance[i]` (issue at `glyphs`) |
| `BrandingSchema` | `{ revision (int, 1 or more), orgName, isDefaultName, accent (lower-case `#rrggbb`, as chosen), tokens, logos: { light, dark, compact: AssetRef or null }, compactDerived, icons, monogram, updatedAt (ISO, 3 decimals, Z) }`. No actor identity: any other member, `updatedBy*` included, is refused. Cross-field: `isDefaultName` equals `orgName === "M365Portal"` (issue at `isDefaultName`); `compactDerived` needs a compact logo (issue at `compactDerived`) |
| `ApplyBrandingRequestSchema` | `{ orgName (input form), accent (AccentInput: `#rgb` or `#rrggbb`, any case, message `accent_invalid`), logos: { light, dark, compact: Sha256Hex or null } }`, all members required (replacement semantics). Validates, does not normalise |
| `IfMatchHeaderSchema` | a strong quoted integer: `"0"` or `"1"` to 15 digits without leading zero. Weak, unquoted, lists, `*`, spaces, signs: refused |
| `revisionEtag(n)` / `parseRevisionEtag(v)` | `"3"` and back (`null` when malformed): one spelling for the ETag the server sends and the If-Match the client sends. `"0"` parses (it is well formed, so it is stale, 412, not malformed, 422) |
| `brandingAssetUrl(hash)`, `urlMatchesHash(ref)`, `assetRefFields` | the one spelling of `/branding/<hash>.png` and the shared members of `AssetRef` and `StagedAsset` |

`schemas/assets.ts`: `AssetSlotSchema` (`logoLight`, `logoDark`, `compact`); `UploadAssetQuerySchema` `{ slot }` (a repeated or unknown parameter is refused); `SVG_CONTENT_CATEGORIES` and `SvgContentCategorySchema` (the 11 of contract section 6, in its order: the sanitiser and the page use this one list); `UploadWarningSchema`, a union on `code`: `SvgContentRemovedWarningSchema` `{ code: 'svg_content_removed', categories (1 to 11, unique) }` or `AnimationFlattenedWarningSchema` `{ code: 'animation_flattened' }`; `StagedAssetSchema` = the members of an `AssetRef` plus `bytes` (1 to 2,097,152) and `created`; `UploadAssetResponseSchema` `{ asset: StagedAsset, warnings (at most 2) }`.

`schemas/export-import.ts`: `Base64PngSchema` (canonical base64: standard alphabet, padded, no whitespace, trailing bits zero, decoded size at most 2,097,152 bytes, checked by round trip and length first); `BrandingExportSchema` `{ schemaVersion: literal 1, orgName (input form), accent (AccentInput), images: { logoLight, logoDark, compact: Base64Png or null } }`, every image member present (a missing one is refused, so a typo cannot remove a logo silently); `ImportQuerySchema` `{ dryRun?: 'true' | 'false' }` (text, no coercion); `ImportedImageSummarySchema` `{ hash, width, height, bytes, warnings }`; `ImportResultSchema` `{ dryRun, applied, orgName (stored form), accent (lower-case), images: { logoLight, logoDark, compact: summary or null }, branding: Branding or null }` with `applied === !dryRun` (issue at `applied`) and `branding === null` exactly for a dry run (issue at `branding`).

`schemas/manifest.ts`: `ManifestIconSchema` `{ src: /branding/<64 hex>.png, sizes: '192x192' | '512x512', type: 'image/png', purpose?: 'any' | 'maskable' }`; `WebManifestSchema` `{ id: '/', name (stored form), short_name (1 to 256 characters and `shortOrgName(v) === v`), start_url: '/', scope: '/', display: 'standalone', theme_color, background_color (lower-case `#rrggbb`), icons (0 to 3) }`.

Additions beyond the list of contract 8.1, none removed or renamed: `OrgNameInputSchema`, `OrgNameSchema`, `SvgContentCategorySchema`, `SvgContentRemovedWarningSchema`, `AnimationFlattenedWarningSchema`, `ManifestIconSchema` (two schemas needed the same rule, or an OpenAPI component needed a name) and the helper functions and constants above.

Notes for the routes (S2b) that follow from the schemas:

- `import_unsupported_version`: read `schemaVersion` from the parsed JSON first; the schema only knows the literal 1, so a version 2 would be a generic schema failure.
- Duplicate keys cannot be seen after `JSON.parse`; `__proto__` and `constructor` members are refused by the strict objects (tested with a parsed JSON text); the document depth is the route's own check.
- A schema failure of the import document is `import_invalid` with the issue path as pointer (`images/logoLight`, `accent`, ...); the message codes `org_name_invalid`, `accent_invalid`, `base64_invalid` are the `message` of the issue.
- `ETag: "<revision>"` is `revisionEtag(branding.revision)`.

## 5. Decisions and deviations from the task text

1. **Names, throwing, and a try-variant.** The task does not fix how `normalizeOrgName` fails. It throws `InvalidOrgNameError` like `normalizeAccent` does, and `tryNormalizeOrgName` is the non-throwing sibling the schemas use.
2. **Control characters are refused, not collapsed** (tab, line breaks included); only Zs space separators are trimmed and collapsed. This reads the spec row literally ("Rejected: control characters (Cc)") and keeps "refuse, do not guess" for text that ends up in titles, audit entries and dialogs. It means a name pasted with a trailing newline is refused (a text input never delivers one).
3. **Refusal happens before trimming**, so a byte order mark at the start of a name is refused (the task lists U+FEFF) instead of silently trimmed.
4. **`short_name` has trailing spaces dropped** after the cut ("Rocket Inc. Labs" gives "Rocket Inc.", not "Rocket Inc. "). Still a cut on a cluster boundary at 12 or fewer; the task test did not decide it.
5. **Glyph box**: the table is normalised to a cap height of 1000, not an em of 1000, so the layout needs no font metric. "One fixed em box" of the task is read as one fixed box; the box is stated in the header and in section 4.1. Relative path commands and integers keep the file at 12.5 kB (absolute would be about 14 kB).
6. **The pictogram** is a building (outline with a door notch and six windows), drawn by the generator itself, 800 wide and as tall as a capital. It is a design choice; the task asks for "one generic pictogram".
7. **`monogramGlyphs` draws the drawable initials** when only some can be drawn (assumption A-1); spec FR-A-092 says "otherwise one fixed generic pictogram" and is read as "when nothing can be drawn".
8. **`deriveInitials` refinements**: upper case unless that makes more than one cluster; the first cluster of a word that starts with a letter or number (so `_Acme` gives A); trailing joiners dropped; NFC. Each is a choice the spec leaves open (section 4.3 and the file header).
9. **`monogramFor`, `splitGraphemes`, `iconPlateFor`, `logoPlateColour`, `revisionEtag`, `parseRevisionEtag`, `brandingAssetUrl`, `SVG_CONTENT_CATEGORIES`** are additions: each one is a spelling that two streams would otherwise write twice. Nothing in the task or contract is removed or renamed.
10. **`IfMatchHeaderSchema` accepts `"0"`**: it is well formed, never current (revisions start at 1), so it must be 412, not 422.
11. **`UploadAssetQuery` and `ImportQuery` are strict**: a cache-busting parameter gives 422. The Appearance page sends `slot` and `dryRun` only.
12. **Consistency refinements** on `Branding`, `Monogram` and `ImportResult` state what the data model's CHECK constraints and the producing code already guarantee. `refine` is not a transform; JSON Schema and OpenAPI generation convert (tested), the refinements are simply not described there.

## 6. Mutation checks (on a scratch copy; the live tree was never mutated)

43 mutations of the real code, each run against the test file that guards it. 42 killed; the number is the count of failing tests.

| Unit | Mutations (all killed unless marked) |
|---|---|
| `org-name.ts` (11) | no NFC (6), braille allowed (7), no collapse (4), cap 65 clusters (4), no control check (6), joiners refused (10), no byte cap (6), short cut by code unit (5), no trim after the cut (2), no visible-character rule (4), surrogates allowed (4) |
| `initials.ts`, `monogram.ts` (8) | second word instead of last (4), no upper case (11), no table (11), no NFD (8), never the pictogram (13), three glyphs (2), first two words with a broken variable (31, not counted as evidence), **emoji as words: survived** |
| `logo-plate.ts` (6) | 4.5:1 (12), plates swapped (18), icon always light (12), unknown luminance plated (11), ignores the theme (15) |
| schemas (12) | `Branding` not strict (6), If-Match leading zero (2), no base64 round trip (3), no decoded-size check (1), no url rule on `AssetRef` (9), import consistency off (2), query not strict (1), any `schemaVersion` (3), no fallback rule (2), any `display` (1), lenient name input (7) |
| glyph table and generator (9) | stale digit (2), hole winding flipped (3), a key removed (9), a wrong advance (4), `Math.floor` in the generator (2), the closing line kept (2), no y flip (2), the font version missing from the header (2) |

The surviving mutant (`isWordLike` replaced by "not blank") is **equivalent**: a word-like segment is required by the spec, and the refinement "the first cluster that starts with a letter or number" already makes emoji and symbols give no initial, so the check is defence in depth that no input can tell apart. Kept because the spec words say so.

## 7. Open points, assumptions, risks

Open points (owner or other streams; the numbers are those of [`chunk-s2a.md`](chunk-s2a.md)):

- **OP-1 Dependencies.** `opentype.js` 2.0.0, `@types/opentype.js` 1.3.10 and `@fontsource/inter` 5.3.0 were added to `packages/shared` as devDependencies through the install protocol (exact versions, catalog pins). `pnpm add` drops the comments of `pnpm-workspace.yaml`; they were put back inside the lock (`git diff pnpm-workspace.yaml` shows the three new catalog lines, and `sharp: 0.35.5` that another stream added). `git diff pnpm-lock.yaml` removes no line (the `libc:` lines are intact). S8: a reason row for each in `docs/architecture.md` (plan 5.2 has the wording). Orchestrator: commit the three files together.
- **OP-2 VERSION.** The protected paths touched (`packages/shared/src/**`, `package.json`, lockfile) need a `VERSION` bump at commit time; not done here.
- **OP-3 Plate thresholds** (owner review; the brief says only "automatic display"). A logo is plated when its mean luminance has less than 3:1 (WCAG 1.4.11) with the sidebar surface of the theme: **dark theme below luminance 0.113, light theme above 0.248**; the plates are the raised surfaces (white, `#161b22`). 3:1 plates some mid-tone brand colours on the light theme (orange 0.41, light blue 0.34) although they are readable; a 2:1 line would plate fewer and let a logo of luminance 0.07 to 0.11 through on dark. The method uses a mean, so a half-white half-black logo is not plated although half of it may vanish; a per-asset minimum and maximum would be a data model change. To `docs/open-points.md` through S8.
- **OP-4 Inter licence.** Inter is SIL OFL 1.1; the glyph table is a derived work and carries the copyright and licence notice in its header. S8: list it in the third-party notices and `docs/architecture.md`. The app already self-hosts Inter for the UI, so the notice is needed anyway.
- **OP-5 Organisation-name edge cases** for the spec: tab and newline are refused (decision 2); the emoji flags of England, Scotland and Wales use tag characters (U+E0020 to U+E007F) and are refused, as FR-A-081 says; keycap sequences and ZWJ emoji are accepted; U+180B to U+180D (Mongolian variation selectors) are default-ignorable and refused, because the spec's exceptions name only the two joiners and the two variation selector ranges. S8 may add one sentence to FR-A-081 or `docs/security.md`.
- **OP-6 Text of FR-A-092.** The spec says "otherwise one fixed generic pictogram"; the code draws the drawable initials when only some can be (decision 7). One sentence in the spec, or a change of the code, owner's choice.
- **OP-7 `T-A-082`** should use `iconPlateFor`, `logoPlateColour` and the `x` offsets of `monogramFor`, and **`T-A-085`** `revisionEtag`; both are named in section 4. The orchestrator may add them to the "Needs and Test first" text of those tasks.

Assumptions:

- A-1 When only some initials can be drawn, the drawable ones are drawn and the tile shows fewer letters than `initials` holds (`Zoë 日本` shows Z).
- A-2 The default accent, the surfaces and the plate colours come from the token module; a change there moves the plate thresholds (a test shows it) and needs the numbers of OP-3 updated in the header (a test fails until they are).
- A-3 Grapheme and word segmentation are those of Node 22 (ICU 77, Unicode 16). The server is authoritative for what is stored.
- A-4 The Zod 4.6.5 behaviours relied on: `.meta` ids, `strictObject`, `refine` with `path`, discriminated unions, `z.int()`, `toJSONSchema` in both directions (all tested).

Risks:

- R1 **Engine differences in `Intl.Segmenter`.** A browser with older Unicode data may count the clusters of a very new emoji differently from the server, so the live counter can say 64 when the server says 65. The server's answer is the one that is stored; the form must show the server's `org_name_invalid`.
- R2 **`@types/opentype.js` declares `/// <reference lib="dom" />`.** It is reached only by `scripts/gen-glyphs.ts` and the two tests that import opentype.js, but a TypeScript program includes the DOM lib globally once any file reaches it, so `tsc -p packages/shared` no longer flags a DOM global used by a file in `src`. `shared/exports.test.ts` compiles `src` alone under NodeNext and bundler resolution without those files and would catch it.
- R3 **Base64 cost.** `Base64PngSchema` runs `atob` and `btoa` on up to 2.8 million characters per image, three images per import, on the server's main thread: a few milliseconds each (the 9 MiB hostile cases are refused by length first). If it ever shows in a profile, move the check into the child process.
- R4 **The sweep tests are heavy** (1.1 million code points, three times, 1.5 s in total on this machine). If a slower CI machine makes them a problem, the oracle test is the one to thin out, not the rule.
- R5 **Generated file drift.** Any change to the generator, the font package version or the pictogram constants makes `shared/glyphs.test.ts` fail until `pnpm glyphs:generate` is run and the file committed (intended).

## 8. Not verified here

Any browser (Safari and Firefox segmentation, the live preview), arm64 (the generator uses IEEE multiplication and `Math.round` only, and the output is checked byte for byte on x64; an arm64 run is unmeasured), sharp rendering of the paths inside the distroless image (`T-A-082` and the image smoke test `T-A-235` do that), any consumer outside this package (the server's service and routes, the Appearance page: they are written later against section 4).

## 9. Files of this chunk

Created: `packages/shared/scripts/gen-glyphs.ts`, `packages/shared/test/{org-name,glyphs,initials,logo-plate,schemas-branding}.test.ts`, this note and `chunk-s2a.md`. Changed (stub filled in): `packages/shared/src/branding/{org-name,initials,monogram,logo-plate,glyphs.generated}.ts` and `packages/shared/src/schemas/{branding,assets,export-import,manifest}.ts`. Through the install protocol: `packages/shared/package.json` (three devDependencies), `pnpm-workspace.yaml` (three catalog pins), `pnpm-lock.yaml`. No other stream's file touched; no git state changed; `VERSION` and `tasks.md` untouched.

## 10. Re-run recipe

```text
cd packages/shared
./node_modules/.bin/vitest run test/org-name.test.ts test/glyphs.test.ts test/initials.test.ts test/logo-plate.test.ts test/schemas-branding.test.ts   # 615 tests, about 10 s
./node_modules/.bin/vitest run test/exports.test.ts test/single-implementation.test.ts test/repo-conventions.test.ts                                    # the guards over the new files
pnpm glyphs:generate && git diff --stat src/branding/glyphs.generated.ts          # from the repository root: no change expected
tsx scripts/gen-glyphs.ts --check                                                  # from packages/shared
```

A note for anyone writing source files with the Write tool in this environment: four-digit escapes (backslash, `u` and four hexadecimal digits, for U+2028 for example) in the text of a file are turned into the real character when the file is written, which breaks regular expression literals and hides homoglyphs. The files of this chunk use the braced form (`\u{2028}`), which is not touched.
