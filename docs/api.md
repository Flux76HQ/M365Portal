# API reference: users and groups (Phase C), distribution lists, contacts, group members and the CSV export (Phase D steps D1 and D2)

> Nederlandse versie: zie [Nederlands](#nederlands). The machine-readable contract of every route is the
> OpenAPI 3.1 document the server generates from its route table, served at `GET /api/v1/openapi.json`; the
> wire schemas are in `packages/shared/src/schemas/` (`directory.ts` for Phase C; `distribution-lists.ts`,
> `contacts.ts` and `member-writes.ts` for step D1). This page is the human reading of the seven read-only
> routes Phase C adds (P33 to P39) and of the fourteen routes of Phase D step D1 (P40 to P45 and P47 to P54,
> which write) and of the two routes of the CSV export of step D2 (P46 and P55; `schemas/export.ts`). Routes of
> the earlier phases are in
> [`specs/002-phase-b/contracts/phase-b-api.md`](../specs/002-phase-b/contracts/phase-b-api.md). The rest of
> step D2 (the audit screen) and D3 (roles, rotation) add their routes later.

## English

### What is common to the seven routes of Phase C

- All are `GET` under `/api/v1`, rate class `read` (capacity 120, refill 2 per second per client address,
  [limits](operations.md#limits-outside-the-repository)), and need a signed-in session. Every response has
  `Cache-Control: no-store`. No route of Phase C writes anything; any other method on these paths is 405.
- The permissions and the scopes are those of the panel's role model ([permissions.md](permissions.md),
  Part 3 and Part 4). The server enforces them; the pages only hide.
- A query is strict: an unknown parameter, a text longer than 64 characters or with control characters, a
  `limit` outside 1 to 200, or an `id` that is not a GUID is 422 `validation_failed`. A user principal name
  is not accepted as an id.
- Errors are `application/problem+json` as everywhere ([phase-b-api.md](../specs/002-phase-b/contracts/phase-b-api.md)).
  The `detail` is generic English and is not shown by the UI; Microsoft text, ids and names never appear.
- Text values are at most 256 bytes. A value Microsoft did not return is `null`, never a missing key.
  Names and addresses are data: the web app renders them as text.
- **No total anywhere.** A count would show the size of a scope.

### Paging

A list answers `{ "items": [...], "nextCursor": "..." }`. `limit` is the text of a whole number from 1 to 200
(default 100; the web app asks for 50). `nextCursor` is absent at the end of the list; otherwise pass it
back as `cursor` with the same other parameters to get the next page.

- The cursor is an opaque 24-character handle (URL-safe). It is not Microsoft's link and carries no data. It
  is valid for the actor who received it, on that route, with the same search text, filters, order and group
  or user, for 600 seconds after it was made or last used. The server keeps at most 1,000 handles in memory
  (least recently used out), so a restart also ends them. Anything else (another actor, another list, a
  changed filter, an expired or unknown handle) is 400 `cursor_invalid`; start again without a cursor
  ([ADR-0179](adr/0179-directory-cursor-store-and-restricted-rows.md)).
- **A page may hold fewer rows than `limit`, even none, and still carry a `nextCursor`.** An actor whose
  rights are limited to part of the tenant is served by reading at most five Microsoft pages of 999 rows
  per request and keeping the rows the actor may see. Keep asking until `nextCursor` is absent. A row
  never appears twice and none is lost between pages.
- Microsoft Graph does not accept `$skip` on these lists, so there are no page numbers and no jump to the
  last page.

### Routes

| Id | Request | Permission | Answers |
|---|---|---|---|
| P33 `users.list` | `GET /api/v1/users` | `users:read`, scoped | 200, 400, 422, 503 |
| P34 `users.get` | `GET /api/v1/users/{id}` | `users:read` on that user | 200, 403, 404, 422, 503 |
| P35 `users.groups` | `GET /api/v1/users/{id}/groups` | `users:read` (full) on that user and `groups:read` | 200, 400, 403, 404, 422, 503 |
| P36 `groups.list` | `GET /api/v1/groups` | `groups:read`, scoped | 200, 400, 422, 503 |
| P37 `groups.get` | `GET /api/v1/groups/{id}` | `groups:read` on that group | 200, 403, 404, 422, 503 |
| P38 `groups.owners` | `GET /api/v1/groups/{id}/owners` | `groups:read` on that group | 200, 400, 403, 404, 422, 503 |
| P39 `groups.members` | `GET /api/v1/groups/{id}/members` | `groups:read` on that group | 200, 400, 403, 404, 422, 503 |

A caller without the permission, or with no session, gets the standard 403 or 401 before any of these
answers; the 403 of a single object outside the caller's scope is `permission_denied` and is audited
(reason `scope_mismatch`). An unknown id is 404 `not_found`. The check order is: existence (404), then scope
(403).

#### P33 `GET /api/v1/users`

Query: `q` (prefix text, 1 to 64 characters), `enabled` (`all` default, `true`, `false`), `type` (`all`
default, `member`, `guest`), `order` (`asc` default, `desc`; always by display name), `limit`, `cursor`.

- `q` is a prefix match (starts with) on display name, e-mail address and principal name. It is not a
  word search: "ann" finds "Ann Jansen", not "Marianne".
- A row is either the **full row** `{ id, displayName, userPrincipalName, mail, department, jobTitle,
  accountEnabled, userType }` (`userType` is `member`, `guest` or `null`) or, for a user the caller sees
  only through a `basic` grant, the **basic row** `{ id, displayName, mail }`.
- **Filters for basic actors.** A caller who is shown any user as `basic` and does not see every user in
  full gets 422 `validation_failed` with `errors[0] = { "pointer": "query/enabled" | "query/type", "code":
  "filter_not_allowed" }` when `enabled` or `type` is not `all`; for such a caller the principal name is also
  left out of the search. The filter would otherwise reveal a property the grant hides.
- "Member" means the Microsoft `userType` `Member` only; a user whose type Microsoft does not return has
  `userType: null` and matches neither filter value (U72).
- There are no licence fields, filters or columns (decision of the owner, 2026-10-13).

#### P34 `GET /api/v1/users/{id}`

The full detail has `id`, `displayName`, `givenName`, `surname`, `userPrincipalName`, `mail`, `department`,
`jobTitle`, `officeLocation`, `accountEnabled`, `userType`, `onPremisesSyncEnabled`, `createdDateTime`
(UTC, with milliseconds) and `manager`. A `basic` caller gets `{ id, displayName, mail }` and nothing else.

`manager` is best effort and always present:

| `manager` | Meaning |
|---|---|
| `{ "state": "present", "user": <row> }` | The manager, as a full row, a basic row, or a restricted row when the caller may not see that user |
| `{ "state": "none" }` | The user has no manager (Microsoft answered 404) |
| `{ "state": "unavailable" }` | Microsoft refused or could not answer the manager call. For application permissions the Learn page says "Not supported" (U66); the rest of the user is still returned |

#### P35 `GET /api/v1/users/{id}/groups`

Query: `limit`, `cursor`. The groups the user belongs to, **nested groups included** (transitive), as group
rows `{ id, displayName, mail, kind, visibility }`. Groups the caller may not see are **left out**, never
shown as restricted, so membership cannot be probed. Groups with hidden membership may be missing (U67).
403 `permission_denied` when the caller has no `groups:read`, or sees the user only as `basic`.

#### P36 `GET /api/v1/groups`

Query: `q` (prefix on display name, e-mail address and mail nickname, 1 to 64 characters), `kind` (`all`
default, `m365`, `security`, `mailsecurity`, `distribution`), `order`, `limit`, `cursor`. A row is
`{ id, displayName, mail, kind, visibility }`; `kind` is `m365`, `security`, `mailsecurity`, `distribution`
or `unknown` (a property Microsoft did not return, U36); `visibility` is `Private`, `Public`,
`HiddenMembership` or `null`. Mail-enabled security and distribution groups are listed and are read-only in
Microsoft Graph. **Dynamic distribution groups are not returned by Graph**, so the `distribution` kind is
never claimed to be complete.

#### P37 `GET /api/v1/groups/{id}`

`{ id, displayName, description, mail, mailNickname, kind, visibility, membershipType, onPremisesSyncEnabled,
createdDateTime }`. `membershipType` is `assigned`, `dynamic` or `null`. The membership rule of a dynamic
group is not part of the answer.

#### P38 `GET /api/v1/groups/{id}/owners` and P39 `GET /api/v1/groups/{id}/members`

Query: `limit`, `cursor`. Direct members only (no nested expansion). Answers `{ items, ownersState |
membersState, nextCursor? }`. A row is one of:

- a **reference** `{ kind: "user" | "group" | "other", id, displayName, mail, userPrincipalName }`; for a user
  the caller sees only as `basic` the `userPrincipalName` is `null`, and for an `other` object (device,
  service principal, contact) only `id` and `kind` are filled;
- a **restricted row** `{ kind, restricted: true }` for an object the caller may not see: no id, no name, no
  address. The count of restricted rows on a page is the number of such rows; the answer has no field for it.

States: `ownersState` is `listed` or `not_available` (an empty list for distribution, mail-enabled security
and on-premises-synced groups, for which Microsoft has no owners). `membersState` is `listed` or `hidden`
(the group has hidden membership; the list is empty, there is no cursor and Microsoft is not asked).

### Problem codes of these routes

| Status | Code | When |
|---|---|---|
| 400 | `cursor_invalid` | Unknown, expired or foreign cursor, or a cursor from another list or filter |
| 401 | `unauthenticated`, `session_expired` | No valid session |
| 403 | `permission_denied` | Missing permission, a single object outside the scope, or a basic caller on P35 |
| 404 | `not_found` | Unknown id |
| 422 | `validation_failed` | Bad query or path; `filter_not_allowed` for a basic caller (P33) |
| 503 | `graph_unavailable` | Microsoft unavailable. With `errors[0].code` `graph_permission_missing` when the panel's own application lacks a permission (`Retry-After: 30`); the web app points to Settings, Connection |
| 503 | `graph_throttled` | Microsoft asked for a wait of more than 60 seconds |
| 503 | `secrets_unavailable` | The sealing key or the stored secrets are unusable |

### Limits

The numbers (search text 64 characters, page size 100 and at most 200, Microsoft page size 999, five
Microsoft pages per scoped request, cursor lifetime 600 seconds and 1,000 cursors) are in
[operations.md](operations.md#limits-outside-the-repository). Phase C adds no request body, so the largest
request the application accepts stays 9,437,184 bytes, and no environment variable, Compose line,
`.env.example` entry or database migration. (Step D1 adds write bodies and one variable, below.)

### Phase D step D1: distribution lists, contacts and group members

> **Status:** step D1 (2026-10-13). Fourteen routes: P40 to P45 (distribution lists), P47 to P52 (mail
> contacts) and P53 and P54 (members of Microsoft 365 and security groups). P46 (export preview) and
> everything after it belong to steps D2 and D3. The wire schemas are in
> `packages/shared/src/schemas/{distribution-lists,contacts,member-writes}.ts`; the spec table is section
> 6.11.1 of `specs/004-phase-d/spec.md`. **Nothing here has run against a real Microsoft 365 tenant**: what
> Exchange and Graph answer is the subject of the owner test [owner-test-phase-d1.md](owner-test-phase-d1.md).

**Route ids are lower case** (`distributionlists.list`, not `distributionLists.list`): the id of a route is
the `action` of its denial entries in the audit log, and the audit action grammar has no capital letter. The
OpenAPI tag stays `distributionLists`.

#### What is common to the fourteen routes

- All are under `/api/v1`, need a signed-in session and are answered with `Cache-Control: no-store`. The
  reads are class `read` (capacity 120, refill 2 per second per client address); the writes are class
  `write` (capacity 10, refill 0.5 per second) and need the CSRF token and a same-origin `Origin` like every
  write ([limits](operations.md#limits-outside-the-repository)). Any other method on a path is 405.
- The permission and the scope are those of the role model ([permissions.md](permissions.md), Parts 3 to
  5), checked on the server for the one object (`distributionList`, `contact` or `group`). The order of the
  checks is: existence (404), then scope (403 `permission_denied`, audited with reason `scope_mismatch`),
  then the state of the object (409 `read_only_object`).
- **Ids are GUIDs.** A distribution list and a contact are identified by their Exchange GUID, a Microsoft 365
  or security group by its Entra object id, a user by its Entra object id (also as a member of a list; that
  `ExternalDirectoryObjectId` is UNVERIFIED on member rows, OV-D1 and OV-D5). A member of a list without an
  Entra id is shown by its Exchange GUID.
- A query is strict, as in Phase C: an unknown parameter, a text of more than 64 characters or with control
  characters, a `limit` outside 1 to 200 or an `id` that is not a GUID is 422 `validation_failed`.
- **No total anywhere**, and the Phase C paging rules apply: `{ "items": [...], "nextCursor": "..." }`, an
  opaque 24-character cursor bound to the actor, route and parameters, valid 600 seconds, kept in memory
  (a restart ends it: 400 `cursor_invalid`), and a page may hold fewer rows than `limit`
  ([ADR-0179](adr/0179-directory-cursor-store-and-restricted-rows.md)). The lists and contacts come from
  Exchange, which does not page: the server reads the result once, keeps it in memory for the cursor
  (`exchange.listBufferMax`, 10,000 rows) and pages over it. A search that matches more than 10,000 rows is
  422 `validation_failed` with `errors[0] = { "pointer": "/q", "code": "narrow_search" }`; the
  catalogue has a message for that detail code (`distributionLists.error.narrow_search` and, on the contacts
  pages, `contacts.error.narrow_search`, in both languages).
- Names and addresses are data: the web app renders them as text, the logs never contain them, and no audit
  entry holds a name, an address or a field value (only ids and field names).
- Microsoft text never reaches a response. The `detail` of a problem is generic English.

| Id | Request | Permission (scoped) | Audit | Answers |
|---|---|---|---|---|
| P40 `distributionlists.list` | `GET /api/v1/distribution-lists` | `distributionlists:read`, scoped | denials | 200, 400, 422, 503 |
| P41 `distributionlists.get` | `GET /api/v1/distribution-lists/{id}` | `distributionlists:read` on that list | denials | 200, 403, 404, 422, 503 |
| P42 `distributionlists.members` | `GET /api/v1/distribution-lists/{id}/members` | `distributionlists:read` on that list | denials | 200, 400, 403, 404, 422, 503 |
| P43 `distributionlists.members.add` | `POST /api/v1/distribution-lists/{id}/members` | `distributionlists:members:write` on that list | `dl.member.add` | 200, 403, 404, 409, 422, 503 |
| P44 `distributionlists.members.remove` | `DELETE /api/v1/distribution-lists/{id}/members` | `distributionlists:members:write` on that list | `dl.member.remove` | 200, 403, 404, 409, 422, 503 |
| P45 `distributionlists.search` | `GET /api/v1/distribution-lists/{id}/candidates?q=` | `distributionlists:members:write` on that list, plus `users:read` and `contacts:read` for what is offered | denials | 200, 400, 403, 404, 409, 422, 503 |
| P46 `distributionlists.export.preview` | `POST /api/v1/distribution-lists/{id}/export/preview` | `distributionlists:export` on that list, plus `users:read`, `contacts:read` and `groups:read` for what is shown | denials | 200, 403, 404, 422, 503 |
| P55 `distributionlists.export` | `POST /api/v1/distribution-lists/{id}/export` | `distributionlists:export` on that list (fresh step-up), plus `users:read`, `contacts:read` and `groups:read` for what is exported | `dl.export` | 200, 403, 404, 422, 429, 503 |
| P47 `contacts.list` | `GET /api/v1/contacts` | `contacts:read`, scoped | denials | 200, 400, 422, 503 |
| P48 `contacts.get` | `GET /api/v1/contacts/{id}` | `contacts:read` on that contact | denials | 200, 403, 404, 422, 503 |
| P49 `contacts.create` | `POST /api/v1/contacts` | `contacts:create`, scoped by the proposed name, alias and address | `contact.create` | 201, 403, 409, 422, 503 |
| P50 `contacts.update` | `PATCH /api/v1/contacts/{id}` | `contacts:update` on that contact (before and after the change) | `contact.update` | 200, 403, 404, 409, 422, 503 |
| P51 `contacts.delete` | `DELETE /api/v1/contacts/{id}` | `contacts:delete` on that contact | `contact.delete` | 200, 403, 404, 409, 422, 503 |
| P52 `contacts.memberships` | `GET /api/v1/contacts/{id}/lists` | `contacts:read` on that contact and `distributionlists:read` | denials | 200, 400, 403, 404, 422, 503 |
| P53 `groups.members.add` | `POST /api/v1/groups/{id}/members` | `groups:members:write` on that group | `group.member.add` | 200, 403, 404, 409, 422, 503 |
| P54 `groups.members.remove` | `DELETE /api/v1/groups/{id}/members` | `groups:members:write` on that group | `group.member.remove` | 200, 403, 404, 409, 422, 503 |
| P70 `dashboard.counters` | `GET /api/v1/dashboard` | authenticated; each counter follows `users:read`, `groups:read`, `distributionlists:read`, `contacts:read` | denials | 200, 401 |

"Denials" means a success is not audited (ODC-01) and every refusal of an authenticated actor is, under the
route id. P43, P44, P53 and P54 audit successes too, one entry per member (below). Step-up: a write that
changes **more than 20 members** needs a fresh sign-in (403 `step_up_required`, audited as a denial);
`LIMITS.distributionLists.stepUpAbove` and `LIMITS.groupMembers.stepUpAbove`. The web app warns beforehand and,
on `step_up_required`, opens the sign-in dialog; the write is not replayed on its own.

#### Distribution lists (P40 to P42, P45)

- **P40.** Query: `q` (prefix, 1 to 64 characters, on name, alias and address), `kind` (`all` default,
  `standard`, `dynamic`, `synced`), `order` (`asc` default, `desc`; by display name), `limit`, `cursor`. A row
  is `{ id, displayName, primarySmtpAddress, kind, securityEnabled, memberCount, managers }`. `kind` is
  `standard` (a distribution group or mail-enabled security group that Exchange manages), `dynamic` or
  `synced` (synchronised from on-premises; read-only). `memberCount` is **`null` on rows** (counting every list
  would cost one Exchange call each) and `managers` is `null` unless the caller sees every user, because
  `ManagedBy` can name people the caller may not see. Unknown values are `null`, never a missing key.
  Dynamic lists are found through `Get-Recipient` (the group cmdlet does not return them).
- **P41.** The same row plus `alias` and `createdDateTime`; `memberCount` is counted here (`null` for a dynamic
  list or when the count failed).
- **P42.** Query: `limit`, `cursor`. Answers `{ items, nextCursor? }`. A row is
  `{ kind: "user" | "contact" | "group" | "other", id, displayName, primarySmtpAddress }` or, for a member the
  caller may not see, the **restricted row** `{ kind, restricted: true }` without id, name or address (the same
  single function as in Phase C). **A dynamic list has no member list**: its members follow a rule and the
  cmdlet that would list them (`Get-DynamicDistributionGroupMember`) is not on the worker's allow-list, so the
  answer is `{ "items": [] }`. Nothing in the answer says "empty because it cannot be listed"
  (finding FD-05).
- **P45.** Query: `q` (required, 1 to 64 characters), `limit`. The users and contacts the caller may see that
  match, as `{ kind: "user" | "contact", id, displayName, mail, alreadyMember }` (`alreadyMember` is `null`
  when the member read failed). A user without a mailbox address is not offered. **No cursor is issued**: the
  first page is the answer (the picker asks for 25), and a `cursor` in the request is 400 `cursor_invalid`. A
  dynamic or synchronised list is 409 `read_only_object`.

#### CSV export (P46, P55)

A download of the members of a list for a newsletter service. Both routes are `POST` because they take options;
the body is the same (`ExportOptions`, strict):

```json
{ "preset": "laposta" }
{ "preset": "custom", "columns": ["email", "firstName"], "separator": ";", "bom": true,
  "dedupe": true, "skipWithoutEmail": true }
```

- **Presets.** `laposta` is `email`, `first_name`, `last_name` with `;` and a byte order mark; `generic` is all five
  columns (`email`, `first_name`, `last_name`, `display_name`, `type`) with `,` and no BOM; `custom` takes
  `columns` (one to five, each once), `separator` (`,` or `;`) and `bom`. For `laposta` and `generic`, sending
  `columns`, `separator` or `bom` is 422. `dedupe` (default true) keeps one row per address, compared without
  regard to case; `skipWithoutEmail` (default true) leaves out a member without an address. **The Laposta preset
  is labelled "check the importer": Laposta's current import format has not been read from its documentation
  (U91).**
- **P55** streams `text/csv; charset=utf-8` with `Content-Disposition: attachment` (the list name made safe, and
  the date), `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. It needs a **fresh step-up**
  (403 `step_up_required` otherwise), is class `export` (6 a minute per client address, 429 `rate_limited`) and
  writes nothing to disk. Rows are written as they are read from Exchange; a client that stops reading stops
  the read. At most `export.rowsMax` (100,000) rows: a longer list ends the stream as a failed download, audited
  as `export_too_large`. The first member is read before the answer starts, so an Exchange failure is a 503
  problem and not a broken file. A dynamic list has no member list for the panel: its file holds the header alone.
- **Who is in the file.** The members the caller may see: a user, contact or group outside the caller's
  `users:read`, `contacts:read` or `groups:read` scope is not exported (a file is no way round the scope) and is
  counted as skipped, as are a repeated address and a member without one. Nested lists are written as one row of
  type `group`, not expanded.
- **Formula safety.** A field that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets one space in
  front of it so that Excel, LibreOffice and Google Sheets show it as text; every field is quoted when RFC 4180
  needs it. Rows end with CRLF ([ADR-0184](adr/0184-csv-formula-safety.md)).
- **P46** answers `{ csv, rows, skipped, more }`: the header and the first `export.previewRows` (20) rows, made by
  the same function with the same options (without the BOM), for the preview in the dialog. It needs the
  permission but no step-up, is class `write`, and is audited only when denied.
- **Audit.** One `dl.export` entry per export, written when the stream ends: `rows` sent, `skipped`, `preset`,
  and the NAMES of the `columns` and `options`; never a name or an address. An export that did not complete is
  outcome `error` with the reason `cancelled`, `export_too_large`, `export_failed` or the problem code of
  Exchange.

#### Member writes (P43, P44, P53, P54)

Request body, the same for all four (`DELETE` carries a body too):

```json
{ "members": ["<guid>", "<guid>"] }
```

`members` has 1 to **200** distinct GUIDs (`bulkMax`); a duplicate, a non-GUID or 201 entries is 422
`validation_failed`. Answer 200, always with one result per member in the order sent:

```json
{
  "results": [{ "id": "<guid>", "result": "added" }, { "id": "<guid>", "result": "failed", "reason": "mail_disabled" }],
  "summary": { "total": 2, "added": 1, "removed": 0, "already": 0, "failed": 1 },
  "readBackPending": false
}
```

- `result` is `added`, `removed`, `already` (the member was already in the state asked for: no write was
  sent) or `failed`. `reason` is present if and only if `failed`: `not_found`, `member_type_not_allowed`,
  `mail_disabled`, `rejected`, `permission_missing`, `throttled`, `unavailable`, `timeout`. The summary counts
  must equal the results (a schema check).
- **`readBackPending`** (lists only, P43 and P44; the group answer has no such field): true when a changed
  member is not (yet) in the member list read after the write, or when that read failed. Exchange is
  eventually consistent; the delay is not documented (U82). The member list may need a refresh.
- **The membership is read first** and "already" is decided from that read, not from Microsoft's answer to a
  duplicate (U92, U93, U94). The members are written in chunks (lists: 50 per chunk; groups: 20 per chunk,
  one Graph call per member), one transaction of audit entries per chunk.
- **Reasons before any call:** `not_found` (the id is not a user or contact of the tenant), `mail_disabled`
  (a user without a mailbox address; lists only), `member_type_not_allowed` (a group on a list; anything but a
  user on a group). **Reasons after a call:** `permission_missing` (Microsoft refused the application, for
  example a role-assignable group, U96), `rejected`, `throttled`, `unavailable`, `timeout`. A throttled or
  unavailable Exchange stops the rest of the request: the remaining members fail with the same reason.
- **When the first write fails for the role, the manager check or Exchange being down, the whole request is
  the problem** (503 `exchange_unavailable` or `exchange_permission_missing`) and nothing is claimed as done.
- **Lists (P43, P44).** A user is added by mailbox address, a contact by its GUID; the worker always sends
  `-BypassSecurityGroupManagerCheck` (U78: the service principal is not in `ManagedBy`). A list that is
  `dynamic` or `synced` is 409 `read_only_object` before any call.
- **Groups (P53, P54).** Users only. The membership is the direct membership, read 999 per page up to 50
  pages. A 404 on a removal counts as "already" (U93). A group that is dynamic, synchronised, a distribution
  or mail-enabled security group, of an unknown kind or has hidden membership is 409 `read_only_object`
  before any Graph call (with hidden membership the membership cannot be read, so "already" cannot be
  decided). The delete path always ends in `/$ref`, built by one function; a path without it would delete the
  member object itself (R-D-08).
- **Audit.** For each member one entry: action `dl.member.add`, `dl.member.remove`, `group.member.add` or
  `group.member.remove`, target the list or group id, outcome `success` (added, removed, already) or `error`
  with the reason as `reasonCode`, detail `{ memberId, result }`. Then one **summary entry**
  `{ summary: true, total, added, removed, already, failed }` (outcome `error` when nothing was done and
  something failed). A request that fails as a whole writes the summary alone, outcome `error`, with the
  problem code. No name or address is in any entry.

#### Contacts (P47 to P52)

- **P47.** Query: `q` (prefix on name, alias and address), `order`, `limit`, `cursor`. A row is
  `{ id, displayName, alias, externalEmailAddress, synced }` (`synced` is `null` when Exchange did not say;
  U12).
- **P48 and the 201 of P49.** The row plus `firstName`, `lastName`, `hiddenFromAddressLists`,
  `createdDateTime`.
- **P49.** Body `{ displayName, alias, externalEmailAddress, firstName?, lastName? }`. The address must
  already be normalised (trimmed, lower case); a client that sends anything else gets 422
  `address_not_normalised`. Limits: display name 256, alias 64, names 64, address 254 characters. The
  alias set is letters, digits and ``! # % * + - / = ? ^ _ ~``, periods only between other characters. The
  Exchange `-Name` is **derived** (the alias cut to 57 characters, a hyphen and 6 hexadecimal characters) and
  never typed (U95). The scope of the caller is checked against the proposed display name, alias and
  address; an id scope never covers a new contact. 201 with a `Location` header and the contact as read back.
  A duplicate address or alias is 409 `conflict` with `errors[0] = { "pointer": "/externalEmailAddress" |
  "/alias", "code": "conflict" }` and **no id of the existing contact** (a problem body has no member for it).
- **P50.** Body with at least one of `displayName`, `alias`, `externalEmailAddress` (names cannot be changed:
  `Set-MailContact` has no first or last name, U15). Only fields that differ from the current value are sent
  and audited; if nothing differs the answer is 200 with no call and no audit entry. The contact must stay
  inside the caller's scope after the change (403 otherwise). A synchronised contact is 409
  `read_only_object`; a duplicate is 409 `conflict` as above.
- **P51.** Body `{ confirmName }`, which must equal the display name exactly: otherwise 422 with
  `errors[0] = { "pointer": "/confirmName", "code": "confirm_mismatch" }` (or `display_name_characters` for a
  name with padding or control characters, which cannot be confirmed by typing). Exchange removes the contact
  from the lists it is in; the answer is `{ "removedFromLists": [{ id, displayName }] }`, cut to the lists the
  caller may see. A synchronised contact is 409.
- **P52.** Query: `limit`, `cursor`. The lists the contact is a member of, as list rows. Needs `contacts:read` on the contact and `distributionlists:read`; the lists are found by
  `Get-DistributionGroup -Filter "Members -eq ..."`, whose use of that filter is UNVERIFIED (OV-D5).
- Validation codes (`errors[].code` of a 422, message keys `contacts.validation.<code>`): `display_name_empty`,
  `display_name_too_long`, `display_name_characters`, `alias_empty`, `alias_too_long`, `alias_characters`,
  `address_invalid`, `address_not_normalised`, `address_too_long`, `person_name_too_long`,
  `nothing_to_change`, `confirm_mismatch`. The pointer is `/<field>`.

#### Dashboard counters (P70)

`GET /api/v1/dashboard`: access `authenticated`, rate class `read`, a success is not audited. The answer is
`{ users, groups, distributionLists, contacts }`; each counter is `{ state: "ok", count, capped }`,
`{ state: "denied" }` (the caller holds no read permission for that kind) or `{ state: "unavailable" }` (Graph or
Exchange could not answer; the other counters still do). A counter is the number of rows the caller's own list
page would show: it pages through the same scoped list read (`users.list`, `groups.list`,
`distributionlists.list`, `contacts.list`), 200 rows a page, at most `LIMITS.directory.scanPagesMax` pages. A count
that reaches that bound is `capped: true` and the card shows "1,000+". Answers are kept for 60 seconds per caller
and per set of visible scopes (FR-D-808); an answer with an `unavailable` counter is not kept. No new limit and no
request body.

#### Problem codes added by step D1

| Status | Code | When |
|---|---|---|
| 400 | `cursor_invalid` | As in Phase C; also a cursor sent to P45 |
| 403 | `permission_denied`, `step_up_required` | Missing permission or scope; more than 20 members without a fresh step-up |
| 404 | `not_found` | Unknown list, contact or group |
| 409 | `read_only_object` | Dynamic or synchronised list; synchronised contact; group of a kind or with hidden membership that Graph cannot write |
| 409 | `conflict` | Duplicate contact address or alias (pointer `/externalEmailAddress` or `/alias`, no id) |
| 422 | `validation_failed` | Bad query, path or body; detail codes `narrow_search` (`/q`), the contact validation codes, `confirm_mismatch` |
| 503 | `exchange_unavailable` | The worker, the Exchange role or Exchange is not available (`Retry-After: 30`). Detail codes `exchange_role_pending` (the role was granted recently and has not propagated) and `exchange_timeout`. **It is also the answer when the credential source cannot produce the certificate (degraded secrets, no certificate or no initial domain; built but not proven against a tenant, finding FD-01)** |
| 503 | `exchange_throttled` | Exchange throttled the request after the retry budget (`Retry-After` from the hint) |
| 503 | `exchange_permission_missing` | Exchange refused the application: the role, or the manager check |
| 503 | `graph_unavailable`, `graph_throttled`, `secrets_unavailable` | As in Phase C; for P45, P53 and P54 |

`builtin_role` and `rotation_failed` exist in the registry for step D3 and are not answered by D1.

#### Limits of step D1

Numbers are in [operations.md](operations.md#limits-outside-the-repository): `bulkMax` 200 and `bulkChunk` 50
(lists) or 20 (groups), step-up above 20 members, the worker's recycling and deadline, the retry budget, the
list buffer of 10,000 rows, the protocol line of 1,048,576 bytes, and the contact field lengths. A write body
holds at most 200 GUIDs (about 8 KB), so the largest request the application accepts stays **9,437,184 bytes**
and nothing in front of the panel needs a new setting. Step D1 adds one environment variable
(`EXCHANGE_KEY_HANDOVER`, default `memory`), changes the image base and the Compose file, and has no
migration; see [operations.md](operations.md#the-exchange-worker-phase-d-step-d1).

## Nederlands

### Wat de zeven routes van Fase C gemeen hebben

- Allemaal `GET` onder `/api/v1`, ratelimitklasse `read` (capaciteit 120, aanvulling 2 per seconde per
  clientadres, [grenzen](operations.md#grenzen-buiten-de-repository)) en een ingelogde sessie nodig. Elk
  antwoord heeft `Cache-Control: no-store`. Geen route van Fase C schrijft iets; elke andere methode op deze paden is 405.
- Rechten en scopes zijn die van het rollenmodel van het panel ([permissions.md](permissions.md), Deel 3 en
  Deel 4). De server dwingt ze af; de pagina's verbergen alleen.
- Een query is streng: een onbekende parameter, een tekst van meer dan 64 tekens of met stuurtekens, een
  `limit` buiten 1 tot 200 of een `id` dat geen GUID is, geeft 422 `validation_failed`. Een
  gebruikersprincipalnaam is geen geldig id.
- Fouten zijn `application/problem+json`; de `detail` is algemeen Engels en wordt niet getoond. Tekst,
  id's en namen van Microsoft staan nooit in een antwoord. Een waarde die Microsoft niet gaf, is `null`.
- **Nergens een totaal**: een telling zou de grootte van een scope verraden.

### Pagineren

Een lijst antwoordt `{ "items": [...], "nextCursor": "..." }`. `limit` is de tekst van een geheel getal van 1
tot 200 (standaard 100; de webapp vraagt 50). `nextCursor` ontbreekt aan het einde; geef hem anders terug als
`cursor`, met dezelfde overige parameters.

- De cursor is een ondoorzichtige, URL-veilige code van 24 tekens, niet de link van Microsoft en zonder
  gegevens. Hij geldt voor de aanvrager die hem kreeg, op die route, met dezelfde zoektekst, filters,
  volgorde en groep of gebruiker, 600 seconden na het maken of het laatste gebruik. De server houdt
  hoogstens 1.000 codes in het geheugen (de langst ongebruikte valt eruit); een herstart beëindigt ze ook.
  Al het andere (andere aanvrager, andere lijst, ander filter, verlopen of onbekende code) geeft 400
  `cursor_invalid`: begin opnieuw zonder cursor ([ADR-0179](adr/0179-directory-cursor-store-and-restricted-rows.md)).
- **Een pagina kan minder rijen dan `limit` bevatten, zelfs geen enkele, en toch een `nextCursor`
  hebben.** Wie maar een deel van de tenant mag zien, wordt bediend door per verzoek hoogstens vijf
  Microsoft-pagina's van 999 rijen te lezen en de zichtbare rijen te houden. Blijf vragen tot `nextCursor`
  ontbreekt. Een rij komt nooit twee keer voor en gaat niet verloren tussen pagina's.
- Graph accepteert hier geen `$skip`: er zijn geen paginanummers en geen sprong naar de laatste pagina.

### Routes

Zie de Engelse tabel hierboven voor id, verzoek, recht en mogelijke statussen. Per route.

- **P33 `users.list`**: `q` (voorvoegsel op weergavenaam, e-mailadres en principalnaam, geen woordzoeker),
  `enabled`, `type`, `order`, `limit`, `cursor`. Een rij is volledig (`id`, `displayName`,
  `userPrincipalName`, `mail`, `department`, `jobTitle`, `accountEnabled`, `userType`) of, bij een
  `basic`-recht, alleen `id`, `displayName`, `mail`. **Filters voor basic-aanvragers**: wie ook maar één
  gebruiker alleen als `basic` ziet en niet iedereen volledig, krijgt 422 `validation_failed` met
  `errors[0].code` `filter_not_allowed` bij `enabled` of `type` anders dan `all`; de principalnaam telt dan
  ook niet mee in de zoekopdracht. "Lid" betekent alleen het Microsoft-type `Member`; een gebruiker zonder
  type heeft `userType: null` en voldoet aan geen van beide filterwaarden (U72). Geen licentievelden.
- **P34 `users.get`**: kerngegevens en `manager`: `present` (met een rij, die beperkt is als de aanvrager die
  gebruiker niet mag zien), `none` (geen manager) of `unavailable` (Microsoft weigert de aanroep; voor
  applicatierechten staat bij Learn "Not supported", U66). Een `basic`-aanvrager krijgt `id`, `displayName`,
  `mail`. Onbekend id 404, buiten de scope 403 `permission_denied`.
- **P35 `users.groups`**: de groepen van de gebruiker, transitief; groepen die de aanvrager niet mag zien
  ontbreken (nooit "beperkt"); groepen met verborgen lidmaatschap kunnen ontbreken (U67). 403 zonder
  `groups:read` of bij een gebruiker die alleen als `basic` zichtbaar is.
- **P36 `groups.list`**: `q` (voorvoegsel op weergavenaam, e-mailadres en mailalias), `kind` (`all`, `m365`,
  `security`, `mailsecurity`, `distribution`). Een rij: `id`, `displayName`, `mail`, `kind` (ook `unknown`
  als Microsoft een eigenschap niet geeft, U36) en `visibility`. **Dynamische distributiegroepen geeft Graph
  niet terug**; de soort `distribution` is dus nooit volledig.
- **P37 `groups.get`**: `id`, `displayName`, `description`, `mail`, `mailNickname`, `kind`, `visibility`,
  `membershipType`, `onPremisesSyncEnabled`, `createdDateTime`. De lidmaatschapsregel van een dynamische
  groep staat er niet bij.
- **P38 `groups.owners` en P39 `groups.members`**: alleen directe leden. Een rij is een verwijzing
  (`kind` `user`, `group` of `other`, met `id`, naam, e-mailadres en principalnaam; bij een alleen-`basic`
  gebruiker is de principalnaam `null`, bij `other` zijn alleen `kind` en `id` gevuld) of een **beperkte
  rij** `{ kind, restricted: true }` zonder id, naam of adres. `ownersState`: `listed` of `not_available`
  (lege lijst bij distributie-, e-mailbeveiligings- en gesynchroniseerde groepen). `membersState`: `listed`
  of `hidden` (verborgen lidmaatschap: lege lijst, geen cursor, Microsoft wordt niet gevraagd).

Foutcodes: 400 `cursor_invalid`; 401 `unauthenticated` of `session_expired`; 403 `permission_denied`; 404
`not_found`; 422 `validation_failed`; 503 `graph_unavailable` (met `errors[0].code`
`graph_permission_missing` als de applicatie van het panel een recht mist; `Retry-After: 30`; de webapp
verwijst naar Instellingen, Verbinding), 503 `graph_throttled` (Microsoft vraagt meer dan 60 seconden
wachttijd) en 503 `secrets_unavailable`.

Grenzen: zoektekst 64 tekens, paginagrootte 100 (hoogstens 200), Microsoft-pagina 999 rijen, vijf
Microsoft-pagina's per verzoek voor een beperkte aanvrager, cursor 600 seconden en 1.000 cursors; zie
[operations.md](operations.md#grenzen-buiten-de-repository). Fase C voegt geen verzoekbody toe: het grootste
verzoek blijft 9.437.184 bytes, en er is geen nieuwe omgevingsvariabele, Compose-regel,
`.env.example`-regel of migratie.

### Fase D stap D1: distributielijsten, contacten en groepsleden

> **Status:** stap D1 (2026-10-13). Veertien routes: P40 tot en met P45 (distributielijsten), P47 tot en met
> P52 (mailcontacten) en P53 en P54 (leden van Microsoft 365- en beveiligingsgroepen). Stap D2 voegt de
> CSV-export toe: P46 (voorbeeld) en P55 (download). De rest van D2 (auditscherm) en D3 horen er nog niet bij. De schema's staan in
> `packages/shared/src/schemas/{distribution-lists,contacts,member-writes}.ts`; de routetabel is sectie 6.11.1
> van `specs/004-phase-d/spec.md`. **Niets hiervan is tegen een echte Microsoft 365-tenant gedraaid**: wat
> Exchange en Graph antwoorden is de vraag van de eigenaarstest [owner-test-phase-d1.md](owner-test-phase-d1.md).

**Route-id's zijn kleine letters** (`distributionlists.list`, niet `distributionLists.list`): het id van een
route is de `action` van de weigeringsregels in het auditlog en de actiegrammatica kent geen hoofdletters.
De OpenAPI-tag blijft `distributionLists`.

#### Wat de veertien routes gemeen hebben

- Allemaal onder `/api/v1`, een ingelogde sessie nodig en `Cache-Control: no-store`. Lezen is klasse `read`
  (capaciteit 120, aanvulling 2 per seconde per clientadres), schrijven is klasse `write` (capaciteit 10,
  aanvulling 0,5 per seconde) en vraagt het CSRF-token en een `Origin` van dezelfde oorsprong, zoals elke
  schrijfactie ([grenzen](operations.md#grenzen-buiten-de-repository)). Elke andere methode op een pad is 405.
- Recht en scope zijn die van het rollenmodel ([permissions.md](permissions.md), Deel 3 tot en met 5) en
  worden op de server voor het ene object gecontroleerd. Volgorde: bestaan (404), scope (403
  `permission_denied`, geaudit met reden `scope_mismatch`), dan de toestand van het object (409
  `read_only_object`).
- **Id's zijn GUID's.** Een distributielijst en een contact hebben hun Exchange-GUID, een Microsoft 365- of
  beveiligingsgroep zijn Entra-objectid, een gebruiker zijn Entra-objectid (ook als lid van een lijst;
  `ExternalDirectoryObjectId` op ledenrijen is ONGEVERIFIEERD, OV-D1 en OV-D5). Een lid zonder Entra-id
  toont zijn Exchange-GUID.
- Een query is streng, net als in Fase C: onbekende parameter, tekst langer dan 64 tekens of met
  stuurtekens, `limit` buiten 1 tot 200 of een `id` dat geen GUID is geeft 422 `validation_failed`.
- **Nergens een totaal**; de pagineerregels van Fase C gelden: `{ "items": [...], "nextCursor": "..." }`, een
  ondoorzichtige cursor van 24 tekens, gebonden aan aanvrager, route en parameters, 600 seconden geldig, in
  het geheugen (een herstart beëindigt hem: 400 `cursor_invalid`); een pagina kan minder rijen dan `limit`
  hebben. Lijsten en contacten komen uit Exchange, dat niet pagineert: de server leest het resultaat één keer,
  houdt het voor de cursor in het geheugen (`exchange.listBufferMax`, 10.000 rijen) en pagineert daarover. Een
  zoekopdracht met meer dan 10.000 treffers geeft 422 `validation_failed` met `errors[0] = { "pointer":
  "/q", "code": "narrow_search" }`; de catalogus heeft een melding voor die
  detailcode (`distributionLists.error.narrow_search` en, op de contactpagina's, `contacts.error.narrow_search`, in
  beide talen).
- Namen en adressen zijn gegevens: de webapp toont ze als tekst, de logs bevatten ze nooit en geen
  auditregel bevat een naam, adres of veldwaarde (alleen id's en veldnamen). Microsoft-tekst komt nooit in
  een antwoord; de `detail` is algemeen Engels.

Routes, rechten en auditacties staan in de Engelse tabel hierboven. "Alleen weigeringen" betekent: een
geslaagde actie wordt niet geaudit (ODC-01) en elke weigering van een ingelogde aanvrager wel, onder het
route-id. P43, P44, P53 en P54 auditen ook successen, per lid één regel. **Step-up**: een schrijfactie op
**meer dan 20 leden** vraagt een verse aanmelding (403 `step_up_required`, geaudit als weigering); de webapp
waarschuwt vooraf en opent bij die fout het aanmeldvenster; de schrijfactie wordt niet vanzelf herhaald.

#### Distributielijsten (P40 tot en met P42, P45)

- **P40.** Query: `q` (voorvoegsel van 1 tot 64 tekens op naam, alias en adres), `kind` (`all`, `standard`,
  `dynamic`, `synced`), `order`, `limit`, `cursor`. Een rij: `id`, `displayName`, `primarySmtpAddress`, `kind`,
  `securityEnabled`, `memberCount`, `managers`. `kind` is `standard`, `dynamic` of `synced` (gesynchroniseerd
  vanuit on-premises, alleen lezen). `memberCount` is op rijen **altijd `null`** (tellen kost per lijst een
  Exchange-aanroep) en `managers` is `null` tenzij de aanvrager alle gebruikers ziet (`ManagedBy` kan mensen
  noemen die de aanvrager niet mag zien). Dynamische lijsten komen via `Get-Recipient`.
- **P41.** Dezelfde rij plus `alias` en `createdDateTime`; `memberCount` wordt hier geteld (`null` voor een
  dynamische lijst of als het tellen mislukte).
- **P42.** Leden, gepagineerd: `kind` (`user`, `contact`, `group`, `other`), `id`, `displayName`,
  `primarySmtpAddress`, of een **beperkte rij** `{ kind, restricted: true }` zonder id, naam of adres. **Een
  dynamische lijst heeft geen ledenlijst**: de cmdlet daarvoor staat niet op de toegestane lijst van de worker,
  dus het antwoord is `{ "items": [] }` zonder aanwijzing dat het "leeg omdat niet te lezen" is
  (bevinding FD-05).
- **P45.** Query: `q` (verplicht), `limit`. De gebruikers en contacten die de aanvrager mag zien en die
  passen, als `{ kind, id, displayName, mail, alreadyMember }` (`null` als het lezen van de leden mislukte).
  Een gebruiker zonder mailadres wordt niet aangeboden. **Er komt geen cursor**; een meegestuurde `cursor`
  is 400 `cursor_invalid`. Een dynamische of gesynchroniseerde lijst is 409 `read_only_object`.

#### CSV-export (P46, P55)

Een download van de leden van een lijst voor een nieuwsbriefdienst. Beide routes zijn `POST` omdat ze opties
meekrijgen; de body is dezelfde (`ExportOptions`, streng): `preset` (`laposta`, `generic` of `custom`), bij
`custom` ook `columns` (een tot vijf, elk één keer: `email`, `firstName`, `lastName`, `displayName`, `type`),
`separator` (`,` of `;`) en `bom`; verder `dedupe` en `skipWithoutEmail` (beide standaard aan).

- **Presets.** `laposta` is `email`, `first_name`, `last_name` met `;` en een BOM; `generic` is alle vijf de
  kolommen met `,` en zonder BOM. Bij `laposta` en `generic` is het meesturen van `columns`, `separator` of `bom`
  een 422. **De Laposta-preset heet "controleer de importeur": het huidige importformaat van Laposta is niet uit
  hun documentatie gelezen (U91).**
- **P55** streamt `text/csv` als download (`Content-Disposition: attachment`, `Cache-Control: no-store`). Er is
  een **verse step-up** nodig, de klasse is `export` (6 per minuut per clientadres, anders 429) en er komt
  niets op schijf. Rijen worden geschreven zoals ze uit Exchange komen; stopt de browser met lezen, dan stopt
  ook het lezen bij Exchange. Maximaal `export.rowsMax` (100.000) rijen: een langere lijst beëindigt de stroom
  als mislukte download, met `export_too_large` in het auditlog. Het eerste lid wordt gelezen vóór het antwoord
  begint, dus een storing bij Exchange is een 503 en geen kapot bestand. Een dynamische lijst heeft voor het
  panel geen ledenlijst: het bestand bevat dan alleen de kopregel.
- **Wie er in het bestand staan.** Alleen leden die de aanvrager mag zien: een gebruiker, contact of groep buiten
  de scope van `users:read`, `contacts:read` of `groups:read` wordt niet geëxporteerd en telt als overgeslagen,
  net als een herhaald adres of een lid zonder adres. Geneste lijsten staan als één rij van type `group`.
- **Formuleveiligheid.** Een veld dat begint met `=`, `+`, `-`, `@`, een tab of een regeleinde krijgt één spatie
  ervoor, zodat Excel, LibreOffice en Google Sheets het als tekst tonen ([ADR-0184](adr/0184-csv-formula-safety.md)).
- **P46** antwoordt `{ csv, rows, skipped, more }`: de kopregel en de eerste 20 rijen, gemaakt door dezelfde
  functie met dezelfde opties, voor het voorbeeld in het dialoogvenster. Geen step-up, klasse `write`, alleen
  bij weigering in het auditlog.
- **Audit.** Eén `dl.export`-regel per export: aantal verzonden `rows`, `skipped`, `preset` en de NAMEN van de
  `columns` en `options`; nooit een naam of adres. Een export die niet af kwam, heeft uitkomst `error` met reden
  `cancelled`, `export_too_large`, `export_failed` of de probleemcode van Exchange.

#### Ledenwijzigingen (P43, P44, P53, P54)

Body voor alle vier (ook `DELETE` heeft een body): `{ "members": ["<guid>", ...] }`, 1 tot **200**
verschillende GUID's; een dubbele, een niet-GUID of 201 stuks is 422 `validation_failed`. Antwoord 200 met
per lid een resultaat in de volgorde van het verzoek, een `summary` (`total`, `added`, `removed`, `already`,
`failed`, gelijk aan de resultaten) en, alleen bij lijsten, `readBackPending`.

- `result` is `added`, `removed`, `already` (stond al in de gevraagde toestand: er is niets geschreven) of
  `failed`; `reason` staat er dan en alleen dan bij: `not_found`, `member_type_not_allowed`,
  `mail_disabled`, `rejected`, `permission_missing`, `throttled`, `unavailable`, `timeout`.
- **`readBackPending`**: waar als een gewijzigd lid na het schrijven nog niet in de ledenlijst staat of als
  die lezing mislukte. Exchange is uiteindelijk consistent; de vertraging is niet gedocumenteerd (U82).
- **Eerst wordt het lidmaatschap gelezen**; "already" volgt uit die lezing, niet uit het antwoord van
  Microsoft op een dubbele toevoeging (U92, U93, U94). Het schrijven gaat in brokken (lijsten 50, groepen 20,
  per lid één aanroep), per brok één transactie met auditregels.
- **Redenen vóór een aanroep**: `not_found`, `mail_disabled` (gebruiker zonder mailadres; alleen lijsten),
  `member_type_not_allowed` (een groep in een lijst; bij een groep alles behalve een gebruiker). **Na een
  aanroep**: `permission_missing` (Microsoft weigert de applicatie, bijvoorbeeld een rol-toewijsbare groep,
  U96), `rejected`, `throttled`, `unavailable`, `timeout`. Een gethrottlede of onbereikbare Exchange stopt
  de rest: de overige leden falen met dezelfde reden. **Mislukt de eerste schrijfactie door de rol, de
  beheerderscontrole of een onbereikbare Exchange, dan is het hele verzoek het probleem** (503) en wordt
  niets als gedaan gemeld.
- **Lijsten**: een gebruiker wordt op mailadres toegevoegd, een contact op GUID; de worker stuurt altijd
  `-BypassSecurityGroupManagerCheck` (U78). **Groepen**: alleen gebruikers; het directe lidmaatschap wordt per
  999 gelezen, hoogstens 50 pagina's; een 404 bij verwijderen telt als "already" (U93); een dynamische,
  gesynchroniseerde, distributie- of e-mailbeveiligde groep, een groep van onbekend soort of met verborgen
  lidmaatschap is 409 `read_only_object` vóór elke Graph-aanroep. Het verwijderpad eindigt altijd op `/$ref`
  (anders verwijdert Graph mogelijk het lid zelf; R-D-08).
- **Audit**: per lid een regel (`dl.member.add`, `dl.member.remove`, `group.member.add`,
  `group.member.remove`; doel is het lijst- of groepsid; uitkomst `success` of `error` met de reden als
  `reasonCode`; detail `{ memberId, result }`), daarna één **samenvattingsregel** `{ summary: true, total,
  added, removed, already, failed }`. Mislukt een verzoek als geheel, dan schrijft het alleen de samenvatting
  met uitkomst `error` en de probleemcode. Geen naam of adres in een regel.

#### Contacten (P47 tot en met P52)

- **P47.** `q` (voorvoegsel op naam, alias en adres), `order`, `limit`, `cursor`; rij `id`, `displayName`,
  `alias`, `externalEmailAddress`, `synced` (`null` als Exchange het niet zegt, U12). **P48 en de 201 van
  P49** voegen `firstName`, `lastName`, `hiddenFromAddressLists` en `createdDateTime` toe.
- **P49.** Body `displayName`, `alias`, `externalEmailAddress`, optioneel `firstName` en `lastName`. Het adres
  moet al genormaliseerd zijn (zonder spaties, kleine letters), anders 422 `address_not_normalised`.
  Lengtes: weergavenaam 256, alias 64, namen 64, adres 254. De Exchange-`-Name` wordt **afgeleid** (alias op
  57 tekens, een streepje en 6 hexadecimale tekens) en nooit getypt (U95). De scope wordt gecontroleerd tegen de
  voorgestelde naam, alias en adres; een id-scope dekt een nieuw contact nooit. 201 met `Location`. Een
  dubbel adres of alias is 409 `conflict` met `errors[0] = { "pointer": "/externalEmailAddress" | "/alias",
  "code": "conflict" }` en **zonder id** van het bestaande contact.
- **P50.** Minstens één van `displayName`, `alias`, `externalEmailAddress` (namen niet wijzigbaar:
  `Set-MailContact` heeft geen voor- of achternaam, U15). Alleen afwijkende velden worden verstuurd en geaudit;
  verschilt niets, dan 200 zonder aanroep en zonder auditregel. Het contact moet na de wijziging binnen de
  scope blijven (anders 403). Gesynchroniseerd: 409 `read_only_object`.
- **P51.** Body `{ confirmName }` gelijk aan de weergavenaam, anders 422 met pointer `/confirmName` en code
  `confirm_mismatch` (of `display_name_characters` bij een naam met spaties aan de rand of stuurtekens).
  Exchange haalt het contact uit zijn lijsten; antwoord `{ "removedFromLists": [{ id, displayName }] }`, beperkt
  tot de lijsten die de aanvrager mag zien.
- **P52.** De lijsten waarvan het contact lid is, als lijstrijen; nodig zijn `contacts:read` op het contact en
  `distributionlists:read`. Het filter `Members -eq ...` op `Get-DistributionGroup` is ONGEVERIFIEERD (OV-D5).
- Validatiecodes (`errors[].code` bij 422): `display_name_empty`, `display_name_too_long`,
  `display_name_characters`, `alias_empty`, `alias_too_long`, `alias_characters`, `address_invalid`,
  `address_not_normalised`, `address_too_long`, `person_name_too_long`, `nothing_to_change`,
  `confirm_mismatch`.

#### Dashboardtellers (P70)

`GET /api/v1/dashboard`: toegang `authenticated`, ratelimitklasse `read`, een geslaagde aanroep wordt niet
geaudit. Het antwoord is `{ users, groups, distributionLists, contacts }`; elke teller is
`{ state: "ok", count, capped }`, `{ state: "denied" }` (de aanvrager mag die soort niet lezen) of
`{ state: "unavailable" }` (Graph of Exchange kon niet antwoorden; de andere tellers antwoorden wel). Een teller is
het aantal rijen dat de eigen lijstpagina van de aanvrager zou tonen: hij bladert door dezelfde bereikgebonden
lijstlezing (`users.list`, `groups.list`, `distributionlists.list`, `contacts.list`), 200 rijen per pagina, hooguit
`LIMITS.directory.scanPagesMax` pagina's. Een telling die die grens bereikt is `capped: true` en de kaart toont
"1.000+". Antwoorden worden 60 seconden bewaard per aanvrager en per set zichtbare bereiken (FR-D-808); een
antwoord met een `unavailable`-teller wordt niet bewaard. Geen nieuwe grens en geen verzoekbody.

#### Foutcodes die stap D1 toevoegt

400 `cursor_invalid` (ook een cursor op P45); 403 `permission_denied` en `step_up_required`; 404 `not_found`;
409 `read_only_object` (dynamische of gesynchroniseerde lijst, gesynchroniseerd contact, groep die Graph niet
kan schrijven of met verborgen lidmaatschap) en `conflict` (dubbel adres of alias, zonder id); 422
`validation_failed` (met onder meer `narrow_search`, de contactcodes en `confirm_mismatch`); 503
`exchange_unavailable` (worker, rol of Exchange niet beschikbaar; `Retry-After: 30`; detailcodes
`exchange_role_pending` en `exchange_timeout`; **ook als de bron van het Exchange-certificaat het
certificaat niet kan leveren (geheimen gedegradeerd, geen certificaat of initieel domein; gebouwd maar niet bewezen
tegen een tenant, bevinding FD-01)**), 503 `exchange_throttled`, 503
`exchange_permission_missing` (rol of beheerderscontrole geweigerd) en de Graph-codes van Fase C.
`builtin_role` en `rotation_failed` staan in het register voor stap D3.

#### Grenzen van stap D1

De getallen staan in [operations.md](operations.md#grenzen-buiten-de-repository). Een schrijfbody bevat
hoogstens 200 GUID's (circa 8 KB), dus het grootste verzoek blijft **9.437.184 bytes**. Stap D1 voegt één
omgevingsvariabele toe (`EXCHANGE_KEY_HANDOVER`, standaard `memory`), verandert het basisbeeld van de image en
het Compose-bestand en heeft geen migratie; zie
[operations.md](operations.md#de-exchange-worker-fase-d-stap-d1).
