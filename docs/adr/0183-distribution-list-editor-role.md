# ADR-0183: The sixth built-in role, Distribution List Editor

Samenvatting (NL): Er is een zesde vaste rol bijgekomen, *Distribution List Editor* (sleutel `dl_editor`). De rol mag contacten aanmaken, bewerken en verwijderen, distributielijsten lezen, er leden aan toevoegen of uit verwijderen, en gebruikers lezen (nodig om leden te zoeken). Verder niets: geen groepen, geen export, geen auditlogboek, geen instellingen en geen rolbeheer. De rol zit in migratie `0002_dl_editor_role`; het aantal vaste rollen in de triggers gaat van vijf naar zes, de rechten van de bestaande rollen veranderen niet. Samen met de rol is het scherm *Instellingen, Rollen en toegang* gebouwd, waarmee een Eigenaar bestaande gebruikers en Entra-groepen een rol geeft of afneemt.

## Status

Accepted by the owner on 2026-10-14 (request: the roles must be defined so that existing users can be given rights on the portal, plus an extra role that can manage mail contacts and put them on, or take them off, existing distribution lists). Changes the built-in role set of FR-B-501 (a change of the constant needs a new migration and an ADR). Requirement: FR-B-501, FR-B-502, FR-B-508 (assignments), FR-B-515 (no privileged role for a group), FR-D-601 to FR-D-608 (role administration; the first part of the screen is built here, ahead of step D3).

Source: the owner's request in the session of 2026-10-14; `docs/permissions.md` Part 3 (the matrix, one more column); spec 002-phase-b 6.9.4.

## Context

Migration `0001` sealed the built-in roles at five and made them immutable by trigger: no sixth built-in row could be inserted and no permission row of a built-in role could be added. The roles *Operator* (contacts and lists, plus groups) and *Helpdesk* (lists, no contacts) did not fit a person whose whole job is the mail contacts and the lists they sit on. Giving such a person *Operator* also gives them the members of Microsoft 365 and security groups; giving *Helpdesk* does not let them manage contacts at all. The assignment API existed (`POST /api/v1/rbac/assignments`), but no page used it, so an Owner had no way to give an existing user a role short of calling the API by hand.

## Decision

1. **The role `dl_editor`** holds seven permissions, all with the qualifier `full`: `users:read`, `distributionlists:read`, `distributionlists:members:write`, `contacts:read`, `contacts:create`, `contacts:update`, `contacts:delete`. `users:read` is there because searching for members to add (P45) reads users; without it only contacts could be found. It holds none of `groups:*`, `distributionlists:export`, `audit:*`, `settings:*` or `rbac:manage`.
2. **Migration `0002_dl_editor_role`** drops the two triggers that protect the built-in roles from new rows, seeds the role and its seven permissions with the fixed instant `2026-01-01T00:00:00.000Z`, and creates the two triggers again with the limit six. The epoch triggers count the eight inserts; the migration puts the epoch back, because no grant of an existing role changed and no cached grant is stale. The number of triggers stays 32.
3. **One constant.** `BUILTIN_ROLES` in `packages/shared/src/rbac/roles.ts` gets the sixth entry. The start-up check (`builtin-check.ts`) compares the database with it, so a database without migration `0002` does not start (`builtin_roles_mismatch`).
4. **The role can be given to a group** (it holds neither `rbac:manage` nor `settings:connection`), and is scoped like any other role: *Contacts and lists of department X* is a scoped assignment.
5. **The page `/settings/roles`** ("Rollen en toegang") needs `rbac:manage` (an Owner; the break-glass session has the permission but not the page, it has its own). It lists the assignments (P28), names the people and groups through the directory routes, gives a user or group a role (P29) and removes an assignment after a confirmation that names role and person (P30). It offers a group only the roles a group may hold. It adds nothing the server does not enforce: step-up, the check that the actor could hold the role, the last Owner and the existing-assignment conflict all come from the server, in words of the catalogue.

## Consequences

- A fresh installation and an upgraded one end with the same six roles; `schema-snapshots/0002-dl_editor_role.sql` is the committed snapshot of version 2, and the upgrade harness got a seed for version 1 and a `appends` rule so that a migration may add rows to named tables.
- The totals of the matrix are now 15, 13, 9, 6, 4 and 7 (and 5 for the template *Bestuur*); `docs/permissions.md`, the spec table and every test that counted five were updated in the same change.
- The page does not edit scopes yet (an assignment given here is unscoped) and does not offer custom roles; those remain in step D3 (FR-D-601, FR-D-602, FR-D-604, FR-D-606 and FR-D-608: custom roles, cloning, templates, scope per assignment, effective permissions, "view as").
- Operators: nothing to change in `.env` or Compose. Existing assignments keep working. After the upgrade, an Owner opens *Settings, Roles and access* to give existing users the role they need.

## Evidence

- `packages/shared/test/rbac-matrix.test.ts`, `rbac-effective.test.ts`, `rbac-roles-wire.test.ts`: the six roles and their cells.
- `apps/server/test/migrations.upgrade.test.ts` (block "the real upgrade 0001 to 0002_dl_editor_role"), `rbac/builtin-roles.test.ts`, `policy-matrix.test.ts`, `docs-contract.test.ts`: the migration, the immutability at six, the matrix of `docs/permissions.md` against the constant.
- `apps/web/test/roles-page.test.tsx` and `e2e/tests/roles-admin.spec.ts` (give with step-up, conflict, remove), `e2e/tests/nav-gating.spec.ts` and `access.spec.ts` (the new principal), `e2e/tests/a11y.spec.ts` (axe on `/settings/roles`).
- Not verified: a run against a real Microsoft 365 tenant (the directory lookups of names use the existing Graph routes).
