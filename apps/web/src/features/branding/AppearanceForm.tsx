import { zodResolver } from '@hookform/resolvers/zod';
import { DownloadIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { OfflineState, useOfflineSave } from '../../components/shell/OfflineState';
import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { useToast } from '../../components/ui/toast';
import { type ApiClient, ApiError } from '../../lib/api';
import { isolatedMessage } from '../../lib/isolate';
import { useTranslator } from '../../lib/locale';
import { messageForError, translateProblemCode } from '../../lib/problem';
import { brandingQueryOptions, queryKeys } from '../../lib/query';
import { useMe, useRouterContext } from '../../lib/router-context';
import { AccentPicker } from './AccentPicker';
import { ImportPanel } from './ImportPanel';
import { LivePreview } from './LivePreview';
import { LogoSlots } from './LogoSlot';
import { BRANDING_EXPORT_PATH, isBrandingConflict } from './api';
import { useApplyBranding, useResetBranding } from './queries';
import {
  ACCENT_ISSUE,
  ORG_NAME_ISSUE,
  createAppearanceSchema,
  isDirty,
  requestOf,
  requestOfBranding,
  valuesOf,
  type AppearanceValues,
} from './schema';
import type { BrandingTools } from './tools';
import type { Branding, LogoVariant } from './types';
import { useUnsavedGuard } from './use-unsaved-guard';

// The Appearance form (T-A-214; FR-A-132, FR-A-133, FR-A-134; US-2).
//
// The form is based on one saved branding, `baseline`: the revision it was loaded at, which `If-Match`
// carries. It changes only when this page saved, reset or imported (the server's answer), or when the
// person asks to load the latest. If the cache gets a newer revision from elsewhere while the form has
// edits, nothing is replaced: the conflict message appears at once, before the person saves. If the form
// has no edits, the newer revision is simply adopted.
//
// Offline: every button that sends something is off while `useOfflineSave` says so; nothing is queued.
// Undo (FR-A-133) re-applies the previous values through the revision the change produced, so a change
// someone else saved in between is answered with a conflict and not overwritten.

const UNDO_TOAST_MS = 15_000;

export interface AppearanceFormProps {
  /** The branding in the cache. */
  readonly branding: Branding;
  readonly tools: BrandingTools;
  readonly api: ApiClient;
}

export function AppearanceForm({ branding, tools, api }: AppearanceFormProps) {
  const { t } = useTranslator();
  const { queryClient } = useRouterContext();
  const me = useMe();
  const { toast } = useToast();
  const apply = useApplyBranding(api);
  const { mutateAsync: applyAsync } = apply;
  const reset = useResetBranding(api);

  const [baseline, setBaseline] = useState(branding);
  const [compactDerived, setCompactDerived] = useState(branding.compactDerived);
  const [conflictSeen, setConflictSeen] = useState(false);
  const [lastError, setLastError] = useState<unknown>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  // True from the moment this page sends a change until it has taken the answer over, so that the
  // answer landing in the cache is not mistaken for somebody else's change.
  const [writing, setWriting] = useState(false);
  const save = useOfflineSave(lastError);

  const baselineValues = useMemo(() => valuesOf(baseline), [baseline]);
  const schema = useMemo(() => createAppearanceSchema(tools), [tools]);
  const form = useForm<AppearanceValues>({
    resolver: zodResolver(schema),
    mode: 'onChange',
    defaultValues: valuesOf(branding),
    // The form follows the baseline: adopting a newer revision resets it to that revision's values.
    values: baselineValues,
  });
  const values = useWatch({ control: form.control }) as AppearanceValues;
  const dirty = isDirty(values, baseline, compactDerived, tools);
  const objectName = t('appearance.object', { name: baseline.orgName });
  // The organisation name is typed text: in the sentence it sits in a <bdi> (E-07, defect D-3).
  const objectContent = isolatedMessage(t, 'appearance.object', undefined, {
    name: baseline.orgName,
  });
  const guardDialog = useUnsavedGuard({ dirty, objectName, objectContent });

  const adopt = useCallback(
    (next: Branding) => {
      setBaseline(next);
      setCompactDerived(next.compactDerived);
      setConflictSeen(false);
      form.reset(valuesOf(next));
    },
    [form],
  );

  // A newer revision in the cache: with edits on the page it is a conflict, shown before the person
  // saves; without edits there is nothing to lose and it is adopted (the form follows `baseline`).
  const newerElsewhere = !writing && branding.revision > baseline.revision;
  const conflict = conflictSeen || (newerElsewhere && dirty);
  if (newerElsewhere && !dirty) {
    setBaseline(branding);
    setCompactDerived(branding.compactDerived);
  }

  const fail = useCallback(
    (error: unknown) => {
      setLastError(error);
      if (isBrandingConflict(error)) setConflictSeen(true);
      if (error instanceof ApiError && error.code === ORG_NAME_ISSUE) {
        form.setError('orgName', { type: 'server', message: ORG_NAME_ISSUE });
      }
      if (error instanceof ApiError && error.code === ACCENT_ISSUE) {
        form.setError('accent', { type: 'server', message: ACCENT_ISSUE });
      }
      toast({
        tone: 'error',
        title: t('appearance.failed'),
        description: messageForError({ t }, error, { publicOrigin: me.publicOrigin }),
      });
    },
    [form, me.publicOrigin, t, toast],
  );

  /** Re-applies a saved branding on top of the revision a change produced (Undo). */
  const undo = useCallback(
    async (previous: Branding, revision: number) => {
      setLastError(null);
      setWriting(true);
      try {
        const restored = await applyAsync({
          request: requestOfBranding(previous),
          revision,
        });
        adopt(restored);
        toast({ tone: 'success', title: t('appearance.undone') });
      } catch (error) {
        fail(error);
      } finally {
        setWriting(false);
      }
    },
    [applyAsync, adopt, fail, t, toast],
  );

  const offerUndo = useCallback(
    (title: string, previous: Branding, next: Branding) => {
      toast({
        tone: 'success',
        title,
        duration: UNDO_TOAST_MS,
        action: {
          label: t('appearance.undo'),
          altText: t('appearance.undoAlt'),
          onAction: () => {
            void undo(previous, next.revision);
          },
        },
      });
    },
    [t, toast, undo],
  );

  const submit = form.handleSubmit(async (submitted) => {
    setLastError(null);
    const previous = baseline;
    setWriting(true);
    try {
      const next = await apply.mutateAsync({
        request: requestOf(submitted, compactDerived),
        revision: baseline.revision,
      });
      adopt(next);
      offerUndo(t('appearance.saved'), previous, next);
    } catch (error) {
      fail(error);
    } finally {
      setWriting(false);
    }
  });

  async function resetToDefaults(): Promise<void> {
    setLastError(null);
    const previous = baseline;
    setWriting(true);
    try {
      const next = await reset.mutateAsync({ revision: baseline.revision });
      adopt(next);
      setConfirmReset(false);
      offerUndo(t('appearance.reset.done'), previous, next);
    } catch (error) {
      setConfirmReset(false);
      fail(error);
    } finally {
      setWriting(false);
    }
  }

  async function loadLatest(): Promise<void> {
    setLastError(null);
    try {
      const latest = await queryClient.query({
        ...brandingQueryOptions(api),
        staleTime: 0,
      });
      queryClient.setQueryData(queryKeys.branding, latest);
      adopt(latest);
      toast({ tone: 'info', title: t('appearance.conflict.reloaded') });
    } catch (error) {
      fail(error);
    }
  }

  function setLogo(variant: LogoVariant, asset: AppearanceValues['logos'][LogoVariant]): void {
    form.setValue(`logos.${variant}`, asset, { shouldDirty: true });
    if (variant === 'compact') {
      setCompactDerived(false);
    } else if (compactDerived) {
      // The derived compact logo belongs to the old main logo; the server makes a new one on save.
      form.setValue('logos.compact', null, { shouldDirty: true });
    }
  }

  const busy = apply.isPending || reset.isPending;
  const sendingOff = save.saveDisabled || conflict;
  const nameError = form.formState.errors.orgName?.message;
  const accentError = form.formState.errors.accent;
  const translated = (code: string | undefined): string | undefined =>
    code === undefined ? undefined : translateProblemCode({ t }, code);

  return (
    <div className="flex flex-col gap-8">
      <OfflineState
        save={save}
        onRetry={() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.branding });
        }}
      />

      {conflict ? (
        <Banner
          tone="warning"
          title={t('appearance.conflict.title')}
          action={
            <Button
              size="sm"
              onClick={() => {
                void loadLatest();
              }}
            >
              {t('appearance.conflict.reload')}
            </Button>
          }
        >
          {t('appearance.conflict.description')}
        </Banner>
      ) : null}

      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="flex flex-col gap-8"
      >
        <FormField
          label={t('appearance.name.label')}
          hint={t('appearance.name.hint')}
          {...(nameError === undefined ? {} : { error: translated(nameError) ?? nameError })}
          className="max-w-xl"
        >
          {(control) => (
            <Input
              {...control}
              {...form.register('orgName')}
              autoComplete="organization"
              spellCheck={false}
              disabled={busy}
            />
          )}
        </FormField>

        <AccentPicker
          value={values.accent}
          disabled={busy}
          {...(accentError?.type === 'server'
            ? { error: translated(accentError.message) ?? '' }
            : {})}
          onChange={(next) => {
            form.clearErrors('accent');
            form.setValue('accent', next, { shouldDirty: true, shouldValidate: true });
          }}
        />

        <LogoSlots
          value={values.logos}
          compactDerived={compactDerived && values.logos.compact !== null}
          disabled={busy}
          api={api}
          onChange={setLogo}
        />

        <LivePreview orgName={values.orgName} accent={values.accent} logos={values.logos} />

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            disabled={!dirty || busy || sendingOff}
            aria-busy={apply.isPending ? true : undefined}
            aria-describedby={save.describedBy}
          >
            {apply.isPending ? t('appearance.saving') : t('appearance.save')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!dirty || busy}
            onClick={() => {
              adopt(baseline);
            }}
          >
            {t('appearance.discard')}
          </Button>
          <p role="status" className="text-body-sm text-fg-secondary">
            {dirty ? t('appearance.dirty') : t('appearance.clean')}
          </p>
        </div>
      </form>

      <section aria-labelledby="appearance-tools-title" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="appearance-tools-title" className="text-subtitle font-semibold text-fg">
            {t('appearance.toolsTitle')}
          </h2>
          <p className="text-body-sm text-fg-muted">{t('appearance.toolsDescription')}</p>
        </div>
        <div className="flex flex-col gap-1">
          <div>
            <Button asChild variant="secondary">
              <a href={BRANDING_EXPORT_PATH} download="">
                <DownloadIcon aria-hidden="true" />
                {t('appearance.export.button')}
              </a>
            </Button>
          </div>
          <p className="text-body-sm text-fg-muted">{t('appearance.export.hint')}</p>
        </div>
        <ImportPanel
          revision={baseline.revision}
          disabled={sendingOff || busy}
          describedBy={save.describedBy}
          dirty={dirty}
          api={api}
          onStart={() => {
            setLastError(null);
          }}
          onError={fail}
          onApplied={(next) => {
            const previous = baseline;
            adopt(next);
            offerUndo(t('appearance.import.appliedUndo'), previous, next);
          }}
        />
        <div>
          <Button
            type="button"
            variant="destructive"
            disabled={sendingOff || busy}
            aria-describedby={save.describedBy}
            onClick={() => {
              setConfirmReset(true);
            }}
          >
            {t('appearance.reset.button')}
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        objectName={objectName}
        objectContent={objectContent}
        title={t('appearance.reset.title')}
        description={t('appearance.reset.description')}
        confirmLabel={t('appearance.reset.confirm')}
        cancelLabel={t('appearance.reset.cancel')}
        pending={reset.isPending}
        onConfirm={() => {
          void resetToDefaults();
        }}
      />
      {guardDialog}
    </div>
  );
}
