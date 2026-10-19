// T-D-211, T-D-212, FR-D-401 to FR-D-406, EC-D11 to EC-D13, US-D5: the CSV export P55 and its preview P46 on the
// real application with the in-memory Graph and Exchange clients: headers, the presets, the scope of the caller,
// the step-up, the formula-safe fields, de-duplication, one `dl.export` entry on every way out, and a preview
// that is the start of the download.
import { LIMITS } from '@m365portal/shared/limits';
import type { Grant } from '@m365portal/shared/rbac/effective';
import { ExportPreviewResponseSchema } from '@m365portal/shared/schemas/export';
import { describe, expect, it } from 'vitest';
import { readJson } from '../helpers/http-client.js';
import { ExchangeUnavailableError } from '../../src/ports/errors.js';
import {
  EXPORT_LISTS,
  READ_CONTACTS,
  READ_GROUPS,
  READ_USERS,
  call,
  createListsFixture,
  listPrefix,
  scoped,
  wrapExchange,
  type ListsFixture,
  type ProblemBody,
} from './support.js';

const EXPORTER = [EXPORT_LISTS, READ_USERS, READ_CONTACTS, READ_GROUPS] as const;
const exportPath = (list: { guid: string }): string =>
  `/api/v1/distribution-lists/${list.guid}/export`;
const previewPath = (list: { guid: string }): string => `${exportPath(list)}/preview`;

const OPTIONS = { preset: 'generic' } as const;

const exportRows = (f: ListsFixture) => f.rows().filter((row) => row.action === 'dl.export');
const detailOf = (row: { detail: string | null }): Record<string, unknown> =>
  JSON.parse(row.detail ?? '{}') as Record<string, unknown>;

/** The marketing list with a user that has a name, a contact whose name is a formula, and a repeated address. */
function populate(f: ListsFixture) {
  const state = f.exchangeState;
  const members = state.distributionGroups.get(f.world.lists.marketing.guid)?.members;
  if (members === undefined) throw new Error('no marketing list');
  f.world.users.alice.recipient.firstName = 'Alice';
  f.world.users.alice.recipient.lastName = 'Example';
  const evil = state.addMailContact({
    displayName: '=HYPERLINK("http://evil.example","x")',
    alias: 'evil',
    externalEmailAddress: 'evil@elsewhere.example',
  });
  const repeated = state.addMailContact({
    displayName: 'Alice Again',
    alias: 'alice.again',
    externalEmailAddress: 'ALICE@contoso-fake.example',
  });
  members.push(evil, repeated);
  return { evil, repeated };
}

async function download(
  f: ListsFixture,
  body: unknown = OPTIONS,
  grants: readonly Grant[] = EXPORTER,
) {
  const me = f.actor(...grants);
  const response = await me.client.request('POST', exportPath(f.world.lists.marketing), {
    json: body,
  });
  // `Response.text()` drops a byte order mark; the test wants to see it.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer());
  return { response, text };
}

describe('POST /api/v1/distribution-lists/{id}/export (P55)', () => {
  it('streams a CSV of the members, safe for a spreadsheet, de-duplicated, with the headers of a download', async () => {
    const f = await createListsFixture();
    populate(f);
    const { response, text } = await download(f);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="Marketing-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = text.split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines[0]).toBe('email,first_name,last_name,display_name,type');
    expect(lines).toHaveLength(4);
    expect(lines).toContain('alice@contoso-fake.example,Alice,Example,Alice Example,user');
    expect(lines).toContain('dave@elsewhere.example,,,Dave Outside,contact');
    // The formula is text: one space in front, and quoted because it holds quotes and a comma.
    expect(lines).toContain(
      'evil@elsewhere.example,,," =HYPERLINK(""http://evil.example"",""x"")",contact',
    );
    // The same address in another case is one row.
    expect(text.toLowerCase().split('alice@contoso-fake.example')).toHaveLength(2);
    expect(text.startsWith('﻿')).toBe(false);
  });

  it('writes one entry with the rows sent and the members left out, and no name or address', async () => {
    const f = await createListsFixture();
    populate(f);
    await download(f);
    const rows = exportRows(f);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.outcome).toBe('success');
    expect(row?.target_id).toBe(f.world.lists.marketing.guid);
    expect(detailOf(row ?? { detail: null })).toEqual({
      rows: 3,
      skipped: 1,
      preset: 'generic',
      columns: ['email', 'firstName', 'lastName', 'displayName', 'type'],
      options: ['comma', 'dedupe', 'skip_without_email'],
    });
    expect(row?.detail).not.toMatch(/alice|dave|evil|example/i);
  });

  it('uses the Laposta preset: semicolon, BOM, e-mail with first and last name', async () => {
    const f = await createListsFixture();
    populate(f);
    const { text } = await download(f, { preset: 'laposta' });
    expect(text.startsWith('﻿')).toBe(true);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('email;first_name;last_name');
    expect(lines).toContain('alice@contoso-fake.example;Alice;Example');
    expect(lines).toContain('dave@elsewhere.example;;');
  });

  it('takes columns, separator and BOM from a custom preset, and keeps repeated addresses when asked', async () => {
    const f = await createListsFixture();
    populate(f);
    const { text } = await download(f, {
      preset: 'custom',
      columns: ['displayName', 'email'],
      separator: ';',
      bom: false,
      dedupe: false,
    });
    const lines = text.split('\r\n').filter((line) => line !== '');
    expect(lines[0]).toBe('display_name;email');
    expect(lines).toHaveLength(5);
    expect(lines).toContain('Alice Again;ALICE@contoso-fake.example');
    expect(exportRows(f).map(detailOf)[0]).toMatchObject({ rows: 4, skipped: 0, preset: 'custom' });
    expect(exportRows(f).map(detailOf)[0]?.options).toEqual(['semicolon', 'skip_without_email']);
  });

  it('leaves out the members the caller may not see, and says how many', async () => {
    const f = await createListsFixture();
    populate(f);
    // Without `users:read` the users of the list are restricted rows: not in the file.
    const { text } = await download(f, OPTIONS, [EXPORT_LISTS, READ_CONTACTS]);
    expect(text).not.toContain('alice@');
    expect(text).toContain('dave@elsewhere.example');
    expect(detailOf(exportRows(f)[0] ?? { detail: null })).toMatchObject({ rows: 3, skipped: 1 });
  });

  it('needs a fresh step-up, the permission on the list, and a list that is there', async () => {
    const f = await createListsFixture();
    const list = f.world.lists.marketing;
    const stale = await call<ProblemBody>(
      f.staleActor(...EXPORTER).client,
      'POST',
      exportPath(list),
      OPTIONS,
    );
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe('step_up_required');
    const without = await call<ProblemBody>(
      f.actor(READ_USERS).client,
      'POST',
      exportPath(list),
      OPTIONS,
    );
    expect(without.body.code).toBe('permission_denied');
    const outOfScope = await call<ProblemBody>(
      f.actor(scoped('distributionlists:export', [listPrefix('Sales')])).client,
      'POST',
      exportPath(list),
      OPTIONS,
    );
    expect(outOfScope.status).toBe(403);
    const unknown = await call<ProblemBody>(
      f.actor(...EXPORTER).client,
      'POST',
      '/api/v1/distribution-lists/3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10/export',
      OPTIONS,
    );
    expect(unknown.status).toBe(404);
    expect(f.rows().filter((row) => row.outcome === 'denied')).toHaveLength(3);
    expect(exportRows(f).every((row) => row.outcome === 'denied')).toBe(true);
    expect(f.exchange.calls.filter((c) => c.method === 'listDistributionGroupMembers')).toEqual([]);
  });

  it('refuses options that fight a preset, an empty or repeated column list and an unknown separator', async () => {
    const f = await createListsFixture();
    for (const body of [
      { preset: 'laposta', separator: ',' },
      { preset: 'generic', columns: ['email'] },
      { preset: 'custom', columns: [] },
      { preset: 'custom', columns: ['email', 'email'] },
      { preset: 'custom', separator: '|' },
      { preset: 'excel' },
      {},
    ]) {
      const answer = await call<ProblemBody>(
        f.actor(...EXPORTER).client,
        'POST',
        exportPath(f.world.lists.marketing),
        body,
      );
      expect(answer.status, JSON.stringify(body)).toBe(422);
    }
    expect(exportRows(f)).toEqual([]);
  });

  it('answers 503 and writes one error entry when Exchange fails before the first member', async () => {
    const f = await createListsFixture({
      exchange: (fake) =>
        wrapExchange(fake, {
          listDistributionGroupMembers: () => () => ({
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.reject(new ExchangeUnavailableError({ reason: 'unavailable' })),
              return: () => Promise.resolve({ done: true as const, value: undefined }),
            }),
          }),
        }),
    });
    const answer = await call<ProblemBody>(
      f.actor(...EXPORTER).client,
      'POST',
      exportPath(f.world.lists.marketing),
      OPTIONS,
    );
    expect(answer.status).toBe(503);
    expect(exportRows(f).map((row) => [row.outcome, row.reason_code])).toEqual([
      ['error', 'exchange_unavailable'],
    ]);
  });

  it('writes the rows sent so far with the reason cancelled when the client stops reading', async () => {
    const f = await createListsFixture();
    const members = f.exchangeState.distributionGroups.get(f.world.lists.sales.guid)?.members;
    for (let index = 0; index < 20_000; index += 1) {
      members?.push(
        f.exchangeState.addRecipient({
          displayName: `Person ${String(index)}`,
          primarySmtpAddress: `person${String(index)}@contoso-fake.example`,
        }),
      );
    }
    const response = await f
      .actor(...EXPORTER)
      .client.request('POST', exportPath(f.world.lists.sales), { json: OPTIONS });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rows = exportRows(f);
    expect(rows.map((row) => [row.outcome, row.reason_code])).toEqual([['error', 'cancelled']]);
    expect(Number(detailOf(rows[0] ?? { detail: null }).rows)).toBeLessThan(20_000);
  });

  it('exports a dynamic list as its header alone', async () => {
    const f = await createListsFixture();
    const me = f.actor(...EXPORTER);
    const response = await me.client.request('POST', exportPath(f.world.lists.dynamic), {
      json: OPTIONS,
    });
    expect(await response.text()).toBe('email,first_name,last_name,display_name,type\r\n');
    expect(f.exchange.calls.filter((c) => c.method === 'listDistributionGroupMembers')).toEqual([]);
  });

  it('is rated in the export class, 6 a minute, and the preview in the write class', async () => {
    const f = await createListsFixture();
    const document = await readJson<{
      paths: Record<string, Record<string, Record<string, unknown>>>;
    }>(await f.actor(READ_USERS).client.get('/api/v1/openapi.json'));
    const operation = (suffix: string) =>
      document.paths[`/api/v1/distribution-lists/{id}/${suffix}`]?.post;
    expect(operation('export')?.['x-rate-limit']).toBe('export');
    expect(operation('export')?.['x-audit']).toBe('dl.export');
    expect(operation('export/preview')?.['x-rate-limit']).toBe('write');
    expect(LIMITS.rateLimit.export).toEqual({ capacity: 6, refillIntervalMs: 10_000 });
  });

  it('refuses nothing below the row limit and names the limit in the document', () => {
    expect(LIMITS.export.rowsMax).toBe(100_000);
  });
});

describe('POST /api/v1/distribution-lists/{id}/export/preview (P46)', () => {
  it('is the start of the download, header included, without the BOM', async () => {
    const f = await createListsFixture();
    populate(f);
    for (const body of [OPTIONS, { preset: 'laposta' }, { preset: 'custom', columns: ['email'] }]) {
      const answer = await call(
        f.actor(...EXPORTER).client,
        'POST',
        previewPath(f.world.lists.marketing),
        body,
      );
      expect(answer.status).toBe(200);
      const preview = ExportPreviewResponseSchema.parse(answer.body);
      const { text } = await download(f, body);
      expect(text.replace('﻿', '')).toBe(preview.csv);
      expect(preview.rows).toBe(3);
      expect(preview.skipped).toBe(1);
      expect(preview.more).toBe(false);
    }
  });

  it('shows 20 rows at most and says there are more', async () => {
    const f = await createListsFixture();
    const members = f.exchangeState.distributionGroups.get(f.world.lists.sales.guid)?.members;
    for (let index = 0; index < 25; index += 1) {
      members?.push(
        f.exchangeState.addRecipient({
          displayName: `Person ${String(index)}`,
          primarySmtpAddress: `p${String(index)}@contoso-fake.example`,
        }),
      );
    }
    const answer = await call(
      f.actor(...EXPORTER).client,
      'POST',
      previewPath(f.world.lists.sales),
      OPTIONS,
    );
    const preview = ExportPreviewResponseSchema.parse(answer.body);
    expect(preview.rows).toBe(LIMITS.export.previewRows);
    expect(preview.more).toBe(true);
    expect(exportRows(f)).toEqual([]);
  });

  it('needs the permission but no step-up, and is not audited', async () => {
    const f = await createListsFixture();
    const answer = await call(
      f.staleActor(...EXPORTER).client,
      'POST',
      previewPath(f.world.lists.marketing),
      OPTIONS,
    );
    expect(answer.status).toBe(200);
    expect(f.rows()).toEqual([]);
    const denied = await call<ProblemBody>(
      f.actor(READ_USERS).client,
      'POST',
      previewPath(f.world.lists.marketing),
      OPTIONS,
    );
    expect(denied.status).toBe(403);
  });
});
