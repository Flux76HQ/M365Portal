# ADR-0015: pino JSON logs with deep redaction (D15)

Samenvatting (NL): pino-logs in JSON met diepe redactie en zonder persoonsgegevens.

## Status

Accepted

Source: plan section 6.1, row D15.

## Context

Logs must carry a request id and never a secret or personal data. OpenTelemetry is deferred to Phase D.

## Decision

pino 10.4.0, JSON lines, key-name redaction as a deep function (pino paths cannot match "any key containing token"), no PII, a request id. Stack frames are logged without the message line so that a thrown secret cannot reach the log.

## Consequences

Configuration errors name the variable and never its value. The client address is personal data and is documented as such (`docs/security.md`).

## Evidence

- Plan 6.1 row D15; probe: pino `redact` with `censor` verified.
- `apps/server/test/logging.test.ts` and `no-leak.test.ts` exist; `G1.md` section 2 (an invalid configuration exits 1 naming the variable and never the value).
