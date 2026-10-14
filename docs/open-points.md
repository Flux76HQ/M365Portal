# Open points, assumptions and risks

> **Status:** consolidated for Phase A on 2026-10-11 by the documentation stream (task T-A-278) from
> the gate notes in [`specs/001-m365portal/gate-notes/`](../specs/001-m365portal/gate-notes/), the spec
> (sections 10, 11 and 12), the plan (sections 16 to 18) and
> [`research-microsoft.md`](../specs/001-m365portal/research-microsoft.md). Maintained at the end of
> every phase; only the documentation stream edits this file. Nederlandse samenvatting onderaan:
> [Nederlands](#nederlands).

Every Microsoft API, permission or cmdlet parameter used by this project is checked against Microsoft
Learn. Anything that could not be verified is listed here with the date, what was tried and what is still
needed.

How to read the tables. Every table row starts with a stable id; other documents cite these ids.
**Status** is `open` (needs an action or a decision), `owner` (waits for an owner decision), `recorded`
(a decision, assumption or limitation that is simply true and needs no action), or `closed` (with the
evidence). Ids of gate-note points are the ids the chunk notes use (`s1c-9`: stream S1, chunk c, point
9); where two chunks reuse `OP-n`, the id is prefixed with the chunk (`s3b-OP4`). Gate notes of the
end-to-end, Lighthouse and media stream (S9, tasks T-A-320 to T-A-334) did not exist when this file was
consolidated; their points are added when they land (row `S9-pending`).

## Unverified Microsoft claims

Date of the register: 2026-10-10 (Microsoft Learn only). U1 to U17 are copied from the research; U18 is
an addition of this stream. `docs/permissions.md` refers to these ids.

| # | Claim | Where used | Tried | Needed to close |
|---|---|---|---|---|
| U1 | `GroupMember.ReadWrite.All` alone lists groups (`GET /groups`) | permissions.md (Graph set) | The Learn list-groups and get-group pages print `Group-NestingSupport.ReadWrite.All` as least privileged and omit `GroupMember.ReadWrite.All`; the overview says `GroupMember.Read.All` | A dev-tenant call with only `GroupMember.ReadWrite.All` |
| U2 | The default client of `Connect-MgGraph` is `14d82eec-204b-4c2f-b7e8-296a70dab67e` and is a public client | Wizard step 2 | The sign-in report page lists `14d82eec`; the `Get-MgContext` sample shows `615e6e7c-aa11-4402-91a1-6234967405d5` | Run device code against a dev tenant with each id; keep `BOOTSTRAP_CLIENT_ID` |
| U3 | Behaviour for non-admins and the exact consent errors with the Microsoft client | Wizard error handling | Not on the pages read | A dev-tenant test with a non-admin and with consent disabled |
| U4 | Delay between an Entra role assignment and a working Exchange app-only token | Wizard retry and backoff | Learn is silent; "Directory Role ... returned in the access token" | Measure in a dev tenant; keep the retry loop |
| U5 | Minimal Exchange role set for distribution-list membership and mail contacts (Exchange Recipient Administrator, or a custom role group including Security Group Creation and Membership) | permissions.md, security.md | Role and cmdlet pages read; no statement of sufficiency | A dev-tenant run of all nine cmdlets under each candidate role |
| U6 | `New-ServicePrincipal` parameter set (is `-ServiceId` mandatory?); app role id of `Exchange.ManageAsAppV2` | Wizard step 3 | The reference and the how-to disagree; the Admin API page names both `ManageAsApp` and `ManageAsAppV2` | Read the tenant service principal's `appRoles` for `00000002-0000-0ff1-ce00-000000000000`; run the cmdlet |
| U7 | Exchange Online throttling limits for app-only PowerShell and REST | security.md, `ExchangeClient` design | Searched Learn | None; design for unknown limits |
| U8 | Graph behaviour when adding members to an on-premises-synced security group | Groups UI | Not on the pages read | A dev-tenant test; use `onPremisesSyncEnabled` to show read-only |
| U9 | The Exchange module on Debian, Alpine or distroless | Dockerfile if a PowerShell worker is chosen | Learn lists Ubuntu LTS only | Owner decision OD-07 (decided 2026-10-13 as ODB-01 A: Ubuntu 24.04, ADR-0180); test the chosen base: size, start and memory are unmeasured (U84, OV-D1) |
| U10 | Uniqueness of `ExternalEmailAddress` is enforced by Exchange | Contacts validation | The `New-MailContact` page is silent | App-side uniqueness check (`Get-MailContact -Filter`) |
| U11 | Cmdlet and parameters for listing dynamic distribution groups | Distribution-list screen | Only the Admin API endpoint `DynamicDistributionGroupMember` is documented; the cmdlet page was not read | Read the `Get-DynamicDistributionGroup` page when Phase D starts. Phase D step D1 lists dynamic lists through `Get-Recipient -RecipientTypeDetails DynamicDistributionGroup` and does not list their members (FD-05); the value list is U99 |
| U12 | Output property name `IsDirSynced` on `Get-DistributionGroup` and `Get-MailContact` | Read-only display of synced objects | Only the filterable property is documented | Inspect the output in a dev tenant |
| U13 | `max_age` is honoured by the Entra v2.0 `/authorize` endpoint | Step-up sign-in | Only the consumer-account reference shows it | Use `prompt=login` plus an application timestamp |
| U14 | Graph accepts `http://127.0.0.1` in `web.redirectUris` | Wizard redirect URIs | Learn says the portal cannot; the manifest can | A dev-tenant PATCH test; default to `http://localhost` |
| U15 | `Set-Contact` parameters for first and last name, and that it works app-only with the chosen Exchange role | Contacts edit, CSV export | `Set-MailContact` has no `-FirstName` or `-LastName`; the `Set-Contact` page was not read | Read the `Set-Contact` page when Phase D starts |
| U16 | The identity-and-access throttling limits (write quota 3,000 per 2 min 30 s) cover users and group memberships | `GraphClient` and `ExchangeClient` backoff | The limits table was read; the resource list was not | Read the resource list under "Identity and access service limits" |
| U17 | Permission and shape for reading licence assignments app-only (`assignedLicenses`, beta `cloudLicensing` APIs) | Users list "licenties" column | `licenseDetails` documents "Application: Not supported"; the other APIs were seen only as search snippets | Read the `user` resource page and the `cloudLicensing` pages in Phase C. **Deferred on 2026-10-13 (owner decision D-C3):** licences are not built in Phase C; there is no licence column, field, filter or request (`server/directory/no-licences.test.ts` scans for it). Not read, not closed; to be picked up only if the owner asks for licences |
| U18 | Which OWASP ASVS version (4.0.3 or 5.0) the level 2 mapping targets, and the control identifiers | security.md | The ASVS text was not read for the Phase A documents; the mapping is at chapter level | Choose the version, read its text, copy the control ids (Phase D, FR-D-006) |

### Other unverified items (not Microsoft)

Date 2026-10-11. These are claims of the CI and runtime work that could not be run in the build
environment.

| # | Claim | Where | Tried | Needed to close |
|---|---|---|---|---|
| UV1 | All GitHub workflows run as written (`ci.yml`, `image.yml`, `codeql.yml`, `visual-baselines.yml`) | G7, `chunk-s7a.md` | `actionlint` 1.7.12 clean on 7 files (shellcheck skipped: not installed); `py/test_workflows.py` 64 tests; every command run locally that could run | The first run on GitHub (PR-12) |
| UV2 | cosign 3.x flags, multi-arch digest output, `push-to-registry`, CycloneDX predicate type `https://cyclonedx.org/bom` in `gh attestation verify`, extra permissions of the attest actions, `--verify-tag` in `gh release create`, Trivy DB download and GHCR digest scan | `chunk-s7a.md` | Static checks only | First `publish` run |
| UV3 | Trivy ignore format (a `# reason` comment above and `exp:YYYY-MM-DD` on the entry in `.trivyignore`) | `chunk-s7a.md` | Defined by the test; no entry exists | Verify against Trivy documentation at the first entry |
| UV4 | Dependabot accepts glob `directories` and updates entries in the pnpm `catalog:` of `pnpm-workspace.yaml` keeping the lockfile consistent | `chunk-s7c.md` | Glob support is documented by GitHub; no run | First Dependabot run |
| UV5 | arm64 build and run (`TARGETARCH` prune, `better-sqlite3` and `sharp` prebuilds, ICU data), QEMU smoke | PR-06, G6, `s1d` R1 | Never built or run: amd64 only | The `publish` job |
| UV6 | Compose nested default `${PUBLIC_BASE_URL:-http://localhost:${HOST_PORT:-9300}}` on older Compose v2 plugins | PA-16, `s6a-6` | Proven with Compose v5.6.0 only | CI runner plugin; `REQUIRE_DOCKER=1` |
| UV7 | The Caddy example works | `s6a-8` | Directive names checked against Caddy's documentation on 2026-10-10; not executed | `caddy validate --config deploy/caddy/Caddyfile.example` with a real name |
| UV8 | Service worker, COEP, Trusted Types and Permissions-Policy names in Firefox and Safari | PR-09 | Chromium 141 only | A manual pass in those browsers |
| UV9 | Public scanner grades (securityheaders.com, Mozilla Observatory) and whether the HSTS opt-ins are needed for them | BC-01 | Scanner rules not read; needs a public host | A run on a public host |
| UV10 | Docker bridge networking, `docker compose up` itself, GHCR, SBOM, Trivy | G6 | The sandbox has no bridge network; compose flags were exercised through `docker run` | CI `image` job |
| UV11 | Screen readers, text spacing and zoom to 400 % | architecture.md Accessibility | Manual checklist; not run in Phase A | The pass before the phase gate |
| UV12 | Real tenant behaviour of anything in Part 2 of permissions.md | R-15 | No tenant in the build environment | Owner tests after Phases B and D |

## Owner decisions and brief conflicts

Defaults apply if the owner stays silent; nothing in Phase A is blocked by any of them.

| # | Decision | Default | Needed by | Status |
|---|---|---|---|---|
| OD-01 | Licence of repository and image, and public or private repository and GHCR image. Sharpened by the plan: cosign keyless runs only for a public repository; a private repository gets GitHub attestations | No licence label; `licenses` OCI label absent (FR-A-163) | Phase A gate | owner |
| OD-02 | Integration branch name and channel tag policy | `main`; tags `latest`, `v<VERSION>`, `sha-<short>` | Phase A gate | owner (AGENTS.md already says `main`) |
| OD-03 | Fate of preview mode in Phase B | Removed in Phase B | Phase B gate | owner |
| OD-04 | Phase A deviations and additions: import limit 9 MiB (A-36), SVG `<text>` refused (A-38), 403 not 401 for anonymous writes (A-29), the remote guard and the loopback `Host` rule for preview mode (A-30, SA-15), HSTS defaults (A-46), ESLint 10 (SA-02), staging quota and its error code (SA-06), icon priority (SA-11), SVG allowlist and expansion cap (SA-13, SA-19), the wider organisation-name rejection (SA-18) | As written | Phase A gate | owner |
| OD-05 | Version scheme 0.2.0 for Phase A to 0.5.0 for Phase D, 1.0.0 after acceptance | A-47 | Phase A gate | owner |
| OD-06 | Graph application permission set: the brief's five or the smaller four | The smaller set | Phase B gate | owner (shown in permissions.md) |
| OD-07 | Exchange execution path and runtime base: PowerShell worker (documented, Ubuntu-based runtime), Admin API Preview for reads only, or the undocumented `InvokeCommand` route | None can be assumed: ask early | Phase B gate at the latest | closed 2026-10-13 (owner): ODB-01 A, a `pwsh` worker on Ubuntu 24.04, built in Phase D step D1 (ADR-0180, ADR-0181) |
| OD-08 | Service-principal role, the wizard user's role, the bootstrap fallback when device code is blocked, and the MFA policy | Exchange Administrator now, narrower later; both wizard roles accepted; `BOOTSTRAP_CLIENT_ID` override; `amr` check on | Phase B gate | owner |
| OD-09 | Add root configuration files (`tsconfig*.json`, `eslint.config.*`, `.nvmrc`, `.npmrc`) and `patches/` to `scripts/version_guard_paths.py` | Proposed in the phase report | Phase A gate | owner |
| OD-10 | Retention of audit entries (they hold client addresses) | Keep everything until Phase D | Phase D | owner |
| OD-11 | Pin actions by commit SHA | Answered in the plan: SHA pins | Phase A gate | closed (SA-01, V-07) |
| OD-12 | Release gate: the literal rule (default) or the refinement that lets a re-run of a failed `publish` write the version tag (SA-23) | Literal rule | Phase A gate | owner |
| OD-13 | A global cap on audit rows written for denied requests (per-client buckets do not bound many source addresses, R-09) | Not built in Phase A; decide with OD-10. Proposal: a global cap on audit rows for denied requests per hour, with one summary row when the cap is hit | Phase D | owner |
| OD-14 | Mid-tone accents get black text by default; offer an option that darkens the colour until white text passes (s3a-OP3) | Default as designed (plan 10.4) | Phase A gate | owner |
| OD-15 | Mobile LCP below 2.0 s (PR-01, plan 14.3, ADR-0056). **Measured 2026-10-11 (version 0.2.40, Lighthouse 13.5.0):** preview instance (the e2e instance) mobile LCP 1.06 to 1.51 s, Performance 98 to 100, all 11 routes pass; default instance (no `PREVIEW_MODE`) mobile LCP 3.55 to 3.80 s and Performance 84 to 90, not below 2.0 s (desktop 0.71 to 0.78 s, 100). The harness accepts the miss under a recorded gate (3,740 ms plus 10 percent = 4,114 ms); 11 of 44 cells are `accepted-miss`. First load 262 KiB Brotli against the 150 KiB target (a SHOULD) is **not met**; the budget is 269,000 B and ratchets down | Accept the recorded gate for the default instance (ADR-0056, the recommendation of G4 OP-1); alternatives: approve more work (a smaller entry: about 40 KB less, LCP about 3 s, still not below 2.0 s; or static page content, which needs the actor's permissions) or drop the default-instance rows from the gate | Phase A gate | owner |
| OD-16 | The Performance floor of 75.6 (recorded 84 minus 10 percent) for the default instance on mobile is an extension that the S9c agent added to the OP-1 rule; G4 only named LCP. Without it `pnpm lighthouse` would be red on a decision the owner has not reversed (ADR-0056) | Kept as implemented until the owner confirms or removes it | Phase A gate | owner |
| OD-17 | The lint rule `local/no-string-built-sql` does not cover `apps/server/src/db/migrate.ts`, which runs the shipped SQL through the helper `runShippedStatement` (`Database.prototype.exec.call(db, statement)`, an indirect call that the rule does not see). Proposal: an explicit, documented allowance in the rule for that one file (a named path in the rule's options and a negative fixture proving that any other file still fails), instead of an indirect call that reads as a bypass | Indirect call stays (check 10 of `repo-conventions` is green with it) | Phase A gate | owner |

Brief conflicts and ambiguities (spec section 10). Resolutions are in the spec; they are listed so that
none is lost.

| # | Conflict | Resolution and status |
|---|---|---|
| BC-01 | HSTS with preload against baseline section 13 | Plain `max-age` over https; `includeSubDomains` and `preload` are operator opt-ins on the declared host. recorded (scanner grade: UV9) |
| BC-02 | The brief's "minimaal" Graph set is the broadest, against least privilege | Not decided; OD-06; permissions.md shows both. owner |
| BC-03 | `__Host-` cookies on `http://localhost` | Phase A sets no cookies; Phase B proposal needs owner confirmation. owner |
| BC-04 | Sanitise or rasterise SVG | Both (D17). recorded |
| BC-05 | 2 MB against 2 MiB; 8 MiB import is too small | 2 MiB; import 9 MiB (A-36). recorded |
| BC-06 | CSP without `unsafe-inline` and Trusted Types against UI libraries | CSSOM for styles, nonce for `<style>`, e2e violation guard; a dependency is replaced rather than the policy weakened (R-05). recorded |
| BC-07 | One CI job cannot both run for forks and push, sign and attest | Two jobs, `image` and `publish`. recorded |
| BC-08 | Exchange "REST `InvokeCommand`" is not documented | OD-07. owner |
| BC-09 | MFA via `amr`/`acr` | `amr` through the optional claim (OD-08). owner |
| BC-10 | Distroless runtime cannot hold PowerShell | Distroless in Phase A; the base change is recorded in ADR-0180 and made in Phase D step D1 (owner, OD-07, ODB-01 A). |
| BC-11 | Wizard scopes include `Directory.Read.All`; "temporary Global Administrator" | Phase B gate (OD-08). owner |
| BC-12 | Exchange Administrator against a narrow role group | Phase B gate (OD-08, U5, U6). owner |
| BC-13 | Users list "licenties" | Only if an app-only source is verified (U17). open |
| BC-14 | Audit with IP address against logs without personal data | The audit table keeps it (personal data); logs never do. recorded (OD-10) |
| BC-15 | NAS volumes and SQLite WAL | Unsupported; documented (E-24, A-57). recorded |
| BC-16 | TypeScript 7 and ESLint versions against the registry | Pins in A-27 and A-28. recorded |
| BC-17 | `Get-DistributionGroup -ResultSize 1` as verification call | Decided with OD-07. owner |
| BC-18 | E-mails with the organisation name | No mail in any phase so far. recorded |
| BC-19 | Which endpoint the container health check uses | `/readyz` (A-34). recorded |

## Plan assumptions

| # | Assumption | Status |
|---|---|---|
| PA-01 | Global search in Phase A is the palette's trigger (PD-18) | recorded |
| PA-02 | Schema snapshots are keyed by schema version, not application version (PD-05) | recorded |
| PA-03 | Icon source priority and plates as in PD-11 | recorded |
| PA-04 | A derived compact variant is stored and flagged `logo_compact_derived`; export contains only an explicit compact | recorded |
| PA-05 | The rate-limit client key is the IPv4 address or the IPv6 /64 prefix | recorded (clients behind one /64 share a bucket: s1c R4) |
| PA-06 | `TRUST_PROXY=<N>` means N proxies, client at entry N from the right of `X-Forwarded-For` | recorded |
| PA-07 | A default branding row is created at start by the `system` actor, audit action `branding.init` (PD-12) | recorded |
| PA-08 | The upload route accepts `multipart/form-data` only | recorded |
| PA-09 | An SVG with neither `viewBox` nor `width` and `height` is refused as `svg_not_wellformed` | recorded |
| PA-10 | A dry-run import is audited (`branding.import`, `dryRun: true`) | recorded |
| PA-11 | Staging quota: 32 unreferenced files and 32 MiB | recorded (refined by s2e decision 2 and `chunk-s2fix.md`: only waiting assets count) |
| PA-12 | `If-Match` and `ETag` use a strong quoted revision; a malformed `If-Match` is 422, a missing one 428 | recorded (s2g-1: compression weakens strong ETags unless `no-transform`) |
| PA-13 | `/favicon.ico` and `/apple-touch-icon.png` redirect (307) to the hashed icon | recorded |
| PA-14 | Unknown page paths receive the shell with 200; the client renders Not-found | recorded |
| PA-15 | A denied permissioned read (branding export) is not audited; denied writes are | recorded |
| PA-16 | The Compose and `docker run` stop timeout is 15 s | recorded (UV6) |
| PA-17 | Visual baselines are refreshed by a manual workflow that produces an artefact for owner review | recorded |
| PA-18 | The offline page is a static file in both languages; navigations are never cached | recorded (s4d A-6: it does not pick the browser language) |

## Risks

Spec risks (section 12) and plan risks. Status is as at 2026-10-11.

| # | Risk | Mitigation and status |
|---|---|---|
| R-01 | Visual baselines from the sandbox Chromium may differ from the GitHub runner | Same Chromium revision, self-hosted font, manual refresh workflow. open until the first CI run |
| R-02 | Lighthouse scores vary with the runner | Best of 3 for timing, all kept. open (S9) |
| R-03 | Workflows cannot run here | Static checks and local runs; see UV1. open |
| R-04 | A pinned SHA must be re-resolved on each bump | Pins checked 2026-10-11 (G7); the test asserts the format. recorded |
| R-05 | A dependency may not work under Trusted Types or strict CSP | e2e violation guard; the Radix Select sink was found and patched (s3fix). open: the guard runs in S9 |
| R-06 | sharp on distroless: SVG shapes rasterise, text does not | Answered: yes, the distroless image rasterises SVG (G6); text refused (A-38). closed |
| R-07 | arm64 cannot be tested here | UV5. open |
| R-08 | Preview mode on a reachable network is unauthenticated administration | Remote guard, loopback `Host` rule, banner, loopback publishing, removal in Phase B (OD-03). The `Host` rule is not a boundary (security.md). open |
| R-09 | A hostile client can grow the audit table through denied writes | Write bucket per client; 429 not audited; retention in Phase D (OD-10, OD-13). Anonymous denied writes are audited (403), so an unauthenticated client can grow `audit_log` without bound (disk fill) from many source addresses; the 413 of the request cap is not audited. Proposal for OD-13: a global cap on denied-request rows per hour with one summary row. Not built. open |
| R-10 | NAS or network volumes break SQLite WAL | Documented unsupported. recorded |
| R-11 | The version guard does not cover root configuration files | OD-09. owner |
| R-12 | `eslint-plugin-jsx-a11y` is unmaintained and caps ESLint at 9 | axe in e2e is the primary control; the peer is forced for ESLint 10 for that plugin only (PR-04). recorded |
| R-13 | Keyless signing through the public Sigstore writes the identity to a public log | Only for public repositories (OD-01). recorded |
| R-14 | Rate-limit buckets and the CSRF key are in memory | Single instance is a documented rule. recorded |
| R-15 | Phases B to D rest on UNVERIFIED Microsoft claims | U1 to U17 above; the owner tests against a real tenant after B and D. open |
| R-16 | The registry is ahead of the brief's assumptions | Exact pins, frozen lockfile. recorded |
| R-17 | Playwright pinned to 1.56.x is behind the registry | Dependabot ignore rule DR-3. recorded |
| PR-01 | Mobile LCP below 2.0 s is met on the preview instance (1.06 to 1.51 s, 11 of 11 routes) and **not** on the default instance (3.55 to 3.80 s; it waits for JavaScript that renders the first page's description). First load is 262 KiB Brotli against the 150 KiB target: not met (budget 269,000 B, a ratchet) | Budgets, tactics (static shell, deferred and staged start, route chunk preloads, build-time `cn` tables), the decision rule of ADR-0056 (OD-15, OD-16); `T-A-173`, `T-A-331`, `T-A-330`. open: owner decides; `T-A-334` recalibrates the budget on the final build |
| PR-02 | TanStack Table 9 is a new major; known conflict with `exactOptionalPropertyTypes` | The DataTable wrapper hides the API; the option stays off, guarded by a test. recorded |
| PR-03 | A UI dependency violates CSP or Trusted Types in a way static inspection did not show | e2e guard; shim for the Radix scroll-lock nonce; the Radix Select patch. open |
| PR-04 | `eslint-plugin-jsx-a11y` forced onto ESLint 10 | axe in e2e; fallback ESLint 9 or drop the plugin. recorded |
| PR-05 | Sanitised SVG is still rasterised natively in a child process with the container's privileges | Allowlist rebuild, caps, SIGKILL at 10 s, empty environment, Dependabot and Trivy; Phase D may add a sandbox. open |
| PR-06 | Worker path, native pruning and arm64 on distroless | The amd64 smoke covers the worker bundle; arm64 is UV5. open |
| PR-07 | Drizzle 1.0 changes the migration folder format | Exact pin; Dependabot ignore rule DR-4. recorded |
| PR-08 | Visual baselines differ between sandbox and runner | R-01 mitigations. open |
| PR-09 | Service worker, COEP and Trusted Types in Firefox and Safari | UV8. open |
| PR-10 | `Request.formData()` buffers the bounded body and relies on undici's parser | H-38 and the hostile corpus pass; hand-written parser as fallback. recorded |
| PR-11 | `serveStatic` may mishandle an encoding of traversal | Path guard and fixtures; the guard is an allow-list. recorded |
| PR-12 | Workflows have never run | UV1, UV2. open |
| PR-13 | The monogram covers A to Z and 0 to 9 with Latin transliteration; other scripts get a pictogram | Documented (A-40); widening is an owner request. recorded |
| PR-14 | A sweeper bug deletes a referenced asset | `ON DELETE RESTRICT`, sweeper selects only unreferenced rows, invariant tests. recorded |
| PR-15 | Two concurrent 16-megapixel decodes exceed the 512 MiB limit | Measured in the image smoke: idle RSS 116 to 129 MB, peak 147 to 167 MB after two concurrent maximum-pixel uploads (G6). closed |
| PR-16 | ICU or `Intl.Segmenter` differences in the distroless Node | The image smoke checks the segmenter and Dutch plural rules. closed |
| PR-17 | Per-request Brotli of an 80 KiB HTML costs CPU under load | Rate limit bounds it; measure in S9. open |
| PR-18 | Real-world logos are refused (SVG without size, SVG text) | Clear messages; README (T-A-279). open |

## Dependency and supply chain rules

| # | Rule or advisory | Reason and status |
|---|---|---|
| DR-1 | Dependabot ignores `typescript` `>=6.1` | The stack is probed and pinned on 6.0; `typescript-eslint` 8.71.1 accepts `<6.1`. recorded |
| DR-2 | Dependabot ignores `eslint` `>=11` | The plugins are verified against ESLint 10 only. recorded |
| DR-3 | Dependabot ignores majors of `@playwright/test`, `playwright-core` and `@axe-core/playwright` | They move with the Chromium revision of the sandbox and the baselines (R-17). recorded |
| DR-4 | Dependabot ignores majors of `drizzle-orm` and `drizzle-kit` | Drizzle 1.0 changes the migration folder format (PR-07). recorded |
| DR-6 | Dependabot ignores `node` (Docker base image) `>=23` | The runtime is Node 22, the LTS line of `.nvmrc` and `engines`; Node 25 images no longer ship corepack (the build stage fails, see the broken image build of the Dependabot PR of 2026-10-12) and odd lines are never LTS. Moving to the next LTS changes `.nvmrc`, `engines` and the digests together. recorded |
| DR-5 | Everything else is grouped weekly per ecosystem (`npm`, `docker`, `github-actions`) | The `docker` ecosystem has nothing to watch until a Dockerfile exists; it exists now. UV4 for catalog handling. recorded |
| SA-10 | `pnpm audit` lists one moderate advisory: `esbuild <= 0.24.2` through `drizzle-kit > @esbuild-kit/*`, dev-only | `pnpm audit --prod` is clean and `--audit-level=high` passes; below the threshold, listed here. open (re-check when `drizzle-kit` moves) |
| RP-1 | The Radix Select patch (`patches/@radix-ui__react-select@2.3.8.patch`) removes an inline style that is a Trusted Types sink; the same rule is in `app.css` | On a Radix upgrade re-check: whether the sink is gone upstream (drop the patch), the guard `apps/web/test/csp-sinks.test.ts`, `react-scroll-area` (same sink, unused), and that the Dockerfile copies `patches/` before the frozen install. recorded |
| RP-2 | `ignoredBuiltDependencies: esbuild, better-sqlite3` and `strictDepBuilds: true` | esbuild's postinstall only swaps in a faster shim; `better-sqlite3` ships prebuilds and needs no compiler. recorded |
| RP-3 | `autoInstallPeers` puts `@types/better-sqlite3`, `@types/node` and `undici-types` into the production tree | The Dockerfile deletes them after the copy; the cleaner fix is `autoInstallPeers: false` (s6b-2). open |
| RP-4 | The third-party notice for Inter (SIL OFL 1.1) | The glyph table is a derived work with the notice in its header; the README must list it (s2a-5). open (T-A-279) |

## Gate-note open points

Consolidated 2026-10-11. For each point: what was tried or found is in the Point cell; "needed" is in
the Status cell when it is not obvious. Points that only concern the orchestrator's commit are one row,
`commit-chores`.

### Stream S0 (repository, guards)

| # | Point | Status |
|---|---|---|
| G0-O2 | The `LEGACY_HEALTH_ROUTE` exemption in `no-direct-route-registration` | closed: removed with `buildApp` (s1f-4 decision 11); the remaining allowance for `new Hono()` in `app.ts` is s1f-6 |
| G0-O3 | `tsr generate` prints a Node warning ("Accessing non-existent property 'replaceRouteChunk'"); harmless | recorded; re-check when the router CLI is bumped |
| G0-O4 | `VERSION` has no trailing newline | recorded, optional |
| G0-O5 | Lint-rule gotchas for other streams: no SQL-looking strings for `run`, `all`, `get`, `query`; catalogue calls for every JSX text and the seven checked attributes; exempt modules; rule ids under `local/` | recorded |
| G0-O6 | eslint-rules suites import `expectGuardFails` by relative path because the root has no dependency on `@m365portal/shared` | recorded, optional |
| G0-O7/O8 | Rules deliberately stricter (`pragma`, `openapi`, `document.writeln`, `bg-[red]`, palette utilities) or softer (SQL rule follows one `const` hop) than the task text | recorded |
| G0-O9 | `pnpm audit` and the moderate `esbuild` chain were not part of G0 | closed: G7 ran both; see SA-10 |
| G0-W1 | The list of stubs behind wildcard subpaths is not frozen (deleting `accent.ts` or `meta.ts` stays green until a consumer imports it) | recorded; fix: an `EXPECTED_STUBS` list with a negative fixture |
| G0-W2 | An unanchored hex "extractor" outside `packages/shared` is not seen by `single-implementation.test.ts` | recorded; backstop `no-raw-colour` and review |
| G0-R1 | Port literals in e2e helpers: only `e2e/playwright.config.ts` may hold `4173`/`4174`; contract C14 wants `e2e/routes.ts` and the Lighthouse runner to read `E2E_PORT` | open (S9); proposal: one allowed home `e2e/ports.mjs` |
| G0-R3 | Names of homes are pinned by the single-implementation table; other spellings need S0 to extend it | recorded |
| G0-R7 | Shared source is compiled twice (NodeNext and bundler); a `node:fs` import fails `exports.test.ts` | recorded |
| G0-R8/R9 | Scan scopes: the scans walk the filesystem, not git; a stray copy or package-local store inside the tree would be scanned | recorded |
| G0-R10 | "Clean checkout" means a copy of tracked and untracked files; no GitHub runner was exercised | recorded (UV1) |

### Guard limitations

From `chunk-g0-guard-review.md` (adversarial review, accepted as known limitations, not fixed in Phase A).
The backstops are the Trusted Types CSP in e2e, the boot-time route-table check, the server policy layer
and review. Severity as the review rated it. Fix hints are in that file.

| # | Evasion | Status |
|---|---|---|
| GR-1 | MUST: a nested `apps/web/eslint.config.js` replaces the root configuration for its files | recorded |
| GR-2 | MUST: narrow switch-offs in the root ESLint config, `globalIgnores`, or `reportUnusedDisableDirectives` off are invisible to the canary | recorded |
| GR-3 | MUST: `eslint-disable` of a non-local rule needs no reason (FR-A-003 says "with a reason") | recorded |
| GR-4 | MUST: guards can be neutered silently (`describe.skip`, vitest `exclude`, removed `CHECKS` entry, `.only`) | recorded |
| GR-5 | MUST: checks assert that script names exist, not what they run (`"lint":"echo skipped"`, a tsconfig `include` without `test`) | recorded |
| GR-6 | MUST: `no-literal-ui-strings` follows only `const x = 'literal'`; lookups, defaults, helpers and imported tables escape | recorded |
| GR-7 | SHOULD: component props such as `label`, `hint`, `tooltip` are not inspected (C12 makes props the real leak channel); `document.title`, `toast('...')` pass | recorded |
| GR-8 | MUST: `no-string-built-sql` misses `.call/.apply`, `Reflect.apply` and aliased Drizzle `sql.raw` | recorded |
| GR-9 | MUST: a raw colour as percent-encoded hex in a data URI, or a named colour through `setProperty`/`setAttribute`, evades both colour controls | recorded |
| GR-10 | MUST: org-name look-alikes (`trimOrgName`, `formatOrgName`, `validateOrgName`, `normalizeCompanyName`) pass the single-implementation scan | recorded |
| GR-11 | MUST: tell-tale holes (`const { languages } = navigator`, `documentElement.lang`, `resolvedOptions().locale`, `'problem' + '.' + code`) | recorded |
| GR-12 | MUST: nothing but the exact table names is checked inside `packages/shared/src`, so a second implementation inside shared passes | recorded |
| GR-13 | SHOULD: look-alike detection sees functions and names only (object tables, switch statements, split permission lists, name-less inline code) | recorded |
| GR-14 | MEDIUM: the outline check misses assignments, `setProperty`, template tags and `initial`/`unset` | recorded (e2e keyboard spec is the other control) |
| GR-15 | LOW: `no-dangerous-html` misses `document.write` through other receivers, `execCommand('insertHTML')`; `eval` and `new Function` are not rules | recorded (runtime Trusted Types is the control) |
| GR-16 | LOW: `no-direct-storage` misses `parent.localStorage`, `cookieStore`, `caches`, `navigator.storage` | recorded |
| GR-17 | LOW: `no-trusted-types-policy-elsewhere` misses aliases; `@types/trusted-types` is not installed so the type branch is dead | recorded |
| GR-18 | LOW: `no-direct-route-registration` misses `app.use` handlers that answer | recorded (route-table test is the other control) |
| GR-19 | LOW: the file walker ignores symlinks | recorded |
| GR-20 | LOW: `routeTree.gen.ts` exemption matches any file with that name | recorded |
| GR-21 | LOW: the port scan checks by extension, so `:9300` in a `Caddyfile` or `.service` is not seen | recorded |
| GR-22 | False positives: `requirePermission(have, need)` and `storeLocalePreference` are flagged; CSS id selectors read as hex; `'tracked in issue #123'` flagged | recorded; S4 renamed (`requireAnyOf`, `selectMessage`, s4b A-11) |
| GR-23 | Carry-over: `documentElement.lang` reader and a `detectLocale`-like inline script in `index.html` still evade | recorded |

### Stream S1 (server core)

| # | Point | Status |
|---|---|---|
| s1a-4 | The Dutch of the 32 `problem.*` messages and the English titles are unreviewed by the owner (also G1a risk R2: the check cannot judge Dutch quality) | owner |
| s1a-5 | Production `Clock` interface: closed, each consumer takes `now: () => number` (s1c) | closed |
| s1a-6 | The retry hints (`storage_busy` 1 s, `shutting_down` 5 s) are not in the registry | open: owned by `T-A-027`; not re-verified by the documentation stream |
| s1a-8 | `hasAnyPermission(held, [])` is false; "no requirement" must be handled separately by the web gating | recorded |
| s1a-11 | A socket test cannot spoof `Host` through `fetch`; HSTS and preview matrices run in process or with `node:http` | recorded |
| s1b-3 | `rejectOptions` needs the route table's method list for a real `Allow` | closed by the route table (s1e); not re-verified here |
| s1c-9 | A global budget for buffered request bodies (up to 9 MiB, 2 MiB, 256 KiB each, for at most the 60 s request timeout, bounded per client by the buckets; many addresses multiply it). Not taken at G1 | owner; remedy: refuse with 503 above N bytes in flight |
| s1c-11 | The English texts of `PREVIEW_WARNING` and the generic problem wording are unreviewed | owner |
| s1c-13 | `.vitest/` is not in `.gitignore`; a JSON-reporter report was once committed (s1f-2) | open (S0/orchestrator) |
| s1c-14 | The label of `ANONYMOUS_ACTOR` is pinned by no test | open (Phase B) |
| s1d-3 | Install protocol gap: after a failed `pnpm add` of a native dependency `node_modules/.modules.yaml` keeps `ignoredBuilds` and every later install fails | open: `tools/INSTALL-PROTOCOL.md` should say so for the next native dependency |
| s1d-12 | A destructive migration (dropped column or table) will fail the upgrade harness until it gets an explicit allowance and an ADR; version 2 needs `REAL_SEEDS[1]` | recorded |
| s1d-13 | The moderate dev-only `esbuild` chain through `drizzle-kit` | see SA-10 |
| s1e-11 | `serveStatic` makes three synchronous file calls per asset request | recorded; revisit only if `T-A-330` or `T-A-331` shows it |
| s1f-1 | Four red tests in `single-implementation.test.ts` (`values.ts` hex pattern, `replyLuminance`, `offline.js` `navigator.languages`) | closed for the S2 parts by the renames of `chunk-s2e.md`; the `offline.js` part by s4d A-6 (the offline page no longer reads the language) |
| s1f-2 | `apps/server/.vitest/json/output.json` tracked and not ignored | open (see s1c-13) |
| s1f-6 | The rule `no-direct-route-registration` still allows `new Hono()` in `app.ts`, which nothing needs now | open (S0, optional) |
| s1f-8 | The image health check asks 127.0.0.1; with `HOST` set to a single non-loopback address it fails although the server is fine. Documented in operations.md | owner: document only, or let the script read `HOST` |
| s1f-9 | Not exercised: the process as PID 1 (covered later by the image smoke), arm64, a bind-mounted volume, a real EROFS turn during run | recorded (UV5) |
| s1-fix-1 | The parser-level errors `bad_request` (400), `request_timeout` (408) and `request_header_fields_too_large` (431) are registered since amendment 1: the registry has 34 codes, with Dutch and English messages (`chunk-amend1.md`); older gate notes still say 31 | closed (2026-10-11) |
| s1-fix-2 | Anonymous denied writes can grow the audit table without bound | see R-09, OD-13 |
| s1-fix-3 | Residual of preview mode: a client that reaches the port directly can send `Host: localhost` without forwarding headers | recorded (R-08) |
| s1-fix-4 | The migration runner re-implements the stock migrator's loop (about 20 lines); a Drizzle change of the bookkeeping table fails `verifyApplied` and the upgrade tests loudly | recorded |
| s1-risk | Risks of S1 chunks kept for reference: `TRUST_PROXY=1` without a proxy lets a client choose its address; `style-src` without `unsafe-inline` blocks inline style attributes (BC-06; e2e is the control); compression buffers whole responses (up to the 8 MiB export); the rate limiter can sweep 10,000 entries per insertion in the worst case; clients behind one IPv6 /64 share a bucket; the shutdown drain test takes 10 real seconds; `verify-audit` on a WAL database needs write access to the directory for `-shm` unless the writer's files exist; no browser run for S1 (`T-A-322` is the control) | recorded |
| s1-pending | Closed-state of the S1 hand-off items: `T-A-045` wiring, `T-A-044` readiness, `T-A-041` denial audit and the S2 table-driven tests were delivered in G1 and G2 | closed (G1, G2) |

### Stream S2 (branding backend)

| # | Point | Status |
|---|---|---|
| s2a-4 | Logo plate thresholds: dark theme plates below luminance 0.113, light theme above 0.248 (3:1 against the sidebar surface); plates white and `#161b22`. 3:1 plates some readable mid-tones; a mean is a proxy (a half-white half-black logo is not plated). Per-asset min and max would be a data-model change | owner (design review at the Appearance acceptance) |
| s2a-6 | Organisation-name edge cases for FR-A-081: tab and newline refused; the England, Scotland and Wales flag emoji (tag characters) refused; Mongolian variation selectors U+180B to U+180D refused; ZWJ emoji, ZWNJ and keycap sequences accepted; refusal happens before trimming | open (spec sentence) |
| s2a-7 | FR-A-092 wording: the code draws the drawable initials when only some can be drawn ("Zoë 日本" shows Z); the spec says "otherwise one fixed generic pictogram" | owner |
| s2a-9 | The default-ignorable table is pinned to Unicode data; a Node upgrade that changes it fails `shared/org-name.test.ts` | recorded; re-check on a Node upgrade |
| s2a-risk | `Intl.Segmenter` in older browsers may count a new emoji differently from the server (show the server's `org_name_invalid`); `@types/opentype.js` pulls the DOM lib into the shared program (`exports.test.ts` still catches DOM globals in `src`); `Base64PngSchema` decodes up to 2.8 million characters per image on the main thread; the code point sweeps take about 1.5 s; the Write tool of the build environment turns `\uXXXX` escapes into characters | recorded |
| s2b-1 | The server test run was red by design until `T-A-083` | closed (G2) |
| s2b-6/8 | Category expectations of the corpus beyond H-01 and H-13; H-19 accepts an out-of-range declared size with or without a warning | closed by `T-A-080` per its task; not re-verified here |
| s2b-9 | libvips prints a `GLib-GObject-CRITICAL` line on stderr for `width="1e9"` raw SVG; the pipeline sizes from the `viewBox` first; the child has no stderr (s2c-3) | recorded |
| s2b-risk | Hand-built HEIC and PDF fixtures; sharp output is part of the bytes of raster fixtures (a sharp upgrade may change bytes, not meaning); the corpus asserts `metadata()` calibration, the rendering claims are `T-A-081`'s | recorded |
| s2c-risk | `failOn: 'warning'` is also used when rendering the rebuilt SVG: a librsvg warning on our own output would be refused as `image_corrupt`; relax to `error` for SVG if the Appearance acceptance shows it. The value grammar is ours: `calc()`, `var()` and `env()` lose their attributes with `unknown_attribute` | open (Appearance acceptance `T-A-216`) |
| s2e-risk | File modification times drive the orphan and `.tmp` sweepers (a restore resets them: harmless); the directory is not fsynced after the rename, so a power loss can lose the newest file while its row survives (start logs `branding_asset_missing`, the UI shows the monogram) | recorded |
| s2e-3 | Quota order deviates from plan 8.5 (stage 4 after the image job, again under the lock); derived variants retire already expired; the quota counts waiting assets only. The wording of `chunk-s2fix.md` is now in data-model I-5 and section 5, spec FR-A-091, section 6.4 (the specific 409 detail) and section 6.6 | closed (2026-10-11; the spec row 6.5 of the quota is unchanged) |
| s2fix-1 | Undo goes back ONE change: masters retired by the previous apply lose their 24 hours at the next apply, so at most 3 files are the Undo target and count toward the quota. Residual: an upload whose timer was refreshed in the same millisecond as an apply is taken for a retired master and expires at the next apply (the administrator uploads again) | recorded |
| s2fix-2 | The 413 of the request cap (2,162,689-byte upload, 9,437,185-byte import) is answered by the body-limit guard in `src/http` and is not audited; pinned by tests. An audit of it needs an `onBodyLimit` hook in the route wrapper (S1) and flipping two assertions | owner |
| s2f-risk | An import holds about 40 MB at peak; three images are processed one after the other (up to 30 s of image time); `prototype` is refused as a key too (not in FR-A-093's list) | recorded |
| s2g-1 | `compress.ts` weakens every strong ETag when it compresses; branding avoids it with `Cache-Control: no-transform`. Phase B routes that use `If-Match` (secrets, setup, RBAC) will meet the same trap | open (S1/Phase B): each route sets `no-transform`, or compression leaves such ETags alone |
| s2g-2 | `routes/meta.ts` exports no builder for the `me` body; `module.ts` has a tested copy | open (S1, any time) |
| s2g-risk | The HTTP corpus takes about 90 s on 4 shared CPUs (one process per fixture); `no-transform` costs about 1.5 KB per branding read; the H-37 preload wraps `http.createServer` and fails loudly if `@hono/node-server` imports `http` differently | recorded |
| s2-fix-1 | SVG containers `<a>` and `<switch>` are unsupported; import `schemaVersion` 1.0 acceptance is a nit | recorded |
| s6b-4 | H-42 `body-9437185-bytes` once saw a closed connection instead of the 413 under load (a race between the server closing the socket and the client reading the answer, inherent to answering before the body is read) | recorded; if it recurs the runner should accept `closed` as it does for `cutOff` |

### Stream S3 (shared core and design system)

| # | Point | Status |
|---|---|---|
| s3a-OP1 | The 3 % margin band: FR-A-101 says a colour that meets the bounds is used unchanged; plan 10.4 uses the bounds with a 3 % margin (3.09:1, 4.635:1, 4.502:1), so a colour at 3.00 to 3.09:1 is adjusted. The test encodes the plan | owner: add the sentence to the spec row or drop the margin |
| s3a-OP2 | A near-black accent in the light theme gets hover `#010101` and active `#020202` (0.045 OKLab lightness is below one 8-bit step); 3 of 24,096 sampled colours; AA unaffected | owner (design) |
| s3a-OP3 | 63 % of random colours get black text on the accent; 52 % (light) and 31 % (dark) are adjusted | owner (OD-14) |
| s3a-OP4 | Default accent `#0078d4` equals a well-known vendor blue | owner; one constant (`DEFAULT_ACCENT`) and a regenerated stylesheet |
| s3a-OP5 | `T-A-078`/`T-A-082` should list `T-A-122` under Needs; optional `"sideEffects": false` in `packages/shared/package.json` if the bundle check shows the tokens barrel in the entry chunk (also s4a-8) | open (orchestrator, at `T-A-259`) |
| s3a-OP6 | `RADIUS_FULL_USES` is a list, not a control; nothing scans for `rounded-full` | open (S3, a source scan in `styles.test.ts`) |
| s3a-OP7 | The exhaustive 16,777,216-colour sweep is a one-off; CI runs the 24,630-colour property test | recorded; re-run after a change of a surface, `accent.ts` or `contrast.ts` |
| s3a-OP9 | Spec wording: FR-A-120 says the tokens are "defined once as CSS variables through the Tailwind v4 theme"; as built they are defined in TypeScript and emitted as CSS variables (PD-13) | open (spec sentence) |
| s3a-OP10 | `pnpm tokens:check` is not a CI step by name | closed: G7 added a "Design token freshness" step |
| s3a-risk | Engine rounding: the exact hex can differ by one 8-bit level on another engine (the guarantee holds per engine); bundle weight of the tokens barrel (unmeasured until `T-A-259`); injection order solved by `:where` defaults; a surface change can make the derivation throw a named error | recorded |
| s3b-OP2 | The Radix scroll-lock `<style>` needs a nonce (`__webpack_nonce__` set before the first render) | closed by `T-A-164` per the S4 notes; the e2e guard is the control |
| s3b-OP3 | The Latin font must be preloaded; its hashed name is known only after the build | closed by the build plugin (s4b); not re-verified here |
| s3b-OP4 | axe reports `aria-hidden-focus` on `#root` while a Radix Select is open (a static false positive) | open (S9: do not scan with a Select open, or exempt that one rule in that state) |
| s3b-OP5 | Focus after a dialog opened from a menu item falls to `<body>` unless the caller hands focus to the menu trigger | recorded; on first use |
| s3b-OP6 | The radio uses `rounded-full`, beyond the three documented uses (avatar, switch thumb, status dot) | owner: add `'radio'` to `RADIUS_FULL_USES` or make it a rounded square |
| s3b-OP7 | No looping animation exists (skeleton, spinner): FR-A-122 caps every animation at 200 ms | owner: read the rule as "per transition" (a spec amendment) or keep static |
| s3b-OP8 | `CommandBar` overflow is the caller's decision (`maxVisible`), not measured | recorded |
| s3b-OP11 | Spec section 2 should list `web/ui/cn.test.ts` and the `web/ui/*.test.tsx` files as additional controls (TA-08) | open (spec pass) |
| s3b-risk | `cn@0.4.0` is a young package (fallback `clsx` plus `tailwind-merge`, one file); Radix 1.7 attribute names (`data-[state=checked]`); forced colours reviewed by eye on one screenshot (`forced-colors.spec.ts` is the control); happy-dom has no layout; `styles.test.ts` runs four Vite builds into a git-ignored folder; modal Radix components lock the body scroll | recorded |
| s3b-A | Assumptions of the design system: `Button` defaults to `secondary`; popups sit on the `dialog` layer; font fallback `size-adjust` 106.7 % measured against Liberation Sans in Chromium 141; `prefers-contrast: more` raises two aliases and the focus ring to 3 px; toasts: at most five, 5 s, announced by the Radix announcer; each `Tooltip` has its own provider | recorded |
| s3c-OP1 | `tokens.generated.css` must never be reformatted by hand or by a formatter that ignores `.prettierignore` | recorded |
| s3c-OP2 | DataTable wiring is S4's (labels from the catalogue, `columnStorage`, router search params) | closed (S4, G4) |
| s3c-OP3 | `getRowLabel` must be what the first visible cell shows (WCAG 2.5.3) | recorded; on first use |
| s3c-OP4 | Lazy-load the DataTable; its JS size was not measured alone | open (`T-A-173`, `T-A-259`) |
| s3c-OP6 | e2e coverage happy-dom cannot give: sticky header, skeleton height, keyboard walk, visual baselines of the table | open (S9) |
| s3c-risk | TanStack Table 9.2.8 is a new major (PR-02); the column picker is a modal dialog; focus after a column move was proven in happy-dom only; `exactOptionalPropertyTypes` stays off | recorded |
| s3fix-1 | The `/design` showcase toast covers the DataTable page-size select at a 900 px viewport (a pointer click is intercepted; keyboard works) | open (S4, showcase) |
| s3fix-2 | `scripts/version_guard_paths.py` should list `patches/` as a protected path | open (OD-09) |
| G3-1 | Palette flag: the neutral blue-grey palette, accent default `#0078d4` and the 3 px focus ring under high contrast are for the owner's review with the screenshots of `T-A-332` | owner |

### Stream S4 (web foundation, shell, PWA, i18n)

| # | Point | Status |
|---|---|---|
| s4a-1 | `single-implementation.test.ts` treats functions named with the word "locale" outside shared as look-alikes | closed: S4 used other names (G4) |
| s4a-2 | Every commit that edits a fragment must run `pnpm i18n:merge` and commit the generated catalogues; on a conflict regenerate | recorded (architecture.md) |
| s4a-4 | A key whose last segment is `zero`, `one`, `two`, `few`, `many` or `other` is a plural form | recorded |
| s4a-5 | Interpolation formats numbers (1.234 in Dutch, 1,234 in English); pass a string to keep digits untouched | recorded |
| s4a-6 | The Dutch of the i18n fixtures and of the 32 problem messages is unreviewed | owner |
| s4a-risk | The catalogue checks' blind spots (nl and en are both Latin, so the third-script check can only pass on real catalogues; a catalogue shifted wholesale); a Japanese catalogue would be judged too strictly; `Intl` data of the distroless Node was not asked about `nl` in Phase A; import attributes; generated-file conflicts; the type-derived key union grows with the catalogue | recorded |
| s4b-OP1 | `schemas/meta.ts` exports no `MeResponse` type; the web derives it | open (S1, any time) |
| s4b-OP3 | `apps/web/build` reads `../../VERSION`; the Docker build context needs it | closed (Dockerfile, G6) |
| s4b-OP4 | `precompress` also writes `index.html.br`/`.gz`, which the server never serves (about 16 kB) | open (S6, only if the size budget needs it) |
| s4b-OP5 | Entry size: 589 kB raw, 181 kB gzip at s4b; 374 kB raw, 120 kB gzip at s7c; first load 260 KiB Brotli against the 150 KiB target | open (PR-01; `T-A-173`, `T-A-334`) |
| s4b-OP6 | `radix-ui` is imported as the unified package in `toast.tsx`; check that only the Toast part is in the entry | open (`T-A-173`) |
| s4b-OP7 | The `-` shown for a missing request id is a literal, not a catalogue word | owner |
| s4b-OP8 | TanStack Query 5.104 deprecates `fetchQuery` and `ensureQueryData`; use `queryClient.query` and `staleTime: 'static'` | recorded |
| s4b-OP10 | The `<noscript>` text is literal Dutch and English in `index.html`, outside the catalogue check | recorded |
| s4b-A | Decisions: `__M365_BOOT_JSON__` is the JSON text only (the template owns the element); the manifest link is the template's own; the toast is the Radix provider (sonner dropped, PD-03); 4xx/5xx without a problem body become `http_<status>`, `client_error` or `network_error`; the spec names `problemMessage` and `requirePermission` are exported as `selectMessage` and `requireAnyOf` | recorded |
| s4b-risk | The boot script and `STORAGE_KEYS` are one source but `public/offline.js` cannot import them; the Vite 8 `transformIndexHtml` ordering is relied on (guarded by `build-output.test.ts`); the router `Wrap` is outside the router context | recorded |
| s4c-OP2 | The `link` button hover failed contrast on the dark surface | closed (s3fix) |
| s4c-OP1 | Radix Select injected an inline style (Trusted Types sink) | closed (s3fix, RP-1) |
| s4c-OP3 | Zod JIT probe fires when chunks split; fixed by `disableZodJit` in the boot script using the Zod 4.6.5 internal `__zod_globalConfig` | recorded; re-check on a Zod upgrade (the boot script has 1.4 kB of a 1.5 kB limit) |
| s4c-OP4 | cmdk 1.1.1 does not set `aria-activedescendant` itself; a MutationObserver follows the selection | recorded |
| s4c-OP5 | Document title of a page that throws while rendering stays the page's own | recorded |
| s4c-OP7 | Entry, DataTable and palette chunk sizes are not budgeted per chunk | open (`T-A-173`, `T-A-259`) |
| s4c-OP8 | Route-change focus and announcement for screen readers is not implemented (only the title updates) | open (S4/S9; part of the manual screen-reader pass) |
| s4d-OP1 | `e2e/pwa.spec.ts` and `e2e/offline.spec.ts` are the CI proof (the offline spec stops the server; `setOffline` does not reach the worker) | open (S9) |
| s4d-OP2 | Mount points of `UpdateToast` and `OfflineState` | closed per G4; not re-verified here |
| s4d-OP3 | `sw.js` (2.6 kB) works under the worker profile in Chromium 141; other browsers | UV8 |
| s4d-OP4 | The offline page does not pick the browser language (both languages side by side); an `EXEMPTIONS` entry would bring it back | owner |
| s4d-risk | `offline.html` is cached per version: a change without a version bump keeps the old copy; cache-first for `/assets/<name>` assumes hashed names | recorded |
| G4-2 | S4's remaining hand-offs are in `G4a.md` section 8 | closed (the items above) |

### Stream S5 (branding UI)

| # | Point | Status |
|---|---|---|
| s5a-OP1 | Upload progress is indeterminate (`fetch` gives no upload progress; `XMLHttpRequest` is refused by the guard) | owner: a percentage needs `XMLHttpRequest` inside `lib/api.ts` |
| s5a-OP2 | The preview needed a pure `OrgMarkView` | closed (s5b) |
| s5a-OP3 | The preview forces hover/pressed/focus with classes; a change of the button variants in S3 must be mirrored in `FORCED` of `LivePreview.tsx` | recorded |
| s5a-OP4 | The eight swatches and the colour wording ("Used", "Chosen", "adjusted slightly") are unreviewed | owner |
| s5a-OP5 | CSSOM writes of the preview proven in happy-dom only; not run in Chromium under the production CSP in the unit tests | closed: G5 ran the real Chromium production build (axe and CSP) |
| s5b-OP1 | `accent-subtle` with `text-fg` is 4.27:1 for `#ffff00` in the dark theme (secondary and ghost hover); axe fails the dark preview for that accent | open (S3); saving is not blocked |
| s5b-OP4 | Import apply is the third request of the `upload` bucket; a 429 is shown in words | open (S9 against the real server) |
| s5b-OP6 | `e2e/branding.spec.ts` and `e2e/branding-persistence.spec.ts` | open (S9) |
| G5-R | Tests of the S5 chunk were written after the code; only Chromium 141 was used; a build change in S4's plugin (`forgetInlinedStylesheets`) should be reviewed by S4 | recorded |

### Stream S6 (image and deploy)

| # | Point | Status |
|---|---|---|
| s6a-2 | The image checks were first written without a daemon | closed: the first real run (G6) found three true positives that the Dockerfile fixes |
| s6a-3 | The size ceiling stays 400 MB (193.5 MB measured, VERSION 0.2.31) | superseded 2026-10-13: the ceiling is 600 MB for the Ubuntu image (ODD-10; 538.2 MB measured in CI) |
| s6a-6 | Compose nested default proven on v5.6.0 only | UV6 |
| s6a-7 | `REQUIRE_DOCKER=1` and `git` on PATH must be set in the CI job that runs the server tests | closed: `ci.yml` sets it (s7a) |
| s6a-8 | The Caddy example was not run | UV7 |
| s6a-9 | The Dutch of `deploy/README.md` is unreviewed | owner |
| s6b-1 | Remediation texts must pass `--build-arg VERSION` | closed: operations.md says so; `image.yml` passes it |
| s6b-2 | `autoInstallPeers` puts type packages into the production tree | RP-3 |
| s6b-3 | The hostile corpus against the container exists only as a scratch harness (44 of 44 passed) | owner: add as a `REQUIRE_DOCKER`-guarded test before G9 if wanted |
| s6b-5/6 | Smoke bridge mode, arm64 and `docker compose up` were not executed | UV5, UV10 |
| s6b-7 | The Docker daemon was started by hand with `--iptables=false --bridge=none` and the vfs driver, which copies the image per container and filled the shared disk twice | recorded |
| s6b-8 | `repo-conventions` check 10 was red because of an `eslint-disable` in `db/migrate.ts` (chunk-amend1: shipped SQL runs through `runShippedStatement`; the owner may prefer an explicit rule allowance) | owner |
| s6-risk | `.dockerignore` is a contract with the Dockerfile; the `.env.example` parser is strict; Compose reads the shell environment before `.env`; the prune relies on the legacy deploy layout and fails the build when it finds nothing | recorded |

### Stream S7 (CI)

| # | Point | Status |
|---|---|---|
| s7a-1 | Concurrency: two quick merges can finish `publish` out of order and move `latest` backwards | recorded |
| s7a-2 | Artefact paths `e2e/playwright-report/`, `e2e/test-results/`, `e2e/lighthouse/results/` are assumed; missing paths are ignored | open (S9 owns the outputs) |
| s7c-1 | Bundle budget honesty: first load 260 KiB against 150 KiB; JS 232 KiB and CSS 43.6 KiB meet the spec limits; the ratchet only goes down | open (PR-01, `T-A-173`, `T-A-334`) |
| s7c-2 | `pnpm docs:check` failed in the `quality` job until these documents existed | closed once README.md lands (T-A-279) |
| s7c-3 | The `Bundle budget` ratchet in a shallow pull-request checkout depends on the script's own `git fetch --depth=1`; shellcheck findings on the runner; CodeQL may flag existing code on a first run; `visual-baselines.yml` assumes `visual.spec.ts` and its default snapshot path | open (UV1) |

### Stream S9 (verification, G4 follow-ups)

| # | Point | Status |
|---|---|---|
| G4-OP1 | Default-instance mobile LCP and Performance: see OD-15, OD-16 and ADR-0056 | owner |
| G4-OP4 | First load 262 KiB Brotli against 150 KiB (FR-A-155 is a SHOULD). Candidates: zod's core (20 KB), both catalogues in the first load (about 8 KB), the Radix toast, tooltip and menu parts, the drawer's dialog | open (PR-01; `T-A-334`) |
| G4-OP6 | `form-field.tsx` puts `font-normal` on the "required" hint; the theme resets weights, so the class generates no CSS (`font-regular` is the theme's class). Changing it changes pixels | open (S3) |
| G4-OP7 | Lighthouse's lab spread is real (TBT moves by about 100 ms between runs); FR-A-154 judges Performance on the first run, so a rare noisy first run (94 where 99 is usual) fails. Left as written | owner (PD-27) |
| G4-OP5 | A Phase B display name (actor label, document title) is user text: use `isolatedMessage` or `<bdi>` | open (Phase B) |
| s9c-1 | The best-of-3 rule for timing and the 10 percent wide default-mobile gate lose sensitivity: a regression smaller than the run-to-run spread (LCP 0.03 to 0.3 s, Performance 1 to 10 points) passes | recorded |
| s9c-2 | `T-A-330` says three runs; the baseline rule (repeat only on a timing miss) is followed, `--always-repeat` gives three | recorded |
| s9c-3 | `pnpm lighthouse` takes about 20 minutes for the full pass; on GitHub it needs the same, Node 22.19 or newer and a Chromium | open (CI first run, UV1) |
| s9c-4 | No Phase A git tag exists; the no-Phase-B guard switches on the constant `CURRENT_PHASE` in `tools/traceability/phase-guard.ts` (change it to `'B'` in the commit of the first Phase B file) | recorded |
| s9c-5 | The README images (`docs/media`, made by `pnpm media`) show the version string (0.2.40) and go stale at the next bump. Re-run `pnpm media` for a release, or mask the version (a one-line change) | owner |
| s9c-6 | The step and job reader of the traceability check is line-based (no YAML parser: the workspace-deps guard forbids an undeclared one); another indentation makes a step "missing" and fails loudly | recorded |

### Gates and cross-stream

| # | Point | Status |
|---|---|---|
| commit-chores | At every commit: bump `VERSION` for protected paths; `pnpm add` strips the comments of `pnpm-workspace.yaml`, so check that `git diff pnpm-workspace.yaml` shows only the intended catalog lines and that the comments are back; the lockfile keeps its `libc:` lines | orchestrator |
| G1-6 | Carried over at G1: s1c-9 (not taken), `serveStatic` synchronous calls (s1e-11), the install protocol for the next native dependency (s1d-3) | see those rows |
| G2-4 | Plate thresholds (G2a OP-3) are for the owner's review | s2a-4 |
| G2-5 | The upload rate class makes H-39 unrunnable from one client over HTTP, which is the intended protection: the row runs from distinct client addresses behind a trusted proxy | recorded |
| amend1-1 | `runShippedStatement` is the one place that runs shipped SQL, and the lint rule's header says migrations are out of its scope; see OD-17 for the proposal of an explicit allowance. The Dutch and English texts of the three new messages are unreviewed | owner |
| S9-pending | Gate notes of S9 later than `chunk-s9c.md` (T-A-334 to T-A-337: budget recalibration, accessibility and responsive passes, the Phase A report) were not available when this file was consolidated | open: add their points when they land (T-A-999) |
| T-A-279 | `README.md`, English and Dutch, written 2026-10-11 and checked by `pnpm docs:check` (`G8.md`) | closed |

## Phase B (2026-10-12)

Consolidated for Phase B by the documentation task `T-B-425` from the Phase B spec (sections 8, 9, 11 and
12), the plan (sections 17 to 20) and `research-microsoft-b.md`. The ids continue the Phase A series: U34 and
up, the owner-verified ledger OV, the assumptions B, the plan decisions PB, the owner decisions ODB and the
risks RB and PBR. Status words are as above. Rows of the spec are copied with their ids; a status column is
added where the spec has none.

### Unverified Microsoft claims U34 to U50

Date of the register: 2026-10-10 (Microsoft Learn only), closed items marked on 2026-10-12.

| # | Claim | Where used | Tried | Needed to close |
|---|---|---|---|---|
| U34 | The `docker exec` command `/nodejs/bin/node /app/dist/cli.js <command>` works in the distroless image | FR-B-110, US-B1, README | Phase A image layout from its plan | Closed on 2026-10-12: the image smoke test ran `dist/cli.js generate-app-key` and `docker exec ... setup-token` in the real image (33 of 33 checks green), see `specs/002-phase-b/phase-a-reread/deploy-docs.md` |
| U35 | Clock-skew values: Learn gives no tolerance for ID-token timestamps and none for the host clock against Entra; the 60 s tolerance and the 60 and 300 s thresholds are our choices | FR-B-213, FR-B-404 | id-tokens and signing-key-rollover pages | OV-07 and OV-23 show real skew; the numbers are constants |
| U36 | Which properties (`id`, `displayName`, `groupTypes`, `mailEnabled`, `securityEnabled`) `GET /groups/{id}` returns to an application that holds `GroupMember.Read.All` and not `Group.Read.All`; the permission is listed for Get group and described as "basic group properties"; and whether `GET /groups` returns distribution groups to such an application (Learn calls them read-only in Graph) | FR-B-311, FR-B-219, Phase C and D (recognising and listing distribution lists) | group-get, group-list, permissions reference (excerpts) | OV-19 |
| U37 | `GET /groups?$filter=startswith(displayName,'...')` works for an app-only caller without `ConsistencyLevel: eventual` | FR-B-311, FR-B-219 | group-list excerpt | OV-19; fallback: send `ConsistencyLevel: eventual` and `$count=true` |
| U38 | `checkMemberGroups` with a well-formed id of a group that does not exist or was deleted: the whole call fails, or the id is omitted | FR-B-507 | the page states that one malformed id fails the request and is silent on unknown ids | OV-16; the bisect fallback of FR-B-507 handles both |
| U39 | Browser handling of `SameSite=Strict` cookies set by and sent after a redirect chain started by a cross-site navigation, and of cookies on `http://localhost` (shared across ports, `Secure` omitted) | FR-B-401, FR-B-412 | reasoning from the cookie specification, not Learn | OV-14 |
| U40 | Option names of `jose` 6.2.12 for remote key sets (cache duration, cooldown) | FR-B-404 | stack probe pins the version | Closed (probe V-B08): the option names are `cacheMaxAge` and `cooldownDuration`; `server/auth/jwks-cache.test.ts` pins the behaviour |
| U41 | Whether Node 22 honours `NODE_USE_ENV_PROXY` for `fetch`, and from which minor | EB-31 | none | image smoke test behind a proxy, or the owner's own proxy |
| U42 | A `WWW-Authenticate` challenge with the scheme `Cookie` (RFC 9110 expects a challenge with 401; the scheme is not a registered one) | FR-B-414 | RFC text only | none; low risk, documented |
| U43 | Host names of the `verification_uri` Entra returns for the device-code flow; the allow-list (`microsoft.com`, `www.microsoft.com`, `login.microsoft.com`, `login.microsoftonline.com`) is ours | FR-B-214 | research §5.1 (response shape only) | OV-01 shows the real host; the allow-list is a constant |
| U44 | Whether the Admin API `OrganizationConfig` endpoint accepts `$select`, and which properties it returns | FR-B-309 V5, FR-B-314 | endpoint reference lists `Get-OrganizationConfig` without parameters | OV-06 |
| U45 | The response envelope of the Admin API (top-level array, `value` array or single object) and its error body | FR-B-314 | `get-started`, `OrganizationConfig` and `DistributionGroupMember` pages read; they show requests, not responses | OV-06 records a real answer |
| U46 | `Group.ReadBasic.All` is named in Learn's List groups table but has no section in the permissions reference; whether it exists for applications | fallback ladder of plan 8.8 | permissions reference searched | Learn clarification or a tenant listing of the Graph service principal's `appRoles` |
| U47 | Entra accepts an uploaded self-signed certificate with exactly `basicConstraints` (cA=false, critical) and `keyUsage` digitalSignature (critical) and nothing else; re-sending existing key credentials as read (with `key`) preserves them in a full-list `PATCH` | FR-B-106, FR-B-306 | plan probe V-B02; Learn pages carried | OV-03, OV-04 |
| U48 | `assignedLicenses` is returned for `GET /users?$select=assignedLicenses` with `User.Read.All` alone | Phase C | user-list page: its property exceptions do not list it | the Phase C spec. **Deferred on 2026-10-13 (D-C3):** `assignedLicenses` is never selected (a `$select` containing it fails `schemas.test.ts`); not tested, not closed |
| U49 | Application `tags`: maximum count and length, so that `m365portal-install-<32 hex>` is accepted | FR-B-303 | none on Learn | OV-03 |
| U50 | `$select` of `passwordCredentials` and `keyCredentials` on `GET /applications/{id}` and `GET /servicePrincipals(appId='...')`, and `GET .../owners?$select=id`, return the collections (without secret text) to a delegated caller holding `Application.ReadWrite.All`; the properties are named on the application, service principal and passwordCredential resource pages and both owner lists name `Application.Read.All`, but no page shows a `$select` of the credential collections | FR-B-318, FR-B-319 | resource pages and both owner-list pages read on 2026-10-10 | OV-03; fallback: an unreadable count stops adoption (fail closed) and V4 shows `not_checked` for it |
| U51 | Whether Graph sends `Retry-After` as seconds only or also as an HTTP date (both are read) | FR-B-312 | Learn's Graph throttling page says seconds | OV-01 |
| U52 | The status of a duplicate `POST /servicePrincipals` (the fake answers 409) | FR-B-310 | none on Learn | OV-03 |
| U53 | The permissions needed to list role assignments, and whether Application Administrator may grant non-Graph roles (the fake allows Global Administrator and Privileged Role Administrator only) | FR-B-310, FR-B-318 | none on Learn | OV-02 |
| U54 | Admin API error statuses and bodies: unknown group (404), wrong tenant in the URL (403), missing `X-AnchorMailbox` (400), wrong content type (415), expired continuation link (400) | FR-B-314 | none on Learn | OV-06 |
| U55 | `Guid` is not among the documented recipient properties; it is requested with `$select` and read as null when absent | FR-B-314 | none on Learn | OV-06 |
| U56 | The `/users('$x@y.com')` key form for a user principal name that starts with `$` | FR-B-312 | Learn's tip on keys | OV-01 |
| U57 | Whether `appRoleAssignment` ids are opaque strings (only role assignment ids are shown on Learn) | FR-B-310 | none on Learn | OV-03 |
| U58 | The maximum lifetime of a client assertion: Learn says 5 to 10 minutes and also that Entra places no restriction on `exp`; the product keeps 300 s, the fake enforces 600 s | FR-B-112 | certificate-credentials page | OV-04 |
| U59 | Whether Entra rejects a replayed assertion `jti` (Learn says it must be unique; the fake refuses a reuse) | FR-B-112 | certificate-credentials page | OV-04 |
| U60 | The wording of MSAL 7.0.1 errors that the bootstrap parses (`Error(s): <code> - ...`, `post_request_failed`) | FR-B-214 | library behaviour, pinned by tests | OV-01 |
| U61 | What the device-code poll answers when Conditional Access blocks (the fake answers `access_denied` with AADSTS53003) | FR-B-214 | none on Learn | OV-01 |
| U62 | The error code for client credentials sent with an `Origin` header (the fake answers `invalid_request`) | FR-B-112 | Learn says only that they are refused | OV-04 |
| U63 | Whether `prompt=login` yields a fresh `auth_time` in the ID token, which the step-up check relies on | FR-B-411 | Learn lists `auth_time` as optional | OV-07 |
| U64 | Whether a browser stores a `SameSite=Strict` cookie set on the callback response (reached by a cross-site redirect) and sends it on the follow-up request | FR-B-412 | browser behaviour; e2e only | OV-14 |
| U65 | Whether `end_session_endpoint` accepts `post_logout_redirect_uri` `http://localhost:<port>` when the registration holds the port-less `http://localhost/auth/logged-out` | FR-B-410 | extends U29 | OV-09 |

Updates made by the plan to earlier items: U22 (the default `interval` is 5 s and `expires_in` 900, observed;
`slow_down` stays undocumented), U31 (`$filter` on `principalId` is documented; the behaviour of a duplicate
POST is not), U33 (the discovery document lists only `RS256`; the clock tolerance stays ours), U40 (closed:
option names checked), U41 (accepted with an experimental warning, effect unproven), U43 (the observed host
is `login.microsoft.com`) and U44 (`$select` is documented; the envelope is U45). Carried from the research
and relied on by Phase B with unchanged status: U4 to U6, U13, U14, U18 to U21, U23 to U27, U29, U30 and U32.
Closed: U16.

### Owner-verified ledger OV-01 to OV-23

The owner's test plan. None of these is covered by an automated control; the Phase B report expands each into
a checklist line with a result field and the date. Status of every item: `owner`.

| ID | What the owner checks | Procedure and expected result | Fail means | Status |
|---|---|---|---|---|
| OV-01 | Device-code consent screen with the three scopes | Run step 2 with a Global Administrator, then with Privileged Role Administrator plus Application Administrator. Consent screen lists the three scopes; "Consent on behalf of your organization" appears only for the first; leaving it off works. Note the host of the verification link (U43). | Adjust the wizard text; extend the host allow-list; U23 stays open | owner |
| OV-02 | Device code allowed, or the Conditional Access message and manual mode | In a tenant with the managed "Block device code flow" policy (or after adding such a policy): step 2 names Conditional Access (`AADSTS53003`) and offers manual mode; the manual checklist then completes the setup. | Reword EB-04; fix the manual checklist (FR-B-218) | owner |
| OV-03 | Graph accepts what the wizard sends | Application with the `http://localhost` and https redirect URIs, `amr` and `auth_time` optional claims, a 360-day credential, tags; with an app management policy if the tenant has one (U14, U19, U20, U49); also read the credential and owner counts of FR-B-318 for the new application and its service principal (U50). | Change the body (FR-B-303), lifetime, key size or certificate profile (FR-B-106, U47), or where the counts come from (FR-B-318) | owner |
| OV-04 | First client-credentials token with the uploaded self-signed certificate | Verification V1 succeeds with `x5t#S256` only; if it fails with `AADSTS700027`, set the documented fallback of FR-B-112 and rerun (U21). | Switch the `x5t` fallback on by default | owner |
| OV-05 | The four application permissions are effective | V2 and V3 pass; record the delay between the grant and the first success. | Adjust the window of FR-B-212 | owner |
| OV-06 | Exchange role propagation and the Admin API probe | Record the delay between the role assignment and the first 200 of V5; note whether the preview API is available; note which `OrganizationConfig` fields return (U44). Optional Exchange Recipient Administrator experiment of ODB-03. | Window and wording of EB-09; ODB-03 | owner |
| OV-07 | A real ID token | Inspect the owner's own token claims (decode locally): `amr` values per method, `tid`, `oid`, no `groups`, `ver` 2.0, header `alg`, `auth_time`; observe `prompt=login`; observe whether `max_age` is ignored (U13, U27, U33, U35). | `AUTH_MFA_AMR_VALUES` default, step-up rule, tolerance | owner |
| OV-08 | A user in more than 200 groups and nested groups | Sign in as that user with a role bound to a nested group: the role applies through `checkMemberGroups`. | FR-B-507 | owner |
| OV-09 | Sign-out round trip | Sign out: land on `/auth/logged-out` then `/signin?signedout=1`; no front-channel URL registered; behaviour with an existing primary refresh token (U29). | FR-B-410 | owner |
| OV-10 | Real throttling | Cannot be forced; if a `429` occurs, read `docs/operations.md` log events and compare with FR-B-312. | Retry values | owner |
| OV-11 | Security Defaults tenant | The wizard works for an administrator; a non-administrator *Lezer* signs in with and without `mfa` in `amr` (EB-27). | EB-27 text; ODB-04 | owner |
| OV-12 | Non-administrator with a panel role on a tenant with user consent disabled | Sign-in either works or ends in `consent_required`; the consent link of FR-B-419 fixes it (U30). | FR-B-419 (SHOULD) | owner |
| OV-13 | Exchange write-path experiment (informs ODB-01, ODB-03) | On the owner's machine, with a throwaway application, certificate and Exchange Administrator assignment made by hand following Learn's app-only article (the panel's sealed key is never exported): `Connect-ExchangeOnline` with that application, `Get-DistributionGroup -ResultSize 1`, `Add-DistributionGroupMember` and `Remove-DistributionGroupMember` on a test list, then the same with Exchange Recipient Administrator instead of Exchange Administrator (U4 to U6). The report records which role suffices. Not a Phase B feature. | Appendix A recommendation | owner |
| OV-14 | Browsers and `SameSite` | Sign in with Chrome, Firefox and Safari on `https://` and on `http://localhost:<port>`: the first paint after the interstitial shows the signed-in persona; sign-out and re-sign-in work; no `securitypolicyviolation` (U39). | FR-B-401, FR-B-412 (B-07) | owner |
| OV-15 | Global Administrator without a panel role | Sign in with such an account: "geen toegang" page with a reference id, no session, an `auth.signin` denied entry `no_role`. | FR-B-506 | owner |
| OV-16 | Revocation timing of group-derived rights | Remove the user from the bound Entra group: rights vanish at the next request after `GROUP_CACHE_TTL_SECONDS`; record how long Graph needs to reflect the change; also delete a bound group and confirm others still resolve (U38). | Default TTL (ODB-10); FR-B-507 | owner |
| OV-17 | Break-glass | Generate the hash with `hash-password`, configure it, sign in: red banner, 30-minute limit, only "Eigenaar herstellen" works; the audit shows `breakglass.signin`. | FR-B-521 to FR-B-523 | owner |
| OV-18 | Restart and lock | After the first Owner signed in, restart the container: `/setup` answers 404, sign-in still works, the certificate opens with the same `APP_KEY`; remove `APP_KEY` and see the degraded state and the readable explanation. | FR-B-207, FR-B-108 | owner |
| OV-19 | Group picker and group properties | In wizard step 5 search groups by prefix; group properties include `groupTypes`, `mailEnabled`, `securityEnabled` with only `GroupMember.Read.All` (U36, U37). | Add `Group.Read.All` (new decision), or send `ConsistencyLevel` | owner |
| OV-20 | Tenant without Exchange Online | If the owner has such a tenant: Exchange sub-actions are skipped, step is warning, the panel works. Otherwise report "not tested". | EB-08 | owner |
| OV-21 | Manual provisioning mode | Follow the checklist for a tenant (or after deleting the application): V1 to V3 and V5 pass; V4 and V6 show `not_checked`. | FR-B-218 | owner |
| OV-22 | Repair against drift | Remove one permission and change the redirect URI by hand, then run "Herstel verbinding": only the drifted sub-actions change; no duplicate application or service principal appears. | FR-B-220 | owner |
| OV-23 | Environment checks on the owner's host | Step 1 is green in the real container (network hosts, time skew within 60 s, key); behind a proxy, record what happens (U41). | EB-14, EB-31 | owner |

### Phase B assumptions B-01 to B-26

Each assumption has one ADR: ADR-0100 plus its number.

| ID | Assumption | Evidence and verdict | Rows | Status |
|---|---|---|---|---|
| B-01 | Graph permission set: start from `User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All`; add `Group.Read.All` or `Directory.Read.All` only if provably needed; never `RoleManagement.ReadWrite.Directory` for the runtime application | Kept. Learn lists `GroupMember.Read.All` for `checkMemberGroups` on users, Get group and List groups, and `User.Read.All` for `transitiveMemberOf`; no call was found that needs `Group.Read.All` or `Directory.Read.All` (8.1, 8.2). Open: U36, U37. Delta against the brief's five in 8.2 | FR-B-301, FR-B-311 | recorded |
| B-02 | `ExchangeClient` interface plus an adapter for the documented read path only (Admin API, Preview); the write path stays an owner decision with a memo | Kept. The Admin API has six POST-only endpoints and no distribution list or contact writes; `InvokeCommand` has no Learn page; the PowerShell module is the only documented write path (8.4, Appendix A) | FR-B-314, ODB-01 | recorded |
| B-03 | Exchange Administrator for the service principal by default; a narrower custom role group is a follow-up; the role is a setting | Kept. Learn states Exchange Administrator suffices "for any task"; whether narrower roles suffice for list and contact writes is UNVERIFIED (U5); experiment OV-13 | FR-B-308, ODB-03 | recorded |
| B-04 | Wizard user is Global Administrator, or Privileged Role Administrator plus an app-registration role; the wizard asks exactly the scopes its calls need | Kept. Three scopes cover every call; the brief's fourth (`Directory.Read.All`) is needed by none (8.3) | FR-B-214, BCB-04 | recorded |
| B-05 | Sign-in is the authorization code flow with PKCE, `state`, `nonce`, issuer, audience and `tid` validation and a certificate assertion; implemented with our own code client and `jose`, with MSAL used only for device code and client-credentials tokens | Kept. MSAL adds `offline_access`, `openid`, `profile`, `email` and caches per account (research §5.3); the panel needs no token retention and one assertion signer | FR-B-112, FR-B-402 to FR-B-404, FR-B-418 | recorded |
| B-06 | MFA is a configurable `amr` check; step-up uses `prompt=login` plus a claims or `max_age` check | Changed. `max_age` and an ID-token `claims` request are undocumented for Entra (U13, U27) and `prompt=login` does not force MFA; step-up is `prompt=login`, a fresh `auth_time`, the same `oid` and the MFA policy again; no `max_age`, no `claims` | FR-B-405, FR-B-411 | recorded |
| B-07 | Sessions are server-side, hashed, in SQLite, with rotation, idle and absolute timeouts, sign-out everywhere and session-bound CSRF; the cookie is `__Host-` only on https, plain `HttpOnly`/`SameSite=Strict` on `http://localhost`; the OIDC transaction cookie is `Lax` | Kept, with two consequences: `response_mode=query` (a `form_post` callback is a cross-site POST that a Lax cookie does not accompany) and a 200 interstitial instead of a 303 after the callback so the Strict cookie reaches the first paint (U39). Phase A BC-03 already accepts the plain names on `localhost` | FR-B-401, FR-B-407, FR-B-408, FR-B-412 | recorded |
| B-08 | Libsodium XChaCha20-Poly1305 seals the certificate key; the key comes from `APP_KEY` or `APP_KEY_FILE`; a rotation procedure exists; the bootstrap token lives in memory only | Kept, with a derived per-purpose subkey, a key id and additional data that binds blob to row, purpose and key | FR-B-104 to FR-B-110, FR-B-215 | recorded |
| B-09 | A one-time setup token (`SETUP_TOKEN` or a 0600 file, never logged) protects the unconfigured panel; the wizard locks when `setup_completed` and answers 404 afterwards | Changed. The lock engages at the first successful sign-in of the designated first Owner, not at "finish": a failed first sign-in (wrong redirect URI, blocked MFA) would otherwise lock the owner out of the tenant they just configured (BCB-02). If that person never signs in, the state stays open and the token still guards it (documented). `setup-reopen` is the recovery | FR-B-201, FR-B-203, FR-B-207, FR-B-219, FR-B-222, ODB-05 | recorded |
| B-10 | The wizard is persisted, idempotent and resumable with per-step status, rollback hint, live log, retry and backoff | Kept. The live log is polled (1 s, 2 s in a hidden tab), not streamed, because intermediaries buffer event streams. Graph replication takes "several minutes" (research §10.2) | FR-B-208 to FR-B-212 | recorded |
| B-11 | RBAC: the 15-permission catalogue is unchanged; five immutable built-in roles; *Bestuur* as template data; effective permissions are the union of assignments; scopes; default deny | Clarified. The brief does not say what a scope restricts when a role mixes resource types. Scopes restrict per resource type; permissions without a resource type (settings, audit, RBAC) come only from unscoped assignments; `users:read` has the qualifier `basic` so *Bestuur* can read names and e-mail (BCB-09, BCB-10) | 6.5, FR-B-501 to FR-B-513 | recorded |
| B-12 | `GraphClient` (MSAL certificate auth, `Retry-After`, jitter, short-TTL cache, typed errors) is built on a thin own HTTP layer behind interfaces; the Microsoft Graph SDK is not added | Kept. The runtime client calls six Graph endpoints (8.2); the brief asks for no unnecessary dependencies; the retry rules are small and testable | FR-B-311 to FR-B-313, FR-B-711 | recorded |
| B-13 | Not in Phase B: users and groups screens (C), distribution lists, contacts, CSV (D), RBAC admin UI (D), audit UI (D), OpenTelemetry (D), Bicep (D) | Kept | 1.1 | recorded |
| B-14 | Retry values: transient 1 s to 30 s, at most 6 tries; replication 2 s to 60 s with a 300 s window; role-to-token propagation 900 s by default, 3,600 s at most | Changed from an earlier draft (600 s): Learn names no delay for Entra role to Exchange (U4), so the default is the research window | FR-B-212 | recorded |
| B-15 | Group membership comes from `checkMemberGroups` in chunks of 20 at every sign-in and at the cache TTL (300 s); the token's `groups` claim is ignored; Graph failure keeps direct grants and drops group grants | Kept. Learn: at most 20 ids per request; the `groups` claim is dropped over 200 entries (8.4) | FR-B-409, FR-B-507 | recorded |
| B-16 | The principal is `(tid, oid)`; the first Owner is the bootstrap administrator's `oid` plus `tid`, never `sub`; in manual mode the operator names the Owner | Kept. `oid` is the same across applications, `sub` is pairwise (research §5.5) | FR-B-216, FR-B-219, FR-B-406 | recorded |
| B-17 | Break-glass is decided for Phase B (the brief allows B or D): an optional env-configured account that can only restore an Owner | Kept at B. Without it a deleted Owner group or a lost MFA device locks the panel; the env-only design needs no UI and costs one route and one session kind | FR-B-521 to FR-B-523, ODB-06 | recorded |
| B-18 | `PREVIEW_MODE` is removed; actor kinds are `anonymous`, `user`, `setup`, `break_glass`; anonymous writes now answer 401 instead of Phase A's 403 | Kept. Phase A FR-A-032 promised removal; RFC 9110 expects a challenge with 401 (U42) | FR-B-102, FR-B-413, FR-B-414 | recorded |
| B-19 | A small X.509 library, chosen by a plan-time probe (candidate `@peculiar/x509`), creates the certificate | Added. `node:crypto` parses certificates and cannot create them (checked on Node 22.22); the distroless image has no `openssl` | FR-B-106, FR-B-711 | recorded |
| B-20 | Simulation: MSW with `onUnhandledFrame: 'error'` for HTTP; an in-process fake identity provider signing with `jose`; e2e starts the production bundle with request interception installed before it loads; no production file knows the fake | Kept (brief section 7) | FR-B-707, FR-B-708 | recorded |
| B-21 | Denials are audited for writes by any actor and for permissioned reads of authenticated actors; anonymous reads (401) and 429 are not audited | Changed (extends Phase A PA-15): the brief says every refused action (403) is audited; anonymous probing is attacker-reachable volume | FR-B-602, ODB-12 | recorded |
| B-22 | The certificate is RSA 2048 with 360 days validity; renewal in Phase B is the repair flow (full-list `PATCH`); self-rotation by `addKey` is Phase D; banners at 60 and 14 days | Changed against the brief's silence on lifetime: Learn caps a credential at one year from its start date; `addKey` needs proof of possession of a valid key (research §2.4); RSA size U20 | FR-B-106, FR-B-111, FR-B-220, ODB-08 | recorded |
| B-23 | A manual provisioning mode exists as a SHOULD | Added. The managed "Block device code flow" policy applies to every client and is enabled by default after a 30-day report-only period (research §5.6) | FR-B-218, ODB-07 | recorded |
| B-24 | Callback failures before the ID token is validated are not audited; failures from validation on are | Added. Earlier failures are unauthenticated and attacker-reachable; the `auth` rate class bounds the volume | FR-B-403 | recorded |
| B-25 | Session numbers: idle 30 minutes, absolute 8 hours, at most 10 sessions per principal, step-up window 10 minutes, break-glass 30 minutes, setup session 60 minutes and 8 hours | Added. The brief gives none and no source fixes them; `docs/security.md` documents the choice | FR-B-407, FR-B-411, FR-B-522, ODB-09 | recorded |
| B-26 | One replica on local disk (Phase A A-57): login transactions, setup sessions, rate and unlock counters live in memory and are lost at restart | Added. After a restart users sign in again and the wizard needs the token again; no security property depends on persistence; a shared store is out of scope | FR-B-204, FR-B-205, FR-B-402 | recorded |

### Phase B plan decisions PB-01 to PB-28

Each decision has one ADR: ADR-0150 plus its number.

| ID | Decision | Evidence | Consequence / revisit trigger | Status |
|---|---|---|---|---|
| PB-01 | Outbound HTTP is global `fetch` only; no `node:http`, `node:https`, `node:net`, `node:tls`, `undici` anywhere in `apps/server/src`; every test process installs a no-egress guard | V-B05 (`https.get` bypassed MSW and reached real Entra), V-B06, V-B04 (MSAL 7 uses `fetch`) | Tightens FR-B-315; revisit if a dependency starts using `node:https` (the guard then fails loudly) | recorded |
| PB-02 | X.509: `@peculiar/x509` 2.1.0 + `reflect-metadata` 0.2.2, lazy; fallback a 120-line DER encoder | V-B02, V-B03 | One-file swap behind `CertificateFactory`; revisit on an advisory | recorded |
| PB-03 | Sign-in uses our own code-flow client and `jose`; MSAL only for the bootstrap and app tokens | V-B04, B-05 | none | recorded |
| PB-04 | ID-token validation order of 8.6.5 with our own checks around `jose` | V-B07 | Fixture table F-02 to F-27 is the control | recorded |
| PB-05 | Remote key set: `cacheMaxAge` 24 h, `cooldownDuration` 5 min, custom fetch, hourly `reload()` | V-B08 (closes U40) | none | recorded |
| PB-06 | The setup actor holds exactly `settings:branding` and `settings:connection` | wizard step 5 needs the Phase A branding routes | Amends the spec (SB-01) | recorded |
| PB-07 | One availability gate for setup, connection pages and break-glass: same not-found function, same rate bucket as the unknown path | FR-B-207 | Byte equality test excludes only `requestId` | recorded |
| PB-08 | CSRF binding is computed from the cookies as sent (hashes joined by `.`), without a database read | an Owner who reopens setup holds two cookies | SB-09 | recorded |
| PB-09 | Sessions: hashed id, in-memory last-seen memo, database write at most every 60 s | FR-B-407 | After a restart idle can be up to 60 s longer | recorded |
| PB-10 | Revalidation inline and single-flight, retry no earlier than 30 s after a failure | FR-B-409 | Graph outage never blocks requests for more than one attempt per 30 s | recorded |
| PB-11 | `SCOPE_MATRIX` per target (11.3) | FR-B-513 leaves it to the plan | SB-07 | recorded |
| PB-12 | Break-glass: scrypt memory <= 128 MiB, one verification at a time, RBAC write routes restricted to `user` actors | V-B10 | SB-03, SB-04 | recorded |
| PB-13 | Certificate `pending` state; generate and seal before upload; renewal in repair with possession proof before swap | crash safety of the PATCH | SB-02 | recorded |
| PB-14 | In-process runner with lease; modes `continue` and `reconcile`; wizard budget disables `GraphHttp` retries so the runner owns and logs every wait; one combined poll per second | FR-B-209, FR-B-211, FR-B-212 | SB-19 | recorded |
| PB-15 | Boot re-check of `/api/v1/me` when the boot actor is anonymous | `SameSite=Strict` drops the cookie on cross-site navigation | keeps Strict (brief 6) | recorded |
| PB-16 | Header `X-Session-Idle-Expires` on authenticated responses | the client cannot know the sliding deadline otherwise | SB-18 | recorded |
| PB-17 | Four namespaces load lazily per locale; the rest join the entry | PD-16 threshold crossed | AM-21 | recorded |
| PB-18 | Service worker passes `/auth/*` and `/api/*` through untouched | keep redirects and cookies out of the worker | AM-12 | recorded |
| PB-19 | One WHATWG fake tenant, three transports, crash-after-n fault model | one simulation, no divergence | FR-B-707 | recorded |
| PB-20 | Clock, scheduler and random source injected in all new code | deterministic tests | lint canary | recorded |
| PB-21 | e2e: three processes, seeding through the real API, per-principal storage states | FR-B-708 | direct-DB `expired-assignment` fixture | recorded |
| PB-22 | Exchange probe `Get-OrganizationConfig?$select=Name,Guid`; tolerant envelope parser | V-B15 | U45 | recorded |
| PB-23 | `setup_object` kinds include grants and role assignments; audit `objectId` only for GUID ids | non-GUID ids | SB-11 | recorded |
| PB-24 | Grants merge per `(permission, qualifier)` | spec rule over-grants with scoped full grants | SB-13 | recorded |
| PB-25 | Phase C/D services take capability-branded arguments from the policy layer | the safety net cannot undo a write | 11.9 | recorded |
| PB-26 | Migration `0001` only adds objects; CHECK expressions come from `db/check-macros.ts` so schema and SQL cannot differ | data-model.md | none | recorded |
| PB-27 | 303 to `/setup` applies only without a valid user session | non-designated users during `awaiting_first_signin` | SB-14 | recorded |
| PB-28 | ADR numbering blocks | Phase A keeps 0001 to 0055 | AM-22 | recorded |

### Phase B owner decisions ODB-01 to ODB-18

Each has a default that the code implements, so work is not blocked; the owner can overturn a default at the
gate or after the owner test. ODB-01 (the Exchange write path) is recorded by ADR-0102 and is updated with the
owner's choice after the gate.

| ID | Decision | Options | Default in this spec | Evidence and effect | Needed by | Status |
|---|---|---|---|---|---|---|
| ODB-01 | Exchange write path (distribution list members, mail contacts) | A pwsh worker in the one container on an Ubuntu LTS base; B pwsh in a separate container; C Admin API only; D the undocumented `InvokeCommand` REST endpoint | Undecided; Phase B ships interface, read adapter and contract suite only. Recommendation A in Appendix A | Appendix A: criteria 3, 4, 12, 13; Phase B is unaffected | Before the Phase D plan; best at the Phase B gate | owner |
| ODB-02 | Graph permission set | The reduced four (default) or the brief's five; and `GroupMember.ReadWrite.All` granted now (default) or only when Phase C starts | Reduced four, write permission granted now | 8.2. Granting early means one consent covers Phase C, at the price of an unused write permission for a phase; deferral means a repair run with an administrator before Phase C | The owner test | owner |
| ODB-03 | Exchange role and second app role | Exchange Administrator (default) or Exchange Recipient Administrator or a custom role group; grant `Exchange.ManageAsAppV2` when exposed (default) or only `Exchange.ManageAsApp` | Exchange Administrator; both app roles | Learn supports Exchange Administrator; narrower sufficiency is U5, U6; the V2 role feeds only the Admin API probe | After OV-13 | owner |
| ODB-04 | MFA switch | `AUTH_REQUIRE_MFA` as an operator switch (default); or always enforced for principals holding `owner` or `rbac:manage` | Operator switch, default on, visible in the posture line and Settings | A tenant without any MFA policy cannot produce `mfa` (EB-26, EB-27); enforcing for Owners only would lock them out there | The owner test (OV-11) | owner |
| ODB-05 | When the wizard locks | At the first Owner sign-in (default) or at "Voltooien" as the brief says | First Owner sign-in | BCB-02 | The Phase B gate | owner |
| ODB-06 | Break-glass in Phase B | Build now (default) or in Phase D | Now | B-17 | The Phase B gate | owner |
| ODB-07 | Manual provisioning mode | Build now as a SHOULD (default) or defer to Phase D | Build now | B-23; tenants with the device-code block cannot use the wizard otherwise | The Phase B gate | owner |
| ODB-08 | Certificate renewal | Repair flow in B and `addKey` self-rotation in D (default); or only repair | Repair in B, `addKey` in D | B-22; a lapsed certificate always needs an administrator | Before the Phase D plan | owner |
| ODB-09 | Session numbers | Idle 30 minutes, absolute 8 hours (default), or others | Defaults | B-25 | The owner test | owner |
| ODB-10 | Group-derived revocation delay | `GROUP_CACHE_TTL_SECONDS` 300 (default) or shorter | 300 | Shorter means more Graph calls (4 resource units per 20 groups per refresh); OV-16 measures Graph's own delay | The owner test | owner |
| ODB-11 | Out-of-scope single objects | 403 `permission_denied` (default) or 404 | 403 | Brief: invisible or read-only. 404 hides existence; Phase C decides for lists (they filter by `visibleScopes`) | The Phase C spec | closed on 2026-10-13: decision D-C2, 403 `permission_denied` for a single object outside the scope, built and tested (`users-routes.test.ts`, `groups-routes.test.ts`, `audit-denials.test.ts`) |
| ODB-12 | Denial audit volume | Audit permissioned reads of authenticated actors (default) or writes only | Both | B-21; the brief asks for every refused action | The owner test | owner |
| ODB-13 | Admin API probe in verification | Keep V5 as a warning (default) or drop it until ODB-01 is decided | Keep | Preview terms U25; a warning never blocks | The owner test | owner |
| ODB-14 | First Owner other than the bootstrap administrator | Allowed only in manual mode (default), always, or never | Manual mode only | B-16; the brief says the signed-in Global Administrator becomes Owner | The Phase B gate | owner |
| ODB-15 | Plain cookie names on `http://localhost` | Accept (default) or require https even for local use | Accept | BCB-06; Phase A BC-03 | The Phase B gate | owner |
| ODB-16 | Entra groups and privileged roles | Roles holding `rbac:manage` or `settings:connection` cannot be bound to a group (default); or bound with step-up and a warning; or free | Forbidden (FR-B-515) | Whoever controls an Entra group (group owners, a Groups Administrator, a dynamic rule) would otherwise become a panel Owner without a panel audit entry. The brief allows assignment to groups but does not need it for the Owner role | The Phase B gate | owner |
| ODB-17 | Break-glass strength | A password floor and reverse-proxy restriction (default); or a second factor or an in-app address allow-list now; or restore only for `Member` users (needs `userType` in `getUser`) | Floor of 14 characters in `hash-password` (FR-B-110) and the documented proxy restriction; second factor and allow-list stay in Phase D | Break-glass bypasses Conditional Access and MFA by design; its password plus any enabled account in the tenant, a B2B guest included, restores an Owner. Restore refuses a disabled account (FR-B-523) | The Phase B gate | owner |
| ODB-18 | Adopting an existing application | Refuse secrets and ask for an acknowledgement of foreign certificates and owners (default); always refuse; always ask | Default (FR-B-318) | An application pre-created by someone else would receive the permissions the wizard grants, and its owner can add credentials at any time | The owner test (OV-03) | owner |

### Phase B risks RB-01 to RB-18 and PBR-01 to PBR-14

Likelihood and impact are low (L), medium (M) or high (H).

| ID | Risk | L / I | Mitigation | Control | Status |
|---|---|---|---|---|---|
| RB-01 | The Exchange write path stays undecided and Phase D cannot meet criteria 3, 4, 12, 13 | M / H | Memo with a recommendation and a deadline; Phase B built so any option plugs into the interface | `server/exchange/exchange-client-contract.test.ts`; ODB-01 | open |
| RB-02 | The Admin API stays Preview, narrows or disappears | M / M | Used only for the verification probe and the read adapter; failures are warnings | `server/setup/verify.test.ts`; U25 | open |
| RB-03 | Role propagation takes longer than the window | M / M | 900 s default, 3,600 s maximum, "Retry now", a final hint, the owner measures | `server/setup/propagation-probe.test.ts`; OV-06 | open |
| RB-04 | Device code is blocked by Conditional Access | H / M | Distinct message and manual mode | `server/setup/aadsts-map.test.ts`, `server/setup/manual-mode.test.ts`; OV-02 | open |
| RB-05 | A stranger takes over an unconfigured panel | M / H | Setup token, brute-force limits, loopback guard over http, token never logged, lock at first Owner sign-in | SC-B-001 | open |
| RB-06 | The owner locks themselves out (wrong redirect URI, lost `APP_KEY`, expired certificate, no Owner) | M / H | State stays open until the Owner signs in; `setup-reopen`; break-glass; documented `APP_KEY` backup | `server/cli.test.ts`, `server/auth/break-glass.test.ts`; OV-17, OV-18 | open |
| RB-07 | `APP_KEY` is lost, so the sealed certificate key is unrecoverable | L / H | Documented separate backup; recovery is a new certificate through the repair flow with an administrator | `server/secrets/degraded.test.ts`; `docs/operations.md` | open |
| RB-08 | One powerful application identity (Exchange Administrator, group write) is abused through a panel flaw | L / H | Panel RBAC on the server, fail-closed policy layer, audit of every write and denial, least-privilege documentation, ODB-03 | SC-B-006, `server/policy-scoped-routes.test.ts` | open |
| RB-09 | A self-signed certificate is discouraged by Learn | L / L | No CA exists for a self-hosted panel; the trade-off is written in `docs/security.md` | `server/docs-contract.test.ts` | open |
| RB-10 | The simulation encodes our reading of Learn and diverges from Microsoft | M / M | The fake validates strictly, contract suites run against it, the owner-verified ledger covers the residue | `server/fakes/fake-tenant.selftest.test.ts`; section 8.6 | open |
| RB-11 | Browsers treat the `SameSite` redirect chain differently from the design | M / M | `response_mode=query`, Lax transaction cookie, 200 interstitial; first paint carries the session | `server/auth/interstitial.test.ts`; OV-14 (U39) | open |
| RB-12 | The tenant never emits `amr` or MFA, so nobody can sign in | M / M | Separate errors `amr_missing` and `mfa_required`; operator switch; repair re-applies the claim; break-glass | `server/auth/mfa.test.ts`; OV-11 | open |
| RB-13 | Revocation of group-derived rights is late (cache TTL plus Graph eventual consistency) | M / M | TTL setting, revalidation, direct assignments revoke at once, expiry at the instant | `server/rbac/epoch.test.ts`, `server/auth/revalidate.test.ts`; OV-16 | open |
| RB-14 | In-memory state (transactions, setup sessions, counters) is lost at restart or differs across replicas | M / L | Documented single replica; sign-in simply starts again | `server/lifecycle.test.ts`; B-26 | open |
| RB-15 | Graph throttles the application | L / M | Retry rules, caches, priority header, fail-fast on long waits | `server/integrations/graph/http-retry.test.ts`; OV-10 | open |
| RB-16 | New dependencies (`@azure/msal-node`, `jose`, `libsodium-wrappers`, an X.509 library) enlarge the image and the supply-chain surface | M / M | Pinned versions, audit in CI, image size re-measured, each with a reuse mark | `quality`, `image`, `server/docs-contract.test.ts` | open |
| RB-17 | An attacker keeps the break-glass route or the setup unlock locked (the failure bounds are global: 20 and 30 per hour) or fills the verification queue, so the emergency path is unavailable when needed | M / M | The bounds are the price of online guessing resistance; a container restart resets the in-memory counters (documented); the setup token and the break-glass hash are long secrets; the reverse proxy can restrict both routes by address | `server/auth/break-glass.test.ts`, `server/setup/unlock-rate.test.ts`; `docs/operations.md` | open |
| RB-18 | Someone who controls an Entra group, an application owner or a credential of the runtime application gains panel or tenant power outside the panel's RBAC and audit | M / H | FR-B-515 (no privileged role for a group), FR-B-318 and FR-B-319 (adoption trust, foreign credentials visible), the blast radius documented in `docs/security.md`, a least-privilege permission set | `server/rbac/group-privileged.test.ts`, `server/setup/discovery.test.ts`, `server/setup/verify.test.ts` | open |

| ID | Risk | L / I | Mitigation and control | Status |
|---|---|---|---|---|
| PBR-01 | The simulation lets a real network call through (a library that bypasses `fetch`, as `node:https` bypassed MSW) | M / H | Fetch-only rule, no-egress guard in every test process, layering test, negative controls (PB-01, 14.3) | open |
| PBR-02 | Entra rejects the certificate or the assertion (`x5t#S256` only, extensions, lifetime, key size) | M / M | The three fallbacks are one-line switches (`x5t` header, shorter lifetime, key size); OV-03, OV-04; U19 to U21, U47 | open |
| PBR-03 | The Phase A interfaces differ from the planned ones at the Phase A gate | M / M | `T-B-001` re-reads the code against C1 to C14, amends the spec in the same commit (SB list grows), stops if a contract moved (V-B19) | open |
| PBR-04 | `@peculiar/x509` or `reflect-metadata` gets an advisory or misbehaves in the distroless image | L / M | Lazy import, 5 MB subtree, DER-encoder fallback, image smoke test creates a certificate in the real image (PB-02) | open |
| PBR-05 | Break-glass verification exhausts memory next to image jobs in the 512 MiB limit | L / M | 128 MiB cap, one at a time, the smoke test reports peak RSS (PB-12) | open |
| PBR-06 | Cross-site entry drops the `Strict` cookie and users bounce to sign-in | M / L | The boot re-check (PB-15); OV-14 observes it in three browsers | open |
| PBR-07 | Lazy i18n needs a Phase A i18n API change late in Phase A | L / L | `loadNamespace` is additive (AM-21); fall back to bundling all namespaces if the budget allows (it exceeds PD-16's threshold, so Lighthouse would be re-measured) | open |
| PBR-08 | `msw` 3 is a new major with `onUnhandledFrame`; its interception of `fetch` could change | L / M | Pinned; the no-egress guard is independent of it; the contract suites fail loudly | open |
| PBR-09 | The fake tenant encodes a wrong reading of Learn (assertion validation, replication delay, error codes) | M / M | Strictness self-test, contract suites on both implementations, the owner-verified ledger OV-01 to OV-23 | open |
| PBR-10 | SQLite writer contention: wizard run, sign-ins and the CLI use one file | L / L | Short `BEGIN IMMEDIATE` transactions, no network inside a transaction, `busy_timeout` 5 s, CLI uses the same PRAGMAs | open |
| PBR-11 | The Exchange Admin API envelope differs from the tolerant parser | M / L | Tolerant parser, warning-only use in the wizard (U45) | open |
| PBR-12 | A long-lived bootstrap object stays in memory after an error path | L / H | Four discard triggers (FR-B-215), `finally` blocks, lifecycle test with canary tokens, shutdown hook | open |
| PBR-13 | Reopen blocks sign-in for everyone until the wizard finishes | M / L | Documented in operations.md and in the CLI output; `setup-reopen` requires `--confirm`; the wizard keeps step state so the repair is quick (RB-13) | open |
| PBR-14 | `msal-node` carries `jsonwebtoken` and other transitive packages the product does not use | L / L | Listed in architecture.md, audited in CI, `clientCertificate` never configured | open |

### Decisions taken while building Phase B

These were taken by the implementing streams where the spec was silent; each is recorded here so that the
owner can overturn it.

- A step-up without MFA gives `mfa_required` or `amr_missing` (FR-B-411), not `stepup_failed`: the user needs
  to know which of the two tenant settings is missing, and `stepup_failed` stays for a mismatch of identity.
- The F-45 fixture uses 250 short entries in `groups` (with `_claim_names` and `hasgroups`): enough to pass the
  200-entry limit of a JWT while keeping the token under the header size of the fake identity provider.
- Audit rows of requests that have no user principal use the actor ids `anonymous` and `break-glass` (the
  break-glass session is an actor with no row in the user table), and the same ids appear in the logs.
- The stored default language (set by the wizard at finish) reaches the browser through `GET /api/v1/me`
  as `defaultLanguage` only once the setup is `completed`; before that there is no delivery path, so the setup
  and sign-in pages of an unconfigured panel follow the browser language.
- The group properties of OV-19 (`groupTypes`, `mailEnabled`, `securityEnabled`) are not visible in the panel
  in Phase B: the wizard's group picker shows the display name only, so a failure of U36 is detected by the
  owner test and not by a user-facing screen.
- The `x5t` fallback of the client assertion (the SHA-1 header of U21) is a constant in the code, not a
  variable: it is switched on by a one-line change after OV-04 shows `AADSTS700027`, so no operator can
  enable it by accident.
- There is no screen for the audit log in Phase B (the missing audit view is Phase D, FR-D-006); the audit
  is read through the database and `verify-audit`.
- Phase A items closed by Phase B: R-08 (preview mode) and OD-03 (preview mode removed), and the permission
  set of OD-06 is implemented with its default (four application roles).

## Phase C (2026-10-12)

Consolidated at the closing of Phase C on 2026-10-13 by task `T-C-071` from the gate notes `specs/003-phase-c/gate-notes/GC0.md` to `GC3.md` (the e2e and documentation streams included). Added first by the Phase C specification task from `specs/003-phase-c/spec.md` (sections 8 to 11), `plan.md` (section 10) and `research-microsoft-c.md`. Numbering: this file already held U1 to U65 (the gap that `docs/phase-reports/phase-B.md` section 4.1 item 10 noted for U51 to U65 is closed: all of them have rows above), so nothing was renumbered and Phase C continues at **U66**. Status words as above.

### Unverified Microsoft claims U66 to U74

Date of the register: 2026-10-12 (Microsoft Learn only); final wording and status as of the closing of Phase C, 2026-10-13. Status words as above.

| # | Claim | Where used | Tried | Needed to close | Status (2026-10-13) |
|---|---|---|---|---|---|
| U66 | `GET /users/{id}/manager` (and `$expand=manager`) works for an application token holding `User.Read.All`; the List manager page says Application: "Not supported", a sibling page lists `User.Read.All` | FR-C-107, EC-C6 | List manager page read 2026-10-12 | OV-C2; the design degrades to "not available" | open. Built as a designed degradation: `unavailable` on 403, 400 or an odd shape; the fake refuses the manager for apps by default (`managerForApps('refused')`). Nothing tried beyond Learn; only a real tenant closes it |
| U67 | What Graph answers for the members of a `HiddenMembership` group without `Member.Read.Hidden` (empty list or 403), and whether such groups are missing from a user's `transitiveMemberOf` | FR-C-108, FR-C-206 | permissions text and members page read | OV-C5; the panel does not call members for such groups | open. Built: no members call for `HiddenMembership`; the fake omits such groups from a user's groups. The real answer is not known |
| U68 | `GET /groups/{id}/owners` accepts `GroupMember.Read.All` for application tokens (the PowerShell page says so; the REST permission table was seen only in part) | FR-C-305 | Get-MgGroupOwner page, owners page excerpt | OV-C4 | open. Built with `GroupMember.Read.All`; a Graph 403 shows the translated `graph_permission_missing` message, never an error page |
| U69 | The distribution and mail-enabled-security filters (`not groupTypes/any(c:c eq 'Unified') and mailEnabled eq ... and securityEnabled eq ...`) with `$orderby=displayName`, `$count=true` and the header work for an application holding only `GroupMember.Read.All`; `$select` of `visibility`, `mailNickname`, `description`, `onPremisesSyncEnabled` is returned (extends U36) | FR-C-301, FR-C-304 | group-list page filter table | OV-C1 | open. Built as written; `unknown` kind is a designed state (RC-01). Strictness of the fake is our reading (RC-04) |
| U70 | `startsWith` joined by `or` over `displayName`, `mail`, `userPrincipalName`, combined with `and accountEnabled eq ...`, `userType eq ...` and `$orderby=displayName` under the advanced pair is accepted | FR-C-202 | each part documented alone (advanced-queries property table) | OV-C1; fallback: `displayName` only | open. The fake treats `startsWith` on `userPrincipalName`, `department` and `mailNickname` as needing the advanced pair (not on `displayName`, `mail`): our reading (GC1 deviation 6). The fallback `displayName` only is not built |
| U71 | `$select=id,displayName,mail,userPrincipalName,department,mailNickname` on the polymorphic members and owners collections (and the manager) returns those properties for users (and `displayName`, `mail`, `mailNickname` for groups); amended 2026-10-13 from four to six properties | FR-C-306 | members page: query options supported | OV-C4; fallback: no `$select` | open. The code selects six properties, `department` and `mailNickname` included, because restricted-row decisions need the scope attributes (GC1 deviation 2). The fallback "no `$select`" is not built |
| U72 | The literal values of `userType` are `Member` and `Guest`, and users with a null `userType` exist; "member" then means `Member` only | FR-C-202 | property table says `eq` and `eq null` work | OV-C1 | open. Built with the literals `Member` and `Guest`; a null `userType` is neither |
| U73 | A `nextLink` of an advanced query keeps working without resending `ConsistencyLevel` (the client always resends it) | FR-C-103 | not stated on the pages read | none; harmless | open, harmless: the client always resends the header on a `nextLink` |
| U74 | Which properties `transitiveMemberOf/microsoft.graph.group` returns for an application holding `User.Read.All` and `GroupMember.Read.All` (limited-information rule) | FR-C-206 | permissions-overview excerpt | OV-C5; groups with `null` names show a dash | open. Built as written; groups with a null name show a dash |

No U66 to U74 claim was closed in Phase C: no automated test can reach a real tenant, and Microsoft Learn was read once (2026-10-12, `research-microsoft-c.md`). All nine wait for the owner test OV-C1 to OV-C5 (`docs/owner-test-phase-c.md`).

Carried and still open, relevant to Phase C: U1, U8, U36 (its "is `GroupMember.Read.All` listed for group list" half is answered by the group-list page; which properties come back stays open), U37 (not needed: Phase C always sends the advanced pair), **U17 and U48 (licences: deferred by the owner on 2026-10-13, no licence column in Phase C; status `deferred`, the licences are not built)**.

### Phase C owner decisions

Recorded (owner, 2026-10-13): **D-C1** first version is read only (no create/update/delete, no group-membership writes, no password reset, no licence changes; no new Graph permission; `GroupMember.ReadWrite.All` is "granted, unused" in Phase C, ODB-02 default). **D-C2** ODB-11 closed: a single object outside the visible scope answers 403 `permission_denied`; lists filter by `visibleScopes`. **D-C3** no licence column; U17 stays open (deferred). D-C1 to D-C3 are `recorded` and implemented.

On 2026-10-13 the owner said in chat that the default choices below are fine for now: ODC-01 to ODC-05 are therefore `recorded` as **default implemented, owner agreed 2026-10-13**. The owner can still overturn any of them after the owner test (OV-C2 for ODC-05, OV-C5 for ODC-04).

| ID | Decision | Options | Default in the spec | Needed by | Status |
|---|---|---|---|---|---|
| ODC-01 | Audit of successful reads | Denials only (the code today; default); or an entry per detail view; or per list | Denials only | The owner test | recorded: default implemented, owner agreed 2026-10-13 |
| ODC-02 | Distribution and mail-enabled security groups in the Groups list | Shown read-only with a badge (default); or hidden until Phase D | Shown, read-only | The Phase C gate | recorded: default implemented, owner agreed 2026-10-13 |
| ODC-03 | Search semantics | Prefix on name, mail and principal name (default); or tokenised `$search` | Prefix | The owner test | recorded: default implemented, owner agreed 2026-10-13 |
| ODC-04 | Hidden-membership groups | State "hidden", no call (default); or request `Member.Read.Hidden` later | State "hidden" | After OV-C5 | recorded: default implemented, owner agreed 2026-10-13 |
| ODC-05 | Manager | Best effort, "not available" when refused (default); or drop until U66 is closed | Best effort | After OV-C2 | recorded: default implemented, owner agreed 2026-10-13 |

### Phase C assumptions, plan decisions and risks

| ID | Statement | Status |
|---|---|---|
| AC-01 | The tenant is a workforce tenant (not B2C): `$count` and `$search` exist | recorded (a B2C tenant is not supported; not verifiable here) |
| AC-02 | A scan of 5 Graph pages per request is acceptable for scoped lists | recorded; the tenant size is unknown, OV-C3 measures the paging |
| AC-03 | Names and addresses are personal data: no logs, no disk cache | recorded; `no-pii-in-logs.test.ts` guards the log half |
| AC-04 | Only direct group members in the first version | recorded; the page says that only direct members are listed |
| AC-05 | The role templates of Phase B already grant `users:read` and `groups:read` as needed | recorded, but only partly true: the Phase B templates grant `users:read` full, but no role that can be assigned holds the qualifier `basic` before Phase D (spec FR-C-602, amended) |
| PC-01 | `GraphHttp.requestPage` is added instead of changing `requestAll` | recorded, built |
| PC-02 | The cursor store is in memory, not a signed token | recorded, built; a restart ends all cursors (documented in the owner sheet) |
| PC-03 | Prefix search over `$search` (ODC-03) | recorded, built |
| PC-04 | One pure query-builder module | recorded, built (`directory-query.ts`, a test forbids other builders) |
| PC-05 | Restricted rows for members and owners; omission for a user's groups | recorded, built (`restricted-rows.ts`) |
| PC-06 | Ids in paths are GUIDs only (no UPN lookups) | recorded, built (non-GUID is 422) |
| RC-01 | `GroupMember.Read.All` alone returns too few group properties (U36): kinds show as `unknown` (M / M) | open: depends on U36/U69, OV-C1 |
| RC-02 | The manager call is refused for applications (U66) (H / L) | open: degraded state built and tested; waits for OV-C2 |
| RC-03 | Scoped lists of a very large tenant are slow (L / M) | open: five pages per request (`scanPagesMax`); real timing is OV-C3 |
| RC-04 | The fake tenant encodes a wrong reading of Learn (M / M) | open: strictness self-test with 14 rules and the contract suite on both implementations; the reading itself is checked only by OV-C1 to OV-C6 |
| RC-05 | Restricted rows or the cursor store leak information (L / H) | open, mitigated: one restricted-row function with negatives, cursors bound to actor, route and parameters; one wasted groups request and one denial audit row per `basic` detail view are known (finding FC-10) |
| RC-06 | CSS growth from two new pages exceeds the budget (M / L) | open, at its limit: entry CSS unchanged but only 18 B of headroom, initial JavaScript only 52 B; any later change in the entry or a shared component needs `pnpm build && pnpm bundle:check`; a card layout for narrow screens needs an approved growth |

### Findings at the closing of Phase C (2026-10-13)

Gaps and inconsistencies found while consolidating `GC0` to `GC3` and the code. Ids `FC-nn` are new. "Amended" means the spec or task text was changed to follow the code, which is right; each place says it was amended at the closing of Phase C.

| ID | Finding | Status |
|---|---|---|
| FC-01 | FR-C-306 said four properties in the members `$select`; the code selects six (`department`, `mailNickname` added so a department- or alias-scoped actor does not see every member as restricted; GC1 deviation 2). U71 covers it | amended; OV-C4 must confirm Graph returns them |
| FC-02 | FR-C-204 said only-`basic` actors may not filter on state or type; the code refuses `enabled`, `type` and the principal-name search with 422 `filter_not_allowed` whenever any row could be shown as `basic` and the actor does not see all users in full (GC1 deviation 4). A mixed actor (`basic` plus a department-scoped full grant) cannot filter on state or type at all | amended; revisit after OV-C6 |
| FC-03 | FR-C-101 and tasks name `contract.test.ts`; the file is `graph-client.contract.test.ts` (Phase B name); `manager.test.ts` was added | amended |
| FC-04 | The e2e fixtures self-test is a Playwright spec (`e2e/tests/directory-fixtures.spec.ts`), not `e2e/fixtures.unit.test.ts` | amended |
| FC-05 | A `basic` actor cannot be created through the RBAC API before Phase D: no assignable role holds `users:read` basic. The e2e fixture writes a custom role into the database. US-C5, FR-C-602 and OV-C6 say so; the `basic` half of OV-C6 is not possible for the owner and is covered by tests only. Phase D (RBAC admin UI, role editor) closes it | amended; open for Phase D |
| FC-06 | SC-C4 `server/directory/perf.test.ts` was not built (informational, in no task); no timing is measured automatically | amended; OV-C3 is the only measurement |
| FC-07 | `docs/operations.md` (Dutch) said "alle 25 grenzen"; the table has 79 rows (checked 2026-10-13; `limits-doc.test.ts` does not check the sentence) | amended |
| FC-08 | The web tests use a `fetch` stand-in, not MSW (not a dependency, install protocol); the own `DirectoryTable` replaces the `DataTable` (page-and-total based); filters are native radio buttons (Radix controls raised the initial JavaScript by 1.8 to 4.2 KB gzip); the cursor is component state, not URL (FR-C-501 read as "filters") | recorded (GC2); spec and tasks amended |
| FC-09 | Bundle headroom after Phase C: 52 B of initial JavaScript gzip, 18 B of entry CSS (RC-06) | open (risk) |
| FC-10 | A `basic` actor: the loader of `/users/$id` asks for the memberships before the detail says the actor is basic. The request is answered 403 and is audited as one denial row (`permission_missing`) per detail view; the page never shows the answer | open; fix needs the grants before the loader (Phase D or a small patch) |
| FC-11 | The router writes `enabled` and `type` in the URL as a quoted string (`enabled=%22false%22`); the e2e specs accept both forms. Cosmetic | recorded |
| FC-12 | `seedDirectory` runs on demand in the fake tenant (the seed is built when an e2e fixture asks, 1,200 users and 150 groups), not at start | recorded |
| FC-13 | The `/design` showcase validator `validateShowcaseSearch` has the raw-key merge behaviour that the directory validators avoid (a dropped key keeps its raw invalid value); not touched | open, low |
| FC-14 | Six server tasks (T-C-010, 011, 012, 018, 019, 020) were written with their test in one step and not seen red first; their negatives are the evidence (GC1). The "seen red once more" reruns of all negative controls were not repeated | recorded |
| FC-15 | Not done by the stream: T-C-064 visual baselines (from the CI artefact only), T-C-069 full run and T-C-070 (GC3) are the orchestrator's or CI's | open, see `GC3.md` |
| FC-16 | Focus moves to the page heading on navigation through `usePageHeadingFocus` (FR-C-506), only after navigating, not after a filter change | recorded |
| FC-17 | `GroupMember.ReadWrite.All` is granted and unused in Phase C; docs list it as "granted, unused in Phase C" | recorded (ODB-02) |

For Phase D the owner will be asked for ODB-01 (the Exchange write path), ODB-03 (Exchange role and second app role) and ODB-08 (certificate renewal) before building starts; their rows above stay `owner`.

## Phase D (2026-10-13)

Written spec-first in `specs/004-phase-d/` (spec, research). Consolidated at the end of **step D1** on 2026-10-13
by task `T-D-191` from the gate notes `specs/004-phase-d/gate-notes/GD1-0.md`, `GD1-web.md`, `GD1-server-a.md` and
`GD1-server-b.md`. Phase D is delivered in three steps (D1 Exchange layer, distribution lists, contacts and group
members; D2 CSV export and the audit screen; D3 role administration, certificate rotation, hardening); this section
holds what is known after D1, and D2 and D3 add to it. Numbering: Phase D continues the U-register at **U75**; U92 to
U96 came with amendment 1 of the research (T-D-101) and **U97 to U100 were registered by this consolidation** from
findings in the gate notes. Status words as above. **Nothing in step D1 has run against a real Microsoft 365 tenant**,
so no U-claim of Phase D is closed; the owner test is [owner-test-phase-d1.md](owner-test-phase-d1.md).

### Unverified Microsoft claims U75 to U100

Date of the register: 2026-10-13 (Microsoft Learn only). Source of each: `specs/004-phase-d/research-microsoft-d.md`
(summary tables and amendment 1), `spec.md` section 8.3, and the gate notes. Status words as above; **open** here
means "built as designed, with a fallback that fails closed, and waiting for the owner test".

| # | Claim | Where used | Tried | Needed to close | Status (2026-10-13, after D1) |
|---|---|---|---|---|---|
| U75 | `Connect-ExchangeOnline -Certificate` with an in-memory X509Certificate2 works on Linux `pwsh` and writes no key to disk | FR-D-103, `EXCHANGE_KEY_HANDOVER`, worker `connect` | Learn (parameter documented without platform). The real worker script ran on a real PowerShell 7 in the in-memory and the tmpfs paths, **without a tenant**: `Connect-ExchangeOnline` itself was never called | OV-D1 steps 4 to 8, 10 | open. Built: `memory` default, `tmpfs` fallback with a negative control (file mode 0600, removed, tmpfs check). The PEM credential source is built (FD-01: `CreateFromPem` in memory; the tmpfs fallback derives a PKCS#12 from the PEMs) but `CreateFromPem` and `Connect-ExchangeOnline -Certificate` have never run against a real `pwsh` on Linux or a tenant; on Linux the key may have to be exportable if the module re-reads it (OV-D1) |
| U76 | Exchange Recipient Administrator is enough for all Phase D cmdlets | ODB-03, the ten cmdlets of the allow-list | role listed as supported; per-cmdlet not read | OV-D1 steps 5, 6 (and a later narrowing trial) | open. Default stays Exchange Administrator; narrowing only after OV-D1 (ODB-03) |
| U77 | `Exchange.ManageAsAppV2` exists and what it does | wizard (grants it where exposed), Admin API probe | not on Learn; only `Exchange.ManageAsApp` | OV-D1 step 7 | open. The worker does not depend on it |
| U78 | An app-only principal not in `ManagedBy` needs `-BypassSecurityGroupManagerCheck`, satisfied by its Entra role | member writes of lists (P43, P44) | rule stated for user accounts only | OV-D2 steps 14 and 18 | open. Built: the bypass is **always** sent; OV-D2 step 18 runs it without, directly at the worker |
| U79 | Default `-ResultSize` and paging of the cmdlets | every list read | Learn: `Get-MailContact` says "default value is 1000" in the description and "None" in the table; other pages "None" | OV-D5 step 30 | open, low impact: the client always passes `ResultSize` explicitly (a number or `Unlimited`). Partly answered for `Get-MailContact` (GD1-0) |
| U80 | How to detect on-premises-synced groups and contacts, and that contacts reject cloud writes the same way | `synced` and `kind: synced`, read-only states | only a group troubleshooting page | OV-D5 step 33 | open. Built: `IsDirSynced` null-safe (U12); a synchronised object is read-only |
| U81 | Numeric throttling limits for EXO PowerShell app-only | retry budget | none given | OV-D8 (any step) | open. The retry numbers are ours (3 retries, 1 s to 15 s) |
| U82 | Delay between a write and a correct read-back | `readBackPending` | none given for EXO cmdlets | OV-D2 step 15 | open. Built: the list is read once after the write; `readBackPending` and a refresh button |
| U83 | First module version with REST for all cmdlets | the pinned module 3.10.1 | "since 2023", no version | OV-D1 steps 1, 9 | open. Pinned to 3.10.1; closes if every cmdlet of the allow-list answers |
| U84 | Image size, `pwsh` and connect start time, memory of a warm session | ADR-0180, the size ceiling | none given. Measured in CI on 2026-10-13 (amd64, run 38394173673): image 538.2 MB; `/readyz` 200 after 1,184 ms; Exchange worker ping 1,473 ms inside the restricted container; idle RSS 148 MB, peak RSS 173 MB during two concurrent largest uploads | OV-D1 steps 2, 3, 11; the owner decision ODD-10 (closed) | **partly answered**: size and amd64 start measured in CI; the ceiling is 600 MB (ODD-10). **Still open:** arm64, and the memory of a long-running worker |
| U85 | Lifetime and renewal of an app-only session in a long-lived `pwsh` | recycling, restart after a failed call | none given | OV-D1 step 12 | open. Built: the worker is replaced after 500 calls or 3,600 s and restarted once per failed call |
| U86 | `iss` of the proof JWT: app id or object id | certificate rotation, step D3 | the two pages read differ | OV-D3 (step D3) | open, not touched in D1 |
| U87 | One-year cap on certificate validity and the maximum number of `keyCredentials` | rotation, step D3 | not stated | OV-D3 | open, not touched in D1 |
| U88 | Propagation time of a newly added certificate | rotation, step D3 | none given | OV-D3 | open, not touched in D1 |
| U89 | Service-principal cmdlet runs are in the Exchange admin audit log, and how they are identified | the Exchange audit as a second source | page speaks of administrators and users | OV-D4 steps 36, 37 | open. The panel's own audit does not depend on it |
| U90 | Each Phase D write cmdlet is in the logged set | the same | "some are not logged", no list | OV-D4 step 36 | open |
| U91 | The current Laposta CSV import format (columns, separator, encoding) | FR-D-402, step D2 | not read | owner reads Laposta's import help; OV-D6 | open, step D2 |
| U92 | Graph answers `400` for an add of an existing member, an unsupported member type and a not yet replicated group alike | `groups.members.add` (P53) | `group-post-members` lists the three under one status | OV-D2 step 13 (only partly reachable) | open. Built: membership is read first, "already" is decided from the read, a bare `400` after a failed pre-check is `rejected`. The screens pre-check, so the real answer is seen only if a plain add shows "Microsoft refused the change" |
| U93 | Graph's answer for removing an object that is not a member | `groups.members.remove` (P54) | `group-delete-members` is silent | OV-D2 step 13 (only partly reachable) | open. Built: pre-check, and a `404` is "already" |
| U94 | Exchange add of an existing member and remove of a non-member: error or silent success, and the error text | P43, P44 | the cmdlet pages are silent | OV-D2 step 18, directly at the worker | open. Built: membership read first; the answer codes `already_member` and `not_a_member` exist and are handled |
| U95 | Scope of the uniqueness of a mail contact's `-Name` | P49 | "unique name" only | OV-D5 step 27 | open. Built: `-Name` is derived (alias cut to 57 characters, a hyphen, 6 hexadecimal characters) and the alias and the address are checked for duplicates by the panel |
| U96 | Detecting role-assignable groups before a Graph member write | P53, P54 | property not in the Phase C `$select`; not read | OV-D2 step 22 | open. Built: the 403 is mapped after the call to the reason `permission_missing` |
| U97 | The OPATH filter the panel sends: `-like 'prefix*'` on `Name`, `DisplayName`, `Alias`, `PrimarySmtpAddress` for `Get-DistributionGroup` and `Get-Recipient`, `Members -eq '<distinguished name>'` for the lists of a contact, and `-ANR` of `Get-MailContact` matching the **external address** (used for the prefix search and for the duplicate check of a new address or alias) | P40, P41, P47, P49, P50, P51, P52 | cmdlet pages; filterable properties read in part (GD1-server-a finding 8) | OV-D5 steps 26, 29, 30 | open, **registered by this consolidation**. If `-ANR` does not match the external address, a duplicate address is not caught (OV-D5 step 26 shows it). The contact's lists (P52) depend on the `Members` filter |
| U98 | `Get-DistributionGroupMember` rows carry `ExternalDirectoryObjectId` (the Entra id of a user member), so a member is shown with the id Graph and the picker use; and `ManagedBy` is returned as names, not as addresses | P42, P45 (`alreadyMember`), the Managers column | not read (GD1-server-b, last paragraph) | OV-D2 step 16, OV-D5 steps 29, 31 | open, **registered by this consolidation**. Fallback: a member without the id shows its Exchange GUID; managers `null` unless the caller sees every user |
| U99 | The value lists of `SortBy` (`Get-DistributionGroup`) and `RecipientTypeDetails` (`Get-DistributionGroup`, `Get-Recipient`, including `DynamicDistributionGroup`) | P40, P41 (dynamic lists) | not read (GD1-0: identifier patterns instead of enumerations) | OV-D1 step 9, OV-D5 step 30 | open, **registered by this consolidation** |
| U100 | The exception error ids and texts that the worker script maps to the closed error codes (`not_found`, `already_member`, `not_a_member`, `manager_check`, `permission_denied`, `role_pending`, `throttled`, ...) | the worker script, the client | not run against Exchange. Mapping is by fully qualified error id first, text second (GD1-server-a finding 8) | OV-D2 steps 14, 17, 18, 22 (the failures the owner provokes) | open, **registered by this consolidation**. Anything not placed is `internal`, never a guess at success |

Answered by Learn during step D1 (no owner test needed for these halves): U15 for `Set-MailContact` (it has no first
or last name, so names are set on creation only; `Set-Contact` was not read and is not used) and the `Get-MailContact`
default of U79 (see its row). The Phase B rows **U5, U6, U9, U11, U12** stay open and are touched by step D1: U5 and
U6 by U76 and U77, U9 is decided (Ubuntu, ADR-0180) and partly measured in CI (U84: size and amd64 start; arm64 and long-running memory not), U11 is answered in design (dynamic lists
come through `Get-Recipient`, listed read-only, members not listed, FD-05) but the value list is U99, and U12
(`IsDirSynced`) is used null-safe.

### Owner-verified ledger OV-D1 to OV-D9

| ID | What | Closes | Step | Status |
|---|---|---|---|---|
| OV-D1 | Connect and the key on disk | U75, U76, U77, U83, U84, U85, U99 | D1 | open: procedure in [owner-test-phase-d1.md](owner-test-phase-d1.md) sections A to F; needs only the image, not the panel's credential source; the PEM connect line it tests is the one the built credential source sends |
| OV-D2 | Member write without manager rights, with and without the bypass | U78, U82, U92, U93, U94, U96, U98, U100 | D1 | open: section G; credential source built (FD-01); the Exchange half needs the tenant |
| OV-D3 | Certificate rotation | U86, U87, U88 | D3 | open, not in D1 |
| OV-D4 | Exchange audit of the panel's changes | U89, U90 | D1 | open: section I, after OV-D2 and OV-D5, 30 minutes later |
| OV-D5 | Contacts, searches and synced objects | U15 (answered), U79, U80, U95, U97, U98, U99 | D1 | open: section H; needs the credential source |
| OV-D6 | Export import | U91 | D2 | open, not in D1 |
| OV-D7 | Retention and the audit screen | FR-D-453 | D2 | open, not in D1 |
| OV-D8 | Throttling | U81 | any | open: note it if a 429 occurs during OV-D1 to OV-D5 |
| OV-D9 | Break-glass hardening | FR-D-801 | D3 | open, not in D1 |

### Phase D owner decisions

| ID | Decision | Status |
|---|---|---|
| ODB-01 | A: a `pwsh` worker in the one container on an Ubuntu LTS base | closed 2026-10-13 (owner); built in D1 (ADR-0180, ADR-0181) |
| ODB-03 | Exchange Administrator plus both app roles; narrowing only after OV-13 and OV-D1 | closed 2026-10-13 (owner); the wizard grants both (pinned by `setup/exchange-roles-phase-d.test.ts`) |
| ODB-08 | Repair flow in B plus `addKey` self-rotation in D | closed 2026-10-13 (owner); the rotation is step D3 |
| ODD-01 | Group member writes (Graph) are in Phase D | closed 2026-10-13 (owner); built in D1 (P53, P54) |
| ODD-02 | Delivery in three steps D1, D2, D3 with an owner test after each | closed 2026-10-13 (owner) |
| ODD-03 | RBAC administration in full as the brief describes | closed 2026-10-13 (owner); step D3 |
| OV-C2 | The owner has no users with a manager in the test tenant, so OV-C2 (U66, the manager call) cannot be tested now; U66 stays open and the designed "not available" degradation stays the behaviour (ODC-05) | recorded 2026-10-13 |
| ODD-04 to ODD-07 | Audit retention, denial cap, break-glass hardening, export rate and step-up: defaults in `specs/004-phase-d/spec.md` section 10 | defaults; owner agrees at GD0; steps D2 and D3 (the `rateLimit.export` class exists since D1) |
| ODD-08 | Distroless is dropped for an Ubuntu LTS runtime | implemented in D1 (follows ODB-01 A); the **size ceiling** that follows from it is ODD-10 |
| ODD-09 | The format of the certificate the server hands to the worker (new at D1, GD1-server-b): A a PKCS#12 written with a declared direct dependency on `@peculiar/asn1-pfx`; B a hand-written PKCS#12 writer; C **PEM** (`certificate` and a PKCS#8 `privateKey`, built with `X509Certificate2.CreateFromPem`, no password, no PKCS#12) | **decided C by the owner, 2026-10-13; built** (protocol, hand-over, worker script, the one audited accessor `SecretsRuntime.withCertificateMaterial`; GD1-0 Amendment 1) and **not proven against real `pwsh` or a tenant** (U75, OV-D1) (FD-01) |
| ODD-10 | The image size ceiling for the Ubuntu runtime (new at D1): measure the first build and set a ceiling with a margin, or ask for a smaller image | **closed 2026-10-13: 600 MB** (owner decision; CI measured 538.2 MB, amd64, run 38394173673); FD-02 |
| ODD-11 | The bundle budget for the three steps of Phase D (new at D1) | recorded 2026-10-13: owner approved +2,048 B gzip initial JS and (second approval, after the D1 pages measured 272 B over) +3,072 B Brotli first load for D1 to D3 in `approvedGrowth`; budget 247,740 B and 280,572 B; the D1 pages measure 278,796 B first load, so about 1.8 KB is left for D2 and D3 (FD-15) |

### Phase D assumptions and risks (status after step D1)

| ID | Statement | Status |
|---|---|---|
| AD-01 | The tenant uses Exchange Online with cloud-managed distribution groups; synced objects are rare | recorded; synced objects are read-only (EC-D5), OV-D5 step 33 if the tenant has any |
| AD-02 | A list has at most a few thousand members | **partly wrong by design**: the worker line is 1 MiB, so a member read fails as `too_many_rows` at about 2,500 members (FD-07) |
| AD-03 | One `pwsh` worker serving calls serially is fast enough | recorded; one ping answered in 1,473 ms in CI (U84); load and long-running behaviour unmeasured |
| AD-04 | The container may run on an Ubuntu LTS base | recorded (ODB-01 A) |
| AD-05 | The panel's own application may roll its own keys without a new permission | recorded; step D3 (OV-D3) |
| RD-01 | The in-memory certificate path fails on Linux (U75) | open: the tmpfs fallback and its negative control are built; OV-D1 decides. A second risk since the format change: the key must be exportable if the module re-reads it |
| RD-02 | The Ubuntu image is much larger or slower to start (U84) | **measured**: the image is 538.2 MB (CI, amd64), over the old ceiling of 400 MB; owner decision ODD-10 closed 2026-10-13 with 600 MB. Start 1,184 ms to `/readyz`, worker ping 1,473 ms; arm64 not measured |
| RD-03 | The service principal cannot add members without manager rights (U78) | open: bypass always sent; OV-D2 |
| RD-04 | Exchange write is eventually consistent (U82) | open: `readBackPending`, UI note |
| RD-05 | A leak of member lists through logs or the worker | mitigated: `no-pii-in-logs`, canary tests, stderr discarded, audit with ids and field names only; the worker shares the user and file system of the panel (accepted, docs/security.md) |
| RD-06 | Rotation leaves the panel without a usable key | step D3 |
| RD-07 | The entry bundle budget is exceeded by D3 shared code | open: about 1.8 KB first load left; any more needs a new approval (FD-15) |
| RD-08 | The scope of D is too big for the review | recorded: three steps, each with its own gate, pull request and owner test |
| RD-09 | CSV safety differs between Excel, LibreOffice and importers | step D2 |

### Findings at the closing of step D1 (2026-10-13)

Gaps, deviations and decisions found while consolidating the four gate notes and the code. Ids `FD-nn` are new. "Amended"
means the spec or task text was changed to follow the code, which is right; each place says so.

| ID | Finding | Status |
|---|---|---|
| FD-01 | **No credential source for the worker.** The frozen `connect` line wanted a PKCS#12; Phase B stores a sealed PKCS#8 key and the public certificate, Node cannot write PKCS#12, `@peculiar/asn1-pfx` is only transitive, and no method returned the key (by design, FR-B-107). Server part B stopped on purpose. **Decided by the owner on 2026-10-13: option C, PEM. Now built:** the amendment of `packages/shared/src/exchange/protocol.ts` (`connect` carries `certificate: { format: 'pem', certificate, privateKey }`), `key-handover.ts` and `worker-script.ps1`, the one audited accessor `SecretsRuntime.withCertificateMaterial` (`secrets/certificate-material.ts`; the access is a log line, not an audit row) and the real source `integrations/exchange/pwsh/credential-source.ts`, which `start.ts` passes as `ExchangeWorkerSettings.credentials`. The `tmpfs` fallback writes the two PEMs, builds the certificate from them and derives a PKCS#12 for `-CertificateFilePath` (mode 0600, removed in a `finally` block). **NOT proven against a real `pwsh` or a tenant**: `CreateFromPem`, the binding of a string to its `ReadOnlySpan<char>` parameters and `Connect-ExchangeOnline -Certificate` with that object on Linux (U75, OV-D1); `real-pwsh.test.ts` runs only where `pwsh` exists and was not run in the build container. A degraded secrets state, no certificate, no key that opens it or no initial domain answers 503 `exchange_unavailable` (reason `credential_unavailable`); every Graph feature keeps working. The e2e topology can now exercise lists and contacts through the `pwsh` shim (FD-23) | built, not proven (ODD-09) |
| FD-02 | **Image size: measured, ceiling decided.** The build environment had no Docker daemon; CI measured the image at 538.2 MB (amd64, run 38394173673; Phase A measured 193.5 MB) against the old ceiling of 400 MB, and the container smoke test passed 33 of 34 (only the size check failed). On 2026-10-13 the owner decided the ceiling of 600 MB; `LIMITS.imageSizeCeilingMegabytes` and `check_image_size.py` were changed to match. Measured too: `/readyz` 200 after 1,184 ms, worker ping 1,473 ms (module 3.10.1, PowerShell 7.6.6), idle RSS 148 MB, peak RSS 173 MB, `docker stop` exit 0 in 152 ms. Not measured: arm64, long-running memory | closed 2026-10-13 (ODD-10) |
| FD-03 | **The Dockerfile was not built.** The fetch logic (URLs, checksums, unpacking, the `netFramework` removal) ran locally with the real downloads and the checksums matched; the `FROM` digests were resolved over the network. The apt packages of the runtime stage are not pinned by version (a snapshot mirror is the fix, not done). Not run: `docker build`, `pnpm image:smoke`, `check_image_size.py` against an image, the arm64 ping (`continue-on-error`) | open, CI and the owner |
| FD-04 | **Route ids of the Exchange routes are lower case** (`distributionlists.list`): the id is the `action` of denial entries and the audit action grammar has no capital letter (a denial on `distributionLists.list` ended in a 500). Spec 6.11.1 amended, including P46 and P55; the OpenAPI tag stays `distributionLists`; a check compares the spec table with the routes | amended, closed |
| FD-05 | **Dynamic lists show no members.** `Get-DynamicDistributionGroupMember` is not on the frozen allow-list: P42 answers `{ "items": [] }`, the detail has `memberCount: null`, writes and candidates answer 409. The frozen schema has no `state` field (unlike `MembersResponse` of groups), so nothing tells the UI the list is empty because it cannot be read. Fix: a `membersState` field or the cmdlet on the allow-list, both a change to `packages/shared` | open (reported, not done) |
| FD-06 | **`narrow_search` had no catalogue message at the gate.** The 422 for a result larger than `exchange.listBufferMax` (pointer `/q`) is a detail code that the frozen catalogue did not know (`exchange_role_pending` and `exchange_timeout` only), so the UI fell back to the generic validation text. **Fixed:** the messages `distributionLists.error.narrow_search` and `contacts.error.narrow_search` exist in both languages (GD1-0 Amendment 1) | closed |
| FD-07 | **A very large list cannot be read.** The worker answer is cut at 1 MiB of JSON; the client turns a cut list into `too_many_rows` (503) instead of a silent short list, which is about 2,500 members. AD-02 assumed a few thousand. A larger line or a smaller projection is a decision for the owner | owner, open |
| FD-08 | Group writes: a group with hidden membership answers 409 `read_only_object` (the membership cannot be read, so "already" cannot be decided, FR-C-108); the web shows no editor for it | recorded |
| FD-09 | P45 issues no cursor (a cursor in the request is 400 `cursor_invalid`); `alreadyMember` is `null` when the member read failed; users without a mailbox address are not offered (EC-D3) | recorded |
| FD-10 | `validation_failed` carries the code of a custom message (`http/problem.ts`, `faultCode`): before, every `custom` issue became the code `custom`, so the contact validation codes never reached the browser. Phase B and C tests are green | recorded |
| FD-11 | Step-up above a threshold is decided in the handler (`PolicyDenied` has the reason `step_up_required`, audited as a denial like the declared step-up); `directory/step-up.ts` is the one function both write families call | recorded |
| FD-12 | The audit vocabulary of D1 is kept apart from Phase B (`audit/actions-d.ts`: seven actions; `AUDIT_DETAIL_KEYS_D`: nine keys) because the Phase B tests pin 19 actions and 64 keys; no key can hold a name or an address | recorded |
| FD-13 | A module `groups` beside `directory` carries P53 and P54, so the Phase C guard "the directory folder has no way to write" keeps its meaning; `appModules` has 10 entries | recorded |
| FD-14 | P46 (export preview) is a `POST` rated `read` in the spec; the route table allows only `write`, `upload`, `auth`, `setup` for a write method. Decided when the route is built in step D2 (class `write`, or a `GET` with the options in the query) | open, step D2 |
| FD-15 | **Bundle budget.** The D1 contract grew the entry by 941 B gzip JS and 808 B Brotli; the D1 pages then measured 272 B over the first Brotli allowance, because the opening block of `index.html` lists the lazy files of each route. The owner approved the growth twice (ODD-11); `bundle-budget.json` was edited only by recording those approvals. First load measured 278,796 B against 280,572 B | recorded; risk RD-07 |
| FD-16 | `EXCHANGE_KEY_HANDOVER` is the first new variable of D1 (`ENV_VARIABLES` has 26 entries since FD-25 added `EXCHANGE_DEBUG_ERRORTEXT`). It was not in the first spec table; spec 6.1 now lists it (amendment 2). It is in `.env.example`, `docker-compose.yml`, README and `docs/operations.md` | amended, closed |
| FD-17 | Test-first deviations, named in the gate notes: server part B wrote the services and routes first and the tests directly after, per route group (the red state was shown afterwards by running the tests against a tree without `apps/server/src`: 16 files failed, 53 tests failed); `build.mjs` already copied the worker script when its test was written; the self-tests are separate files; the Python checks live in `scripts/`, not `py/` | recorded |
| FD-18 | Console noise on stdout (found by the real-PowerShell run): the module prints names to the console; the script now redirects it and writes protocol lines through its own writer; the Node side ignores non-JSON lines, never logs them, and discards stderr. `real-pwsh.test.ts` runs only where `pwsh` exists (GitHub runners and the image have it); it never talks to a tenant | recorded |
| FD-19 | Lists: `memberCount` is `null` on rows and counted on the detail; `managers` is `null` unless the caller sees every user (`ManagedBy` can name people the caller may not see) | recorded |
| FD-20 | End-to-end and visual: `e2e/tests/pages.spec.ts` and `nav-gating.spec.ts` still describe the two pages as placeholders and need updating; visual baselines are never made in the sandbox; the e2e topology needs the `pwsh` shim (`e2e/support/pwsh-shim/`, now available; FD-23) to exercise lists and contacts; the credential source is built | open, e2e stream and CI |
| FD-21 | The gate note `GD1.md` (T-D-198) and CI for D1 (quality, e2e, image, CodeQL, Trivy) are not done; this step's phase report says "CI results pending" | open |
| FD-22 | Pre-existing: FC-10 (a `basic` actor's loader asks for memberships first) and FC-05 (no way to assign a `basic` role before the role editor of step D3) stay as in Phase C | open, step D3 |
| FD-23 | **The worker command is looked up on the server's PATH** by `resolveCommand()` (`integrations/exchange/runtime.ts`), because the worker is started with an environment without a `PATH`. This is a product change that lets the e2e shim (`e2e/support/pwsh-shim/`, with its README) stand in for PowerShell without a test hook; the image does not contain the shim | recorded |
| FD-24 | **`narrow_search` now has catalogue messages:** `distributionLists.error.narrow_search` and `contacts.error.narrow_search`, in both languages (the detail code maps to the first, `detail-codes.ts`). Closes FD-06 | recorded |
| FD-25 | **Temporary opt-in diagnostics, an explicit exception to FR-D-107 (owner decision 2026-10-13, "Ja, opt-in en gemaskeerd").** On 0.3.66 every Exchange cmdlet answers `internal` with `WriteErrorException` and no hint word, so the cause is unreadable. `EXCHANGE_DEBUG_ERRORTEXT=1` (default off; new variable 26; `0` is the explicit off, anything else stops the start) makes the worker add `detail.text` (masked, 300 characters) and `detail.textLength`, and the server logs them as `errorText` and `errorTextLength`; GD1-0 amendment 5. The masking does not cover display names or tenant names. To be removed from the owner's deployment after the diagnosis; whether the code stays is the owner's call | recorded, temporary |
| FD-26 | **Fixed .NET libraries in the image (2026-10-14).** On 2026-10-13 Microsoft published CVE-2026-84008 (`System.Security.Cryptography.Pkcs`) and CVE-2026-96958, -96959 and -96960 (`System.Security.Cryptography.Xml`), all fixed in 10.0.13. PowerShell 7.6.6 ships Xml and Pkcs 10.0.10 and loads its own copies; the Exchange module 3.10.1 ships Pkcs 10.0.0 (no newer module exists, 3.10.1.1 is the same package). Trivy failed the image run for 0.3.68. `scripts/patch-dotnet-libraries.sh`, called from the Dockerfile stage `pwsh-fetch`, replaces them with the 10.0.13 builds from nuget.org, pinned by SHA-512 (equal to the nuget.org catalog `packageHash`), and patches the two deps.json files; the build fails when PowerShell or the module ships other versions. Tested against a real PowerShell 7.6.6 and the module (import, worker tests); NOT yet against a real tenant. Remove the block when a PowerShell and a module with 10.0.13 or later are pinned | recorded, temporary |

For step D1 the owner is asked for: a view on **large lists** (FD-07), the bundle budget
of D2 and D3 if it is not enough (FD-15), and whether to continue to step D2. The image size ceiling (ODD-10) is decided (600 MB, 2026-10-13). The certificate format (ODD-09) is decided and built; it is not proven against a tenant.

## Nederlands

Dit bestand bundelt de onverifieerde Microsoft-aannames (U1 tot en met U18), de overige onverifieerde
punten (UV1 tot en met UV12), de beslissingen van de eigenaar en de conflicten met de briefing (OD-01 tot
en met OD-17, BC-01 tot en met BC-19), de plan-aannames (PA-01 tot en met PA-18), de risico's (R-01 tot en met
R-17 en PR-01 tot en met PR-18), de afhankelijkheidsregels (DR-1 tot en met DR-5, SA-10, RP-1 tot en met RP-4)
en alle open punten uit de gate-notities van de streams S0 tot en met S7 (in de ids van de chunk-notities,
zoals `s1c-9`), plus de bekende beperkingen van de repository-bewakers (GR-1 tot en met GR-23).

- **Status** is `open` (er is een actie of beslissing nodig), `owner` (wacht op de eigenaar), `recorded`
  (een vaststaande beslissing, aanname of beperking) of `closed` (afgehandeld, met bewijs).
- **Niet geverifieerd** betekent: niet gevonden op Microsoft Learn of niet uitgevoerd in de bouwomgeving.
  Elke rij noemt wat is geprobeerd en wat nodig is om te sluiten. De ASVS-versie (U18) is bewust nog niet
  gekozen. Alles wat alleen op GitHub draait (workflows, signeren, Trivy, arm64) is nog nooit uitgevoerd
  en staat als eerste-run-risico (UV1, UV2, UV5).
- **Belangrijkste beslissingen voor de eigenaar:** OD-06 en OD-07 (Graph-rechten en het Exchange-pad, uiterlijk
  bij de Fase B-poort), OD-03 (preview-modus verwijderen), OD-01 (licentie en publiek of privé), OD-13 (een
  globale grens op auditregels van geweigerde verzoeken) en de ontwerpkeuzes uit de S3-punten (accentkleur,
  zwarte tekst op middentonen, lussende animaties, plaatdrempels voor logo's).
- **Bekende risico's:** de standaardinstantie haalt mobiel geen LCP onder 2,0 s (3,55 tot 3,80 s; de previewinstantie
  wel: 1,06 tot 1,51 s; ADR-0056, OD-15, OD-16) en de eerste lading is 262 KiB tegenover 150 KiB (PR-01); anonieme geweigerde schrijfacties laten het auditlog groeien (R-09); preview-modus is geen
  beveiligingsgrens (R-08).
- De punten van de e2e-, Lighthouse- en mediastream (S9) staan in de sectie 'Stream S9'; de README (T-A-279) is af.
  Nieuw: OD-17 (een expliciete, gedocumenteerde uitzondering in de SQL-lintregel voor `migrate.ts` in plaats van een
  indirecte aanroep) en de drie probleemcodes van de parser (nu 34 codes in het register).
- **Fase B (2026-10-12):** de onverifieerde claims U34 tot en met U50 (U34 en U40 gesloten), het door de eigenaar te
  verifiëren overzicht OV-01 tot en met OV-23, de aannames B-01 tot en met B-26, de plan-beslissingen PB-01 tot en met
  PB-28, de eigenaarsbeslissingen ODB-01 tot en met ODB-18 en de risico's RB-01 tot en met RB-18 en PBR-01 tot en met
  PBR-14. Belangrijkste beslissingen voor de eigenaar: ODB-01 (het Exchange-schrijfpad, vastgelegd in ADR-0102),
  ODB-02 (de vier Graph-rechten) en ODB-17 (break-glass zonder tweede factor). Het ontbrekende auditscherm is Fase D.
- **Fase C (2026-10-12):** de onverifieerde claims U66 tot en met U74 (de rij U51 tot en met U65 stond er al; er is niets hernummerd), de eigenaarsbeslissingen D-C1 tot en met D-C3 (2026-10-13: alleen lezen, 403 voor losse objecten buiten het zicht, geen licentiekolom) en ODC-01 tot en met ODC-05, de aannames AC-01 tot en met AC-05, de plan-beslissingen PC-01 tot en met PC-06 en de risico's RC-01 tot en met RC-06. `GroupMember.ReadWrite.All` is verleend maar ongebruikt in fase C. **Afsluiting fase C (2026-10-13):** U66 tot en met U74 zijn nog open (alleen een echte tenant sluit ze, test OV-C1 tot en met OV-C5); U17 en U48 zijn uitgesteld (licenties niet gebouwd); ODC-01 tot en met ODC-05 zijn standaard ingevoerd en op 2026-10-13 door de eigenaar akkoord bevonden; ODB-11 is gesloten (403). Nieuw: bevindingen FC-01 tot en met FC-17, onder andere dat een `basic`-gebruiker voor fase D niet via de RBAC-API kan worden aangemaakt (daarom kan de eigenaar dat deel van OV-C6 niet doen) en dat de bundel nog maar 52 B (JavaScript) en 18 B (CSS) ruimte heeft.
- **Fase D stap D1 (2026-10-13):** de onverifieerde claims U75 tot en met U96 en, bij het afsluiten van stap D1 erbij gezet, U97 tot en met U100 (allemaal nog open: niets is tegen een echte tenant gedraaid), het door de eigenaar te verifiëren overzicht OV-D1 tot en met OV-D9 (voor D1: OV-D1, OV-D2, OV-D4 en OV-D5), de besluiten ODD-01 tot en met ODD-11, de aannames AD-01 tot en met AD-05, de risico's RD-01 tot en met RD-09 en de bevindingen FD-01 tot en met FD-24. Belangrijkste punten voor de eigenaar: **ODD-10, het plafond voor de grootte van de nieuwe Ubuntu-image** (gesloten op 13-10-2026: CI mat 538,2 MB, de eigenaar besloot tot 600 MB; arm64 en het geheugen van een langlopende worker zijn niet gemeten, U84), **FD-01, de bron van de inloggegevens van de Exchange-worker** (besloten: PEM; gebouwd maar niet bewezen tegen een echte `pwsh` of tenant, U75 en OV-D1) en FD-07 (een lijst met meer dan ongeveer 2.500 leden is niet te lezen). Dynamische lijsten tonen geen leden (FD-05). Nieuw in de bevindingen: de workeropdracht wordt op het PATH van de server opgezocht (`resolveCommand()`, FD-23, waardoor de e2e-shim kan werken) en `narrow_search` heeft nu meldingen (`distributionLists.error.narrow_search` en `contacts.error.narrow_search`, FD-24).
