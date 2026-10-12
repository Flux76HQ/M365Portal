import { Banner } from '../../components/ui/banner';
import { useTranslator } from '../../lib/locale';
import { useMe } from '../../lib/router-context';
import { formatCountdown } from './countdown';
import { useSecondsLeft } from './use-seconds-left';

function Countdown({ untilMs }: { readonly untilMs: number }) {
  const { t } = useTranslator();
  const seconds = useSecondsLeft(untilMs);
  // `role="timer"` is not announced on every tick, so the banner (a polite status) stays quiet.
  return <span role="timer">{t('session.breakGlass.remaining', { time: formatCountdown(seconds) })}</span>;
}

/**
 * The persistent red banner of a break-glass session (FR-B-522, FR-B-608): on every route, no close
 * button, and the absolute countdown (the session never slides). The tone is an icon and a bar as well
 * as a colour.
 */
export function BreakGlassBanner() {
  const { t } = useTranslator();
  const me = useMe();
  if (me.actor.kind !== 'break_glass') return null;
  return (
    <Banner tone="danger" title={t('session.breakGlass.title')} data-testid="break-glass-banner">
      <p>{t('session.breakGlass.message')}</p>
      {me.session === null ? null : (
        <p className="mt-1 font-medium text-fg">
          <Countdown untilMs={Date.parse(me.session.expiresAt)} />
        </p>
      )}
    </Banner>
  );
}
