# Phase D step D1 report / Fase D stap D1-rapport

Date / datum: 2026-10-13 · Branch `claude/modest-bohr-45f4kf`, build `0.3.58` (HEAD `44287d2` plus the documentation of this report) · Spec: `specs/004-phase-d/spec.md` · Gate notes: `specs/004-phase-d/gate-notes/GD1-0.md`, `GD1-web.md`, `GD1-server-a.md`, `GD1-server-b.md`

Status: **Step D1 of Phase D is built; the owner test against a real Microsoft 365 test tenant is open; CI results (quality, e2e, image, CodeQL, Trivy, visual baselines) are pending.** Two things are not finished and are named here first: **(1)** the credential source of the worker is **built** (decided on 2026-10-13: PEM, option C) but **not proven**: nothing has run against a real `pwsh` or a tenant (U75, OV-D1); **(2)** the Ubuntu image was not built in this environment; CI measured it at **538.2 MB** (amd64) and the owner decided on 2026-10-13 that its **size ceiling is 600 MB** (arm64 and the memory of a long-running worker are not measured). Nothing in this report claims what only a real tenant or a built image can show.

Status: **Stap D1 van Fase D is gebouwd; de test van de eigenaar op een echte Microsoft 365-testtenant staat open; de CI-resultaten (quality, e2e, image, CodeQL, Trivy, visuele baselines) zijn "pending".** Twee dingen zijn niet af en staan hier vooraan: **(1)** de bron van de inloggegevens van de worker is **gebouwd** (besloten op 2026-10-13: PEM, optie C) maar **niet bewezen**: niets is gedraaid tegen een echte `pwsh` of een tenant (U75, OV-D1); **(2)** de Ubuntu-image is hier niet gebouwd; CI mat **538,2 MB** (amd64) en de eigenaar besloot op 13-10-2026 tot een **plafond van 600 MB** (arm64 en het geheugen van een langlopende worker zijn niet gemeten). Dit rapport beweert niets wat alleen een echte tenant of een gebouwde image kan laten zien.

---

## 0. Samenvatting (Nederlands)

**Wat er is.** Het paneel schrijft nu voor het eerst. Stap D1 bouwt: een **Exchange-laag** met één `pwsh`-werkproces in dezelfde container (de image is daarvoor Ubuntu 24.04 met PowerShell 7.6 en de Exchange-module in plaats van distroless, besluit ODB-01 A), **distributielijsten** (lijst, detail, leden bekijken, **leden toevoegen en verwijderen** met een resultaat per lid), **mailcontacten** (aanmaken, bewerken, verwijderen met validatie en een getypte bevestiging) en **leden toevoegen en verwijderen bij gewone groepen** (Microsoft 365 en beveiliging, via Graph met het al verleende `GroupMember.ReadWrite.All`). Veertien routes (P40 tot en met P45 en P47 tot en met P54), de pagina's in twee talen, nieuwe grenzen in `docs/operations.md` en één nieuwe omgevingsvariabele, `EXCHANGE_KEY_HANDOVER` (standaard `memory`).

**Wat zeker is.** Alles wat de simulatie kan laten zien is getest: de worker met een gesloten lijst van tien cmdlets en een protocol dat framing, overlopen en elke foutcode afdekt, de nep-tenant voor Exchange en Graph is net zo streng als Learn zegt, geen sleutel op schijf in de standaardmodus, geen naam of adres in logs of auditregels, een verse step-up boven 20 leden, het `/$ref`-pad van Graph, scope per object, en per lid een resultaat. Het workerscript is op een echte PowerShell 7 gedraaid (zonder tenant).

**Wat niet zeker is.** Hoe Microsoft echt antwoordt: **U75 tot en met U100** (onder andere of het certificaat op Linux uit het geheugen werkt, of de rol van de service principal de beheerderscontrole van een lijst vervult, hoe lang Exchange nodig heeft om een wijziging te tonen en of het Exchange-auditlog de uitvoeringen van het paneel bevat). Die sluit alleen jouw test, **OV-D1, OV-D2, OV-D4 en OV-D5**, met het stappenplan in [`docs/owner-test-phase-d1.md`](../owner-test-phase-d1.md) (ongeveer 90 minuten plus 30 minuten wachten). Ook niet bewezen: de gebouwde image (`docker build`, grootte, starttijd, de arm64-ping), de volledige e2e-matrix en de visuele baselines; die komen van de CI.

**Twee dingen die nog niet af zijn.** (1) De bron van de inloggegevens is gebouwd (jij koos PEM) maar niet bewezen tegen een echte `pwsh` of tenant; kan Exchange niet verbinden, dan antwoorden de Exchange-pagina's "Exchange is niet beschikbaar". Groepsledenbeheer via Graph werkt wel. (2) De image mat in CI 538,2 MB (amd64); de eigenaar besloot op 13-10-2026 tot een plafond van 600 MB (was 400 MB). arm64 en het geheugen van een langlopende worker zijn niet gemeten.

**De vraag.** Mag stap D2 (CSV-export en auditscherm) beginnen? Het plafond voor de image is besloten (600 MB). Zie sectie 5.

---

## 1. What was built / Wat is gebouwd

- **Routes P40 to P45 and P47 to P54** (14 routes, ids in lower case: `distributionlists.list`, `.get`, `.members`, `.members.add`, `.members.remove`, `.search`; `contacts.list`, `.get`, `.create`, `.update`, `.delete`, `.memberships`; `groups.members.add`, `.members.remove`). Reads class `read`, writes class `write`, all `Cache-Control: no-store`. Member writes: 1 to 200 ids, one result per member (`added`, `removed`, `already`, `failed` with a reason), membership read first, chunks of 50 (lists) or 20 (groups), a fresh step-up above 20 members, `readBackPending` for lists. Contacts: validated fields, a derived Exchange name, duplicate address or alias is 409 `conflict` with the field as pointer and no id, delete needs the typed display name and answers the lists the contact was removed from. Reference: [`docs/api.md`](../api.md).
- **Exchange worker** (`PwshExchangeClient`, session, launcher, generated script): one long-lived `pwsh` child, line-delimited JSON on stdin and stdout, serial calls with a 120-second deadline, recycled after 500 calls or 3,600 seconds, bounded retries (3, 1 s to 15 s), a closed allow-list of **ten cmdlets** checked twice and pinned by a hash, `Confirm` and `WhatIf` never a caller parameter, no empty identity, the certificate in memory by default (`EXCHANGE_KEY_HANDOVER=memory`) or through a mode 0600 tmpfs file (`tmpfs`, fallback). ADR-0181; [`docs/security.md`](../security.md).
- **Image**: the runtime stage is `ubuntu:24.04` by digest with PowerShell 7.6.6 and `ExchangeOnlineManagement` 3.10.1 (checksums checked in the same `RUN`), user `nonroot` 65532, node at `/nodejs/bin/node` (entry point unchanged), telemetry off. It has a shell now. ADR-0180; [`docs/operations.md`](../operations.md#the-exchange-worker-phase-d-step-d1).
- **Graph**: two write methods on the port and both implementations (`addGroupMember`, `removeGroupMember`), the delete path built by one function that always ends in `/$ref`, a guard that allows exactly these two write methods. `GroupMember.ReadWrite.All` is now **used** ([`docs/permissions.md`](../permissions.md), Part 5). No new permission.
- **Fakes**: the Exchange write module of the fake tenant (strict on member types, duplicates, the manager check with and without the bypass, synchronised objects, a read-back delay), the Graph member writes, and a stand-in process that speaks the worker protocol.
- **Web**: Distribution lists (search, kind filter, detail, members, add and remove with the result table), Contacts (list, detail, create, edit, delete dialogs, validation at the field), member editing on the Groups page (five read-only cases with their reason), a shared member picker; all in lazy chunks and lazy catalogues in Dutch and English.
- **Audit**: seven actions (`dl.member.add|remove`, `group.member.add|remove`, `contact.create|update|delete`), one entry per member plus a summary entry; no name or address in any entry.
- **Limits** (`LIMITS.exchange`, `.distributionLists`, `.groupMembers`, `.contacts`, `.rateLimit.export`): eight new rows in `docs/operations.md`, compared with the code by `limits-doc.test.ts`. The largest request stays 9,437,184 bytes (a write body holds at most 200 GUIDs).
- **Docs**: `docs/api.md`, `docs/permissions.md` Part 5, `docs/operations.md`, `docs/security.md`, ADR-0180 and ADR-0181, `README.md`, `docs/open-points.md` (U75 to U100, FD-01 to FD-24), `docs/owner-test-phase-d1.md`, this report; all in Dutch and English.

**Deliberately not built in D1**: the export and the audit screen (D2), role administration, certificate rotation, break-glass hardening and telemetry (D3), members of dynamic lists, creating or deleting lists and groups, changing the names of a contact, owner and manager changes, licences (U17, U48), and the credential source of the worker (FD-01, in progress).

**Deployment-file changes (AGENTS.md statement).** The operator has to change **nothing by hand**. What changed: **(a)** `Dockerfile`: new stage `pwsh-fetch` and an Ubuntu 24.04 runtime stage; **(b)** `.github/workflows/image.yml`: the arm64 smoke step also pings the Exchange worker (still `continue-on-error`; no step added or renamed); **(c)** `docker-compose.yml`: the line `EXCHANGE_KEY_HANDOVER:` in the `environment` block passes the variable through (unset or empty means the default `memory`); **(d)** `.env.example`: `EXCHANGE_KEY_HANDOVER=memory` with its comment. **New variable `EXCHANGE_KEY_HANDOVER`, default `memory`, values `memory` or `tmpfs`; it need not be added by hand.** No new Compose mapping line, no new volume, no migration. **An existing Phase C deployment keeps working untouched:** pull the new image and recreate the container (uid 65532, port, volume and entry point are the same; the image is larger). **Limits as numbers:** the largest request stays 9,437,184 bytes; the image size ceiling is 400 MB today and **must be re-set by the owner** (section 5).

**Wat is gebouwd (Nederlands, kort)**: veertien routes, een Exchange-worker met een gesloten lijst van tien cmdlets, een Ubuntu-image met PowerShell, twee schrijfmethoden op de Graph-client, uitgebreide nep-tenants en een stand-in voor de worker, de pagina's Distributielijsten en Contacten en ledenbeheer bij Groepen in twee talen, zeven auditacties, acht nieuwe grenzen en één nieuwe omgevingsvariabele. Deployment-bestanden: `Dockerfile`, `image.yml`, `docker-compose.yml` (`EXCHANGE_KEY_HANDOVER:` doorgegeven) en `.env.example`; een bestaande installatie blijft ongewijzigd werken (image ophalen, container opnieuw maken); je hoeft niets met de hand toe te voegen. Niet gebouwd: export, auditscherm, rollenbeheer, rotatie, leden van dynamische lijsten en de bron van de inloggegevens (in uitvoering).

---

## 2. Test results / Testresultaten

### 2.1 What ran locally / Lokaal uitgevoerd

From the gate notes (2026-10-13, Node v22, pnpm 10), each on the working tree of its own stream. **The full run of one clean tree, and every CI job, is pending: this report does not state a combined number.**

| Check | Result (source) |
|---|---|
| Shared contract (`GD1-0`) | 52 files / 3,966 tests green (47 / 3,780 before); lint, typecheck green; `pnpm i18n:merge` and `i18n:check` green; `pnpm test:tools` 15 files / 1,118 tests green |
| Web (`GD1-web`) | lint, typecheck green; 80 files / 1,996 tests green (6 new files with 104 tests); `i18n:check` green; `routes:generate` idempotent |
| Server part A (`GD1-server-a`) | lint, typecheck green; at that gate 218 of 219 files passed or were skipped, 9,017 tests passed, 4 failed (`limits-doc.test.ts`, the known interim red, closed by the docs rows); `python3 -m unittest discover -s scripts` 245 tests green; `exchange:check` green |
| Real PowerShell 7 (`GD1-server-a`) | the worker script ran on a real `pwsh`: 10 tests green (protocol, allow-list, the tmpfs hand-over file with mode 0600, removed again). **No tenant was contacted** |
| Server part B (`GD1-server-b`) | lint, typecheck green; **234 files passed, 1 skipped (`real-pwsh.test.ts` without `pwsh`), 9,154 tests passed, 11 skipped, 0 failed** (16 new files with 133 tests). One run on a loaded machine failed `branding/hostile-uploads.test.ts` H-42; alone it passes (353 of 353) and the final full run was green |
| Red first (`GD1-server-b`) | the 19 new or changed test files run against a tree without `apps/server/src`: 16 files failed, 53 tests failed, 96 passed, 7 suites could not load; the tests of the HTTP routes were written directly after the code, not before (a deviation, FD-17) |
| `pnpm bundle:check` | the owner approved the Phase D growth twice (ODD-11); the D1 web pages measured initial JS 247,422 B gzip (budget 247,740) and first load 278,796 B Brotli (budget 280,572), so about 1.8 KB of first-load room is left for D2 and D3 (FD-15) |
| `pnpm docs:check` (docs contract and limits tests) | green at the time of writing, with the D1 rows, ADR-0181 and the D1 documents; CI repeats it |

### 2.2 Only on GitHub, or not yet run / Alleen op GitHub of nog niet gedraaid

**CI results: pending.** Not run anywhere: `docker build` of the new Dockerfile, `pnpm image:smoke` (including the worker ping and `workerPingMs`), `check_image_size.py` against a real image (CI has since measured 538.2 MB on amd64 and the owner set the ceiling to 600 MB on 2026-10-13), the arm64 worker ping, Trivy and CodeQL on the new base, the full `pnpm e2e` matrix (`e2e/tests/pages.spec.ts` and `nav-gating.spec.ts` still describe the two pages as placeholders, FD-20), the visual baselines of the new pages (never from the sandbox), `pnpm lint` and `pnpm test` of the whole repository on one tree, and the gate note `GD1.md` (T-D-198).

### 2.3 Simulated / Gesimuleerd

Entra, Graph and Exchange are the one fake tenant, plus a stand-in for the worker at the process boundary. They encode our reading of Learn (R-D-01 to R-D-09): member types, the manager check, `/$ref`, the 400 ambiguity, eventual consistency. **A passing test proves our code against our reading, not Microsoft's behaviour** (RC-04, and U75 to U100).

### 2.4 Could not be tested here / Niet testbaar

A real tenant (OV-D1, OV-D2, OV-D4, OV-D5), a built image (size, start time, memory), the module on Linux with a real certificate, the Exchange audit log, screen readers, and any real throttling.

---

## 3. Step list to try it yourself / Stappenlijst voor de eigenaar

The full list, in English and Dutch, with copyable commands and what you may and may not copy back, is [`docs/owner-test-phase-d1.md`](../owner-test-phase-d1.md): about 90 minutes plus a wait of about 30 minutes, sections A to K. It needs a test tenant, never production. Sections A to F (OV-D1) need only the image; the Exchange parts of G, H and I need a build with the finished credential source (FD-01); the group steps of G need neither. The panel keeps working whatever the answers are. It also asks for the **image size decision** (section J).

De volledige lijst, in het Engels en Nederlands, staat in [`docs/owner-test-phase-d1.md`](../owner-test-phase-d1.md): ongeveer 90 minuten plus ongeveer 30 minuten wachten, secties A tot en met K, op een testtenant. Secties A tot en met F (OV-D1) hebben alleen de image nodig; de Exchange-delen van G, H en I een build met de afgeronde bron van de inloggegevens (FD-01).

### 3.1 Owner-verified ledger / Grootboek (OV-D1, OV-D2, OV-D4, OV-D5)

| ID | Check | Closes | Result |
|---|---|---|---|
| OV-D1 | Connect with the certificate in memory, the cmdlets that answer, no key on disk, memory, a 15-minute session | U75, U76, U77, U83, U84, U85, U99 | not tested |
| OV-D2 | Member writes without manager rights (with the bypass in the panel, without it at the worker); read-back delay; role-assignable group; read-only lists and groups | U78, U82, U92, U93, U94, U96, U98, U100 | not tested |
| OV-D4 | The Exchange audit log shows the panel's changes | U89, U90 | not tested |
| OV-D5 | Contacts (create, duplicate, same name, edit, delete), the filters and searches, synchronised objects | U15 (answered), U79, U80, U95, U97, U98, U99 | not tested |
| (decision) | Image size ceiling | U84, ODD-10 | decided 2026-10-13: 600 MB (CI measured 538.2 MB); arm64 and long-running memory not measured |

---

## 4. Open points, deviations and decisions / Open punten, afwijkingen en besluiten

Full registers: `docs/open-points.md`, section "Phase D" (U75 to U100 with status, OV-D1 to OV-D9, ODD-01 to ODD-11, AD, RD and the findings FD-01 to FD-24).

### 4.1 Not yet done in step D1 / Nog niet gedaan

1. **The credential source of the worker (FD-01).** Decided: PEM (option C). **Built** (`SecretsRuntime.withCertificateMaterial`, `credential-source.ts`, the tmpfs fallback derives a PKCS#12 from the PEMs; GD1-0 Amendment 1) and **not proven** against a real `pwsh` or a tenant (`CreateFromPem`, `Connect-ExchangeOnline`: U75, OV-D1). If the source cannot produce the certificate every Exchange route answers 503 `exchange_unavailable`; Graph features work.
2. **The image was not built here**; CI measured it at 538.2 MB (amd64) and the owner decided the ceiling of 600 MB on 2026-10-13 (FD-02, FD-03). arm64 and the memory of a long-running worker are not measured.
3. U75 to U100 and OV-D1, OV-D2, OV-D4, OV-D5: the owner test (all `open`).
4. CI for the step (FD-21), the e2e specs for the two pages and the visual baselines (FD-20), the gate note `GD1.md`.
5. Dynamic lists show no members and nothing says why (FD-05); the `narrow_search` message was missing at the gate and now exists (FD-06, FD-24); a list of more than about 2,500 members cannot be read (FD-07).

### 4.2 Deviations from the spec and tasks, with evidence / Afwijkingen

The code is right in each case; spec and tasks were amended and say so.

| # | Deviation | Source |
|---|---|---|
| 1 | Route ids of `distributionlists.*` are lower case (the audit action grammar has no capital letter); spec 6.11.1 amended | GD1-server-b, FD-04 |
| 2 | Layout routes `distribution-lists.tsx` and `contacts.tsx` plus `.index` routes, because a route with a child must render an outlet | GD1-web |
| 3 | Dynamic lists have no member list (`Get-DynamicDistributionGroupMember` is not on the allow-list); the frozen schema has no state field | GD1-server-a, GD1-server-b, FD-05 |
| 4 | `narrow_search` is a detail code that had no catalogue message at the gate; it has one now (`distributionLists.error.narrow_search`, `contacts.error.narrow_search`) | GD1-server-b, GD1-0 Amendment 1, FD-06, FD-24 |
| 5 | A hidden-membership group is 409 `read_only_object` for writes | GD1-server-b, FD-08 |
| 6 | P45 issues no cursor; users without a mailbox address are not offered | GD1-server-b, FD-09 |
| 7 | `validation_failed` carries the code of a custom message; `Retry-After` on `exchange_unavailable` (30 s) and `exchange_throttled` | GD1-server-b, FD-10 |
| 8 | Step-up above a threshold is decided in the handler (`PolicyDenied` reason `step_up_required`) | GD1-server-b, FD-11 |
| 9 | The audit vocabulary of D1 is separate from Phase B (seven actions, nine keys) | GD1-server-b, FD-12 |
| 10 | A module `groups` beside `directory`; `appModules` has 10 entries | GD1-server-b, FD-13 |
| 11 | `ExchangeClient.listDistributionGroupMembers` no longer hands out a cut list (`too_many_rows`) | GD1-server-b, FD-07 |
| 12 | `EXCHANGE_KEY_HANDOVER` was not in the first spec table; spec 6.1 amended | GD1-server-a, FD-16 |
| 13 | Server part B was written code first and tests directly after; the self-tests are separate files; the Python checks are in `scripts/`, not `py/` | GD1-server-a, GD1-server-b, FD-17 |
| 14 | The bundle budget needed two owner approvals (`approvedGrowth` in `scripts/bundle-budget.json`) | GD1-0, GD1-web, FD-15 |
| 15 | No command palette entry was added (the entry catalogue has no room) | GD1-web |

### 4.3 Owner decisions / Besluiten van de eigenaar

| ID | Decision | Status |
|---|---|---|
| ODB-01 | A: a `pwsh` worker in the one container on Ubuntu LTS | closed 2026-10-13; built in D1 |
| ODB-03 | Exchange Administrator plus both app roles; narrowing only after OV-D1 | closed 2026-10-13; the wizard grants both |
| ODD-01 | Group member writes through Graph in Phase D | closed 2026-10-13; built in D1 |
| ODD-08 | Distroless is dropped for an Ubuntu LTS runtime | implemented in D1 |
| ODD-09 | Certificate format handed to the worker: PKCS#12 (A or B) or PEM (C) | **decided C, PEM, 2026-10-13; built, not proven against `pwsh` or a tenant** |
| ODD-10 | The image size ceiling | **closed 2026-10-13: 600 MB** (CI measured 538.2 MB, amd64) |
| ODD-11 | Bundle budget for the three steps (+2,048 B gzip JS, +3,072 B Brotli first load) | recorded 2026-10-13 |

---

## 5. Decisions needed from the owner, and the question / Besluiten en de vraag

1. **The image size ceiling (ODD-10): decided.** CI measured the new image at 538.2 MB (amd64, run 38394173673) and on 2026-10-13 the owner decided that the ceiling becomes 600 MB (was 400 MB). Nothing is asked here any more. arm64 and the memory of a long-running worker are not measured (U84).
2. **Large lists (FD-07).** A list with more than about 2,500 members cannot be read through a 1 MiB protocol line. Tell whether that is acceptable for your tenant or whether the line or the projection should change before D2.
3. **Already decided, for the record:** PKCS#12 against PEM for the worker's certificate was **decided on 2026-10-13: PEM**; it is built (GD1-0 Amendment 1) and not proven against a real `pwsh` or a tenant.
4. **Bundle room.** About 1.8 KB of first-load room is left for D2 and D3; any more needs a further approval.

### The question / De vraag

Approve proceeding to step D2 (CSV export and the audit screen)? (The image size ceiling is already decided: 600 MB.) The owner fills in the approval line below; nobody else does. Nothing for step D2 is started before it is filled in.

Akkoord om door te gaan met stap D2? (Het plafond voor de grootte van de image is al besloten: 600 MB.)

Naam en datum / Name and date:
