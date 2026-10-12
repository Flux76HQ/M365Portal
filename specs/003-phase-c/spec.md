# Feature Specification: M365Portal Phase C (users and groups, read only)

## Samenvatting (Nederlands)

**Wat.** Fase C vult de twee pagina's die in fase A en B nog plaatshouders zijn: **Gebruikers** en **Groepen**. De eerste versie is bewust klein en veilig: **alleen lezen**. Gebruikers: een lijst met paginering, zoeken, sorteren op weergavenaam, filter op ingeschakeld of uitgeschakeld en op lid of gast, en een detailpagina met kerngegevens, manager en groepslidmaatschappen. Groepen: een lijst met paginering, zoeken en filter op type (Microsoft 365, beveiliging, e-mailbeveiliging, distributie, zoals Graph ze teruggeeft), en een detailpagina met kerngegevens, eigenaren en leden (gepagineerd).

**Wat niet.** Geen aanmaken, wijzigen of verwijderen, geen ledenbeheer, geen wachtwoordreset, geen licentiewijzigingen en geen licentiekolom (besluit van de eigenaar, 2026-10-13; U17 blijft open). Fase C heeft **geen nieuwe Graph-schrijfrecht** nodig en ook geen nieuw leesrecht. `GroupMember.ReadWrite.All` is in fase B al verleend en blijft in fase C ongebruikt (ODB-02): het staat in de documentatie als "verleend, ongebruikt". Een test faalt als een fase C-route iets anders dan GET is of een schrijfmethode op de Graph-client verschijnt.

**Rechten.** Fase C gebruikt de bestaande rechten `users:read` (met kwalificatie `full` of `basic`) en `groups:read`, de bestaande scopes (`visibleScopes`) en de centrale policy-laag. Lijsten tonen alleen wat de aanvrager mag zien. Een **enkel object buiten het zicht** geeft 403 `permission_denied` (ODB-11, bevestigd door de eigenaar op 2026-10-13). Een aanvrager met alleen `users:read` met kwalificatie `basic` ziet alleen id, naam en e-mail. Leden en eigenaren die de aanvrager als gebruiker of groep niet mag zien, komen terug als "beperkt" zonder gegevens.

**Wat Microsoft Learn zegt en wat niet (sectie 8).** Gecontroleerd: lijsten van gebruikers en groepen (maximaal 999 per pagina, geen `$skip`, `ConsistencyLevel: eventual` met `$count=true` voor `$filter` samen met `$orderby`), `GroupMember.Read.All` is voor groepenlijsten, leden en eigenaren toegestaan, `transitiveMemberOf` werkt met `User.Read.All`, en `memberOf` niet (alleen `Directory.Read.All`). Let op: de pagina "List manager" noemt voor **applicatierechten "Not supported"**; de manager is daarom een bonus die netjes kan ontbreken (U66). Groepen met verborgen lidmaatschap vragen `Member.Read.Hidden`, dat we niet hebben en niet aanvragen: de pagina zegt dan dat het lidmaatschap verborgen is. Wat niet te verifiëren was, staat als U66 tot en met U74 in het register; de eigenaar sluit ze met één test tegen de echte tenant (sectie 8.4).

**Audit.** De code beslist al: geslaagde leesacties worden niet geaudit; elke weigering van een leesactie door een ingelogde aanvrager wel (FR-B-602). Fase C houdt dat zo; of ook geslaagde detailweergaven in het auditlog moeten, is besluit ODC-01 (standaard: nee).

**Taal en toegankelijkheid.** Nederlands en Engels vanaf het begin, in twee nieuwe lazy namespaces (`users`, `groups`); de eerste lading groeit niet. Semantische tabellen, volledig met het toetsenbord bedienbaar, WCAG 2.2 AA met axe in CI.

**Omvang.** Zeven routes (allemaal GET), vier pagina's, geen migratie, geen nieuwe omgevingsvariabele, geen nieuw Graph-recht. Na fase C stop ik: de eigenaar test tegen een echte tenant.

---

## Document status

**Feature Branch**: the branch this session was given (integration branch `main`).

**Created**: 2026-10-12

**Status**: Draft for the Phase C gate. Written spec-first on the merged Phase B (PR #3). Phase B code was read for this document: `apps/server/src/{rbac,policy,http,integrations/graph}`, `packages/shared/src/{permissions,limits,problem}.ts` and `rbac/`, `apps/server/test/fakes/fake-tenant/graph`, `apps/web/src/routes/{users,groups}.tsx` and `docs/phase-reports/phase-B.md`.

**Input**: `docs/build-prompt.md` (users and groups), `specs/002-phase-b/` (spec, plan, tasks, `research-microsoft-b.md`, gate notes), `docs/open-points.md` (U1 to U65, ODB-01 to ODB-18, PB-01 to PB-28), `research-microsoft-c.md` (same folder: R-C-01 to R-C-10), and the owner's decisions of 2026-10-13 (section 10).

**Size rule.** This phase is deliberately about a quarter of Phase B. A row that adds machinery beyond reading and showing users and groups is out.

**U-register numbering.** `docs/open-points.md` already holds U1 to U65 (Phase B closed the gap noted in `docs/phase-reports/phase-B.md` section 4.1 item 10: U51 to U65 are present with their rows). Nothing was renumbered. Phase C continues after the highest used number: **U66 to U74** (section 8.3). U17 and U48 (licences) stay open and are recorded as deferred.

---

## 1. Scope and phase gate

### 1.1 Scope

| Area | In Phase C | Not in Phase C (phase) |
|---|---|---|
| Users | List (paged, prefix search, sort by display name, filter enabled/disabled, member/guest); detail (core properties, manager, group memberships, transitive) | Create, update, delete, enable/disable, password reset, licence column and licence changes (D or later; U17, U48), sign-in activity, photos, direct reports |
| Groups | List (paged, prefix search, filter by kind: Microsoft 365, security, mail-enabled security, distribution; sort by display name); detail (core properties, owners, members, both paged) | Create, update, delete, owner and member changes (`groups:members:write` stays unused), transitive members, nested-group expansion, dynamic distribution groups (Graph does not return them), dynamic-membership rule editing |
| Graph | Six new read methods on the existing `GraphClient` port (`getUser`, `getGroup` extended); no new permission | Any write method; `Member.Read.Hidden`, `Group.Read.All`, `Directory.Read.All`, `User.ReadBasic.All` (not requested) |
| RBAC | Existing `users:read` (qualifiers `full`, `basic`), `groups:read`, `visibleScopes`, `authorizeResource`, capability-branded arguments | New permissions, new roles, scope pickers (D) |
| Audit | Denials of the new read routes (existing wrapper behaviour) | Audit of successful reads (ODC-01), audit UI (D) |
| Web | `/users`, `/users/$id`, `/groups`, `/groups/$id`; namespaces `users`, `groups` | Bulk actions, export (D), saved views, column customisation beyond the DataTable defaults |
| Storage | None | Any table, migration or cache on disk |
| Distribution lists | Distribution groups that Graph returns appear in the groups list as kind `distribution`, read-only | The distribution-list pages, members write, dynamic lists (D, resource type `distributionList`) |

### 1.2 Graph permissions in Phase C

| Application role | Held since | Phase C use |
|---|---|---|
| `User.Read.All` | B | List users, get user, manager (U66), `transitiveMemberOf`, user fields of members and owners |
| `GroupMember.Read.All` | B | List groups, get group, members, owners, groups of a user |
| `Organization.Read.All` | B | Not used by Phase C (wizard and Settings only) |
| `GroupMember.ReadWrite.All` | B (decision ODB-02: granted early, one consent) | **Granted, unused.** No Phase C code path may use a write permission; `docs/permissions.md` lists it as "granted, unused in Phase C" (FR-C-105) |

### 1.3 Suggested build streams (input to the plan; not binding)

S-C1 shared contract and fake tenant, S-C2 Graph client and server routes, S-C3 web, S-C4 docs, e2e and verification. S-C2 and S-C3 run in parallel once the wire contract (T-C-001 to T-C-005) is frozen at gate GC0 (plan section 8).

---

## 2. Document conventions

IDs: `FR-C-nnn` requirements (MUST/SHOULD), `US-C1..`, `EC-C1..` edge cases, `SC-C1..` success criteria, `ODC-nn` owner decisions, `AC-nn` assumptions, `RC-nn` risks, `U66` and up unverified Microsoft claims. Test paths follow Phase B: `server/` is `apps/server/test/`, `shared/` is `packages/shared/test/`, `web/` is `apps/web/test/`, `e2e/` is `e2e/tests/`. "(+ negative)" means a guard that also lands the fixture that makes it fail on purpose (`expectGuardFails`). Every MUST has a named automated control; what only a real tenant can show is in section 8.4. No Microsoft API, property or permission in this document comes from memory: each is in `research-microsoft-c.md` (cited as R-C-nn) or in Phase B's research.

---

## 3. Phase gate

Phase C ends with the phase report (summary, test results, step list for the owner, open points, the question whether to continue) and stops. Phase D (distribution lists, contacts, RBAC admin UI, audit UI, hardening) does not start without the owner's explicit approval (AGENTS.md section 1).

---

## 4. User scenarios

- **US-C1 (P1) Find a user.** An administrator with `users:read` opens Users, types the first letters of a name or address, filters on "disabled", and sees a paged table sorted by display name. Done when: the right rows, in order, with a next page, from the fake tenant and (owner test) the real one.
- **US-C2 (P1) Open a user.** The detail shows name, principal name, mail, department, job title, office, state, type, manager and group memberships. Done when: a user without a manager shows "no manager", and a manager that cannot be read shows "not available", never an error page.
- **US-C3 (P1) Find and open a group.** Groups list with search and kind filter; detail with kind, mail address, visibility, owners and members (paged). Done when: a group with 250 members pages through all of them.
- **US-C4 (P1) A scoped administrator sees only their part.** An actor whose `users:read` is limited to department "Finance" sees only those users in the list and gets 403 on any other user by id. Done when: the list never contains a row the detail would refuse.
- **US-C5 (P2) Basic access.** A role with `users:read` qualifier `basic` sees id, name and mail only; no manager, no memberships, no filters on state or type.
- **US-C6 (P2) Honest limits.** A hidden-membership group, a distribution group without owners, a Graph throttle and a missing permission each show a plain translated message.

---

## 5. Edge cases

| ID | Case | Behaviour |
|---|---|---|
| EC-C1 | Search text longer than 64 characters or with control characters | 422 `validation_failed` (the Phase B registry status, `PROBLEM_CODES`) before any Graph call |
| EC-C2 | Single quote in the search text | Doubled by `odataString`; the fake tenant parses it back (test with `O'Neil`) |
| EC-C3 | Cursor from another actor, expired, or unknown | 400 `cursor_invalid` (FR-C-108); the UI restarts the list from the first page with a notice |
| EC-C4 | Scoped actor whose scope matches few users of a large tenant | The server scans at most 5 Graph pages per request and returns what it found with a cursor (FR-C-203); the UI keeps offering "next" until the cursor is absent |
| EC-C5 | User without manager | Graph 404 on the manager call becomes `manager: { state: 'none' }` |
| EC-C6 | Manager call refused for application permissions (U66) | `manager: { state: 'unavailable' }`, one log line without ids; the page works |
| EC-C7 | Hidden-membership group | No members call; `membersState: 'hidden'` (FR-C-108); owners still listed |
| EC-C8 | Group created in Exchange, distribution or synced | Owners may be empty (R-C-06); the UI says owners are not available for this kind |
| EC-C9 | Member that is a device, service principal or contact | Returned as kind `other` with `id` only when the actor may see groups or users; counted, not shown by name |
| EC-C10 | Property Graph did not return (U36) | `null`; kind `unknown`; the UI shows a dash |
| EC-C11 | Guest user (`#EXT#` principal name) | Shown with type `guest`; the principal name is displayed as received |
| EC-C12 | Replication delay (a group created seconds ago is missing) | The page note "recent changes can take a moment" is part of the empty state; no retry loop |
| EC-C13 | Graph 429 or 5xx | Existing `GraphHttp` retry; after the budget 503 `graph_throttled` or `graph_unavailable`; the UI offers "try again" |
| EC-C14 | Panel application lacks a permission (Graph 403) | 503 `graph_unavailable` with `errors[]` code `graph_permission_missing`; the UI points to Settings, Connection (repair) |
| EC-C15 | User id that is not a GUID | 422 `validation_failed` (the path schema is `GuidSchema`); user principal names are not accepted as ids in Phase C |

---

## 6. Requirements

### 6.1 Graph client (reads only)

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-C-101 | MUST | The `GraphClient` port gains six read methods and no write method: `listUsers`, `getUserManager`, `listUserGroups`, `listGroups`, `listGroupMembers`, `listGroupOwners`; `getUser` and `getGroup` are kept and their selected properties extended (FR-C-104). Each is implemented by `HttpGraphClient` on `GraphHttp` (retry, budget, cache and error mapping as in Phase B) and by `FakeGraphClient`; one contract suite runs against both (Phase B FR-B-315 pattern). Calls: `GET /users`, `GET /users/{id}/manager`, `GET /users/{id}/transitiveMemberOf/microsoft.graph.group`, `GET /groups`, `GET /groups/{id}/members`, `GET /groups/{id}/owners` (R-C-01, R-C-03, R-C-05 to R-C-08). | `server/integrations/graph/contract.test.ts` (both implementations), `server/integrations/graph/permissions-map.test.ts` (a row per method) |
| FR-C-102 | MUST | Query construction uses `url-guard.ts` only (`odataString`, `guidSegment`, `buildQuery`). `$filter` and `$orderby` are built from closed allow-lists in one module (`directory-query.ts`), never from request text except the search literal. List calls send `ConsistencyLevel: eventual` and `$count=true` (R-C-01, R-C-02); member and owner calls likewise (R-C-05, R-C-06). `$skip` is never sent (R-C-01); `$top` is at most 999. List results are not cached; `getUser` and `getGroup` keep the 60 s cache. | `server/integrations/graph/directory-query.test.ts` (table of inputs to exact query strings, injection canaries), `server/integrations/graph/graph-http.test.ts` (header present) |
| FR-C-103 | MUST | Paging follows Graph's `@odata.nextLink` through the existing same-origin, `/v1.0/`-only rule. The panel's cursor (`PageQuerySchema.cursor`, 1 to 512 URL-safe characters) is a random handle into a server-side store that holds the `nextLink` and the resume state, bound to the actor id, with `LIMITS.directory.cursorTtlSeconds` (600) and at most `LIMITS.directory.cursorEntries` (1,000) entries (least recently used out). The link itself never reaches the browser. | `server/directory/cursor-store.test.ts` (actor binding, expiry, eviction, handle entropy) |
| FR-C-104 | MUST | Answers are parsed by Zod allow-lists (Phase B `schemas.ts` rules: unknown properties dropped, strings cut at 256 bytes, absent is `null`). `DirectoryUser` adds `givenName`, `surname`, `jobTitle`, `officeLocation`, `userType`, `onPremisesSyncEnabled`, `createdDateTime`; `DirectoryGroup` adds `visibility`, `description`, `createdDateTime`; members and owners parse to `DirectoryRef { id, kind: 'user' \| 'group' \| 'other', displayName, mail, userPrincipalName }` from `@odata.type`. `assignedLicenses`, phones, addresses and sign-in data are never selected (decision 3, 2026-10-13). | `server/integrations/graph/schemas.test.ts` (+ negative: `$select` containing `assignedLicenses` fails) |
| FR-C-105 | MUST | Phase C needs no new Graph permission. `GRAPH_METHOD_PERMISSIONS` has a row for every new method; every permission in those rows is in the four granted roles and none in a write role. `GroupMember.ReadWrite.All` is not used by any method; `docs/permissions.md`, the Connection page text and `docs/open-points.md` list it as "granted, unused in Phase C". The port has no method whose name starts with `create`, `update`, `delete`, `add`, `remove`, `set` or `reset`, and `HttpGraphClient` sends no request with a method other than GET (the existing `checkMemberGroups` POST is a read and is the only exception, allow-listed by name). | `server/integrations/graph/permissions-map.test.ts`, `server/integrations/graph/read-only.test.ts` (+ negative: a fixture method `addMember` fails it), `server/docs-contract.test.ts` |
| FR-C-106 | MUST | Errors map to the Phase B taxonomy: 404 on a single object is `null` (route answers 404 `not_found`); 429 and 5xx exhaust to `graph_throttled` or `graph_unavailable`; a Graph 403 for the panel's own application is `GraphForbiddenError`, answered 503 `graph_unavailable` with `errors[]` code `graph_permission_missing` (EC-C14). No Graph message text reaches a response. | `server/directory/errors.test.ts` |
| FR-C-107 | SHOULD | The manager is best effort. `getUserManager` returns `{ state: 'present', user }`, `{ state: 'none' }` (404, R-C-07) or `{ state: 'unavailable' }` (403, 400 or an unexpected shape, which includes "application permissions not supported", U66). It is read with a separate call so a failure cannot hide the user. | `server/integrations/graph/manager.test.ts`, `e2e/users.spec.ts` (manager unavailable) |
| FR-C-108 | MUST | Hidden membership: the group detail route reads `visibility` and, for `HiddenMembership`, answers `membersState: 'hidden'` and makes no members call (R-C-05; `Member.Read.Hidden` is not requested, ODC-04). A cursor that is unknown, expired or from another actor is 400 `cursor_invalid`. | `server/directory/groups-routes.test.ts`, `server/directory/cursor-store.test.ts` |

### 6.2 Users

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-C-201 | MUST | `GET /api/v1/users` (P33, `users.list`, permission `users:read`, scoped `user`). Query (strict Zod): `q` (prefix text, 1 to 64 characters), `enabled` (`all` default, `true`, `false`), `type` (`all` default, `member`, `guest`), `order` (`asc` default, `desc`; always by display name), `limit` (1 to 200, default 100), `cursor`. Response: `{ items: UserListItem[], nextCursor?: string }`. No total count is returned (a count would leak the size of a scope). | `shared/schemas-directory.test.ts`, `server/directory/users-routes.test.ts` |
| FR-C-202 | MUST | Graph mapping: `q` becomes `(startsWith(displayName,'q') or startsWith(mail,'q') or startsWith(userPrincipalName,'q'))`; `enabled` becomes `accountEnabled eq true|false`; `type` becomes `userType eq 'Member'|'Guest'` (U72 for the literals and for users whose `userType` is null); the parts are joined with `and`; `$orderby=displayName asc|desc`; `$select` is the list set (`id`, `displayName`, `userPrincipalName`, `mail`, `department`, `jobTitle`, `accountEnabled`, `userType`); the advanced pair is sent (R-C-01, R-C-02; the combination is U70). Prefix search is a choice, not a Graph limit (ODC-03). | `server/integrations/graph/directory-query.test.ts` |
| FR-C-203 | MUST | Scope handling uses `ctx.visibleScopes('users:read')`. For `all` the Graph page is passed through. For scope items the server reads Graph pages of 999 in order, keeps the users for which `matchScope` is true (attributes: `displayName`, `mail`, `department`; a missing attribute never matches), fills up to `limit` and stops after `LIMITS.directory.scanPagesMax` (5) Graph pages, returning a cursor that resumes exactly after the last row handed out. A row never appears twice and never vanishes between pages. | `server/directory/scoped-list.test.ts` (property test, seeded, 20,000 cases against a naive filter), `server/directory/users-routes.test.ts` |
| FR-C-204 | MUST | Qualifier handling: rows of users visible only through a `basic` grant pass through `projectUser(user, 'basic')` (`id`, `displayName`, `mail`) in the list and the detail; one function is used on every path. An actor holding only `basic` grants may not use the `enabled` or `type` filters (422 `validation_failed`: the filter would reveal a hidden property); the detail of such a user has no manager and no memberships. | `shared/rbac-qualifier.test.ts` (existing), `server/directory/users-routes.test.ts` (+ negative: a list handler that skips the projection fails) |
| FR-C-205 | MUST | `GET /api/v1/users/{id}` (P34, `users.get`): the user is read with `getUser`, then `ctx.authorizeResource('users:read', { type: 'user', id, displayName, mail, department })`. Unknown id is 404 `not_found`; a user outside the actor's visible scope is **403 `permission_denied`** (ODB-11, confirmed 2026-10-13), audited as a denial with reason `scope_mismatch`. The response carries the core properties (FR-C-104), `manager` (FR-C-107) and no memberships. | `server/directory/users-routes.test.ts` (existence order: 404 for unknown, 403 for out of scope), `server/audit-denials.test.ts` (route table driven) |
| FR-C-206 | MUST | `GET /api/v1/users/{id}/groups` (P35, `users.groups`): needs `users:read` on the user (as FR-C-205) **and** `groups:read`; the groups returned are filtered by `visibleScopes('groups:read')` (a group the actor may not see is omitted, never shown as restricted, so membership cannot be probed). Source: `transitiveMemberOf/microsoft.graph.group` (R-C-08), so the list is transitive and the UI says so; groups with hidden membership may be absent (U67) and the page says so. Paged with a cursor. An actor with `users:read` but without `groups:read` gets 403 `permission_denied` on this route and the page hides the section. | `server/directory/users-routes.test.ts`, `web/user-detail.test.tsx` |
| FR-C-207 | MUST | No licence data anywhere: no column, field, filter or request mentions licences. U17 and U48 stay open, deferred by the owner (decision 3). | `server/directory/no-licences.test.ts` (source scan of the Phase C files and of the OpenAPI document for `assignedLicenses`, `license`, `licence`) (+ negative) |

### 6.3 Groups

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-C-301 | MUST | `GET /api/v1/groups` (P36, `groups.list`, permission `groups:read`, scoped `group`). Query: `q` (prefix, 1 to 64), `kind` (`all` default, `m365`, `security`, `mailsecurity`, `distribution`), `order`, `limit`, `cursor`. Response `{ items: GroupListItem[], nextCursor?: string }`, no total. Graph mapping from R-C-03: `m365` is `groupTypes/any(c:c eq 'Unified')`; `security` is `mailEnabled eq false and securityEnabled eq true`; `mailsecurity` is `not groupTypes/any(c:c eq 'Unified') and mailEnabled eq true and securityEnabled eq true`; `distribution` is `not groupTypes/any(c:c eq 'Unified') and mailEnabled eq true and securityEnabled eq false`; `q` is `startsWith` on `displayName`, `mail` and `mailNickname` (ODC-03); the advanced pair is sent (U69). Scope handling as FR-C-203 with the attributes `id`, `displayName`, `alias` (the `mailNickname`) and `mail`. | `server/directory/groups-routes.test.ts`, `server/directory/scoped-list.test.ts` |
| FR-C-302 | MUST | Dynamic distribution groups are not returned by Graph (R-C-03). The groups list says so once, in a note under the filter ("dynamic distribution lists are managed in Exchange"), and never claims completeness for the `distribution` kind. | `web/groups-page.test.tsx` |
| FR-C-303 | MUST | One shared function `groupKindOf({ groupTypes, mailEnabled, securityEnabled })` returns `m365`, `security`, `mailsecurity`, `distribution` or `unknown` from the table of R-C-04 (`unknown` when a property is `null`, U36). It is used by the server mapper and the web; no second derivation exists. A read-only badge (`mailsecurity`, `distribution`: "read-only in Microsoft Graph") accompanies the kind. | `shared/group-kind.test.ts` (exhaustive over the property combinations) |
| FR-C-304 | MUST | `GET /api/v1/groups/{id}` (P37, `groups.get`): `getGroup`, then `ctx.authorizeResource('groups:read', { type: 'group', id, displayName, alias, mail })`; unknown id 404; outside the visible scope 403 `permission_denied` (ODB-11). Fields: `id`, `displayName`, `description`, `mail`, `mailNickname`, `kind`, `visibility`, `membershipType` (`assigned` or `dynamic` from `groupTypes`), `onPremisesSyncEnabled`, `createdDateTime`. Membership rules are shown as text for dynamic groups; there is no editor. | `server/directory/groups-routes.test.ts` |
| FR-C-305 | MUST | `GET /api/v1/groups/{id}/owners` (P38, `groups.owners`): after FR-C-304's authorisation, owners are listed paged (R-C-06). Rows are `DirectoryRef` of kind `user` or `other` (service principals). For a group of kind `distribution`, `mailsecurity` or with `onPremisesSyncEnabled = true` an empty list carries `ownersState: 'not_available'` (R-C-06). | `server/directory/groups-routes.test.ts` |
| FR-C-306 | MUST | `GET /api/v1/groups/{id}/members` (P39, `groups.members`): after FR-C-304's authorisation, direct members are listed paged with `$select=id,displayName,mail,userPrincipalName` (U71), kinds `user`, `group`, `other`. A `HiddenMembership` group answers `membersState: 'hidden'` and an empty list (FR-C-108). No total is computed from a scan; the page shows "n shown" only. | `server/directory/groups-routes.test.ts` |
| FR-C-307 | MUST | Restricted rows: a member or owner of kind `user` is returned in full only if the actor's `visibleScopes('users:read')` contains it (projected by `projectUser` when only `basic` matches); of kind `group` only if `visibleScopes('groups:read')` contains it; anything else becomes `{ kind, restricted: true }` with **no id, name or address**. The restricted count is shown ("3 members you cannot see"): it is the number of restricted rows of the page, no field of its own. One function does this for members and owners, and also for the manager of a user: a manager the actor may not see is `manager: { state: 'present', user: <restricted row> }` (amended at GC0, T-C-004: otherwise the detail would hand an out-of-scope user's name to a scoped actor). | `server/directory/restricted-rows.test.ts` (+ negative: a handler that returns the raw row fails) |

### 6.4 Policy, errors and audit

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-C-401 | MUST | The seven routes (table 6.7.1) are declared with `defineRoute`, are `GET`, class `read`, access `permission` with `scoped` set, and every handler asks `ctx.visibleScopes` or `ctx.authorizeResource` (otherwise the wrapper's 500 `policy_not_applied` fires). The services behind them take the capability values (`VisibleScope`, `AuthorizedResource`) as arguments and cannot be called without them (PB-25, ADR-0175). | `server/directory/policy-applied.test.ts` (route table driven, fake handler that skips the check gets 500), `server/directory/capability-types.test.ts` (type-level test, `@ts-expect-error` fixtures) |
| FR-C-402 | MUST | Phase C adds no route with a method other than GET and declares no `audit` action: the route table test fails when a Phase C route id has another method. Denials are audited by the wrapper with the route id as action and the reasons `permission_missing` or `scope_mismatch` (FR-B-602). Successful reads are not audited unless ODC-01 is decided otherwise. Nothing is written to the database by these routes. | `server/directory/routes-table.test.ts`, `server/audit-denials.test.ts`, `server/directory/no-writes.test.ts` (the database file is byte-identical before and after a request mix) |
| FR-C-403 | MUST | Responses carry `Cache-Control: no-store` (they hold personal data) and the Phase B security headers unchanged. `/api/v1/users*` and `/api/v1/groups*` join the `no-store` list of FR-B-417. The service worker does not cache them (it already passes `/api/*` through, PB-18). | `server/cache-headers.test.ts` (extended list), `server/security-headers.test.ts` |
| FR-C-404 | MUST | New problem codes (table 6.7.3) have status, English title and nl/en messages with a remedy line. The UI shows translated text only, never server `detail`, never text copied from Microsoft. Display names, addresses and similar values are data: rendered as text, never as HTML, never interpreted as markup or links. | `shared/error-codes.test.ts`, `shared/message-keys.test.ts`, `web/no-html-injection.test.tsx` (names such as `<img src=x onerror=...>`) |
| FR-C-405 | MUST | Logs and errors never carry display names, addresses, user principal names, search text or ids from Graph answers (Phase B FR-B-313 rule). Log fields: route, status, count, duration. | `server/directory/no-pii-in-logs.test.ts` (canary names in the fake tenant, log sink scanned) |

### 6.5 Web

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-C-501 | MUST | `/users` and `/groups` (existing files, placeholders replaced) and the new `/users/$id` and `/groups/$id` (TanStack file routes; `staticData.titleKey`; `beforeLoad: requirePermission(['users:read'])` or `['groups:read']`; `gatedPage(..., NoAccess)`). Filters, search text, order and the cursor live in validated URL search parameters, so a reload and a shared link show the same view. Data comes from TanStack Query with keys per route and parameters, `placeholderData` while paging, no refetch on window focus for lists. | `web/routes-coverage.test.ts` (+ negative), `web/users-page.test.tsx`, `web/groups-page.test.tsx`, `web/gating.test.tsx` |
| FR-C-502 | MUST | Lists use the design system `DataTable` (semantic `table`, `th scope`, a caption, sortable header for display name as a button with `aria-sort`), a search field with a visible label, filters as `Select` or `SegmentedControl`, and "Previous/Next" controls that move through cursors (previous pages are remembered in component state). Loading shows `Skeleton`, empty shows `EmptyState` with the replication note (EC-C12), failure shows `ErrorState` with "try again". Row activation is a link in the first cell (keyboard and screen reader); no row-click-only behaviour. | `web/users-page.test.tsx`, `web/groups-page.test.tsx`, `e2e/keyboard.spec.ts` (extended) |
| FR-C-503 | MUST | Detail pages: a heading with the display name, a definition list of core properties, a `Tabs` or sectioned layout for manager and groups (user) or owners and members (group); each section loads and fails on its own (a failed members call does not hide the owners). The hidden, restricted, unavailable, none and not-available states of section 5 each have a distinct translated message. Guest users and read-only kinds are marked with text, not colour alone. Copy buttons are not offered for personal data in Phase C. | `web/user-detail.test.tsx`, `web/group-detail.test.tsx` |
| FR-C-504 | MUST | Every new string exists in `nl` and `en` in the lazy namespaces `users` and `groups` (`LAZY_NAMESPACES`, `NAMESPACE_OWNERS`, `load-namespace.ts`, lazy JSON files), loaded by the route loader; shared words (`nav.users`, `nav.groups`, problem messages) stay where they are. The placeholders `placeholders.users.description` and `placeholders.groups.description` are removed from the entry catalogue. Catalogue checks of baseline section 12 run on the merged files. | `shared/i18n-fragments.test.ts`, `shared/i18n-catalogue.test.ts` (+ negative), `shared/message-keys.test.ts`, `quality` (lint: no literal UI strings) |
| FR-C-505 | MUST | Bundle: the initial JavaScript, entry CSS and first-load numbers of `scripts/bundle-budget.json` do not grow (no `approvedGrowth` entry is added); the pages and both namespaces are separate chunks. | `pnpm bundle:check` (CI `quality`) |
| FR-C-506 | MUST | Accessibility (WCAG 2.2 AA): axe with the Phase B tag set and zero violations on the four routes in light and dark at both viewport sizes, in the states loaded, empty, error, restricted rows and hidden membership; focus moves to the page heading on navigation and back to the search field after a filter change announces the result count in a polite live region; targets at least 24 by 24 CSS px; complete keyboard operation of search, filters, paging, row links and detail sections. | `e2e/a11y.spec.ts` (route and state list), `e2e/keyboard.spec.ts`, `web/users-page.test.tsx` |
| FR-C-507 | MUST | Visual baselines (light and dark, desktop and mobile) for `/users` (loaded, empty), `/users/$id`, `/groups` (loaded), `/groups/$id` (with hidden membership note). **Baselines come from the CI runner artefact, never from this sandbox** (Phase B rule PB-21 and the e2e README). | `e2e/visual.spec.ts` |
| FR-C-508 | SHOULD | Lighthouse at least 95 on `/users` and `/groups` with a session created through the fake sign-in; **reported, not gated** (the owner group is informed). | `e2e` step "Lighthouse" (route list extended) |

### 6.6 Tests, fake tenant, documentation

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-C-601 | MUST | The fake tenant (`apps/server/test/fakes/fake-tenant/graph`) is extended to the routes of FR-C-101 and stays **strict like the real service**: `$top` above 999 is 400; `$skip` is 400; `@odata.nextLink` paging with an opaque `$skiptoken`; `$select` honoured; `$filter` accepts exactly the grammar of FR-C-202 and FR-C-301 (`startsWith`, `eq`, `and`, `or`, `not`, `groupTypes/any(c:c eq 'Unified')`) and refuses anything else with 400 `Request_UnsupportedQuery`; `$orderby` together with `$filter`, any `$count=true`, any `startsWith` on a non-default property combination and the `not` operator all **require** `ConsistencyLevel: eventual` and `$count=true` (400 otherwise); `/groups/{id}/members` and `/owners` require the advanced pair for every query option except `$expand`; `memberOf` for an application token is refused (needs `Directory.Read.All`); the manager call is refused to application tokens in a switchable mode (U66, default: refused) and answered 404 for users without one; hidden-membership groups refuse members without `Member.Read.Hidden`; owners are empty for distribution and synced groups; limited-information members (`id` and `@odata.type` only) appear for object types the token cannot read. Seed data (`seedDirectory`) offers 1,200 users and 150 groups of all kinds, including names with quotes, diacritics, a guest, a disabled user, a user with no manager and a 250-member group. | `server/fakes/fake-tenant.selftest.test.ts` (strictness: each refusal has a case), `server/integrations/graph/contract.test.ts` |
| FR-C-602 | MUST | End-to-end tests with Playwright against the fake tenant (three-process topology of Phase B): `e2e/users.spec.ts` and `e2e/groups.spec.ts` cover US-C1 to US-C6, including a scoped actor and a `basic` actor created through the real RBAC API. | `e2e` |
| FR-C-603 | MUST | Documentation in Dutch and English: `docs/permissions.md` (Phase C reads, `GroupMember.ReadWrite.All` granted, unused; deferred list), `docs/api.md` or the OpenAPI section (seven routes), `docs/operations.md` limits table rows (FR-C-701), the README feature list, `docs/open-points.md` (done by the documentation task), one ADR block for the cursor store and the restricted-row rule. | `server/docs-contract.test.ts`, `server/limits-doc.test.ts` |
| FR-C-604 | MUST | Phase C adds no deployment-file change: no new environment variable, no Compose change, no `.env.example` change, no migration. The PR body says so in one line (AGENTS.md deployment-file rule). `VERSION` is bumped (runtime code changes). | `server/deploy-files.test.ts` (unchanged), `enforce-version-bump` |

### 6.7 Reference tables (normative)

#### 6.7.1 Route index (continues Phase B table 6.9.7, P33 and up)

| # | Id | Method and path | Permission | Class | Audit |
|---|---|---|---|---|---|
| P33 | `users.list` | `GET /api/v1/users` | `users:read` (scoped `user`) | read | denials only |
| P34 | `users.get` | `GET /api/v1/users/{id}` | `users:read` (scoped `user`) | read | denials only |
| P35 | `users.groups` | `GET /api/v1/users/{id}/groups` | `users:read` and `groups:read` | read | denials only |
| P36 | `groups.list` | `GET /api/v1/groups` | `groups:read` (scoped `group`) | read | denials only |
| P37 | `groups.get` | `GET /api/v1/groups/{id}` | `groups:read` (scoped `group`) | read | denials only |
| P38 | `groups.owners` | `GET /api/v1/groups/{id}/owners` | `groups:read` (scoped `group`) | read | denials only |
| P39 | `groups.members` | `GET /api/v1/groups/{id}/members` | `groups:read` (scoped `group`) | read | denials only |

P35 requires two permissions; the route declares `users:read` and the handler additionally calls `ctx.visibleScopes('groups:read')`, which denies with `permission_missing` when the actor holds none (FR-C-206).

#### 6.7.2 Limits (constants in `packages/shared/src/limits.ts`, key `directory`; rows added to `docs/operations.md`)

| Constant | Value | Meaning |
|---|---|---|
| `searchMaxChars` | 64 | `q` length (EC-C1) |
| `pageLimitDefault`, `pageLimitMax` | 100, 200 | The Phase B list convention (CD-10); the UI asks for 50 |
| `graphPageSize` | 999 | `$top` for scope scans (R-C-01) |
| `scanPagesMax` | 5 | Graph pages read per request for a scoped list (FR-C-203) |
| `cursorTtlSeconds`, `cursorEntries` | 600, 1,000 | Cursor store (FR-C-103) |

No request body is added, so the largest accepted request of the application is unchanged (9,437,184 bytes).

#### 6.7.3 Problem codes added

| Code | Status | Meaning |
|---|---|---|
| `cursor_invalid` | 400 | Unknown, expired or foreign list cursor (restart the list) |

Everything else reuses `permission_denied`, `not_found`, `validation_failed`, `graph_unavailable`, `graph_throttled`. New `errors[]` detail code: `graph_permission_missing` (message keys in both catalogues).

---

## 7. Success criteria

| ID | Criterion | Measured by |
|---|---|---|
| SC-C1 | A 1,200-user fake tenant pages through completely in order with no duplicate or gap, for `all` and for a scoped actor | `server/directory/scoped-list.test.ts`, `e2e/users.spec.ts` |
| SC-C2 | No Phase C route writes anything: route methods, the Graph client's methods and the database bytes prove it | FR-C-105, FR-C-402 tests |
| SC-C3 | No licence data, no new permission, no new environment variable | FR-C-105, FR-C-207, FR-C-604 |
| SC-C4 | A page of 100 users renders from a warm server in under 300 ms from the fake tenant at the 95th percentile (informational; real timing is the owner's, OV-C3) | `server/directory/perf.test.ts` (reported) |
| SC-C5 | Zero axe violations on all four routes and states; keyboard-only completion of US-C1 to US-C3 | `e2e/a11y.spec.ts`, `e2e/keyboard.spec.ts` |
| SC-C6 | The bundle budget numbers are unchanged | `pnpm bundle:check` |
| SC-C7 | The owner's real-tenant checklist (section 8.4) is executable in under 30 minutes | the phase report step list |

---

## 8. Microsoft facts, permissions and the owner-verified ledger

### 8.1 What was read, and what it settled

See `research-microsoft-c.md` (R-C-01 to R-C-10, read 2026-10-12). Settled by Learn: list users and groups options, page sizes and the advanced-query rule; `GroupMember.Read.All` is accepted for group list, members and owners; `transitiveMemberOf` with `User.Read.All`; `memberOf` for another user needs `Directory.Read.All` (so it is not used); group kinds by property; dynamic distribution groups are not returned; owners are unavailable for Exchange-created, distribution and synced groups; hidden membership needs `Member.Read.Hidden`.

### 8.2 Facts the design rests on (all Learn-verified unless marked)

1. Advanced query pair on every list (R-C-01, R-C-02). 2. No `$skip`; follow `nextLink` (R-C-01). 3. The four group-kind filters (R-C-03). 4. A manager call may fail for application permissions (R-C-07, U66). 5. Limited information for object types the app cannot read (R-C-05).

### 8.3 UNVERIFIED register (new in this document; copy to `docs/open-points.md`, date 2026-10-12)

| # | Claim | Where used | Tried | Needed to close |
|---|---|---|---|---|
| U66 | `GET /users/{id}/manager` (and `$expand=manager`) works for an application token holding `User.Read.All`; the List manager page says Application: "Not supported", a sibling page lists `User.Read.All` | FR-C-107, EC-C6 | List manager page read 2026-10-12 | OV-C2; the design already degrades to "not available" |
| U67 | What Graph answers for the members of a `HiddenMembership` group without `Member.Read.Hidden` (empty list or 403), and whether such groups are missing from a user's `transitiveMemberOf` | FR-C-108, FR-C-206 | permissions text and members page read | OV-C5; the panel does not call members for such groups |
| U68 | `GET /groups/{id}/owners` accepts `GroupMember.Read.All` for application tokens (the PowerShell page says so; the REST permission table was seen only in part) | FR-C-305 | Get-MgGroupOwner page, owners page excerpt | OV-C4 |
| U69 | The distribution and mail-enabled-security filters (`not groupTypes/any(c:c eq 'Unified') and mailEnabled eq ... and securityEnabled eq ...`) combined with `$orderby=displayName`, `$count=true` and the header work for an application holding only `GroupMember.Read.All`; and that `$select` of `visibility`, `mailNickname`, `description`, `onPremisesSyncEnabled` is returned (extends U36) | FR-C-301, FR-C-304 | group-list page filter table | OV-C1 |
| U70 | `startsWith` joined by `or` over `displayName`, `mail`, `userPrincipalName`, combined with `and accountEnabled eq ...`, `userType eq ...` and `$orderby=displayName` under the advanced pair is accepted | FR-C-202 | each part is documented alone (advanced-queries property table) | OV-C1; fallback: drop `or` to `displayName` only |
| U71 | `$select=id,displayName,mail,userPrincipalName` on the polymorphic members and owners collections returns those properties for users (and `displayName`, `mail` for groups) | FR-C-306 | members page: query options supported | OV-C4; fallback: no `$select`, parse the defaults |
| U72 | The literal values of `userType` are `Member` and `Guest`, and users whose `userType` is null exist; "member" then means `Member` only | FR-C-202 | property table says `eq` and `eq null` work | OV-C1 (count with a null-type user) |
| U73 | A `nextLink` of an advanced query keeps working without resending `ConsistencyLevel` (the client always resends it, so this only matters if it is not needed) | FR-C-103 | not stated on the pages read | none; harmless; recorded for the contract suite |
| U74 | Which properties `transitiveMemberOf/microsoft.graph.group` returns for an application holding `User.Read.All` and `GroupMember.Read.All` (the limited-information rule) | FR-C-206 | permissions-overview excerpt | OV-C5; groups with `null` names show a dash |

Carried and still open: U1 (alone-permission), U8 (on-premises synced groups), U17 and U48 (licences; deferred by the owner, 2026-10-13), U36 and U37 (group properties and filter without the header under `GroupMember.Read.All`; U36's "is it listed" half is closed by R-C-03). Phase C sends the advanced pair always, so U37 does not matter for its own calls.

### 8.4 Owner-verified ledger (the owner's real-tenant test of Phase C; none is covered by an automated control)

| ID | Check | Closes |
|---|---|---|
| OV-C1 | Users: search "a", filter disabled, filter guest, order descending; Groups: all four kinds; compare counts with the Entra portal | U69, U70, U72, U36 |
| OV-C2 | Open a user who has a manager and one who has none; note whether "not available" appears | U66 |
| OV-C3 | Open the first page of 100 users and note the time; page to the end in a tenant with more than 1,000 users | SC-C4, U73 |
| OV-C4 | Open a Microsoft 365 group with owners and members; a group with more than 100 members pages | U68, U71 |
| OV-C5 | Open a hidden-membership group and a user who belongs to one | U67, U74 |
| OV-C6 | Sign in as an actor with `users:read` limited by department, and as one with `basic`; confirm 403 on an outside user, restricted rows in a group | FR-C-203, FR-C-204, FR-C-307 |

---

## 9. Assumptions

| ID | Assumption | Evidence |
|---|---|---|
| AC-01 | The tenant is a workforce tenant (not Azure AD B2C), so `$count` and `$search` exist | R-C-01 note |
| AC-02 | A tenant has at most some tens of thousands of users; a scan of 5 Graph pages per request is acceptable for scoped lists | owner's tenant size is unknown; limit is a constant |
| AC-03 | Display names and addresses are not secret from an actor who may see the object, but are personal data: no logs, no cache on disk | FR-C-405 |
| AC-04 | Only direct group members are needed in the first version | owner decision 1 (slim) |
| AC-05 | The role templates of Phase B grant `users:read` and `groups:read` as needed; no role change is part of Phase C | `docs/permissions.md` Part 3 |

---

## 10. Owner decisions

Recorded decisions (owner, **2026-10-13**), implemented as stated:

| ID | Decision | Effect |
|---|---|---|
| D-C1 | Scope of the first version: read only (users and groups as in section 1.1); no create/update/delete, no group membership writes, no password reset, no licence changes; no new Graph write permission; `GroupMember.ReadWrite.All` stays unused (ODB-02 default) | sections 1.1, 1.2, FR-C-105, FR-C-402 |
| D-C2 | ODB-11 is closed: a single object (user or group) outside the actor's visible scope answers 403 `permission_denied`; lists filter by `visibleScopes` | FR-C-203, FR-C-205, FR-C-304 |
| D-C3 | No licence column in the users list; U17 stays open, recorded as deferred | FR-C-207 |

New decisions, each with a default so that nothing blocks:

| ID | Decision | Options | Default in this spec | Needed by |
|---|---|---|---|---|
| ODC-01 | Audit of successful reads | Denials only (the code today, FR-B-602; default); or also an entry per detail view (`users.get`, `groups.get`); or per list | Denials only. The brief asks for "every refused action"; ODB-12 concerned denials. A success entry per detail view needs a new action and detail keys (small) | The owner test |
| ODC-02 | Distribution and mail-enabled security groups in the Groups list for `groups:read` | Shown read-only with a badge (default); or hidden until Phase D has `distributionlists:read` | Shown, read-only, badge. They are real groups to Graph; hiding them would make the list incomplete | The Phase C gate |
| ODC-03 | Search semantics | Prefix on name, mail and principal name (default); or tokenised `$search` | Prefix: it composes with filters and order, and matches how scopes work. `$search` can be added later | The owner test |
| ODC-04 | Hidden-membership groups | State "hidden" and make no call (default); or request `Member.Read.Hidden` in a later phase | State "hidden". The permission would be a new consent; not worth it in a read-only first version | After OV-C5 |
| ODC-05 | Manager | Best effort, degrades to "not available" (default); or drop the manager until U66 is closed | Best effort | After OV-C2 |

---

## 11. Risks

| ID | Risk | L / I | Mitigation |
|---|---|---|---|
| RC-01 | `GroupMember.Read.All` alone returns too few group properties (U36), so kinds show as `unknown` | M / M | `unknown` is a designed state; fallback ladder of Phase B plan 8.8; OV-C1 |
| RC-02 | The manager call is refused for applications (U66) | H / L | Designed degradation; no new permission is requested to fix it |
| RC-03 | Scoped lists of a very large tenant are slow (5 pages per request) | L / M | Constant limit, cursor resume, no total; revisit with real timing (OV-C3) |
| RC-04 | The fake tenant's strictness encodes a wrong reading of Learn | M / M | Strictness self-test, contract suite on both implementations, ledger OV-C1 to OV-C6 |
| RC-05 | Restricted rows or the cursor store leak information | L / H | One function for restricted rows with a negative control; cursors bound to the actor, random, short-lived |
| RC-06 | CSS growth from two new pages pushes the entry CSS over the budget | M / L | Reuse design-system components only; if over, stop and ask for an approved growth (not assumed) |

---

## 12. Dependencies and what Phase C hands to Phase D

Phase C needs from Phase B: `GraphClient` and `GraphHttp`, the route wrapper and policy layer (`visibleScopes`, `authorizeResource`, branded capabilities), `projectUser`, `matchScope`, `PageQuerySchema`, the DataTable and design system, lazy namespaces, the fake tenant and the Phase B e2e topology. It hands to Phase D: the cursor store and restricted-row function (reusable for distribution lists and contacts), `groupKindOf` (distribution groups are the bridge to the distribution-list pages), and the open questions U66 to U74. No Phase B file changes except the listed seams (plan section 5.4): `modules.ts`, the `GraphClient` port and fake, `limits.ts`, `problem.ts`, i18n lazy lists, the two route files, `permissions-map.ts`, `cache-headers`, docs.
