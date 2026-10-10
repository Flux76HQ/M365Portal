# Chunk note s2a (T-A-070 to T-A-074): open points, assumptions, risks

Written by the `s2a` worker for S8's consolidation (`T-A-278`). The full evidence, frozen interfaces and test counts are in [`G2a.md`](G2a.md); this note lists only what a later reader has to act on or keep in mind.

## Open points

| # | Point | Owner | When |
|---|---|---|---|
| s2a-1 | Reason rows in `docs/architecture.md` for `opentype.js` 2.0.0, `@types/opentype.js` 1.3.10 and `@fontsource/inter` 5.3.0 (all devDependencies of `packages/shared`, used only by the glyph generator; plan 5.2 has the wording) | S8 | `T-A-274` |
| s2a-2 | `git diff pnpm-workspace.yaml` must show the three new catalog pins (and `sharp` of another stream); `pnpm add` removes the file's comments, they were restored by hand inside the install lock. Commit `packages/shared/package.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml` together | orchestrator | before the commit |
| s2a-3 | `VERSION` bump at commit time for the protected paths touched (`packages/shared/src/**`, dependency files) | orchestrator | commit |
| s2a-4 | **Logo plate thresholds**: a logo is plated when its mean luminance has under 3:1 (WCAG 1.4.11) with the sidebar surface: dark theme below 0.113, light theme above 0.248; plates are white and `#161b22`. The numbers are this chunk's choice; the brief only says "automatic display". Trade-offs: 3:1 plates some readable mid-tone brand colours on the light theme; a mean is a proxy (a two-tone logo may vanish half). A per-asset min and max luminance would be a data-model change | owner (design), S8 | `docs/open-points.md`, Appearance acceptance (`T-A-216`) |
| s2a-5 | **Inter is SIL OFL 1.1**: the glyph table is a derived work and carries the notice in its header. List it in the third-party notices and `docs/architecture.md` | S8 | `T-A-274`, `T-A-279` |
| s2a-6 | **Organisation-name edge cases** for FR-A-081 or `docs/security.md`: tab and newline are refused, not collapsed; England, Scotland and Wales flag emoji use tag characters and are refused; the Mongolian variation selectors U+180B to U+180D are default-ignorable and refused; ZWJ emoji, ZWNJ and keycap sequences are accepted; refusal happens before trimming, so a leading byte order mark is a refusal | S8 / owner | spec pass |
| s2a-7 | **FR-A-092 wording**: the code draws the drawable initials when only some can be drawn ("Zoë 日本" shows Z); the spec says "otherwise one fixed generic pictogram". One sentence in the spec, or a code change, owner's choice | S8 / owner | spec pass |
| s2a-8 | `T-A-082` should use `iconPlateFor`, `logoPlateColour` and the `x` offsets of `monogramFor`; `T-A-085` and `T-A-087` `revisionEtag`; `T-A-088` reads `schemaVersion` before the strict schema (`import_unsupported_version`); the luminance for `branding_asset.luminance` is computed with `srgbChannelToLinear` and `relativeLuminanceOfChannels` of `branding/contrast.ts` (G3a, OP-5 there). Typing: `monogramFor` returns readonly arrays, a `Branding` needs `monogram: { ...m, glyphs: [...m.glyphs] }` | S2 (b), orchestrator | those tasks |
| s2a-9 | The spec text of FR-A-081 says "every `Default_Ignorable_Code_Point` except U+200C and U+200D and the variation selectors"; the test pins the engine's property to a hard-coded table of the Unicode data, so a Node upgrade that changes the data fails `shared/org-name.test.ts` with the code point named. Re-check the table (DerivedCoreProperties.txt) before changing it | S2, S0 | on a Node upgrade |
| s2a-10 | `docs/operations.md` or `docs/architecture.md`: the glyph table is regenerated with `pnpm glyphs:generate` (needs the devDependencies, no network); a stale table fails `shared/glyphs.test.ts` | S8 | `T-A-274`, `T-A-277` |

## Assumptions

- When only some initials can be drawn, the drawable ones are drawn (s2a-7).
- The glyph box is the cap height (1000 units, y down, y = 0 the cap line); layout is `x` = sum of the previous advances (the contract of `monogramFor`).
- Segmentation is that of Node 22 (ICU 77, Unicode 16); the server is authoritative for a stored name.
- Plate colours, surfaces and the default accent come from the token module; a change there moves the plate thresholds and the header numbers (a test checks them).

## Risks

- Browsers with older Unicode data may count the clusters of a very new emoji differently from the server (the live counter versus `org_name_invalid`); show the server's answer.
- `@types/opentype.js` pulls the DOM lib into the TypeScript program of `packages/shared` (`/// <reference lib="dom" />`), so `tsc -p packages/shared` no longer flags a DOM global in `src`; `shared/exports.test.ts` compiles `src` alone and would.
- `Base64PngSchema` decodes and re-encodes up to 2.8 million characters per image on the main thread (milliseconds); move it to the child process if it ever shows in a profile.
- The code point sweeps of `org-name.test.ts` take about 1.5 s; thin the oracle test, not the rule, if a CI machine struggles.
- The Write tool of this environment turns four-digit `\uXXXX` escapes in file text into the real character; use `\u{XXXX}`. A U+2028 in a regular expression literal is a syntax error, a Cyrillic capital in a test looks like a Latin one.
