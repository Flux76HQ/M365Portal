import { InboxIcon } from 'lucide-react';
import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { ErrorState } from '../../components/ui/error-state';
import { Persona } from '../../components/ui/persona';
import { Skeleton } from '../../components/ui/skeleton';
import { useTranslator } from '../../lib/locale';
import { ComponentSection, Specimen } from './Specimen';

// Messages that stay on the page and the placeholders for content that is not there yet: banner, persona,
// skeleton, empty state, error state.

const TONES = ['info', 'success', 'warning', 'danger'] as const;

export function FeedbackSection() {
  const { t } = useTranslator();
  return (
    <>
      <ComponentSection id="banner">
        {TONES.map((tone) => (
          <Specimen key={tone} component="banner" state={tone} className="sm:col-span-2">
            <Banner tone={tone} title={t(`showcase.banner.${tone}Title`)} className="w-full rounded-md border">
              {t('showcase.banner.message')}
            </Banner>
          </Specimen>
        ))}
      </ComponentSection>

      <ComponentSection id="persona">
        <Specimen component="persona" state="default">
          <div className="flex items-center gap-3">
            <Persona size="sm" initials={t('showcase.persona.initials')} label={t('showcase.persona.small')} />
            <Persona size="md" initials={t('showcase.persona.initials')} label={t('showcase.persona.medium')} />
            <Persona size="lg" initials={t('showcase.persona.initials')} label={t('showcase.persona.large')} />
          </div>
        </Specimen>
      </ComponentSection>

      <ComponentSection id="skeleton">
        <Specimen component="skeleton" state="loading" className="w-full">
          <div aria-busy="true" className="flex w-full flex-col gap-2">
            <Skeleton height={20} width="40%" />
            <Skeleton height={14} />
            <Skeleton height={14} width="80%" />
          </div>
        </Specimen>
      </ComponentSection>

      <ComponentSection id="empty-state">
        <Specimen component="empty-state" state="empty" className="w-full">
          <div className="w-full rounded-lg border border-line-subtle bg-surface-raised">
            <EmptyState
              headingLevel={4}
              icon={<InboxIcon />}
              title={t('showcase.empty.title')}
              description={t('showcase.empty.description')}
              action={<Button variant="primary">{t('showcase.empty.action')}</Button>}
            />
          </div>
        </Specimen>
      </ComponentSection>

      <ComponentSection id="error-state">
        <Specimen component="error-state" state="error" className="w-full">
          <div className="w-full rounded-lg border border-line-subtle bg-surface-raised">
            <ErrorState
              headingLevel={4}
              title={t('showcase.error.title')}
              description={t('showcase.error.description')}
              action={<Button>{t('showcase.error.retry')}</Button>}
              requestIdLabel={t('showcase.sample.requestId')}
              requestId="sample-0000"
            />
          </div>
        </Specimen>
      </ComponentSection>
    </>
  );
}
