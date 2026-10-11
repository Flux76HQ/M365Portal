# ADR-0041: HTML shell filled in one pass, never cached once filled (PD-15)

Samenvatting (NL): De HTML-shell wordt in één doorloop gevuld met een replacer-functie en nooit gecachet.

## Status

Plan

Source: plan section 6.2, row PD-15.

## Context

An organisation name equal to a placeholder must stay inert. Two sequential `replaceAll` calls would rescan inserted values, and a replacement string would interpret `$&`, `` $` `` and `$'` inside a name. Caching a filled shell would reuse a nonce, and compressing a response that carries a secret is a BREACH shape.

## Decision

The Vite `index.html` is a template with `__M365_*__` placeholders replaced in one regex pass with a replacer function. Initial branding and `me` are embedded as a `type="application/json"` data block with `<`, U+2028 and U+2029 escaped, so the first render needs no API round trip. The boot script and the critical CSS are inlined with the nonce. HTML is compressed per request (Brotli quality 4, gzip fallback); `/api/v1/csrf` and images are never compressed. Only the template and the token CSS per branding revision are cached, never a filled shell; filled HTML is `no-store`.

## Consequences

A reverse proxy in front must never cache the HTML shell (documented in `docs/operations.md`).

## Evidence

- Plan 6.2 row PD-15; PR-17.
- `apps/server/test/branding/html-shell.test.ts` (names equal to `__M365_NONCE__`, `$&` and `$'`) and `module.test.ts` exist; `G2.md` section 3 lists `Cache-Control: no-store` on the shell.
- `G5.md`: in real Chromium the organisation name `Acme <b>Corp</b>` is escaped in the page title.
