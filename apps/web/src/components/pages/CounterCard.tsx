import { CircleAlertIcon, MinusIcon } from 'lucide-react';
import { useId } from 'react';
import { useTranslator } from '../../lib/locale';
import { Skeleton } from '../ui/skeleton';

export type CounterCardState =
  | { readonly state: 'loading' | 'empty' | 'error' | 'denied' }
  | {
      readonly state: 'data';
      readonly value: number;
      /** The count stopped at its bound: the real number is larger ("1,000+"). */
      readonly capped?: boolean;
    };

export type CounterCardProps = {
  /** What is counted ("Users"), already translated. */
  readonly name: string;
} & CounterCardState;

/**
 * One counter of the dashboard (PD-19). A card is never blank and never invents a number: it is a
 * skeleton while loading, "not connected yet" when there is nothing to count, "could not be loaded" on a
 * failure, "not available for your role" when the caller may not read that kind, and a number only when it
 * has data (`GET /api/v1/dashboard`, P70; a signed-out visitor has none, so those cards stay "not connected").
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
        <p className="text-display font-semibold text-fg">
          {n(props.value)}
          {props.capped === true ? '+' : ''}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-body text-fg-secondary">
          {state === 'error' ? (
            <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-danger" />
          ) : (
            <MinusIcon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
          )}
          {state === 'error'
            ? t('dashboard.card.error')
            : state === 'denied'
              ? t('dashboard.card.denied')
              : t('dashboard.card.empty')}
        </p>
      )}
    </div>
  );
}
