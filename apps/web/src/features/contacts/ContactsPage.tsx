// /contacts (FR-D-301, US-D2): the mail contacts the actor may see, 50 to a page, by display name, with a search
// on the first letters of the name, alias or address. A contact that is synchronised from on-premises says so.
// "New contact" is offered to an actor who may create; the server decides.
import type { ContactListItem } from '@m365portal/shared/schemas/contacts';
import { getRouteApi, Link } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { PageHeader } from '../../components/pages/PageHeader';
import { useTranslator } from '../../lib/locale';
import { useRouterContext } from '../../lib/router-context';
import { useCan } from '../directory/capabilities';
import { DirectoryError } from '../directory/DirectoryError';
import { DirectorySearch } from '../directory/DirectorySearch';
import { DirectoryTable, type DirectoryColumn } from '../directory/DirectoryTable';
import { ListFooter } from '../directory/ListFooter';
import { StateNotice } from '../directory/StateNotice';
import { textOrDash } from '../directory/format';
import { usePagedQuery } from '../directory/usePagedQuery';
import { usePageHeadingFocus } from '../directory/usePageHeadingFocus';
import { contactsListOptions, contactsParamsOf, type ContactsParams } from './queries';

// The form is a chunk of its own: nothing of it loads until "New contact" is pressed.
const ContactFormDialog = lazy(() =>
  import('./ContactFormDialog').then((module) => ({ default: module.ContactFormDialog })),
);

const route = getRouteApi('/contacts/');

export function ContactsPage() {
  usePageHeadingFocus();
  const translator = useTranslator();
  const { t } = translator;
  const { api } = useRouterContext();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const canCreate = useCan('contacts:create');
  const [creating, setCreating] = useState(false);
  const [formWanted, setFormWanted] = useState(false);
  const params = contactsParamsOf(search);
  const { query, paging } = usePagedQuery(JSON.stringify(params), (cursor) =>
    contactsListOptions(api, params, cursor),
  );
  const filtered = params.q !== undefined;

  function change(next: Partial<ContactsParams>) {
    const merged = { ...params, ...next };
    void navigate({
      search: {
        ...(merged.q === undefined ? {} : { q: merged.q }),
        ...(merged.order === 'asc' ? {} : { order: merged.order }),
      },
    });
  }

  const columns: DirectoryColumn<ContactListItem>[] = [
    {
      id: 'name',
      header: t('contacts.column.name'),
      rowHeader: true,
      cell: (row) => (
        <Link
          to="/contacts/$id"
          params={{ id: row.id }}
          className="text-accent-text underline underline-offset-4 hover:decoration-2"
        >
          {row.displayName === null || row.displayName === ''
            ? t('contacts.unnamed')
            : row.displayName}
        </Link>
      ),
    },
    {
      id: 'alias',
      header: t('contacts.column.alias'),
      cell: (row) => textOrDash(translator, row.alias),
    },
    {
      id: 'address',
      header: t('contacts.column.address'),
      cell: (row) => textOrDash(translator, row.externalEmailAddress),
    },
    {
      id: 'state',
      header: t('contacts.column.state'),
      cell: (row) =>
        row.synced === true ? t('contacts.source.synced') : t('contacts.source.local'),
    },
  ];

  const data = query.data;
  const showingPlaceholder = query.isPlaceholderData;
  const failed = data === undefined && query.isError;
  const empty = data?.items.length === 0 && !showingPlaceholder;
  let body;
  if (failed) {
    body = (
      <DirectoryError
        title={t('contacts.error.title')}
        error={query.error}
        retryLabel={t('contacts.error.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (empty) {
    body = (
      <EmptyState
        headingLevel={2}
        title={filtered ? t('contacts.empty.filteredTitle') : t('contacts.empty.title')}
        description={
          filtered ? t('contacts.empty.filteredDescription') : t('contacts.empty.description')
        }
        action={
          filtered ? (
            <Button
              onClick={() => {
                void navigate({ search: {} });
              }}
            >
              {t('contacts.filter.clear')}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <DirectoryTable
        caption={t('contacts.table.caption')}
        columns={columns}
        rows={data?.items ?? []}
        getRowKey={(row) => row.id}
        loading={data === undefined}
        loadingLabel={t('contacts.loading')}
        sort={{
          columnId: 'name',
          direction: params.order,
          onToggle: () => {
            change({ order: params.order === 'asc' ? 'desc' : 'asc' });
          },
        }}
      />
    );
  }

  return (
    <>
      <PageHeader title={t('nav.contacts')} description={t('contacts.page.description')} />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <DirectorySearch
            label={t('contacts.search.label')}
            hint={t('contacts.search.hint')}
            value={params.q}
            onSubmit={(q) => {
              change({ q });
            }}
          />
          {canCreate ? (
            <Button
              variant="primary"
              onClick={() => {
                setFormWanted(true);
                setCreating(true);
              }}
            >
              {t('contacts.actions.new')}
            </Button>
          ) : null}
        </div>
        {paging.restarted ? <StateNotice state={{ kind: 'cursorRestarted' }} /> : null}
        {body}
        {failed || (empty && !paging.canPrevious) ? null : (
          <ListFooter
            countText={
              data === undefined || showingPlaceholder
                ? ''
                : t('contacts.result.count', { count: data.items.length })
            }
            paging={paging}
            nextCursor={showingPlaceholder ? undefined : data?.nextCursor}
            busy={showingPlaceholder}
          />
        )}
      </div>
      {canCreate && formWanted ? (
        <Suspense fallback={null}>
          <ContactFormDialog mode="create" open={creating} onOpenChange={setCreating} />
        </Suspense>
      ) : null}
    </>
  );
}
