import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { ApiError, type ApiClient } from '../../lib/api';
import { useTranslator } from '../../lib/locale';
import { messageForError } from '../../lib/problem';
import { useMe } from '../../lib/router-context';
import { useSecondsLeft } from '../auth/use-seconds-left';
import { setupApi } from './setup-api';

export interface TokenFormProps {
  readonly api: ApiClient;
  /** The setup session is open; the wizard takes over. */
  readonly onUnlocked: () => void;
}

/** The text of a counter that reaches zero, as the unlock form shows it. */
function LockedNote({ until }: { readonly until: number }) {
  const { t } = useTranslator();
  const seconds = useSecondsLeft(until);
  return seconds > 0 ? (
    <p data-slot="token-locked" className="text-body-sm text-fg-secondary">
      {t('setup.token.retryIn', { seconds })}
    </p>
  ) : null;
}

/**
 * The setup token form (T-B-300; FR-B-203, FR-B-204): one password-type field, so the browser neither shows
 * nor autofills the token, and one button. A wrong token gets the generic message (never a hint about what
 * was wrong); a lock gets the wait from `Retry-After` as a countdown and the button stays disabled until
 * it ends. A finished wizard (409) points to the sign-in. The token is cleared as soon as it is sent.
 */
export function TokenForm({ api, onUnlocked }: TokenFormProps) {
  const { t } = useTranslator();
  const me = useMe();
  const input = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState('');
  const [lockedUntil, setLockedUntil] = useState(0);
  const unlock = useMutation({
    mutationFn: (value: string) => setupApi(api).unlock(value),
    onSuccess: () => {
      setToken('');
      onUnlocked();
    },
    onError: (error) => {
      setToken('');
      if (error instanceof ApiError && error.code === 'setup_token_locked') {
        setLockedUntil(Date.now() + (error.retryAfterSeconds ?? 1) * 1000);
      }
      input.current?.focus();
    },
  });
  const seconds = useSecondsLeft(lockedUntil);
  const locked = seconds > 0;

  const error = unlock.error;
  const finished = error instanceof ApiError && error.code === 'setup_step_not_ready';
  const errorText =
    error === null || finished ? undefined : messageForError({ t }, error, { publicOrigin: me.publicOrigin });

  return (
    <form
      className="flex max-w-md flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (token === '' || locked || unlock.isPending) return;
        unlock.mutate(token);
      }}
    >
      <p className="text-body text-fg-secondary">{t('setup.token.lead')}</p>
      {finished ? (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-s-4 border-line-subtle border-s-info bg-surface-raised p-4">
          <p className="text-fg">{t('setup.token.finished')}</p>
          <Button asChild variant="primary" className="self-start">
            <a href="/auth/login">{t('setup.finish.signIn')}</a>
          </Button>
        </div>
      ) : null}
      <FormField
        label={t('setup.token.label')}
        hint={t('setup.token.help')}
        {...(errorText === undefined ? {} : { error: errorText })}
      >
        {(control) => (
          <Input
            {...control}
            ref={input}
            type="password"
            name="setup-token"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
            }}
          />
        )}
      </FormField>
      <LockedNote until={lockedUntil} />
      <Button
        type="submit"
        variant="primary"
        className="self-start"
        disabled={token === '' || locked || unlock.isPending}
      >
        {unlock.isPending ? t('setup.token.submitting') : t('setup.token.submit')}
      </Button>
    </form>
  );
}
