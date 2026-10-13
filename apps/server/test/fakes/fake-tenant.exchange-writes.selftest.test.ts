// T-D-115, FR-D-102, FR-D-103, plan 6 (+ negative): the strictness of the fake tenant's Exchange
// WRITE module and of the worker stand-in. A lenient fake gives false greens (baseline section 2),
// so each rule below is a Microsoft Learn statement (research R-D-02, R-D-09) or a documented choice
// where Learn is silent (U78, U80, U94, U95), and a test that the fake still refuses what Exchange
// refuses. `STRICT_EXCHANGE_RULES` lists them for the gate note and the owner's ledger.
//
// The simulation encodes OUR reading of Learn; it cannot prove what Exchange does. What a real tenant
// must confirm is the owner-verified ledger (OV-D1, OV-D2, OV-D5), not this file.
import { encodeLine, parseResponseLine } from '@m365portal/shared/exchange/protocol';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { PROJECTIONS } from '../../src/integrations/exchange/pwsh/projections.js';
import { FakeExchangeState, runCmdlet, type CmdletOutcome } from './fake-tenant/exchange/index.js';
import { createStandInLauncher } from './fake-tenant/exchange/worker-standin.js';

/** The statements the Exchange write module encodes. */
export const STRICT_EXCHANGE_RULES: readonly { rule: string; learn: string }[] = [
  {
    rule: 'a distribution group accepts mailboxes, mail users, mail contacts and mail-enabled groups as members, and nothing else (Microsoft 365 groups and dynamic groups are refused)',
    learn:
      'https://learn.microsoft.com/powershell/module/exchangepowershell/add-distributiongroupmember (Member types)',
  },
  {
    rule: 'a recipient that is not mail-enabled does not exist for Exchange: not_found',
    learn:
      'https://learn.microsoft.com/powershell/module/exchangepowershell/add-distributiongroupmember (non-mail-enabled Entra users are not supported)',
  },
  {
    rule: 'a caller who is not in ManagedBy needs -BypassSecurityGroupManagerCheck AND the role that allows it (Organization Management or Security Group Creation and Membership)',
    learn:
      'https://learn.microsoft.com/powershell/module/exchangepowershell/add-distributiongroupmember (-BypassSecurityGroupManagerCheck); U78 for the app-only principal',
  },
  {
    rule: 'a group synchronised from on-premises cannot be changed in the cloud (read_only_object); the same is assumed for contacts (U80)',
    learn:
      'https://learn.microsoft.com/troubleshoot/exchange/groups-and-distribution-lists/cannot-manage-dg',
  },
  {
    rule: 'Add- and Remove-DistributionGroupMember cannot be used on dynamic distribution groups (not found)',
    learn:
      'https://learn.microsoft.com/powershell/module/exchangepowershell/remove-distributiongroupmember',
  },
  {
    rule: 'adding an existing member and removing a non-member are errors (already_member, not_a_member): the fake documents its choice, U94',
    learn: 'research R-D-09, U94 (the pages are silent)',
  },
  {
    rule: 'Get-MailContact with an -Identity that does not exist returns ALL contacts',
    learn:
      'https://learn.microsoft.com/powershell/module/exchangepowershell/get-mailcontact (Identity caution)',
  },
  {
    rule: 'New-MailContact: -Name and -ExternalEmailAddress are mandatory, -Name is unique, the alias is derived from the name when absent, the external address is the primary address and is unique among recipients',
    learn:
      'https://learn.microsoft.com/powershell/module/exchangepowershell/new-mailcontact; uniqueness scope is U95',
  },
  {
    rule: 'Set-MailContact has no first or last name; an identity that does not resolve is an error',
    learn: 'https://learn.microsoft.com/powershell/module/exchangepowershell/set-mailcontact',
  },
  {
    rule: 'OPATH: the wildcard is only a suffix, only -like takes one, operators are -and -or -like -eq, an unknown property is not a recognised filterable property',
    learn:
      'https://learn.microsoft.com/powershell/exchange/recipient-filters; https://learn.microsoft.com/powershell/exchange/filter-properties',
  },
  {
    rule: 'a cmdlet that is not given -ResultSize returns a default number of rows (1,000 for Get-MailContact, U79 for the others)',
    learn:
      'https://learn.microsoft.com/powershell/module/exchangepowershell/get-mailcontact (ResultSize); U79',
  },
  {
    rule: 'a change is visible to a read only after a delay (eventual consistency, U82)',
    learn: 'research U82 (Learn states none for Exchange cmdlets)',
  },
];

function call(
  state: FakeExchangeState,
  cmdlet: string,
  args: Record<string, unknown>,
): CmdletOutcome {
  return runCmdlet(state, cmdlet, args);
}

function code(outcome: CmdletOutcome): string {
  return outcome.ok ? 'ok' : outcome.error;
}

function rows(outcome: CmdletOutcome): Record<string, unknown>[] {
  if (!outcome.ok) throw new Error(`the call failed: ${outcome.error}`);
  return (outcome.data as { rows: Record<string, unknown>[] }).rows;
}

/** A world with the cast of the rules. */
function world() {
  const state = new FakeExchangeState();
  const anna = state.addRecipient({
    displayName: 'Anna Jansen',
    primarySmtpAddress: 'anna@contoso-fake.example',
  });
  const team = state.addRecipient({
    displayName: 'Team Alpha',
    primarySmtpAddress: 'team@contoso-fake.example',
    recipientTypeDetails: 'GroupMailbox',
  });
  const shared = state.addRecipient({
    displayName: 'Shared',
    primarySmtpAddress: 'shared@contoso-fake.example',
    recipientTypeDetails: 'SharedMailbox',
  });
  const contact = state.addMailContact({
    displayName: 'Carol',
    alias: 'carol',
    externalEmailAddress: 'carol@partner.example',
  });
  const synced = state.addMailContact({
    displayName: 'Synced Contact',
    alias: 'syncedcontact',
    externalEmailAddress: 'synced@partner.example',
    isDirSynced: true,
  });
  const managed = state.addDistributionGroup({
    name: 'Managed',
    primarySmtpAddress: 'managed@contoso-fake.example',
    managedByApp: true,
  });
  const has = state.addDistributionGroup({
    name: 'HasAnna',
    primarySmtpAddress: 'hasanna@contoso-fake.example',
    managedByApp: true,
    members: [anna],
  });
  const foreign = state.addDistributionGroup({
    name: 'Foreign',
    primarySmtpAddress: 'foreign@contoso-fake.example',
  });
  const onPrem = state.addDistributionGroup({
    name: 'OnPrem',
    primarySmtpAddress: 'onprem@contoso-fake.example',
    isDirSynced: true,
    members: [anna],
  });
  const dynamic = state.addDistributionGroup({
    name: 'Dyn',
    primarySmtpAddress: 'dyn@contoso-fake.example',
    recipientTypeDetails: 'DynamicDistributionGroup',
  });
  return { state, anna, team, shared, contact, synced, managed, has, foreign, onPrem, dynamic };
}

/** The table of refusals, so that the lenient runner can be run through the same guard. */
const REFUSALS: readonly {
  name: string;
  cmdlet: string;
  args: (w: ReturnType<typeof world>) => Record<string, unknown>;
  expected: string;
}[] = [
  {
    name: 'a Microsoft 365 group as a member',
    cmdlet: 'Add-DistributionGroupMember',
    args: (w) => ({
      Identity: w.foreign.guid,
      Member: w.team.guid,
      BypassSecurityGroupManagerCheck: true,
    }),
    expected: 'member_type_not_allowed',
  },
  {
    name: 'a recipient that does not exist',
    cmdlet: 'Add-DistributionGroupMember',
    args: (w) => ({
      Identity: w.foreign.guid,
      Member: 'ghost@contoso-fake.example',
      BypassSecurityGroupManagerCheck: true,
    }),
    expected: 'not_found',
  },
  {
    name: 'a caller who does not manage the group and gives no bypass',
    cmdlet: 'Add-DistributionGroupMember',
    args: (w) => ({ Identity: w.foreign.guid, Member: w.anna.guid }),
    expected: 'manager_check',
  },
  {
    name: 'a synced group',
    cmdlet: 'Add-DistributionGroupMember',
    args: (w) => ({
      Identity: w.onPrem.guid,
      Member: w.shared.guid,
      BypassSecurityGroupManagerCheck: true,
    }),
    expected: 'read_only_object',
  },
  {
    name: 'a dynamic group',
    cmdlet: 'Add-DistributionGroupMember',
    args: (w) => ({
      Identity: w.dynamic.guid,
      Member: w.shared.guid,
      BypassSecurityGroupManagerCheck: true,
    }),
    expected: 'not_found',
  },
  {
    name: 'an existing member',
    cmdlet: 'Add-DistributionGroupMember',
    args: (w) => ({ Identity: w.has.guid, Member: w.anna.guid }),
    expected: 'already_member',
  },
  {
    name: 'a non-member',
    cmdlet: 'Remove-DistributionGroupMember',
    args: (w) => ({ Identity: w.managed.guid, Member: w.shared.guid }),
    expected: 'not_a_member',
  },
  {
    name: 'a contact with a used address',
    cmdlet: 'New-MailContact',
    args: () => ({
      Name: 'Other-1',
      ExternalEmailAddress: 'carol@partner.example',
      Alias: 'other',
    }),
    expected: 'already_exists',
  },
  {
    name: 'a contact with a used name',
    cmdlet: 'New-MailContact',
    args: () => ({ Name: 'Carol', ExternalEmailAddress: 'other@partner.example', Alias: 'other' }),
    expected: 'already_exists',
  },
  {
    name: 'a synced contact changed',
    cmdlet: 'Set-MailContact',
    args: (w) => ({ Identity: w.synced.guid, DisplayName: 'x' }),
    expected: 'read_only_object',
  },
  {
    name: 'a contact that does not exist, changed',
    cmdlet: 'Set-MailContact',
    args: () => ({ Identity: 'ghost', DisplayName: 'x' }),
    expected: 'not_found',
  },
  {
    name: 'a wildcard as a prefix',
    cmdlet: 'Get-DistributionGroup',
    args: () => ({ Filter: "Name -like '*x'" }),
    expected: 'invalid_argument',
  },
  {
    name: 'a property that is not filterable',
    cmdlet: 'Get-DistributionGroup',
    args: () => ({ Filter: "Secret -eq 'x'" }),
    expected: 'invalid_argument',
  },
  {
    name: 'an operator that does not exist',
    cmdlet: 'Get-DistributionGroup',
    args: () => ({ Filter: "Name -match 'x'" }),
    expected: 'invalid_argument',
  },
];

describe('the list of rules', () => {
  it('names a Learn page, the research or the open point for every rule', () => {
    expect(STRICT_EXCHANGE_RULES.length).toBeGreaterThanOrEqual(12);
    for (const entry of STRICT_EXCHANGE_RULES)
      expect(entry.learn).toMatch(/learn\.microsoft\.com|research|U\d\d/);
  });
});

describe('Exchange refuses what Learn says it refuses (the write module)', () => {
  it.each(REFUSALS)('refuses $name', ({ cmdlet, args, expected }) => {
    const w = world();
    expect(code(call(w.state, cmdlet, args(w)))).toBe(expected);
  });

  it('refuses without changing anything', () => {
    const w = world();
    const before = JSON.stringify(
      [...w.state.distributionGroups.values()].map((g) => g.members.map((m) => m.guid)),
    );
    for (const { cmdlet, args } of REFUSALS) call(w.state, cmdlet, args(w));
    const after = JSON.stringify(
      [...w.state.distributionGroups.values()].map((g) => g.members.map((m) => m.guid)),
    );
    expect(after).toBe(before);
    expect(w.state.contacts()).toHaveLength(2);
  });

  it('accepts a mailbox, a shared mailbox, a mail user and a contact as members', () => {
    const w = world();
    const mailUser = w.state.addRecipient({
      displayName: 'Mail User',
      primarySmtpAddress: 'mu@contoso-fake.example',
      recipientTypeDetails: 'MailUser',
    });
    for (const member of [w.anna, w.shared, mailUser, w.contact]) {
      expect(
        code(
          call(w.state, 'Add-DistributionGroupMember', {
            Identity: w.managed.guid,
            Member: member.guid,
          }),
        ),
      ).toBe('ok');
    }
    expect(w.state.groupMembers(w.managed.guid)).toHaveLength(4);
  });

  it('knows a member by name, alias, address and GUID, and refuses an ambiguous name', () => {
    const w = world();
    const twin = w.state.addRecipient({
      displayName: 'Anna Jansen',
      primarySmtpAddress: 'anna2@contoso-fake.example',
    });
    expect(twin.guid).not.toBe(w.anna.guid);
    expect(
      code(
        call(w.state, 'Add-DistributionGroupMember', {
          Identity: w.managed.guid,
          Member: 'anna2@contoso-fake.example',
        }),
      ),
    ).toBe('ok');
    expect(
      code(
        call(w.state, 'Add-DistributionGroupMember', {
          Identity: w.managed.guid,
          Member: 'Anna Jansen',
        }),
      ),
    ).toBe('invalid_argument');
    expect(
      code(
        call(w.state, 'Add-DistributionGroupMember', {
          Identity: w.managed.guid,
          Member: w.anna.guid.toUpperCase(),
        }),
      ),
    ).toBe('ok');
  });

  it('needs the role for the bypass: managed groups do not, foreign groups do (U78)', () => {
    const w = world();
    expect(
      code(
        call(w.state, 'Add-DistributionGroupMember', {
          Identity: w.managed.guid,
          Member: w.anna.guid,
        }),
      ),
    ).toBe('ok');
    w.state.setAppHoldsOrganizationManagement(false);
    expect(
      code(
        call(w.state, 'Add-DistributionGroupMember', {
          Identity: w.foreign.guid,
          Member: w.anna.guid,
          BypassSecurityGroupManagerCheck: true,
        }),
      ),
    ).toBe('permission_denied');
    expect(
      code(
        call(w.state, 'Add-DistributionGroupMember', {
          Identity: w.foreign.guid,
          Member: w.anna.guid,
        }),
      ),
    ).toBe('manager_check');
    w.state.setAppHoldsOrganizationManagement(true);
    expect(
      code(
        call(w.state, 'Add-DistributionGroupMember', {
          Identity: w.foreign.guid,
          Member: w.anna.guid,
          BypassSecurityGroupManagerCheck: true,
        }),
      ),
    ).toBe('ok');
  });

  it('removes a contact from every group it was in', () => {
    const w = world();
    call(w.state, 'Add-DistributionGroupMember', {
      Identity: w.managed.guid,
      Member: w.contact.guid,
    });
    expect(w.state.groupMembers(w.managed.guid).map((m) => m.guid)).toContain(w.contact.guid);
    expect(code(call(w.state, 'Remove-MailContact', { Identity: w.contact.guid }))).toBe('ok');
    expect(w.state.groupMembers(w.managed.guid).map((m) => m.guid)).not.toContain(w.contact.guid);
  });
});

describe('what a read gives (the trap and the defaults)', () => {
  it('Get-MailContact with an identity that does not exist returns ALL contacts (R-D-09)', () => {
    const w = world();
    const all = rows(call(w.state, 'Get-MailContact', { Identity: 'ghost' }));
    expect(all).toHaveLength(2);
    expect(rows(call(w.state, 'Get-MailContact', { Identity: w.contact.guid }))).toHaveLength(1);
  });

  it('derives the alias from the name when none is given, and uses the external address as primary', () => {
    const w = world();
    const created = rows(
      call(w.state, 'New-MailContact', {
        Name: 'Piet Partner',
        ExternalEmailAddress: 'piet@partner.example',
      }),
    )[0]!;
    expect(created.Alias).toBe('PietPartner');
    expect(created.DisplayName).toBe('Piet Partner');
    expect(created.PrimarySmtpAddress).toBe('piet@partner.example');
    expect(created.ExternalEmailAddress).toBe('piet@partner.example');
  });

  it('returns only the projected properties of each cmdlet, and nothing else', () => {
    const w = world();
    for (const [cmdlet, args] of [
      ['Get-DistributionGroup', {}],
      ['Get-MailContact', {}],
      ['Get-Recipient', {}],
      ['Get-DistributionGroupMember', { Identity: w.onPrem.guid }],
      ['Get-OrganizationConfig', {}],
    ] as const) {
      for (const row of rows(call(w.state, cmdlet, args))) {
        expect(Object.keys(row).sort(), cmdlet).toEqual([...PROJECTIONS[cmdlet]].sort());
      }
    }
  });

  it('Get-DistributionGroup does not return dynamic groups, Get-Recipient returns everything that is mail-enabled', () => {
    const w = world();
    const groups = rows(call(w.state, 'Get-DistributionGroup', {})).map((row) => row.Name);
    expect(groups).not.toContain('Dyn');
    expect(groups).toEqual(expect.arrayContaining(['Managed', 'Foreign', 'OnPrem', 'HasAnna']));
    const dynamic = rows(
      call(w.state, 'Get-Recipient', { RecipientTypeDetails: ['DynamicDistributionGroup'] }),
    );
    expect(dynamic.map((row) => row.Name)).toEqual(['Dyn']);
    expect(rows(call(w.state, 'Get-Recipient', {})).length).toBeGreaterThan(8);
  });

  it('Get-DistributionGroupMember does not find a dynamic group', () => {
    const w = world();
    expect(code(call(w.state, 'Get-DistributionGroupMember', { Identity: w.dynamic.guid }))).toBe(
      'not_found',
    );
  });

  it('returns the default number of rows without -ResultSize, all with Unlimited, n with n', () => {
    const w = world();
    w.state.setDefaultResultSize(1);
    expect(rows(call(w.state, 'Get-MailContact', {}))).toHaveLength(1);
    expect(rows(call(w.state, 'Get-MailContact', { ResultSize: 'Unlimited' }))).toHaveLength(2);
    expect(rows(call(w.state, 'Get-MailContact', { ResultSize: 2 }))).toHaveLength(2);
    expect(rows(call(w.state, 'Get-DistributionGroup', { ResultSize: 1 }))).toHaveLength(1);
  });

  it('reads an OPATH filter: -like with a suffix wildcard, -eq, -or, doubled quotes', () => {
    const w = world();
    expect(
      rows(call(w.state, 'Get-DistributionGroup', { Filter: "Name -like 'man*'" })).map(
        (r) => r.Name,
      ),
    ).toEqual(['Managed']);
    expect(
      rows(call(w.state, 'Get-DistributionGroup', { Filter: "Name -eq 'foreign'" })).map(
        (r) => r.Name,
      ),
    ).toEqual(['Foreign']);
    expect(
      rows(
        call(w.state, 'Get-DistributionGroup', {
          Filter: "Name -like 'man*' -or Name -like 'for*'",
        }),
      )
        .map((r) => r.Name)
        .sort(),
    ).toEqual(['Foreign', 'Managed']);
    w.state.addDistributionGroup({
      name: "O'Brien",
      primarySmtpAddress: 'ob@contoso-fake.example',
    });
    expect(
      rows(call(w.state, 'Get-DistributionGroup', { Filter: "Name -like 'o''b*'" })).map(
        (r) => r.Name,
      ),
    ).toEqual(["O'Brien"]);
    expect(code(call(w.state, 'Get-DistributionGroup', { Filter: "Name -like 'x' -or" }))).toBe(
      'invalid_argument',
    );
    expect(
      code(call(w.state, 'Get-DistributionGroup', { Filter: "Name -like 'unterminated" })),
    ).toBe('invalid_argument');
  });

  it('shows a change only after the delay, and the write path is never stale (U82)', () => {
    const w = world();
    w.state.setReadBackDelay(2);
    expect(
      code(
        call(w.state, 'Add-DistributionGroupMember', {
          Identity: w.managed.guid,
          Member: w.shared.guid,
        }),
      ),
    ).toBe('ok');
    expect(
      code(
        call(w.state, 'Add-DistributionGroupMember', {
          Identity: w.managed.guid,
          Member: w.shared.guid,
        }),
      ),
    ).toBe('already_member');
    const count = (): number =>
      rows(call(w.state, 'Get-DistributionGroupMember', { Identity: w.managed.guid })).length;
    expect([count(), count(), count()]).toEqual([0, 0, 1]);
  });
});

describe('the worker stand-in speaks the protocol strictly', () => {
  const connect = {
    v: 1,
    type: 'connect',
    id: 'connect-0001',
    appId: '11111111-2222-4333-8444-555555555555',
    organization: 'contoso-fake.onmicrosoft.com',
    certificate: { format: 'pfx-base64', data: 'AAAA', password: 'x' },
  };

  function open() {
    const w = world();
    const launcher = createStandInLauncher(w.state);
    const process = launcher.launch({ certificateMode: 'memory' });
    const answers: string[] = [];
    process.onData((chunk) => answers.push(chunk));
    const send = async (message: unknown): Promise<ReturnType<typeof parseResponseLine>[]> => {
      answers.length = 0;
      process.write(typeof message === 'string' ? message : encodeLine(message));
      await new Promise((resolve) => setImmediate(resolve));
      return answers
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map(parseResponseLine);
    };
    return { w, process, send };
  }

  it('answers not_connected to a call before the connect message', async () => {
    const { send } = open();
    const [answer] = await send({
      v: 1,
      type: 'call',
      id: 'call-00001',
      cmdlet: 'Get-OrganizationConfig',
      args: {},
      deadlineMs: 5000,
    });
    expect(answer).toMatchObject({
      ok: true,
      value: { ok: false, error: { code: 'not_connected' } },
    });
  });

  it('answers a ping at any time, and a connect once; a second connect is not needed', async () => {
    const { send } = open();
    const [pong] = await send({ v: 1, type: 'ping', id: 'ping-00001' });
    expect(pong).toMatchObject({ ok: true, value: { ok: true } });
    const [connected] = await send(connect);
    expect(connected).toMatchObject({ ok: true, value: { ok: true } });
  });

  it('refuses a call outside the allow-list with invalid_argument, and a line that is not the protocol with nothing but a closed code', async () => {
    const { send } = open();
    await send(connect);
    const [refused] = await send(
      `${JSON.stringify({ v: 1, type: 'call', id: 'call-00002', cmdlet: 'Get-Mailbox', args: {}, deadlineMs: 5000 })}\n`,
    );
    expect(refused).toMatchObject({
      ok: true,
      value: { ok: false, error: { code: 'invalid_argument' } },
    });
    const [junk] = await send('this is not json\n');
    expect(junk).toMatchObject({
      ok: true,
      value: { ok: false, error: { code: 'invalid_argument' } },
    });
  });

  it('never puts text from the request into an answer', async () => {
    const { send } = open();
    await send(connect);
    const [answer] = await send({
      v: 1,
      type: 'call',
      id: 'call-00003',
      cmdlet: 'Remove-MailContact',
      args: { Identity: 'Zoë Canary' },
      deadlineMs: 5000,
    });
    expect(JSON.stringify(answer)).not.toContain('Canary');
  });
});

describe('negative: a lenient fake would have accepted what these tests refuse', () => {
  /** The guard behind the table: the runner must give the documented code. */
  const assertRefusals = (
    runner: (
      w: ReturnType<typeof world>,
      cmdlet: string,
      args: Record<string, unknown>,
    ) => CmdletOutcome,
  ): void => {
    for (const refusal of REFUSALS) {
      const w = world();
      const got = code(runner(w, refusal.cmdlet, refusal.args(w)));
      if (got !== refusal.expected)
        throw new Error(
          `${refusal.name}: the fake gave ${got}, Exchange gives ${refusal.expected}`,
        );
    }
  };

  it('the real runner passes the table', () => {
    expect(() => {
      assertRefusals((w, cmdlet, args) => call(w.state, cmdlet, args));
    }).not.toThrow();
  });

  it('a runner that accepts everything fails the table', () => {
    expectGuardFails(assertRefusals, () => ({ ok: true, data: { done: true } }), {
      name: 'accept-all runner',
      reason: 'the fake gave ok, Exchange gives',
    });
  });

  it('a runner that skips the manager check, or the member type check, fails the table', () => {
    const lenientOn =
      (skipped: string) =>
      (
        w: ReturnType<typeof world>,
        cmdlet: string,
        args: Record<string, unknown>,
      ): CmdletOutcome => {
        const result = call(w.state, cmdlet, args);
        return !result.ok && result.error === skipped ? { ok: true, data: { done: true } } : result;
      };
    expectGuardFails(assertRefusals, lenientOn('manager_check'), {
      name: 'no manager check',
      reason: 'the fake gave ok, Exchange gives manager_check',
    });
    expectGuardFails(assertRefusals, lenientOn('member_type_not_allowed'), {
      name: 'no type check',
      reason: 'Exchange gives member_type_not_allowed',
    });
    expectGuardFails(assertRefusals, lenientOn('read_only_object'), {
      name: 'synced objects writable',
      reason: 'Exchange gives read_only_object',
    });
  });
});
