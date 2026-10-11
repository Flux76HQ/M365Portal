# ADR-0029: Toasts on Radix Toast; sonner dropped; a patch for Radix Select (PD-03)

Samenvatting (NL): Toasts op Radix Toast, sonner is vervallen; Radix Select krijgt een patch voor Trusted Types.

## Status

Plan

Source: plan section 6.2, row PD-03.

## Context

`sonner` injects a `<style>` without a nonce (P16) and its region is always polite. Radix Toast distinguishes foreground (assertive) from background (polite) and pauses on hover and focus. The Radix documentation was not re-read; the component test asserts the behaviour.

## Decision

Toasts are built on Radix Toast and `sonner` and its patch are dropped. The announcer is `aria-live="polite"` with a foreground assertive one for errors; an error never dismisses itself. A later finding added a second patch: `@radix-ui/react-select@2.3.8` (through `radix-ui@1.7.0`) renders its scrollbar-hiding rule as an inline `<style dangerouslySetInnerHTML>`, a TrustedHTML sink under `require-trusted-types-for 'script'`, so every Select crashed into the error boundary. `patches/@radix-ui__react-select@2.3.8.patch` removes the element and the same rule lives in `apps/web/src/styles/app.css`.

## Consequences

One dependency and one patch fewer than planned, one patch added. Radix's scroll lock still injects a `<style>` that needs the nonce set before the first render (chunk-s3b OP-2). A Radix upgrade must be re-checked by `csp-sinks.test.ts`. Fallback for toasts: `sonner` 2.0.8 plus a verified 2-line patch.

## Evidence

- Plan 6.2 row PD-03; P16, V-13.
- `chunk-s3b.md` (T-A-127): toast tests with an injected clock; no `sonner` in `apps/web` (only a test file mentions the name).
- `chunk-s3fix.md`: `csp-sinks.test.ts` (3 tests, red first, with a negative fixture); in real Chromium 141, all 5 enabled comboboxes on `/design` opened with the keyboard with 0 `securitypolicyviolation`; the pre-patch build crashed on the same harness.
