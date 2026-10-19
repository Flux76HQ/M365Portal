# Feature Specification: M365Portal Phase D (Exchange lists and contacts, group members, CSV, roles, audit, hardening)

## Samenvatting (Nederlands)

**Wat.** Fase D maakt het portaal compleet: het wordt een beheerpaneel dat ook **wijzigt**, niet alleen leest. Het wordt in **drie stappen** opgeleverd, elke stap met een eigen pull request en een korte test van jou tegen de echte tenant (besluit van 2026-10-13):

- **D1, Exchange-laag, distributielijsten, mailcontacten en groepsleden.** Een `pwsh`-werkproces in dezelfde container (besluit ODB-01 = A; het image krijgt daarvoor een Ubuntu-LTS-basis in plaats van distroless). Distributielijsten: lijst en detail met leden, leden toevoegen en verwijderen. Mailcontacten: aanmaken, bewerken, verwijderen, met validatie en een bevestiging bij verwijderen. Gewone groepen (Microsoft 365 en beveiliging, via Graph): leden toevoegen en verwijderen, met het al verleende recht `GroupMember.ReadWrite.All` (besluit van 2026-10-13: ja, in fase D).
- **D2, CSV-export en auditscherm.** Export van een distributielijst (kolomkeuze met voorbeeld, Laposta-preset en generieke preset, scheidingsteken, BOM, ontdubbelen, bescherming tegen formule-injectie, niets op schijf, elke export in het auditlog). Het auditlog in de interface (filter, zoeken, ketencontrole) en als CSV; bewaartermijn en een globale begrenzing van auditregels voor geweigerde verzoeken.
- **D3, rollenbeheer, certificaatrotatie, beveiliging en afronding.** Het scherm *Instellingen, Rollen en toegang* volledig zoals de opdracht (eigen rollen, klonen, sjablonen zoals *Bestuur*, scope per toewijzing, vervaldatum, effectieve rechten, "bekijk als"); zelfvernieuwing van het certificaat met `addKey` (ODB-08), met de herstelflow als vangnet; versterking van break-glass; OpenTelemetry (uitschakelbaar), Bicep-voorbeeld, het ASVS-overzicht, e2e en documentatie.

**Besluiten die al vaststaan.** ODB-01 = A (`pwsh` in dezelfde container), ODB-03 = Exchange Administrator met beide app-rollen, ODB-08 = herstelflow plus `addKey`, groepsleden in fase D, drie stappen, rollenbeheer volledig (alle 2026-10-13).

**Wat Microsoft Learn zegt en wat niet (sectie 8).** Gecontroleerd: app-only verbinden met een certificaat (`-Certificate` met een `X509Certificate2` in het geheugen, `-CertificateThumbprint` alleen op Windows), de cmdlets voor distributiegroepen en contacten, `-BypassSecurityGroupManagerCheck`, `pwsh` en de module op Ubuntu 24.04, `addKey` en `removeKey` (bewijs van bezit met een nog geldig certificaat, geen extra recht nodig voor de eigen sleutels) en het Exchange-beheerauditlog. **Niet** te verifiëren: of het certificaat zonder bestand op Linux werkt (U75), of *Exchange Recipient Administrator* volstaat (U76), of `Exchange.ManageAsAppV2` bestaat (U77), hoe een service-principal zich gedraagt bij het beheerderscontrolevlag (U78), doorvoer- en vertragingscijfers (U81, U82) en of de `iss` van het bewijs-JWT de app-id of het object-id is (U86). Dit zijn **U75 tot en met U90**; jouw tests OV-D1 tot en met OV-D4 sluiten ze.

**Wat niet.** Geen gebruikers aanmaken of verwijderen, geen wachtwoordreset, geen licenties (U17, U48 blijven uitgesteld), geen dynamische distributielijsten bewerken, geen synchronisatie met Laposta, geen Exchange-schrijfpad via het ongedocumenteerde `InvokeCommand`.

**Omvang en grenzen.** Dit is de grootste fase; daarom drie stappen. Het entry-CSS en entry-JS van de web-app zitten op hun budget (52 B JavaScript en 18 B CSS ruimte): alle nieuwe schermen komen in lazy chunks en lazy vertaalbestanden; als de eerste lading toch groeit, stop ik en vraag een goedgekeurde groei (het budgetbestand wijzig ik nooit zelf).

---

## Document status

**Feature Branch**: `claude/modest-bohr-45f4kf` (rebuilt on `main` 93924f2, release v0.3.54; integration branch `main`).

**Created**: 2026-10-13

**Status**: Draft for the Phase D gate GD0. Written spec-first on the merged Phase C (PR #9). No Phase D code exists. This document and `research-microsoft-d.md` are the only files of this commit series so far.

**Input**: `docs/build-prompt.md` (section 4, 2a, 6, 7, 8), `specs/001-m365portal`, `specs/002-phase-b`, `specs/003-phase-c` (spec, plan, tasks, gate notes), `research-microsoft-d.md` (same folder: R-D-01 to R-D-07), `docs/open-points.md` (U1 to U74, ODB-01 to ODB-18, ODC-01 to ODC-05, OD-10, OD-13, FC-05), `docs/phase-reports/phase-C.md`, and the owner's decisions of 2026-10-13 (section 10).

**U-register numbering.** `docs/open-points.md` holds U1 to U74. Phase D continues at **U75 to U96** (section 8.3; U91 is the Laposta format, U92 to U96 came with amendment 1). Nothing is renumbered.

**Size rule.** Each of the three steps is about the size of Phase B. A row that adds machinery beyond its step is moved to a later step or out.

---

## 1. Scope and phase gate

### 1.1 Scope by step

| Area | D1 | D2 | D3 | Not in Phase D |
|---|---|---|---|---|
| Exchange layer | `ExchangeClient` write methods behind the port; `pwsh` worker, one warm process, request/response over a pipe; Ubuntu LTS runtime image | | | `InvokeCommand` REST (ODB-01 D); a separate container (ODB-01 B) |
| Distribution lists | List, detail, members (paged), add and remove members (users and contacts) | CSV export | | Creating, renaming, deleting lists; owners (`ManagedBy`) changes; dynamic lists (read-only badge only) |
| Mail contacts | List, detail, create, update, delete, list memberships | | | Contacts that Exchange synced from on-premises (read-only badge) |
| Groups (Graph) | Add and remove members of Microsoft 365 and security groups (multi-select, bulk) | | | Group create, update, delete; owners; dynamic and synced groups (read-only) |
| Audit | Write entries for every D1 write | Audit screen, CSV, retention, global denial cap | | Streaming to an external SIEM |
| RBAC | Permissions already exist (15) | | Admin screen, custom roles, clone, templates, scope, expiry, effective rights, view as | New permissions beyond the 15 |
| Application identity | Exchange Administrator and both app roles (ODB-03); repair flow grants them | | Certificate self-rotation (`addKey`, ODB-08) | Rotation of a lapsed certificate (repair flow, administrator needed) |
| Hardening | Worker isolation, no key on disk (U75 fallback) | | Break-glass second factor and allow-list (ODB-17), OpenTelemetry, Bicep, ASVS map (FR-D-006), image seccomp profile | A WAF, an external vault |
| Tests and docs | Per step | Per step | e2e of the whole, Lighthouse, final report | |

### 1.2 Microsoft permissions in Phase D

| What | Held since | Phase D use |
|---|---|---|
| Graph `User.Read.All`, `GroupMember.Read.All`, `Organization.Read.All` | B | As in Phase C |
| Graph `GroupMember.ReadWrite.All` | B (ODB-02) | **Used from D1**: add and remove members of Microsoft 365 and security groups (`groups:members:write`) |
| Exchange application role `Exchange.ManageAsApp` (and `ManageAsAppV2` where Entra exposes it, U77) | B (granted by the wizard) | Used from D1 by the `pwsh` worker |
| Entra directory role Exchange Administrator for the service principal | B | Used from D1 (ODB-03); narrower role is U76, owner experiment OV-13/OV-D1 |
| Application ability to roll its own keys (`addKey`/`removeKey`) | B (own application) | Used in D3; no new permission (R-D-05) |

No new Graph permission is requested. A new consent is not needed after Phase B.

### 1.3 Build streams (input to the plan; not binding)

S-D1 shared contract, fake tenant (Exchange write fake) and worker protocol; S-D2 Exchange adapter, services and routes; S-D3 web; S-D4 docs, e2e, verification. Steps D1, D2, D3 are sequential gates (GD1, GD2, GD3); inside a step S-D2 and S-D3 run in parallel after the wire contract is frozen (plan section 8).

---

## 2. Document conventions

IDs: `FR-D-nnn` requirements (MUST/SHOULD), `US-D1..`, `EC-D1..` edge cases, `SC-D1..` success criteria, `ODD-nn` owner decisions, `AD-nn` assumptions, `RD-nn` risks, `U75` and up unverified Microsoft claims. Requirement numbers start at 100 per area: D1 uses 1xx to 3xx, D2 4xx to 5xx, D3 6xx to 9xx. Test paths follow Phase B and C: `server/` is `apps/server/test/`, `shared/` is `packages/shared/test/`, `web/` is `apps/web/test/`, `e2e/` is `e2e/tests/`. "(+ negative)" means a guard that also lands the fixture that makes it fail on purpose. Every MUST has a named automated control; what only a real tenant can show is in section 8.4. No Microsoft API, property or permission in this document comes from memory: each is in `research-microsoft-d.md` (cited as R-D-nn) or in the Phase B and C research.

---

## 3. Phase gates

| Gate | Ends | The owner then |
|---|---|---|
| GD0 | This spec, plan and tasks reviewed | Approves the plan (the owner has approved the scope on 2026-10-13) |
| GD1 | D1 done: PR merged, image published | Runs OV-D1 to OV-D3 (and OV-13) against the real tenant |
| GD2 | D2 done | Runs the export and audit checks (OV-D5 to OV-D7) |
| GD3 | D3 done and the final report | Runs the rest of the ledger (section 8.4) and accepts or rejects; 1.0.0 only after the acceptance (OD-05) |

Each gate ends with a phase report (summary, test results, steps for the owner, open points, the question whether to continue) and stops. The next step does not start without the owner's explicit go (AGENTS.md section 1).

---

## 4. User scenarios

- **US-D1 (P1) Add someone to a distribution list.** An operator opens a list, searches a user or contact, adds them, sees the new member after a short wait, removes another member after a confirmation. Done when: the Exchange fake records exactly one add and one remove, both audited with who, which list, which member and the result.
- **US-D2 (P1) Manage a mail contact.** Create with validation (display name, alias, external address unique), edit, see which lists the contact is in, delete after a confirmation that names the contact. Done when: every field error is a plain translated message and a delete of a contact in lists says so first.
- **US-D3 (P1) Add a user to a group.** On a Microsoft 365 or security group a helpdesk user adds several users at once; a dynamic or synced group offers no add button and says why. Done when: a partial failure shows which members failed and which were added.
- **US-D4 (P1) The *Bestuur* template.** A holder creates a contact and adds or removes members of the assigned list, but a server check refuses edit and delete of contacts, other lists, export, settings and RBAC. Done when: each refused action is a 403 plus an audit row (brief criterion 12).
- **US-D5 (P1) Export a list for a newsletter service.** An owner exports with the Laposta preset, semicolon, BOM, de-duplicated, and opens the file in Excel; a member named `=HYPERLINK(...)` is harmless; the export is in the audit log with the row count; nothing stays on the server (brief criterion 13).
- **US-D6 (P2) Read the audit log.** An administrator filters by actor, action, result and period, opens an entry, exports a period as CSV, and sees whether the hash chain verifies.
- **US-D7 (P1) Delegate safely.** An owner creates a custom role, scopes an assignment to the groups *Sales* and *Marketing*, gives it an end date, previews "view as" that user, and cannot grant more than they hold; the last Owner cannot be removed.
- **US-D8 (P2) The certificate renews itself.** Sixty days before expiry the panel rotates its own certificate with `addKey`, proves possession with the old one, keeps working, removes the old key after a grace period; if the certificate had already lapsed, the repair flow is the way (administrator needed).
- **US-D9 (P2) Break-glass is harder to abuse.** The owner configures an address allow-list and a second factor for break-glass; every use is loud.

---

## 5. Edge cases

| ID | Case | Behaviour |
|---|---|---|
| EC-D1 | The `pwsh` worker is not ready, crashed or timed out (Learn's REST call timeout is 15 minutes, R-D-02) | One restart; the call fails with 503 `exchange_unavailable` and a retry hint; no write is repeated automatically unless it is idempotent (add of an existing member, remove of an absent one are treated as success with state `already`) |
| EC-D2 | Exchange role not yet effective after setup (propagation) | 503 `exchange_unavailable`, detail `exchange_role_pending`; the UI points to Settings, Connection |
| EC-D3 | Member is a Microsoft 365 group or a mail-disabled user (not allowed in a distribution list, R-D-02) | 422 `validation_failed` with a per-member reason before the call |
| EC-D4 | Principal is not in `ManagedBy` of the list | The worker sets `-BypassSecurityGroupManagerCheck` per call (U78 decides whether it is needed); if Exchange still refuses, 403 from Exchange maps to `exchange_permission_missing` and the UI points to the role |
| EC-D5 | List is synced from on-premises or dynamic | Read-only badge; write routes answer 409 `read_only_object` |
| EC-D6 | Two actors change the same list at once | Last write wins at Exchange; the panel shows the member list read back after the write; no panel-side locking |
| EC-D7 | Write succeeded but the read-back is stale (U82) | The response says `readBackPending: true`; the UI shows the optimistic member with a "may take a moment" note |
| EC-D8 | Bulk add of 200 members | Processed in chunks of 50 (constant), per-member result list; one audit row per member and one summary row |
| EC-D9 | Contact with an external address that already exists | 409 `conflict` with the existing contact's id if the actor may see it |
| EC-D10 | Contact alias with characters Exchange rejects | 422 `validation_failed` before the call; the allowed set is documented |
| EC-D11 | CSV member without an e-mail address | Skipped and counted; the summary shows the count; the audit row holds it |
| EC-D12 | CSV value starts with `=`, `+`, `-`, `@`, tab or CR | Prefixed so a spreadsheet shows text; a unit test covers every leading character and quoting |
| EC-D13 | Export of a very large list | Streamed; memory bounded; client cancel stops the Exchange read; the row count in the audit entry is the rows sent |
| EC-D14 | Audit table grows through denied requests | Global cap per hour (ODD-05); beyond the cap a counter row is written once and further denials are counted, not stored |
| EC-D15 | Certificate rotation fails after `addKey` and before the sealed store is updated | The old certificate stays the active one; the new key is removed at the next run; the state is `rotation_failed` with the reason; the panel never ends with no usable key |
| EC-D16 | The certificate lapsed | No rotation possible (R-D-05); the banner says so and points to the repair flow |
| EC-D17 | Custom role that holds `rbac:manage` bound to an Entra group | Refused (FR-B-515 stays) |
| EC-D18 | An assignment expires while the actor has a session | Rights drop at the next request after expiry (FR-B-507 revalidation, the clock is the server's) |

---

## 6. Requirements

### 6.1 The Exchange layer and the `pwsh` worker (D1)

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-D-101 | MUST | `ExchangeClient` gains write methods behind the same port: `listDistributionGroups`, `getDistributionGroup`, `addDistributionGroupMember`, `removeDistributionGroupMember`, `listMailContacts`, `getMailContact`, `createMailContact`, `updateMailContact`, `removeMailContact`, `listRecipientMemberships`. The Admin API adapter keeps the read probe only; a new `PwshExchangeClient` implements the rest. One contract suite runs against `PwshExchangeClient` over a fake worker and `FakeExchangeClient`. `capabilities().write` lists exactly the methods built | `server/exchange/exchange-client-contract.test.ts`, `server/exchange/capabilities.test.ts` |
| FR-D-102 | MUST | The worker is one long-lived `pwsh` child process started by the server at first use, with an empty environment except what it needs, no shell, a fixed script, and a line-delimited JSON protocol on stdin and stdout (request id, cmdlet from a closed allow-list, parameters from schemas, a deadline). Requests are serial. A cmdlet outside the allow-list or an unknown parameter is refused by the server before it reaches the worker | `server/exchange/worker-protocol.test.ts` (+ negative: allow-list bypass attempt), `server/exchange/allow-list.test.ts` |
| FR-D-103 | MUST | The worker connects with `Connect-ExchangeOnline` using the application id, the tenant and a certificate (R-D-01). The preferred path passes the certificate and its PKCS#8 private key as PEM text in the `connect` line on stdin (GD1-0, amendment 1) and builds the `X509Certificate2` in memory with `CreateFromPem`, so no private key is written to disk; if U75 is false on Linux the fallback is files (the two PEMs and the PKCS#12 derived from them) on a `tmpfs` with mode 0600 that are deleted right after the connection, with a documented residual risk and a negative control that no key remains afterwards | `server/exchange/no-key-on-disk.test.ts`, `server/secrets/no-plaintext.test.ts` extended; OV-D1 |
| FR-D-104 | MUST | The session is renewed before it expires and after a failure; a stuck call is killed at its deadline and the worker restarted; memory of the worker is bounded by recycling it after `LIMITS.exchange.workerMaxCalls` calls or `workerMaxAgeSeconds` seconds (R-D-03: repeated connect and disconnect can leak memory) | `server/exchange/worker-lifecycle.test.ts` (fake clock, fake worker) |
| FR-D-105 | MUST | Throttling and transient errors: bounded retries with backoff; after the budget 503 `exchange_throttled` or `exchange_unavailable`; `Retry-After` shown when given. The numbers are constants (U81) | `server/exchange/retry.test.ts` |
| FR-D-106 | MUST | The runtime image changes from distroless to an Ubuntu LTS base that holds `pwsh` and the `ExchangeOnlineManagement` module at a pinned version (R-D-03), still non-root, read-only-root compatible, `cap_drop: ALL`; every `FROM` and the module are pinned (by digest and by exact version); the ADR records the move away from distroless and the measured image size and start time (U84); the size ceiling is re-measured and re-set by the owner-approved number only | `py/test_check_dockerfile_pins.py`, `image` smoke test (worker answers a ping in the container), `py/check_image_contents.py`, ADR 0180 |
| FR-D-107 | MUST | Nothing in the worker's input or output is logged beyond the request id, cmdlet name, outcome and duration; display names, addresses and member lists never reach logs. The one exception is the temporary, opt-in `EXCHANGE_DEBUG_ERRORTEXT=1` (below, GD1-0 amendment 5): off by default, masked and truncated error text in the owner's own log | `server/no-leak.test.ts` extended, `server/logging.test.ts` |
| FR-D-108 | SHOULD | The Admin API read adapter and the probe stay as the setup verification (V5, warning only); reads of lists and members use the worker so there is one reading path | `server/setup/verify.test.ts` |

**Configuration (amendment 2, GD1-server-b; amendment 5 of GD1-0).** Two environment variables are new in step D1:

| Variable | Default | Meaning | Enforced by |
|---|---|---|---|
| `EXCHANGE_KEY_HANDOVER` | `memory` | How the certificate reaches the `pwsh` worker (FR-D-103): `memory` passes the certificate and the PKCS#8 key as PEM on the stdin pipe and builds the `X509Certificate2` in memory (`CreateFromPem`); `tmpfs` is the fallback for the day U75 is false on Linux (mode 0600 files on a tmpfs, removed right after the connect). Any other value is refused at start. Not secret. It is in `.env.example`, `docker-compose.yml`, `README.md` and `docs/operations.md` | `server/config.test.ts`, `server/exchange/key-handover.test.ts`, `server/integrations/registry-exchange-worker.test.ts` |
| `EXCHANGE_DEBUG_ERRORTEXT` | unset (off) | **Temporary, opt-in diagnostics; an explicit, documented exception to FR-D-107 (GD1-0 amendment 5, owner decision 2026-10-13).** `1` makes the worker add a masked (e-mail addresses, GUIDs and long token-like runs replaced by `X`), truncated (300 characters) error text and the length of the unmasked message to a failure, and the server logs both as `errorText` and `errorTextLength` in the `exchange_fault` and `connect_refused` entries, for the owner's own log only; a start with it on logs the warning `exchange_debug_errortext`. `0` is the explicit off; any other value, an empty one included, is refused at start. Not secret. Remove it after troubleshooting. It is in `.env.example` (commented out), `docker-compose.yml`, `README.md` and `docs/operations.md` | `server/config.test.ts`, `server/exchange/no-personal-data-in-logs.test.ts`, `server/exchange/real-pwsh.test.ts`, `server/exchange/node-launcher.test.ts` |

### 6.2 Distribution lists (D1)

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-D-201 | MUST | Routes P40 to P46 (6.11.1): list, get, members (paged), add members, remove members, contact memberships of a list in one call is not a route (members include contacts as type `contact`). Lists are scoped by `distributionlists:read` (`visibleScopes`); a single list outside the scope answers 403 `permission_denied` (ODB-11 stays) | `server/distribution-lists/routes.test.ts`, `server/policy-matrix.test.ts` |
| FR-D-202 | MUST | The list shows name, primary address, kind badge (`standard`, `dynamic`, `synced`), member count and managers where Exchange returns them; unknown properties are `null` (U79, U80); paging uses the Phase C cursor store; search is a prefix match on name and address (OPATH `-like` suffix wildcard only, R-D-02) | `server/distribution-lists/list.test.ts` |
| FR-D-203 | MUST | Adding and removing members takes a list of identities (user ids or contact ids), each validated: the member must exist, be a user or a contact, and be allowed in a distribution list (EC-D3). Result per member: `added`, `removed`, `already`, `failed` with a reason code. At most `LIMITS.distributionLists.bulkMax` (200) per request, processed in chunks of `bulkChunk` (50) | `server/distribution-lists/members-write.test.ts`, `shared/distribution-lists-schema.test.ts` |
| FR-D-204 | MUST | Writes require `distributionlists:members:write` on that list (scoped), a CSRF token, step-up for bulk requests above `LIMITS.distributionLists.stepUpAbove` (default 20), and the write rate class; a dynamic or synced list answers 409 `read_only_object` | `server/distribution-lists/policy.test.ts`, `server/step-up-routes.test.ts` |
| FR-D-205 | MUST | Every write is audited: one entry per member (`dl.member.add`, `dl.member.remove`: actor, list identity hash, member identity hash, result) plus one summary entry per request; denials follow FR-B-602. Identities in audit details are the object ids, never display names | `server/audit-integration.test.ts`, `server/distribution-lists/audit.test.ts` |
| FR-D-206 | MUST | The member list is read back after a write; if it does not yet show the change the response carries `readBackPending` (EC-D7) | `server/distribution-lists/readback.test.ts` |
| FR-D-207 | SHOULD | Dynamic lists are shown read-only with a badge and their member list as Exchange returns it (R-D-02: refreshed every 24 hours) | `server/distribution-lists/dynamic.test.ts` |

### 6.3 Mail contacts (D1)

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-D-301 | MUST | Routes P47 to P52 (6.11.1): list, get, create, update, delete, memberships. Scoped by `contacts:read`, `contacts:create`, `contacts:update`, `contacts:delete` as the catalogue says (an object that does not exist yet is checked against the scope by its proposed name and alias prefix, the one rule for `create`) | `server/contacts/routes.test.ts`, `server/policy-matrix.test.ts` |
| FR-D-302 | MUST | Validation before any call: display name 1 to 256 characters, alias in the documented allowed set (R-D-09: at most 64 characters; ASCII letters, digits, `! # % * + - / = ? ^ _ ~`, U+00A1 to U+00FF; a period only between other characters; the characters Learn says need escaping are refused) and unique, external address a valid, normalised address (trimmed, lower case, ASCII, at most 254 characters, no display-name, quoted or prefixed form), unique among recipients (409 `conflict`, EC-D9); the Exchange `-Name` (unique, at most 64 characters, R-D-09) is derived by the service from the alias plus a short suffix and never typed by the user (U95); first and last name only where the cmdlet supports them (U15: `Set-MailContact` has none; a `Set-Contact` call is used only if U15 is verified, otherwise the columns stay empty and the CSV preset says so) | `shared/contact-schema.test.ts`, `server/contacts/validation.test.ts` |
| FR-D-303 | MUST | Delete asks for a confirmation that names the contact and the number of lists it is in, and is a `DELETE` with the confirmed name as a body field; a contact in lists is removed from them by Exchange and the response lists them | `server/contacts/delete.test.ts`, `web/contacts-delete-dialog.test.tsx` |
| FR-D-304 | MUST | Audit actions `contact.create`, `contact.update`, `contact.delete` with the changed field names (never values of personal data beyond the object id) | `server/contacts/audit.test.ts` |
| FR-D-305 | MUST | A contact that Exchange reports as synced from on-premises is read-only (409 `read_only_object`; U80) | `server/contacts/synced.test.ts` |

### 6.4 Group member writes via Graph (D1)

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-D-351 | MUST | `GraphClient` gains `addGroupMember` and `removeGroupMember` (and their bulk forms through the JSON batch only if R-D-02 of Phase C allows; otherwise one call per member). The `DELETE` path is built by one function that always ends in `/$ref`, and a test fails on a path without it (without `/$ref` Graph deletes the member object itself, R-D-08). Phase C's read-only guard changes: the test that failed on any write method now lists exactly these two and fails on any other | `server/integrations/graph/read-only.test.ts` (rewritten with the allow-list, + negative), `server/integrations/graph/graph-client.contract.test.ts` |
| FR-D-352 | MUST | Routes P53 and P54 (6.11.1): add and remove members of a Microsoft 365 or security group, scoped by `groups:members:write` (resource `group`); dynamic, synced and distribution or mail-enabled security groups answer 409 `read_only_object` (the latter are managed through Exchange: M365 groups' cmdlets are not supported app-only, R-D-01) | `server/groups/members-write.test.ts` |
| FR-D-353 | MUST | Bulk (up to 200, chunks of 20 to match Graph's limits) with per-member results, one `POST .../members/$ref` per member (the `PATCH members@odata.bind` form takes at most 20 members but is all-or-nothing, so it gives no per-member result and is not used, R-D-08); adding an existing member and removing an absent one are `already` | `server/groups/members-bulk.test.ts` |
| FR-D-354 | MUST | Audit `group.member.add` and `group.member.remove` as FR-D-205; step-up above the same threshold | `server/groups/audit.test.ts` |
| FR-D-355 | MUST | `docs/permissions.md` moves `GroupMember.ReadWrite.All` from "granted, unused" to "used from Phase D (FR-D-352)" with the reason | `server/docs-contract.test.ts` |

### 6.5 CSV export (D2)

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-D-401 | MUST | Route P55 `POST /api/v1/distribution-lists/{id}/export` (a POST because it takes options and writes an audit entry) returns a streamed `text/csv` download; permission `distributionlists:export` on that list (scoped); step-up required; the response has `Cache-Control: no-store` and `Content-Disposition` with a file name of the list name (sanitised) and the date; nothing is stored on the server | `server/distribution-lists/export.test.ts`, `server/no-leak.test.ts` (no file, no temp, no cache) |
| FR-D-402 | MUST | Options: columns (chosen from `email`, `firstName`, `lastName`, `displayName`, `type`, default the five), preset (`laposta`, `generic`, `custom`), separator (`;` or `,`), BOM (yes or no), expand nested lists (yes or no, depth and size capped), de-duplicate by e-mail (case-insensitive), skip members without e-mail. The Laposta preset is fixed only after its current import format is read from Laposta's documentation (U91 below); until then it is the e-mail plus first name plus last name preset, labelled "check the importer" | `shared/export-options.test.ts`, `server/distribution-lists/export-options.test.ts` |
| FR-D-403 | MUST | Formula injection: a value that starts with `=`, `+`, `-`, `@`, tab or carriage return is made safe (a leading apostrophe-free approach is chosen in the plan; the test fixes the exact result) and every field is quoted when needed by RFC 4180; the property test generates values from the union of leading characters, quotes, separators and line breaks and parses the output with an independent parser | `shared/csv.property.test.ts` (20,000 cases), `server/distribution-lists/csv-injection.test.ts` (member `=HYPERLINK(...)`) |
| FR-D-404 | MUST | The preview in the UI (first 20 rows) uses the same function as the download and the same options; a mismatch is a test failure | `web/export-preview.test.tsx`, `server/distribution-lists/export-preview.test.ts` |
| FR-D-405 | MUST | Each export writes `dl.export` with actor, list object id, row count sent, skipped count, options (names only) and result; a cancelled stream writes the rows sent so far with result `cancelled`. A short privacy notice (GDPR) is shown before the first download in a session | `server/distribution-lists/export-audit.test.ts`, `e2e/export.spec.ts` |
| FR-D-406 | SHOULD | The stream is bounded in memory (rows are written as read) and a request over `LIMITS.export.rowsMax` (100,000) is refused before the stream starts | `server/distribution-lists/export-limits.test.ts` |

**Amendments of 2026-10-19 (the CSV export of a distribution list is built ahead of the rest of step D2, at the owner's request: "an option to export all members as CSV for a newsletter supplier").** What was decided while building it, and what is not built:

- Formula safety (FR-D-403) is **one space in front** of the field, not an apostrophe; ADR-0184. The preview (P46) returns the text of the first rows (`{ csv, rows, skipped, more }`) made by the same function as the download.
- P46 is rated class `write`, not `read`: the route table refuses a POST in the read class, and a live preview must not spend the 6 a minute of the export class.
- A cancelled or failed export is outcome `error` with the reason `cancelled`, `export_too_large`, `export_failed` or the problem code, not an outcome `cancelled`: the audit table allows four outcomes (FR-D-405 asked for a result `cancelled`).
- The row limit (FR-D-406) is enforced while streaming: the first member is read before the response starts (so an Exchange failure is a 503), and a list longer than `export.rowsMax` ends the stream as a failed download. It is not known beforehand without reading the whole list.
- A member the caller may not see (outside their `users:read`, `contacts:read` or `groups:read` scope) is not exported and is counted as skipped. A dynamic list exports its header alone (FR-D-207). **Not built:** expanding nested lists (the option of FR-D-402); a nested list is one row of type `group`. The Laposta preset stays "check the importer" (U91 is open). `text/csv` is not compressed by `compress.ts`, so that the stream is not buffered.
- The privacy notice is in the dialog every time it opens (FR-D-405 asked for the first download of a session).
- Not part of this change: the audit screen and its routes (P56 to P59, FR-D-451 to FR-D-455), the gate notes GD2-0, GD2-server, GD2-web and GD2, and the owner sheet OV-D6.

### 6.6 Audit screen, retention and denial cap (D2)

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-D-451 | MUST | Routes P56 to P58: list (filter by actor, action, result, period, object id; cursor paging newest first), get one entry, verify the hash chain (a read that reports `ok` or the first broken position). Permission `audit:read` (global-only). Reading the audit log is itself not audited, denials are | `server/audit/routes.test.ts`, `server/audit/verify-route.test.ts` |
| FR-D-452 | MUST | Route P59 `POST /api/v1/audit/export` streams a CSV of a filtered period, permission `audit:export`, step-up; formula injection as FR-D-403; the export is audited (`audit.export`) | `server/audit/export.test.ts` |
| FR-D-453 | MUST | Retention (ODD-04, default 400 days for entries, with the hash chain kept by a sealed checkpoint row so deleting old entries does not break verification of the rest); a retention job runs daily, deletes in batches and writes one `audit.retention` entry; the retention setting is a documented environment variable with a lower bound | `server/audit/retention.test.ts` (fake clock, chain still verifies), `server/audit/checkpoint.test.ts` |
| FR-D-454 | MUST | A global cap on audit rows written for denied requests per hour (ODD-05, default 2,000): above it a single `audit.denials.capped` row is written per hour and denials are counted in a metric, not stored; per-client buckets stay (R-09, OD-13 closed) | `server/audit/denial-cap.test.ts` (+ negative) |
| FR-D-455 | MUST | The UI shows details of an entry as stored (no HTML), a banner when the chain does not verify, and never shows secrets (none exist in entries: the canary test covers it) | `web/audit-page.test.tsx`, `server/no-leak.test.ts` |

### 6.7 RBAC administration (D3)

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-D-601 | MUST | New routes P60 to P70 (6.11.1): custom roles (list is P27; create, update, clone, delete), templates (list, apply), assignments with scope and expiry (P28 to P30 extended), effective rights (P31 extended with scope and expiry), "view as" preview (a read that computes what a principal would see for a sample of routes; it never creates a session). All need `rbac:manage`, step-up for writes, `actorKinds: ['user']` for writes | `server/rbac/roles-routes.test.ts`, `server/rbac/templates.test.ts`, `server/rbac/view-as.test.ts` |
| FR-D-602 | MUST | Built-in roles stay immutable (a write to one answers 409 `builtin_role`); custom roles hold only permissions of the 15; a role that holds `rbac:manage` or `settings:connection` cannot be bound to an Entra group (FR-B-515); deleting a role that has assignments answers 409 with the count | `server/rbac/builtin-roles.test.ts`, `server/rbac/custom-roles.test.ts` |
| FR-D-603 | MUST | No privilege escalation: an actor may grant a role, scope or qualifier only if their own effective rights cover it (`canGrant`, the Phase B property tests extended to custom roles, scopes and expiry); the last Owner cannot be removed or downgraded, also under a race | `shared/rbac-covers.property.test.ts`, `server/rbac/last-owner.concurrency.test.ts` |
| FR-D-604 | MUST | Scope per assignment by resource type: an explicit set of object ids (groups, lists, contacts) or a filter (name prefix, department for users); the scope picker searches through the existing scoped routes; the stored scope uses the Phase B scope schema unchanged | `shared/rbac-scope.test.ts`, `server/rbac/scope-routes.test.ts` |
| FR-D-605 | MUST | Expiry: an assignment may have an end date; the effective-rights computation and the revalidation use the server clock; an expired assignment is shown as expired and can be deleted | `server/rbac/expiry.test.ts` (fake clock) |
| FR-D-606 | MUST | The `basic` qualifier of `users:read` can be assigned through a custom role or the *Bestuur* template (closes FC-05); `projectUser` is unchanged | `server/rbac/basic-qualifier.test.ts`, `e2e/rbac-basic.spec.ts` |
| FR-D-607 | MUST | Every change to a role, template application or assignment is audited (`rbac.role.create`, `rbac.role.update`, `rbac.role.delete`, `rbac.assignment.create`, `rbac.assignment.delete`, `rbac.template.apply`) with before and after names of permissions, never free text beyond the role name | `server/rbac/audit.test.ts` |
| FR-D-608 | MUST | The screen is *Instellingen, Rollen en toegang* (`/settings/roles`; its first part, the list of assignments with give and remove for a user or an Entra group, was built ahead of step D3 together with the sixth built-in role *Distribution List Editor*, ADR-0183): an overview per role and per principal, effective rights per user with the reason for each right, "view as" (read only, marked with a banner, no actions), and a change flow with a confirmation that lists what changes | `e2e/rbac-admin.spec.ts`, `web/rbac-admin.test.tsx` |

### 6.8 Certificate self-rotation (D3)

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-D-701 | MUST | A rotation job runs when the certificate has at most `LIMITS.cert.rotateBeforeDays` (60) days left: it generates a new key and certificate (RSA 2048, validity as the policy of the tenant allows, U87), calls Graph `addKey` on the own application with a proof-of-possession JWT signed with the current valid certificate (audience, `nbf`, `exp` ten minutes after, R-D-05; `iss` per U86 decided by OV-D3, the code tries the documented form first and records which one worked), seals the new key, switches the active certificate, and removes the old key after `LIMITS.cert.oldKeyGraceHours` (24) | `server/setup/rotation.test.ts`, `server/setup/rotation-proof.test.ts` (JWT claims and signing), fake tenant |
| FR-D-702 | MUST | Failure safety: the old certificate stays active until the new one is verified by a token request with it; every failure ends in `rotation_failed` with a reason code and leaves a working state (EC-D15); a second run after a failure cleans up an unused new key | `server/setup/rotation-faults.test.ts` (fault injection at each step) |
| FR-D-703 | MUST | The banners at 60 and 14 days stay; after rotation they disappear; a lapsed certificate (EC-D16) points to the repair flow and never tries `addKey` | `server/setup/rotation-lapsed.test.ts`, `e2e/cert-banner.spec.ts` |
| FR-D-704 | MUST | Rotation writes `connection.cert.rotate` with the old and new thumbprints (public data) and the result; the `APP_KEY` sealing is the one of Phase B; the Exchange worker reconnects with the new certificate after rotation | `server/setup/rotation-audit.test.ts`, `server/exchange/worker-reconnect.test.ts` |
| FR-D-705 | SHOULD | Rotation can be run by hand from Settings, Connection by an Owner with step-up | `e2e/cert-rotate.spec.ts` |

### 6.9 Hardening, observability, documentation (D3)

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-D-801 | MUST | Break-glass hardening (ODD-06, default: both): an in-app address allow-list (CIDR list from the environment; empty means off and is flagged in the posture line) and a second factor (TOTP secret sealed with `APP_KEY`, enrolled by the Owner while signed in; required at break-glass sign-in when set); every use is already loud (FR-B-522) | `server/auth/break-glass-hardening.test.ts` (+ negative), `e2e/break-glass.spec.ts` |
| FR-D-802 | MUST | OpenTelemetry traces and metrics, off by default, enabled by environment variables, exporting to an operator-given OTLP endpoint; no PII in attributes (the canary test), no new dependency unless the plan shows it fits the image budget | `server/telemetry.test.ts`, `server/no-leak.test.ts` |
| FR-D-803 | MUST | An Azure example (Bicep) with the same hardening as the compose example (non-root, read-only root, no new privileges, secrets from Key Vault references) and a lint check; a seccomp profile for the image that allows the worker | `py/test_bicep_example.py`, `py/check_compose_hardening.py` extended |
| FR-D-804 | MUST | Rate classes for the new routes (write, export, audit-export) with the bounds of `LIMITS.rateLimit`; the route-table check (Phase B SB-28) covers P40 and up | `server/route-table.test.ts` |
| FR-D-805 | MUST | The "permission audit" view of the brief: Settings shows, for each Microsoft permission and role the panel holds, why it is held and which routes use it, generated from `permissions-map.ts` and compared with the real tenant state in the verification step | `server/permissions-map.test.ts`, `e2e/permission-audit.spec.ts` |
| FR-D-806 | MUST | `docs/security.md` completes the OWASP ASVS level 2 mapping to individual controls (the version is decided at the start of D3 and recorded: U18), with the control that enforces each item and its test | `server/docs-contract.test.ts` |
| FR-D-807 | MUST | The documentation contract: `docs/api.md` (routes P40 and up), `docs/permissions.md` (part 5 Phase D), `docs/operations.md` (new limits, the worker, image size, retention, rotation), `docs/security.md`, ADRs (0180 runtime base, 0181 worker protocol, 0182 CSV safety, 0183 audit retention, 0184 certificate rotation), `README`, the phase reports of each step and the owner test sheet, all in Dutch and English | `server/docs-contract.test.ts`, `quality` |
| FR-D-808 | SHOULD | The dashboard shows counters (members of the lists the actor may see, contacts, recent audit entries for actors with `audit:read`), all through the existing scoped reads and cached for 60 seconds | `e2e/dashboard.spec.ts` |

### 6.10 Web (all steps, lazy chunks only)

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-D-901 | MUST | Pages `/distribution-lists`, `/distribution-lists/$id`, `/contacts`, `/contacts/$id`, `/audit`, `/settings/roles` and group member editing on `/groups/$id`; each in lazy chunks and lazy namespaces (`distributionLists`, `contacts`, `audit`, `rbacAdmin`); the entry chunks do not grow (the bundle check must pass with no budget change) | `quality` (`pnpm bundle:check`), `web/i18n-namespaces.test.ts` |
| FR-D-902 | MUST | Dutch and English catalogues complete for every key, semantic tables, full keyboard operation, WCAG 2.2 AA with axe at zero violations in light and dark at both viewports, visual baselines taken from the runner artefact only | `e2e/a11y.spec.ts`, `e2e/keyboard.spec.ts`, `e2e/visual.spec.ts`, `web/i18n-catalogue.test.ts` |
| FR-D-903 | MUST | The UI shows only what the actor may do (hides or disables), and states that the server decides; every write has a confirmation that lists what changes; every error state is a plain translated message | `e2e/*.spec.ts` per step |
| FR-D-904 | SHOULD | Lighthouse performance at least 95 on the public routes, and the Phase C accepted miss list does not grow without an owner decision | `e2e/lighthouse` (budget file unchanged) |

### 6.11 Reference tables (normative)

#### 6.11.1 Route index (continues Phase C table, P40 and up)

| # | Route id | Method and path | Access | Class | Audit |
|---|---|---|---|---|---|
| P40 | `distributionlists.list` | `GET /api/v1/distribution-lists` | `distributionlists:read`, scoped | read | denials only |
| P41 | `distributionlists.get` | `GET /api/v1/distribution-lists/{id}` | `distributionlists:read` on that list | read | denials only |
| P42 | `distributionlists.members` | `GET /api/v1/distribution-lists/{id}/members` | `distributionlists:read` on that list | read | denials only |
| P43 | `distributionlists.members.add` | `POST /api/v1/distribution-lists/{id}/members` | `distributionlists:members:write`, stepUp above threshold | write | `dl.member.add` |
| P44 | `distributionlists.members.remove` | `DELETE /api/v1/distribution-lists/{id}/members` (body: identities) | `distributionlists:members:write`, stepUp above threshold | write | `dl.member.remove` |
| P45 | `distributionlists.search` | `GET /api/v1/distribution-lists/{id}/candidates?q=` | `distributionlists:members:write`, `users:read` and `contacts:read` scoped | read | denials only |
| P46 | `distributionlists.export.preview` | `POST /api/v1/distribution-lists/{id}/export/preview` | `distributionlists:export` | write | denials only |
| P47 | `contacts.list` | `GET /api/v1/contacts` | `contacts:read`, scoped | read | denials only |
| P48 | `contacts.get` | `GET /api/v1/contacts/{id}` | `contacts:read` on that contact | read | denials only |
| P49 | `contacts.create` | `POST /api/v1/contacts` | `contacts:create`, scoped by proposed name | write | `contact.create` |
| P50 | `contacts.update` | `PATCH /api/v1/contacts/{id}` | `contacts:update` on that contact | write | `contact.update` |
| P51 | `contacts.delete` | `DELETE /api/v1/contacts/{id}` | `contacts:delete` on that contact | write | `contact.delete` |
| P52 | `contacts.memberships` | `GET /api/v1/contacts/{id}/lists` | `contacts:read` and `distributionlists:read` | read | denials only |
| P53 | `groups.members.add` | `POST /api/v1/groups/{id}/members` | `groups:members:write`, stepUp above threshold | write | `group.member.add` |
| P54 | `groups.members.remove` | `DELETE /api/v1/groups/{id}/members` | `groups:members:write`, stepUp above threshold | write | `group.member.remove` |
| P55 | `distributionlists.export` | `POST /api/v1/distribution-lists/{id}/export` | `distributionlists:export`, stepUp | export | `dl.export` |
| P56 | `audit.list` | `GET /api/v1/audit` | `audit:read` | read | denials only |
| P57 | `audit.get` | `GET /api/v1/audit/{id}` | `audit:read` | read | denials only |
| P58 | `audit.verify` | `GET /api/v1/audit/verify` | `audit:read` | read | denials only |
| P59 | `audit.export` | `POST /api/v1/audit/export` | `audit:export`, stepUp | export | `audit.export` |
| P60 | `rbac.roles.create` | `POST /api/v1/rbac/roles` | `rbac:manage`, stepUp | write | `rbac.role.create` |
| P61 | `rbac.roles.update` | `PATCH /api/v1/rbac/roles/{id}` | `rbac:manage`, stepUp | write | `rbac.role.update` |
| P62 | `rbac.roles.clone` | `POST /api/v1/rbac/roles/{id}/clone` | `rbac:manage`, stepUp | write | `rbac.role.create` |
| P63 | `rbac.roles.delete` | `DELETE /api/v1/rbac/roles/{id}` | `rbac:manage`, stepUp | write | `rbac.role.delete` |
| P64 | `rbac.templates.list` | `GET /api/v1/rbac/templates` | `rbac:manage` | read | denials only |
| P65 | `rbac.templates.apply` | `POST /api/v1/rbac/templates/{id}/apply` | `rbac:manage`, stepUp | write | `rbac.template.apply` |
| P66 | `rbac.viewas` | `POST /api/v1/rbac/view-as` | `rbac:manage` | read | denials only |
| P67 | `connection.cert.rotate` | `POST /api/v1/connection/certificate/rotate` | `settings:connection`, stepUp | write | `connection.cert.rotate` |
| P68 | `breakglass.factor.enroll` | `POST /api/v1/rbac/break-glass/factor` | `rbac:manage`, stepUp | write | `breakglass.factor.enroll` |
| P69 | `permissions.audit` | `GET /api/v1/connection/permission-audit` | `settings:connection` | read | denials only |
| P70 | `dashboard.counters` | `GET /api/v1/dashboard` | authenticated | read | denials only |

Amendment 2 (GD1-server-b): the route ids of `distributionlists.*` are spelt in lower case. The id of a route is the `action` of its denial entries (`access-guard.ts`, `route-table.ts`) and the audit writer's action grammar has no capital letter, so a denial on `distributionLists.list` would have ended in a 500. P46 is a `POST`: the route table rates a write method `write`, `upload`, `auth` or `setup`, so the class `read` of P46 cannot stand when the route is built in step D2 (decision then: class `write`, or a `GET` with the options in the query).

P28 to P31 keep their ids and gain `scope` and `expiresAt` in their bodies. Class `export` is a new row of `LIMITS.rateLimit` (ODD-07: 6 per minute per actor). Route ids follow the Phase B grammar (SB-27). All new routes declare `scoped` or `unscopedReason` (FR-B-505).

#### 6.11.2 Limits (constants in `packages/shared/src/limits.ts`; rows added to `docs/operations.md`)

| Constant | Value | Meaning |
|---|---|---|
| `exchange.workerMaxCalls`, `exchange.workerMaxAgeSeconds` | 500, 3,600 | Worker recycling (FR-D-104) |
| `exchange.callDeadlineSeconds` | 120 | One cmdlet call |
| `distributionLists.bulkMax`, `bulkChunk`, `stepUpAbove` | 200, 50, 20 | Member writes |
| `export.rowsMax`, `export.previewRows` | 100,000; 20 | CSV |
| `audit.denialCapPerHour` | 2,000 | FR-D-454 |
| `audit.retentionDays` | 400 | FR-D-453 |
| `cert.rotateBeforeDays`, `cert.oldKeyGraceHours` | 60; 24 | FR-D-701 |
| `rateLimit.export` | capacity 6, one token every 10,000 ms (6 a minute) | ODD-07, P55, P59 |
| `exchange.listBufferMax`, `exchange.lineMaxBytes` | 10,000; 1,048,576 | List buffer per cursor (plan 5.2); one protocol line (FR-D-102). Added by amendment 1 (GD1-0) |
| `exchange.retryMax`, `exchange.retryBackoff.initialMs`, `.maxMs` | 3; 1,000; 15,000 | FR-D-105, numbers ours until U81 is closed. Added by amendment 1 |
| `groupMembers.bulkMax`, `bulkChunk`, `stepUpAbove` | 200, 20, 20 | FR-D-353, FR-D-354; Graph adds at most 20 members in one request (R-D-08). Added by amendment 1 |
| `contacts.nameMaxChars`, `displayNameMaxChars`, `aliasMaxChars`, `personNameMaxChars`, `addressMaxChars` | 64, 256, 64, 64, 254 | FR-D-302; `New-MailContact` limits of R-D-09. Added by amendment 1 |

#### 6.11.3 Problem codes added

| Code | Status | Meaning |
|---|---|---|
| `exchange_unavailable` | 503 | Worker, role or Exchange not available (detail codes `exchange_role_pending`, `exchange_timeout`) |
| `exchange_throttled` | 503 | Exchange throttled after the retry budget |
| `exchange_permission_missing` | 503 | Exchange refused the application (role or manager check) |
| `read_only_object` | 409 | Dynamic, synced or Exchange-managed object |
| `conflict` | 409 | Duplicate contact address or alias (reuses the registry if present) |
| `builtin_role` | 409 | A built-in role cannot change |
| `rotation_failed` | 409 | Certificate rotation did not complete (detail reason) |

Amendment 1 (GD1-0): `exchange_role_pending` and `exchange_timeout` are `errors[]` detail codes of `exchange_unavailable` with catalogue messages `distributionLists.error.exchange_role_pending` and `.exchange_timeout` (`i18n/detail-codes.ts`); the contacts pages load the `distributionLists` namespace for them. `exchange_unavailable` is also the Phase B wizard result code of the Exchange probe (`setup/result-codes.ts`): the same word on two surfaces that never mix, a second permitted overlap next to `tenant_mismatch` (CD-05 test amended). `conflict` carries the existing contact's id (EC-D9) as an `errors[]` entry `{ pointer, code: 'conflict' }` only; a problem body has no member for an id (the schema is strict).

---

## 7. Success criteria

| ID | Outcome | Measure | Control |
|---|---|---|---|
| SC-D-001 | An operator can add and remove list members (brief criterion 3, US-D1) | Against the fake tenant: 100 % of add, remove, already and failed cases give the stated result and one audit entry per member | `server/distribution-lists/members-write.test.ts`, `e2e/distribution-lists.spec.ts` |
| SC-D-002 | A contact can be created, edited, deleted (criterion 4, US-D2) | All validation rows and the delete confirmation behave; the fake records exactly the mutating calls | `server/contacts/*.test.ts`, `e2e/contacts.spec.ts` |
| SC-D-003 | *Bestuur* does exactly what it should and nothing else (criterion 12, US-D4) | The policy matrix for the template over every new route equals the table; each refused action is 403 with an audit row | `server/policy-matrix.test.ts`, `e2e/bestuur.spec.ts` |
| SC-D-004 | The export is safe, correct and audited (criterion 13, US-D5) | 20,000 property cases parse back to the exported values with the independent parser; `=HYPERLINK(...)` is text; BOM and separator options are exact; the audit row has the right count; no byte of the export is on disk afterwards | `shared/csv.property.test.ts`, `server/distribution-lists/export.test.ts`, `e2e/export.spec.ts` |
| SC-D-005 | The audit log is readable, verifiable and bounded | The chain verifies after retention deletes; the denial cap holds under 10,000 denials; the audit CSV equals the stored rows for the filter | `server/audit/*.test.ts` |
| SC-D-006 | Delegation is safe (US-D7, criterion 11) | The 20,000-case grant properties hold with custom roles, scopes and expiry; 100 races of two Owners leave one | `shared/rbac-covers.property.test.ts`, `server/rbac/last-owner.concurrency.test.ts` |
| SC-D-007 | The certificate renews without an outage (US-D8) | Fault injection at each step of rotation leaves a working active certificate every time; a rotated panel still gets a Graph token and reconnects the worker | `server/setup/rotation-faults.test.ts` |
| SC-D-008 | No Exchange secret on disk and no personal data in logs | The key canary has 0 hits in files and logs after a full run (or only the documented tmpfs file during connect, if U75 is false) | `server/exchange/no-key-on-disk.test.ts`, `server/no-leak.test.ts` |
| SC-D-009 | The image still works | The smoke test (worker ping, read-only root, restart persistence) passes; the measured size and start time are recorded | `image` job |
| SC-D-010 | The UI meets the quality bar | Zero axe violations on every new route and state; keyboard-only completion of every flow; baselines for every listed state; entry chunks unchanged | `e2e/a11y.spec.ts`, `e2e/keyboard.spec.ts`, `e2e/visual.spec.ts`, `bundle:check` |
| SC-D-011 | The owner can test without guessing | Each step's report holds one procedure and one result field per ledger item (8.4) and a row per decision ODD-01 to ODD-07 | review, `server/docs-contract.test.ts` |
| SC-D-012 | Earlier phases are not lost | Every Phase A, B and C test and e2e spec still runs (migrated, none deleted) | `quality`, `e2e` |

---

## 8. Microsoft facts, permissions and the owner-verified ledger

### 8.1 What was read, and what it settled

`research-microsoft-d.md` (R-D-01 to R-D-07) was read from Microsoft Learn for this document. It settles: app-only authentication from PowerShell and the role and app-role names (R-D-01); the cmdlet shapes, member types, the manager check, OPATH filters and the 15-minute REST timeout (R-D-02); `pwsh` and the module on Ubuntu 24.04 (R-D-03); throttling (R-D-04, no numbers); `addKey` and `removeKey` (R-D-05); and the Exchange admin audit log (R-D-06).

### 8.2 Facts the design rests on (Learn-verified)

- `-CertificateThumbprint` is Windows-only; `-Certificate` takes an `X509Certificate2` that need not be installed; `-CertificateFilePath` needs a file and a password (R-D-01).
- Microsoft 365 (unified) group cmdlets are not supported app-only, so group member writes use Graph (R-D-01); distribution lists use Exchange (R-D-02).
- Microsoft 365 groups and mail-disabled users are not allowed as members of a distribution group (R-D-02).
- `addKey` needs no extra permission to roll the application's own keys; the proof is a JWT with audience `00000002-0000-0000-c000-000000000000`, `nbf`, `exp` ten minutes after, signed with an existing valid certificate; after expiry rotation is impossible (R-D-05).
- Exchange admin audit is on by default, 180-day retention, up to 30 minutes delay; Get, Search and Test cmdlets are not logged (R-D-06).

### 8.3 UNVERIFIED register (new; copy to `docs/open-points.md`, date 2026-10-13)

U75 to U90 are listed with their source in `research-microsoft-d.md` (summary table). One more is added by this document:

| ID | Claim | Needed by | Why unverified | How the owner closes it |
|---|---|---|---|---|
| U91 | The current Laposta CSV import format (columns, separator, encoding) | FR-D-402 | Laposta's documentation was not read for this document | Owner or planner reads Laposta's import help; OV-D6 imports a test file |
| U92 | Graph answers `400` for an add of an existing member, an unsupported member type and a not yet replicated group alike | FR-D-353 | `group-post-members` lists the three under one status | Pre-check membership; OV-D2 |
| U93 | Graph's answer for removing an object that is not a member | FR-D-353 | `group-delete-members` is silent | Pre-check; OV-D2 |
| U94 | Exchange add of an existing member and remove of a non-member: error or silent success | FR-D-203, EC-D1 | The cmdlet pages are silent | Read membership first; OV-D2 |
| U95 | Scope of the uniqueness of a mail contact's `-Name` | FR-D-302, EC-D9 | "unique name" only | Derived name with suffix; OV-D5 |
| U96 | Detecting role-assignable groups before a Graph member write | FR-D-352 | Property not in the Phase C `$select`; not read | Map the 403 after the call; OV-D2 |

U92 to U96 are described in `research-microsoft-d.md`, amendment 1 (R-D-08, R-D-09).

### 8.4 Owner-verified ledger (the owner's real-tenant test; none is covered by an automated control)

| ID | What | Procedure (short) | Settles | Step |
|---|---|---|---|---|
| OV-D1 | Connect and the key on disk | Run the worker against the tenant; check that `Get-DistributionGroup -ResultSize 1` answers; observe the files in the container while it runs | U75, U76, U77, U83, U84, U85 | D1 |
| OV-D2 | Member write without manager rights | Add and remove a member on a list the service principal does not manage; with and without the bypass | U78, U82 | D1 |
| OV-D3 | Certificate rotation | Rotate once; note which `iss` worked; note how long until the new certificate gets a token; check the key count | U86, U87, U88 | D3 |
| OV-D4 | Exchange audit of the panel's changes | After OV-D2, search the unified audit log for the entries | U89, U90 | D1 |
| OV-D5 | Contacts and synced objects | Create, edit, delete a contact; open a synced list and contact if the tenant has them | U15, U79, U80 | D1 |
| OV-D6 | Export import | Export with the Laposta preset and import into Laposta (or the owner's service) | U91 | D2 |
| OV-D7 | Retention and the audit screen | Check the chain after a retention run on real data | FR-D-453 | D2 |
| OV-D8 | Throttling | If a 429 occurs note the log events and the numbers | U81 | any |
| OV-D9 | Break-glass hardening | Enrol the second factor, test the allow-list from outside it | FR-D-801 | D3 |

---

## 9. Assumptions

| ID | Assumption | Evidence |
|---|---|---|
| AD-01 | The tenant uses Exchange Online with cloud-managed distribution groups; synced objects are rare | owner's tenant is a test tenant; EC-D5 handles the rest |
| AD-02 | A list has at most a few thousand members | the export limit is a constant |
| AD-03 | One `pwsh` worker serving calls serially is fast enough for an administrator tool | calls are rare; the deadline and recycle constants are tunable |
| AD-04 | The container may run on an Ubuntu LTS base (the owner decided ODB-01 = A) | decision of 2026-10-13 |
| AD-05 | The panel's own application may roll its own keys without a new permission | R-D-05 (OV-D3 confirms) |

---

## 10. Owner decisions

Recorded (owner, **2026-10-13**), implemented as stated:

| ID | Decision | Effect |
|---|---|---|
| ODB-01 | A: a `pwsh` worker in the one container on an Ubuntu LTS base | 6.1, FR-D-106, ADR 0180 |
| ODB-03 | Exchange Administrator for the service principal plus both app roles (`Exchange.ManageAsApp` and `ManageAsAppV2` where exposed); narrowing only after OV-13 and OV-D1 | 1.2, EC-D4 |
| ODB-08 | Repair flow in Phase B plus `addKey` self-rotation in Phase D | 6.8 |
| ODD-01 | Group member writes (Graph) are in Phase D | 6.4 |
| ODD-02 | Delivery in three steps D1, D2, D3, each with its own PR and owner test | section 3 |
| ODD-03 | RBAC administration in full as the brief describes | 6.7 |

New decisions, each with a default so that nothing blocks:

| ID | Decision | Options | Default in this spec | Needed by |
|---|---|---|---|---|
| ODD-04 | Audit retention | Keep forever (today); or a number of days | 400 days with a checkpoint so the chain still verifies; configurable, lower bound 90 | GD2 |
| ODD-05 | Global cap on denial audit rows | None; or a cap per hour | 2,000 per hour | GD2 |
| ODD-06 | Break-glass hardening (ODB-17) | Allow-list; second factor; both | Both, each optional | GD3 |
| ODD-07 | Export rate and step-up | Step-up always; or only above a row count | Always step-up, 6 per minute | GD2 |
| ODD-08 | Distroless is dropped for an Ubuntu LTS runtime | Accept; or keep distroless and a separate worker container (ODB-01 B) | Accept (follows ODB-01 A) | GD1 |

---

## 11. Risks

| ID | Risk | L / I | Mitigation |
|---|---|---|---|
| RD-01 | The in-memory certificate path fails on Linux (U75) | M / H | The tmpfs fallback with a negative control; OV-D1 early in D1 |
| RD-02 | The Ubuntu LTS image is much larger or slower to start (U84) | M / M | Measure first, record in the ADR; the size ceiling is the owner's number; `-CommandName` and `-SkipLoadingFormatData` (R-D-03) |
| RD-03 | The service principal cannot add members without manager rights (U78) | M / M | Bypass flag per call; Exchange role; OV-D2; a clear error |
| RD-04 | Exchange write is eventually consistent (U82) | H / L | `readBackPending`, UI note |
| RD-05 | A leak of member lists through logs or the worker | L / H | Worker logs only metadata; the canary tests |
| RD-06 | Rotation leaves the panel without a usable key | L / H | Verify before switch; fault injection at every step; the repair flow remains |
| RD-07 | The entry bundle budget is exceeded by D3 shared code | M / L | Lazy chunks only; stop and ask for an approved growth (never assumed) |
| RD-08 | The scope of D is too big for the review | M / M | Three steps, each its own gate and PR |
| RD-09 | CSV safety differs between Excel, LibreOffice and importers | M / M | Property test with an independent parser; the preview; OV-D6 |

---

## 12. Dependencies and what Phase D hands on

Phase D needs from Phase C: the cursor store, restricted rows, `groupKindOf`, `GraphClient` and `GraphHttp`, the policy layer, the DataTable and design system, lazy namespaces, the fake tenant and the e2e topology. It hands to the owner a finished, tested 1.0.0 candidate and the list of open risks and follow-up ideas of the brief (licence management, shared mailboxes, MFA overview, rules). No file of Phase B or C changes except the listed seams (plan section 5): `modules.ts`, the `ExchangeClient` and `GraphClient` ports and fakes, `limits.ts`, `problem.ts`, `permissions-map.ts`, i18n lazy lists, the Dockerfile, the CI workflow image stage, and docs.
