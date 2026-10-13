# API reference: users and groups (Phase C)

> Nederlandse versie: zie [Nederlands](#nederlands). The machine-readable contract of every route is the
> OpenAPI 3.1 document the server generates from its route table, served at `GET /api/v1/openapi.json`; the
> wire schemas are in `packages/shared/src/schemas/directory.ts`. This page is the human reading of the seven
> routes Phase C adds (P33 to P39). Routes of the earlier phases are in
> [`specs/002-phase-b/contracts/phase-b-api.md`](../specs/002-phase-b/contracts/phase-b-api.md).

## English

### What is common to the seven routes

- All are `GET` under `/api/v1`, rate class `read` (capacity 120, refill 2 per second per client address,
  [limits](operations.md#limits-outside-the-repository)), and need a signed-in session. Every response has
  `Cache-Control: no-store`. No route writes anything; any other method on these paths is 405.
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
`.env.example` entry or database migration.

## Nederlands

### Wat de zeven routes gemeen hebben

- Allemaal `GET` onder `/api/v1`, ratelimitklasse `read` (capaciteit 120, aanvulling 2 per seconde per
  clientadres, [grenzen](operations.md#grenzen-buiten-de-repository)) en een ingelogde sessie nodig. Elk
  antwoord heeft `Cache-Control: no-store`. Geen route schrijft iets; elke andere methode op deze paden is 405.
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
