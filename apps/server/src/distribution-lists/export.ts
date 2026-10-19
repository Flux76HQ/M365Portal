// The CSV export of a distribution list (step D2, T-D-211, T-D-212; FR-D-401 to FR-D-406, EC-D11 to EC-D13,
// ADR 0182) and the preview of its first rows (P46, FR-D-404).
//
//   - ONE function builds the rows, for the download and for the preview (`exportRows`): the preview is the
//     first rows of the same sequence, written by the same `csvRow`, so the two cannot disagree (FR-D-404);
//   - the members are read from Exchange as they are consumed (an async iterable): the rows are written as
//     read and nothing is kept but the set of addresses seen, for the de-duplication. Nothing touches the
//     disk (FR-D-401); a client that stops reading stops the Exchange read (EC-D13);
//   - a member the actor may not see (`toMemberRow`: restricted) is not exported and counts as skipped, the
//     Phase C rule of FR-C-307 applied to a file: a file is no way round the scope. Nested lists are written
//     as one row of type `group`, not expanded;
//   - the first member is read BEFORE the response starts, so a failing Exchange is a 503 problem and not a
//     broken download. A failure after that ends the stream with an error (the browser sees a failed
//     download, never a short file that looks whole);
//   - exactly one `dl.export` entry per export, on every way out (T-D-212): the rows actually sent, the
//     members left out, and the NAMES of the preset, columns and options. Never an address or a name.
//
// A dynamic list has no member list for the panel (FR-D-207): its export is the header alone.
import { CSV_BOM, csvRow } from '@m365portal/shared/csv/write';
import {
  EXPORT_HEADERS,
  resolveExportOptions,
  type ResolvedExportOptions,
} from '@m365portal/shared/csv/presets';
import { LIMITS } from '@m365portal/shared/limits';
import type { ExportOptions, ExportPreviewResponse } from '@m365portal/shared/schemas/export';
import { appendAudit } from '../audit/index.js';
import type { MemberAuditContext } from '../audit/member-writes.js';
import { withTransaction, type DatabaseHandle } from '../db/index.js';
import { ProblemError } from '../http/problem.js';
import type { AuthorizedResource } from '../policy/index.js';
import type {
  ExchangeClient,
  ExchangeDistributionGroup,
  ExchangeRecipient,
} from '../ports/exchange.js';
import { exchangeProblem } from './errors.js';
import { recipientProperty } from './mappers.js';
import { toMemberRow, type MemberVisibility } from './members.js';

export interface ExportDeps {
  readonly exchange: () => ExchangeClient;
  readonly database: () => DatabaseHandle;
  readonly now: () => number;
}

export interface ExportInput {
  readonly authorized: AuthorizedResource<'distributionList'>;
  readonly group: ExchangeDistributionGroup;
  readonly visibility: MemberVisibility;
  readonly options: ExportOptions;
}

export interface ExportStart {
  readonly stream: ReadableStream<Uint8Array>;
  /** `Content-Disposition` for the download. */
  readonly contentDisposition: string;
}

export interface DistributionListExports {
  /** P55: the stream of the file. The first member is read before this returns. */
  start(input: ExportInput & { readonly audit: MemberAuditContext }): Promise<ExportStart>;
  /** P46: the first rows, as the file would start. */
  preview(input: ExportInput): Promise<ExportPreviewResponse>;
}

/** What an export did, for the audit entry: counted as the rows are produced. */
interface Counts {
  rows: number;
  skipped: number;
}

/** The reason a stream that was cut short records. */
const REASON_CANCELLED = 'cancelled';
const REASON_TOO_LARGE = 'export_too_large';
const REASON_FAILED = 'export_failed';

const encoder = new TextEncoder();
/** Rows written between two awaits of the stream: a chunk of the response. */
const ROWS_PER_CHUNK = 500;

interface MemberValues {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly displayName: string;
  readonly type: string;
}

/** The values of one member, or `null` for a member the actor may not see. */
function valuesOf(recipient: ExchangeRecipient, visibility: MemberVisibility): MemberValues | null {
  const row = toMemberRow(recipient, visibility);
  if (row === null || 'restricted' in row) return null;
  const email = row.primarySmtpAddress ?? '';
  // A shared mailbox or a room is counted, not shown by name (`toMemberRow`): it has no name to write.
  const named = row.kind !== 'other';
  return {
    email,
    firstName: named ? (recipientProperty(recipient, 'FirstName') ?? '') : '',
    lastName: named ? (recipientProperty(recipient, 'LastName') ?? '') : '',
    displayName: row.displayName ?? '',
    type: row.kind,
  };
}

/**
 * The rows of the file, as the lists of values of the chosen columns, in the order Exchange gives them.
 * Skips (a member not visible, a missing address when asked, a repeated address when asked) are counted in
 * `counts`. The one source of rows for the download and for the preview.
 */
async function* exportRows(
  members: AsyncIterable<ExchangeRecipient>,
  visibility: MemberVisibility,
  options: ResolvedExportOptions,
  counts: Counts,
): AsyncGenerator<readonly string[]> {
  const seen = new Set<string>();
  for await (const recipient of members) {
    const values = valuesOf(recipient, visibility);
    if (values === null) {
      counts.skipped += 1;
      continue;
    }
    if (values.email === '' && options.skipWithoutEmail) {
      counts.skipped += 1;
      continue;
    }
    if (options.dedupe && values.email !== '') {
      const key = values.email.toLowerCase();
      if (seen.has(key)) {
        counts.skipped += 1;
        continue;
      }
      seen.add(key);
    }
    yield options.columns.map((column) => values[column]);
  }
}

function headerOf(options: ResolvedExportOptions): readonly string[] {
  return options.columns.map((column) => EXPORT_HEADERS[column]);
}

/** The names of the options that are on, for the audit entry: never a value. */
function optionNames(options: ResolvedExportOptions): string[] {
  return [
    options.separator === ';' ? 'semicolon' : 'comma',
    ...(options.bom ? ['bom'] : []),
    ...(options.dedupe ? ['dedupe'] : []),
    ...(options.skipWithoutEmail ? ['skip_without_email'] : []),
  ];
}

const FILE_NAME_FALLBACK = 'distribution-list';

/** A file name of ASCII letters, digits and `._- ` from a list name; never empty, never a path. */
export function exportFileStem(displayName: string | null): string {
  const cleaned = (displayName ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[ ._-]+|[ ._-]+$/g, '')
    .slice(0, 64)
    .trim();
  return cleaned === '' || /^_+$/.test(cleaned) ? FILE_NAME_FALLBACK : cleaned;
}

/** `attachment; filename="<stem>-<date>.csv"`, with the UTF-8 name too when the list name is not ASCII. */
export function exportContentDisposition(displayName: string | null, now: number): string {
  const date = new Date(now).toISOString().slice(0, 10);
  const ascii = `attachment; filename="${exportFileStem(displayName)}-${date}.csv"`;
  if (displayName === null || /^[\x20-\x7e]*$/.test(displayName)) return ascii;
  const utf8 = displayName
    // eslint-disable-next-line no-control-regex -- control characters and path separators are not file names
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '_')
    .trim()
    .slice(0, 64);
  return utf8 === ''
    ? ascii
    : `${ascii}; filename*=UTF-8''${encodeURIComponent(`${utf8}-${date}.csv`)}`;
}

export function createDistributionListExports(deps: ExportDeps): DistributionListExports {
  const iso = (): string => new Date(deps.now()).toISOString();

  function membersOf(group: ExchangeDistributionGroup): AsyncIterable<ExchangeRecipient> {
    if (group.kind === 'dynamic') {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true as const, value: undefined }),
        }),
      };
    }
    return deps.exchange().listDistributionGroupMembers(group.guid);
  }

  /** The one `dl.export` entry; outcome `error` with a reason when the export did not complete. */
  function record(
    group: ExchangeDistributionGroup,
    audit: MemberAuditContext,
    options: ExportOptions,
    resolved: ResolvedExportOptions,
    counts: Counts,
    reason: string | null,
  ): void {
    const ts = iso();
    withTransaction(deps.database(), (tx) => {
      appendAudit(tx, {
        ts,
        actorKind: audit.actorKind,
        actorId: audit.actorId,
        requestId: audit.requestId,
        ...(audit.clientIp === undefined ? {} : { clientIp: audit.clientIp }),
        action: 'dl.export',
        targetType: 'distribution_list',
        targetId: group.guid,
        outcome: reason === null ? 'success' : 'error',
        ...(reason === null ? {} : { reasonCode: reason }),
        detail: {
          rows: counts.rows,
          skipped: counts.skipped,
          preset: options.preset,
          columns: [...resolved.columns],
          options: optionNames(resolved),
        },
      });
    });
  }

  return {
    async start({ authorized, group, visibility, options, audit }) {
      if (authorized.resource.id !== group.guid) {
        throw new TypeError('the capability is for another list');
      }
      const resolved = resolveExportOptions(options);
      const counts: Counts = { rows: 0, skipped: 0 };
      const iterator = exportRows(membersOf(group), visibility, resolved, counts)[
        Symbol.asyncIterator
      ]();

      let finished = false;
      /** Writes the entry once, whatever way the export ends. */
      function finish(reason: string | null): void {
        if (finished) return;
        finished = true;
        record(group, audit, options, resolved, counts, reason);
      }

      // The first member is read now: a failure of Exchange is an answer, not a half download.
      let first: IteratorResult<readonly string[]>;
      try {
        first = await iterator.next();
      } catch (error) {
        const problem = exchangeProblem(error);
        finish(problem.code);
        throw problem;
      }

      let pending: IteratorResult<readonly string[]> | null = first;
      let headerSent = false;

      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (!headerSent) {
              headerSent = true;
              controller.enqueue(
                encoder.encode(
                  `${resolved.bom ? CSV_BOM : ''}${csvRow(headerOf(resolved), resolved.separator)}`,
                ),
              );
              return;
            }
            let chunk = '';
            let written = 0;
            while (written < ROWS_PER_CHUNK) {
              const next = pending ?? (await iterator.next());
              pending = null;
              if (next.done === true) {
                finish(null);
                if (chunk !== '') controller.enqueue(encoder.encode(chunk));
                controller.close();
                return;
              }
              if (counts.rows >= LIMITS.export.rowsMax) {
                finish(REASON_TOO_LARGE);
                controller.error(new Error(REASON_TOO_LARGE));
                return;
              }
              counts.rows += 1;
              written += 1;
              chunk += csvRow(next.value, resolved.separator);
            }
            controller.enqueue(encoder.encode(chunk));
          } catch (error) {
            finish(error instanceof ProblemError ? error.code : REASON_FAILED);
            controller.error(error);
          }
        },
        async cancel() {
          // The client stopped reading: the rows sent so far are the entry; the Exchange read is dropped.
          finish(REASON_CANCELLED);
          await iterator.return(undefined);
        },
      });

      return {
        stream,
        contentDisposition: exportContentDisposition(group.displayName, deps.now()),
      };
    },

    async preview({ authorized, group, visibility, options }) {
      if (authorized.resource.id !== group.guid) {
        throw new TypeError('the capability is for another list');
      }
      const resolved = resolveExportOptions(options);
      const counts: Counts = { rows: 0, skipped: 0 };
      const iterator = exportRows(membersOf(group), visibility, resolved, counts)[
        Symbol.asyncIterator
      ]();
      let csv = csvRow(headerOf(resolved), resolved.separator);
      let rows = 0;
      let more = false;
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) break;
          if (rows >= LIMITS.export.previewRows) {
            more = true;
            break;
          }
          csv += csvRow(next.value, resolved.separator);
          rows += 1;
        }
      } catch (error) {
        throw exchangeProblem(error);
      } finally {
        await iterator.return(undefined);
      }
      return { csv, rows, skipped: counts.skipped, more };
    },
  };
}
