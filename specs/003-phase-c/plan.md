# Implementation Plan: M365Portal Phase C (users and groups, read only)

**Spec**: [spec.md](spec.md) | **Research**: [research-microsoft-c.md](research-microsoft-c.md) | **Builds on**: `specs/002-phase-b/plan.md` (sections 8, 11, 14), ADR-0175 (capability-branded arguments), ADR-0169 (one fake tenant)

## Samenvatting (Nederlands)

Dit plan beschrijft hoe fase C wordt gebouwd: zes nieuwe leesmethoden op de bestaande `GraphClient` (met retry, cache en foutafbeelding uit fase B), een kleine `directory`-module op de server met zeven GET-routes achter de bestaande policy-laag, een cursoropslag in het geheugen, een uitbreiding van de nep-tenant die net zo streng is als de echte Graph, en vier webpagina's in twee nieuwe lazy namespaces. Er is geen migratie, geen nieuwe omgevingsvariabele en geen nieuw Graph-recht. Server en web kunnen door twee bouwers tegelijk worden gebouwd zodra het draadcontract (schema's in `packages/shared`) bevroren is (poort GC0).

## 0. What was re-read before planning

The Phase B code as merged (PR #3): `apps/server/src/integrations/graph/{graph-client,graph-http,cache,schemas,permissions-map,errors-map}.ts` (the client already has `requestAll`, `consistencyLevelEventual`, same-origin `nextLink` following, a 5 MiB response cap and `GRAPH_MAX_PAGES` 20); `apps/server/src/policy/{context,scoped,authorize}.ts` (`ctx.visibleScopes`, `ctx.authorizeResource`, branded `VisibleScope` and `AuthorizedResource`); `apps/server/src/http/route.ts` (default-deny wrapper, `policy_not_applied` net, denial audit of reads by authenticated actors); `packages/shared/src/{permissions,rbac/*,limits,problem}.ts` (permission `users:read` with qualifier `basic`, `groups:read`, `PERMISSION_RESOURCE`, `SCOPE_MATRIX` with user attributes `displayName`, `mail`, `department` and group attributes `id`, `displayName`, `alias`, `mail`, `matchScope`, `projectUser`, `PageQuerySchema` default 100 and maximum 200); `apps/web/src/{routes/users.tsx,routes/groups.tsx,lib/gating.ts,components/data-table}`; `apps/server/test/fakes/fake-tenant/graph/` (`directory.ts`, `module.ts`, `odata.ts` with a grammar of `eq`, `startswith` and `and` only).

Findings that shape the plan:

1. Successful reads are not audited anywhere; the wrapper audits denials of permissioned reads (FR-B-602). Phase C keeps it (ODC-01).
2. `GraphHttp.requestAll` follows up to 20 pages and returns all items; Phase C needs one page at a time, so `GraphHttp` gains `requestPage` (additive) that returns `{ items, nextLink }`; the same-origin rule is reused.
3. `OData` grammar of the fake lacks `or`, `not`, `any(...)`, `$orderby`, `$count` and the header rule. S-C1 adds them.
4. The user scope attributes are `displayName`, `mail`, `department`; list `$select` must include `department` or scoped matching fails closed (a missing attribute never matches).
5. `LAZY_NAMESPACES` and `NAMESPACE_OWNERS` are closed lists; two entries are added.
6. No Phase B route is called `/api/v1/users` or `/api/v1/groups`: no collision. Route ids `users.*` and `groups.*` are free.

## 1. Technical context

No new dependency. Hono, zod-openapi, TanStack Router and Query, Vitest, MSW, Playwright, axe: as in Phase B. Storage: none (the cursor store is process memory and is lost on restart; a lost cursor is `cursor_invalid`, the UI restarts the list). Performance: the cost is Graph latency; the server adds at most 5 Graph calls per scoped list request and one to three per detail page.

## 2. Constitution and baseline check

| Rule | How Phase C satisfies it |
|---|---|
| Server-side enforcement only (AGENTS.md section 1) | Seven routes, all through `defineRoute`; every handler asks the policy context; FR-C-401 |
| No invented Microsoft facts | Research file with URLs; U66 to U74 |
| Phase stop | `T-C-999` is the phase report; nothing behind it |
| Documentation contract | Docs in nl and en (FR-C-603); no deployment change (FR-C-604) |
| Versioning | Runtime code changes: `VERSION` bump in the first code task (`T-C-030`) via `python scripts/bump_version.py` |
| Secrets and PII | No logs of names or ids (FR-C-405); no storage |
| Reuse | Table in section 3 |

## 3. Reuse

| Item | Decision | Note |
|---|---|---|
| `GraphHttp`, retry, budget, error map | reuse | one additive method `requestPage` |
| `GraphClient` port, `HttpGraphClient`, `FakeGraphClient`, contract suite | adapt | six methods added, two DTOs extended |
| Route wrapper, policy context, branded capabilities | reuse | |
| `projectUser`, `matchScope`, `visibleScopes` | reuse | |
| `PageQuerySchema`, `CursorSchema` | reuse | cursor semantics defined here (FR-C-103) |
| Problem registry | adapt | one code `cursor_invalid` |
| Fake tenant | adapt | grammar, ordering, counts, headers, seeds |
| DataTable, Skeleton, EmptyState, ErrorState, Tabs, Select, SegmentedControl, Persona | reuse | |
| Placeholder pages and `placeholders.users/groups` | replace | removed |
| New: `directory` server module, cursor store, `groupKindOf`, restricted-row function | new | small |

## 4. Module layout

### 4.1 Shared (`packages/shared/src`)

- `schemas/directory.ts`: Zod wire schemas `UserListQuery`, `UserListItem`, `UserDetail`, `GroupListQuery`, `GroupListItem`, `GroupDetail`, `DirectoryRowSchema` (full row | `restricted`), `UserGroupsResponse`, `OwnersResponse`, `MembersResponse` (with `membersState`, `ownersState`), `ManagerState`. Wire contract for both sides (the gate GC0 artefact).
- `directory/group-kind.ts`: `groupKindOf`, `GROUP_KINDS`.
- `limits.ts`: key `directory` (spec 6.7.2). `problem.ts`: `cursor_invalid`. `i18n`: lazy namespaces `users`, `groups` with `nl` and `en` JSON.

### 4.2 Server (`apps/server/src`)

- `ports/graph.ts`: new DTOs and methods (spec FR-C-101, FR-C-104).
- `integrations/graph/directory-query.ts`: the only builder of `$filter`, `$orderby`, `$select` for users, groups, members, owners (FR-C-102); `schemas.ts` additions; `graph-client.ts` methods; `graph-http.ts` `requestPage`; `permissions-map.ts` rows.
- `directory/` (new module, factory appended to `modules.ts`): `cursor-store.ts`, `scoped-list.ts` (the scan loop of FR-C-203, generic over a page source and a matcher), `restricted-rows.ts` (FR-C-307), `users-service.ts`, `groups-service.ts` (they take `VisibleScope` or `AuthorizedResource` arguments), `routes.ts` (P33 to P39), `module.ts`.
- `http/cache-headers.ts`: `no-store` path list (FR-C-403).
- Test fake: `test/fakes/fake-tenant/graph/{odata,directory,module}.ts` and a new `seed-directory.ts`.

### 4.3 Web (`apps/web/src`)

- `routes/users.tsx`, `routes/groups.tsx` (replaced), `routes/users.$id.tsx`, `routes/groups.$id.tsx` (new; `routeTree.gen.ts` regenerates by `pnpm routes:generate` and is committed).
- `features/users/{UsersPage,UserDetail,UserFilters,queries}.tsx` and `features/groups/{GroupsPage,GroupDetail,GroupFilters,MembersTable,queries}.tsx`; a shared `features/directory/{useCursorPaging,RestrictedRow,StateNotice}.tsx` for paging, restricted rows and the state messages.
- `lib/query.ts` gains key factories only; `lib/commands.ts` is unchanged.

## 5. Server design

### 5.1 `requestPage` and the Graph methods

`GraphHttp.requestPage(request | { nextLink })` returns `{ items, nextLink: string | null, count: number | null }`; the link is validated by the existing rule and never leaves the server. `HttpGraphClient` methods return `{ items, next: PageToken | null }` where `PageToken` is an opaque in-memory object holding the validated link. The contract suite runs each method on both implementations with the same scenarios (page boundaries, empty, 404, 403, limited-information members, `null` properties).

### 5.2 Query builder (FR-C-102, FR-C-202, FR-C-301)

`directory-query.ts` exports pure functions `usersQuery(params)`, `groupsQuery(params)`, `membersQuery()`, `ownersQuery()`, `userGroupsQuery()`; each returns `{ path, query, headers }`. Closed enums for `enabled`, `type`, `kind`, `order`. The search literal goes through `odataString` and is limited to `searchMaxChars`. A table test compares every input to an exact expected string, plus canaries (`'`, `%27`, `)`, ` or `, a 10 KiB string).

### 5.3 Cursor store and paging (FR-C-103, FR-C-203)

`cursor-store.ts`: `put(actorId, state) -> handle`, `take(actorId, handle) -> state | null` (not single-use: a page may be re-requested; the entry is refreshed on use), 18 random bytes base64url (24 characters), LRU with TTL by injected clock. `state` is `{ kind, params, pageToken | null, skip }` where `skip` is the number of already handed-out rows of the current scanned Graph page (so a resume after a partially used page is exact). `scoped-list.ts`: given a page source and `VisibleSet`, loops: fetch page, filter by `matchScope` over the visible items (a `basic` or `full` set decides the projection per row), push rows until `limit`, remember the position, stop at `scanPagesMax`. For `all` the loop runs once with Graph `$top = limit`.

### 5.4 Routes and policy

Each handler: validate (route schema), `ctx.visibleScopes(...)` or load-then-`ctx.authorizeResource(...)`, call the service with the capability, map errors, return. Detail routes read the object first (so the scope check has the attributes), which means 404 for unknown and 403 for out of scope (ODB-11). `GET /users/{id}/groups` asks for both `users:read` (authorize the user) and `groups:read` (`visibleScopes`). Sub-resource lists for a group authorise the group, then apply `restricted-rows.ts` with the actor's `users:read` and `groups:read` visibility. The `unscopedReason` field is not used (all routes are scoped).

### 5.5 Mappers

Pure functions from Graph DTO to wire DTO: `toUserListItem(user, qualifier)`, `toUserDetail`, `toGroupListItem`, `toGroupDetail`, `toRef`. They call `projectUser` for `basic`; they are the only code that builds a wire user (a unit test greps the directory module for object literals with `displayName` outside the mappers).

## 6. Fake tenant design

Extend, never fork (ADR-0169). `odata.ts` gains `or`, `not`, parentheses, `any(c:c eq 'literal')` on `groupTypes`, `$orderby`, `$count`, `$top` limits (999), `$skip` rejection, `$skiptoken` paging with opaque tokens, and the **advanced-query rule** as a single function `requiresAdvanced(parsedQuery)` (true for `$orderby` with `$filter`, `$count`, `not`, `ne`, `endsWith`, `$search`, relationship queries) which returns 400 when the header or `$count=true` is missing. `module.ts` gains the routes of FR-C-101 with the permission map of `permissions-map.ts` (a token missing `User.Read.All` or `GroupMember.Read.All` gets 403). Switches (`fake.setMode`): `managerForApps: 'refused' | 'allowed'` (default refused, U66), `hiddenMembersRefused` (default on), `omitGroupProperties` (U36). `seed-directory.ts` builds deterministic data from a seed (1,200 users, 150 groups, nesting, 250-member group, hidden-membership group, guests, disabled, quote and diacritic names, managers chain).

## 7. Web design

URL search parameters are the state (`validateSearch` with the same Zod schemas as the wire query, minus cursor handling). `useCursorPaging` keeps a stack of cursors so "Previous" works; changing any filter resets the stack. Query keys include all parameters. Detail pages run independent queries per section. Restricted rows render a muted row with the text "restricted" and no data. All text through `t()`; names are text nodes. Table columns: users — display name (link), principal name, mail, department, state (icon plus text), type; groups — display name (link), kind (badge with text), mail, visibility. Mobile: the DataTable's existing narrow layout; the detail definition list stacks.

## 8. Streams, territories and waves (input to `tasks.md`)

| Stream | Territory | Can run in parallel with |
|---|---|---|
| S-C1 Contract and shared | `packages/shared/**` additions, `docs/` none | first; gate GC0 |
| S-C2 Graph client, fake tenant, server module | `apps/server/src/{ports,integrations/graph,directory}`, `apps/server/test/**` | S-C3 after GC0 |
| S-C3 Web | `apps/web/**` | S-C2 after GC0 |
| S-C4 Docs, e2e, verification | `e2e/**`, `docs/**`, `scripts/bundle-budget.json` (read only), README | starts after GC1 and GC2; docs tasks may start after GC0 |

Waves: W0 S-C1 (gate GC0: wire schemas, limits, problem code, group kind, i18n namespace shells frozen). W1 S-C2 and S-C3 at the same time (two builders: one server, one web). S-C3 works against the schemas and mocks the API with MSW handlers built from them; it needs no server code. Gates GC1 (server) and GC2 (web). W2 S-C4 (e2e needs both). Gate GC3 and the phase report.

Seams in Phase B files (the complete list): `apps/server/src/modules.ts` (append factory), `ports/graph.ts` (+ `FakeGraphClient` in test), `integrations/graph/{graph-client,graph-http,schemas,permissions-map}.ts`, `http/cache-headers.ts`, `packages/shared/src/{limits,problem}.ts`, `packages/shared/src/i18n/{types,load-namespace}.ts` and the i18n merge script's `NAMESPACE_OWNERS`, `apps/web/src/routes/{users,groups}.tsx`, `apps/web/src/i18n` entry catalogue (placeholders removed), `e2e/routes.ts`, `docs/permissions.md` and friends.

## 9. Test strategy

Unit and integration with Vitest on the fake tenant (no egress guard as in Phase B). Property test for the scoped scan (seeded, 20,000 cases, naive reference implementation). Type-level tests for the capability arguments. Source scans for licences, writes and PII logs, each with a negative fixture. Web tests with Testing Library and MSW. e2e with Playwright on the three-process topology: seeding of roles and scoped assignments through the real RBAC API. Visual baselines from the CI runner artefact only. Lighthouse reported not gated.

## 10. Phase C open points to track

U66 to U74 (spec 8.3), ODC-01 to ODC-05 (spec 10), risks RC-01 to RC-06. Plan decisions: **PC-01** `requestPage` instead of changing `requestAll`; **PC-02** cursor store in memory, not signed tokens (no key material, no replay beyond the actor); **PC-03** prefix search over `$search` (ODC-03); **PC-04** one pure query-builder module; **PC-05** restricted rows instead of omission for members and owners, omission for a user's groups (membership probing); **PC-06** ids only as GUIDs in paths (no UPN lookups).
