// /distribution-lists/$id, the CSV export (step D2; FR-D-401, FR-D-402, FR-D-404, FR-D-405, US-D5): the button is
// offered to an actor with the export permission on a list that has members to export, the dialog shows the
// privacy notice, the presets, a preview from the server and the download, a failure is shown translated,
// and the Dutch interface has every word.
import { createTranslator } from '@m365portal/shared/i18n';
import type { Permission } from '@m365portal/shared/permissions';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { problem } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import { loadAllLazyNamespaces } from './helpers/setup-fixtures';
import {
  contactMember,
  createPhaseDApi,
  emptyPhaseDWorld,
  listGuid,
  listRecord,
  makeList,
  userMember,
  type PhaseDWorld,
} from './support/phase-d-handlers';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const en = createTranslator('en');
const nl = createTranslator('nl');
const t = en.t;

const EXPORTER: Permission[] = ['distributionlists:read', 'distributionlists:export'];
const SALES = `/distribution-lists/${listGuid(1)}`;
const DYNAMIC = `/distribution-lists/${listGuid(2)}`;

function world(): PhaseDWorld {
  const w = emptyPhaseDWorld();
  w.lists.push(
    listRecord(makeList(1, { displayName: 'Sales' }), [
      userMember(1),
      userMember(2),
      contactMember(1),
      { ...userMember(3), primarySmtpAddress: 'USER1@example.test' },
    ]),
    listRecord(makeList(2, { displayName: 'Everyone', kind: 'dynamic' }), [userMember(4)]),
  );
  return w;
}

async function open(
  path: string,
  options: { permissions?: Permission[]; language?: 'en' | 'nl' } = {},
) {
  const api = createPhaseDApi(world());
  const view = await renderApp({
    me: sampleMe({ kind: 'user', permissions: options.permissions ?? EXPORTER }),
    path,
    language: options.language ?? 'en',
    fetch: api.fetch,
  });
  return { ...view, api };
}

const saved: { blob: Blob; name: string }[] = [];

function captureDownloads() {
  saved.length = 0;
  const blobs = new Map<string, Blob>();
  let counter = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        counter += 1;
        const url = `blob:test/${String(counter)}`;
        blobs.set(url, blob);
        return url;
      },
      revokeObjectURL: () => undefined,
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ blob: blobs.get(this.href)!, name: this.download });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the export button', () => {
  it('is offered with the export permission on a list that has members, and not otherwise', async () => {
    const first = await open(SALES);
    expect(
      await screen.findByRole('button', { name: t('distributionLists.export.open') }),
    ).toBeInTheDocument();
    first.unmount();

    const second = await open(SALES, { permissions: ['distributionlists:read'] });
    await screen.findByRole('heading', { level: 1, name: 'Sales' });
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: t('distributionLists.export.open') })).toBeNull();
    second.unmount();

    await open(DYNAMIC);
    await screen.findByRole('heading', { level: 1, name: 'Everyone' });
    expect(screen.queryByRole('button', { name: t('distributionLists.export.open') })).toBeNull();
  });
});

describe('the export dialog', () => {
  it('shows the notice, the Laposta preset first, and the preview from the server', async () => {
    const { api, user } = await open(SALES);
    await user.click(
      await screen.findByRole('button', { name: t('distributionLists.export.open') }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: t('distributionLists.export.title', { name: 'Sales' }),
    });
    expect(within(dialog).getByText(t('distributionLists.export.privacy'))).toBeInTheDocument();
    expect(
      within(dialog).getByRole('radio', { name: t('distributionLists.export.preset.laposta') }),
    ).toBeChecked();
    const preview = await within(dialog).findByLabelText(
      t('distributionLists.export.preview.label'),
    );
    expect(preview).toHaveTextContent('email;first_name;last_name');
    expect(preview).toHaveTextContent('user1@example.test');
    // Three addresses; the fourth member repeats one of them.
    expect(
      within(dialog).getByText(t('distributionLists.export.preview.all', { count: 3 })),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(t('distributionLists.export.preview.skipped', { count: 1 })),
    ).toBeInTheDocument();
    expect(api.callsTo('POST', /\/export\/preview$/)[0]?.body).toEqual({
      preset: 'laposta',
      dedupe: true,
      skipWithoutEmail: true,
    });
  });

  it('asks for the preview again when the format changes, and offers the columns for a free choice', async () => {
    const { api, user } = await open(SALES);
    await user.click(
      await screen.findByRole('button', { name: t('distributionLists.export.open') }),
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText(t('distributionLists.export.preview.label'));
    await user.click(
      within(dialog).getByRole('radio', { name: t('distributionLists.export.preset.custom') }),
    );
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: t('distributionLists.export.column.firstName'),
      }),
    );
    await user.click(
      within(dialog).getByRole('checkbox', { name: t('distributionLists.export.column.lastName') }),
    );
    await user.click(
      within(dialog).getByRole('checkbox', { name: t('distributionLists.export.column.type') }),
    );
    await user.click(
      within(dialog).getByRole('radio', { name: t('distributionLists.export.separator.comma') }),
    );
    await waitFor(() => {
      expect(
        within(dialog).getByLabelText(t('distributionLists.export.preview.label')),
      ).toHaveTextContent('email,display_name');
    });
    const last = api.callsTo('POST', /\/export\/preview$/).at(-1)?.body;
    expect(last).toEqual({
      preset: 'custom',
      columns: ['email', 'displayName'],
      separator: ',',
      bom: true,
      dedupe: true,
      skipWithoutEmail: true,
    });
  });

  it('refuses a free choice without a column', async () => {
    const { user } = await open(SALES);
    await user.click(
      await screen.findByRole('button', { name: t('distributionLists.export.open') }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('radio', { name: t('distributionLists.export.preset.custom') }),
    );
    for (const column of ['email', 'firstName', 'lastName', 'displayName', 'type'] as const) {
      await user.click(
        within(dialog).getByRole('checkbox', {
          name: t(`distributionLists.export.column.${column}`),
        }),
      );
    }
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      t('distributionLists.export.columns.none'),
    );
    expect(
      within(dialog).getByRole('button', { name: t('distributionLists.export.download') }),
    ).toBeDisabled();
  });

  it('downloads the file the server sends, under the name the server gave it, byte order mark included', async () => {
    captureDownloads();
    const { api, user } = await open(SALES);
    await user.click(
      await screen.findByRole('button', { name: t('distributionLists.export.open') }),
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText(t('distributionLists.export.preview.label'));
    await user.click(
      within(dialog).getByRole('button', { name: t('distributionLists.export.download') }),
    );
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      t('distributionLists.export.done'),
    );
    expect(api.callsTo('POST', /\/export$/)).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toBe('Sales-2026-10-19.csv');
    const bytes = new Uint8Array(await saved[0]!.blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toContain(
      'email;first_name;last_name\r\nuser1@example.test;;\r\n',
    );
  });

  it('shows the translated reason when the server refuses, and keeps the choices', async () => {
    captureDownloads();
    const { api, user } = await open(SALES);
    api.override('POST', /\/export$/, () => problem(403, 'permission_denied'));
    await user.click(
      await screen.findByRole('button', { name: t('distributionLists.export.open') }),
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText(t('distributionLists.export.preview.label'));
    await user.click(
      within(dialog).getByRole('button', { name: t('distributionLists.export.download') }),
    );
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(t('distributionLists.export.error'));
    expect(alert).toHaveTextContent(t('problem.permission_denied'));
    expect(saved).toHaveLength(0);
    expect(
      within(dialog).getByRole('radio', { name: t('distributionLists.export.preset.laposta') }),
    ).toBeChecked();
  });

  it('is in Dutch, word for word', async () => {
    const { user } = await open(SALES, { language: 'nl' });
    await user.click(
      await screen.findByRole('button', { name: nl.t('distributionLists.export.open') }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: nl.t('distributionLists.export.title', { name: 'Sales' }),
    });
    expect(within(dialog).getByText(nl.t('distributionLists.export.privacy'))).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: nl.t('distributionLists.export.download') }),
    ).toBeInTheDocument();
    await within(dialog).findByLabelText(nl.t('distributionLists.export.preview.label'));
  });
});
