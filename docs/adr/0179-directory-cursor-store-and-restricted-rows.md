# ADR-0179: Directory cursor store and restricted rows

Samenvatting (NL): De lijsten van Fase C pagineren met een willekeurige cursor die naar een geheugenopslag wijst (gebonden aan aanvrager, route en parameters, 600 seconden, 1.000 items), en één functie bepaalt wat een aanvrager van een lid, eigenaar of manager mag zien (PC-02, PC-05).

## Status

Plan. Decided in the Phase C plan (PC-02 cursor store in memory, PC-05 restricted rows instead of omission for members and owners) and adjusted while building (gate GC1, deviations 2 to 5; the rows below are what the code does).

Source: `specs/003-phase-c/plan.md` section 10 (PC-02, PC-05), spec FR-C-103, FR-C-108 and FR-C-307.

## Context

Microsoft Graph pages through a long `@odata.nextLink` and never accepts `$skip` on the directory lists (R-C-01). Two problems follow for a read-only panel that shows users and groups to actors with different scopes:

1. The link is a Microsoft URL. It must not reach the browser (it is an outbound address the panel follows under its same-origin rule), and the browser needs a short opaque value to ask for "the next page". A list for a scoped actor also has to resume exactly after the last row it handed out, inside a Graph page of up to 999 rows, without a row twice or lost (FR-C-203).
2. A group lists members and owners, and a user has a manager. These are objects the actor met through someone else. If the actor's `users:read` or `groups:read` does not cover them, naming them would leak what the scope hides. Several handlers would each have to remember the rule (RC-05).

## Decision

**Cursor store.** The cursor of a directory list is a random handle into a store in process memory (`apps/server/src/directory/cursor-store.ts`). The handle is 18 random bytes, base64url, 24 characters. An entry holds the route, the canonical form of the parameters, the validated Graph page token and the number of rows of that Graph page that earlier pages used up. It is bound to the actor id, the route and the parameters (`q`, the filters, the order, the group or user): a handle used by another actor, on another route, with a changed filter, after it expired or after a restart is the same answer, 400 `cursor_invalid`, so a handle cannot be probed. An entry lives `LIMITS.directory.cursorTtlSeconds` (600) after it was made or last used (sliding), the store holds at most `LIMITS.directory.cursorEntries` (1,000) entries and drops the least recently used first. A handle may be used again. Nothing is written to disk and nothing is signed, so there is no key material and no replay beyond the actor the handle was made for. A scoped list reads at most `LIMITS.directory.scanPagesMax` (5) Graph pages per request, so a step may return fewer rows than asked for, even none, together with a cursor; the UI keeps offering "next" until the cursor is absent.

**One restricted-row function.** `apps/server/src/directory/restricted-rows.ts` (`toDirectoryRow`) is the only code that turns a member, an owner or the manager of a user into a row of the wire. A user is returned in full when the actor's `users:read` covers it in full, as `basic` (id, display name, mail; no principal name) when only a `basic` grant covers it, and otherwise as `{ kind, restricted: true }` with no id, no name, no address and not even a `null` id. A group is returned in full or restricted by `groups:read`. Any other object (device, service principal, contact) is returned as its kind and id without a name when the actor may see users or groups at all, and restricted otherwise. A missing attribute never matches a scope item. The function takes the policy layer's `VisibleScope` values, so it cannot be called by a handler that never asked the policy layer (ADR-0175). A user's list of groups (`users.groups`) is different on purpose: a group the actor may not see is left out, never shown as restricted, so membership cannot be probed.

## Consequences

- A restart loses every cursor. The UI restarts the list from the first page with a notice. This is accepted for a panel that runs as one replica (ADR-0126).
- A scoped actor on a very large tenant pays up to five Graph calls per request (RC-03); the limit is a constant and real timing is the owner's check OV-C3.
- Deviation 4 of gate GC1 is stricter than FR-C-204: an actor who is shown any user as `basic` (a `basic` grant, and no full grant on every user) may not use the `enabled` or `type` filters (422 `validation_failed`, `errors[0].code` `filter_not_allowed`), and the principal name is left out of that actor's search. Revisit with the owner test OV-C6.
- A member or owner list carries restricted rows, so the page count of restricted rows ("3 members you cannot see") is the number of restricted rows of the page, not a field of the answer.
- Both pieces are reusable for the distribution lists and contacts of Phase D (spec section 12).
- Unverified: whether Graph returns `department` and `mailNickname` on the polymorphic members and owners collections (U71, deviation 2 of GC1). Without them a department- or alias-scoped actor would see every member as restricted. The owner check OV-C4 and OV-C6 show it.

## Evidence

- `apps/server/test/directory/cursor-store.test.ts` (actor binding, sliding expiry with the injected clock, least-recently-used eviction at 1,000, 18 random bytes, a foreign handle; negative: a store that ignores the actor), `scoped-list.test.ts` (seeded property test, 20,000 cases against the naive filter, resume after a partly used page, five pages), `restricted-rows.test.ts` (no id, name or address; `basic`; fail closed; negative: a handler that returns the raw row), `users-routes.test.ts` and `groups-routes.test.ts` (end to end on the fake tenant).
- `specs/003-phase-c/gate-notes/GC1.md`, the table of tasks T-C-018 to T-C-023 and the list of deviations.
- Not verified here: behaviour against a real Microsoft 365 tenant. That is the owner-verified ledger OV-C1 to OV-C6 (`docs/owner-test-phase-c.md`).
