// /users/$id (FR-C-503, US-C2, EC-C5, EC-C6): the core properties, the manager and the group memberships of
// one user. Each part loads and fails on its own: the memberships are another request than the user, and the
// manager is a field the server answers best-effort ("none" and "unavailable" are states, not errors).
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import type { ManagerState } from '@m365portal/shared/schemas/directory';
import { isRestrictedRow } from '@m365portal/shared/schemas/directory';
import { PageHeader } from '../../components/pages/PageHeader';
import { ErrorState } from '../../components/ui/error-state';
import { Skeleton } from '../../components/ui/skeleton';
import { useTranslator } from '../../lib/locale';
import { translateProblemCode } from '../../lib/problem';
import { useMe, useRouterContext } from '../../lib/router-context';
import { DefinitionList } from '../directory/DefinitionList';
import { DirectoryError } from '../directory/DirectoryError';
import { DirectoryTable } from '../directory/DirectoryTable';
import { ListFooter } from '../directory/ListFooter';
import { RestrictedValue } from '../directory/RestrictedRow';
import { Section } from '../directory/Section';
import { StateNotice } from '../directory/StateNotice';
import { StateMark, formatTimestamp, textOrDash, yesNo } from '../directory/format';
import { isGuid } from '../directory/guid';
import { usePagedQuery } from '../directory/usePagedQuery';
import { usePageHeadingFocus } from '../directory/usePageHeadingFocus';
import { groupColumns } from '../groups/columns';
import { userGroupsOptions, userOptions } from './queries';

const route = getRouteApi('/users/$id');

function BackLink() {
  const { t } = useTranslator();
  return (
    <p className="mb-1">
      <Link
        to="/users"
        className="text-accent-text underline underline-offset-4 hover:decoration-2"
      >
        {t('users.detail.back')}
      </Link>
    </p>
  );
}

function Manager({ manager }: { readonly manager: ManagerState }) {
  const { t } = useTranslator();
  if (manager.state === 'none') return <StateNotice state={{ kind: 'managerNone' }} />;
  if (manager.state === 'unavailable')
    return <StateNotice state={{ kind: 'managerUnavailable' }} />;
  const row = manager.user;
  // A manager the actor may not see is a restricted row: the word, and nothing that identifies them.
  if (isRestrictedRow(row)) return <RestrictedValue />;
  const name =
    row.displayName === null || row.displayName === '' ? t('users.unnamed') : row.displayName;
  return (
    <p className="flex flex-wrap items-baseline gap-x-2">
      <Link
        to="/users/$id"
        params={{ id: row.id }}
        className="text-accent-text underline underline-offset-4 hover:decoration-2"
      >
        {name}
      </Link>
      {row.mail === null ? null : <span className="text-fg-secondary">{row.mail}</span>}
    </p>
  );
}

function UserGroups({ id, name }: { readonly id: string; readonly name: string }) {
  const translator = useTranslator();
  const { t } = translator;
  const { api } = useRouterContext();
  const { query, paging } = usePagedQuery(id, (cursor) => userGroupsOptions(api, id, cursor));
  const data = query.data;
  const placeholder = query.isPlaceholderData;
  let body;
  if (data === undefined && query.isError) {
    body = (
      <DirectoryError
        headingLevel={3}
        title={t('users.groups.error')}
        error={query.error}
        retryLabel={t('users.error.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (data?.items.length === 0 && !placeholder && !paging.canPrevious) {
    body = <p className="text-body text-fg-secondary">{t('users.groups.empty')}</p>;
  } else {
    body = (
      <>
        <DirectoryTable
          caption={t('users.groups.caption', { name })}
          columns={groupColumns(translator)}
          rows={data?.items ?? []}
          getRowKey={(row) => row.id}
          loading={data === undefined}
          loadingLabel={t('users.groups.loading')}
        />
        <ListFooter
          countText={
            data === undefined || placeholder
              ? ''
              : t('groups.result.count', { count: data.items.length })
          }
          paging={paging}
          nextCursor={placeholder ? undefined : data?.nextCursor}
          busy={placeholder}
        />
      </>
    );
  }
  return (
    <Section heading={t('users.groups.heading')}>
      <StateNotice state={{ kind: 'transitiveGroups' }} />
      <StateNotice state={{ kind: 'groupsMayBeMissing' }} />
      {paging.restarted ? <StateNotice state={{ kind: 'cursorRestarted' }} /> : null}
      {body}
    </Section>
  );
}

export function UserDetail() {
  usePageHeadingFocus();
  const translator = useTranslator();
  const { t } = translator;
  const { id } = route.useParams();
  const { api } = useRouterContext();
  const me = useMe();
  const valid = isGuid(id);
  const query = useQuery({
    ...userOptions(api, id),
    enabled: valid,
    refetchOnWindowFocus: false,
  });

  if (!valid) {
    return (
      <>
        <BackLink />
        <PageHeader title={t('users.detail.title')} />
        <ErrorState
          headingLevel={2}
          title={t('users.detail.error')}
          description={translateProblemCode(translator, 'not_found')}
        />
      </>
    );
  }

  const user = query.data;
  if (user === undefined) {
    return (
      <>
        <BackLink />
        <PageHeader title={t('users.detail.title')} />
        {query.isError ? (
          <DirectoryError
            title={t('users.detail.error')}
            error={query.error}
            retryLabel={t('users.error.retry')}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : (
          <div
            aria-busy="true"
            aria-label={t('users.detail.loading')}
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
    user.displayName === null || user.displayName === '' ? t('users.unnamed') : user.displayName;
  // A user the actor sees through a `basic` grant has a name and an address and nothing else: no manager,
  // no memberships (FR-C-204).
  const full = 'userPrincipalName' in user ? user : null;
  const created = full === null ? null : formatTimestamp(translator, full.createdDateTime);
  const canSeeGroups = me.permissions.includes('groups:read');

  return (
    <>
      <BackLink />
      <PageHeader title={name}>
        {full?.userType === 'guest' ? (
          <p className="text-body-sm font-medium text-fg-secondary">{t('users.type.guest')}</p>
        ) : null}
      </PageHeader>
      <div className="flex flex-col gap-8">
        <Section heading={t('users.detail.properties')}>
          <DefinitionList
            items={[
              {
                id: 'displayName',
                term: t('users.field.displayName'),
                value: textOrDash(translator, user.displayName),
              },
              ...(full === null
                ? []
                : [
                    {
                      id: 'givenName',
                      term: t('users.field.givenName'),
                      value: textOrDash(translator, full.givenName),
                    },
                    {
                      id: 'surname',
                      term: t('users.field.surname'),
                      value: textOrDash(translator, full.surname),
                    },
                    {
                      id: 'upn',
                      term: t('users.field.upn'),
                      value: textOrDash(translator, full.userPrincipalName),
                    },
                  ]),
              { id: 'mail', term: t('users.field.mail'), value: textOrDash(translator, user.mail) },
              ...(full === null
                ? []
                : [
                    {
                      id: 'department',
                      term: t('users.field.department'),
                      value: textOrDash(translator, full.department),
                    },
                    {
                      id: 'jobTitle',
                      term: t('users.field.jobTitle'),
                      value: textOrDash(translator, full.jobTitle),
                    },
                    {
                      id: 'officeLocation',
                      term: t('users.field.officeLocation'),
                      value: textOrDash(translator, full.officeLocation),
                    },
                    {
                      id: 'state',
                      term: t('users.field.accountEnabled'),
                      value: <StateMark translator={translator} enabled={full.accountEnabled} />,
                    },
                    {
                      id: 'type',
                      term: t('users.field.userType'),
                      value:
                        full.userType === null
                          ? textOrDash(translator, null)
                          : t(full.userType === 'guest' ? 'users.type.guest' : 'users.type.member'),
                    },
                    {
                      id: 'synced',
                      term: t('users.field.synced'),
                      value: yesNo(translator, full.onPremisesSyncEnabled),
                    },
                    {
                      id: 'created',
                      term: t('users.field.created'),
                      value: textOrDash(translator, created),
                    },
                  ]),
            ]}
          />
          {full === null ? <StateNotice state={{ kind: 'basicOnly' }} /> : null}
        </Section>
        {full === null ? null : (
          <Section heading={t('users.manager.heading')}>
            <Manager manager={full.manager} />
          </Section>
        )}
        {full === null || !canSeeGroups ? null : <UserGroups id={id} name={name} />}
      </div>
    </>
  );
}
