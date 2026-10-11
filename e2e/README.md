# @m365portal/e2e

Playwright end-to-end tests against the **production build**.

```sh
pnpm build   # required first: Playwright builds nothing, it starts apps/server/dist/index.js
pnpm e2e     # same as: pnpm --filter @m365portal/e2e test
```

## Topology (FR-A-157, contract C14)

`global-setup.ts` starts two instances of the built server, each with a fresh temporary `DATA_DIR`
and `PUBLIC_BASE_URL=http://localhost:<port>`; `global-teardown.ts` stops them and removes the
directories (also after an aborted run).

| Instance | Port | Mode |
|---|---|---|
| `preview` (the default `baseURL`) | `E2E_PORT` (default 4173) | `PREVIEW_MODE=true`, `SHOWCASE=true` |
| `anonymous` | `E2E_PORT + 1` | neither |

- `E2E_PORT` is 1024-65534; for example `E2E_PORT=4180 pnpm e2e` when 4173 or 4174 is taken. A server
  already answering on either port fails the run on purpose (it would serve a stale build).
- The browser talks to `http://localhost:<port>`, not `127.0.0.1`: writes are only accepted from
  `PUBLIC_BASE_URL`, and preview mode needs a loopback `Host`.
- Without a prior `pnpm build` the run stops with a message that says so.
- One worker: the instances, the stop/start helper and the service worker tests share state.
- The browser is the Chromium found through `PLAYWRIGHT_BROWSERS_PATH`. In the agent sandbox it is
  preinstalled and `playwright install` must not be run there: `@playwright/test` is pinned to 1.56.1
  because its expected Chromium revision (1194) is the preinstalled one. In CI the `e2e` job installs
  the matching browser itself.

## Files

| File | Role |
|---|---|
| `playwright.config.ts` | projects, the default port, which spec runs in which project (`SPEC_PROJECTS`) |
| `fixtures.ts` | `test` with the automatic **guard** (fails on `securitypolicyviolation`, `pageerror`, `console.error`, a `Permissions-Policy` warning, an unexpected same-origin 4xx/5xx, a request to another origin) and `app` (open a page, wait for the shell, assert the theme background and the loaded Inter font) |
| `servers.ts` | the instances: `app.servers.stop/start/restart(instance)` on the same `DATA_DIR` (offline tests stop the server; they never use `context.setOffline`) |
| `routes.ts` | the client paths used by axe, visual regression and Lighthouse; `apps/web/test/routes-coverage.test.ts` compares it with the router |
| `axe-waivers.json`, `axe-waivers.ts` | axe waivers: rule, reason, expiry date; an expired or reason-less waiver fails the run |

Projects: `desktop-light`, `desktop-dark` (1440 by 900), `mobile-light`, `mobile-dark` (390 by 844),
`ultrawide` (3440 by 1440), `storage-blocked`, `forced-colors`, `reduced-motion`. A spec that is not
listed in `SPEC_PROJECTS` runs in `desktop-light` only. Dark mode is the stored theme choice, and the
fixture asserts the computed background (stack-probe P19).

A spec that provokes a violation on purpose reads it with `guard.take('violation')`; a spec that expects
a 4xx declares it with `guard.allowResponse({ status: 404, url: '/api/...' })`.

- One test: `pnpm --filter @m365portal/e2e exec playwright test -g "healthz"`.
- Accessibility uses `import { AxeBuilder } from '@axe-core/playwright'` (the default import does not
  type-check under NodeNext).

## Nederlands

End-to-endtests tegen de productiebuild. Draai eerst `pnpm build` en daarna `pnpm e2e`. Twee instanties
van de server starten met elk een tijdelijke `DATA_DIR`: `preview` op `E2E_PORT` (standaard 4173, met
voorbeeldmodus en showcase) en `anonymous` op `E2E_PORT + 1`. Bij het afsluiten worden ze gestopt en
de mappen verwijderd. Zonder `pnpm build` stopt de configuratie met een melding die dat zegt.
