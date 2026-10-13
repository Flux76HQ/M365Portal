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
| U9 | The Exchange module on Debian, Alpine or distroless | Dockerfile if a PowerShell worker is chosen | Learn lists Ubuntu LTS only | Owner decision OD-07; test the chosen base |
| U10 | Uniqueness of `ExternalEmailAddress` is enforced by Exchange | Contacts validation | The `New-MailContact` page is silent | App-side uniqueness check (`Get-MailContact -Filter`) |
| U11 | Cmdlet and parameters for listing dynamic distribution groups | Distribution-list screen | Only the Admin API endpoint `DynamicDistributionGroupMember` is documented; the cmdlet page was not read | Read the `Get-DynamicDistributionGroup` page when Phase D starts |
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
| OD-07 | Exchange execution path and runtime base: PowerShell worker (documented, Ubuntu-based runtime), Admin API Preview for reads only, or the undocumented `InvokeCommand` route | None can be assumed: ask early | Phase B gate at the latest | owner |
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
| BC-10 | Distroless runtime cannot hold PowerShell | Distroless in Phase A; possible base change recorded in an ADR. owner (OD-07) |
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
| s6a-3 | The size ceiling stays 400 MB (193.5 MB measured, VERSION 0.2.31) | owner: recalibrate after the first CI build |
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

Written spec-first in `specs/004-phase-d/` (spec, research). No Phase D code exists at this point.

### Unverified Microsoft claims U75 to U91

Date of the register: 2026-10-13 (Microsoft Learn only). Source of each: `specs/004-phase-d/research-microsoft-d.md`, summary table. Status words as above.

| # | Claim | Where used | Tried | Needed to close | Status (2026-10-13) |
|---|---|---|---|---|---|
| U75 | `Connect-ExchangeOnline -Certificate` with an in-memory X509Certificate2 works on Linux `pwsh` and writes no key to disk | see spec 004 section 8.4 | parameter documented without platform; Linux not stated for it | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U76 | Exchange Recipient Administrator is enough for all Phase D cmdlets | see spec 004 section 8.4 | role listed as supported; per-cmdlet not read | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U77 | `Exchange.ManageAsAppV2` exists and what it does | see spec 004 section 8.4 | not on Learn; only `Exchange.ManageAsApp` | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U78 | An app-only principal not in `ManagedBy` needs `-BypassSecurityGroupManagerCheck`, satisfied by its Entra role | see spec 004 section 8.4 | rule stated for user accounts only | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U79 | Default `-ResultSize` and paging of the cmdlets | see spec 004 section 8.4 | pages show "None"; 1,000 only for the Admin API | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U80 | How to detect on-premises-synced groups and contacts, and that contacts reject cloud writes the same way | see spec 004 section 8.4 | only a group troubleshooting page | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U81 | Numeric throttling limits for EXO PowerShell app-only | see spec 004 section 8.4 | none given | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U82 | Delay between a write and a correct read-back | see spec 004 section 8.4 | none given for EXO cmdlets | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U83 | First module version with REST for all cmdlets | see spec 004 section 8.4 | "since 2023", no version | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U84 | Image size, `pwsh` and connect start time, memory of a warm session | see spec 004 section 8.4 | none given | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U85 | Lifetime and renewal of an app-only session in a long-lived `pwsh` | see spec 004 section 8.4 | none given | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U86 | `iss` of the proof JWT: app id or object id | see spec 004 section 8.4 | the two pages read differ | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U87 | One-year cap on certificate validity and the maximum number of `keyCredentials` | see spec 004 section 8.4 | not stated; only the optional policy (180 days recommended) | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U88 | Propagation time of a newly added certificate | see spec 004 section 8.4 | none given | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U89 | Service-principal cmdlet runs are in the Exchange admin audit log, and how they are identified | see spec 004 section 8.4 | page speaks of administrators and users | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U90 | Each Phase D write cmdlet is in the logged set | see spec 004 section 8.4 | "some are not logged", no list | OV-D1 to OV-D4 (spec 004 section 8.4) | open |
| U91 | The current Laposta CSV import format (columns, separator, encoding) | FR-D-402 | not read | owner reads Laposta's import help; OV-D6 | open |

### Phase D owner decisions

| ID | Decision | Status |
|---|---|---|
| ODB-01 | A: a `pwsh` worker in the one container on an Ubuntu LTS base | closed 2026-10-13 (owner) |
| ODB-03 | Exchange Administrator plus both app roles; narrowing only after OV-13 and OV-D1 | closed 2026-10-13 (owner) |
| ODB-08 | Repair flow in B plus `addKey` self-rotation in D | closed 2026-10-13 (owner) |
| ODD-01 | Group member writes (Graph) are in Phase D | closed 2026-10-13 (owner) |
| ODD-02 | Delivery in three steps D1, D2, D3 with an owner test after each | closed 2026-10-13 (owner) |
| ODD-03 | RBAC administration in full as the brief describes | closed 2026-10-13 (owner) |
| ODD-04 to ODD-08 | Audit retention, denial cap, break-glass hardening, export rate, Ubuntu runtime: defaults in `specs/004-phase-d/spec.md` section 10 | defaults; owner agrees at GD0 |

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
