// The certificate expiry levels (T-B-142, FR-B-111): `warning` at 60 days or fewer, `critical` at 14 or
// fewer, `expired` at 0 or fewer. A day that has started counts as a day left (the days are rounded up),
// so one hour before the end the page says "1 day, critical" and not "0 days, expired". Pure; the clock
// is the caller's.
import { LIMITS } from '@m365portal/shared/limits';

const DAY_MS = 86_400_000;

export type CertificateLevel = 'ok' | 'warning' | 'critical' | 'expired';

export interface CertificateExpiry {
  readonly daysLeft: number;
  readonly level: CertificateLevel;
}

export function certificateExpiry(notAfter: string, nowMs: number): CertificateExpiry {
  const end = Date.parse(notAfter);
  if (!Number.isFinite(end)) return { daysLeft: 0, level: 'expired' };
  // `+ 0` turns -0 into 0.
  const daysLeft = Math.ceil((end - nowMs) / DAY_MS) + 0;
  const { warnDays, criticalDays } = LIMITS.certificate;
  const level: CertificateLevel =
    daysLeft <= 0
      ? 'expired'
      : daysLeft <= criticalDays
        ? 'critical'
        : daysLeft <= warnDays
          ? 'warning'
          : 'ok';
  return { daysLeft, level };
}

/** The log line the start posture writes for a certificate that needs attention, else `undefined`. */
export function expiryWarningOf(
  notAfter: string,
  nowMs: number,
):
  | {
      readonly event: 'certificate_expiry';
      readonly level: Exclude<CertificateLevel, 'ok'>;
      readonly daysLeft: number;
    }
  | undefined {
  const { daysLeft, level } = certificateExpiry(notAfter, nowMs);
  return level === 'ok' ? undefined : { event: 'certificate_expiry', level, daysLeft };
}
