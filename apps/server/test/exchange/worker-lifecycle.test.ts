// T-D-112, FR-D-104, EC-D1 (fake clock, scripted stand-in): a stuck call is killed at its deadline
// and the next call gets a new worker; the worker is recycled after `workerMaxCalls` calls or
// `workerMaxAgeSeconds` seconds; a crash at any step of the protocol (before the connect answer,
// during a call, while idle) is one typed error and a fresh worker next time; requests are serial;
// closing is graceful and idempotent. No test sleeps: time moves with the fake scheduler.
import { LIMITS } from '@m365portal/shared/limits';
import { describe, expect, it } from 'vitest';
import { ExchangeUnavailableError } from '../../src/ports/errors.js';
import { rejectionOf } from '../integrations/support.js';
import { sessionHarness } from './support.js';

const ORG = { cmdlet: 'Get-OrganizationConfig', args: {} } as const;
const DEADLINE_MS = LIMITS.exchange.callDeadlineSeconds * 1000;

function reasonOf(failure: unknown): string {
  expect(failure).toBeInstanceOf(ExchangeUnavailableError);
  return (failure as ExchangeUnavailableError).reason;
}

describe('the deadline (FR-D-104)', () => {
  it('kills the worker when a call does not answer in time, and the next call starts a new one', async () => {
    const h = sessionHarness();
    h.launcher.script((call) => (call.index === 1 ? 'hang' : undefined));
    await h.drive(h.session.request(ORG));
    const stuck = h.session.request({ ...ORG, deadlineMs: 5_000 });
    const outcome = rejectionOf(stuck);
    await h.settle();
    h.time.elapse(4_999);
    await h.settle();
    expect(h.launcher.processes[0]!.killed).toBe(false);
    h.time.elapse(1);
    expect(reasonOf(await outcome)).toBe('worker_timeout');
    expect(h.launcher.processes[0]!.killed).toBe(true);
    const next = await h.drive(h.session.request(ORG));
    expect(next.response.ok).toBe(true);
    expect(h.launcher.launches).toBe(2);
  });

  it('uses the call deadline of the limits table when the caller names none', async () => {
    const h = sessionHarness();
    h.launcher.script((call) => (call.index === 0 ? 'hang' : undefined));
    const outcome = rejectionOf(h.session.request(ORG));
    await h.settle();
    h.time.elapse(DEADLINE_MS - 1);
    await h.settle();
    expect(h.launcher.processes[0]!.killed).toBe(false);
    h.time.elapse(1);
    expect(reasonOf(await outcome)).toBe('worker_timeout');
  });

  it('refuses a deadline over the limit before anything is written', async () => {
    const h = sessionHarness();
    const failure = await rejectionOf(h.session.request({ ...ORG, deadlineMs: DEADLINE_MS + 1 }));
    expect(failure).toBeInstanceOf(Error);
    expect(h.launcher.launches).toBe(0);
  });

  it('stops the timer of a call that answered (nothing is left armed)', async () => {
    const h = sessionHarness();
    await h.drive(h.session.request(ORG));
    expect(h.time.scheduler.pending()).toBe(0);
  });

  it('times out a connect that is never answered', async () => {
    const h = sessionHarness();
    h.launcher.connect('hang');
    const outcome = rejectionOf(h.session.request(ORG));
    await h.settle();
    h.time.elapse(DEADLINE_MS);
    expect(reasonOf(await outcome)).toBe('worker_timeout');
    expect(h.launcher.processes[0]!.killed).toBe(true);
  });
});

describe('recycling (FR-D-104, R-D-03)', () => {
  it('starts a new worker for call 501 and shuts the old one down in order', async () => {
    expect(LIMITS.exchange.workerMaxCalls).toBe(500);
    const h = sessionHarness();
    for (let n = 0; n < 500; n += 1) await h.drive(h.session.request(ORG));
    expect(h.launcher.launches).toBe(1);
    await h.drive(h.session.request(ORG));
    expect(h.launcher.launches).toBe(2);
    const old = h.launcher.processes[0]!;
    expect(old.received.some((line) => line.includes('"shutdown"'))).toBe(true);
    expect(old.stdinClosed).toBe(true);
    // The count restarts: the new worker has connect + 1 call.
    expect(h.launcher.processes[1]!.received).toHaveLength(2);
    expect(h.credentials.loads).toBe(2);
  });

  it('recycles by age: one second before the limit it is the same worker, at the limit a new one', async () => {
    const h = sessionHarness();
    await h.drive(h.session.request(ORG));
    h.time.elapse(LIMITS.exchange.workerMaxAgeSeconds * 1000 - 1);
    await h.drive(h.session.request(ORG));
    expect(h.launcher.launches).toBe(1);
    h.time.elapse(1);
    await h.drive(h.session.request(ORG));
    expect(h.launcher.launches).toBe(2);
    expect(h.launcher.processes[0]!.received.some((line) => line.includes('"shutdown"'))).toBe(
      true,
    );
  });

  it('recycles by a count given in the options, and by nothing else', async () => {
    const h = sessionHarness({ limits: { maxCalls: 3 } });
    for (let n = 0; n < 3; n += 1) await h.drive(h.session.request(ORG));
    expect(h.launcher.launches).toBe(1);
    await h.drive(h.session.request(ORG));
    expect(h.launcher.launches).toBe(2);
  });

  it('kills an old worker that does not leave after the shutdown line', async () => {
    const h = sessionHarness({ limits: { maxCalls: 1 } });
    h.launcher.script((call) => (call.type === 'shutdown' ? 'ignore' : undefined));
    await h.drive(h.session.request(ORG));
    const second = h.drive(h.session.request(ORG));
    await h.settle();
    h.time.elapse(10_000);
    await second;
    expect(h.launcher.processes[0]!.killed).toBe(true);
    expect(h.launcher.launches).toBe(2);
  });
});

describe('a crash at every step of the protocol (plan 9)', () => {
  it('before the connect answer: a typed error, and a new worker next time', async () => {
    const h = sessionHarness();
    h.launcher.connect('exit');
    expect(reasonOf(await rejectionOf(h.drive(h.session.request(ORG))))).toBe('worker_crashed');
    h.launcher.connect('ok');
    const next = await h.drive(h.session.request(ORG));
    expect(next.response.ok).toBe(true);
    expect(h.launcher.launches).toBe(2);
  });

  it('during a call', async () => {
    const h = sessionHarness();
    h.launcher.script((call) => (call.index === 0 ? 'exit' : undefined));
    expect(reasonOf(await rejectionOf(h.drive(h.session.request(ORG))))).toBe('worker_crashed');
    const next = await h.drive(h.session.request(ORG));
    expect(next.response.ok).toBe(true);
    expect(h.launcher.launches).toBe(2);
  });

  it('after the answer, while idle: the next call notices and starts a new worker', async () => {
    const h = sessionHarness();
    await h.drive(h.session.request(ORG));
    h.launcher.processes[0]!.crash();
    await h.settle();
    const next = await h.drive(h.session.request(ORG));
    expect(next.response.ok).toBe(true);
    expect(h.launcher.launches).toBe(2);
  });

  it('while the second of two queued calls waits: the first fails, the second runs on a new worker', async () => {
    const h = sessionHarness();
    h.launcher.script((call) => (call.index === 0 ? 'exit' : undefined));
    const first = rejectionOf(h.session.request(ORG));
    const second = h.session.request(ORG);
    await h.settle();
    expect(reasonOf(await first)).toBe('worker_crashed');
    expect((await h.drive(second)).response.ok).toBe(true);
    expect(h.launcher.launches).toBe(2);
  });

  it('a worker that cannot be started at all is worker_start_failed', async () => {
    const h = sessionHarness();
    h.launcher.failLaunch(1);
    expect(reasonOf(await rejectionOf(h.drive(h.session.request(ORG))))).toBe(
      'worker_start_failed',
    );
    expect((await h.drive(h.session.request(ORG))).response.ok).toBe(true);
  });
});

describe('requests are serial (FR-D-102)', () => {
  it('writes the second call only after the first one is answered, and keeps the order', async () => {
    const h = sessionHarness();
    h.launcher.script((call) => (call.index === 0 ? 'hold' : undefined));
    const first = h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} });
    const second = h.session.request({ cmdlet: 'Get-DistributionGroup', args: {} });
    await h.settle();
    const sent = (): string[] =>
      h.launcher.processes[0]!.received.filter((line) => line.includes('"call"'));
    expect(sent()).toHaveLength(1);
    h.launcher.release();
    await h.settle();
    await Promise.all([first, second].map((p) => h.drive(p)));
    expect(sent()).toHaveLength(2);
    expect(sent()[0]).toContain('Get-OrganizationConfig');
    expect(sent()[1]).toContain('Get-DistributionGroup');
  });

  it('a timed-out call does not stop the queue behind it', async () => {
    const h = sessionHarness();
    h.launcher.script((call) => (call.index === 0 ? 'hang' : undefined));
    const first = rejectionOf(h.session.request({ ...ORG, deadlineMs: 2_000 }));
    const second = h.session.request(ORG);
    await h.settle();
    h.time.elapse(2_000);
    expect(reasonOf(await first)).toBe('worker_timeout');
    expect((await h.drive(second)).response.ok).toBe(true);
  });
});

describe('close', () => {
  it('sends shutdown, closes stdin, and is idempotent', async () => {
    const h = sessionHarness();
    await h.drive(h.session.request(ORG));
    await h.drive(h.session.close());
    await h.drive(h.session.close());
    const worker = h.launcher.processes[0]!;
    expect(worker.received.filter((line) => line.includes('"shutdown"'))).toHaveLength(1);
    expect(worker.stdinClosed).toBe(true);
  });

  it('closing a session that never started does nothing, and a closed session refuses calls', async () => {
    const h = sessionHarness();
    await h.drive(h.session.close());
    expect(h.launcher.launches).toBe(0);
    expect(reasonOf(await rejectionOf(h.session.request(ORG)))).toBe('worker_closed');
    expect(h.launcher.launches).toBe(0);
  });

  it('kills a worker that does not leave after the shutdown line', async () => {
    const h = sessionHarness();
    h.launcher.script((call) => (call.type === 'shutdown' ? 'ignore' : undefined));
    await h.drive(h.session.request(ORG));
    const closing = h.session.close();
    await h.settle();
    h.time.elapse(10_000);
    await closing;
    expect(h.launcher.processes[0]!.killed).toBe(true);
  });
});
