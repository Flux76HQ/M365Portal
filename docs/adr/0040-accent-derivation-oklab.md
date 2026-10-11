# ADR-0040: Accent derivation by an OKLab lightness search per theme (PD-14)

Samenvatting (NL): Accentafleiding via een OKLab-helderheidszoektocht per thema, zodat de contrasteisen altijd gelden.

## Status

Plan

Source: plan section 6.2, row PD-14.

## Context

V-11: an organisation may choose any accent. Text, focus rings and component edges must still meet WCAG 2.2 AA.

## Decision

A bisection followed by a verified walk over OKLab lightness per theme against four opaque surfaces. White text on the accent when it clears 4.5:1, else black. Hover and active are OKLab lightness steps of 0.045 and 0.09 in the contrast-increasing direction, with a fallback that searches up to 1.0. Colours that fail 3:1 in a theme are darkened (light) or lightened (dark) minimally. The default accent is `#0078d4`.

## Consequences

Mid-tone brands get dark text; the owner may prefer a "darken for white text" mode (open point). `normalizeAccent` throws `InvalidAccentError`; `tryNormalizeAccent` is the non-throwing sibling.

## Evidence

- Plan 6.2 row PD-14; V-11; plan 10.4 and appendix B.
- `G3a.md` section 5: the implementation compared with the reference prototype on 34,096 colours with 0 differences; the fallback range was never needed in that comparison.
