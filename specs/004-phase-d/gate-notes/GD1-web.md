# Gate note GD1-web (T-D-165): the web stream of step D1

Verdict: **GD1-web passed for lint, typecheck and tests; ONE STOP CONDITION: `pnpm bundle:check` is over the Brotli first-load budget by 272 B** (section "Bundle check"). The initial JavaScript and the entry CSS are within budget. `scripts/bundle-budget.json` was not touched.

## What was run, on which state

State: branch `claude/modest-bohr-45f4kf`, HEAD `0d4c0e8` (GD1-0) plus the uncommitted S-D3 working tree (the orchestrator commits), 2026-10-13, Node v22, pnpm 10. `VERSION` is 0.3.55 and was not bumped here.

| Command | Result |
|---|---|
| `pnpm --filter @m365portal/web lint` (`tsr generate && eslint . --max-warnings 0`) | green |
| `pnpm --filter @m365portal/web typecheck` (`tsr generate && tsc -b`) | green |
| `pnpm --filter @m365portal/web test` | green: 80 files / 1,996 tests (74 files before this stream; it adds 6 files with 104 tests and changes 6 others) |
| `pnpm i18n:merge`, `pnpm i18n:check` | check green: 2 files / 177 tests; the shared tests `i18n*`, `message-keys`, `error-codes` green: 6 files / 620 tests |
| `pnpm --filter @m365portal/web build`, `pnpm bundle:check` | **fails on one number**, see below |
| `pnpm routes:generate` | idempotent (the md5 of `routeTree.gen.ts` is the same after a second run); `routes:check` needs the committed file and was not run |
| Not run | `pnpm e2e` and the visual baselines (S-D4 and CI), the server tests (S-D2's), the other packages |

## Tasks (evidence)

Test-first as the protocol asks: the test files and the MSW-style handlers (`test/support/phase-d-handlers.ts`, built from the frozen schemas, every answer parsed with its route's schema, every request parsed with the request schema) were written before any page code, and the red state was shown by running them against the tree without the code.

| Task | Test files (`apps/web/test/`) | Red first, for the right reason | Green |
|---|---|---|---|
| T-D-150 `MemberPicker`, `MemberResults` | `member-picker.test.tsx` (17: debounce once with the trimmed text, no search for blank text, results with kind and address, empty, translated error with retry, users wording, Dutch, multi-select and removal from the selection, selection kept across searches, already-a-member disabled, the limit, Enter / ArrowDown / space, the selection as a status, the result view: counts, failures first, reasons, all done, all failed, read-back note with refresh, dismiss) | the file failed to load: `Cannot find module ../src/features/directory/MemberPicker` | 17 / 17 |
| T-D-151 distribution lists | `distribution-lists-page.test.tsx` (27: kinds, read-only badge, dash, search and kind filter in the URL, empty and filtered-empty, error with retry, `exchange_role_pending` detail code, gating and Dutch, detail properties and members, restricted rows counted, paging, empty members, members failing alone, not found / not an id, dynamic and synced read-only, no buttons without the permission, add with picker and result, partial failure, read-back pending, refusal inside the dialog, step-up note, remove with confirmation, cancel, partial removal, whole-request failure) | placeholder pages: `Unable to find an accessible element with the role "table"`, headings and buttons absent | 27 / 27 |
| T-D-152 contacts | `contacts-page.test.tsx` (30), `contacts-delete-dialog.test.tsx` (9) | the same: placeholders, no table, no button, no dialog | 39 / 39 |
| T-D-153 group member editing | `group-members-write.test.tsx` (15: editable kinds, five read-only cases with their reason, no permission and no reason, hidden membership, add, partial failure, refusal, remove with confirmation, restricted row, Dutch) | `Unable to find an accessible element with the role "button"` (no add button); the one test that expects no editor passed | 15 / 15 |
| T-D-154 strings, namespaces, nav | `lazy-namespaces.test.ts` (+2 loaders, +2 negatives), `routes-coverage.test.ts`, `pages.test.tsx`, `placeholders.test.tsx` (the two pages are real now), `directory-search.test.ts` (+2), the shared `i18n-catalogue` / `i18n-fragments` | `lazy-namespaces.test.ts` was red before the routes loaded the namespaces (`no route loads the lazy namespace distributionLists`, `contacts`: the interim red of GD1-0) | green |
| accessibility (unit) | `phase-d-a11y.test.tsx` (6: outline, captions and scopes, named controls, dialog name and focus return, form message as description and focus on the first wrong field, member removal with the keyboard alone) | written with the pages | 6 / 6 |

First red run of the five page and picker files, against the tree without the code: **5 files failed, 80 tests failed, 1 passed** (the passing test asserts that a hidden-membership group shows no editor).

Negatives landed here: `lazy-namespaces.test.ts` (the contacts layout without `distributionLists`, the groups layout without it), `directory-search.test.ts` (bad values dropped, every key named), the handlers refuse a request that does not fit the schema (a test that sends a wrong body fails in the handler, not by luck), `group-members-write.test.tsx` and `distribution-lists-page.test.tsx` (an actor without the permission gets no button; a read-only kind gets no checkbox).

## Files

New: `features/directory/{MemberPicker,MemberResults,MemberActions,MemberDialogs,candidates,capabilities,useMemberSelection}`, `features/distribution-lists/{queries,columns,ListFilters,ListKindBadge,ListMembersTable,DistributionListsPage,DistributionListDetail}`, `features/contacts/{queries,validation,ContactsPage,ContactDetail,ContactFormDialog,DeleteContactDialog}`, `features/groups/{member-editing,GroupMembersReadOnly}`, routes `distribution-lists.index`, `distribution-lists.$id`, `contacts.index`, `contacts.$id`. Changed: routes `distribution-lists`, `contacts`, `groups` (layouts with the gate and the namespaces), `features/groups/{GroupDetail,MembersTable,queries}`, `features/directory/{StateNotice,search}`, `lib/locale.ts` (three namespace groups), `routeTree.gen.ts` (regenerated). Strings: the fragments `distributionLists`, `contacts`, `groups` in `packages/shared/src/i18n/fragments` (all frozen keys unchanged, the rest added in nl and en) and the merged lazy files.

## Decisions and deviations

1. **Layout and index routes.** The plan names `distribution-lists.tsx` and `distribution-lists.$id.tsx`. A route with a child must render an outlet, so, as in Phase C, `distribution-lists.tsx` and `contacts.tsx` are layouts (gate, namespaces, outlet) and `distribution-lists.index.tsx` and `contacts.index.tsx` are the lists. `/distribution-lists/$id` and `/contacts/$id` are added to the parameterised routes of `routes-coverage.test.ts`; the e2e route list is unchanged.
2. **Namespaces.** The lists and contacts pages load `users` as well: the shared directory components (`textOrDash`, `ListFooter`, `DirectoryError`) use `users.*` keys. Groups: `LIST_NAMESPACES` = users, distributionLists; `CONTACT_NAMESPACES` = users, contacts, distributionLists; `MEMBER_NAMESPACES` = distributionLists (also loaded by `/groups`).
3. **Picker and result wording** is generic and lives in `distributionLists.*` (the groups page uses it), with `picker.search.labelUsers` / `hintUsers` and `add.descriptionUsers` added for groups, where only users can be added. The frozen shell keys are used as frozen.
4. **Capabilities.** `useCan(permission)` reads `me.permissions` (held anywhere). Scopes decide per object on the server; a refusal (`permission_denied`) is shown as its translated message. The contact detail hides the lists section without `distributionlists:read`.
5. **Dialogs are chunks of their own** (`MemberDialogs`, `ContactFormDialog`, `DeleteContactDialog`, loaded on the first button press) so the route chunks and the preload map stay small; the picker is not imported by any page statically (`candidates.ts` holds the shared types).
6. **Contact form** trims the display name, alias and names before it validates (a trailing space is a paste error, not a reason to stop), normalises the address with `normalizeExternalAddress`, and sends only changed fields on edit (`nothing_to_change` otherwise). Server field errors (`errors[]` pointers) are shown at their field; `conflict` uses `problem.conflict`.
7. **Command palette / nav.** Phase C added only the navigation commands, and they exist for both pages since Phase A (`distribution-lists`, `contacts`); no palette entry was added (a "new contact" command would grow the entry catalogue, which has 0 B of room).
8. **Delete dialog** is Radix `AlertDialog` built from the shared dialog classes (the `ConfirmDialog` has no field); focus lands on Cancel, the typed name must equal the display name, and the toast names the number of lists the contact was removed from.
9. The step-up (`step_up_required`) is handled by the API client (the session dialog opens, the write is not replayed); the add dialog keeps its selection and warns beforehand above `LIMITS.<x>.stepUpAbove`.

## Bundle check

| | initial JS gzip | entry CSS raw | first load Brotli |
|---|---|---|---|
| Budget (with the approved Phase D growth) | 247,740 | 47,200 | 278,524 |
| HEAD `0d4c0e8`, measured | 246,902 | 47,182 | 278,284 |
| With this stream | **247,422** (within, 318 B room) | **47,182** (unchanged; four classes unique to the new pages were replaced by existing ones) | **278,796 (over by 272 B)** |

Where the 512 B of Brotli come from: about two thirds is the `routes` map in the `m365-start` block of `index.html` (the build lists every chunk file a route needs so the browser fetches them in parallel). `/contacts` went from 10 to 19 files and `/distribution-lists` from 10 to 22, because the placeholder pages became real pages that share chunks with `/users` and `/groups`; `/groups`, `/users`, `/design` and `/settings/*` gain one or two names each as shared code (the directory search, the Radix checkbox) moved into chunks of its own. The rest is the entry JavaScript of four route files (each carries the dependency list of its lazy component) and three small functions (`validate*Search`, the namespace groups). Hash names do not compress, so a file name costs about 15 B. Tried without effect: dropping the four prefetch loaders (JS -69 B, Brotli +36 B, noise of the changed hashes), lazy dialogs (done, kept: -43 B).

Options for the owner: (1) raise `approvedGrowth.firstLoadBrotliBytes` by at least 272 B (the budget file's own note says Phase D steps D2 and D3 add more routes, so a larger figure for the three steps is realistic); (2) accept fewer preloaded names by not listing the shared chunks of a route in the map (a change to `build/plugins/defer-entry.ts`, not done: it is a Phase A seam).

## What was not done, and what the next stream must know

- No visual baselines (rule), no e2e run; `e2e/tests/pages.spec.ts` and `nav-gating.spec.ts` still describe the two pages as placeholders and need S-D4's update.
- Not tested against the real server routes P40 to P54 (S-D2 builds them in parallel); the handlers follow the frozen schemas. Open questions for the contract at integration: the contacts route must answer `409 conflict` with `errors[] { pointer: '/externalEmailAddress' | '/alias', code: 'conflict' }` (the form shows it at the field), `422 validation_failed` with the pointer `/<field>` and a code of `CONTACT_VALIDATION_CODES`, and `DELETE` with `confirmName` mismatch as `422` pointer `/confirmName`, code `confirm_mismatch`.
- `docs/` (the web section of the architecture and the limits rows) is S-D4's.
- The members of a list are read 50 to a page; the picker asks for 25 candidates and says "there are more results" when it gets 25.
