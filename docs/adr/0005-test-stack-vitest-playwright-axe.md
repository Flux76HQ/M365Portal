# ADR-0005: Vitest, Playwright, axe and Lighthouse, with baselines from the sandbox Chromium (D5)

Samenvatting (NL): Vitest, Playwright, axe en Lighthouse; visuele baselines komen uit de Chromium van de bouwomgeving.

## Status

Accepted

Source: plan section 6.1, row D5.

## Context

The product needs unit, integration, browser, accessibility and performance checks that a pull request can run.

## Decision

Vitest for units and integration, Playwright for end-to-end, axe for accessibility, Lighthouse for performance. The probe's traps are rules: dark mode is toggled through `data-theme` and the test asserts the computed background (P19); `toHaveScreenshot` uses `threshold: 0` (P20); the test asserts that the self-hosted font loaded (P21).

## Consequences

Baselines made in this sandbox may differ from those made on a GitHub runner (R-01); the `visual-baselines` workflow exists to refresh them there. Only Chromium 141 was used so far.

## Evidence

- Plan 6.1 row D5; probe P3 and P18 to P21.
- `G5.md`: 50 checks in real Chromium 141 against the production build and the real server, axe 0 violations in 15 states.
- `G7.md`: no workflow has run on GitHub; the cross-environment risk R-01 is open.
