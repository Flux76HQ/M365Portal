import { useMemo } from 'react';
import { Banner } from '../../components/ui/banner';
import { PageHeader } from '../../components/pages/PageHeader';
import { useTranslator } from '../../lib/locale';
import { ControlsSection } from './ControlsSection';
import { FeedbackSection } from './FeedbackSection';
import { FormSection } from './FormSection';
import { NavigationSection, OverlaysSection } from './OverlaysSection';
import { createSampleSource, type SampleSource } from './sample-data';
import { TableSection } from './TableSection';

export interface ShowcaseProps {
  /** Where the demo table gets its rows. Defaults to the sample source with its simulated latency. */
  readonly source?: SampleSource;
}

/**
 * The component showcase, `/design` (FR-A-131, US-5.8, US-5.9): every component of the library in each of its
 * states, on one page. It exists only while the server runs with `SHOWCASE=true`, makes no network
 * request and shows nothing but sample data, which it says. It is also the page the visual regression
 * run takes its screenshots of.
 */
export function Showcase({ source }: ShowcaseProps) {
  const { t } = useTranslator();
  const fallbackSource = useMemo(() => createSampleSource(), []);
  const demoSource = source ?? fallbackSource;
  return (
    <div className="flex flex-col gap-10">
      <PageHeader title={t('nav.design')} description={t('showcase.lead')} />
      <Banner tone="info" title={t('showcase.sample.title')} className="rounded-md border">
        {t('showcase.sample.message')}
      </Banner>

      <section aria-labelledby="showcase-group-controls" className="flex flex-col gap-8">
        <h2 id="showcase-group-controls" className="text-title-3 font-semibold text-fg">
          {t('showcase.group.controls')}
        </h2>
        <ControlsSection />
        <FormSection />
      </section>

      <section aria-labelledby="showcase-group-overlays" className="flex flex-col gap-8">
        <h2 id="showcase-group-overlays" className="text-title-3 font-semibold text-fg">
          {t('showcase.group.overlays')}
        </h2>
        <OverlaysSection />
      </section>

      <section aria-labelledby="showcase-group-navigation" className="flex flex-col gap-8">
        <h2 id="showcase-group-navigation" className="text-title-3 font-semibold text-fg">
          {t('showcase.group.navigation')}
        </h2>
        <NavigationSection />
      </section>

      <section aria-labelledby="showcase-group-feedback" className="flex flex-col gap-8">
        <h2 id="showcase-group-feedback" className="text-title-3 font-semibold text-fg">
          {t('showcase.group.feedback')}
        </h2>
        <FeedbackSection />
      </section>

      <section aria-labelledby="showcase-group-data" className="flex flex-col gap-8">
        <h2 id="showcase-group-data" className="text-title-3 font-semibold text-fg">
          {t('showcase.group.data')}
        </h2>
        <TableSection source={demoSource} />
      </section>
    </div>
  );
}
