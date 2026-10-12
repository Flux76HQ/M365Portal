// T-B-142 (FR-B-111): the certificate expiry levels on the boundaries 61, 60, 15, 14, 0 and below, and the
// start posture warning (no secret in it).
import { describe, expect, it } from 'vitest';
import { certificateExpiry, expiryWarningOf } from '../../src/connection/cert-expiry.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const inDays = (days: number): string => new Date(NOW + days * DAY).toISOString();

describe('the level', () => {
  it.each([
    [361, 361, 'ok'],
    [61, 61, 'ok'],
    [60, 60, 'warning'],
    [15, 15, 'warning'],
    [14, 14, 'critical'],
    [1, 1, 'critical'],
    [0, 0, 'expired'],
    [-1, -1, 'expired'],
    [-400, -400, 'expired'],
  ] as const)('%i days from now: daysLeft %i, level %s', (days, daysLeft, level) => {
    expect(certificateExpiry(inDays(days), NOW)).toEqual({ daysLeft, level });
  });

  it('counts a started day as a day left (one hour left is 1 day and critical, not 0 and expired)', () => {
    expect(certificateExpiry(new Date(NOW + 3_600_000).toISOString(), NOW)).toEqual({ daysLeft: 1, level: 'critical' });
    expect(certificateExpiry(new Date(NOW - 3_600_000).toISOString(), NOW)).toEqual({ daysLeft: 0, level: 'expired' });
  });

  it('is the boundary of the day, not of the hour: 60 days and one hour is still ok', () => {
    expect(certificateExpiry(new Date(NOW + 60 * DAY + 3_600_000).toISOString(), NOW).level).toBe('ok');
  });

  it('treats an unreadable date as expired (+ negative: a readable one is not)', () => {
    expect(certificateExpiry('not a date', NOW).level).toBe('expired');
    expect(certificateExpiry(inDays(200), NOW).level).toBe('ok');
  });
});

describe('the start posture', () => {
  it('is silent while the level is ok', () => {
    expect(expiryWarningOf(inDays(200), NOW)).toBeUndefined();
  });

  it.each([
    [60, 'warning'],
    [14, 'critical'],
    [0, 'expired'],
  ] as const)('warns at %i days with the level and the days, and nothing else', (days, level) => {
    expect(expiryWarningOf(inDays(days), NOW)).toEqual({ event: 'certificate_expiry', level, daysLeft: days });
  });
});
