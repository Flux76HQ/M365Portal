# Gate note GC2 (T-C-050): web

Verdict: **GC2 passed (local pass)** for the web package: the four pages, their routes and gating, both languages, the unit-level accessibility and no-HTML-injection checks and the bundle budget. What a unit environment cannot show (axe with real contrast and target sizes, keyboard specs in a browser, visual baselines, Lighthouse) is S-C4 (T-C-063 to T-C-065) and CI. The server (S-C2) was built at the same time; every web test runs against handlers built from the frozen wire schemas, so the web does not wait for the server (see "What the server must keep" below).

## What was run, on which state

State: branch `claude/modest-bohr-45f4kf`, HEAD `b43f713` (GC0) plus the uncommitted S-C3 working tree (the orchestrator commits) and, in the same checkout, the uncommitted working tree of S-C2 (not touched, not tested here), 2026-10-13, Node v22, pnpm 10.

| Command | Result | Time |
|---|---|---|
| `pnpm --filter @m365portal/web lint` (routes generate, eslint `--max-warnings 0` over the whole package) | green | 63 s |
| `pnpm --filter @m365portal/web typecheck` | green | 21 s |
| `pnpm --filter @m365portal/web test` | green: 74 files / 1,896 tests (11 new files with 160 tests; 5 existing files adapted, see below) | 142 s |
| `pnpm --filter @m365portal/web build` | green | 8 s |
| `pnpm bundle:check` | **within budget**: initial JS 245,640 B gzip (budget 245,692; before this stream 245,007), entry CSS 47,182 B raw (budget 47,200; unchanged), first load 277,120 B brotli (budget 277,500; before 276,390). No `approvedGrowth` added. The ratchet was skipped (no base ref) | 3 s |
| `pnpm i18n:merge`, `pnpm i18n:check` | merge wrote the lazy `users.*`, `groups.*` and the entry catalogues; check green: 2 files / 171 tests | 5 s |
| `pnpm routes:generate` twice | `routeTree.gen.ts` identical both times (deterministic) | 3 s |
| `pnpm --filter @m365portal/shared test` | 3,779 of 3,780 green; the one red is not S-C3 (see "Known interim reds") | 45 s |
| `npx prettier --check` on every file touched | green | 2 s |
| `npx eslint --max-warnings 0` on every file touched | green (part of the package lint) | |
| Not run | repo-wide `pnpm lint`, `pnpm typecheck`, `pnpm test` (another agent builds `apps/server` in the same checkout; only this package was run, as instructed), `pnpm routes:check` (its `git diff --exit-code` needs `routeTree.gen.ts` committed; the file is regenerated and deterministic), server tests, `pnpm e2e`, `pnpm lighthouse`, axe in a browser, visual baselines (never in the sandbox), CodeQL, Trivy, image | |

Bundle numbers in detail: the six route files add their options (search validation, loaders, gate) to the entry; the pages (`users.index`, `users._id`, `groups.index`, `groups._id`), the shared table, the paging code, the queries and the four catalogues (`users.en`, `users.nl`, `groups.en`, `groups.nl`) are separate chunks. Gzip of a first visit to `/users` (route chunks, not the entry): 14.6 KB; to `/groups`: 12.8 KB.

## Known interim reds (not defects of this gate)

| Test | Why | Owner |
|---|---|---|
| `packages/shared/test/single-implementation.test.ts`, "check 1": `apps/server/src/directory/scoped-list.ts:24: second definition of covers (function)` | a file of the server stream (S-C2, in progress in the same checkout) defines `covers`; the one implementation is `@m365portal/shared/rbac/covers` | S-C2 |
| `pnpm routes:check` | passes once the regenerated `apps/web/src/routeTree.gen.ts` is committed (it compares with HEAD) | orchestrator |
| `apps/server/test/limits-doc.test.ts` (GC0 note) | rows of `docs/operations.md` | S-C4 (T-C-067) |

`web/lazy-namespaces.test.ts`, red since GC0 on purpose, is green (T-C-046).

## Tasks (evidence; files under `apps/web/test/` unless stated)

| Task | Test files | Red first, for the right reason |
|---|---|---|
| T-C-040 handlers from the wire schemas | `directory-handlers.test.ts` (17) on `support/directory-handlers.ts` | handlers and test written together; the guard seen red by making the handler send its fixture unparsed: the licence field and the restricted row with a name then passed (2 negatives failed), restored. Every answer is parsed with the schema of its route before it is sent |
| T-C-041 paging, state notices, restricted row | `use-cursor-paging.test.tsx` (6), `restricted-row.test.tsx` (8) | modules absent |
| T-C-042 users list | `users-page.test.tsx` (19) | the placeholder page: every test timed out |
| T-C-043 user detail | `user-detail.test.tsx` (17) | no route |
| T-C-044 groups list | `groups-page.test.tsx` (11) | no route |
| T-C-045 group detail | `group-detail.test.tsx` (17) | no route |
| T-C-046 routes and gating | `directory-gating.test.tsx` (13), `routes-coverage.test.ts` (+3), `lazy-namespaces.test.ts` (+2, green again), `directory-search.test.ts` (11), `pages.test.tsx`, `gating.test.tsx`, `placeholders.test.tsx` adapted | `lazy-namespaces` red since GC0; `routes-coverage` red when the two parameterised routes appeared |
| T-C-047 strings | `shared/i18n-catalogue.test.ts`, `shared/i18n-fragments.test.ts` via `pnpm i18n:check` | first merge failed "plural completeness" (a key ending in `.other` is a plural form): `groups.member.kindOther`, fixed |
| T-C-048 no HTML injection, a11y | `no-html-injection.test.tsx` (8), `directory-a11y.test.tsx` (33) | the first runs found a region with a negative tabindex (a shell region, test narrowed to `main`), a radio test that needed the Radix key-hold trick (then replaced by native radios), a duplicated text query |
| T-C-049 bundle | `pnpm build` + `pnpm bundle:check` | see below: three attempts over budget before it passed |
| T-C-050 this gate | | |

## Decisions taken while building

- **Routes are a layout, an index and a detail page**: `routes/users.tsx` (gate by `users:read`, loads both namespaces, `Outlet`), `routes/users.index.tsx` (the list), `routes/users.$id.tsx`; the same for groups. The gate sits once in the layout, so a detail address is gated by the same permission and shows No-access at the same URL. A flat `users.tsx` + `users.$id.tsx` would have nested the detail inside the list. The breadcrumbs are Dashboard / Users / User. Both namespaces (`users`, `groups`) are loaded by both layouts (`DIRECTORY_NAMESPACES` in `lib/locale.ts`): the user page lists groups, the group page lists users, and both name the `graph_permission_missing` message of `users` (GC0 amendment).
- **A bad link is dropped, key by key.** `validateUsersSearch` / `validateGroupsSearch` return every key, `undefined` for a dropped value: the router merges validated keys over the raw ones, so a key left out kept its raw invalid value (found while testing; the same latent behaviour exists in `validateShowcaseSearch` of `/design`, not touched). They import no schema (the route file belongs to the entry); `directory-search.test.ts` ties the vocabularies and the 64-character limit to the wire enums and `LIMITS.directory`.
- **The cursor is component state, not URL** (plan section 7, "minus cursor handling"; FR-C-502 "remembered in component state"). A shared link shows the first page of the same filters; FR-C-501's "and the cursor" is read as the filters. `useCursorPaging` keeps the stack, a change of filters resets it, `cursor_invalid` restarts with a status notice (`usePagedQuery` feeds the query's error back in a render-phase update).
- **No total anywhere** (FR-C-201): the footer says "50 users shown", "Page 2", Previous/Next; the buttons are disabled while another page loads.
- **A table of our own, not the DataTable.** The design system's `DataTable` is page-and-total based (`totalCount`, page numbers, page size, selection column). `DirectoryTable` is a semantic table (caption, `th scope`, first cell a row header and a link, sort header as a button with `aria-sort`, a focusable named scroll region) with the same look; restricted rows render through it.
- **Filters are native radio buttons in a fieldset** (`FilterChoice`), not the SegmentedControl or Select. Using the Radix controls changed the chunk layout and raised initial JS gzip by 4.2 KB with the Select and the SegmentedControl, and still by 1.8 KB with the SegmentedControl alone; native radios keep the arrow keys, the single tab stop and the group name and add nothing. The kind filter has five choices and wraps.
- **Entry CSS did not grow**: the pages use only utility classes the entry already generates (three that were new were replaced; checked by comparing the class names of the new files with the built entry CSS). Narrow screens scroll the table inside its region instead of hiding columns (`md:table-cell` would have been new CSS with 18 B of slack).
- **One key helper**: `directoryKey(...parts)` in `lib/query.ts` instead of seven factories (the entry holds `lib/query.ts`; the factories cost 1.4 KB gzip through a different chunk layout). Everything else lives with the feature.
- **The route loaders start the data and do not wait for it**: the first page of the list and the grants of the actor (`/api/v1/me/access`, to know a `basic` actor before drawing the columns) for `/users`; the group, its owners and its members for `/groups/$id`; the user and, with `groups:read`, their groups for `/users/$id`. They run only when the gate said `allowed` and the id is a GUID. The page headers and filters render before any data; the table body shows skeleton rows until the first page arrives (`aria-busy`, a visually hidden "Loading users").
- **Focus moves to the page heading on navigation** (FR-C-506) through `usePageHeadingFocus`: only when the page was reached by navigating (history index above 0), only on mount (a filter change keeps the focus where the person works).
- **Manager out of scope** is a restricted value (word and lock icon, no name, no link); `none` and `unavailable` are notices, never errors (GC0 amendment). A dynamic group shows `Dynamic` and a note that the rule is not shown (no `membershipRule` on the wire). Restricted members and owners are counted in words above the table and drawn as restricted rows without id or data.
- **Basic actor**: the columns are name and email, the state and type filters are not offered, and the note says why; the user detail has no manager and no memberships. The page detects it from the grants (`users:read` held only as `basic`), and until they are known it shows the full set.
- **`prefetchQuery` is deprecated** in the installed Query version (lint `no-deprecated`); the loaders use `queryClient.query(...)` with the errors swallowed (`directory/prefetch.ts`), as `routes/setup.tsx` does.
- **Placeholders removed**: `placeholders.users.description` and `placeholders.groups.description` are gone from the fragments and the entry catalogues; `placeholders.test.tsx` now covers the three Phase D pages.
- **The handlers are a `fetch` stand-in, not MSW**: `msw` is not a dependency of the web package and the install protocol forbids adding one in this phase; `test/support/directory-handlers.ts` plugs into `renderApp({ fetch })` exactly like `helpers/mock-api.ts`, and keeps the rules of the server the pages rely on.

## Adapted existing tests (web territory)

| Test | Change |
|---|---|
| `placeholders.test.tsx` | `/users` and `/groups` removed (no longer placeholders) |
| `lazy-namespaces.test.ts` | the two layouts must load `DIRECTORY_NAMESPACES`; a negative for a layout that forgets `groups` |
| `routes-coverage.test.ts` | `/users/$id` and `/groups/$id` are known parameterised routes (a parameterised route the test does not know fails, + negatives); a listed concrete address such as `/users/<guid>` is accepted; `e2e/routes.ts` was not touched |
| `pages.test.tsx` | `/users` and `/groups` are index routes and take the title of their layouts, like `/settings` |
| `gating.test.tsx` | "no preview banner" looks for the banner element, not any `role="status"` (the lists announce their count in one) |

## Frozen interfaces (web side; after this gate a change needs an amendment of this note)

- Routes: `/users`, `/users/$id`, `/groups`, `/groups/$id`; search parameters `q`, `enabled` (`true` | `false`), `type` (`member` | `guest`), `kind`, `order` (`desc`), defaults left out.
- `@m365portal` web exports used by other streams: none. The e2e streams rely on the accessible names, in English: search field "Search by name or email address" and button "Search"; filter groups "Account state", "User type", "Group type" (radio buttons); table captions "Users", "Groups", "Owners of {name}", "Members of {name}", "Groups of {name}"; sort button "Display name" with `aria-sort`; "Previous page", "Next page", "Page {n}"; live region "{n} users shown" (`role="status"`); restricted rows carry `data-restricted="true"`; page size 50.
- Lazy namespaces `users` and `groups`: the keys of `packages/shared/src/i18n/fragments/{users,groups}.*.json`.

## What the server must keep (the contract the handlers encode)

`GET /api/v1/me/access` grants decide the `basic` layout; a `basic` actor with `enabled` or `type` gets 422 `validation_failed`; the list query sends `limit=50`, omits defaults (`order` only when `desc`) and `cursor` only when it has one; `cursor_invalid` is 400 and restarts the list; a user or group outside the scope is 403 `permission_denied` by id; a Graph permission problem is 503 `graph_unavailable` with `errors: [{ pointer, code: 'graph_permission_missing' }]`; `/users/{id}/groups` is 403 without `groups:read` (the page does not ask without it); hidden membership is `membersState: 'hidden'` with no cursor; the web ignores the server's `title` and `detail`.

## Seams applied

| Seam | Files |
|---|---|
| XC7 | `apps/web/src/routes/{users,groups}.tsx` (placeholder pages gone), new `routes/{users,groups}.index.tsx`, `routes/{users,groups}.$id.tsx`, regenerated `routeTree.gen.ts`; `packages/shared/src/i18n/fragments/placeholders.{en,nl}.json` and the merged entry catalogues |
| XC5 (fill) | `packages/shared/src/i18n/fragments/{users,groups}.{en,nl}.json` (the S-C1 shells filled) and the merged `locales/lazy/{users,groups}.*.json`; `pnpm i18n:merge` |
| outside the list | `apps/web/src/lib/query.ts` (one helper, `directoryKey`), `apps/web/src/lib/locale.ts` (`DIRECTORY_NAMESPACES`) |
| not touched | `apps/server`, `e2e`, `docs`, `scripts/bundle-budget.json`, `VERSION` |

## Control-name changes

None to a control. The tests keep the names of tasks.md (`directory-handlers`, `use-cursor-paging`, `restricted-row`, `users-page`, `user-detail`, `groups-page`, `group-detail`, `routes-coverage`, `gating`, `no-html-injection`, `directory-a11y`); the gating of the four routes is in `directory-gating.test.tsx` next to the existing `gating.test.tsx`.

## Negative controls landed here (for the ledger of T-C-070)

| Guard | Negative |
|---|---|
| handlers answer from the wire schemas | a user with a licence field; a restricted row that names the object (seen red with the parse bypassed); a hidden membership with members |
| search vocabularies tie to the wire enums | a drifted vocabulary |
| lazy namespaces have a route | a layout that forgets the `groups` namespace |
| route list against the route tree | an unknown parameterised route; a listed address that is no page of one |
| names are data | an injected `<img onerror>`; a `javascript:` link; an HTML sink in the source |
| gating | an actor with the other permission sees No-access and no request is made (4 routes) |

## Open points, assumptions, risks, UNVERIFIED

- UNVERIFIED (CI/e2e): zero axe violations in light and dark at both viewports (contrast of the new text, 24 px targets), keyboard-only completion in a real browser, Lighthouse of `/users` and `/groups`, visual baselines. The unit tests prove the structure axe relies on (one `h1`, an outline without gaps, captions, scoped headers, names for every control, labelled fields, live regions, decoration hidden), not the pixels.
- Mobile: the table scrolls inside its focusable region; no column is hidden. A card layout for narrow screens needs new CSS and an approved growth of the entry CSS (RC-06); not assumed.
- For a `basic` actor the loader of `/users/$id` starts the groups request before the detail says it is basic: one wasted request (the page never shows it).
- The bundle has 52 B of gzip headroom for the initial JS and 18 B for the entry CSS. Chunk assignment moves with every new import shared between the entry and the lazy chunks (a 1.4 KB swing was seen for moving seven key factories), so any later change in the entry or in a shared UI component needs `pnpm build && pnpm bundle:check` again.
- The `/design` showcase validator has the raw-key merge behaviour described above; not changed (outside this stream).
- The user detail does not offer copy buttons (FR-C-503) and lists only direct members (said on the page).
