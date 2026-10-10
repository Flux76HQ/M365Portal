# Gate note G4a (T-A-160 to T-A-162): the i18n core of stream S4

**Date**: 2026-10-10. **Written by**: the `s4a` worker (S4, i18n core). **Gate**: G4a freezes `createTranslator`, `detectLocale`, the fragment namespaces, the merge tooling and the catalogue checks, for S1 (problem fragments), S4 (the rest of the web), and S5 (appearance fragments) (tasks.md section 2.2, contract C11).

## 1. Verdict

All three tasks are done and verified by running commands, in the live tree and again in a clean copy (section 7). No test was skipped, weakened or left red. 215 tests were added; the whole `@m365portal/shared` suite is 1,323 of 1,323 green in the clean copy. A mutation pass over the new code (76 one-edit mutants) ended with every mutant killed; five survived the first pass, each showed a case that no test reached (two of them were equivalent while the bundled catalogue stayed as small as it is), and the tests were extended (section 2). Nothing here calls a Microsoft API, no dependency was added, `VERSION` and git were not touched.

Two things for the orchestrator before wave 3 (section 8): the look-alike rule of T-A-005 that S4's `lib/locale.ts` will meet (s4a-1), and the fact that the generated `locales/{en,nl}.json` must be regenerated, never merged by hand (s4a-2).

## 2. Tasks done, with evidence

| Task | Red first (reason) | Green | Negative fixtures and mutation proof |
|---|---|---|---|
| T-A-160 i18n module | `i18n.test.ts` failed at load: `createTranslatorFrom is not a function` (the module was `export {};`); `i18n.types.test.ts`: 12 tests failed with TS2305 "has no exported member `createTranslator`" | `i18n.test.ts` 84, `i18n.types.test.ts` 19 | Four guards, each with an input that makes it fail through `expectGuardFails`: no i18n framework in any `package.json` of the workspace (6 framework names tried), only relative imports in `src/i18n`, `detect.ts` imports `./types.js` and nothing else (4 forbidden specifiers), `types.ts` reaches a catalogue only through `import type`. The compile check of the type test has its own negative (a bad key gives TS2345, a dead `@ts-expect-error` gives TS2578). 36 mutants of `detect.ts`, `format.ts`, `create-translator.ts`, `types.ts`: all killed (F1, F3, T1 and Y1 survived the first pass and led to four new tests) |
| T-A-161 fragment merge | `i18n-fragments.test.ts` failed at load: `Cannot find module '../scripts/i18n-merge.js'`; the compile-time check that the registry's `problem.*` keys equal the English catalogue's failed (TS2344, `en.json` was `{}`). After the script and before `pnpm i18n:merge`: 3 failed (freshness), 34 passed | `i18n-fragments.test.ts` 37 | More than 30 negative inputs through `expectGuardFails` (prefix, key grammar, duplicate across files, duplicate inside a file, missing language, unsorted, unknown namespace, bad file name, unsupported language, invalid JSON, not an object, non-string value) plus the freshness guard (stale, hand-edited, missing) and the CLI run for real (write, `--check` ok, stale, missing, broken fragments write nothing, usage errors exit 2). 18 mutants of `i18n-merge.ts`: all killed |
| T-A-162 catalogue checks, gate | `i18n-catalogue.test.ts` failed at load: `Cannot find module './helpers/catalogue-check.js'`. Six tests then failed on mistakes of my own test data (a key `a.one` is a plural form; a symbols test whose English side lacked the placeholder), which is the hazard of s4a-4 happening to its author | `i18n-catalogue.test.ts` 75 | The five fixtures of the task (`shifted-cyrillic`, `shifted-greek`, `placeholder-mismatch`, `empty-value`, `plural-missing`) each fail with the expected message, are reported by exactly one check, and differ from the valid base catalogue only at the intended keys. Further negatives in memory for key parity, plural kinds, stray braces, plural categories (Arabic, Polish, a Dutch `.zero`), every script of the list, CJK. 22 mutants of `catalogue-check.ts`: all killed (C21, digits of another script, survived the first pass and got a test) |

Mutation method: a copy of `packages/shared` in the scratchpad (`node_modules` symlinked), one edit per run, the test files that own the code per run, a green baseline first (209 tests). A first run of the harness reported every mutant as surviving because it parsed the summary line wrongly; it was fixed to use the exit status of Vitest plus the `FAIL` lines, and the run was repeated from the start. Survivors of the second run: F1 (`name in params` against `Object.hasOwn`), F3 (an own parameter whose value is `undefined`), T1 (a catalogue that inherits a message), Y1 (`MessageKey` as the raw keys; the bundled catalogue has no plural group, so only a different `en.json` shows it: the type test now hands the compiler another `en.json`) and C21 (a Devanagari digit read as a letter). Each got a test; the five were re-run and are killed.

`pnpm i18n:merge` and `pnpm i18n:check` exist (the script contract of tasks.md section 4); `pnpm i18n:check` runs `i18n-catalogue.test.ts` and `i18n-fragments.test.ts` (112 tests).

## 3. Frozen interfaces

Import paths: `@m365portal/shared/i18n` (barrel, owned by S4), `@m365portal/shared/i18n/detect` (the boot script's import), `@m365portal/shared/i18n/locales/en.json` and `nl.json`.

### C11 the module (`src/i18n/`)
- `createTranslator(locale: Locale): Translator`. `Translator = { locale: Locale; t(key: MessageKey, params?: MessageParams): string; n(value: number, options?: Intl.NumberFormatOptions): string; d(value: Date | number, options?: Intl.DateTimeFormatOptions): string }`. `t`, `n` and `d` are closures: destructuring them is fine. A value that is not a supported locale (it can only come from outside the type system) gives English.
- `createTranslatorFrom(locale: string, catalogues: CatalogueSet): LooseTranslator`: the same machinery over catalogues of the caller's own (tests, tooling); keys are strings; `catalogues.en` is the fall back; a malformed language tag throws `RangeError` at once. `Translator` is assignable from it for the bundled case.
- `MessageKey`: derived from `locales/en.json` (`MessageKeyOf<typeof En>`): every key that is not a plural form, plus the base key of each plural group. `t('does.not.exist')` is a compile error (proved by `@ts-expect-error` lines and by running the compiler from inside the test, also against a different `en.json`). `MessageKeyOf<Catalogue>` is exported for tooling.
- **Resolution of `t(key, params)`**: the locale's catalogue, then `en`. In each catalogue: the plain key; else the plural form `key.<category>` that `Intl.PluralRules` of THAT locale selects for `params.count` (only when `count` is a number); else `key.other`. Nothing found: the key itself is returned (visible, never a crash). Own properties only: `constructor`, `toString` and anything inherited are never messages.
- **Interpolation**: `{name}` (letters, digits, underscore; first character a letter or underscore), one pass, a replacer function. A parameter value is data: `$&`, `{other}` and the like in it stay literal and are not scanned again. A number parameter is formatted for the locale (`1234` prints `1.234` in `nl`, `1,234` in `en`); a string is printed as given (pass a string for a year or an identifier). A placeholder with no parameter, or with a parameter that is neither string nor number, stays visible as `{name}`.
- `n` and `d`: `Intl.NumberFormat` and `Intl.DateTimeFormat` of the locale, formatters cached per locale and option set (64 entries). `d` without options prints `dateStyle: 'medium'`; an invalid date throws `RangeError`.
- `detectLocale(languages: readonly unknown[] | null | undefined): Locale`: the first entry whose primary subtag is `nl` or `en` decides (`-` or `_` as separator, any case, whitespace trimmed); `nl-BE` is `nl`; `de-DE` alone, an empty list, `null`, `*`, `nld`, `x-nl` give `en`; entries that are not strings are skipped. Defined only in `detect.ts`, which imports only `./types.js`: bundled alone it is 256 bytes minified (measured).
- `LOCALES` (`['en', 'nl']`), `DEFAULT_LOCALE` (`'en'`), `isLocale(value: unknown): value is Locale` (for a stored choice), `PLURAL_CATEGORIES`, `placeholdersOf(message)`, `stripPlaceholders(message)`, `interpolate`, `createFormatters(tag)`, and the types `Locale`, `MessageKey`, `MessageKeyOf`, `MessageParams`, `Translator`, `LooseTranslator`, `Catalogue`, `CatalogueSet`, `Formatters`, `PluralCategory`.
- **Plural groups**: a key whose last segment is `zero`, `one`, `two`, `few`, `many` or `other` is a plural form, always. Callers pass the base key and `count`. English and Dutch need `one` and `other`.

### Fragments and the merge (`src/i18n/fragments/`, `scripts/i18n-merge.ts`)
- File name `<namespace>.<language>.json`, language `en` or `nl` (from `LOCALES`), namespace lower case letters and digits. One flat JSON object of strings; every key starts with `<namespace>.`, continues in dot-separated non-empty segments without spaces, braces or control characters; keys sorted in code unit order (the default `Array.prototype.sort`); no key twice in a file or across the fragments of one language.
- `NAMESPACE_OWNERS` (exported from the script): `problem` S1; `appearance`, `accent`, `logo`, `preview` S5; `shell`, `nav`, `theme`, `lang`, `banner`, `a11y`, `palette`, `shortcuts`, `dashboard`, `pages`, `errors`, `common`, `placeholders`, `showcase`, `pwa` S4. A namespace outside the table fails the merge and names the constant; a namespace with files must have both languages; a namespace in the table without files is fine.
- `pnpm i18n:merge` writes `src/i18n/locales/{en,nl}.json` (generated, committed, two-space JSON, final newline, keys sorted). `tsx scripts/i18n-merge.ts [--check] [--fragments <dir>] [--out <dir>]`; `--check` compares only. Exit 0 ok, 1 problems or stale, 2 usage. Every problem of a run is listed, not the first.
- A stale or missing committed file fails `shared/i18n-fragments.test.ts` with `... is stale (first difference at line N); run \`pnpm i18n:merge\` and commit the result`.
- The merged catalogues hold exactly the 32 `problem.*` keys of S1 in each language today; the test also proves (TA-03) that nothing else may carry a `problem.` key, and the type test proves in both directions that the keys of the registry (`ProblemMessageKey`) equal the `problem.*` keys of `MessageKey`.

### The catalogue checks (`test/i18n-catalogue.test.ts`, `test/helpers/catalogue-check.ts`; FR-A-111, baseline section 12)
Run on the merged `locales/{en,nl}.json`; each is a pure function of a `{ en, nl, ... }` set, `assertCatalogues` throws with every problem grouped by check name:
1. **key parity** against `en`; a plural group counts as one key (forms differ per language) and must be a group in every language;
2. **no empty value** (white space and invisible format characters count as empty; a non-string is an error);
3. **placeholder parity** per key (names compared as sets), and **placeholder syntax** (a brace that is not a well-formed `{name}` is an error even when both languages repeat it);
4. **plural completeness**: the forms `Intl.PluralRules` selects for the language (Arabic six, Polish four, English and Dutch two), no form that can never be shown (`.zero` in Dutch), no key that is both plain and a group;
5. **no value in a third script**: letters only (`\p{L}`), placeholders left out, 43 scripts told apart, any other script `Other`; the catalogue's own script is the one with most letters, Latin is always allowed, a catalogue dominated by Han or Hangul keeps its top two non-Latin scripts; ties by name; at most 10 offenders listed per language, the rest counted.

**What the checks cannot see, stated in the test header and executable as two tests**: one Latin-script language filed as another (nl and en are both Latin, so on the real catalogues the third-script check can only pass; the fixtures prove it works), and a catalogue that shifted wholesale (its own script is inferred from itself). A Japanese catalogue (kanji, hiragana, katakana) would exceed "top two".

## 4. Test counts

| File | Tests |
|---|---|
| `packages/shared/test/i18n.test.ts` | 84 |
| `packages/shared/test/i18n.types.test.ts` | 19 |
| `packages/shared/test/i18n-fragments.test.ts` | 37 |
| `packages/shared/test/i18n-catalogue.test.ts` | 75 |
| Total new | 215 |

Skipped, todo or only: none. The clean copy ran the whole shared package: 1,323 tests in 15 files (the 11 files of other streams and S0 included), all green.

## 5. Files

Created: `packages/shared/src/i18n/{create-translator,types,detect,format}.ts`, `packages/shared/scripts/i18n-merge.ts`, the four test files above, `packages/shared/test/helpers/catalogue-check.ts`, `packages/shared/test/fixtures/i18n/{shifted-cyrillic,shifted-greek,placeholder-mismatch,empty-value,plural-missing}/{en,nl}.json`, this note and `chunk-s4a.md`. Changed: `packages/shared/src/i18n/index.ts` (the stub became the barrel), `packages/shared/src/i18n/locales/{en,nl}.json` (generated: `{}` became 32 keys each). No file outside the S4 territory of tasks.md section 1.1, no dependency, no seam. The files contain real non-ASCII characters on purpose (Cyrillic, Greek and Han test text; the fixtures); invisible characters in tests are written with `String.fromCodePoint`.

## 6. Assumptions

See `chunk-s4a.md` (A-1 to A-7). The ones that matter most to a consumer: a number parameter is formatted for the locale (decision, easy to reverse in `interpolate`); an unknown key returns the key; braces have no escape; `detectLocale` knows only the two-letter codes.

## 7. What was run, and where

| Where | Commands | Result |
|---|---|---|
| Live tree | the four test files; `eslint --max-warnings 0` and `prettier --check` on every file of this chunk; `tsc -p packages/shared`; `pnpm i18n:merge`; `pnpm i18n:check`; `single-implementation`, `repo-conventions`, `exports`, `index`, `guard-helper` of S0 | all green |
| Bundlers (scratch project, the real `@m365portal/shared` through a symlink) | esbuild 0.28.2 bundle for Node of `createTranslator` + `detectLocale` run with Node (printed the Dutch message for `['de-DE','nl-BE']`); esbuild minified bundle of `@m365portal/shared/i18n/detect` alone: 256 bytes, no catalogue; `vite build` (Vite 8.3.4) of the barrel: one 10.4 kB chunk containing the catalogues | all as expected |
| Clean copy (`git ls-files -co --exclude-standard`, `pnpm install --frozen-lockfile` exit 0 in 1.9 s) | `pnpm --filter @m365portal/shared typecheck`, `lint`, whole `test` (1,323 of 1,323); `pnpm i18n:merge` followed by `cmp` against the committed files (identical); `pnpm i18n:check` (112); `typecheck` of `@m365portal/server` and `@m365portal/web`; `prettier --check` of this chunk's files | all exit 0 |
| Mutation pass (scratch copy) | 76 mutants, section 2 | 76 killed after the five additions |

Not run: root `pnpm test` and `pnpm build`, the web test suite and web build, e2e (outside this territory; the web package does not import the i18n module yet). Not verifiable here: the `nl` data of the distroless image's Node (not needed in Phase A), browsers other than the preinstalled Chromium.

Re-run recipe:

```text
pnpm --filter @m365portal/shared exec vitest run test/i18n.test.ts test/i18n.types.test.ts test/i18n-fragments.test.ts test/i18n-catalogue.test.ts
pnpm i18n:merge && pnpm i18n:check
```

## 8. Open points and decisions for the orchestrator

The full list with owners is `chunk-s4a.md` (s4a-1 to s4a-8). The ones to act on:

1. **s4a-1 (S4, `T-A-163`)**: `single-implementation.test.ts` treats a function named with the word `locale` outside `packages/shared/src` as a second locale normaliser. `lib/locale.ts` must name its functions otherwise (`readLanguageChoice`, `applyLanguage`) or use hooks, or the owner adds an exemption. Use `isLocale` and `detectLocale` from shared.
2. **s4a-2 (everyone)**: edit a fragment, run `pnpm i18n:merge`, commit the generated files with it. On a conflict in `locales/*.json`: regenerate.
3. **VERSION** is needed at commit time (protected paths `packages/shared/**` changed); not touched here.
4. **s4a-8**: `"sideEffects": false` in `packages/shared/package.json` (S0's file) if `pnpm bundle:check` shows the catalogues in a chunk that needs only `detectLocale`.
5. **Tasks file**: T-A-160 lists `T-A-002` under Needs only; the work also relies on `T-A-022` for the shape of the `problem` fragments (T-A-161 already says so).

## 9. Risks

R-1 to R-5 of `chunk-s4a.md`: the blind spots of the check, the Japanese case, ICU data, import attributes, generated-file conflicts. One more here: **the type-derived key union grows with the catalogue.** TypeScript computes `MessageKey` from a JSON module; at a few thousand keys the cost is noticeable in the editor. Phase A is expected to stay in the low hundreds; this is an estimate, not a measurement.
