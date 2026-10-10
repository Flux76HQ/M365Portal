# @m365portal/e2e

Playwright end-to-end tests against the **production build**.

```sh
pnpm build   # required first: Playwright builds nothing, it starts apps/server/dist/index.js
pnpm e2e     # same as: pnpm --filter @m365portal/e2e test
```

- The server is started by `playwright.config.ts` on port **4173** (`HOST=127.0.0.1`) with a fresh
  temporary `DATA_DIR`, `SHOWCASE=true` and `PREVIEW_MODE=true`. A server already running on that
  port fails the run on purpose. Set `E2E_PORT` (1024-65535, default 4173) to use another port, for
  example `E2E_PORT=4180 pnpm e2e` when 4173 is taken; the base URL and `PUBLIC_BASE_URL` follow it.
- The temporary `DATA_DIR` is removed again when the Playwright process exits (an `exit` hook in
  `playwright.config.ts`), also after an aborted run or `playwright test --list`. Only a `kill -9`
  can leave a `m365portal-e2e-*` directory behind in the system temp folder.
- Without a prior `pnpm build` the config stops with `apps/server/dist/index.js is missing: run pnpm
  build first`.
- The browser is the Chromium found through `PLAYWRIGHT_BROWSERS_PATH`. In the agent sandbox it is
  preinstalled and `playwright install` must not be run there (nothing can be downloaded):
  `@playwright/test` is pinned to 1.56.1 because that is the version whose expected Chromium
  revision (1194) is the preinstalled one. In CI the `e2e` job installs the matching browser itself
  with `playwright install --with-deps chromium` (plan, section 12.3).
- One test: `pnpm --filter @m365portal/e2e exec playwright test -g "healthz"`.
- The accessibility tests of the later streams add `@axe-core/playwright@4.13.0` (the pin of
  `specs/001-m365portal/stack-probe.md`) together with their first test: it is not declared before
  it is used. Import it as `import { AxeBuilder } from '@axe-core/playwright'` (the default import
  does not type-check under NodeNext).

## Nederlands

End-to-endtests tegen de productiebuild. Draai eerst `pnpm build` en daarna `pnpm e2e`; de server
start op poort 4173 (of `E2E_PORT`) met een tijdelijke `DATA_DIR`, die bij het afsluiten weer wordt
verwijderd. Zonder `pnpm build` stopt de configuratie met een melding die dat zegt.
