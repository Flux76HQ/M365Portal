// T-D-112, FR-D-102, FR-D-107 (+ negative: allow-list bypass attempt): the worker session speaks the
// line protocol of `@m365portal/shared/exchange/protocol` to a scripted stand-in process (no
// `pwsh`). What it proves: the first line is the connect message, every call is one validated line
// with its own id, a cmdlet outside the allow-list or a parameter outside its schema is refused
// BEFORE a byte is written (the worker is not even started), an answer for another id is ignored,
// noise is skipped, a malformed or oversized answer kills the worker, and a command error is data.
import { LIMITS } from '@m365portal/shared/limits';
import { parseRequestLine } from '@m365portal/shared/exchange/protocol';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  ExchangeCommandError,
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
} from '../../src/ports/errors.js';
import { rejectionOf } from '../integrations/support.js';
import { sessionHarness } from './support.js';

const GROUP = '5a6b7c8d-1111-4222-8333-944455556666';

describe('the first line is connect, every call is one line with its own id', () => {
  it('connects on the first request, then writes the call', async () => {
    const h = sessionHarness();
    const answer = await h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} }));
    expect(answer.response.ok).toBe(true);
    expect(h.launcher.launches).toBe(1);
    const [first, second] = h.launcher.processes[0]!.received;
    const connect = parseRequestLine(first!);
    expect(connect.ok && connect.value.type).toBe('connect');
    const call = parseRequestLine(second!);
    expect(call.ok && call.value.type).toBe('call');
    if (call.ok && call.value.type === 'call') {
      expect(call.value.cmdlet).toBe('Get-OrganizationConfig');
      expect(call.value.deadlineMs).toBe(LIMITS.exchange.callDeadlineSeconds * 1000);
      expect(call.value.id).toBe(answer.id);
    }
    expect(first!.endsWith('\n')).toBe(true);
    expect(first!.trimEnd().includes('\n')).toBe(false);
  });

  it('hands the credential over once per worker, and never again', async () => {
    const h = sessionHarness();
    await h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} }));
    await h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} }));
    expect(h.credentials.loads).toBe(1);
    const connects = h.launcher.processes[0]!.received.filter((line) => line.includes('"connect"'));
    expect(connects).toHaveLength(1);
  });

  it('gives every call a different id of the allowed shape', async () => {
    const h = sessionHarness();
    const ids = new Set<string>();
    for (let n = 0; n < 5; n += 1) {
      const answer = await h.drive(
        h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} }),
      );
      expect(answer.id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
      ids.add(answer.id);
    }
    expect(ids.size).toBe(5);
  });

  it('writes the arguments that were validated, not the object the caller holds', async () => {
    const h = sessionHarness();
    const args: Record<string, unknown> = { Identity: GROUP };
    const pending = h.session.request({ cmdlet: 'Get-DistributionGroupMember', args });
    args.Identity = 'changed-after-the-call';
    await h.drive(pending);
    const line = h.launcher.processes[0]!.received.find((entry) => entry.includes('"call"'))!;
    expect(line).toContain(GROUP);
    expect(line).not.toContain('changed-after-the-call');
  });
});

/** Calls that must never reach the worker. */
const HOSTILE_CALLS: readonly { name: string; cmdlet: unknown; args: unknown }[] = [
  { name: 'a cmdlet outside the list', cmdlet: 'Get-Mailbox', args: {} },
  { name: 'a write cmdlet outside the list', cmdlet: 'Remove-Mailbox', args: { Identity: 'x' } },
  { name: 'Invoke-Expression', cmdlet: 'Invoke-Expression', args: { Command: 'whoami' } },
  { name: 'a lower-case name', cmdlet: 'get-distributiongroup', args: {} },
  { name: 'a trailing space', cmdlet: 'Get-DistributionGroup ', args: {} },
  { name: 'a leading space', cmdlet: ' Remove-MailContact', args: { Identity: GROUP } },
  { name: 'two statements in one name', cmdlet: 'Get-OrganizationConfig;Get-Mailbox', args: {} },
  { name: 'a newline in the name', cmdlet: 'Get-OrganizationConfig\nGet-Mailbox', args: {} },
  { name: 'an empty name', cmdlet: '', args: {} },
  { name: 'a prototype name', cmdlet: '__proto__', args: {} },
  { name: 'constructor', cmdlet: 'constructor', args: {} },
  { name: 'a number', cmdlet: 42, args: {} },
  {
    name: 'Confirm as a caller parameter',
    cmdlet: 'Remove-MailContact',
    args: { Identity: GROUP, Confirm: false },
  },
  {
    name: 'WhatIf as a caller parameter',
    cmdlet: 'Remove-MailContact',
    args: { Identity: GROUP, WhatIf: true },
  },
  { name: 'a parameter that is not listed', cmdlet: 'Get-DistributionGroup', args: { Anr: 'x' } },
  {
    name: 'a __proto__ key',
    cmdlet: 'Get-DistributionGroup',
    args: JSON.parse('{"__proto__":{"Identity":"x"}}'),
  },
  { name: 'arguments as an array', cmdlet: 'Get-DistributionGroup', args: [] },
  { name: 'null arguments', cmdlet: 'Get-DistributionGroup', args: null },
  {
    name: 'a missing Identity (would list everything)',
    cmdlet: 'Get-DistributionGroupMember',
    args: {},
  },
  {
    name: 'an undefined Identity (vanishes in JSON)',
    cmdlet: 'Get-DistributionGroupMember',
    args: { Identity: undefined },
  },
  { name: 'a blank Identity', cmdlet: 'Remove-MailContact', args: { Identity: '   ' } },
  {
    name: 'an Identity with a line break',
    cmdlet: 'Remove-MailContact',
    args: { Identity: 'a\nb' },
  },
  { name: 'an Identity that is a number', cmdlet: 'Remove-MailContact', args: { Identity: 7 } },
  {
    name: 'an over-long Member',
    cmdlet: 'Add-DistributionGroupMember',
    args: { Identity: GROUP, Member: 'a'.repeat(257) },
  },
  {
    name: 'no Member on a member write',
    cmdlet: 'Add-DistributionGroupMember',
    args: { Identity: GROUP },
  },
  { name: 'a change to nothing', cmdlet: 'Set-MailContact', args: { Identity: GROUP } },
  {
    name: 'a first name on Set-MailContact (it has none)',
    cmdlet: 'Set-MailContact',
    args: { Identity: GROUP, FirstName: 'A' },
  },
  {
    name: 'a primary address on New-MailContact (on-premises only)',
    cmdlet: 'New-MailContact',
    args: { Name: 'n', ExternalEmailAddress: 'a@b.example', PrimarySmtpAddress: 'x@b.example' },
  },
  {
    name: 'an address with a display name',
    cmdlet: 'New-MailContact',
    args: { Name: 'n', ExternalEmailAddress: 'Anna <a@b.example>' },
  },
];

describe('the allow-list is enforced before anything is written (FR-D-102)', () => {
  it.each(HOSTILE_CALLS)('refuses $name without starting the worker', async ({ cmdlet, args }) => {
    const h = sessionHarness();
    const failure = await rejectionOf(
      h.session.request({ cmdlet: cmdlet as string, args: args as Record<string, unknown> }),
    );
    expect(failure).toBeInstanceOf(ExchangeUnsupportedError);
    expect((failure as ExchangeUnsupportedError).reason).toBe('not_allowed');
    expect(h.launcher.launches).toBe(0);
    expect(h.credentials.loads).toBe(0);
  });

  it('never repeats a refused value in the error', async () => {
    const h = sessionHarness();
    const failure = await rejectionOf(
      h.session.request({ cmdlet: 'Remove-MailContact', args: { Identity: 'secret-name\nx' } }),
    );
    expect(JSON.stringify(failure)).not.toContain('secret-name');
    expect(String(failure)).not.toContain('secret-name');
  });

  it('negative: a requester that skips the check lets a forbidden call reach the worker, and the guard sees it', async () => {
    const h = sessionHarness();
    // The fixture writes the line itself: what a lenient session would do.
    const lenient = (cmdlet: string, args: Record<string, unknown>): void => {
      const worker = h.launcher.launch({ certificateMode: 'memory' });
      worker.write(
        `${JSON.stringify({ v: 1, type: 'call', id: 'lenient-0001', cmdlet, args, deadlineMs: 5000 })}\n`,
      );
    };
    const strict = async (cmdlet: string, args: Record<string, unknown>): Promise<void> => {
      await h.session.request({ cmdlet, args }).catch(() => undefined);
    };
    const guard = async (input: { send: typeof strict }): Promise<void> => {
      const before = h.launcher.processes.reduce((n, p) => n + p.received.length, 0);
      await input.send('Remove-Mailbox', { Identity: 'x' });
      const after = h.launcher.processes.reduce((n, p) => n + p.received.length, 0);
      if (after !== before) throw new Error('a forbidden call reached the worker');
    };
    await expect(guard({ send: strict })).resolves.toBeUndefined();
    await expectGuardFails(
      guard,
      {
        send: (cmdlet, args) => {
          lenient(cmdlet, args);
          return Promise.resolve();
        },
      },
      { name: 'lenient requester', reason: 'a forbidden call reached the worker' },
    );
  });
});

describe('what comes back', () => {
  it('returns a command error as data: the session does not throw for it', async () => {
    const h = sessionHarness();
    const answer = await h.drive(
      h.session.request({
        cmdlet: 'Add-DistributionGroupMember',
        args: { Identity: 'nobody@contoso-fake.example', Member: 'x@contoso-fake.example' },
      }),
    );
    expect(answer.response).toEqual({
      v: 1,
      id: answer.id,
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('ignores an answer for another id and waits for its own', async () => {
    const h = sessionHarness();
    h.launcher.script(() => ({
      before: [JSON.stringify({ v: 1, id: 'someone-else-1', ok: true, data: { wrong: true } })],
    }));
    const answer = await h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} }));
    expect(answer.response.ok && (answer.response.data as { wrong?: boolean }).wrong).toBeFalsy();
    expect(answer.response.ok).toBe(true);
  });

  it('skips a line that is not JSON (a banner, a warning) and keeps the worker', async () => {
    const h = sessionHarness();
    h.launcher.script(() => ({ before: ['WARNING: something printed to stdout', ''] }));
    const answer = await h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} }));
    expect(answer.response.ok).toBe(true);
    expect(h.launcher.processes[0]!.killed).toBe(false);
  });

  it('kills the worker for an answer that is JSON but not the protocol, and starts a new one next time', async () => {
    const h = sessionHarness();
    h.launcher.script((call) =>
      call.index === 0 ? { replace: [JSON.stringify({ v: 1, id: 'x', ok: 'maybe' })] } : undefined,
    );
    const failure = await rejectionOf(
      h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} })),
    );
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect((failure as ExchangeUnavailableError).reason).toBe('worker_protocol');
    expect(h.launcher.processes[0]!.killed).toBe(true);
    const next = await h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} }));
    expect(next.response.ok).toBe(true);
    expect(h.launcher.launches).toBe(2);
  });

  it('kills the worker for a line longer than the limit', async () => {
    const h = sessionHarness();
    h.launcher.script(() => ({
      replace: ['x'.repeat(LIMITS.exchange.lineMaxBytes + 10)],
    }));
    const failure = await rejectionOf(
      h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} })),
    );
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect((failure as ExchangeUnavailableError).reason).toBe('worker_protocol');
    expect(h.launcher.processes[0]!.killed).toBe(true);
  });

  it('reads an answer that arrives in pieces', async () => {
    const h = sessionHarness();
    h.launcher.script(() => ({ chunk: 7 }));
    const answer = await h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} }));
    expect(answer.response.ok).toBe(true);
  });

  it('answers a ping, and a ping starts the worker', async () => {
    const h = sessionHarness();
    expect(await h.drive(h.session.ping())).toBe(true);
    expect(h.launcher.launches).toBe(1);
  });
});

describe('the connect message', () => {
  it('maps a refused connect to a typed error and kills the worker', async () => {
    const h = sessionHarness();
    h.launcher.connect({ error: 'permission_denied' });
    const failure = await rejectionOf(
      h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} })),
    );
    expect(failure).toBeInstanceOf(ExchangeCommandError);
    expect((failure as ExchangeCommandError).commandCode).toBe('permission_denied');
    expect(h.launcher.processes[0]!.killed).toBe(true);
  });

  it('says role_pending for a role that is not effective yet (EC-D2)', async () => {
    const h = sessionHarness();
    h.launcher.connect({ error: 'role_pending' });
    const failure = await rejectionOf(
      h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} })),
    );
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect((failure as ExchangeUnavailableError).reason).toBe('role_pending');
  });

  it('keeps Retry-After of a throttled connect', async () => {
    const h = sessionHarness();
    h.launcher.connect({ error: 'throttled', retryAfterMs: 9_000 });
    const failure = await rejectionOf(
      h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} })),
    );
    expect(failure).toBeInstanceOf(ExchangeCommandError);
    expect((failure as ExchangeCommandError).retryAfterMs).toBe(9_000);
  });

  it('stops a worker whose script was made from another allow-list (PD-02)', async () => {
    const h = sessionHarness();
    h.launcher.connect({ wrongHashes: true });
    const failure = await rejectionOf(
      h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} })),
    );
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect((failure as ExchangeUnavailableError).reason).toBe('worker_protocol');
    expect(h.launcher.processes[0]!.killed).toBe(true);
    // Nothing was sent to it after the connect.
    expect(h.launcher.processes[0]!.received).toHaveLength(1);
  });

  it('does not start a worker when the credential cannot be read, and says why in a fixed word', async () => {
    const h = sessionHarness();
    h.credentials.failWith(new Error('database is locked: /data/app.db'));
    const failure = await rejectionOf(
      h.drive(h.session.request({ cmdlet: 'Get-OrganizationConfig', args: {} })),
    );
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect((failure as ExchangeUnavailableError).reason).toBe('worker_start_failed');
    expect(String(failure) + JSON.stringify(failure)).not.toContain('/data/app.db');
    expect(h.launcher.launches).toBe(0);
  });
});
