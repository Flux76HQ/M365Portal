import { isAllowedVerificationUri } from '@m365portal/shared/setup/steps';
import { CopyIcon, ExternalLinkIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '../../components/ui/button';
import { useLanguage } from '../../lib/locale';
import { formatCountdown } from '../auth/countdown';
import { useSecondsUntil } from './StepFrame';
import type { DeviceCodePanelState } from './setup-api';

export interface DeviceCodePanelProps {
  readonly panel: DeviceCodePanelState;
  readonly offsetMs: number;
  readonly busy: boolean;
  readonly onCancel: () => void;
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * The device-code panel (FR-B-214, FR-B-216): the code as selectable text with a copy button, the time left,
 * the instruction to leave "Consent on behalf of your organization" off, a way to cancel, and the
 * Microsoft page as a link only when the address is on the closed list of hosts. Anything else (a
 * `javascript:` address, a look-alike host, plain http) renders no link at all and says where to go instead.
 * No sentence of Microsoft's is shown: the texts are the panel's own.
 */
export function DeviceCodePanel({ panel, offsetMs, busy, onCancel }: DeviceCodePanelProps) {
  const { t } = useLanguage().translator;
  const heading = useId();
  const [copy, setCopy] = useState<CopyState>('idle');
  const seconds = useSecondsUntil(panel.expiresAt, offsetMs);
  const waiting = panel.state === 'waiting_for_user';
  const link = isAllowedVerificationUri(panel.verificationUri) ? panel.verificationUri : null;

  const copyCode = (): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      setCopy('failed');
      return;
    }
    clipboard.writeText(panel.userCode).then(
      () => {
        setCopy('copied');
      },
      () => {
        setCopy('failed');
      },
    );
  };

  return (
    <section
      aria-labelledby={heading}
      data-slot="device-code-panel"
      className="flex flex-col gap-3 rounded-lg border border-line-subtle bg-surface-raised p-4"
    >
      <h3 id={heading} className="text-subtitle font-semibold text-fg">
        {t('setup.device.title')}
      </h3>
      <p role="status" className="text-body font-medium text-fg">
        {t(`setup.deviceState.${panel.state}`)}
      </p>
      {waiting ? (
        <>
          <p className="text-body text-fg-secondary">{t('setup.device.instruction')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-body-sm text-fg-secondary">{t('setup.device.codeLabel')}</span>
            <code className="select-all rounded-md border border-line-control bg-surface-page px-3 py-1.5 font-mono text-title-3 text-fg">
              {panel.userCode}
            </code>
            <Button variant="secondary" size="sm" onClick={copyCode}>
              <CopyIcon aria-hidden="true" className="size-4" />
              {t('setup.device.copy')}
            </Button>
            {copy === 'copied' ? <span role="status" className="text-body-sm text-success">{t('setup.device.copied')}</span> : null}
            {copy === 'failed' ? <span role="status" className="text-body-sm text-danger">{t('setup.device.copyFailed')}</span> : null}
          </div>
          <p className="text-body-sm text-fg-secondary">
            {t('setup.device.expires', { time: formatCountdown(seconds) })}
          </p>
          {link === null ? (
            <p className="text-body text-fg-secondary">{t('setup.device.noLink')}</p>
          ) : (
            <p className="flex flex-col gap-0.5">
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-target w-fit items-center gap-1.5 rounded-sm text-accent-text underline underline-offset-4 hover:bg-accent-subtle"
              >
                {t('setup.device.link')}
                <ExternalLinkIcon aria-hidden="true" className="size-4" />
              </a>
              <span className="text-body-sm text-fg-muted">{t('setup.device.linkNote')}</span>
            </p>
          )}
          <p className="rounded-md border border-s-4 border-line-subtle border-s-warning bg-surface-page p-3 text-body-sm text-fg">
            {t('setup.connect.consentWarning')}
          </p>
          <Button variant="secondary" className="self-start" disabled={busy} onClick={onCancel}>
            {t('setup.device.cancel')}
          </Button>
        </>
      ) : null}
    </section>
  );
}
