# ADR-0035: SVG sanitiser: strict decode, DOCTYPE refusal, allowlist rebuild, expansion check, rasterise (PD-09)

Samenvatting (NL): SVG-sanering: strikte decodering, DOCTYPE/ENTITY geweigerd, herbouw uit een allowlist, expansiecontrole en altijd rasteren.

## Status

Plan

Source: plan section 6.2, row PD-09.

## Context

V-01: `saxes` does not expand entities or enforce encodings. Probe section 4: sharp does not load external references and rejects entity bombs. Fewer features mean less renderer surface.

## Decision

Strict UTF-8 decode (BOM, UTF-16 and a non-UTF-8 `encoding` declaration refused); a case-insensitive pre-scan that refuses `<!DOCTYPE` and `<!ENTITY` anywhere (comments and CDATA included); `saxes` 6.0.0 with `xmlns: true` and throwing handlers for element count, depth and size; a rebuild from element and attribute allowlists with per-attribute value validators; a reference-cycle and expansion check (a cycle, or more than 100,000 expanded element instances, is `svg_too_complex`); then render with sharp at the target size derived from `viewBox` (else `width` and `height`, else `svg_not_wellformed`). The SVG is never stored or served: only the PNG derivative is. The Phase A allowlist excludes `filter`, `pattern`, `image`, `a`, `switch`, `style`, `text`, `foreignObject`, animation and all `fe*` elements and is published in `docs/security.md`.

## Consequences

Logos that use blur filters lose them with warning `svg_content_removed` (category `filter`). Widening the allowlist is an owner request.

## Evidence

- Plan 6.2 row PD-09; V-01; plan 8.6.
- `G2.md` section 4: `SVG_ALLOWLIST` compared with plan 8.6 by a script that parses the plan: 19 elements in both, none missing, none extra. Corpus 44 of 44 over HTTP, and against the container (`G6.md`).
- `chunk-s2c.md`: mutation pass on the SVG modules, 17 of 19 mutants killed, survivors closed with tests.
