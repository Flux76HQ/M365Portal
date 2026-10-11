import type { ReactNode } from 'react';
import { Staged } from '../../components/pages/staged';
import { useTranslator } from '../../lib/locale';
import { componentById, STATE_KEYS, type ShowcaseState } from './registry';

/** The forced states: classes that draw what a pointer or the keyboard would, so a still image shows them. */
export const FORCED_FOCUS = 'outline-2 outline-offset-2 outline-focus-ring';

export interface SpecimenProps {
  readonly component: string;
  readonly state: ShowcaseState;
  readonly children: ReactNode;
  /** The caption; defaults to the name of the state. */
  readonly caption?: string;
  readonly className?: string;
}

/**
 * One component in one state, with a caption. `data-component` and `data-state` are what the test and
 * the visual regression run find it by.
 */
export function Specimen({ component, state, children, caption, className }: SpecimenProps) {
  const { t } = useTranslator();
  return (
    <div
      data-component={component}
      data-state={state}
      className={`flex min-w-0 flex-col items-start gap-2 ${className ?? ''}`}
    >
      <p className="text-caption font-medium text-fg-muted">{caption ?? t(STATE_KEYS[state])}</p>
      {children}
    </div>
  );
}

export interface ComponentSectionProps {
  readonly id: string;
  readonly children: ReactNode;
  /** Lay the specimens out in a column instead of a wrapping row (wide components). */
  readonly stacked?: boolean;
}

/** The heading of a component and the grid of its specimens. */
export function ComponentSection({ id, children, stacked = false }: ComponentSectionProps) {
  const { t } = useTranslator();
  const headingId = `showcase-${id}`;
  const component = componentById(id);
  return (
    <Staged>
      <section
        aria-labelledby={headingId}
        data-showcase-section={id}
        className="flex flex-col gap-3"
      >
        <h3 id={headingId} className="text-subtitle font-semibold text-fg">
          {t(component.nameKey)}
        </h3>
        <div
          className={
            stacked
              ? 'flex flex-col gap-6'
              : 'grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3'
          }
        >
          {children}
        </div>
      </section>
    </Staged>
  );
}
