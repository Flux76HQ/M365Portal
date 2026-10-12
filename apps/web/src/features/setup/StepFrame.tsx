import type { StepKey } from '@m365portal/shared/setup/steps';
import { CircleAlertIcon } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../../components/ui/button';
import { ApiError } from '../../lib/api';
import { useLanguage } from '../../lib/locale';
import { useMe } from '../../lib/router-context';
import { useSecondsLeft } from '../auth/use-seconds-left';
import { errorText, hintText, resultText } from './hints';
import { StatusMark } from './StatusMark';
import type { StepState, SubActionState } from './setup-api';
import { stepOf, type WizardContext } from './wizard-context';

/** Seconds until an ISO moment of the server, on the server's clock. */
export function useSecondsUntil(iso: string, offsetMs: number): number {
  return useSecondsLeft(Date.parse(iso) - offsetMs);
}

function WaitingNote({ sub, context }: { readonly sub: SubActionState; readonly context: WizardContext }) {
  const { t } = useLanguage().translator;
  const waiting = sub.waiting;
  // A hook may not be conditional: a sub-action that does not wait never renders this component.
  const seconds = useSecondsUntil(waiting?.nextAttemptAt ?? new Date(0).toISOString(), context.offsetMs);
  if (waiting === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-fg-secondary">
      <span>{t('setup.configure.waitingFor', { seconds })}</span>
      <span>{t('setup.configure.attempt', { attempt: waiting.attempt })}</span>
      <Button variant="secondary" size="sm" onClick={context.actions.retryNow} disabled={context.actions.busy}>
        {t('setup.configure.retryNow')}
      </Button>
    </div>
  );
}

export interface SubActionListProps {
  readonly step: StepState;
  readonly context: WizardContext;
}

/** The sub-actions of a step: name, status as icon and words, the attempt, the countdown of a wait. */
export function SubActionList({ step, context }: SubActionListProps) {
  const { translator } = useLanguage();
  const { t } = translator;
  return (
    <ul className="flex flex-col gap-2" data-slot="sub-actions">
      {step.subActions.map((sub) => (
        <li
          key={sub.key}
          data-sub={sub.key}
          className="flex flex-col gap-1 rounded-md border border-line-subtle bg-surface-raised px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-body font-medium text-fg">{t(`setup.sub.${sub.key}` as never)}</span>
            <StatusMark status={sub.status} className="ms-auto" />
          </div>
          {sub.attempt > 1 && sub.waiting === null ? (
            <p className="text-body-sm text-fg-muted">{t('setup.configure.attempt', { attempt: sub.attempt })}</p>
          ) : null}
          {sub.waiting === null ? null : <WaitingNote sub={sub} context={context} />}
          {sub.errorCode !== null && sub.status !== 'waiting' && sub.status !== 'failed' ? (
            <p className="text-body-sm text-fg-secondary">{resultText(translator, sub.errorCode).message}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export interface RollbackHintsProps {
  readonly steps: readonly StepState[];
  readonly applicationObjectId?: string | null;
}

/** "If you abandon the setup": what the panel created and how to remove it by hand (no automatic rollback). */
export function RollbackHints({ steps, applicationObjectId }: RollbackHintsProps) {
  const { translator } = useLanguage();
  const items = steps.flatMap((step) =>
    step.subActions.flatMap((sub) => {
      if (sub.hint === null) return [];
      const text = hintText(translator, sub.hint, { applicationObjectId, subAction: sub.key });
      return text === null ? [] : [{ key: sub.key, text }];
    }),
  );
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="rollback-hints" className="flex flex-col gap-2" data-slot="rollback-hints">
      <h3 id="rollback-hints" className="text-subtitle font-semibold text-fg">
        {translator.t('setup.hintTitle')}
      </h3>
      <ul className="list-disc ps-6 text-body text-fg-secondary">
        {items.map((item) => (
          <li key={item.key}>{item.text}</li>
        ))}
      </ul>
    </section>
  );
}

export interface ErrorSummaryProps {
  readonly step: StepState;
  readonly children?: ReactNode;
}

/**
 * What went wrong in this step and what to do about it: the message and the remedy of the result code of
 * each failed sub-action. It is an alert and it takes the focus when it appears (FR-B-609), so a keyboard
 * or screen-reader user lands on it and not on the part of the page that was there before.
 */
export function ErrorSummary({ step, children }: ErrorSummaryProps) {
  const { translator } = useLanguage();
  const { t } = translator;
  const ref = useRef<HTMLDivElement>(null);
  const failed = step.subActions.filter((sub) => sub.status === 'failed');
  const signature = failed.map((sub) => `${sub.key}:${String(sub.errorCode)}:${String(sub.attempt)}`).join('|');
  useEffect(() => {
    ref.current?.focus();
  }, [signature]);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      data-slot="error-summary"
      className="flex flex-col gap-3 rounded-lg border border-s-4 border-line-subtle border-s-danger bg-surface-raised p-4 outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
    >
      <div className="flex items-start gap-3">
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
        <p className="font-semibold text-fg">{t('setup.errorSummary.title')}</p>
      </div>
      <ul className="flex flex-col gap-3">
        {failed.map((sub) => {
          const code = sub.errorCode;
          const text = code === null ? null : resultText(translator, code);
          return (
            <li key={sub.key} className="flex flex-col gap-1">
              <p className="text-body font-medium text-fg">{t(`setup.sub.${sub.key}` as never)}</p>
              {text === null ? null : (
                <>
                  <p className="text-body text-fg">{text.message}</p>
                  <p className="text-body text-fg-secondary">
                    <span className="font-medium">{t('setup.remedyLabel')}: </span>
                    {text.remedy}
                  </p>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {children}
    </div>
  );
}

export interface StepFrameProps {
  readonly step: StepKey;
  readonly context: WizardContext;
  /** Move the focus to the heading (the step changed since the page opened). */
  readonly focus: boolean;
  /** The title, when it is not the step's own. */
  readonly title?: string;
  /** Buttons under the error summary of a failed step. */
  readonly recovery?: ReactNode;
  /** The sub-action rows; a step with its own display hides them. */
  readonly subActions?: boolean;
  /** The error summary of a failed step; a step that lists its failures itself turns it off. */
  readonly errorSummary?: boolean;
  readonly children?: ReactNode;
}

/**
 * The frame of one step: the heading that takes the focus when the step changes, the line of help, the
 * error summary of a failed step, then the step's own content and its sub-actions.
 */
export function StepFrame({ step, context, focus, title, recovery, subActions = true, errorSummary = true, children }: StepFrameProps) {
  const { t } = useLanguage().translator;
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const state = stepOf(context, step);
  const failed = state.status === 'failed' && errorSummary;
  useEffect(() => {
    if (focus && !failed) heading.current?.focus();
  }, [focus, failed]);
  return (
    <section aria-labelledby={id} data-step-panel={step} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2
          id={id}
          ref={heading}
          tabIndex={-1}
          className="text-title-3 font-semibold text-fg outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
        >
          {title ?? t(`setup.step.${step}`)}
        </h2>
        <p className="max-w-prose text-body text-fg-secondary">{t(`setup.stepHelp.${step}`)}</p>
      </div>
      {failed ? <ErrorSummary step={state}>{recovery}</ErrorSummary> : null}
      {context.actions.error === null ? null : <ActionError error={context.actions.error} />}
      {children}
      {subActions ? <SubActionList step={state} context={context} /> : null}
    </section>
  );
}

/** A request of the wizard that the server refused: the translated reason. */
export function ActionError({ error }: { readonly error: unknown }) {
  const { translator } = useLanguage();
  const { t } = translator;
  const me = useMe();
  return (
    <div
      role="alert"
      data-slot="action-error"
      className="flex items-start gap-3 rounded-lg border border-s-4 border-line-subtle border-s-danger bg-surface-raised p-4 text-body"
    >
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="flex flex-col gap-1">
        <p className="text-fg">{errorText(translator, error, me.publicOrigin)}</p>
        {error instanceof ApiError && error.requestId !== null ? (
          <p className="text-caption text-fg-muted">
            {t('common.table.requestId')}: <code className="font-mono select-all">{error.requestId}</code>
          </p>
        ) : null}
      </div>
    </div>
  );
}
