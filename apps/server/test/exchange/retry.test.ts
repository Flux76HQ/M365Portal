// T-D-113, FR-D-105, EC-D1: bounded retries with backoff for `PwshExchangeClient`, over the scripted
// stand-in and a fake clock. Throttling waits `Retry-After` (with jitter, never past a minute) or
// backs off 1 s doubling to 15 s with full jitter, at most `retryMax` times, then a typed error that
// carries the hint. A worker that timed out or crashed is restarted and the call repeated ONCE, and
// only when repeating it is safe: reads and idempotent writes, never `New-MailContact`.
import { LIMITS } from '@m365portal/shared/limits';
import { describe, expect, it } from 'vitest';
import {
  ExchangeCommandError,
  ExchangeThrottledError,
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
} from '../../src/ports/errors.js';
import { rejectionOf } from '../integrations/support.js';
import { clientHarness } from './support.js';

const { retryMax } = LIMITS.exchange;
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

describe('throttling', () => {
  it('waits Retry-After and repeats, and not a moment sooner', async () => {
    const h = seeded();
    h.launcher.script((call) =>
      call.index === 0 ? { error: 'throttled', retryAfterMs: 3_000 } : undefined,
    );
    const done = h.client.getDistributionGroup(GROUP);
    await h.settle();
    expect(h.launcher.calls()).toBe(1);
    h.time.elapse(2_999);
    await h.settle();
    expect(h.launcher.calls()).toBe(1);
    h.time.elapse(1);
    expect((await done)?.primarySmtpAddress).toBe(GROUP);
    expect(h.launcher.calls()).toBe(2);
  });

  it('adds up to 20 per cent jitter to Retry-After', async () => {
    const h = seeded({ random: [0.5] });
    h.launcher.script((call) =>
      call.index === 0 ? { error: 'throttled', retryAfterMs: 10_000 } : undefined,
    );
    const done = h.client.getDistributionGroup(GROUP);
    await h.settle();
    h.time.elapse(10_999);
    await h.settle();
    expect(h.launcher.calls()).toBe(1);
    h.time.elapse(1);
    await done;
    expect(h.launcher.calls()).toBe(2);
  });

  it('backs off 1 s, 2 s, 4 s with full jitter when no hint is given', async () => {
    const h = seeded({ random: [0.5] });
    h.launcher.script((call) => (call.index < 3 ? { error: 'throttled' } : undefined));
    const done = h.client.getDistributionGroup(GROUP);
    const waits = [500, 1_000, 2_000];
    for (const [n, wait] of waits.entries()) {
      await h.settle();
      expect(h.launcher.calls()).toBe(n + 1);
      h.time.elapse(wait - 1);
      await h.settle();
      expect(h.launcher.calls()).toBe(n + 1);
      h.time.elapse(1);
    }
    expect((await done)?.primarySmtpAddress).toBe(GROUP);
    expect(h.launcher.calls()).toBe(4);
  });

  it('gives up after retryMax repeats with a typed error that keeps the hint', async () => {
    expect(retryMax).toBe(3);
    const h = seeded();
    h.launcher.script(() => ({ error: 'throttled', retryAfterMs: 2_000 }));
    const outcome = rejectionOf(h.client.getDistributionGroup(GROUP));
    for (let n = 0; n < retryMax + 1; n += 1) {
      await h.settle();
      h.time.elapse(3_000);
    }
    const failure = await outcome;
    expect(failure).toBeInstanceOf(ExchangeThrottledError);
    expect((failure as ExchangeThrottledError).retryAfterMs).toBe(2_000);
    expect(h.launcher.calls()).toBe(retryMax + 1);
  });

  it('fails at once when Retry-After is longer than a minute', async () => {
    const h = seeded();
    h.launcher.script(() => ({ error: 'throttled', retryAfterMs: 61_000 }));
    const failure = await rejectionOf(h.drive(h.client.getDistributionGroup(GROUP)));
    expect(failure).toBeInstanceOf(ExchangeThrottledError);
    expect((failure as ExchangeThrottledError).retryAfterMs).toBe(61_000);
    expect(h.launcher.calls()).toBe(1);
  });

  it('repeats a throttled New-MailContact too: a throttled call did not run', async () => {
    const h = seeded();
    h.launcher.script((call) =>
      call.index === 0 ? { error: 'throttled', retryAfterMs: 1_000 } : undefined,
    );
    const created = h.client.createMailContact({
      name: 'Partner-abc123',
      displayName: 'Partner',
      alias: 'partner',
      externalEmailAddress: 'partner@elsewhere.example',
    });
    await h.settle();
    h.time.elapse(1_000);
    expect((await created).externalEmailAddress).toBe('partner@elsewhere.example');
    expect(h.state.contacts().filter((contact) => contact.alias === 'partner')).toHaveLength(1);
  });
});

describe('a worker that timed out or crashed (EC-D1)', () => {
  it('restarts and repeats a read once', async () => {
    const h = seeded();
    h.launcher.script((call) => (call.index === 0 ? 'exit' : undefined));
    const group = await h.drive(h.client.getDistributionGroup(GROUP));
    expect(group?.primarySmtpAddress).toBe(GROUP);
    expect(h.launcher.launches).toBe(2);
  });

  it('fails with a typed error when the second attempt fails too', async () => {
    const h = seeded();
    h.launcher.script(() => 'exit');
    const failure = await rejectionOf(h.drive(h.client.getDistributionGroup(GROUP)));
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect((failure as ExchangeUnavailableError).reason).toBe('worker_crashed');
    expect(h.launcher.calls()).toBe(2);
  });

  it('repeats an idempotent write: the add that ran before the crash answers already', async () => {
    const h = seeded();
    // The worker applies the add and dies before it can say so.
    h.launcher.script((call) => (call.index === 0 ? 'apply-then-exit' : undefined));
    const outcome = await h.drive(h.client.addDistributionGroupMember(h.group.guid, h.anna.guid));
    expect(outcome).toBe('already');
    expect(h.state.groupMembers(h.group.guid).map((member) => member.guid)).toEqual([h.anna.guid]);
  });

  it('does NOT repeat New-MailContact after a crash: the contact may exist already', async () => {
    const h = seeded();
    h.launcher.script(() => 'apply-then-exit');
    const failure = await rejectionOf(
      h.drive(
        h.client.createMailContact({
          name: 'Partner-abc123',
          displayName: 'Partner',
          alias: 'partner',
          externalEmailAddress: 'partner@elsewhere.example',
        }),
      ),
    );
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect(h.launcher.calls()).toBe(1);
    expect(h.state.contacts().filter((contact) => contact.alias === 'partner')).toHaveLength(1);
  });

  it('treats a remove that finds nothing on its repeat as done', async () => {
    const h = seeded();
    const contact = h.state.addMailContact({
      displayName: 'Partner',
      alias: 'partner',
      externalEmailAddress: 'partner@elsewhere.example',
    });
    h.launcher.script((call) => (call.index === 0 ? 'apply-then-exit' : undefined));
    await expect(h.drive(h.client.removeMailContact(contact.guid))).resolves.toBeUndefined();
    expect(h.state.contacts()).toHaveLength(0);
  });

  it('a Remove that finds nothing on its FIRST attempt is not_found', async () => {
    const h = seeded();
    const failure = await rejectionOf(
      h.drive(h.client.removeMailContact('00000000-0000-4000-8000-000000000001')),
    );
    expect(failure).toBeInstanceOf(ExchangeCommandError);
    expect((failure as ExchangeCommandError).commandCode).toBe('not_found');
  });

  it('turns a timeout that Exchange itself reports into the same restart rule', async () => {
    const h = seeded();
    h.launcher.script((call) => (call.index === 0 ? { error: 'timeout' } : undefined));
    expect((await h.drive(h.client.getDistributionGroup(GROUP)))?.primarySmtpAddress).toBe(GROUP);
    expect(h.launcher.calls()).toBe(2);
  });
});

describe('answers that are not retried', () => {
  it.each([
    'not_found',
    'already_exists',
    'member_type_not_allowed',
    'permission_denied',
    'manager_check',
    'read_only_object',
  ] as const)('%s is thrown as it is, after one call', async (code) => {
    const h = seeded();
    h.launcher.script(() => ({ error: code }));
    const failure = await rejectionOf(
      h.drive(h.client.addDistributionGroupMember(h.group.guid, h.anna.guid)),
    );
    expect(failure).toBeInstanceOf(ExchangeCommandError);
    expect((failure as ExchangeCommandError).commandCode).toBe(code);
    expect(h.launcher.calls()).toBe(1);
  });

  it('not_found of a read of one object is null, not an error', async () => {
    const h = seeded();
    h.launcher.script(() => ({ error: 'not_found' }));
    expect(await h.drive(h.client.getDistributionGroup(GROUP))).toBeNull();
  });

  it('role_pending is exchange_unavailable with that reason (EC-D2), after one call', async () => {
    const h = seeded();
    h.launcher.script(() => ({ error: 'role_pending' }));
    const failure = await rejectionOf(h.drive(h.client.getDistributionGroup(GROUP)));
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect((failure as ExchangeUnavailableError).reason).toBe('role_pending');
    expect(h.launcher.calls()).toBe(1);
  });

  it('invalid_argument from the worker is a client error: nothing sent was valid', async () => {
    const h = seeded();
    h.launcher.script(() => ({ error: 'invalid_argument' }));
    const failure = await rejectionOf(h.drive(h.client.getDistributionGroup(GROUP)));
    expect(failure).toBeInstanceOf(ExchangeUnsupportedError);
    expect(h.launcher.calls()).toBe(1);
  });

  it('internal is exchange_unavailable with the reason internal', async () => {
    const h = seeded();
    h.launcher.script(() => ({ error: 'internal' }));
    const failure = await rejectionOf(h.drive(h.client.getDistributionGroup(GROUP)));
    expect((failure as ExchangeUnavailableError).reason).toBe('internal');
  });

  it('not_connected resets the connection and repeats once', async () => {
    const h = seeded();
    h.launcher.script((call) => (call.index === 0 ? { error: 'not_connected' } : undefined));
    expect((await h.drive(h.client.getDistributionGroup(GROUP)))?.primarySmtpAddress).toBe(GROUP);
    expect(h.launcher.launches).toBe(2);
    expect(h.launcher.processes[0]!.killed).toBe(true);
  });
});
