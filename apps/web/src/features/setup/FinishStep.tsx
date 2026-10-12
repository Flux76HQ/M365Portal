import { GroupSearchQuerySchema } from '@m365portal/shared/schemas/setup';
import { useMutation } from '@tanstack/react-query';
import { lazy, Suspense, useId, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { RadioGroup, RadioOption } from '../../components/ui/radio-group';
import { Skeleton } from '../../components/ui/skeleton';
import { APPEARANCE_NAMESPACES, loadLazyNamespaces, useLanguage } from '../../lib/locale';
import { ProofList } from '../connection/ProofList';
import { ActionError, StepFrame } from './StepFrame';
import { ExchangeNotice } from './VerifyStep';
import { setupApi, type SetupStateResponse } from './setup-api';
import type { StepProps } from './steps';
import { stepOf } from './wizard-context';

// The form and its text are one chunk: the catalogues load before the form renders.
const AppearanceSection = lazy(async () => {
  await loadLazyNamespaces(APPEARANCE_NAMESPACES);
  return import('./AppearanceSection');
});

type Owner = NonNullable<SetupStateResponse['designatedOwner']>;
const ownerName = (owner: Owner): string => owner.nameLabel ?? owner.upnLabel ?? owner.oid;

/**
 * Step 5 (FR-B-219): the last choices and the hand-over. The Owner is the person the server designated (the
 * page shows who and asks for a confirmation that the finish sends back), the language is the default for
 * visitors without a choice, and a group of administrators is optional and only ever searched, never created.
 * The Appearance form of Phase A can be filled in here or skipped. "Finish" is a write; "Sign in" afterwards is
 * a link, a navigation to the sign-in.
 */
export function FinishStep({ context, focus }: StepProps) {
  const { translator, language } = useLanguage();
  const { t } = translator;
  const { state } = context;
  const step = stepOf(context, 'finish');
  const owner = state.designatedOwner;
  const confirmId = useId();
  const [lang, setLang] = useState<'nl' | 'en'>(state.defaultLanguage ?? language);
  const [confirmed, setConfirmed] = useState(false);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<{ id: string; name: string } | null>(null);
  const [skipAppearance, setSkipAppearance] = useState(false);

  const search = useMutation({
    mutationFn: (q: string) => setupApi(context.api).searchGroups(q),
  });
  const finish = useMutation({
    mutationFn: () => {
      if (owner === null) throw new Error('no designated owner');
      return setupApi(context.api).finish({
        confirmOwnerOid: owner.oid,
        language: lang,
        ...(group === null ? {} : { beheerderGroupId: group.id }),
      });
    },
    onSuccess: () => {
      context.refresh();
    },
  });

  const runSearch = (): void => {
    const q = query.trim();
    if (!GroupSearchQuerySchema.safeParse({ q }).success) return;
    search.mutate(q);
  };

  const finished = finish.data !== undefined || state.state === 'awaiting_first_signin' || step.status === 'succeeded';
  if (finished) {
    const name = owner === null ? '-' : ownerName(owner);
    return (
      <StepFrame step="finish" context={context} focus={focus} title={t('setup.finish.title')} subActions={false}>
        <div role="status" className="flex flex-col gap-3 rounded-lg border border-s-4 border-line-subtle border-s-success bg-surface-raised p-4">
          <p className="text-subtitle font-semibold text-fg">{t('setup.finish.done.title')}</p>
          <p className="text-body text-fg-secondary">{t('setup.finish.done.message', { name })}</p>
          <Button asChild variant="primary" className="self-start">
            <a href={finish.data?.signinUrl ?? '/auth/login?returnTo=%2F'}>{t('setup.finish.signIn')}</a>
          </Button>
        </div>
      </StepFrame>
    );
  }

  return (
    <StepFrame step="finish" context={context} focus={focus} title={t('setup.finish.title')} subActions={false}>
      <ExchangeNotice context={context} />

      <section aria-labelledby="finish-owner" className="flex flex-col gap-2">
        <h3 id="finish-owner" className="text-subtitle font-semibold text-fg">
          {t('setup.finish.owner.title')}
        </h3>
        {owner === null ? (
          <p className="text-body text-fg-secondary">{t('setup.finish.owner.unknown')}</p>
        ) : (
          <>
            <p className="text-body text-fg">{t('setup.finish.owner.message', { name: ownerName(owner) })}</p>
            <div className="flex items-start gap-2">
              <Checkbox
                id={confirmId}
                checked={confirmed}
                onCheckedChange={(value) => {
                  setConfirmed(value === true);
                }}
              />
              <label htmlFor={confirmId} className="pt-0.5 text-body text-fg">
                {t('setup.finish.owner.confirm')}
              </label>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="finish-language" className="flex flex-col gap-2">
        <h3 id="finish-language" className="text-subtitle font-semibold text-fg">
          {t('setup.finish.language.label')}
        </h3>
        <p className="text-body-sm text-fg-muted">{t('setup.finish.language.help')}</p>
        <RadioGroup
          aria-labelledby="finish-language"
          value={lang}
          onValueChange={(value) => {
            if (value === 'nl' || value === 'en') setLang(value);
          }}
        >
          <RadioOption value="nl" label={t('setup.finish.language.nl')} />
          <RadioOption value="en" label={t('setup.finish.language.en')} />
        </RadioGroup>
      </section>

      <section className="flex max-w-md flex-col gap-2">
        {group === null ? (
          <>
            <FormField label={t('setup.finish.group.label')} hint={t('setup.finish.group.help')}>
              {(control) => (
                <Input
                  {...control}
                  value={query}
                  autoComplete="off"
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      runSearch();
                    }
                  }}
                />
              )}
            </FormField>
            <Button variant="secondary" className="self-start" disabled={search.isPending || query.trim() === ''} onClick={runSearch}>
              {search.isPending ? t('setup.finish.group.searching') : t('setup.finish.group.search')}
            </Button>
            {search.isError ? <ActionError error={search.error} /> : null}
            {search.data === undefined ? null : search.data.groups.length === 0 ? (
              <p role="status" className="text-body-sm text-fg-secondary">{t('setup.finish.group.none')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {search.data.groups.map((candidate) => (
                  <li key={candidate.id}>
                    <Button
                      variant="ghost"
                      className="w-full justify-start"
                      onClick={() => {
                        setGroup({ id: candidate.id, name: candidate.displayName });
                      }}
                    >
                      {candidate.displayName}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p role="status" className="text-body text-fg">{t('setup.finish.group.selected', { name: group.name })}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setGroup(null);
              }}
            >
              {t('setup.finish.group.clear')}
            </Button>
          </div>
        )}
      </section>

      {skipAppearance ? null : (
        <section aria-labelledby="finish-appearance" className="flex flex-col gap-2">
          <h3 id="finish-appearance" className="text-subtitle font-semibold text-fg">
            {t('setup.finish.appearance.title')}
          </h3>
          <p className="text-body-sm text-fg-muted">{t('setup.finish.appearance.help')}</p>
          <Suspense fallback={<Skeleton height={240} />}>
            <AppearanceSection api={context.api} />
          </Suspense>
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => {
              setSkipAppearance(true);
            }}
          >
            {t('setup.finish.appearance.skip')}
          </Button>
        </section>
      )}

      <section aria-labelledby="finish-summary" className="flex flex-col gap-2">
        <h3 id="finish-summary" className="text-subtitle font-semibold text-fg">
          {t('setup.finish.summary')}
        </h3>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-body">
          <dt className="text-fg-secondary">{t('setup.finish.summary.tenant')}</dt>
          <dd className="text-fg">{state.tenant.name ?? state.tenant.initialDomain ?? state.tenant.tenantId ?? '-'}</dd>
          <dt className="text-fg-secondary">{t('setup.finish.summary.application')}</dt>
          <dd className="text-fg">{state.application?.displayName ?? '-'}</dd>
          <dt className="text-fg-secondary">{t('setup.finish.summary.mode')}</dt>
          <dd className="text-fg">{t(`setup.finish.mode.${state.mode}`)}</dd>
        </dl>
        <ProofList proof={state.proof} application={state.application} tenant={state.tenant} />
      </section>

      {finish.isError ? <ActionError error={finish.error} /> : null}
      <Button
        variant="primary"
        className="self-start"
        disabled={owner === null || !confirmed || finish.isPending}
        onClick={() => {
          finish.mutate();
        }}
      >
        {finish.isPending ? t('setup.finish.submitting') : t('setup.finish.submit')}
      </Button>
    </StepFrame>
  );
}
