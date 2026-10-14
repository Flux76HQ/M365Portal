# ADR-0182: Exchange is called over the InvokeCommand REST endpoint; PowerShell and the Ubuntu image are gone

Samenvatting (NL): De server roept de tien toegestane Exchange-cmdlets aan via `POST /adminapi/beta/<tenant>/InvokeCommand` met hetzelfde applicatietoken (certificaat, client assertion) als voor Graph. Er is geen `pwsh`-worker, geen PowerShell, geen ExchangeOnlineManagement-module en geen Ubuntu-image meer: de runtime is weer de kleine distroless Node-image. Dit is een bewuste, vastgelegde uitzondering op de regel "geen niet-gedocumenteerde Microsoft-API's" (AGENTS.md sectie 1): het endpoint staat niet op Microsoft Learn. De uitzondering is klein gehouden: één bestand, de gesloten allow-list blijft, en een test bewaakt dat nergens anders `InvokeCommand` of PowerShell opduikt. Het is nog niet tegen een echte tenant geprobeerd.

## Status

Accepted by the owner on 2026-10-14 (request: make the panel create contacts the way `contact-pva` does, so that neither PowerShell nor Ubuntu is needed). It **replaces ADR-0180** (Ubuntu runtime with PowerShell) and **ADR-0181** (worker protocol; its closed ten-cmdlet allow-list stays in force). Requirement: FR-D-102 (the Exchange client calls the ten cmdlets of the allow-list and nothing else); FR-D-103 and FR-D-104 (certificate hand-over to a worker, lazy worker start) no longer apply because there is no worker; FR-D-106 (the image) is met by the distroless image again. Nothing here has run against a real Microsoft 365 tenant (open point U101).

Source: the `helmerznl/contact-pva` repository (`backend/src/lib/exchange.ts`), which creates and removes mail contacts and adds them to a distribution list with this call; ADR-0102 (the Exchange port is an interface); ADR-0018 (the image this restores).

## Context

Distribution list members and mail contacts cannot be written with Microsoft Graph (`docs/permissions.md`). ADR-0180 solved that with a long-lived `pwsh` child process, which made the image Ubuntu 24.04 with PowerShell 7.6, the ExchangeOnlineManagement module and two patched .NET libraries (538 MB, a shell, a package database, three pinned downloads, an unproven in-memory certificate hand-over, U75).

The `ExchangeOnlineManagement` module itself talks to Exchange Online over REST: each cmdlet is a `POST https://outlook.office365.com/adminapi/beta/<tenant>/InvokeCommand` with `{"CmdletInput":{"CmdletName":"...","Parameters":{...}}}` and an application token for `https://outlook.office365.com/.default`. `contact-pva` uses exactly that call from plain Node and runs without PowerShell. Microsoft does not document this endpoint for these cmdlets (it documents only the Admin API endpoints that `AdminApiExchangeClient` uses).

## Decision

1. **One client over REST.** `InvokeExchangeClient` (`apps/server/src/integrations/exchange/invoke-client.ts`) implements the Phase D `ExchangeClient` port. It builds each call with the existing `arguments.ts` (every call passes the closed allow-list of `@m365portal/shared/exchange/allow-list` before a byte is sent), sends it with the shared call engine, and reads the rows with the existing `rows.ts`.
2. **Same token as Graph.** The token is `appTokens.get('exchange')`: the MSAL client-credentials flow with the certificate assertion that the Admin API probe already uses. The roles do not change: `Exchange.ManageAsApp` and an Exchange Administrator (or Recipient Administrator) assignment, which the setup wizard already grants. No secret is added, no private key leaves the secrets module for this purpose.
3. **The exception is one file.** `invoke-client.ts` is the only file allowed to name `InvokeCommand`; no file may name `pwsh` or PowerShell in code. `test/integrations/exchange/no-undocumented.test.ts` enforces both.
4. **Failures are closed words.** `error-class.ts` reduces the answer of Exchange to one code of `EXCHANGE_COMMAND_CODES` with the patterns the worker script used; the text of Exchange never reaches a log or a response (FR-D-107). A 429 waits `Retry-After`; a 5xx or lost connection is repeated once for reads and idempotent writes and never for `New-MailContact` (EC-D1); after that the services see `ExchangeUnavailableError`.
5. **The image is distroless again** (`gcr.io/distroless/nodejs22-debian12:nonroot` by digest). Removed: the `pwsh-fetch` stage, PowerShell, the module, `scripts/patch-dotnet-libraries.sh`, the pwsh checks of `check_image_contents.py` and `check_dockerfile_pins.py`, the arm64 worker ping, the variables `EXCHANGE_KEY_HANDOVER` and `EXCHANGE_DEBUG_ERRORTEXT`, and the `pwsh` shim of the e2e topology (the fake tenant now serves `InvokeCommand`).
6. **The Admin API client stays** as the read-only verification path of the wizard (FR-D-108).

## Consequences

- The runtime is a small Node image without a shell again; the size ceiling can be lowered by the owner (it stays 600 MB until then, `LIMITS.imageSizeCeilingMegabytes`). No Linux packages, no PowerShell telemetry, no .NET CVEs to chase.
- **Risk: the endpoint is undocumented and in `beta`.** Microsoft can change or close it without notice; the Exchange features (lists, contacts) would then answer 503 `exchange_unavailable` while users, groups and the rest keep working. Mitigation: the client is one file behind a port, the allow-list is closed, the smoke test of the wizard probes the Admin API, and `docs/open-points.md` U101 asks for a run against a real tenant before this is relied on.
- **Risk: error words.** The fake tenant words errors like the module's error records did; the real REST layer may word some differently, in which case the call ends as `internal` and is logged with its cmdlet and code (never its text) so the patterns can be extended.
- The `withCertificateMaterial` accessor of the secrets module has no consumer any more. It stays, guarded by `test/secrets/material-scope.test.ts`, until the owner decides to remove it.
- Operators of an existing deployment can delete `EXCHANGE_KEY_HANDOVER` and `EXCHANGE_DEBUG_ERRORTEXT` from their `.env` and Compose file; leaving them is harmless (the server ignores unknown variables, but `EXCHANGE_DEBUG_ERRORTEXT=` set empty no longer stops the start).

## Evidence

- `apps/server/test/exchange/exchange-client-contract.test.ts`: the whole Phase D surface against `InvokeExchangeClient` over the fake `InvokeCommand` route and against `FakeExchangeClient` (one suite, two implementations).
- `apps/server/test/exchange/retry.test.ts`, `no-personal-data-in-logs.test.ts`, `capabilities.test.ts`, `rows.test.ts`; `apps/server/test/integrations/exchange/no-undocumented.test.ts` (the exception is one file).
- Not verified: any call to the real `InvokeCommand` endpoint (U101), `docker build` of the restored image, `pnpm image:smoke`, the end-to-end run of Playwright in CI.
