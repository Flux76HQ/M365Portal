import type { MessageKey } from '@m365portal/shared/i18n';
import { ClockIcon } from 'lucide-react';
import { useTranslator } from '../../lib/locale';
import { PageHeader } from './PageHeader';

export interface PlaceholderPageProps {
  readonly titleKey: MessageKey;
  /** What the page will do once it exists. */
  readonly descriptionKey: MessageKey;
  /** The phase that brings it (the roadmap of AGENTS.md). */
  readonly phase: 'C' | 'D';
}

/**
 * A page of a later phase (FR-A-130): it is in the menu for an actor who holds its read permission so the
 * structure is visible, and it says plainly that nothing works yet and what it will do.
 */
export function PlaceholderPage({ titleKey, descriptionKey, phase }: PlaceholderPageProps) {
  const { t } = useTranslator();
  return (
    <>
      <PageHeader title={t(titleKey)}>
        <p className="mt-1 inline-flex w-fit items-center gap-2 rounded-md border border-line-control px-2.5 py-1 text-body-sm font-medium text-fg-secondary">
          <ClockIcon aria-hidden="true" className="size-4 shrink-0" />
          {t('placeholders.notAvailable', { phase })}
        </p>
      </PageHeader>
      <section className="max-w-prose rounded-lg border border-line-subtle bg-surface-raised p-6">
        <h2 className="text-subtitle font-semibold text-fg">{t('placeholders.whatItWillDo')}</h2>
        <p className="mt-2 text-body text-fg">{t(descriptionKey)}</p>
        <p className="mt-4 text-body text-fg-secondary">{t('placeholders.note')}</p>
      </section>
    </>
  );
}
