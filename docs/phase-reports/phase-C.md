# Phase C report / Fase C-rapport

Date / datum: 2026-10-13 · Branch `claude/modest-bohr-45f4kf`, build `0.3.50` · Spec: `specs/003-phase-c/spec.md` · Gate notes: `specs/003-phase-c/gate-notes/GC0.md` to `GC3.md`

Status: **Phase C is built; the owner test against a real Microsoft 365 test tenant is open. GC3 (visual baselines, Lighthouse, CodeQL, Trivy, image, full e2e matrix) is "pending CI".** Nothing in this report claims what only a real tenant can show.

Status: **Fase C is gebouwd; de test van de eigenaar op een echte Microsoft 365-testtenant staat open. GC3 (visuele baselines, Lighthouse, CodeQL, Trivy, image, volledige e2e-matrix) is "pending CI".** Dit rapport beweert niets wat alleen een echte tenant kan laten zien.

---

## 0. Samenvatting (Nederlands)

**Wat er is.** De pagina's **Gebruikers** en **Groepen** zijn echt, en **alleen lezen**. Gebruikerslijst met zoeken (begin van naam, e-mail of principal name), sorteren op weergavenaam, filter op ingeschakeld/uitgeschakeld en lid/gast, en een detailpagina met kerngegevens, manager en groepen (ook via geneste groepen). Groepenlijst met zoeken en filter op soort (Microsoft 365, beveiliging, e-mailbeveiliging, distributie), en een detailpagina met eigenaren en leden, gepagineerd. Zeven routes (P33 tot en met P39), allemaal GET. Geen migratie, geen nieuwe omgevingsvariabele, geen Compose-wijziging, geen nieuw Graph-recht (`GroupMember.ReadWrite.All` is verleend maar ongebruikt). Geen licentiekolom.

**Wat zeker is.** Alles wat de simulatie kan laten zien is getest: de nep-tenant is net zo streng als Graph volgens Microsoft Learn, een lijst van 1.200 gebruikers pagineert zonder dubbele of ontbrekende rij, een beheerder met een beperkte scope ziet alleen zijn deel en krijgt 403 op een ander object (ODB-11), leden buiten het zicht komen terug als "beperkt" zonder naam, en geen enkele route schrijft iets.

**Wat niet zeker is.** Hoe Microsoft echt antwoordt: **U66 tot en met U74** (onder andere de manager voor een applicatietoken, verborgen lidmaatschap, de filters op groepsoort). Die sluit alleen jouw test op een echte tenant, **OV-C1 tot en met OV-C6**, met het stappenplan in [`docs/owner-test-phase-c.md`](../owner-test-phase-c.md) (ongeveer 30 minuten). Voor elke aanname is een nette terugval gebouwd (een melding, nooit een foutpagina). Ook niet bewezen: de visuele baselines, de Lighthouse-cijfers en de volledige e2e-matrix; die komen van de CI. Het `basic`-deel van OV-C6 kun je niet doen: zo'n rol is voor fase D niet toe te wijzen via de RBAC-API.

**Je keuzes.** De standaardkeuzes ODC-01 tot en met ODC-05 zijn ingevoerd en door jou op 2026-10-13 akkoord bevonden ("de standaardkeuzes zijn voorlopig prima"). ODB-11 is gesloten: 403. Geen licenties (D-C3).

**De vraag.** Mag fase D beginnen? Vooraf vragen we jou om ODB-01 (het Exchange-schrijfpad), ODB-03 (Exchange-rol) en ODB-08 (verlenging van het certificaat); zonder die drie begint de bouw van fase D niet. Zie sectie 5.

---

## 1. What was built / Wat is gebouwd

- **Routes P33 to P39** (all `GET`, `Cache-Control: no-store`, class read, denials audited, successes not): `users.list`, `users.get`, `users.groups`, `groups.list`, `groups.get`, `groups.owners`, `groups.members`. Single object outside the actor's scope: 403 `permission_denied` (ODB-11); unknown: 404; list cursor foreign, expired or lost: 400 `cursor_invalid`; Graph 403 for the panel's own application: 503 `graph_unavailable` with the detail code `graph_permission_missing`.
- **Graph client**: six read methods on the existing port and both implementations (`listUsers`, `getUserManager`, `listUserGroups`, `listGroups`, `listGroupMembers`, `listGroupOwners`), `GraphHttp.requestPage`, one query-builder module for every directory `$filter`, the advanced-query pair always sent, no `$skip`, no licence property, no write method (a guard fails if one appears).
- **Server module `directory`**: in-memory cursor store bound to actor, route and parameters (600 s sliding, 1,000 entries); scoped scan (at most 5 Graph pages of 999 per request, resumes exactly; 20,000-case property test against a naive filter); one restricted-row function for members, owners and the manager; `basic` projection on every path; services that cannot be called without the capability values.
- **Fake tenant extension**: the Graph routes of Phase C, strict like the real service by the rules of `research-microsoft-c.md` (14 rules, each with a self-test case and a negative), `seedDirectory` (1,200 users, 150 groups of every kind, quotes, diacritics, a guest, a disabled user, a user without manager, a 250-member group, a hidden-membership group), switches for the manager, hidden members and missing group properties.
- **Web pages**: `/users`, `/users/$id`, `/groups`, `/groups/$id` (gated by `users:read` and `groups:read`, a layout route each), search, filters and order in the URL, previous/next with remembered pages, loading, empty (with the replication note), error and restricted states, each detail section loads and fails alone, focus moves to the heading on navigation, no total anywhere. Lazy namespaces `users` and `groups` in Dutch and English.
- **Limits** (`LIMITS.directory`, five rows in `docs/operations.md`): `q` 64 characters; `limit` default 100, maximum 200 (the UI asks for 50); Graph page 999; 5 Graph pages per scoped request; cursors 600 seconds and 1,000 entries. No request body is added: the largest request stays 9,437,184 bytes.
- **Guards**: read-only (route table, Graph methods, database bytes identical after a request mix), no licences (source scan), no PII in logs (canary names), policy applied on all seven routes, capability types, names rendered as text (injected `<img onerror>`), route list against the route tree, lazy namespaces have a route, docs contract with the Phase C route index in both directions.
- **Docs, e2e**: `docs/permissions.md` (Phase C reads per route), ADR 0179, README, `docs/owner-test-phase-c.md` (nl and en), e2e fixtures with three actors, `users.spec.ts`, `groups.spec.ts`, `directory-fixtures.spec.ts`, extended `a11y`, `keyboard` and `visual` specs, Lighthouse route list (reported, not gated).

**Deliberately not built**: create, update, delete, member changes, password reset, licences (U17, U48 deferred), audit of successful reads (ODC-01), `Member.Read.Hidden`, transitive group members, dynamic distribution lists, `perf.test.ts`.

**Deployment files (AGENTS.md statement)**: no deployment-file changes: no new variable, no `.env.example` change, no Compose change, no migration. An existing Phase B deployment keeps working untouched; pull the image and restart (a restart ends all list cursors, by design). **Limits as numbers**: unchanged largest request 9,437,184 bytes; new list limits as above.

**Wat is gebouwd (Nederlands, kort)**: zeven GET-routes, zes leesmethoden op de Graph-client, een cursor-opslag in het geheugen, een gescande lijst voor beperkte scopes (maximaal 5 Graph-pagina's per verzoek), een functie voor "beperkte rijen", de uitgebreide nep-tenant met 1.200 gebruikers en 150 groepen, vier pagina's in twee talen, vijf nieuwe grenzen in `docs/operations.md`, bewakers tegen schrijven, licenties en persoonsgegevens in logs, en de stappenlijst voor jou. Niet gebouwd: aanmaken, wijzigen, verwijderen, ledenbeheer, wachtwoordreset, licenties.

---

## 2. Test results / Testresultaten

### 2.1 What ran locally / Lokaal uitgevoerd

From the gate notes (2026-10-13, Node v22, pnpm 10); the full run on a clean copy (T-C-069) is the orchestrator's and is recorded in `GC3.md`, not here.

| Check | Result |
|---|---|
| Server package (`GC1`) | 8,629 of 8,630 tests green at the gate; the one red (`limits-doc.test.ts`, five missing rows) was closed by the docs rows. 249 new tests in 19 new files; lint, typecheck, `schema:check` green |
| Web package (`GC2`) | 74 files / 1,896 tests green (11 new files, 160 new tests); lint, typecheck, build, `i18n:check`, `routes:generate` deterministic |
| Shared (`GC0`, `GC2`) | 3,780 tests at GC0 (47 files), all green; at GC2 one red in `single-implementation.test.ts` came from a server file of the parallel stream (`covers` defined twice); the repository-wide run of `GC3.md` is authoritative |
| `pnpm bundle:check` | within budget, no `approvedGrowth`: initial JS 245,640 B gzip (budget 245,692, **52 B left**), entry CSS 47,182 B (budget 47,200, **18 B left**), first load 277,120 B brotli (budget 277,500) |
| `pnpm docs:check` | green after the limits rows and the Phase C route index |

### 2.2 Only on GitHub, or not yet run / Alleen op GitHub of nog niet gedraaid

**Visual baselines** for the new states (never from the sandbox; T-C-064 stays open until the CI artefact is committed), **Lighthouse** of `/users` and `/groups` (reported, not gated), axe with real contrast and target sizes in a browser, the full `pnpm e2e` matrix on CI, `docker build`, `pnpm audit`, CodeQL, Trivy, image smoke test. Status of each: `GC3.md`, "pending CI".

### 2.3 Simulated / Gesimuleerd

Entra and Graph are the one fake tenant. It encodes our reading of Learn (R-C-01 to R-C-10): the advanced-query rule, no `$skip`, opaque `$skiptoken`, `memberOf` refused for apps, manager refused for apps by default (U66), hidden membership refused, owners empty for distribution and synced groups, limited-information members. **A passing test proves our code against our reading, not Microsoft's behaviour** (RC-04).

### 2.4 Could not be tested here / Niet testbaar

Any real tenant (OV-C1 to OV-C6), screen readers, browsers other than Chromium, the real timing of a page of 100 users (SC-C4 is the owner's OV-C3; `perf.test.ts` was not built).

---

## 3. Step list to try it yourself / Stappenlijst voor de eigenaar

The full list, in English and Dutch, with copyable commands and what you may and may not copy back, is [`docs/owner-test-phase-c.md`](../owner-test-phase-c.md): about 30 minutes, steps A to H. It needs a test tenant, never production. The panel keeps working whatever the answers are.

De volledige lijst, in het Engels en Nederlands, staat in [`docs/owner-test-phase-c.md`](../owner-test-phase-c.md): ongeveer 30 minuten, stappen A tot en met H, op een testtenant.

### 3.1 Owner-verified ledger / Grootboek (OV-C1 to OV-C6)

| ID | Check | Closes | Result |
|---|---|---|---|
| OV-C1 | Users: search, filter disabled and guest, order descending; Groups: all four kinds; compare counts with Entra | U69, U70, U72, U36 | not tested |
| OV-C2 | A user with a manager and one without; does "not available" appear | U66 | not tested |
| OV-C3 | First page of 100 users, time; page to the end in a tenant over 1,000 users | SC-C4, U73 | not tested |
| OV-C4 | A Microsoft 365 group with owners and members; a group over 100 members pages | U68, U71 | not tested |
| OV-C5 | A hidden-membership group and a user who belongs to one | U67, U74 | not tested |
| OV-C6 | A department-scoped actor: 403 on an outside user, restricted rows in a group. The `basic` half cannot be done before Phase D (no assignable role holds `users:read` basic); tests only | FR-C-203, FR-C-307 | not tested |

---

## 4. Open points, deviations and decisions / Open punten, afwijkingen en besluiten

Full registers: `docs/open-points.md`, section "Phase C" (U66 to U74 with status, ODC-01 to ODC-05, AC, PC, RC, and the findings FC-01 to FC-17).

### 4.1 Not yet done in Phase C / Nog niet gedaan

1. U66 to U74 and OV-C1 to OV-C6: the owner test (all `open`).
2. Visual baselines from the CI artefact (T-C-064), Lighthouse numbers, CI green for e2e, CodeQL, Trivy, image (`GC3.md`).
3. The negative controls were written with their guards; the "seen red once more" reruns were not repeated, and six server tasks (T-C-010, 011, 012, 018, 019, 020) were not seen red before their code (GC1).
4. A `basic` actor cannot be created through the RBAC API before Phase D (FC-05).
5. Licences (U17, U48) are deferred by the owner, not built.

### 4.2 Deviations from the spec and tasks, with evidence / Afwijkingen

The code is right in each case; spec and tasks were amended and say so (FC-01 to FC-08).

| # | Deviation | Source |
|---|---|---|
| 1 | The members, owners and manager `$select` has six properties (`department`, `mailNickname` added) so scoped actors do not see every member as restricted (U71) | GC1 dev. 2 |
| 2 | `enabled`, `type` and the principal-name search are refused 422 `filter_not_allowed` whenever any row could be shown as `basic` and the actor does not see all users in full (stricter than "only basic") | GC1 dev. 4 |
| 3 | No MSW: the web tests use a `fetch` stand-in (`msw` is not a dependency; install protocol) | GC2 |
| 4 | Own `DirectoryTable` instead of the design system `DataTable` (page-and-total based) | GC2 |
| 5 | Filters are native radio buttons in a fieldset: Radix controls raised initial JS by 1.8 to 4.2 KB gzip against 52 B of room | GC2 |
| 6 | The cursor is component state, not a URL parameter; a shared link shows the first page of the same filters | GC2 |
| 7 | A hook moves focus to the page heading on navigation (not on filter change) | GC2 |
| 8 | A `basic` actor's detail loader asks for the memberships before it knows the actor is basic: one wasted request, answered 403, one denial audit row per detail view (FC-10) | GC2, e2e |
| 9 | The router writes `enabled=%22false%22` in the URL; the e2e specs accept both forms | e2e |
| 10 | `seedDirectory` runs on demand in the fake tenant, when a fixture asks | e2e |
| 11 | The `basic` actor in e2e is a custom role written to the database; the fixtures self-test is a Playwright spec; the contract suite is `graph-client.contract.test.ts`; `perf.test.ts` not built | e2e, GC1 |
| 12 | Bundle headroom after Phase C: 52 B of JavaScript, 18 B of CSS: any later change in the entry or a shared component needs a new budget check (RC-06) | GC2 |
| 13 | `docs/operations.md` said "alle 25 grenzen"; the table has 79 rows | closing |

### 4.3 Owner decisions / Besluiten van de eigenaar

| ID | Decision | Status |
|---|---|---|
| D-C1 | First version read only; no new Graph permission | recorded, built (2026-10-13) |
| D-C2 = ODB-11 | Single object outside the scope: 403 | closed, built and tested |
| D-C3 | No licence column; U17 and U48 deferred | recorded |
| ODC-01 | Audit of successful reads: denials only | default implemented, owner agreed 2026-10-13 |
| ODC-02 | Distribution and mail-enabled security groups shown read-only with a badge | default implemented, owner agreed 2026-10-13 |
| ODC-03 | Prefix search on name, mail and principal name (not `$search`) | default implemented, owner agreed 2026-10-13 |
| ODC-04 | Hidden membership: state "hidden", no call, no `Member.Read.Hidden` | default implemented, owner agreed 2026-10-13; revisit after OV-C5 |
| ODC-05 | Manager best effort, "not available" when refused | default implemented, owner agreed 2026-10-13; revisit after OV-C2 |

---

## 5. Phase D scope and the question / Fase D en de vraag

Phase D (distribution lists, contacts, RBAC admin UI, audit UI, hardening) does not start before your explicit approval. **Before Phase D building starts you will also be asked for three open decisions of Phase B:**

- **ODB-01**, the Exchange write path (distribution list members, mail contacts). Undecided; the recommendation of the Phase B memo is a pwsh worker in the same container.
- **ODB-03**, the Exchange role and the second app role.
- **ODB-08**, certificate renewal by `addKey` self-rotation.

Phase C hands to Phase D: the cursor store and the restricted-row function, `groupKindOf` (distribution groups are the bridge to the distribution-list pages), the open questions U66 to U74, and the missing way to assign a `basic` role (FC-05).

Voor fase D vragen we je eerst om ODB-01, ODB-03 en ODB-08; zonder die besluiten begint de bouw niet.

### The question / De vraag

Approve proceeding to Phase D, and decide ODB-01, ODB-03 and ODB-08? The owner fills in the approval line below; nobody else does. Nothing for Phase D is started before it is filled in.

Akkoord om door te gaan met fase D, en een besluit over ODB-01, ODB-03 en ODB-08?

Naam en datum / Name and date:
