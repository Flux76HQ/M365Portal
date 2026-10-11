# Chunk s3c: open points, assumptions and risks (S3 design system, web: T-A-129 to T-A-131)

Status: **three tasks done** (`T-A-129`, `T-A-130`, `T-A-131`). Gate G3 passed; its note is `G3.md` (evidence, frozen interfaces, CSS size). S8 consolidates the open points into `docs/open-points.md` (`T-A-278`).

## Open points

| # | Point | Owner | When |
|---|---|---|---|
| OP-1 | **`tokens.generated.css` was reformatted by a formatter in commit f1fce0e** (single quotes, wrapped `--shadow-1`), so `pnpm tokens:check` and two tests of `shared/tokens.test.ts` were red at the start of this chunk. `.prettierignore` lists `*.generated.css`, so the file was formatted by an explicit path or a tool that ignores the ignore file. It was regenerated with `pnpm tokens:generate` (4 insertions, 6 deletions) and the check is green. Nobody should run a formatter over that file again | orchestrator / every stream | now |
| OP-2 | **Wiring is S4's (contract C12).** A page builds `DataTableLabels` from the catalogue (the catalogue needs the `table.*` keys: 43 fields, 14 of them functions that take the values, so that word order stays the translator's), passes `columnStorage` backed by `lib/storage.ts` (`columnsKey(tableId)` already exists there; the interface is `read(tableId)`, `write(tableId, prefs)`, `clear(tableId)` and must not throw), and maps `search`/`onSearchChange` to the router's validated search params (page and size may arrive as numbers: both are accepted) | S4 | `T-A-167`, `T-A-169` |
| OP-3 | **`getRowLabel` must be what the first visible cell shows.** With `details` the first visible column becomes a button whose accessible name is `openDetails(rowLabel)` ("Open details of Ada Lovelace"); WCAG 2.5.3 (label in name) holds only when the visible text is contained in that name | S4 / S5 | on first use |
| OP-4 | **Lazy-load the DataTable.** Plan 14 keeps it out of the entry chunk; the library adds `@tanstack/react-table` and `@tanstack/react-store`. Its JS size was not measured on its own (the scratch build with React, Motion and all of S3 was 522 kB raw, 158 kB gzip). `T-A-259` / `T-A-173` should measure it once a page imports it | S4, S7 | `T-A-173`, `T-A-259` |
| OP-5 | **The `/design` showcase must show the DataTable** (plan 9.6: a local, clearly labelled sample source with simulated latency). The scratch page of this chunk (source not kept in the repository) did exactly that and passed axe | S4 | `T-A-170` |
| OP-6 | **e2e coverage** that happy-dom cannot give: sticky header while the region scrolls (measured here: header top 1 px after scrolling 400 px), skeleton row height equal to data row height (48 px both), keyboard walk in a real browser, visual baselines of the table in both themes. `e2e/keyboard.spec.ts` and `e2e/visual.spec.ts` are the controls named by FR-A-125 | S9 | `T-A-323`, `T-A-325` |
| OP-7 | **Carried over from `chunk-s3b.md` and still open for the owner at G3:** OP-6 (radio uses `rounded-full`; add `'radio'` to `RADIUS_FULL_USES` or make it a rounded square) and OP-7 (no looping skeleton: the DataTable skeleton rows are static blocks, FR-A-122 caps every animation at 200 ms) | owner | palette review |

## Assumptions

| # | Assumption |
|---|---|
| A-1 | Sorting cycles ascending, descending, then back to the default (`defaultSort`, or none). Sorting is single-column; the URL carries one `sort` token (`name`, `-name`) |
| A-2 | Selection belongs to one query: **any** change of `q`, `sort`, `page`, `size` or a filter clears it, and clears "all results". Selecting across pages is therefore not offered; "all M results" is the explicit way, and a bulk action then receives the query (without the page) instead of ids |
| A-3 | A search is applied on submit (Enter or the Search button), not per key: no debounce, no timer, nothing to fake in tests. A page that wants live search can wrap the component |
| A-4 | The first column that is visible is the "primary" one (it carries the details button). If the user hides the first column the next visible one takes over; the name column should be `hideable: false` |
| A-5 | A page number beyond the last page shows the clamped page in the pager and does not rewrite the URL (a stale link must not loop or error); the server answers an empty page and the "no data" or "no results" state follows |
| A-6 | `columnStorage.read` is called once, when the table mounts; a stored choice is reconciled against the columns that exist now (unknown ids dropped, new columns appended, a column that cannot be hidden is never hidden). Without a storage the choice lasts as long as the table |
| A-7 | The scroll container has no `tabindex`: jsx-a11y refuses one on a non-interactive element and no rule is disabled. Chromium makes scrollers keyboard-focusable itself and this one always holds focusable controls (checkboxes, sort buttons) when it has rows; the empty and error states hold a button or no scroll at all |
| A-8 | The column picker and the page-size select are always offered (the picker works without a storage); the actions column exists only when `rowActions` is given |

## Risks

| # | Risk |
|---|---|
| R-1 | **TanStack Table 9.2.8 is a new major** (PR-02). Everything it needs sits in `columns.tsx` and `DataTable.tsx`; a page never sees its types. Columns are accessor columns over the whole row because the library only sorts columns that have an accessor; the cast in `toTableColumns` (value type `Row` to `unknown`) is a type-level variance workaround, same runtime object |
| R-2 | The column picker is a modal Dialog (Radix). While it is open, `aria-hidden` removes the page from the accessibility tree, so tests read the headers with `hidden: true` |
| R-3 | Focus after a column move is put back by `useLayoutEffect` on the button that was used; the unit test proves it in happy-dom, a real browser was not driven for that detail (axe and the open dialog were) |
| R-4 | `exactOptionalPropertyTypes` stays off (PR-02): a guard in `DataTable.test.tsx` fails if `tsconfig.base.json` or `tsconfig.app.json` turns it on. Optional props are typed `x?: T`, and `undefined` may be passed |
