# Chunk s8a (T-A-270 to T-A-273): docs-contract tests and the ADRs

## Tasks

| Task | Result |
|---|---|
| T-A-270 | `apps/server/test/docs-contract.test.ts` (29 tests), `limits-doc.test.ts` (12), helper `fixtures/docs/markdown.ts`, negative fixtures `fixtures/docs/{operations-limits-skeleton,readme-broken-links,readme-english-only,permissions-bad-status}.md`. `pnpm docs:check` already existed in the root `package.json`; it is real now. Written first and seen red. |
| T-A-271, 272, 273 | `docs/adr/0000-template.md` and ADR-0001 to ADR-0055 (D1 to D26, PD-01 to PD-28, then ADR-0055 for TA-01 to TA-10). The two ADR tests are green. |

## State of `pnpm docs:check` at the end of this chunk

31 passed, 10 failed. Every failure is a missing document of a later task, and the message says which:

| Failing test | Why (exact) | Written by |
|---|---|---|
| README resolves, both languages, GIF | `README.md is missing` | T-A-279 |
| relative links under docs/ | `docs/architecture.md is missing` | T-A-274 to T-A-278 |
| operations sections | `missing section: setup` (the skeleton) | T-A-277 |
| environment table | `operations.md has no environment table` | T-A-277 |
| security sections, SVG allowlist | `docs/security.md is missing` | T-A-275 |
| panel catalogue, Graph table | `docs/permissions.md is missing` | T-A-276 |
| dependency table, Accessibility | `docs/architecture.md is missing` | T-A-274 |
| limits table | `limits table has no row "JSON request body"` (the skeleton) | T-A-277 |

Every guard has negative cases run through `expectGuardFails` with a reason (the guard-level tests of both files; 41 tests in all, 31 passing). The guards were not yet run against real documents, only against documents built in the tests, so the first real documents may meet a format rule the author has to read.

## Formats the document authors must follow (also in the header of `docs-contract.test.ts`)

- operations.md environment table: header starts with `Variable` and has a `Default` column; one row per `ENV_VARIABLES` entry plus `HOST_PORT`, name in the first cell; defaults are compared (thousands separators ignored) except `PUBLIC_BASE_URL`; the names must also equal the names in `.env.example` (commented lines count).
- operations.md limits table: header `Limit | Value | Enforced by | Constrains` under the heading "Limits outside the repository"; exactly the 25 rows of spec 6.5 (a row beyond them fails), each label starting with the spec's words; the Value cell states every `LIMITS` number (rates per second, durations in seconds or hours as the spec has them); a number of 1,000 or more anywhere in Value or Constrains must be a `LIMITS` value or one of the import derivation numbers; the sentence "whatever sits in front ... must allow ... at least 9,437,184 bytes"; the Dutch section "Nederlands" states 9437184 (with or without separators).
- security.md: a section "SVG allowlist" with a table `Kind | Names`, the row `Elements` and one row per attribute kind of `SVG_ALLOWLIST.attributes` (row label = the key), the names as backticked tokens, equal sets.
- permissions.md: part 1 table without a `Status` column, permission in backticks in the first cell (exactly the 15); part 2 table with `Reason`, `Phase` (B, C or D) and `Status` (exactly `verified`, `corrected` or `UNVERIFIED`); an UNVERIFIED row names its register id `U<n>` in any cell and open-points.md has a table row whose first cell is that id.
- architecture.md: a table `Dependency | Reason | Mark` with the package name in the first cell (backticks allowed) and the mark `reuse`, `adapt` or `replace`; a section `Accessibility` mentioning screen reader, text spacing, colour-only cues and 400 %.
- README: top-level headings `English` and `Nederlands`; a referenced `.gif` of at most 2 MiB.

## Decisions

1. The "route table" check reads the route ids from the `id: '...'` declarations in `apps/server/src` (20 ids, all of the contract's route index found). It is a source scan, not an instantiation of the app; a route declared with a non-literal id would be missed.
2. The MUST check treats a placeholder (`TBD`, `-`, `none`, `n/a`, empty) as "no control" and also fails if a MUST row sits in a table that lacks the Level or Enforced by column. All 127 MUST rows of the spec pass today.
3. ADRs: status word is `Accepted`, `Adjusted` or `Plan`; plan rows that say "Accepted, with changes" are written `Accepted, with changes`. D6 stays Accepted; D4, D7, D19 and PD-06 are Adjusted (PD-06 because the security review in `chunk-s1fix.md` replaced the stock migrator step). Every ADR has an Evidence section that separates what was run from what was only read; items that never ran (GitHub workflows, arm64, bridge networking, Lighthouse, other browsers) are said so.
4. ADR-0003 says "Accepted, with changes" while the plan says the same; ADR-0024 (D24) records honestly that the README and four documents were still missing when it was written.

## Open points

- s8a-1: The documents T-A-274 to T-A-279 must follow the formats above or the tests need an owner-agreed change; tell this stream (S8) if a format is unreasonable.
- s8a-2: ADR claims about the Lighthouse/LCP outcome (ADR-0022, ADR-0053) are deliberately silent on a result because no gate note has one yet. Update them at T-A-334 if the result is worth recording.
- s8a-3: PD-03's ADR (0029) records two patches (sonner dropped, Radix Select patched). If `docs/open-points.md` consolidates the Dependabot ignore rules (T-A-278), add the Radix patch to the "what to re-check on a Radix upgrade" list.
- s8a-4: `fixtures/docs/*.md` were reformatted by Prettier; they are inputs to negative tests, not documentation.

## Not verified here

The guards against real documents (they do not exist yet); lint of the root `format:check` over `docs/adr`; `pnpm docs:check` in the CI `quality` job.
