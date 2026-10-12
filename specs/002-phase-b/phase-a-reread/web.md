# Phase A re-read: web code as built (`T-B-290`)

**Date**: 2026-10-12 | **Read**: `apps/web/src`, `apps/web/test`, `apps/web/build`, `apps/web/index.html`, `packages/shared/src/{i18n,routes.ts,schemas/meta.ts}`, `packages/shared/scripts/i18n-merge.ts`, `e2e/routes.ts` of the tree at `dbfa73f` (Phase A merged, Phase B server and shared work of S-B1 to S-B5 on top) | **Against**: spec 13.1 (web rows), seams XB24 to XB29, plan 12 and 15, `server-shared.md` section 3.4 | **Author**: the S-B6 worker of `T-B-290`.

## 0. Verdict

**PROCEED. The stop rule (PBR-03) did not trigger** for the shell and the API-client contracts: the router context, `lib/api` (`createApiClient`, `ApiError`), the shell (`AppShell`, `Header`), `lib/commands` (`COMMANDS`, `visibleCommands`) and `lib/gating` (`requirePermission`, `gatedPage`) exist as the plan assumes. Nothing moved that makes a Phase B contract unsatisfiable. Eleven things differ from the plan in a way that changes a file, a helper or a lint rule; they are in section 4 and have been applied by this task and `T-B-291` to `T-B-299` (the divergences that touch the tasks after `T-B-299` are marked **for T-B-300+**).

What the orchestrator must know:

1. **The whole Phase A web suite was red at the start** (219 of 1,152 tests, 15 of 47 files): `MeResponseSchema` changed in `a8ee7c5` (XB7) and `test/helpers/boot-fixtures.ts` (`sampleMe`) still built the Phase A shape. `T-B-295` says "boot-fixtures first"; done (section 4, D1). All of the suite is green again (1,601 tests in 55 files at the end of `T-B-299`).
2. **`e2e/routes.ts` is compared with the router's route tree by a web unit test** (`test/routes-coverage.test.ts`). A new client route therefore turns that web test red until `e2e/routes.ts` lists it. `/signin` was added there by this stream (one line, a cross-territory edit of an `XB33` file; S-B7 `T-B-381` owns the file afterwards). Every later route (`/setup`, `/break-glass`, `/settings/connection`, `/settings/access`, `/settings/restore-access`) needs the same line in the same commit.
3. **The entry bundle is over the Phase A budget** (section 5): initial JS 253,802 B gzip against 237,500 B, entry CSS 45,579 B against 45,500 B. The Phase B budget is `T-B-354`; the numbers and the options are in section 5.

## 1. Seams XB24 to XB29

"File" = the named file exists; "Symbol" = the thing the edit changes or extends exists; "Fits" = the planned edit could be made as written.

| Seam | File | Symbol | Fits | Same or differs | Note |
|---|---|---|---|---|---|
| XB24 `i18n/index.ts`, `scripts/i18n-merge.ts`, `test/{i18n,i18n-fragments,i18n-catalogue}.test.ts` | yes | `createTranslator`, `detectLocale`, `NAMESPACE_OWNERS` (closed list, values `S1`/`S4`/`S5`), `mergeFragments`, `staleProblems` | yes | Differs (files) | Three more files had to change, none of them a contract: `create-translator.ts` (the bundled catalogues became live objects, in the new `catalogues.ts`), `types.ts` (the lazy key types) and `test/i18n.types.test.ts` (the key union test). New: `load-namespace.ts`, `detail-codes.ts`. The three small label namespaces `qualifier`, `resource`, `origin` are fragments of their own (a key must start with the name of its fragment; `rbac/labels.ts` produces `qualifier.*`, `resource.*` and `origin.*`). The namespace `banner` (Phase A S4, only the preview banner) was removed. |
| XB25 `routes/{__root,no-access,settings}.tsx`, `routeTree.gen.ts` | yes | root `beforeLoad: loadMe`, `component: AppShell`, `notFoundComponent`; `/no-access` rendered `components/pages/NoAccess`; `/settings` layout `requirePermission(['settings:branding','settings:connection'])` | yes | Same | `/no-access` now renders the public variant (`NoAccessReason`); the in-place No-access content (`components/pages/NoAccess`) is unchanged and still what a gated page shows. `settings.tsx` is edited by `T-B-306`. |
| XB26 `components/shell/*`, `test/{shell,gating,nav-gating,error-boundary}.test.tsx` | yes | `AppShell`, `Header` (`useActorName` read `me.actor.kind === 'preview'`), `PreviewBanner` | yes | Differs (files) | Also changed: `AppShell` root component split into `RootLayout` (public pages get `BareLayout`) and the application frame; new `BareLayout.tsx`, `main-id.ts`; `components/ui/banner.tsx` (rest props, doc text); the static shell (`index.html`, `boot/static-shell.ts`, `build/plugins/static-shell.ts`, SB-39) and `test/{static-shell,build-output}.test.ts`. |
| XB27 `lib/{api,commands,storage}.ts`, `boot/*`, `test/{api,boot}*.test.ts` | yes | `createApiClient`, `COMMANDS` (`anyOf`, `feature`), `STORAGE_KEYS`, stage modules, `readBootData` | yes | Differs (files) | `main.tsx` calls the re-check (one line plus a comment); `lib/locale.ts` (`chooseLanguage`, the controller, `loadLazyNamespace`) and the new `lib/{auth-nav,ms-url,search}.ts` carry the rest. `lib/commands.ts` and `lib/storage.ts` are untouched until `T-B-306`; `Command` has no `actorKinds` field yet (needed by restore-access). |
| XB28 `sw/routing.ts`, `test/sw-routing.test.ts` | yes | `decideRoute`, `looksLikeApi`, `ASSET_PATH`, `BRANDING_PATH` | yes | Same | `looksLikeAuth` added next to `looksLikeApi`; `sw-lifecycle.test.ts` gained a Phase B block. `sw.ts` is unchanged: `networkFirst` never stores. |
| XB29 `packages/shared/src/routes.ts` | yes | `ROUTES`, `CLIENT_PATHS` | yes | Differs | **Not conditional**: the file lists the client paths, and `test/pages.test.tsx` requires a route and a title for every entry. A path is added in the task that creates its route (`signin` by `T-B-297`). Also `e2e/routes.ts`, see 0.2. |

## 2. Phase A web interfaces used by Phase B

| Interface | Phase A file and symbol | Exists | Still fits | Used by |
|---|---|---|---|---|
| `DataTable` | `components/data-table/DataTable.tsx`: `DataTable<Row>`, `DataTableProps` (`search`, `status`, filters, selection), `query-state.tsx` | yes | yes | not used by tasks `T-B-290` to `T-B-299`; `T-B-304` (access page tables), Phase D |
| `ConfirmDialog` | `components/ui/confirm-dialog.tsx`: needs `objectName` (no generic "Are you sure?", FR-A-124), focus on Cancel, `pending`, `destructive` | yes | yes | `T-B-303` (repair, renew), `T-B-305` (restore owner); for the step-up and idle dialogs the plain `Dialog` is used, because they confirm no object |
| `Banner` | `components/ui/banner.tsx`: `role="status"`, tones `info`, `success`, `warning`, `danger`, no close button | yes | yes, extended | break-glass banner (`danger`), stale-groups notice and expiry notice (`warning`) |
| `Toast` | `components/ui/toast.tsx`: `useToast()`, errors are foreground toasts without a timer | yes | yes | sign-out failure (`useSignOut`) |
| `Persona` | `components/ui/persona.tsx`: round mark, `role="img"` with `label` | yes | yes | `PersonaMenu` wraps it in the menu button |
| `Menu` | `components/ui/menu.tsx`: Radix dropdown, items by `id`, `onSelect(id)` | yes | yes | `PersonaMenu` |
| `Dialog` | `components/ui/dialog.tsx`: `useFocusReturn`, `initialFocus` selector, footer | yes | yes | `StepUpDialog`, `IdleDialog` |
| Appearance form | `features/branding/AppearanceForm.tsx`: `AppearanceForm({ branding, tools, api })`, loaded with `loadBrandingTools()`; the page is `routes/settings.appearance.tsx` | yes | yes | `T-B-302` (finish step loads it lazily, skippable) |
| `lib/api` | `createApiClient`, `ApiError`, `NetworkError`, `shouldRetry`, `getApiClient`; CSRF refetch-and-retry | yes | yes, extended | all. New option `auth: AuthEffects`; `getApiClient()` wires the page's effects |
| `lib/storage` | `STORAGE_KEYS`, `createStorage`, `getAppStorage` | yes | yes | language choice (`STORAGE_KEYS.locale`) |
| Command registry | `lib/commands.ts`: `COMMANDS`, `visibleCommands(me)`, `navigationCommands(me)`, `Command.anyOf`, `Command.feature` | yes | needs `actorKinds` | `T-B-306` |
| i18n module | `@m365portal/shared/i18n`: `createTranslator`, `detectLocale`, `MessageKey` derived from `locales/en.json` | yes | yes, extended | `loadNamespace`, `loadRequestedNamespaces`, `missingNamespaces`, `LAZY_NAMESPACES`; `MessageKey` now includes the keys of the four lazy files |
| Service-worker routing | `sw/routing.ts` `decideRoute(request, origin)` | yes | yes, extended | `/auth` is `pass` |
| Boot data reader | `lib/boot-data.ts` `readBootData(doc)`: `{me, branding}` or `null` for anything malformed | yes | yes | `boot/recheck.ts` reads `null` as "no boot data" and asks once |
| Router context | `lib/router-context.ts` `RouterContext {queryClient, api}`, `useMe`, `useBranding`, `staticData.titleKey: MessageKey` | yes | yes | all |
| Gating | `lib/gating.ts` `loadMe`, `requirePermission`, `gatedPage`, `accessOf` | yes | yes, extended | `isPublicPath`, `requireSignIn` (root gate) |
| `StatusPage`, `OrgMark` | `components/pages/StatusPage.tsx`, `components/shell/OrgMark.tsx` (`OrgMarkView`, `OrgMark`) | yes | yes | `PublicPage` uses `OrgMark` |

## 3. The preview inventory (command run, result)

Command: `rg -n "features\.preview|PreviewBanner|preview-banner|banner\.preview|shell\.actor\.preview|kind: 'preview'|PREVIEW|previewMode|'preview'|preview: " apps/web packages/shared/src e2e --glob '!node_modules' --glob '!dist' --glob '!*.gen.ts'` (the Appearance live preview, namespace `preview`, `LivePreview`, is not the preview mode and stays).

| Phase A web file | What it held | Task and result |
|---|---|---|
| `src/components/shell/PreviewBanner.tsx`, `AppShell.tsx`, `Header.tsx` | the banner, its mount, `shell.actor.preview` | `T-B-298`: component deleted; mount replaced by the break-glass banner, the stale-groups notice and the session timers; the header's persona is `PersonaMenu` |
| `index.html`, `build/plugins/static-shell.ts`, `src/boot/static-shell.ts` | banner markup with `{{en:banner.preview.title}}`, and the script that switched it on from `me.features.preview` | `T-B-298`: markup and script removed (SB-39); the shell holds no catalogue token now, the generic language switch of the script stays |
| `test/helpers/boot-fixtures.ts` (`sampleMe({ preview })`) | the fixture every web test builds `me` with | `T-B-295`: new options (`kind`, `session`, `setupState`, `breakGlass`, `adminConsentUrl`), `sampleSignedInMe()` for "a user with every permission"; permissions imply `kind: 'user'` |
| `test/{pages,nav-gating,boot-data,dashboard,showcase,command-palette,gating,placeholders,shell}.test.tsx` | `sampleMe({ preview: true })` as "the actor with every permission" | `sampleSignedInMe()`; tests that relied on an anonymous actor inside the shell use a signed-in user without permissions (`pages.test.tsx`: `person()`), because the root gate now sends an anonymous visitor to `/signin` |
| `test/{static-shell,build-output}.test.ts`, `test/shell.test.tsx` | banner cases | rewritten as the absence of the banner (FR-B-102); `shell.test.tsx` keeps two literal mentions on purpose (`banner.preview.title` and `shell.actor.preview` must not translate) |
| `packages/shared/src/i18n/fragments/banner.{en,nl}.json`, `shell.*.json` (`shell.actor.preview`), merged `locales/*.json` | `banner.preview.*`, `shell.actor.preview` | `T-B-298`: the `banner` fragments and the namespace are removed, the key `shell.actor.preview` is gone |
| `e2e/**` (7 files) | instance names `preview`/`anonymous`, `PREVIEW_MODE`, `tests/preview-banner.spec.ts`, `nav-gating.spec.ts` | not this stream (`T-B-370`, `T-B-371`, `T-B-376`); listed so that they are not lost |

After this task the search finds `apps/web/test/shell.test.tsx` (the two deliberate mentions) and the `e2e/**` files above, and nothing in `apps/web/src` or `packages/shared/src`.

## 4. Divergences that change a file, a helper or a rule

| # | Phase A fact | Effect on Phase B | Applied |
|---|---|---|---|
| D1 | The web fixtures built the Phase A `MeResponse` (`features.preview`, no `roles`, `session`, `setup`, `adminConsentUrl`) | every web test failed | `boot-fixtures.ts` rewritten (`T-B-295`) |
| D2 | `Header` named the actor by kind (`preview` or `anonymous`) and used `Persona` directly | the persona menu needs the display name and a menu | `PersonaMenu` + `useActorName` (`T-B-298`) |
| D3 | `__root.tsx` had no sign-in gate; `requirePermission` shows No-access to anybody without the permission, anonymous included | FR-B-607 wants `/signin?returnTo=` for an anonymous visitor | the gate is the root route's (`requireSignIn`, `isPublicPath`), not `requirePermission`: its existing tests build `sampleMe({ permissions })` and expect `denied` |
| D4 | `AppShell` was the only layout | the public pages (sign-in, no-access, setup, break-glass) have no sidebar | `RootLayout` + `BareLayout` |
| D5 | the TanStack search parser turns `?signedout=1` into a number | `?signedout=1`, `?ref=12345678` | `lib/search.ts` `stringSearchParam`; the route validators ask for text |
| D6 | `queryClient.fetchQuery` | deprecated; lint fails | use `queryClient.query(options)` (already what `loadMe` does) **for T-B-300+** |
| D7 | lint rule `react-hooks/set-state-in-effect` is on | a countdown or a poll that calls `setState` in an effect fails lint | read the clock with `useSyncExternalStore` (`use-seconds-left.ts`, `SessionTimers.tsx`); **for T-B-300+** (polling, countdowns) |
| D8 | lint rule `@typescript-eslint/only-throw-error` is on | `throw redirect(...)` fails | `redirect({ ..., throw: true })` **for T-B-300+** |
| D9 | Phase A pages put a `<header>` inside `main` (`PageHeader`) | `getByRole('banner')` finds two in the real route tree | tests ask for `[data-slot="header"]` |
| D10 | `userEvent` hangs under `vi.useFakeTimers()` | session and polling tests | those tests use `fireEvent` and advance the clock by hand (`session-timeout.test.tsx`) **for T-B-300+** (`setup-log.test.tsx`) |
| D11 | `routes-coverage.test.ts` reads `e2e/routes.ts` | see 0.2 | `/signin` added; **for T-B-300+** every new route |

Not divergences, but checked: `components/ui/toast.tsx` needs `ToastProvider` (it is inside the router's `Wrap`, so anything below `RouterProvider` may call `useToast`); the router context has no place for the location, so the session UI gets its store and location from `AuthRuntimeProvider` (default: the page's); `lib/boot-data.ts` already returns `null` for a malformed block, so "falls back to anonymous" means "no boot data, ask once" (`recheckBootSession`).

## 5. Service-worker precache and the lazy files; the budget

**Does the precache pick up lazily loaded JSON?** The worker precaches only the three offline files at install (`OFFLINE_FILES`). Hashed build output under `/assets/` is cached on first use (`cache-first`, `ASSET_PATH`). Vite turns `import('./locales/lazy/setup.en.json')` into a JavaScript chunk `/assets/<name>-<hash>.js`, which matches `ASSET_PATH` and is stored when it is first fetched with a 200 of type `text/javascript`. So a lazy namespace works offline only after it was used once online; the wizard and the connection page need the server anyway.

**Budget (`pnpm bundle:check` on a real `pnpm build`)**: initial JS 253,802 B gzip (Phase A budget 237,500, Phase B allowance of plan 15 is +8 KiB = 245,692), entry CSS 45,579 B raw (budget 45,500), first load Brotli 281,386 B (budget 269,000). Of the +16.3 KiB, the entry catalogues are about +6.1 KiB gzip (signin 3.4, session 1.6, noaccess 0.7, the label namespaces 0.4 of that for the pair of languages) and the `problem` fragment of S-B1 about +2.4 KiB; the rest is code and shared schemas (`schemas/meta.ts` now imports `schemas/rbac.ts`, the sign-in and session UI). Options for `T-B-307`, cheapest first: load `signin` through the route loader (3.4 KiB, one more round trip on the first page of a signed-out visitor: Lighthouse risk PBR-07), move `role`, `permission`, `scope`, `qualifier`, `resource`, `origin` next to `access` (they are only used by "Mijn toegang" and the finish page), move the `showcase` namespace (5.4 KiB, Phase A) out of the entry. This task changes none of it: the plan puts the decision in `T-B-307`.

## 6. Lines of other documents that need the same change (not edited by this task)

| Where | Text | Change |
|---|---|---|
| `tasks.md` `T-B-297` | "`/no-access` ... (XB25)" | `/no-access` renders the public variant for every actor; the in-place content stays in `components/pages/NoAccess` |
| `tasks.md` `T-B-298` Files | `apps/web/src/components/shell/*` | also `index.html`, `boot/static-shell.ts`, `build/plugins/static-shell.ts` (SB-39), the five Phase A web tests of `server-shared.md` 3.4, `components/ui/banner.tsx` |
| `tasks.md` `T-B-291` Files | the three tests and `i18n-merge.ts` | also `create-translator.ts`, `types.ts`, `index.ts`, `test/i18n.types.test.ts`, and the new `catalogues.ts`, `load-namespace.ts`, `detail-codes.ts` |
| `tasks.md` `T-B-293` | six namespaces | nine: `qualifier`, `resource`, `origin` are fragments of their own |
| `tasks.md` `T-B-297`, `T-B-306`+ | `e2e/routes.ts` not mentioned | each new route is added to `e2e/routes.ts` in the same commit (D11) |
| plan 12.6 | "Ten new namespaces" | thirteen fragments pairs (ten + `qualifier`, `resource`, `origin`); `banner` removed |
| plan 12.2 | the re-check "shows the shell skeleton" | the static shell of `index.html` is on screen while `main.tsx` waits (`boot/recheck.ts`) |
