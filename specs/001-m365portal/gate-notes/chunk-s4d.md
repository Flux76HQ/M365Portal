# Chunk s4d: open points, assumptions and risks (S4 PWA: T-A-171, T-A-172)

Status: **two tasks done** (`T-A-171`, `T-A-172`). No gate in this range (G4 is `T-A-174`). S8 consolidates the open points (`T-A-278`).

## 1. What was run

| Item | Result |
|---|---|
| New tests | 237 in 4 files: `sw-routing` 156, `sw-lifecycle` 47, `sw-register` 23, `sw-register-ui` 11 (extra file, TA-08). `build-output.test.ts` got 6 tests (worker and offline page in the real build) and one assertion narrowed (`offline.css` is the one css file besides the inlined one) |
| Red first | every file failed for the missing module (`../src/sw/routing`, `../src/sw/sw`, `../src/lib/sw-register`, `.../shell/OfflineState`) |
| Mutation pass | 10 one-edit mutants of `sw.ts` and `routing.ts` (status check, redirected, opaque type, content-type list, Range pass, cache-family filter, SKIP_WAITING check, API check, origin check, `%` check): 9 killed. The `%` mutant survives on purpose: the cache patterns exclude `%` anyway, the extra check is defence in depth |
| Guard with negative fixture | `queuesWrites` (no background sync, indexedDB, stored non-GET in `sw/` and `sw-register.ts`), two bad sources through `expectGuardFails` |
| Package gates | `tsc -b` 0, `eslint --max-warnings 0 apps/web` 0 (incl. `local/no-trusted-types-policy-elsewhere`), prettier clean on my files, full web suite 710 of 710, `pnpm i18n:merge` + `i18n:check` 112 green, `routes:check` 0, `pnpm --filter @m365portal/web build` green. `single-implementation` and `repo-conventions`: nothing in `apps/web`; the 4 failures left are in `apps/server` (not mine) |
| Real browser (preinstalled Chromium 141) | the production build served by a throwaway Node server (scratchpad `s4d-proof.mjs`: html profile CSP with nonce and `require-trusted-types-for 'script'; trusted-types m365portal-sw`, worker profile on `/sw.js`, COOP/COEP/CORP). 18 checks pass, **0 `securitypolicyviolation`** across first load, reload, offline page, update and E-21; `crossOriginIsolated` true; page controlled after the first load (claim). Negative (`s4d-negative.mjs`): plain `register('/sw.js')` throws "requires 'TrustedScriptURL' assignment" and fires 2 violations, a second policy name is refused, the named policy registers |
| Flows proven in the browser | offline files precached (3); hashed assets stored after reload and only those; no HTML, no `/api` in any cache (GET and POST to `/api`, `/%61pi`); server stopped: navigation shows the Dutch and English offline page at the app URL, cached asset still loads, `/api` fails (not cached), retry button reloads; new deploy: new worker waits, toast "Update available", accept gives exactly one reload, older caches deleted; boot `me.version` newer than the bundle raises the toast, accept reloads |

## 2. Interfaces

- `/sw.js` is built by `build/plugins/sw.ts` (esbuild, iife, `__APP_VERSION__` from the VERSION file, emitted unhashed in `generateBundle`, so `precompress` writes its `.br` and `.gz`). Public files `offline.{html,css,js}` are copied by Vite. The server (T-A-043) already serves these four paths.
- `sw/contract.ts`: `SERVICE_WORKER_PATH`, `SKIP_WAITING_MESSAGE` (shared by page and worker). `sw/routing.ts`: `decideRoute({url, mode, method}, origin)`, `OFFLINE_ASSETS`. `sw/sw.ts`: `createServiceWorker(scope, version)`, installs itself only inside a worker.
- `lib/sw-register.ts`: `createServiceWorkerClient(env)`, `getServiceWorkerClient()`, `registerServiceWorkerWhenLoaded()` (not in dev, after `load`). Client: `register()`, `updateWaiting` (get/subscribe), `acceptUpdate()`, `checkForUpdate()`.
- `components/shell/UpdateToast.tsx` (toast without timer, action calls `acceptUpdate`; also calls `checkForUpdate` when `api.updateAvailable`), `OfflineState.tsx`: `useOfflineSave(error)` returns `{ offline, saveDisabled, describedBy, tryAgain }`, `OfflineState({ save?, error?, onRetry? })`, `OFFLINE_STATE_ID`. **S5 and the page tasks: put `disabled={save.saveDisabled}` and `aria-describedby={save.describedBy}` on every save, apply and import button, pass `mutation.error ?? query.error` and render `<OfflineState save={save} onRetry=... />` once per page.** Only `NetworkError` counts; the failure is forgotten on the browser's `online` event and on "Try again", so a disabled button never stays stuck.
- Fragment `pwa.{en,nl}.json` (8 keys), merged.

## 3. Deviations from the Files lines

| File | Why |
|---|---|
| `apps/web/src/main.tsx` (one import, one call) and `components/pages/root-providers.tsx` (`<UpdateToast />` inside `AppToastProvider`) | wiring. T-A-172 lists `Needs: T-A-167` (AppShell) as the mount point, but T-A-167 was not done and cannot import components that did not exist yet. The toast sits in the router's `Wrap`, so it works on every page; **T-A-167 may move it into `AppShell`** (then drop it from `root-providers.tsx`) |
| `apps/web/vite.config.ts` | one plugin entry (`serviceWorker({ version })`) |
| `sw/contract.ts`, `test/sw-register-ui.test.tsx` | the constants are shared by page and worker; the UI pieces needed a test (TA-08) |
| `test/build-output.test.ts` | worker and offline page in the build; one existing assertion allows `offline.css` |
| `packages/shared/src/i18n/locales/{en,nl}.json` | regenerated by `pnpm i18n:merge` |

## 4. Decisions and assumptions

| # | Decision |
|---|---|
| A-1 | The routing decision takes the origin as a second argument (`decideRoute(request, origin)`): "cross-origin gives pass" needs it. A path with a `%` is never cache-first (the server serves plain names only); the API check decodes up to 5 rounds, folds `\`, `//`, dot segments, case and trailing dots. A navigation to `/api...` or `/sw.js` is `pass` |
| A-2 | `/offline.css` and `/offline.js` are `cache-first` and answered from the install-time precache (found in the browser run: without this the offline page lost its stylesheet and script when the server was gone). They are never stored in the static cache |
| A-3 | `clients.claim()` on activate, so the first visit is controlled without a reload and offline works at once. The reload after an update happens only after the person accepted (a `controllerchange` before that does nothing) |
| A-4 | A navigation answers `503` with an empty body when the network is down and the offline page is not in the cache (cannot happen after a successful install) |
| A-5 | Accepting with no waiting worker (the server is newer, the new worker has not installed yet) reloads at once; the next load installs the new worker, which then waits and raises the toast once more. Harmless, one redundant prompt; avoidable by waiting for `installed` after `checkForUpdate()` if the owner wants |
| A-6 | **The offline page does not pick the browser's language** (plan 9.8 said `offline.js` reads `navigator.languages`). `single-implementation.test.ts` flags that read (`language-reader`, FR-A-008) and its `EXEMPTIONS` list is empty and owned by S0. Both languages are side by side, Dutch first, so nothing is lost; the script only wires the retry buttons. If the owner wants the preference, one `EXEMPTIONS` entry (`apps/web/public/offline.js`, tell-tale `language-reader`, reason: static file cannot import `detectLocale`, plan PD-17) and ten lines in `offline.js` and `offline.css` bring it back |
| A-7 | `updateViaCache: 'none'` and `scope: '/'` on registration. A refused registration is silent (`register()` resolves false) |

## Open points

| # | Point | Owner | When |
|---|---|---|---|
| OP-1 | `e2e/pwa.spec.ts` and `e2e/offline.spec.ts` (S9) are the CI proof; the throwaway scripts here are not in the repository. Per V-16 the offline spec stops the server, `setOffline` does not reach the worker | S9 | T-A-325 and on |
| OP-2 | Mount point of `UpdateToast` (see section 3) and of `OfflineState` (no page has a save button yet) | S4 / S5 | T-A-167, T-A-169, S5 |
| OP-3 | `sw.js` is 2.6 kB raw; the server's worker profile (`default-src 'none'; connect-src 'self'`) was enough for install, fetch and the offline fallback in Chromium 141 (V-04 confirmed). Other browsers UNVERIFIED | S8 | `docs/open-points.md` |
| OP-4 | A-6 above: exemption or accept | owner / S0 | any time |

## Risks

| # | Risk |
|---|---|
| R-1 | `offline.html` is served `no-cache` by the server but cached for offline use per version; a change to the offline page without a version bump keeps the old copy until the next release (the worker bytes do not change either, since the page files are not in `sw.js`) |
| R-2 | Cache-first for `/assets/<name>` assumes content-hashed names. A non-hashed file added under `/assets` would be pinned for the lifetime of the version |
