// T-D-113, FR-D-105, EC-D1: the retry rules of `InvokeExchangeClient`, over the fake tenant and a fake clock.
//
//   429 (throttled)    the call did not run: waits Retry-After (0 to 20 per cent jitter, at most a minute: a longer
//                      hint fails at once) or backs off, then repeats. Every call is repeated, `New-MailContact` too.
//   5xx, lost call     the call may have run: a read and an idempotent write (add and remove of a member, set and
//                      remove of a contact) are repeated ONCE; `New-MailContact` never is (the contact may exist).
//   anything else      a typed error with a fixed code; no text of Exchange, no argument.
import { describe, expect, it } from 'vitest';
import {
  ExchangeCommandError,
  ExchangeThrottledError,
  ExchangeUnavailableError,
} from '../../src/ports/errors.js';
import { rejectionOf } from '../integrations/support.js';
import { clientHarness } from './support.js';

const GROUP = 'marketing@contoso-fake.example';

function seeded(options?: Parameters<typeof clientHarness>[0]) {
  const h = clientHarness(options);
  const group = h.state.addDistributionGroup({ name: 'Marketing', primarySmtpAddress: GROUP });
  const anna = h.state.addRecipient({
    displayName: 'Anna Jansen',
    primarySmtpAddress: 'anna@contoso-fake.example',
  });
  return { ...h, group, anna };
}

const PARTNER = {
  name: 'Partner-abc123',
  displayName: 'Partner',
  alias: 'partner',
  externalEmailAddress: 'partner@elsewhere.example',
};

describe('throttling', () => {
  it('waits Retry-After and repeats, and not a moment sooner', async () => {
    const h = seeded();
    h.exchange.control.fault({ times: 1, status: 429, retryAfterSeconds: 3 });
    const done = h.client.getDistributionGroup(GROUP);
    await h.settle();
    expect(h.calls()).toBe(1);
    h.time.elapse(2_999);
    await h.settle();
    expect(h.calls()).toBe(1);
    h.time.elapse(1_000);
    expect((await done)?.primarySmtpAddress).toBe(GROUP);
    expect(h.calls()).toBe(2);
  });

  it('gives up with a typed error that keeps the hint', async () => {
    const h = seeded();
    h.exchange.control.fault({ times: 99, status: 429, retryAfterSeconds: 2 });
    const failure = await rejectionOf(h.drive(h.client.getDistributionGroup(GROUP)));
    expect(failure).toBeInstanceOf(ExchangeThrottledError);
    expect((failure as ExchangeThrottledError).retryAfterMs).toBe(2_000);
    expect(h.calls()).toBeGreaterThan(1);
    expect(h.calls()).toBeLessThanOrEqual(5);
  });

  it('fails at once when Retry-After is longer than a minute', async () => {
    const h = seeded();
    h.exchange.control.fault({ times: 99, status: 429, retryAfterSeconds: 61 });
    const failure = await rejectionOf(h.drive(h.client.getDistributionGroup(GROUP)));
    expect(failure).toBeInstanceOf(ExchangeThrottledError);
    expect(h.calls()).toBe(1);
  });

  it('repeats a throttled New-MailContact too: a throttled call did not run', async () => {
    const h = seeded();
    h.exchange.control.fault({ times: 1, status: 429, retryAfterSeconds: 1 });
    const created = await h.drive(h.client.createMailContact(PARTNER));
    expect(created.externalEmailAddress).toBe('partner@elsewhere.example');
    expect(h.state.contacts().filter((contact) => contact.alias === 'partner')).toHaveLength(1);
  });
});

describe('a call that was lost (EC-D1)', () => {
  it('repeats a read once', async () => {
    const h = seeded();
    h.exchange.control.fault({ times: 1, status: 503 });
    const group = await h.drive(h.client.getDistributionGroup(GROUP));
    expect(group?.primarySmtpAddress).toBe(GROUP);
    expect(h.calls()).toBe(2);
  });

  it('fails with a typed error when the repeat fails too', async () => {
    const h = seeded();
    h.exchange.control.fault({ times: 99, status: 503 });
    const failure = await rejectionOf(h.drive(h.client.getDistributionGroup(GROUP)));
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect(h.calls()).toBe(2);
  });

  it('does NOT repeat New-MailContact: the contact may exist already', async () => {
    const h = seeded();
    h.exchange.control.fault({ times: 99, status: 503 });
    const failure = await rejectionOf(h.drive(h.client.createMailContact(PARTNER)));
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect(h.calls()).toBe(1);
  });

  it('a Remove that finds nothing on its FIRST attempt is not_found', async () => {
    const h = seeded();
    const failure = await rejectionOf(
      h.drive(h.client.removeMailContact('00000000-0000-4000-8000-000000000001')),
    );
    expect(failure).toBeInstanceOf(ExchangeCommandError);
    expect((failure as ExchangeCommandError).commandCode).toBe('not_found');
  });

  it('a timeout that Exchange itself reports (504) follows the same rule', async () => {
    const h = seeded();
    h.exchange.control.fault({ times: 1, status: 504 });
    expect((await h.drive(h.client.getDistributionGroup(GROUP)))?.primarySmtpAddress).toBe(GROUP);
    expect(h.calls()).toBe(2);
  });
});

describe('answers that are not retried', () => {
  it.each([
    'already_exists',
    'member_type_not_allowed',
    'permission_denied',
    'manager_check',
    'read_only_object',
  ] as const)('%s is thrown as it is, after one call', async (code) => {
    const h = seeded();
    h.exchange.control.commandFault(code);
    const failure = await rejectionOf(
      h.drive(h.client.addDistributionGroupMember(h.group.guid, h.anna.guid)),
    );
    expect(failure).toBeInstanceOf(ExchangeCommandError);
    expect((failure as ExchangeCommandError).commandCode).toBe(code);
    expect(h.calls()).toBe(1);
  });

  it('not_found of a read of one object is null, not an error', async () => {
    const h = seeded();
    expect(await h.drive(h.client.getDistributionGroup('nobody@contoso-fake.example'))).toBeNull();
  });

  it('role_pending is exchange_unavailable with that reason (EC-D2), after one call', async () => {
    const h = seeded();
    h.exchange.control.commandFault('role_pending');
    const failure = await rejectionOf(h.drive(h.client.getDistributionGroup(GROUP)));
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect((failure as ExchangeUnavailableError).reason).toBe('role_pending');
    expect(h.calls()).toBe(1);
  });

  it('invalid_argument is a client error: nothing sent was valid', async () => {
    const h = seeded();
    h.exchange.control.commandFault('invalid_argument');
    const failure = await rejectionOf(h.drive(h.client.getDistributionGroup(GROUP)));
    expect(failure).toBeInstanceOf(Error);
    expect(h.calls()).toBe(1);
  });
});
