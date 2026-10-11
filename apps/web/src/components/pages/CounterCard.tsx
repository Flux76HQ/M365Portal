import { CircleAlertIcon, MinusIcon } from 'lucide-react';
import { useId } from 'react';
import { useTranslator } from '../../lib/locale';
import { Skeleton } from '../ui/skeleton';

export type CounterCardProps = {
  /** What is counted ("Users"), already translated. */
  readonly name: string;
} & (
  | { readonly state: 'loading' | 'empty' | 'error' }
  | { readonly state: 'data'; readonly value: number }
);

/**
 * One counter of the dashboard (PD-19). A card is never blank and never invents a number: it is a
 * skeleton while loading, "not connected yet" when there is nothing to count, "could not be loaded" on a
 * failure, and a number only when it has data. In Phase A there is no tenant and no endpoint, so no card
 * ever has data.
 */
export function CounterCard(props: CounterCardProps) {
  const { t, n } = useTranslator();
  const headingId = useId();
  const { name, state } = props;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      aria-busy={state === 'loading' ? true : undefined}
      data-slot="counter-card"
      data-state={state}
      className="flex min-h-28 flex-col gap-2 rounded-lg border border-line-subtle bg-surface-raised p-4 shadow-1"
    >
      <h2 id={headingId} className="text-body-sm font-medium text-fg-secondary">
        {name}
      </h2>
      {state === 'loading' ? (
        <>
          <Skeleton height={32} width={96} />
          <span className="sr-only">{t('dashboard.card.loading', { name })}</span>
        </>
      ) : state === 'data' ? (
        <p className="text-display font-semibold text-fg">{n(props.value)}</p>
      ) : (
        <p className="flex items-center gap-2 text-body text-fg-secondary">
          {state === 'error' ? (
            <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-danger" />
          ) : (
            <MinusIcon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
          )}
          {state === 'error' ? t('dashboard.card.error') : t('dashboard.card.empty')}
        </p>
      )}
    </div>
  );
}
