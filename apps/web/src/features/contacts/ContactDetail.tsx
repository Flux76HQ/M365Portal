// /contacts/$id (FR-D-301, FR-D-303, FR-D-305, US-D2): the properties of one mail contact, edit and delete for an
// actor who may, and the distribution lists the contact is in. The lists are another request than the contact,
// so each loads and fails on its own. A contact synchronised from on-premises is read-only and says so. The
// server decides: a refusal is shown, translated.
import { Link, getRouteApi } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { PageHeader } from '../../components/pages/PageHeader';
import { Button } from '../../components/ui/button';
import { ErrorState } from '../../components/ui/error-state';
import { Skeleton } from '../../components/ui/skeleton';
import { useTranslator } from '../../lib/locale';
import { translateProblemCode } from '../../lib/problem';
import { useRouterContext } from '../../lib/router-context';
import { DefinitionList } from '../directory/DefinitionList';
import { DirectoryError } from '../directory/DirectoryError';
import { DirectoryTable } from '../directory/DirectoryTable';
import { ListFooter } from '../directory/ListFooter';
import { Section } from '../directory/Section';
import { StateNotice } from '../directory/StateNotice';
import { formatTimestamp, textOrDash, yesNo } from '../directory/format';
import { isGuid } from '../directory/guid';
import { useCan } from '../directory/capabilities';
import { usePagedQuery } from '../directory/usePagedQuery';
import { usePageHeadingFocus } from '../directory/usePageHeadingFocus';
import { listColumns } from '../distribution-lists/columns';
import { contactListsOptions, contactOptions } from './queries';

// The two dialogs are chunks of their own: nothing of them loads until a button is pressed.
const ContactFormDialog = lazy(() =>
  import('./ContactFormDialog').then((module) => ({ default: module.ContactFormDialog })),
);
const DeleteContactDialog = lazy(() =>
  import('./DeleteContactDialog').then((module) => ({ default: module.DeleteContactDialog })),
);

const route = getRouteApi('/contacts/$id');

function BackLink() {
  const { t } = useTranslator();
  return (
    <p className="mb-1">
      <Link
        to="/contacts"
        className="text-accent-text underline underline-offset-4 hover:decoration-2"
      >
        {t('contacts.detail.back')}
      </Link>
    </p>
  );
}

function Lists({ id, name }: { readonly id: string; readonly name: string }) {
  const translator = useTranslator();
  const { t } = translator;
  const { api } = useRouterContext();
  const { query, paging } = usePagedQuery(id, (cursor) => contactListsOptions(api, id, cursor));
  const data = query.data;
  const placeholder = query.isPlaceholderData;
  let body;
  if (data === undefined && query.isError) {
    body = (
      <DirectoryError
        headingLevel={3}
        title={t('contacts.lists.error')}
        error={query.error}
        retryLabel={t('contacts.error.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (data?.items.length === 0 && !placeholder && !paging.canPrevious) {
    body = <p className="text-body text-fg-secondary">{t('contacts.lists.empty')}</p>;
  } else {
    body = (
      <>
        <DirectoryTable
          caption={t('contacts.lists.caption', { name })}
          columns={listColumns(translator, false)}
          rows={data?.items ?? []}
          getRowKey={(row) => row.id}
          loading={data === undefined}
          loadingLabel={t('contacts.lists.loading')}
        />
        <ListFooter
          countText={
            data === undefined || placeholder
              ? ''
              : t('contacts.lists.shown', { count: data.items.length })
          }
          paging={paging}
          nextCursor={placeholder ? undefined : data?.nextCursor}
          busy={placeholder}
        />
      </>
    );
  }
  return (
    <Section heading={t('contacts.lists.heading')}>
      {paging.restarted ? <StateNotice state={{ kind: 'cursorRestarted' }} /> : null}
      {body}
    </Section>
  );
}

export function ContactDetail() {
  usePageHeadingFocus();
  const translator = useTranslator();
  const { t } = translator;
  const { id } = route.useParams();
  const { api } = useRouterContext();
  const canUpdate = useCan('contacts:update');
  const canDelete = useCan('contacts:delete');
  const canReadLists = useCan('distributionlists:read');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editWanted, setEditWanted] = useState(false);
  const [deleteWanted, setDeleteWanted] = useState(false);
  const valid = isGuid(id);
  const query = useQuery({
    ...contactOptions(api, id),
    enabled: valid,
    refetchOnWindowFocus: false,
  });

  if (!valid) {
    return (
      <>
        <BackLink />
        <PageHeader title={t('contacts.detail.title')} />
        <ErrorState
          headingLevel={2}
          title={t('contacts.detail.error')}
          description={translateProblemCode(translator, 'not_found')}
        />
      </>
    );
  }

  const contact = query.data;
  if (contact === undefined) {
    return (
      <>
        <BackLink />
        <PageHeader title={t('contacts.detail.title')} />
        {query.isError ? (
          <DirectoryError
            title={t('contacts.detail.error')}
            error={query.error}
            retryLabel={t('contacts.error.retry')}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : (
          <div
            aria-busy="true"
            aria-label={t('contacts.detail.loading')}
            className="flex flex-col gap-4"
          >
            <Skeleton height={24} width="40%" />
            <Skeleton height={160} />
          </div>
        )}
      </>
    );
  }

  const name =
    contact.displayName === null || contact.displayName === ''
      ? t('contacts.unnamed')
      : contact.displayName;
  const created = formatTimestamp(translator, contact.createdDateTime);
  const synced = contact.synced === true;

  return (
    <>
      <BackLink />
      <PageHeader title={name} />
      <div className="flex flex-col gap-8">
        <Section heading={t('contacts.detail.properties')}>
          <DefinitionList
            items={[
              {
                id: 'displayName',
                term: t('contacts.field.displayName'),
                value: textOrDash(translator, contact.displayName),
              },
              {
                id: 'alias',
                term: t('contacts.field.alias'),
                value: textOrDash(translator, contact.alias),
              },
              {
                id: 'address',
                term: t('contacts.field.address'),
                value: textOrDash(translator, contact.externalEmailAddress),
              },
              {
                id: 'firstName',
                term: t('contacts.field.firstName'),
                value: textOrDash(translator, contact.firstName),
              },
              {
                id: 'lastName',
                term: t('contacts.field.lastName'),
                value: textOrDash(translator, contact.lastName),
              },
              {
                id: 'hidden',
                term: t('contacts.field.hidden'),
                value: yesNo(translator, contact.hiddenFromAddressLists),
              },
              {
                id: 'synced',
                term: t('contacts.field.synced'),
                value: yesNo(translator, contact.synced),
              },
              {
                id: 'created',
                term: t('contacts.field.created'),
                value: textOrDash(translator, created),
              },
            ]}
          />
          {synced ? <StateNotice state={{ kind: 'contactSynced' }} /> : null}
          {!synced && (canUpdate || canDelete) ? (
            <div className="flex flex-wrap gap-2">
              {canUpdate ? (
                <Button
                  onClick={() => {
                    setEditWanted(true);
                    setEditing(true);
                  }}
                >
                  {t('contacts.actions.edit')}
                </Button>
              ) : null}
              {canDelete ? (
                <Button
                  variant="destructive"
                  onClick={() => {
                    setDeleteWanted(true);
                    setDeleting(true);
                  }}
                >
                  {t('contacts.actions.delete')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </Section>
        {canReadLists ? <Lists id={id} name={name} /> : null}
      </div>
      {canUpdate && !synced && editWanted ? (
        <Suspense fallback={null}>
          <ContactFormDialog
            mode="edit"
            open={editing}
            onOpenChange={setEditing}
            contact={contact}
          />
        </Suspense>
      ) : null}
      {canDelete && !synced && deleteWanted ? (
        <Suspense fallback={null}>
          <DeleteContactDialog
            contact={contact}
            open={deleting}
            onOpenChange={setDeleting}
            canReadLists={canReadLists}
          />
        </Suspense>
      ) : null}
    </>
  );
}
