// T-B-126: the loopback guard (FR-B-206). Over a plain-http PUBLIC_BASE_URL the setup routes and pages
// exist only for a loopback Host and a request without proxy headers. An https base URL is unaffected.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { loopbackGuardOpen, type LoopbackInput } from '../../src/setup/loopback-guard.js';

const PROXY_HEADERS = [
  'Forwarded',
  'X-Forwarded-For',
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
  'X-Forwarded-Port',
  'X-Real-IP',
] as const;

function input(host: string | null, extra: Record<string, string> = {}, https = false): LoopbackInput {
  const headers = new Headers(extra);
  if (host !== null) headers.set('host', host);
  return { publicIsHttps: https, headers };
}

const OPEN_HOSTS = [
  'localhost',
  'localhost:9300',
  'LOCALHOST:9300',
  'localhost.',
  '127.0.0.1',
  '127.0.0.1:9300',
  '127.5.6.7',
  '[::1]',
  '[::1]:9300',
];
const CLOSED_HOSTS = [
  'example.com',
  'panel.example:9300',
  '192.168.1.5',
  '0.0.0.0',
  '10.0.0.1:9300',
  'localhost.evil.test',
  '127.0.0.1.nip.io',
  '127.1',
  'evil.test:9300',
  '[::2]',
  '',
];

type Guard = (candidate: LoopbackInput) => boolean;

/** The matrix: every Host and every proxy header, against a guard. Throws on the first wrong answer. */
function matrix(guard: Guard): void {
  for (const host of OPEN_HOSTS) {
    if (!guard(input(host))) throw new Error(`the guard closed a loopback host: ${host}`);
  }
  for (const host of CLOSED_HOSTS) {
    if (guard(input(host))) throw new Error(`the guard opened for the host "${host}"`);
  }
  if (guard(input(null))) throw new Error('the guard opened for a request without a Host');
  for (const header of PROXY_HEADERS) {
    if (guard(input('localhost:9300', { [header]: '203.0.113.9' }))) {
      throw new Error(`the guard ignored the header ${header}`);
    }
  }
  // An https base URL is not affected, whatever arrives.
  for (const host of [...OPEN_HOSTS, ...CLOSED_HOSTS]) {
    if (!guard(input(host, { 'X-Forwarded-For': '198.51.100.1' }, true))) {
      throw new Error('an https base URL must not be affected');
    }
  }
}

describe('the guard', () => {
  it('passes the whole matrix', () => {
    expect(() => {
      matrix(loopbackGuardOpen);
    }).not.toThrow();
  });

  it('a guard that ignores Host fails the matrix (negative)', () => {
    const ignoresHost: Guard = (candidate) =>
      candidate.publicIsHttps ||
      PROXY_HEADERS.every((header) => !candidate.headers.has(header));
    expectGuardFails(matrix, ignoresHost, { reason: 'the guard opened for the host' });
  });

  it('a guard that ignores X-Forwarded-For fails the matrix (negative)', () => {
    const ignoresForwardedFor: Guard = (candidate) => {
      const headers = new Headers(candidate.headers);
      headers.delete('x-forwarded-for');
      return loopbackGuardOpen({ ...candidate, headers });
    };
    expectGuardFails(matrix, ignoresForwardedFor, { reason: 'the guard ignored the header' });
  });

  it('reads the Host of the request URL when the header is absent', () => {
    expect(
      loopbackGuardOpen({
        publicIsHttps: false,
        headers: new Headers(),
        urlHost: 'localhost:9300',
      }),
    ).toBe(true);
    expect(
      loopbackGuardOpen({ publicIsHttps: false, headers: new Headers(), urlHost: 'example.com' }),
    ).toBe(false);
  });
});
