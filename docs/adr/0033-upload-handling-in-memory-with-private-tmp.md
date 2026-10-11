# ADR-0033: Uploads parsed in memory, temporary files on the data volume (PD-07)

Samenvatting (NL): Uploads worden in het geheugen verwerkt; tijdelijke bestanden staan op het datavolume, niet in /tmp.

## Status

Plan

Source: plan section 6.2, row PD-07.

## Context

V-06: a rename from a tmpfs `/tmp` to the volume would fail with `EXDEV`. The client's file name and media type are untrusted.

## Decision

Multipart is parsed in memory after `bodyLimit` (2,162,688 bytes), exactly one part named `file`. The client file name and the part's media type are never read (a source-scan test fails on `.name` or `.type` of the uploaded part). Temporary files for atomic writes live in `${DATA_DIR}/branding/.tmp/` and are removed at start and hourly. A file of 2,097,153 bytes fits inside the request envelope, so it is refused with 413 after the part is parsed; the request cap cuts off a streaming or chunked body (SA-20, SA-04 amends FR-A-084 and FR-A-089).

## Consequences

Memory use is bounded by the request cap and the image concurrency (ADR-0034).

## Evidence

- Plan 6.2 row PD-07; V-06.
- `G2.md`: `.tmp` is swept at start (`module.test.ts`); the corpus leaves nothing in the process `TMPDIR` or `branding/.tmp` (`persistence.test.ts` and the corpus over HTTP).
- `G6.md`: with a read-only root filesystem and a tmpfs `/tmp` the container writes only to `/data` and `/tmp`.
