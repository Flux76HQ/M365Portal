# ADR-0184: CSV formula safety is a leading space, and the writer is ours

Samenvatting (NL): De CSV-export van een distributielijst wordt in Excel geopend en door nieuwsbriefdiensten ingelezen. Een naam of adres uit Exchange die met `=`, `+`, `-`, `@`, een tab of een regeleinde begint, zou als formule gelezen kunnen worden. Zo'n veld krijgt daarom één spatie ervoor (geen apostrof: die blijft in een bestand dat wordt geopend als tekst staan en komt in de importeur terecht). Verder geldt RFC 4180: aanhalingstekens waar nodig, regels eindigen op CRLF. De schrijver is zelf geschreven (`packages/shared/src/csv/write.ts`) omdat de regel van ons is en een bibliotheek gewicht aan de image toevoegt. Het Laposta-voorbeeld blijft "controleer de importeur" tot hun huidige importformaat is gelezen (U91).

## Status

Accepted on 2026-10-19 with step D2 (the CSV export of a distribution list, P46 and P55). Requirement: FR-D-402, FR-D-403, EC-D12. The spec left the exact approach "to the plan, fixed by the test"; this is that choice.

Source: OWASP "CSV Injection"; RFC 4180; `specs/004-phase-d/spec.md` 6.5.

## Context

A member's display name, first name or address is text from Exchange. Opened in a spreadsheet, a field that starts with `=`, `+`, `-`, `@`, a tab or a carriage return can be read as a formula (CSV injection). The file is also imported by a newsletter service, so what is written must be what the importer should store.

## Decision

- A field that starts with one of those six characters gets **one space in front of it**. The rule applies to every field and to the header, before quoting.
- A field is quoted (RFC 4180) when it holds the separator, a quote, a line break, or starts or ends with a space; a quote inside is doubled. Rows end with CRLF.
- The writer is hand-written: the rule is ours, and a library would add weight to an image that has a budget.

The usual advice is a leading apostrophe. In a file that is opened (not typed) Excel shows the apostrophe as part of the text and an importer stores it. A leading space makes the cell text in Excel, LibreOffice and Google Sheets, and importers trim it.

## Consequences

- An address that starts with `+` or `-` (legal, rare) is exported with a space in front. The price of one rule without exceptions: a "looks like a valid address" check on the field would be where an attack gets through.
- The responses of the export are `text/csv`, which `compress.ts` no longer reads whole: the export is streamed so that memory stays bounded (FR-D-406).
- The Laposta preset is labelled "check the importer" until U91 is closed (OV-D6).

## Evidence

`packages/shared/test/csv.property.test.ts` parses the output with an independent RFC 4180 parser and checks that the parsed value is the original with the documented space, for values built from the leading characters, quotes, separators and line breaks. `apps/server/test/distribution-lists/export.test.ts` exports a member named `=HYPERLINK(...)`.
