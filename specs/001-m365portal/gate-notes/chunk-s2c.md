# Chunk note s2c (T-A-078, T-A-079, T-A-080, T-A-081): open points, assumptions, risks

Written by the `s2c` worker for S8's consolidation (`T-A-278`). The chunk has no gate task (G2 is `T-A-094`). A first run of this chunk was interrupted: it had left the tests and code of `T-A-078` (`sniff`, `raster`, `process-upload`) and part 1 of `svg-sanitiser.test.ts` on disk, untyped and unlinted. This run verified them (mutation pass, typecheck, lint, prettier), finished `T-A-079` to `T-A-081` and wired the SVG path into `process-upload.ts`.

## 1. Tasks and evidence

| Task | Result |
|---|---|
| T-A-078 sniffing and raster | `pipeline/{sniff,raster}.ts`, `test/branding/{sniff,raster}.test.ts` (48 and 34 tests). H-22, H-25 to H-34, H-40, H-41 pass through `viaPipeline`. |
| T-A-079 pre-scan and strict parse | `pipeline/svg/{prescan,parse}.ts`, `svg-sanitiser.test.ts` part 1. `saxes` 6.0.0 is a server dependency (catalog pin, installed). |
| T-A-080 allowlist rebuild | `pipeline/svg/{allowlist,sanitise,refs,rebuild}.ts` and the extra `values.ts` (value grammars), `svg-sanitiser.test.ts` part 2. `SVG_ALLOWLIST` is exported from `allowlist.ts`. |
| T-A-081 rasterisation | `pipeline/svg/render.ts`, `test/branding/svg-render.test.ts` (15 tests). |

Commands run (single worker, live tree):

- `pnpm --filter @m365portal/server exec vitest run test/branding/{sniff,raster,svg-sanitiser,svg-render}.test.ts`: 189 passed (48, 34, 92, 15).
- `... test/branding/hostile-uploads.test.ts`: 308 passed, 1 todo (the `viaHttp` switch of `T-A-093`). That includes the in-process block "hostile corpus through the upload stages" (38 fixtures: every fixture the image layer decides, H-01 to H-24 and H-25 to H-35, H-39 to H-41) and the block through `job-runner.ts` of the other S2 chunk.
- `... test/branding` (whole folder): 572 passed, 1 failed, 1 todo. The failure is `job-runner.test.ts` "is picked up by the *-worker.ts rule of the build": `apps/server/build.mjs` (S1) still bundles `src/index.ts` only (TA-09 is not applied there). Not this chunk's file.
- `tsc -p apps/server`: exit 0. `eslint src/branding test/branding`: my files clean; the only findings are 7 in `test/branding/job-runner.test.ts` (other chunk). `prettier --check` clean on my files.
- Mutation passes (one edit per run, tests of the touched module): 19 mutants on the SVG modules, 17 killed; 14 mutants on sniff and raster, 11 killed. Survivors were closed with tests where they were real gaps (the backslash and comment rule of style declarations, now tested with permissive value rules; a cut-off PNG header). Survivors left, all equivalent: the second path-segment cap inside the implicit-repeat loop (the outer cap gives the same answer, the inner one only exits earlier), `toColourspace('srgb')` (sharp already writes sRGB; kept as documentation), the header pixel cap (sharp's own `limitInputPixels` is the second layer and gives the same code), `PNG_SIGNATURE` spelled out is pinned by the sniff tests.
- Negatives (`expectGuardFails`): every refusal of part 1, the corpus against a widened allowlist (adds `script`, `a`, `image`, event attributes; the check fails), widened elements only, widened attributes only, value rules removed, a renderer asked for more than its bound, a listener that does count a connection.

## 2. Interfaces for the next tasks

- `pipeline/process-upload.ts`: `processUpload({ bytes, slot }) => UploadResult`; sniffs by content, then raster (`rasterise`) or SVG (`rebuildSvg` then `renderSvg`). Used by `image-worker.ts` and by the in-process corpus block. I edited this file (the first run of this chunk created it; it is not on the `Files` line of the four tasks).
- `svg/rebuild.ts`: `rebuildSvg(bytes, { bound, allowlist?, rules? }) => { svg, width, height, removed, warnings }`. `removed` is in the order of `SVG_CONTENT_CATEGORIES`; `warnings` is `[{ code: 'svg_content_removed', categories }]` or empty.
- `svg/render.ts`: `renderSvg(svgText | bytes, bound) => { png, width, height }` through the shared `encodePng` and the PNG chunk self-check.
- Errors are `PipelineError` with a registry problem code (`errors.ts`) and a constant `reason`; nothing of the input is in a message. A failed self-check is `OutputCheckError` (an internal error).

## 3. Decisions the owner should know

1. **Root size.** The new root always carries `width`, `height` and `viewBox` computed from the input's `viewBox` (else `width` and `height` in px, pt, pc, mm, cm or in), with the longer edge equal to the slot bound (512 or 128), so a vector logo is drawn at the bound, not only shrunk. A view box or size above 1,000,000 in magnitude is `svg_too_complex`; zero or negative size, percentages or no size at all is `svg_not_wellformed`. A present but unusable `viewBox` is ignored with category `unknown_attribute`.
2. **Reference graph.** Cycles are found over every element, used or not. The expansion limit (100,000) counts what is drawn: definition containers (`defs`, `symbol`, `clipPath`, `mask`, gradients) count one where they stand and their content counts where something references it. Both walks use an explicit stack or work list (a chain of 4,000 references is fine, in either document order). An unresolved `url(#id)` paint falls back to its fallback colour when it has one.
3. **Dropped but not rejected.** `title` and `desc` keep their text (escaped, at most 1,000 characters); text anywhere else is dropped silently. `href` and `xlink:href` are written as `href`; `href` wins when both are present. A duplicated `id` keeps the first. `style` declarations become attributes (override the attribute, last declaration wins); a declaration with a backslash, a comment, `!important`, an unknown property or an invalid value is dropped. Dropped `url(` values that leave the document are reported as `external_reference`, other dropped values as `style` or `unknown_attribute`.
4. **Text.** `text`, `tspan`, `textPath`, `tref` in the SVG namespace anywhere in the document, also inside a subtree that would be dropped, give `svg_text_unsupported`.
5. **Fully transparent result** (all shapes `fill="none"`, zero-opacity fills) is `image_empty`, decided on the rendered pixels; the spec only says "nothing renderable". Shapes without geometry (`<rect/>`, `<path/>`), `display="none"` and `opacity="0"` count as not drawn before rendering.
6. **H-19** is accepted for `width="1e9"` with a sane `viewBox` (the declared size is ignored, no warning) and refused as `svg_too_complex` for an extreme `viewBox`. The corpus row allows both.
7. **Lint side effect.** `local/no-string-built-sql` treats `.exec()` on a named `RegExp` as SQL and `@typescript-eslint/prefer-regexp-exec` forbids `.match()`; the code uses regex literals with `.exec`, sticky regexes with `.match`, and plain string splitting for units, colours, url references and transforms.

## 4. Open points

| # | Point | Owner | When |
|---|---|---|---|
| s2c-1 | `SVG_ALLOWLIST` (`svg/allowlist.ts`) must be compared with plan 8.6 at gate G2 and published in `docs/security.md`; `svg-sanitiser.test.ts` already pins it to the plan's lists (19 elements, 48 attributes). The docs test (`T-A-270`) should import it | S8, S2 | G2, `T-A-274` |
| s2c-2 | R-06 (does the prebuilt libvips of the distroless image contain the SVG loader) is not answered here; the image smoke test `T-A-235` has to upload an SVG into the running container. If it has no loader, rasterising SVG needs another rasteriser (owner decision) | S6 | `T-A-235` |
| s2c-3 | libvips prints `GLib-GObject-CRITICAL ... out of range for property 'width'` on stderr when a RAW file with `width="1e9"` is fed to sharp. It cannot happen in the pipeline (the sanitised root has explicit small sizes); only the raw-file test of `svg-render.test.ts` shows it. The child process has no stderr | S2 | none |
| s2c-4 | `sharp` and `saxes` need their reason rows in `docs/architecture.md` (`saxes` 6.0.0 with its one transitive dependency `xmlchars`; plan 5.2 has the wording) | S8 | `T-A-274` |
| s2c-5 | `apps/server/build.mjs` does not yet bundle `src/branding/image-worker.ts` (TA-09); `job-runner.test.ts` has one test that fails because of it | S1 / orchestrator | before G2 |
| s2c-6 | `VERSION` bump at commit time (protected paths `apps/server/src/**`); no dependency file changed in this run | orchestrator | commit |

## 5. Assumptions and risks

- The sniffer routes UTF-16 text with a byte order mark and a DOCTYPE'd SVG to the SVG stage, which refuses them (H-14, H-15, H-20): "recognised as SVG" only means "the SVG stage decides".
- `failOn: 'warning'` is also used when rendering the rebuilt SVG. A librsvg warning on a document our own rebuild wrote would be refused as `image_corrupt`; none occurs in the corpus or in the unit tests, but a real-world logo might trigger one. Relax to `error` for SVG only if the Appearance acceptance (`T-A-216`) shows it.
- Timing in the tests is loose (a 30 MB nesting bomb must stop in under 500 ms, a 4,000-reference chain in under 1 s) because the machine is shared; they fail by an order of magnitude when a limit stops working.
- The value grammars are mine: hex, `rgb(a)`, `hsl(a)`, named colours, `none`, `currentColor`; no `calc()`, `var()` or `env()`. A logo that uses them loses those attributes with `unknown_attribute` (rendered with the defaults).
