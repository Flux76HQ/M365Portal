import { useState } from 'react';
import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { useLanguage } from '../../lib/locale';
import type { ConnectionState } from '../setup/setup-api';

const TONES = { warning: 'warning', critical: 'danger', expired: 'danger' } as const;

export interface CertificateCardProps {
  readonly certificate: NonNullable<ConnectionState['certificate']>;
  readonly pending: ConnectionState['pendingCertificate'];
  readonly applicationName: string;
  /** Absent when the panel was set up by hand: the certificate is renewed by hand too. */
  readonly onRenew?: () => void;
  readonly busy: boolean;
}

/**
 * The certificate of the panel (FR-B-111): thumbprint, end date and days left, the level as a banner with a
 * tone (60 days or fewer is a warning, 14 or fewer critical, over is expired), a pending certificate, and
 * the renewal. Renewing is a repair run: a new certificate next to the old one, tested, then the old one goes.
 */
export function CertificateCard({ certificate, pending, applicationName, onRenew, busy }: CertificateCardProps) {
  const { t, d } = useLanguage().translator;
  const [confirming, setConfirming] = useState(false);
  const level = certificate.level;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-body">
        <dt className="text-fg-secondary">{t('connection.field.thumbprint')}</dt>
        <dd className="break-all font-mono text-body-sm text-fg">{certificate.thumbprintSha1}</dd>
        <dt className="text-fg-secondary">{t('connection.field.validUntil')}</dt>
        <dd className="text-fg">{d(Date.parse(certificate.notAfter), { dateStyle: 'long' })}</dd>
        <dt className="text-fg-secondary">{t('connection.field.daysLeft')}</dt>
        <dd className="text-fg">{t('connection.daysLeft', { count: Math.max(0, certificate.daysLeft) })}</dd>
      </dl>
      {level === 'ok' ? (
        <p className="text-body-sm text-fg-secondary">{t('connection.certificate.level.ok')}</p>
      ) : (
        <Banner tone={TONES[level]} className="rounded-md border border-line-subtle">
          {t(`connection.certificate.level.${level}`)}
        </Banner>
      )}
      {pending === null ? null : (
        <p className="text-body-sm text-fg-secondary">{t('connection.certificate.pending', { thumbprint: pending.thumbprintSha1 })}</p>
      )}
      {onRenew === undefined ? null : (
        <>
          <Button
            variant={level === 'ok' ? 'secondary' : 'primary'}
            className="self-start"
            disabled={busy}
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t('connection.repair.renewCertificate')}
          </Button>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            objectName={applicationName}
            title={t('connection.repair.renewCertificate')}
            description={`${t('connection.repair.renewNote')} ${t('connection.repair.needsSignIn')}`}
            confirmLabel={t('connection.repair.renewCertificate')}
            cancelLabel={t('connection.repair.cancel')}
            destructive={false}
            onConfirm={() => {
              setConfirming(false);
              onRenew();
            }}
          />
        </>
      )}
    </div>
  );
}
