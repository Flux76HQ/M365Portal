# Chunk s4b: open points, assumptions and risks (S4 web foundation: T-A-163 to T-A-166)

Status: **four tasks done** (`T-A-163`, `T-A-164`, `T-A-165`, `T-A-166`). No gate in this range (G4 is `T-A-174`). S8 consolidates the open points into `docs/open-points.md` (`T-A-278`).

## 1. What was run

| Item | Result |
|---|---|
| New tests | 188 in 9 files: `storage` 21, `theme` 17, `locale-detection` 12, `boot-script` 13, `build-output` 25, `api` 49, `problem` 15, `boot-data` 17 (extra file, see 4), `gating` 19. `router.test.tsx` (1, scaffold) was adapted |
| Red first | every test file failed for the missing module (`Failed to resolve import "../src/lib/storage"`, `.../boot/boot-script`, `../build/plugins/nonce-inline`, `../src/lib/api`, `.../root-providers`). `boot-script` was first seen red by removing the module again after it had been written |
| Mutation pass | 26 one-edit mutants: 24 of `api.ts`, `problem.ts`, `gating.ts`, `root-providers.tsx`, `router.ts`, `query.ts`, `zod-config.ts`, `nonce-shim.ts`, `boot-data.ts`, plus `fontPreload()` and `precompress()` removed from the build; 25 killed at once. One survived the first pass (the shared refresh of a stale CSRF token) and got a test (`refreshes the token once when several writes find it stale together`) |
| Guards with a negative fixture (`expectGuardFails`) | storage keys only in `lib/storage.ts`; only `lib/api.ts` calls the network (five bad sources); lazy routes are chunks of their own (two bad manifests) |
| Package gates (live tree and a clean copy of `git ls-files -co --exclude-standard`, `pnpm install --frozen-lockfile`) | `tsc -b` 0, `eslint --max-warnings 0 apps/web` 0 (incl. `local/no-direct-storage`, `local/no-trusted-types-policy-elsewhere`), `prettier --check apps/web` clean, `pnpm --filter @m365portal/web build` green, `pnpm routes:check` 0, `pnpm i18n:merge` + `i18n:check` 112 green, `tools/workspace-deps` 31 green. Web suite in the clean copy: 405 of 406; the one failure is `test/styles.test.ts` "uses the family names the tokens put into the font stack", S3's file: `pnpm tokens:check` reports `tokens.generated.css` stale (first difference at line 20), so someone changed `packages/shared/src/tokens` without running `pnpm tokens:generate`. Not touched |
| Single-implementation guard | 4 failures, all in `apps/server` (`branding/pipeline/svg/values.ts`, `job-protocol.ts` `replyLuminance`, `routes/meta.ts` `permissions`): none in `apps/web` |
| Real browser (preinstalled Chromium 141) | the production build, served by a throwaway Node script that fills the six placeholders per request in one regex pass and sends the plan 8.1 html CSP (`script-src 'nonce-..'`, `style-src 'self' 'nonce-..'`, `require-trusted-types-for 'script'`, `trusted-types m365portal-sw`): **0 `securitypolicyviolation`, 0 console errors or warnings, 0 page errors**; the page makes no `/api` request (the boot data seeds Query); theme and `lang` right before first paint in five cases (light, system dark, stored light + stored nl, `nl-BE`, `de-DE`); `__webpack_nonce__` set; the Latin Inter file is the first asset requested. Scripts: scratchpad `s4b-*` (not in the repository) |

## 2. Tasks and evidence

| Task | Verdict | Evidence |
|---|---|---|
| `T-A-163` storage, theme, locale | done | `lib/storage.ts` (`STORAGE_KEYS`, `columnsKey`, `createStorage`, `getBrowserStorage`, `getAppStorage`): throwing backend on any of `getItem`, `setItem`, `removeItem`, a property getter that throws, a full quota, no storage at all: nothing throws, the value stays in memory, `persistent` is false. `lib/theme.ts` (controller with injected storage, `matchMedia`, root; live system change; `data-theme` and `color-scheme`; `useTheme`). `lib/locale.ts` (stored choice wins, else `detectLocale`; `<html lang>`; `createLanguageController`, `LanguageProvider`, `useLanguage`, `useTranslator`). `no-direct-storage` is green over the whole web package |
| `T-A-164` build pipeline | done | `index.html` is the C8 template; `build/plugins/nonce-inline.ts` (inline entry CSS as `<style nonce>`, esbuild-compiled boot script, development defaults), `font-preload.ts`, `precompress.ts` (Brotli quality 11 and gzip level 9 for js, css, svg, json, html; decompression proven byte-identical); `src/boot/boot-script.ts` (pure function; the compiled script is 1,320 bytes minified and bundles only `boot-script.ts`, `lib/storage.ts`, `i18n/detect.ts`, `i18n/types.ts`). `html.cspNonce: '__M365_NONCE__'` kept. `<noscript>` in nl and en. `assetsInlineLimit: 0` (no `data:` URI, plan 8.1) |
| `T-A-165` API client, boot data, query | done | `lib/api.ts`, `lib/problem.ts`, `lib/boot-data.ts`, `lib/query.ts`, `boot/nonce-shim.ts`, `boot/zod-config.ts`; deps `@tanstack/react-query@5.104.1` and `zod@4.6.5` (install protocol) |
| `T-A-166` providers, router, gating | done | `components/pages/root-providers.tsx`, `router.ts`, `lib/gating.ts`, `lib/router-context.ts`, `main.tsx` (imports `./styles/app.css`), the scaffold `styles.css` removed |

## 3. Interfaces the next chunks use (T-A-167 and on)

- **Storage**: `getAppStorage()`; keys `STORAGE_KEYS.sidebar`, `.shortcuts`, `columnsKey(tableId)` (DataTable's `columnStorage` interface of C12 is wired to `AppStorage.read/write`).
- **Theme and language**: `useTheme()` gives `{ choice, resolved, setChoice }`, `useLanguage()` gives `{ language, translator, setLanguage }`, `useTranslator()` gives `{ t, n, d, locale }`. The language switcher sets `setLanguage('nl' | 'en')`, the theme switcher `setChoice('light' | 'dark' | 'system')`.
- **Router context** (`lib/router-context.ts`): `RouterContext = { queryClient, api }`; hooks `useMe()` (suspense, always present because the root route loads it) and `useBranding()`; `staticData.titleKey: MessageKey` is declared for every route (other `staticData` members, breadcrumb label and parent, are declared by T-A-167 as further members of `StaticDataRouteOption`).
- **T-A-169 must**: change `routes/__root.tsx` to `createRootRouteWithContext<RouterContext>()({ beforeLoad: ({ context }) => loadMe(context), component: ... })`; gate a route with `beforeLoad: requirePermission(['users:read'])` and `component: gatedPage(Page, NoAccess)`; give each route `staticData: { titleKey: ... }`. The verdict `access` is merged into the route context, so a child inherits its parent's verdict unless it has a gate of its own. `hasAccess(me, anyOf)` is the same check for a component.
- **API**: `getApiClient()`; `api.get/post/put/delete(path, { body, headers, query, signal, schema })` and `api.request(...)` (returns `{ data, status, headers }`: the ETag of the branding is `headers.get('ETag')`, though `branding.revision` carries the same number). Uploads pass a `FormData` body. `ApiError { code, status, requestId, errors, expectedOrigin, retryAfterSeconds }`, `NetworkError`. `api.updateAvailable.get()/subscribe()` is the signal `UpdateToast` (T-A-172) shows.
- **Messages**: `translateProblemCode(translator, code, params)` (also exported as `problemMessage`, which returns `{ key, params }`), and `messageForError(translator, error, { publicOrigin })` for any error. `shouldRetry` is Query's default.
- **Test helpers**: `test/helpers/boot-fixtures.ts` (`sampleMe`, `sampleBranding`, `installBootBlock`, `installNonceMeta`, `escapeForScript`) builds `me` and `branding` from the real producers; reuse it.
- **Fragments**: `common.{en,nl}.json` exists with `common.close`, `common.notification`, `common.notifications` (`{hotkey}`) for the toast region. T-A-169 owns the rest of `common`: read the file and add keys, do not overwrite it. `pnpm i18n:merge` after every fragment edit.
- **Build**: `vite build` output has the six C8 placeholders (the nonce on every tag, the other five once); `__APP_VERSION__` is defined from the root `VERSION` file for the app (T-A-171 reuses the same value for the worker).

## 4. Deviations from the Files lines

| File | Why |
|---|---|
| `apps/web/tsconfig.app.json`, `tsconfig.node.json` | `build/plugins/*.ts` must be inside a project for the typed lint and `tsc -b`; the tests import them, so the app project needs Node types (closes OP-9 of `chunk-s3b.md`) and both projects `allowImportingTsExtensions` (Vite's config loader wants explicit extensions in the files it loads) |
| `apps/web/src/main.tsx` import of `./styles/app.css` | done in `T-A-164`, not `T-A-166`: the build test needs the real stylesheet (fonts, tokens) to prove the inlined CSS and the font preload. `T-A-166` finished `main.tsx` and removed `styles.css` |
| `apps/web/test/router.test.tsx` | the scaffold test rendered `RouterProvider` alone; the router now has a toast `Wrap` and a title `InnerWrap` that need the Query and language providers, so it mounts `RootProviders` like the app does. Same assertion |
| `apps/web/test/boot-data.test.ts`, `test/helpers/boot-fixtures.ts` | boot data reader, nonce shim, Zod configuration, query client and seeding have no test in the `Files` line of `T-A-165` and the "Done when" asks for proof of each. Additional controls (TA-08) for `T-A-001` to list |
| `packages/shared/src/i18n/fragments/common.{en,nl}.json` and the regenerated `locales/*.json` | the toast labels must come from the catalogue (C12) and no task before `T-A-169` writes `common` |
| `apps/web/package.json`, lockfile, catalog | `esbuild@0.28.2` (devDependency: compiles the boot script; `T-A-171` compiles the worker with it), `@tanstack/react-query@5.104.1`, `zod@4.6.5`. `pnpm add` drops the comments of `pnpm-workspace.yaml`; they were put back under the same lock (the catalog also carries other streams' pins, which were left as they were) |

## 5. Decisions and assumptions

| # | Decision |
|---|---|
| A-1 | **`__M365_BOOT_JSON__` stands for the JSON text only.** The template owns the element: `<script type="application/json" id="m365-boot" nonce="__M365_NONCE__">__M365_BOOT_JSON__</script>`. Likewise `__M365_THEME_CSS__` is the CSS text inside `<style nonce="__M365_NONCE__">`, `__M365_TITLE__` the escaped text inside `<title>`, `__M365_THEME_COLOR__` the value of `content=` in `<meta name="theme-color">`, and `__M365_ICON_LINKS__` raw `<link>` tags. C8 reads either way for the boot block; **S2 (`T-A-091`) must fill it the same way** or the page gets two script elements |
| A-2 | The template has `<link rel="manifest" href="/manifest.webmanifest">` itself (it is served in degraded mode too), so `__M365_ICON_LINKS__` carries only the icons |
| A-3 | "Each placeholder of C8 appears exactly once" is read as: the five value placeholders once, the nonce on every script, style, stylesheet and preload tag (it cannot be once, it must be on all of them) |
| A-4 | Vite reads every `<style>` of `index.html` as CSS and chokes on `__M365_THEME_CSS__`; the plugin sets that one element aside as a comment before Vite looks and puts it back after (two plugins, because a plugin has one `transformIndexHtml`) |
| A-5 | The service worker is out of the `fetch` scan (`src/sw/**` answers requests with `fetch(event.request)` in its own global scope). `T-A-171` keeps that folder |
| A-6 | Toasts are the Radix `ToastProvider` of S3 (PD-03, plan 5.4: sonner and its pnpm patch were dropped). **The instruction to patch sonner for the CSP nonce does not apply**: sonner is not a dependency and no patch was made; the Radix scroll lock is covered by `__webpack_nonce__` |
| A-7 | `me` and `branding` are validated with the shared Zod schemas at the boot-data boundary. Zod therefore sits in the entry chunk (it is anyway: `z.config` runs there, and `problem.ts` and `permissions.ts` of the shared package create schemas at load). Plan 9.3 wants the Zod runtime lazy; that is a measurement for `T-A-173` (the entry is 589 kB raw, 181 kB gzip today, before any shell code) |
| A-8 | A 4xx or 5xx body that is not a problem becomes the code `http_<status>`; a client-side failure is `client_error`, a missing answer `network_error`; all three go through `problem.unknown` (code and request id shown), which is what E-20 asks for. A request id the server did not give is shown as `-` |
| A-9 | `access` of a gated route is a route-context member, not a redirect: Back works and the URL stays |
| A-10 | `Wrap` (toast) and `InnerWrap` (document title) are router options, set in `baseRouterOptions`; passing them as `RouterProvider` props would make the router update itself on every render |
| A-11 | Single-implementation guard: the spec's names `problemMessage` and `requirePermission` contain the words that the look-alike rule reads as a second implementation of the problem and permission mappings. Both are defined as `selectMessage` and `requireAnyOf` and exported under the spec's names (`export { x as name }` is not read as a definition). The owner may prefer an `EXEMPTIONS` entry with a reason and the plain names |
| A-12 | `pnpm dev`: the placeholders get development values and the boot script is inlined, so the theme is right before first paint in development too. There is no embedded boot data in development, so the app fetches `me` and `branding` from the API proxy |

## Open points

| # | Point | Owner | When |
|---|---|---|---|
| OP-1 | **`schemas/meta.ts` exports no `MeResponse` type** (the schemas export their `z.infer` types elsewhere). The web app derives it in `lib/boot-data.ts`. If S1 adds `export type MeResponse` the web re-export can point at it | S1 | any time |
| OP-2 | **`tokens.generated.css` is stale** against `packages/shared/src/tokens` (`pnpm tokens:check` fails, and so does `web/styles.test.ts`, "uses the family names the tokens put into the font stack"). Found while verifying, not caused by this chunk | S3 | before G3 |
| OP-3 | **`apps/web/build` reads `../../VERSION`** (`vite.config.ts`). The Docker build stage must have `VERSION` in its context at that path (plan 12.1) | S6 | `T-A-231` |
| OP-4 | `precompress` also writes `index.html.br` and `.gz`; the server never serves `index.html` as a file (`http/static.ts` refuses it), so they are dead weight (about 16 kB). Cheap to drop in the image stage if the size budget needs it | S6 | `T-A-231` |
| OP-5 | **Entry size**: `index-*.js` is 589 kB raw, 181 kB gzip with only the scaffold page (React, Router, Query, Zod, shared schemas, the Radix Toast provider, Motion config). The Brotli first-load target is 150 KiB. The levers are in `T-A-173` (plan 14.2: lazy Zod and schemas, the Radix import by path, route chunks). Vite prints the "chunks larger than 500 kB" warning; the limit was not raised | S4 | `T-A-173` |
| OP-6 | `radix-ui` is imported as the unified package in `components/ui/toast.tsx` (S3). Check in the bundle that only the Toast part is in the entry | S3 / S4 | `T-A-173` |
| OP-7 | **`unknown` problem code and the `-` request id** (A-8): if the owner prefers a catalogue word for "no request id" a key `common.noRequestId` is one line; it is a hyphen today because a literal string in code is what FR-A-115 forbids and a catalogue key would need a third generic message variant | S4 | owner |
| OP-8 | TanStack Query 5.104 deprecates `fetchQuery` and `ensureQueryData` (lint `no-deprecated`); the code uses `queryClient.query({ ...options })` and `staleTime: 'static'`. Later chunks should too | S4, S5 | on use |
| OP-9 | `document.title` for the Not-found and error pages: those are not matches with `staticData`; `T-A-169` decides their title (the org name alone is the fallback today) | S4 | `T-A-169` |
| OP-10 | The `<noscript>` text sits in `index.html` as literal Dutch and English text (not JSX, so not a lint violation); it is not in the catalogue because no script runs to translate it. The catalogue check does not read it | S4 | recorded |

## Risks

| # | Risk |
|---|---|
| R-1 | The boot script and `STORAGE_KEYS` are one source (a bundled import), but `public/offline.js` (T-A-171) cannot import them and will carry its own copy of the key names if it needs any |
| R-2 | The inline script runs `window.localStorage` access through `getBrowserStorage()`; if a browser throws something that is not caught by `try/catch` in a way that aborts the script, the page shows the default light theme and the app corrects it on start (one flash). Not observed in Chromium 141 |
| R-3 | Vite 8 (Rolldown) `transformIndexHtml` ordering and `ctx.bundle` deletion are relied on (the inlined stylesheet is removed from the bundle in `generateBundle`); a Vite upgrade is caught by `build-output.test.ts` (no `.css` file may remain, no script may reference a missing one) |
| R-4 | The `Wrap` of the router is outside the router context: anything in `AppToastProvider` that needs router hooks must move to `InnerWrap` |
| R-5 | `vite build` is run by `build-output.test.ts` into `apps/web/node_modules/.tmp/build-output-*` (about 1.5 s, removed in `afterAll`); a killed process leaves a folder in a git-ignored place |
