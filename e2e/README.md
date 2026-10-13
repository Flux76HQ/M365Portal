# @m365portal/e2e

Playwright end-to-end tests against the **production build**, with a fake Microsoft tenant.

```sh
pnpm build   # required first, both builds: the server and the web app must carry the same VERSION
pnpm e2e     # same as: pnpm --filter @m365portal/e2e test
```

`openssl` must be on the PATH (the run makes a throwaway certificate for the three Microsoft hosts).

## Topology (T-B-370, FR-B-708, contract C14)

`support/global-setup.ts` starts three processes and configures one instance; `global-teardown.ts`
stops them and removes the run directory (also after an aborted run).

| Process | Port | Role |
|---|---|---|
| instance A (the default `baseURL`) | `E2E_PORT` (default 4173) | configured once per run by driving the real setup wizard against the fake; trusts one proxy hop, so every browser context has its own `X-Forwarded-For` |
| instance B | `E2E_PORT + 1` | empty data dir: the setup, connection and wizard specs |
| fake tenant, HTTP and control | `E2E_PORT + 2` | Entra, Graph, Exchange and Defender fake (`apps/server/test/fakes/fake-tenant`), two tenants (`a`, `b`); also the CONNECT proxy of the browser |
| fake tenant, TLS | `E2E_PORT + 3` | the 3 Microsoft hosts, tunnelled by the proxy |
| spare | `E2E_PORT + 4` | reserved |

- The built servers start with `--import e2e/support/server-preload.mjs`: an MSW preload routes the
  server's outbound calls to the fake (the no-egress guard still forbids any real egress). It lives in
  the e2e package, so no test code enters a production bundle.
- The browser reaches the fake through `--proxy-server` (a redirect hop is not seen by
  `context.route`); loopback bypasses the proxy; any other host answers 403.
- The browser talks to `http://localhost:<port>`, not `127.0.0.1`. Cookies are shared across the ports.
- A server already answering on a port fails the run on purpose (it would serve a stale build).
- One worker. The browser is the Chromium found through `PLAYWRIGHT_BROWSERS_PATH`; in the agent
  sandbox `playwright install` must not be run (`@playwright/test` 1.56.1 matches the preinstalled one).

## The Exchange worker (Phase D)

Instance A finds a fake `pwsh` first on its `PATH` (`servers.ts`: `makePwshShimDirectory`, one directory per run with a
link `pwsh` to `support/pwsh-shim/pwsh` and a link `node`), so the product's own worker launcher starts the fake Exchange
(`apps/server/test/fakes/fake-tenant/exchange/standin-process.mjs`) and the real credential hand-over is exercised. A spec
chooses its data with `support/exchange-seed.ts` (`seedExchange(seed)`, default `standardSeed()`; `clearExchangeSeed()` at
the end); the seed is re-read on every request, so a new seed is the reseed between tests. The worker is a child of the
server: what it did is read through the panel's API and the audit log (`support/database.ts`: `auditRowsAfter`), not
through the fake tenant's call record. `fixtures/lists.ts` holds the drivers, `fixtures/member-states.ts` visits the
states of `MEMBER_STATES` (`routes.ts`) for axe, keyboard, responsive and visual.

## Principals and `signInAs`

`support/principals.ts` lists the fake users with fixed ids: `owner`, `administrator` (role `admin`),
`operator`, `helpdesk`, `reader`, `norole`, `expired-assignment`, `group-member` (role via a group),
and the disposable `leaver` and `deputy`. Global setup writes one `storageState` per stored principal;
a spec picks one with `test.use({ principal: 'reader' })` (default `owner`; `anonymous` has no
session). `app.signInAs(name)` drives a real sign-in through the fake; dynamic sign-ins are logged out
at teardown (a principal holds at most 10 sessions).

## Files

| File | Role |
|---|---|
| `playwright.config.ts` | projects, the default port, which spec runs in which project (`SPEC_PROJECTS`) |
| `fixtures.ts` | `test` with the automatic **guard** (fails on `securitypolicyviolation`, `pageerror`, `console.error`, a `Permissions-Policy` warning, an unexpected same-origin 4xx/5xx, a request to another origin) and `app`, `principal`, `ownClientAddress`, `fakeOf`, `contextAs`, `allowLockedSetup` |
| `servers.ts` | the processes: state file, `spawnInstance`, `restartServer`, `resetEmptyInstance`, `takeSetupBudget` (B restarts before its setup rate budget runs out) |
| `support/*` | ports, principals, fake tenant server and its typed control (`fake-control.ts`), sign-in, API client, wizard drivers (`wizard-api.ts`, `wizard-page.ts`, `wizard-states.ts`), `cross-site-link.ts`, database helpers |
| `routes.ts` | the client paths and the Phase B states used by axe, keyboard, visual and Lighthouse; `apps/web/test/routes-coverage.test.ts` compares the paths with the router in both directions |
| `axe-waivers.json`, `axe-waivers.ts` | axe waivers: rule, reason, expiry date; an expired or reason-less waiver fails the run |
| `lighthouse/` | `pnpm lighthouse`: the same topology (`topology.ts`), public routes gated, signed-in routes reported |

Projects: `desktop-light`, `desktop-dark` (1440 by 900), `mobile-light`, `mobile-dark` (390 by 844),
`ultrawide` (3440 by 1440), `storage-blocked`, `forced-colors`, `reduced-motion`. A spec that is not
listed in `SPEC_PROJECTS` runs in `desktop-light` only.

Visual baselines of new routes and states are taken from the CI artifact (the `*-actual.png` files of
the first run), never from a sandbox. Run the visual specs with `--update-snapshots=none` locally.

- One test: `pnpm --filter @m365portal/e2e exec playwright test -g "healthz"`.
- A second run next to the first: `E2E_PORT=4400 npx playwright test <spec> --project=desktop-light`.
- Accessibility uses `import { AxeBuilder } from '@axe-core/playwright'`.

## Nederlands

End-to-endtests tegen de productiebuild en een nagebootste Microsoft-tenant. Draai eerst `pnpm build`
(beide builds) en daarna `pnpm e2e`; `openssl` is nodig. Instantie A (`E2E_PORT`, standaard 4173) wordt
per run via de echte setup-wizard ingericht, instantie B (`E2E_PORT + 1`) is leeg, de nagebootste tenant
draait op `E2E_PORT + 2` (TLS op `+3`). Bij het afsluiten worden de processen gestopt en de map
verwijderd. Visuele referentiebeelden voor nieuwe routes komen uit het CI-artefact, niet uit de sandbox. Fase D: instantie A vindt
een nagebootste `pwsh` vooraan op het `PATH` (de nagebootste Exchange-worker); `support/exchange-seed.ts` kiest de data.
