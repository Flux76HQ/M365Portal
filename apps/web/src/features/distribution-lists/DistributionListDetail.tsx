// /distribution-lists/$id (FR-D-201, FR-D-204, FR-D-206, FR-D-207, US-D1): the properties of one list and its
// members, page by page. The members are another request than the list, so each loads and fails on its own.
// A standard list can have members added and removed by an actor who may; a dynamic or synchronised list
// is read-only and says so (R-D-02). The server decides: a refusal is shown, translated.
import { LIMITS } from '@m365portal/shared/limits';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { PageHeader } from '../../components/pages/PageHeader';
import { ErrorState } from '../../components/ui/error-state';
import { Skeleton } from '../../components/ui/skeleton';
import { useTranslator } from '../../lib/locale';
import { translateProblemCode } from '../../lib/problem';
import { useRouterContext } from '../../lib/router-context';
import { DefinitionList } from '../directory/DefinitionList';
import { DirectoryError } from '../directory/DirectoryError';
import { ListFooter } from '../directory/ListFooter';
import { MemberActions } from '../directory/MemberActions';
import { Section } from '../directory/Section';
import { StateNotice } from '../directory/StateNotice';
import { formatTimestamp, textOrDash, yesNo } from '../directory/format';
import { isGuid } from '../directory/guid';
import { useCan } from '../directory/capabilities';
import { useMemberSelection } from '../directory/useMemberSelection';
import { usePagedQuery } from '../directory/usePagedQuery';
import { usePageHeadingFocus } from '../directory/usePageHeadingFocus';
import { ListKindBadge } from './ListKindBadge';
import { ListMembersTable } from './ListMembersTable';
import {
  addListMembers,
  listCandidatesSearch,
  listMembersOptions,
  listOptions,
  refreshList,
  removeListMembers,
} from './queries';

const route = getRouteApi('/distribution-lists/$id');

function BackLink() {
  const { t } = useTranslator();
  return (
    <p className="mb-1">
      <Link
        to="/distribution-lists"
        className="text-accent-text underline underline-offset-4 hover:decoration-2"
      >
        {t('distributionLists.detail.back')}
      </Link>
    </p>
  );
}

function Members({
  id,
  name,
  editable,
}: {
  readonly id: string;
  readonly name: string;
  readonly editable: boolean;
}) {
  const { t } = useTranslator();
  const { api, queryClient } = useRouterContext();
  const selection = useMemberSelection();
  const { query, paging } = usePagedQuery(id, (cursor) => listMembersOptions(api, id, cursor));
  const data = query.data;
  const placeholder = query.isPlaceholderData;

  let body;
  if (data === undefined && query.isError) {
    body = (
      <DirectoryError
        headingLevel={3}
        title={t('distributionLists.members.error')}
        error={query.error}
        retryLabel={t('distributionLists.error.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (data?.items.length === 0 && !placeholder && !paging.canPrevious) {
    body = <p className="text-body text-fg-secondary">{t('distributionLists.members.empty')}</p>;
  } else {
    body = (
      <>
        <ListMembersTable
          caption={t('distributionLists.members.caption', { name })}
          rows={data?.items ?? []}
          loading={data === undefined}
          loadingLabel={t('distributionLists.members.loading')}
          {...(editable ? { selection } : {})}
        />
        <ListFooter
          countText={
            data === undefined || placeholder
              ? ''
              : t('distributionLists.members.shown', { count: data.items.length })
          }
          paging={paging}
          nextCursor={placeholder ? undefined : data?.nextCursor}
          busy={placeholder}
        />
      </>
    );
  }

  return (
    <Section heading={t('distributionLists.members.heading')}>
      {editable && data !== undefined ? (
        <MemberActions
          targetName={name}
          scope={['distributionLists', id]}
          search={listCandidatesSearch(api, id)}
          variant="usersAndContacts"
          add={(ids) => addListMembers(api, id, ids)}
          remove={(ids) => removeListMembers(api, id, ids)}
          max={LIMITS.distributionLists.bulkMax}
          stepUpAbove={LIMITS.distributionLists.stepUpAbove}
          selection={selection}
          onChanged={() => {
            refreshList(queryClient, id);
          }}
        />
      ) : null}
      {paging.restarted ? <StateNotice state={{ kind: 'cursorRestarted' }} /> : null}
      {body}
    </Section>
  );
}

export function DistributionListDetail() {
  usePageHeadingFocus();
  const translator = useTranslator();
  const { t } = translator;
  const { id } = route.useParams();
  const { api } = useRouterContext();
  const canWrite = useCan('distributionlists:members:write');
  const valid = isGuid(id);
  const query = useQuery({
    ...listOptions(api, id),
    enabled: valid,
    refetchOnWindowFocus: false,
  });

  if (!valid) {
    return (
      <>
        <BackLink />
        <PageHeader title={t('distributionLists.detail.title')} />
        <ErrorState
          headingLevel={2}
          title={t('distributionLists.detail.error')}
          description={translateProblemCode(translator, 'not_found')}
        />
      </>
    );
  }

  const list = query.data;
  if (list === undefined) {
    return (
      <>
        <BackLink />
        <PageHeader title={t('distributionLists.detail.title')} />
        {query.isError ? (
          <DirectoryError
            title={t('distributionLists.detail.error')}
            error={query.error}
            retryLabel={t('distributionLists.error.retry')}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : (
          <div
            aria-busy="true"
            aria-label={t('distributionLists.detail.loading')}
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
    list.displayName === null || list.displayName === ''
      ? t('distributionLists.unnamed')
      : list.displayName;
  const created = formatTimestamp(translator, list.createdDateTime);
  const readOnly = list.kind !== 'standard';

  return (
    <>
      <BackLink />
      <PageHeader title={name} />
      <div className="flex flex-col gap-8">
        <Section heading={t('distributionLists.detail.properties')}>
          <DefinitionList
            items={[
              {
                id: 'displayName',
                term: t('distributionLists.field.displayName'),
                value: textOrDash(translator, list.displayName),
              },
              {
                id: 'address',
                term: t('distributionLists.field.address'),
                value: textOrDash(translator, list.primarySmtpAddress),
              },
              {
                id: 'alias',
                term: t('distributionLists.field.alias'),
                value: textOrDash(translator, list.alias),
              },
              {
                id: 'kind',
                term: t('distributionLists.field.kind'),
                value: <ListKindBadge kind={list.kind} />,
              },
              {
                id: 'securityEnabled',
                term: t('distributionLists.field.securityEnabled'),
                value: yesNo(translator, list.securityEnabled),
              },
              {
                id: 'memberCount',
                term: t('distributionLists.field.memberCount'),
                value: list.memberCount ?? textOrDash(translator, null),
              },
              {
                id: 'managers',
                term: t('distributionLists.field.managers'),
                value:
                  list.managers === null || list.managers.length === 0 ? (
                    textOrDash(translator, null)
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {list.managers.map((manager, index) => (
                        <li key={`${manager.mail ?? ''}-${String(index)}`}>
                          <span>{manager.displayName ?? manager.mail ?? ''}</span>
                          {manager.displayName !== null && manager.mail !== null ? (
                            <span className="ms-1.5 text-body-sm text-fg-secondary">
                              {manager.mail}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ),
              },
              {
                id: 'created',
                term: t('distributionLists.field.created'),
                value: textOrDash(translator, created),
              },
            ]}
          />
          {list.kind === 'dynamic' ? <StateNotice state={{ kind: 'listReadOnlyDynamic' }} /> : null}
          {list.kind === 'synced' ? <StateNotice state={{ kind: 'listReadOnlySynced' }} /> : null}
        </Section>
        <Members id={id} name={name} editable={canWrite && !readOnly} />
      </div>
    </>
  );
}
