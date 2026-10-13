// /groups/$id (FR-C-503, EC-C7 to EC-C9, US-C3, US-C6): the core properties, the owners and the members of one
// group. The owners and the members are other requests than the group and than each other, so each loads and
// fails on its own. A hidden membership, owners that are not available and rows the actor may not see each
// have a message of their own.
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { LIMITS } from '@m365portal/shared/limits';
import { isReadOnlyGroupKind } from '@m365portal/shared/directory/group-kind';
import { PageHeader } from '../../components/pages/PageHeader';
import type { GroupDetail as GroupDetailData } from '@m365portal/shared/schemas/directory';
import { ErrorState } from '../../components/ui/error-state';
import { Skeleton } from '../../components/ui/skeleton';
import { useTranslator } from '../../lib/locale';
import { translateProblemCode } from '../../lib/problem';
import { useRouterContext } from '../../lib/router-context';
import { useCan } from '../directory/capabilities';
import { DefinitionList } from '../directory/DefinitionList';
import { DirectoryError } from '../directory/DirectoryError';
import { ListFooter } from '../directory/ListFooter';
import { MemberActions } from '../directory/MemberActions';
import { Section } from '../directory/Section';
import { StateNotice } from '../directory/StateNotice';
import { formatTimestamp, textOrDash, yesNo } from '../directory/format';
import { isGuid } from '../directory/guid';
import { useMemberSelection } from '../directory/useMemberSelection';
import { usePagedQuery } from '../directory/usePagedQuery';
import { usePageHeadingFocus } from '../directory/usePageHeadingFocus';
import { GroupKindBadge } from './GroupKindBadge';
import { GroupMembersReadOnly } from './GroupMembersReadOnly';
import { memberEditState } from './member-editing';
import { MembersTable } from './MembersTable';
import {
  addGroupMembers,
  groupMembersOptions,
  groupOptions,
  groupOwnersOptions,
  refreshGroupMembers,
  removeGroupMembers,
  userCandidatesSearch,
} from './queries';

const route = getRouteApi('/groups/$id');

function BackLink() {
  const { t } = useTranslator();
  return (
    <p className="mb-1">
      <Link
        to="/groups"
        className="text-accent-text underline underline-offset-4 hover:decoration-2"
      >
        {t('groups.detail.back')}
      </Link>
    </p>
  );
}

function Owners({ id, name }: { readonly id: string; readonly name: string }) {
  const { t } = useTranslator();
  const { api } = useRouterContext();
  const { query, paging } = usePagedQuery(id, (cursor) => groupOwnersOptions(api, id, cursor));
  const data = query.data;
  const placeholder = query.isPlaceholderData;
  let body;
  if (data === undefined && query.isError) {
    body = (
      <DirectoryError
        headingLevel={3}
        title={t('groups.owners.error')}
        error={query.error}
        retryLabel={t('groups.error.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (data?.ownersState === 'not_available') {
    body = <StateNotice state={{ kind: 'ownersNotAvailable' }} />;
  } else if (data?.items.length === 0 && !placeholder && !paging.canPrevious) {
    body = <p className="text-body text-fg-secondary">{t('groups.owners.empty')}</p>;
  } else {
    body = (
      <>
        <MembersTable
          caption={t('groups.owners.caption', { name })}
          rows={data?.items ?? []}
          of="owners"
          loading={data === undefined}
          loadingLabel={t('groups.owners.loading')}
        />
        {data?.nextCursor === undefined && !paging.canPrevious ? null : (
          <ListFooter
            countText=""
            paging={paging}
            nextCursor={placeholder ? undefined : data?.nextCursor}
            busy={placeholder}
          />
        )}
      </>
    );
  }
  return (
    <Section heading={t('groups.owners.heading')}>
      {paging.restarted ? <StateNotice state={{ kind: 'cursorRestarted' }} /> : null}
      {body}
    </Section>
  );
}

function Members({
  id,
  name,
  group,
}: {
  readonly id: string;
  readonly name: string;
  readonly group: Pick<GroupDetailData, 'kind' | 'membershipType' | 'onPremisesSyncEnabled'>;
}) {
  const { t } = useTranslator();
  const { api, queryClient } = useRouterContext();
  const canWrite = useCan('groups:members:write');
  const selection = useMemberSelection();
  const editState = memberEditState(group);
  const editable = canWrite && editState === 'editable';
  const { query, paging } = usePagedQuery(id, (cursor) => groupMembersOptions(api, id, cursor));
  const data = query.data;
  const placeholder = query.isPlaceholderData;
  let body;
  if (data === undefined && query.isError) {
    body = (
      <DirectoryError
        headingLevel={3}
        title={t('groups.members.error')}
        error={query.error}
        retryLabel={t('groups.error.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (data?.membersState === 'hidden') {
    body = <StateNotice state={{ kind: 'membersHidden' }} />;
  } else if (data?.items.length === 0 && !placeholder && !paging.canPrevious) {
    body = <p className="text-body text-fg-secondary">{t('groups.members.empty')}</p>;
  } else {
    body = (
      <>
        <MembersTable
          caption={t('groups.members.caption', { name })}
          rows={data?.items ?? []}
          of="members"
          loading={data === undefined}
          loadingLabel={t('groups.members.loading')}
          {...(editable ? { selection } : {})}
        />
        <ListFooter
          countText={
            data === undefined || placeholder
              ? ''
              : t('groups.members.shown', { count: data.items.length })
          }
          paging={paging}
          nextCursor={placeholder ? undefined : data?.nextCursor}
          busy={placeholder}
        />
      </>
    );
  }
  return (
    <Section heading={t('groups.members.heading')}>
      <p className="text-body-sm text-fg-secondary">{t('groups.members.directOnly')}</p>
      {data !== undefined && data.membersState !== 'hidden' ? (
        editable ? (
          <MemberActions
            targetName={name}
            scope={['groups', id]}
            search={userCandidatesSearch(api)}
            variant="users"
            add={(ids) => addGroupMembers(api, id, ids)}
            remove={(ids) => removeGroupMembers(api, id, ids)}
            max={LIMITS.groupMembers.bulkMax}
            stepUpAbove={LIMITS.groupMembers.stepUpAbove}
            selection={selection}
            onChanged={() => {
              refreshGroupMembers(queryClient, id);
            }}
          />
        ) : canWrite && editState !== 'editable' ? (
          <GroupMembersReadOnly reason={editState} />
        ) : null
      ) : null}
      {paging.restarted ? <StateNotice state={{ kind: 'cursorRestarted' }} /> : null}
      {body}
    </Section>
  );
}

export function GroupDetail() {
  usePageHeadingFocus();
  const translator = useTranslator();
  const { t } = translator;
  const { id } = route.useParams();
  const { api } = useRouterContext();
  const valid = isGuid(id);
  const query = useQuery({
    ...groupOptions(api, id),
    enabled: valid,
    refetchOnWindowFocus: false,
  });

  if (!valid) {
    return (
      <>
        <BackLink />
        <PageHeader title={t('groups.detail.title')} />
        <ErrorState
          headingLevel={2}
          title={t('groups.detail.error')}
          description={translateProblemCode(translator, 'not_found')}
        />
      </>
    );
  }

  const group = query.data;
  if (group === undefined) {
    return (
      <>
        <BackLink />
        <PageHeader title={t('groups.detail.title')} />
        {query.isError ? (
          <DirectoryError
            title={t('groups.detail.error')}
            error={query.error}
            retryLabel={t('groups.error.retry')}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : (
          <div
            aria-busy="true"
            aria-label={t('groups.detail.loading')}
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
    group.displayName === null || group.displayName === ''
      ? t('groups.unnamed')
      : group.displayName;
  const created = formatTimestamp(translator, group.createdDateTime);

  return (
    <>
      <BackLink />
      <PageHeader title={name} />
      <div className="flex flex-col gap-8">
        <Section heading={t('groups.detail.properties')}>
          <DefinitionList
            items={[
              {
                id: 'displayName',
                term: t('groups.field.displayName'),
                value: textOrDash(translator, group.displayName),
              },
              {
                id: 'description',
                term: t('groups.field.description'),
                value: textOrDash(translator, group.description),
              },
              {
                id: 'mail',
                term: t('groups.field.mail'),
                value: textOrDash(translator, group.mail),
              },
              {
                id: 'mailNickname',
                term: t('groups.field.mailNickname'),
                value: textOrDash(translator, group.mailNickname),
              },
              {
                id: 'kind',
                term: t('groups.field.kind'),
                value: <GroupKindBadge kind={group.kind} />,
              },
              {
                id: 'visibility',
                term: t('groups.field.visibility'),
                value:
                  group.visibility === null
                    ? textOrDash(translator, null)
                    : t(`groups.visibility.${group.visibility}`),
              },
              {
                id: 'membershipType',
                term: t('groups.field.membershipType'),
                value:
                  group.membershipType === null
                    ? textOrDash(translator, null)
                    : t(`groups.membership.${group.membershipType}`),
              },
              {
                id: 'synced',
                term: t('groups.field.synced'),
                value: yesNo(translator, group.onPremisesSyncEnabled),
              },
              {
                id: 'created',
                term: t('groups.field.created'),
                value: textOrDash(translator, created),
              },
            ]}
          />
          {isReadOnlyGroupKind(group.kind) ? (
            <StateNotice state={{ kind: 'readOnlyKind' }} />
          ) : null}
          {group.membershipType === 'dynamic' ? (
            <StateNotice state={{ kind: 'dynamicMembership' }} />
          ) : null}
        </Section>
        <Owners id={id} name={name} />
        <Members id={id} name={name} group={group} />
      </div>
    </>
  );
}
