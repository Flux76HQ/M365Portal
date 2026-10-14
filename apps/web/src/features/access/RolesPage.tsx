import type { MessageKey } from '@m365portal/shared/i18n';
import type { Assignment } from '@m365portal/shared/schemas/rbac';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '../../components/pages/PageHeader';
import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { Skeleton } from '../../components/ui/skeleton';
import { useToast } from '../../components/ui/toast';
import { useLanguage } from '../../lib/locale';
import { messageForError } from '../../lib/problem';
import { useMe, useRouterContext } from '../../lib/router-context';
import { LoadError } from '../setup/LoadError';
import { AssignRoleDialog } from './AssignRoleDialog';
import { ScopeText } from './ScopeText';
import {
  assignmentsOptions,
  principalNameOptions,
  refreshAssignments,
  removeAssignment,
  rolesOptions,
} from './roles-queries';

/**
 * `/settings/roles`, "Rollen en toegang" (Phase D3, FR-B-508, US-B12): the assignments of the panel, and the way to
 * give an existing user or group a role or take it away again. It needs `rbac:manage` (an Owner). The page offers;
 * the server decides: permission, step-up, no privilege escalation, the last Owner, and a group never gets a role
 * that manages access.
 */
export function RolesPage() {
  const { translator } = useLanguage();
  const { t, d } = translator;
  const me = useMe();
  const { api, queryClient } = useRouterContext();
  const { toast } = useToast();
  const [assigning, setAssigning] = useState(false);
  const [removing, setRemoving] = useState<{ assignment: Assignment; name: string } | null>(null);
  const [removeProblem, setRemoveProblem] = useState<string | null>(null);

  const roles = useQuery(rolesOptions(api));
  const assignments = useInfiniteQuery(assignmentsOptions(api));
  const remove = useMutation({
    mutationFn: (id: string) => removeAssignment(api, id),
    onSuccess: () => {
      toast({ title: t('access.admin.removed'), tone: 'success' });
      refreshAssignments(queryClient);
      setRemoving(null);
    },
    onError: (error) => {
      setRemoveProblem(messageForError(translator, error, { publicOrigin: me.publicOrigin }));
    },
  });

  const roleLabel = (assignment: Assignment): string =>
    assignment.role.builtin ? t(`role.${assignment.role.key}` as MessageKey) : assignment.role.key;

  let content;
  if (assignments.data === undefined) {
    content = assignments.isError ? (
      <LoadError
        title={t('access.admin.loadError')}
        error={assignments.error}
        retryLabel={t('access.admin.retry')}
        onRetry={() => {
          void assignments.refetch();
        }}
      />
    ) : (
      <div aria-busy="true" aria-label={t('access.admin.loading')} className="flex flex-col gap-4">
        <Skeleton height={48} />
        <Skeleton height={160} />
      </div>
    );
  } else {
    const pages = assignments.data.pages;
    const items = pages.flatMap((page) => page.assignments);
    const unresolvable = pages.some((page) => page.unresolvable.length > 0);
    const total = pages[0]?.total ?? items.length;
    content = (
      <div className="flex flex-col gap-4">
        {unresolvable ? (
          <Banner tone="warning" title={t('access.admin.title')}>
            {t('access.admin.unresolvable')}
          </Banner>
        ) : null}
        {items.length === 0 ? (
          <p className="text-body text-fg-secondary">{t('access.admin.empty')}</p>
        ) : (
          <>
            <p className="text-body-sm text-fg-muted">
              {t('access.admin.total', { count: total })}
            </p>
            <div className="overflow-x-auto rounded-lg border border-line-subtle">
              <table
                aria-label={t('access.admin.table')}
                className="w-full min-w-120 border-collapse text-start text-body"
              >
                <thead>
                  <tr className="border-b border-line-subtle bg-surface-page">
                    {(
                      [
                        'access.admin.column.principal',
                        'access.admin.column.role',
                        'access.admin.column.scope',
                        'access.admin.column.expires',
                        'access.admin.column.source',
                        'access.admin.column.actions',
                      ] as const
                    ).map((key) => (
                      <th
                        key={key}
                        scope="col"
                        className="px-3 py-2 text-start text-body-sm font-semibold text-fg-secondary"
                      >
                        {t(key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((assignment) => (
                    <AssignmentRow
                      key={assignment.id}
                      assignment={assignment}
                      roleLabel={roleLabel(assignment)}
                      expires={
                        assignment.expiresAt === null
                          ? t('access.assignment.noExpiry')
                          : d(Date.parse(assignment.expiresAt), { dateStyle: 'long' })
                      }
                      onRemove={(name) => {
                        setRemoveProblem(null);
                        setRemoving({ assignment, name });
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {assignments.hasNextPage ? (
          <div>
            <Button
              variant="secondary"
              disabled={assignments.isFetchingNextPage}
              onClick={() => {
                void assignments.fetchNextPage();
              }}
            >
              {t('access.admin.loadMore')}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <PageHeader title={t('access.admin.title')} description={t('access.admin.description')}>
        <div className="mt-4">
          <Button
            variant="primary"
            disabled={roles.data === undefined}
            onClick={() => {
              setAssigning(true);
            }}
          >
            {t('access.admin.assign')}
          </Button>
        </div>
      </PageHeader>
      {content}
      <AssignRoleDialog
        open={assigning}
        onOpenChange={setAssigning}
        roles={roles.data?.roles ?? []}
      />
      {removing === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          objectName={`${roleLabel(removing.assignment)}: ${removing.name}`}
          title={t('access.admin.remove.title')}
          description={removeProblem ?? t('access.admin.remove.description')}
          confirmLabel={t('access.admin.remove.confirm')}
          cancelLabel={t('access.admin.remove.cancel')}
          pending={remove.isPending}
          onConfirm={() => {
            remove.mutate(removing.assignment.id);
          }}
        />
      )}
    </>
  );
}

interface AssignmentRowProps {
  readonly assignment: Assignment;
  readonly roleLabel: string;
  readonly expires: string;
  readonly onRemove: (name: string) => void;
}

function AssignmentRow({ assignment, roleLabel, expires, onRemove }: AssignmentRowProps) {
  const { t } = useLanguage().translator;
  const { api } = useRouterContext();
  const lookup = useQuery(
    principalNameOptions(api, assignment.principalType, assignment.principalId),
  );
  const name =
    lookup.data?.name != null && lookup.data.name !== ''
      ? lookup.data.name
      : lookup.data?.found === false
        ? t('access.admin.principal.unknown')
        : assignment.principalId;
  return (
    <tr className="border-b border-line-subtle last:border-b-0">
      <td className="px-3 py-2 text-fg">
        <span className="block break-words">{name}</span>
        <span className="block text-body-sm text-fg-secondary">
          {t(`access.admin.principal.${assignment.principalType}`)}
        </span>
      </td>
      <td className="px-3 py-2 text-fg">{roleLabel}</td>
      <td className="px-3 py-2 text-fg-secondary">
        <ScopeText scope={assignment.scope} />
      </td>
      <td className="px-3 py-2 text-fg-secondary">{expires}</td>
      <td className="px-3 py-2 text-fg-secondary">
        {t(`access.admin.source.${assignment.source}`)}
      </td>
      <td className="px-3 py-2">
        <Button
          variant="destructive"
          size="sm"
          aria-label={t('access.admin.remove.label', { role: roleLabel, name })}
          onClick={() => {
            onRemove(name);
          }}
        >
          {t('access.admin.remove')}
        </Button>
      </td>
    </tr>
  );
}
