// The dialog that gives an existing user or group a role (Phase D3, FR-B-508, US-B12). The person types a name,
// picks one result, picks a role and optionally the last day. Nothing here decides anything: the server checks the
// permission, the step-up, that the actor could hold the role themselves, that a group gets no privileged role and
// that the principal exists, and answers with a problem code the dialog shows in words. A step-up is asked for by
// the app shell and the write is then sent again by the person.
import type { MessageKey } from '@m365portal/shared/i18n';
import type { Role } from '@m365portal/shared/schemas/rbac';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { useToast } from '../../components/ui/toast';
import { useTranslator } from '../../lib/locale';
import { messageForError } from '../../lib/problem';
import { useMe, useRouterContext } from '../../lib/router-context';
import { searchText } from '../directory/search';
import {
  assignRole,
  refreshAssignments,
  searchPrincipals,
  type PrincipalCandidate,
} from './roles-queries';

/** The pause after the last key before the search runs. */
const SEARCH_DEBOUNCE_MS = 300;
/** `expiresAt` is at most this many days ahead (the server's limit). */
const EXPIRY_MAX_DAYS = 730;
/** A group cannot get a role that holds one of these (FR-B-515): the server refuses it, the list leaves it out. */
const NO_GROUP_PERMISSIONS: readonly string[] = ['rbac:manage', 'settings:connection'];

export interface AssignRoleDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly roles: readonly Role[];
}

type PrincipalType = 'user' | 'group';

export type Expiry = { readonly ok: true; readonly value: string | null } | { readonly ok: false };

/** The end of the chosen day, UTC: `value` is `null` for an empty field; not ok when in the past or too far ahead. */
export function expiryOf(day: string, now: number = Date.now()): Expiry {
  if (day === '') return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false };
  const at = Date.parse(`${day}T23:59:59.999Z`);
  if (Number.isNaN(at) || at <= now || at > now + EXPIRY_MAX_DAYS * 86_400_000)
    return { ok: false };
  return { ok: true, value: new Date(at).toISOString() };
}

export function AssignRoleDialog({ open, onOpenChange, roles }: AssignRoleDialogProps) {
  const translator = useTranslator();
  const { t } = translator;
  const me = useMe();
  const { api, queryClient } = useRouterContext();
  const { toast } = useToast();
  const [type, setType] = useState<PrincipalType>('user');
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState<string | undefined>(undefined);
  const [chosen, setChosen] = useState<PrincipalCandidate | null>(null);
  const [roleKey, setRoleKey] = useState('');
  const [day, setDay] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // Opened again: an empty form, adjusted while rendering.
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) {
      setType('user');
      setDraft('');
      setApplied(undefined);
      setChosen(null);
      setRoleKey('');
      setDay('');
      setProblem(null);
      setSubmitted(false);
    }
  }

  // The text is applied after the last key, not on every key (one request per pause).
  useEffect(() => {
    const next = searchText(draft);
    const text = next !== undefined && Array.from(next).length >= 2 ? next : undefined;
    if (text === applied) return undefined;
    const timer = setTimeout(() => {
      setApplied(text);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, applied]);

  const results = useQuery({
    queryKey: ['rbac', 'principal-search', type, applied ?? null],
    queryFn: ({ signal }) => searchPrincipals(api, type, applied ?? '', signal),
    enabled: open && applied !== undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const assignable = roles.filter(
    (role) =>
      role.assignable &&
      (type === 'user' ||
        !role.permissions.some((grant) => NO_GROUP_PERMISSIONS.includes(grant.permission))),
  );
  const role = assignable.find((candidate) => candidate.key === roleKey);
  const expires: Expiry = role?.key === 'owner' ? { ok: true, value: null } : expiryOf(day);

  const mutation = useMutation({
    mutationFn: (body: Parameters<typeof assignRole>[1]) => assignRole(api, body),
    onSuccess: () => {
      toast({ title: t('access.admin.assigned'), tone: 'success' });
      refreshAssignments(queryClient);
      onOpenChange(false);
    },
    onError: (error) => {
      setProblem(messageForError(translator, error, { publicOrigin: me.publicOrigin }));
    },
  });

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    setProblem(null);
    setSubmitted(true);
    if (chosen === null || role === undefined || !expires.ok) return;
    mutation.mutate({
      principalType: type,
      principalId: chosen.id,
      role: role.key,
      ...(expires.value === null ? {} : { expiresAt: expires.value }),
    });
  }

  const roleLabel = (candidate: Role): string =>
    candidate.builtin ? t(`role.${candidate.key}` as MessageKey) : candidate.key;
  const nameOf = (candidate: PrincipalCandidate): string => {
    const name = candidate.displayName ?? '';
    return name === '' ? (candidate.mail ?? t('access.admin.dialog.unnamed')) : name;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('access.admin.dialog.title')}
      description={t('access.admin.dialog.description')}
      closeLabel={t('access.admin.dialog.close')}
      size="md"
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('access.admin.dialog.cancel')}
          </Button>
          <Button
            type="submit"
            form="assign-role-form"
            variant="primary"
            disabled={mutation.isPending}
            aria-disabled={mutation.isPending}
          >
            {t('access.admin.dialog.submit')}
          </Button>
        </>
      }
    >
      <form id="assign-role-form" noValidate onSubmit={submit} className="flex flex-col gap-4">
        {problem === null ? null : (
          <p
            role="alert"
            className="rounded-md border border-danger px-3 py-2 text-body text-danger"
          >
            {problem}
          </p>
        )}
        <fieldset className="flex flex-col gap-1">
          <legend className="text-body font-medium text-fg">
            {t('access.admin.dialog.principalType')}
          </legend>
          <div className="flex gap-6">
            {(['user', 'group'] as const).map((kind) => (
              <label key={kind} className="flex min-h-control items-center gap-2 text-body text-fg">
                <input
                  type="radio"
                  name="principal-type"
                  value={kind}
                  checked={type === kind}
                  onChange={() => {
                    setType(kind);
                    setChosen(null);
                    setRoleKey('');
                  }}
                />
                {t(`access.admin.principal.${kind}`)}
              </label>
            ))}
          </div>
        </fieldset>

        <FormField
          label={t('access.admin.dialog.search')}
          hint={t('access.admin.dialog.searchHint')}
          error={submitted && chosen === null ? t('access.admin.dialog.pickFirst') : undefined}
        >
          {(control) => (
            <Input
              {...control}
              type="search"
              autoComplete="off"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
          )}
        </FormField>
        {chosen === null ? null : (
          <p className="text-body text-fg" data-slot="chosen-principal">
            {t('access.admin.dialog.chosen', { name: nameOf(chosen) })}
          </p>
        )}
        {applied === undefined ? null : (
          <div aria-live="polite" className="flex flex-col gap-1">
            {results.isFetching ? (
              <p className="text-body-sm text-fg-muted">{t('access.admin.dialog.searching')}</p>
            ) : results.isError ? (
              <p className="text-body-sm text-danger">
                {messageForError(translator, results.error, { publicOrigin: me.publicOrigin })}
              </p>
            ) : results.data?.length === 0 ? (
              <p className="text-body-sm text-fg-muted">{t('access.admin.dialog.noResults')}</p>
            ) : (
              <ul
                aria-label={t('access.admin.dialog.results')}
                className="flex flex-col overflow-y-auto rounded-md border border-line-subtle"
              >
                {(results.data ?? []).map((candidate) => (
                  <li key={candidate.id} className="border-b border-line-subtle last:border-b-0">
                    <button
                      type="button"
                      aria-pressed={chosen?.id === candidate.id}
                      onClick={() => {
                        setChosen(candidate);
                        setRoleKey('');
                      }}
                      className={`flex min-h-control w-full flex-col items-start px-3 py-1 text-start hover:bg-accent-subtle ${chosen?.id === candidate.id ? 'bg-accent-subtle' : ''}`}
                    >
                      <span className="text-body text-fg">{nameOf(candidate)}</span>
                      {candidate.mail === null || candidate.mail === nameOf(candidate) ? null : (
                        <span className="text-body-sm text-fg-secondary">{candidate.mail}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <FormField
          label={t('access.admin.dialog.role')}
          hint={type === 'group' ? t('access.admin.dialog.groupRoleHint') : undefined}
          error={
            submitted && role === undefined ? t('access.admin.dialog.roleRequired') : undefined
          }
        >
          {(control) => (
            <select
              {...control}
              className="h-control rounded-md border border-line-control bg-surface-raised px-3 text-body text-fg"
              value={roleKey}
              onChange={(event) => {
                setRoleKey(event.target.value);
              }}
            >
              <option value="">{t('access.admin.dialog.rolePlaceholder')}</option>
              {assignable.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>
                  {roleLabel(candidate)}
                </option>
              ))}
            </select>
          )}
        </FormField>

        <FormField
          label={t('access.admin.dialog.expires')}
          hint={t('access.admin.dialog.expiresHint')}
          error={submitted && !expires.ok ? t('access.admin.dialog.expiresInvalid') : undefined}
        >
          {(control) => (
            <Input
              {...control}
              type="date"
              value={role?.key === 'owner' ? '' : day}
              disabled={role?.key === 'owner'}
              onChange={(event) => {
                setDay(event.target.value);
              }}
            />
          )}
        </FormField>
      </form>
    </Dialog>
  );
}
