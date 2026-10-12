import { LIMITS } from '@m365portal/shared/limits';
import { BreakGlassResponseSchema } from '@m365portal/shared/schemas/auth';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { ApiError } from '../../lib/api';
import { useLanguage } from '../../lib/locale';
import { messageForError } from '../../lib/problem';
import { useMe, useRouterContext } from '../../lib/router-context';
import { useAuthRuntime } from './runtime';
import { useSecondsLeft } from './use-seconds-left';

function LockNote({ until }: { readonly until: number }) {
  const { t } = useLanguage().translator;
  const seconds = useSecondsLeft(until);
  return seconds > 0 ? (
    <p data-slot="break-glass-lock" className="text-body-sm text-fg-secondary">
      {t('breakglass.form.retryIn', { seconds })}
    </p>
  ) : null;
}

/**
 * The break-glass sign-in (FR-B-522, FR-B-607): a username and a password, a red warning in plain words, and
 * nothing else. The request goes through `lib/api` (Origin and CSRF); the answer carries the one address the
 * browser goes to (`/settings/restore-access`, checked by the schema), with a navigation so the page loads
 * with the new session. A refusal is one generic sentence (it never says which part was wrong); a lock shows
 * the wait from `Retry-After` as a countdown. The password is cleared as soon as it is sent.
 */
export function BreakGlassForm() {
  const { t } = useLanguage().translator;
  const translator = useLanguage().translator;
  const { api } = useRouterContext();
  const me = useMe();
  const { location } = useAuthRuntime();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [missing, setMissing] = useState({ username: false, password: false });
  const [lockedUntil, setLockedUntil] = useState(0);
  const alertRef = useRef<HTMLDivElement>(null);
  const seconds = useSecondsLeft(lockedUntil);
  const locked = seconds > 0;

  const signIn = useMutation({
    mutationFn: (credentials: { username: string; password: string }) =>
      api.post('/api/v1/auth/break-glass', { body: credentials, schema: BreakGlassResponseSchema }),
    onSuccess: (answer) => {
      location.assign(answer.redirect);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'break_glass_locked') {
        setLockedUntil(Date.now() + (error.retryAfterSeconds ?? 1) * 1000);
      }
      queueMicrotask(() => alertRef.current?.focus());
    },
  });

  const error = signIn.error;
  const errorText =
    error === null
      ? null
      : error instanceof ApiError && error.code === 'unauthenticated'
        ? t('breakglass.form.invalid')
        : messageForError(translator, error, { publicOrigin: me.publicOrigin });

  const submit = (): void => {
    const next = { username: username.trim() === '', password: password === '' };
    setMissing(next);
    if (next.username || next.password || locked || signIn.isPending) return;
    const credentials = { username: username.trim(), password };
    setPassword('');
    signIn.mutate(credentials);
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Banner tone="danger" title={t('breakglass.form.warningLabel')} className="rounded-md border border-line-subtle">
        {t('breakglass.form.warning', { minutes: LIMITS.breakGlass.sessionMinutes })}
      </Banner>
      {errorText === null ? null : (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="rounded-md border border-s-4 border-line-subtle border-s-danger bg-surface-raised p-3 text-body text-fg outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
        >
          {errorText}
        </div>
      )}
      <LockNote until={lockedUntil} />
      <FormField label={t('breakglass.form.username')} {...(missing.username ? { error: t('breakglass.form.required') } : {})}>
        {(control) => (
          <Input
            {...control}
            name="break-glass-username"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
          />
        )}
      </FormField>
      <FormField label={t('breakglass.form.password')} {...(missing.password ? { error: t('breakglass.form.required') } : {})}>
        {(control) => (
          <Input
            {...control}
            type="password"
            name="break-glass-password"
            autoComplete="off"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        )}
      </FormField>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={locked || signIn.isPending}>
          {signIn.isPending ? t('breakglass.form.submitting') : t('breakglass.form.submit')}
        </Button>
        <Link to="/signin" className="inline-flex min-h-target items-center rounded-sm text-accent-text underline underline-offset-4 hover:bg-accent-subtle">
          {t('breakglass.form.normalSignIn')}
        </Link>
      </div>
    </form>
  );
}
