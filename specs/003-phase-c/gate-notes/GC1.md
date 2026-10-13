# Gate note GC1 (T-C-028): server

Verdict: **GC1 passed (local pass) for the server package, with one red that is not a defect of this stream**: `apps/server/test/limits-doc.test.ts` ("equals LIMITS row by row") and with it `pnpm docs:check`, because the five rows of `LIMITS.directory` are not yet in `docs/operations.md` (S-C4, T-C-067). The test side is done (the `ROWS` of the test carry the five rows) and the exact rows that make it green are under "For the orchestrator and S-C4". Everything else of the gate is green.

## What was run, on which state

State: branch `claude/modest-bohr-45f4kf`, HEAD `68f8a21` (the S-C3 commit, `VERSION` 0.3.47) plus the uncommitted S-C2 working tree (the orchestrator commits), 2026-10-13, Node v22, pnpm 10. `VERSION` was not touched by this stream (T-C-010 did not bump, as instructed).

| Command | Result | Time |
|---|---|---|
| `pnpm --filter @m365portal/server test` (`vitest run`, 204 files) | green except `limits-doc.test.ts` (1 test, above): 8,629 of 8,630 tests green. Two further reds of the first full run were closed and re-run green (`rbac/default-deny.test.ts`, a `kind: 'user'` row literal that the actor scan reads as an actor; `lifecycle.test.ts`, which compares the built bundle with `VERSION` and ran while the S-C3 commit bumped `VERSION` mid-run) | 310 s |
| `pnpm --filter @m365portal/server lint` (`eslint . --max-warnings 0`) | green | 73 s |
| `pnpm --filter @m365portal/server typecheck` | green | 20 s |
| `pnpm schema:check` | green | 3 s |
| `npx prettier --check apps/server` | green | 5 s |
| `pnpm docs:check` (`docs-contract.test.ts`, `limits-doc.test.ts`) | `docs-contract` green (49 tests, now with the Phase C route index); `limits-doc` red for the five missing rows | 12 s |
| Not run (another builder works in the same checkout) | repo-wide `pnpm lint`, `pnpm typecheck`, `pnpm test:packages`, `pnpm format:check`, web, e2e, `pnpm build`, `pnpm bundle:check`, CI-only controls (CodeQL, Trivy, image) | |

Test files of this stream, run together with the Phase B files they touch: 1,695 tests, 1,695 green (about 20 s per round).

## Tasks (evidence)

Red first, honestly: every test file ran red at least once while it was built (a missing method, a wrong expectation, a pattern the repository guards forbid), and every guard has its negative fixture (`expectGuardFails`). For T-C-010, T-C-011, T-C-012, T-C-018, T-C-019 and T-C-020 the module and its test were written in one step and the first run was green; the protocol of section 0.3 ("seen failing first") was therefore **not** observed for those six, and the negatives are the evidence that each guard can fail.

| Task | Test files (`apps/server/test/`) | Tests | Notes |
|---|---|---|---|
| T-C-010 port DTOs | `integrations/graph/schemas.test.ts` | 18 | `$select` with `assignedLicenses` fails (`checkSelect`, `FORBIDDEN_SELECT_PATTERN`); no `VERSION` bump here |
| T-C-011 `requestPage` | `integrations/graph/graph-http.test.ts` | 16 | foreign origin, look-alike host, http, other version, user info, relative link refused at return and at use; header resent; `$skip` refused; 5 MiB; not cached |
| T-C-012 query builder | `integrations/graph/directory-query.test.ts` | 37 | exact strings per enum; `O'Neil`; canaries `'`, `''`, `') or 1 eq 1 or ('`, `%27`, `)`, ` or `; 64 characters; scan: no other file builds a directory filter (+ negative) |
| T-C-013 grammar and the advanced rule | `fakes/fake-tenant.selftest.test.ts` (new block "Graph directory reads are strict") | 52 in the block | `or`, `not`, `any`, `ne`, `eq null`, `$orderby` with `$filter`, `$count`, `$skip`, `$top` 0 and 1000, unknown functions, `in`, `contains`, `$search` |
| T-C-014 routes, seeds, switches | same, plus `fakes/fake-graph.test.ts` (one Phase B case amended) | | paging with an opaque `$skiptoken`, `$select`, limited-information members, owners empty for distribution/mailsecurity/synced, hidden membership, `memberOf` for apps, manager mode; `seedDirectory`: 1,200 users, 150 groups, deterministic for a seed |
| T-C-015 strictness self-test | same | | `DIRECTORY_STRICT_RULES` (14 rules, each with a case; a test proves the table covers them) and a negative (`expectGuardFails` on a request Learn allows) |
| T-C-016 clients | `integrations/graph/graph-client.contract.test.ts` (174, both implementations), `integrations/graph/manager.test.ts` | 174 + 9 | 404, 403, 429 (`GraphThrottledError`), limited-information members, manager states, null properties, paging, malformed ids send nothing |
| T-C-017 map and read-only | `integrations/graph/permissions-map.test.ts`, `integrations/graph/read-only.test.ts` | 6 + 6 | `GroupMember.ReadWrite.All` in no row; `addMember` fixture fails; every read puts only GET on the wire, `checkMemberGroups` POST alone |
| T-C-018 cursor store | `directory/cursor-store.test.ts` | 10 | actor binding, TTL with the injected clock (sliding), LRU at 1,000, 18 random bytes, foreign handle |
| T-C-019 scoped scan | `directory/scoped-list.test.ts` | 12 | seeded property test, 20,000 cases against the naive filter; resume after a partly used page; five pages |
| T-C-020 restricted rows | `directory/restricted-rows.test.ts` | 18 | no id, name or address; basic; fail closed; negative: a handler returning the raw row fails |
| T-C-021 mappers, services | `directory/mappers.test.ts`, `directory/capability-types.test.ts` | 10 + 2 | `basic` projection on list and detail; milliseconds; scan: no wire user built outside the mappers (+ negative); `@ts-expect-error` calls without capabilities |
| T-C-022 users routes | `directory/users-routes.test.ts` | 19 | list order and paging, filters, scoped actor on 1,200 users, basic actor, mixed actor, 404 vs 403, manager none/unavailable/present/restricted, cursor errors |
| T-C-023 groups routes | `directory/groups-routes.test.ts` | 13 | four kinds, hidden membership makes no members call, owners `not_available`, 250 members paged, restricted rows |
| T-C-024 wiring, headers, table | `directory/routes-table.test.ts`, `directory/policy-applied.test.ts`, `cache-headers.test.ts` (+7 paths, +4 look-alikes), `modules.test.ts`, `branding/module.test.ts`, `docs-contract.test.ts` | 6 + 8 + | seven routes in the OpenAPI document, all GET, no `x-audit`, `no-store`, 405 for writes; handler that skips the policy gets 500 `policy_not_applied` per route; a POST route fails the guard |
| T-C-025 source guards | `directory/no-licences.test.ts`, `directory/no-writes.test.ts`, `directory/no-pii-in-logs.test.ts` | 5 + 3 + 2 | negatives for each; every table identical after a request mix but the session's own stamp; canary names absent from the log |
| T-C-026 denial audit | `audit-denials.test.ts` (+43 cases: seven routes x six callers, and P35), `directory/audit-reads.test.ts` | 43 + 2 | `permission_missing` and `scope_mismatch`; one entry before the 403; no entry for a success, 404 or 422 |
| T-C-027 error mapping | `directory/errors.test.ts` | 53 | per route: Graph 403, throttle, short throttle, 5xx, network, unexpected shape, recovery; secrets and not-connected; 404; a bug stays 500; no Graph text |

Counts: 249 tests in 19 new files (directory 163, Graph integration 86), plus the cases added to the extended files (in all: contract suite 174 tests, self-test 84, audit-denials 167 with 43 new, cache-headers 212 with 11 new).

## Frozen interfaces (the web builder and S-C4 may rely on them)

Routes, ids and wire schemas are those of GC0; behaviour that GC0 left open is now fixed:

- All seven are GET, `Cache-Control: no-store`, read rate class, access `permission` with `scoped`, no audit action. A write method on these paths is the standard 405.
- **Lists** (`users.list`, `groups.list`, `users.groups`, `groups.owners`, `groups.members`): `nextCursor` is a 24-character URL-safe handle, absent at the end, never a link. A step may return **fewer than `limit` rows, even none, with a cursor** (scoped actors: at most five Graph pages per request, EC-C4); the UI keeps offering "next" until the cursor is absent. A cursor is valid for the actor, the route and the same query parameters (a changed `q`, filter, order or group is a different list): anything else, an unknown or expired (600 s, sliding) handle, a restart of the server is **400 `cursor_invalid`**.
- `users.list` with `enabled` or `type` other than `all`: **422 `validation_failed`**, `errors[0] = { pointer: 'query/enabled' | 'query/type', code: 'filter_not_allowed' }`, for an actor who sees any user through a `basic` grant unless they see every user in full. The principal name is then left out of the search too (a row that is shown as `basic` does not show it).
- `users.get`: unknown id 404 `not_found`, out of scope 403 `permission_denied` (audited `scope_mismatch`), non-GUID 422. A user shown through a `basic` grant is `BasicUser`; the manager of a full detail is `none`, `unavailable` (default in the fake: U66; also any failure of the call) or `present` with a `DirectoryRow` (a manager out of the actor's scope is `{ kind: 'user', restricted: true }`).
- `users.groups`: 403 `permission_denied` (audited `permission_missing`) when the actor has no `groups:read` or sees the user only as `basic`; groups outside `groups:read` are left out, never restricted.
- `groups.owners`: `ownersState: 'not_available'` with an empty list when the group is `distribution`, `mailsecurity` or synced and the first page is empty; otherwise `listed`. `groups.members`: `membersState: 'hidden'` (no Graph call) when `visibility` is `HiddenMembership`.
- Rows of members, owners and the manager come from `restricted-rows.ts`: a user in full (with the principal name), as `basic` (principal name `null`), or restricted; a group in full or restricted; `other` objects as `{ kind: 'other', id, displayName: null, mail: null, userPrincipalName: null }` for an actor who may see users or groups at all, otherwise restricted.
- **Graph failures** (all seven): Graph 403 for the application is **503 `graph_unavailable`** with `errors: [{ pointer: '', code: 'graph_permission_missing' }]` and `Retry-After: 30`; a wait over 60 s is 503 `graph_throttled`; other client errors 503 `graph_unavailable`; an unusable secrets state 503 `secrets_unavailable`; a Graph 404 after the existence check 404 `not_found`. No Graph text, id or name in any answer.
- `GraphClient` port (additive): `listUsers`, `getUserManager`, `listUserGroups`, `listGroups`, `listGroupMembers`, `listGroupOwners`, `PageToken` (branded string, only a client makes one), `DirectoryPage`, `DirectoryRef`, `ManagerResult`, `UserListParams`, `GroupListParams`; `DirectoryUser` and `DirectoryGroup` extended (FR-C-104). `GraphHttp.requestPage` is additive; `requestAll` is unchanged.
- Test seams for S-C4 (e2e): `seedDirectory(directory, { seed?, users?, groups? })` and `describeSeed` exported from `test/fakes/fake-tenant/graph/index.ts` (1,200 users, 150 groups by default; named rows in `seeded.ids`); fake controls `managerForApps('refused' | 'allowed')` (default refused, U66), `hiddenMembersRefused(on)` (default on, U67), `omitGroupProperties(on)` (U36, U69).

## Seams applied

| Seam | Files |
|---|---|
| XC1 | `src/modules.ts` (`directoryModule` appended after `rbacModule`) |
| XC2 | `src/ports/graph.ts`, `test/fakes/fake-graph-client.ts` |
| XC3 | `src/integrations/graph/{graph-http,graph-client,schemas,permissions-map}.ts` |
| XC6 | `src/http/cache-headers.ts` (`/api/v1/users*`, `/api/v1/groups*` join the no-store list) |

New in `src/`: `directory/{module,routes,users-routes,groups-routes,users-service,groups-service,mappers,restricted-rows,scoped-list,cursor-store,paging,errors,context}.ts`, `integrations/graph/directory-query.ts`. New in `test/`: `directory/*`, the fake tenant files `lists.ts` and `seed-directory.ts`, five Graph integration tests.

**Phase B test files amended** (all in `apps/server/test/`, none weakened): `ports.test.ts` (twelve methods), `rbac/membership.test.ts` (the two wrapper classes delegate the six new methods), `rbac/api-fixture.ts` (option `graphOptions`), `integrations/graph/graph-client.test.ts` and `graph-client.contract.test.ts` (the extended properties of `getUser` and `getGroup`), `integrations/graph/permissions-map.test.ts`, `fakes/fake-graph.test.ts` (the Phase B case "a `$filter` on users is refused" now uses a property outside the grammar, because `/users?$filter=` is a Phase C route), `modules.test.ts` and `branding/module.test.ts` (seven modules), `docs-contract.test.ts` and `fixtures/docs/phase-b.ts` (the route index of the Phase C spec is a third contract; both directions, with negatives), `cache-headers.test.ts`, `audit-denials.test.ts`, `limits-doc.test.ts`.

## Deviations from tasks.md and the spec (each is a decision, not an oversight)

1. `directory-query.ts` returns `{ route, path, query, consistencyLevelEventual: true }` instead of `{ path, query, headers }`: `GraphRequest` already has the boolean that sets the header.
2. **`$select` of members, owners and the manager is `id,displayName,mail,userPrincipalName,department,mailNickname`** (spec FR-C-306: four properties). A restricted-row decision looks at the scope attributes of the actor; without `department` and `mailNickname` a department- or alias-scoped actor would see every member as restricted. `DirectoryRef` of the port carries both (not on the wire). Folded into U71; OV-C4 must confirm Graph returns them.
3. EC-C9 versus FR-C-307: an `other` member is shown as kind and id without a name to an actor who may see users or groups, and restricted otherwise (the two texts were read together).
4. FR-C-204 says an actor holding "only basic grants" may not use the `enabled` or `type` filters. Stricter and safer: refused whenever any row could be shown as `basic` (the actor has a `basic` grant and does not see all users in full); same condition removes `userPrincipalName` from the search.
5. P35 for a user seen only as `basic` is 403 (FR-C-204: no memberships).
6. The fake's reading of "startsWith on a non-default property" (FR-C-601): `userPrincipalName`, `department`, `mailNickname` need the advanced pair; `displayName` and `mail` do not. Our reading of R-C-02, to be confirmed by OV-C1 (U70).
7. The fake's `$skiptoken` is a base64url text now (was `skipN`); nothing outside the fake reads it.
8. Test file names: the contract suite stays `graph-client.contract.test.ts` (Phase B name; tasks.md says `contract.test.ts`); `manager.test.ts` (named in FR-C-107) was added; `server/directory/perf.test.ts` (SC-C4, informational, not in the task list of S-C2) was **not** built.
9. `cursor-store` is sliding (a use refreshes the 600 s), as plan 5.3 says; the spec's "TTL" is read that way.

## For the orchestrator and S-C4

- **`docs/operations.md`** needs these five rows in the limits table (they were checked against the test with a copy of the document; the labels are the constants of spec 6.7.2). Put them before the `ASSIGNMENT_EXPIRY_MAX_DAYS` row or anywhere in the table:

```text
| `searchMaxChars` | 64 characters | the app | `q` of the users and groups lists: 422 `validation_failed` above it (EC-C1) |
| `pageLimitDefault`, `pageLimitMax` | 100 and 200 rows | the app | `limit` of the directory lists (CD-10); the UI asks for 50 |
| `graphPageSize` | 999 | the app | `$top` of a scoped scan of users or groups (R-C-01) |
| `scanPagesMax` | 5 pages | the app | Graph pages read per request of a scoped list (FR-C-203) |
| `cursorTtlSeconds`, `cursorEntries` | 600 seconds and 1,000 entries | the app | list cursors held in memory, least recently used out (FR-C-103) |
```

  Then `pnpm docs:check` is green. T-C-067 "Needs: GC1" and GC1 "pnpm docs:check" ask for each other; the order above resolves it.
- `docs/permissions.md` (T-C-066): rows per route: `users.list`, `users.get`, `users.groups` use `User.Read.All`; `groups.*` use `GroupMember.Read.All`; manager `User.Read.All` (U66); `transitiveMemberOf` with `User.Read.All` (U67, U74); `GroupMember.ReadWrite.All` "granted, unused in Phase C". The permission map of the code is the source (`integrations/graph/permissions-map.ts`).
- E2E (T-C-060 to T-C-062) can import `seedDirectory`, and switch `managerForApps('allowed')` to show a manager. The e2e topology builds the fake tenant elsewhere; `seedDirectory` takes a `FakeDirectory`.
- ADR 0179 (T-C-067): the decisions worth recording are the in-memory cursor store bound to actor, route and parameters, and the one restricted-row function (deviations 2 to 5).

## Negative controls landed here (for the ledger of T-C-070)

`schemas.test.ts` ($select with a licence property), `directory-query.test.ts` (a service that builds a filter), `read-only.test.ts` (`addMember`, PATCH, DELETE, second POST), `permissions-map.test.ts` (a write role in a row), `cursor-store.test.ts` (a store that ignores the actor), `restricted-rows.test.ts` (raw row handler), `mappers.test.ts` (a service that builds a user row), `capability-types.test.ts` (eleven `@ts-expect-error` calls), `routes-table.test.ts` (POST, audited, unscoped route), `policy-applied.test.ts` (seven routes with a handler that skips the policy), `no-licences.test.ts`, `no-writes.test.ts`, `no-pii-in-logs.test.ts`, `fake-tenant.selftest.test.ts` (a request Learn forbids must be refused), `docs-contract.test.ts` (a Phase C route missing from or invented in the contract). Each landed together with its guard; none was re-run "seen red once more" in this gate.

## Open points, assumptions, risks, UNVERIFIED

- U66 to U74 are unchanged in status; the code treats each as its spec row says: manager `unavailable` on 403/400/odd shape (U66), no members call for `HiddenMembership` and such groups omitted from a user's groups in the fake (U67), `transitiveMemberOf` with `User.Read.All` only (U74), `GroupMember.Read.All` for owners (U68), `$select` on the polymorphic collections including `department` and `mailNickname` (U71, deviation 2), `startsWith`/`or`/`not` combined with `$orderby` and the pair (U69, U70), literal `Member`/`Guest` and null `userType` (U72). A nextLink is always sent with the header again (U73).
- Risk: a scoped actor on a very large tenant reads up to five Graph pages of 999 per request (RC-03); the constant is `LIMITS.directory.scanPagesMax`. A cursor is lost on restart (by design, PC-02).
- Risk: an actor with a `basic` grant and a department-scoped full grant cannot filter on state or type at all (deviation 4); revisit with the owner test (OV-C6).
- UNVERIFIED here: `pnpm build` and `pnpm bundle:check` with the new server code (no web or build change in this stream), `pnpm install --frozen-lockfile` on a clean copy, the repo-wide gates, CI-only controls.
