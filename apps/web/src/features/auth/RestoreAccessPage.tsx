import { GuidSchema } from '@m365portal/shared/schemas/common';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '../../components/pages/PageHeader';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { ApiError } from '../../lib/api';
import { useLanguage } from '../../lib/locale';
import { useMe, useRouterContext } from '../../lib/router-context';
import { errorText } from '../setup/hints';
import { ActionError } from '../setup/StepFrame';
import { useSignOut } from './use-sign-out';

/**
 * `/settings/restore-access` (FR-B-523, US-B10): the one thing a break-glass session can change. It gives
 * the Owner role back to a person, by the object id of their Microsoft Entra account. The server checks that
 * the account exists and is enabled; when Microsoft cannot be reached it says so and the operator may
 * confirm the id without that check (the audit log records that it was unchecked). Afterwards the session
 * should end: the person signs in with their own account.
 */
export function RestoreAccessPage() {
  const { translator } = useLanguage();
  const { t } = translator;
  const { api } = useRouterContext();
  const me = useMe();
  const signOut = useSignOut();
  const [userId, setUserId] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [unverified, setUnverified] = useState(false);

  const restore = useMutation({
    mutationFn: (request: { userId: string; confirmUnverified?: true }) =>
      api.post('/api/v1/rbac/restore-owner', { body: request }),
    onSuccess: () => {
      setUnverified(false);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'graph_unavailable') setUnverified(true);
    },
  });

  const id = userId.trim().toLowerCase();
  const send = (confirmUnverified: boolean): void => {
    if (!GuidSchema.safeParse(id).success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    restore.mutate(confirmUnverified ? { userId: id, confirmUnverified: true } : { userId: id });
  };

  const unverifiedDialog = unverified && GuidSchema.safeParse(id).success;
  const showError = restore.isError && !unverified;

  return (
    <>
      <PageHeader
        title={t('breakglass.restore.title')}
        description={t('breakglass.restore.lead')}
      />
      {restore.isSuccess ? (
        <div
          role="status"
          className="flex max-w-xl flex-col gap-3 rounded-lg border border-s-4 border-line-subtle border-s-success bg-surface-raised p-4"
        >
          <p className="text-body text-fg">{t('breakglass.restore.done')}</p>
          <Button
            variant="primary"
            className="self-start"
            onClick={() => {
              void signOut(false);
            }}
          >
            {t('breakglass.restore.signOut')}
          </Button>
        </div>
      ) : (
        <form
          noValidate
          className="flex max-w-xl flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            send(false);
          }}
        >
          <FormField
            label={t('breakglass.restore.field')}
            hint={t('breakglass.restore.fieldHelp')}
            {...(invalid ? { error: t('breakglass.restore.invalidId') } : {})}
          >
            {(control) => (
              <Input
                {...control}
                name="user-id"
                autoComplete="off"
                spellCheck={false}
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value);
                }}
              />
            )}
          </FormField>
          {showError ? (
            <div
              role="alert"
              className="rounded-md border border-s-4 border-line-subtle border-s-danger bg-surface-raised p-3 text-body text-fg"
            >
              {errorText(translator, restore.error, me.publicOrigin)}
            </div>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            className="self-start"
            disabled={restore.isPending}
          >
            {restore.isPending
              ? t('breakglass.restore.submitting')
              : t('breakglass.restore.submit')}
          </Button>
        </form>
      )}
      {restore.isError && unverified ? <ActionError error={restore.error} /> : null}
      {unverifiedDialog ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setUnverified(false);
              send(false);
            }
          }}
          objectName={id}
          title={t('breakglass.restore.unverified.title')}
          description={t('breakglass.restore.unverified.message')}
          confirmLabel={t('breakglass.restore.unverified.confirm')}
          cancelLabel={t('breakglass.restore.unverified.retry')}
          onConfirm={() => {
            send(true);
          }}
          pending={restore.isPending}
        />
      ) : null}
    </>
  );
}
