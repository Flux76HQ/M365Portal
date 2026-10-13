// T-D-105, FR-D-102: the CLOSED allow-list of the Exchange worker: cmdlet name -> argument schema.
// Exactly ten cmdlets (R-D-02, R-D-09), each with the parameters Learn documents and nothing else. A
// cmdlet outside the list, an unknown parameter, a missing required parameter, an empty identity (the
// `Get-` cmdlets return everything for it, R-D-09) and every prototype trick are refused BEFORE the
// request reaches the worker. The same table feeds the PowerShell script generator (PD-02), so it is
// plain data and `allowListManifest()` is its canonical text.
import { describe, expect, it } from 'vitest';
import {
  ALLOW_LIST,
  EXCHANGE_CMDLETS,
  EXCHANGE_READ_CMDLETS,
  EXCHANGE_WRITE_CMDLETS,
  TEXT_PATTERNS,
  allowListManifest,
  cmdletArgsSchema,
  isExchangeCmdlet,
  validateCall,
} from '../src/exchange/allow-list.js';
import { expectGuardFails } from '../src/testing/index.js';

const GUID = '8e0c2b8e-0000-4000-8000-0000000000aa';

describe('the closed map', () => {
  it('holds exactly the ten cmdlets of T-D-105, in this order', () => {
    expect([...EXCHANGE_CMDLETS]).toEqual([
      'Get-DistributionGroup',
      'Get-DistributionGroupMember',
      'Add-DistributionGroupMember',
      'Remove-DistributionGroupMember',
      'Get-MailContact',
      'New-MailContact',
      'Set-MailContact',
      'Remove-MailContact',
      'Get-Recipient',
      'Get-OrganizationConfig',
    ]);
    expect(Object.keys(ALLOW_LIST)).toEqual([...EXCHANGE_CMDLETS]);
  });

  it('splits into reads (Get-) and writes (Add-, Remove-, New-, Set-); no other verb exists', () => {
    expect([...EXCHANGE_READ_CMDLETS]).toEqual([
      'Get-DistributionGroup',
      'Get-DistributionGroupMember',
      'Get-MailContact',
      'Get-Recipient',
      'Get-OrganizationConfig',
    ]);
    expect([...EXCHANGE_WRITE_CMDLETS]).toEqual([
      'Add-DistributionGroupMember',
      'Remove-DistributionGroupMember',
      'New-MailContact',
      'Set-MailContact',
      'Remove-MailContact',
    ]);
    for (const name of EXCHANGE_CMDLETS) {
      expect(name).toMatch(/^(?:Get|Add|Remove|New|Set)-[A-Za-z]+$/);
      expect(ALLOW_LIST[name].access).toBe(name.startsWith('Get-') ? 'read' : 'write');
    }
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(ALLOW_LIST)).toBe(true);
    expect(Object.isFrozen(ALLOW_LIST['Get-Recipient'])).toBe(true);
    expect(Object.isFrozen(ALLOW_LIST['Get-Recipient'].params)).toBe(true);
    expect(() => {
      (ALLOW_LIST as Record<string, unknown>)['Invoke-Command'] = {};
    }).toThrow(TypeError);
  });

  it('knows its names by own property only', () => {
    expect(isExchangeCmdlet('Get-Recipient')).toBe(true);
    for (const bad of [
      'get-recipient',
      'Get-Recipient ',
      'Get-Mailbox',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      '',
      42,
      null,
      undefined,
    ]) {
      expect(isExchangeCmdlet(bad), String(bad)).toBe(false);
    }
  });

  it('asks Remove- cmdlets to be run with -Confirm:$false by the script and offers callers no Confirm or WhatIf', () => {
    for (const name of ['Remove-DistributionGroupMember', 'Remove-MailContact'] as const) {
      expect(ALLOW_LIST[name].confirmFalse).toBe(true);
    }
    for (const name of EXCHANGE_CMDLETS) {
      expect(Object.keys(ALLOW_LIST[name].params), name).not.toContain('Confirm');
      expect(Object.keys(ALLOW_LIST[name].params), name).not.toContain('WhatIf');
    }
  });

  it('lists only parameters Learn documents for the cmdlet (R-D-02, R-D-09)', () => {
    const names = (cmdlet: (typeof EXCHANGE_CMDLETS)[number]): string[] =>
      Object.keys(ALLOW_LIST[cmdlet].params).sort();
    expect(names('Add-DistributionGroupMember')).toEqual([
      'BypassSecurityGroupManagerCheck',
      'Identity',
      'Member',
    ]);
    expect(names('Remove-DistributionGroupMember')).toEqual([
      'BypassSecurityGroupManagerCheck',
      'Identity',
      'Member',
    ]);
    expect(names('New-MailContact')).toEqual([
      'Alias',
      'DisplayName',
      'ExternalEmailAddress',
      'FirstName',
      'LastName',
      'Name',
    ]);
    expect(names('Set-MailContact')).toEqual([
      'Alias',
      'DisplayName',
      'ExternalEmailAddress',
      'HiddenFromAddressListsEnabled',
      'Identity',
      'Name',
    ]);
    expect(names('Remove-MailContact')).toEqual(['Identity']);
    expect(names('Get-OrganizationConfig')).toEqual([]);
    // Set-MailContact has no FirstName or LastName (R-D-09, U15); New-MailContact has no PrimarySmtpAddress (on-premises only).
    expect(names('Set-MailContact')).not.toContain('FirstName');
    expect(names('New-MailContact')).not.toContain('PrimarySmtpAddress');
  });
});

describe('validateCall: what passes', () => {
  const passes: readonly (readonly [string, Record<string, unknown>])[] = [
    ['Get-DistributionGroup', {}],
    ['Get-DistributionGroup', { Identity: GUID }],
    ['Get-DistributionGroup', { ResultSize: 'Unlimited', IncludeManagedByWithDisplayNames: true }],
    [
      'Get-DistributionGroup',
      { Filter: "Alias -like 'sal*'", ResultSize: 100, SortBy: 'DisplayName' },
    ],
    ['Get-DistributionGroupMember', { Identity: GUID, ResultSize: 'Unlimited' }],
    ['Add-DistributionGroupMember', { Identity: GUID, Member: 'jan@example.test' }],
    [
      'Add-DistributionGroupMember',
      { Identity: GUID, Member: GUID, BypassSecurityGroupManagerCheck: true },
    ],
    [
      'Remove-DistributionGroupMember',
      { Identity: GUID, Member: GUID, BypassSecurityGroupManagerCheck: true },
    ],
    ['Get-MailContact', { Identity: GUID }],
    [
      'Get-MailContact',
      { ResultSize: 'Unlimited', SortBy: 'Alias', RecipientTypeDetails: ['MailContact'] },
    ],
    ['Get-MailContact', { ANR: 'jan' }],
    ['New-MailContact', { Name: 'jan-1a2b', ExternalEmailAddress: 'jan@example.test' }],
    [
      'New-MailContact',
      {
        Name: 'jan-1a2b',
        ExternalEmailAddress: 'jan@example.test',
        Alias: 'jan.devries',
        DisplayName: 'Jan de Vries',
        FirstName: 'Jan',
        LastName: 'de Vries',
      },
    ],
    ['Set-MailContact', { Identity: GUID, DisplayName: 'New name' }],
    ['Set-MailContact', { Identity: GUID, HiddenFromAddressListsEnabled: false }],
    ['Remove-MailContact', { Identity: GUID }],
    ['Get-Recipient', { Filter: "EmailAddresses -eq 'SMTP:jan@example.test'", ResultSize: 5 }],
    ['Get-Recipient', { Identity: GUID }],
    ['Get-OrganizationConfig', {}],
  ];

  it.each(passes)('%s %j', (cmdlet, args) => {
    expect(validateCall(cmdlet, args)).toEqual({ ok: true, cmdlet, args });
  });
});

describe('validateCall: what is refused before the worker sees it', () => {
  const label = (value: unknown): string =>
    value === undefined ? 'undefined' : JSON.stringify(value);

  const reason = (cmdlet: unknown, args: unknown): string => {
    const result = validateCall(cmdlet, args);
    return result.ok ? 'accepted' : result.reason;
  };

  it('a cmdlet outside the list, or spelt differently, is unknown_cmdlet', () => {
    for (const cmdlet of [
      'Invoke-Expression',
      'Invoke-Command',
      'Get-Mailbox',
      'Remove-Mailbox',
      'Update-DistributionGroupMember',
      'Set-DistributionGroup',
      'New-DistributionGroup',
      'Get-DistributionGroup;Remove-Mailbox',
      'Get-DistributionGroup | Remove-Mailbox',
      'Get-DistributionGroup\n',
      'get-distributiongroup',
      '& Get-DistributionGroup',
      '__proto__',
      'constructor',
      'toString',
      '',
      null,
      7,
      ['Get-DistributionGroup'],
    ]) {
      expect(reason(cmdlet, {}), JSON.stringify(cmdlet)).toBe('unknown_cmdlet');
    }
  });

  it('an unknown parameter is refused, and the report names the parameter, never the value', () => {
    for (const parameter of [
      'Confirm',
      'WhatIf',
      'Verbose',
      'Debug',
      'ErrorAction',
      'DomainController',
      'ManagedBy',
      'OrganizationalUnit',
      'IgnoreDefaultScope',
      'Credential',
      'identity',
      'Identity ',
      '-Identity',
      'Identity:',
      '__proto__',
      'constructor',
    ]) {
      const args = JSON.parse(
        `{"Identity":"${GUID}",${JSON.stringify(parameter)}:"secret-value-1"}`,
      ) as Record<string, unknown>;
      const result = validateCall('Remove-MailContact', args);
      expect(result.ok, parameter).toBe(false);
      expect(JSON.stringify(result), parameter).not.toContain('secret-value-1');
    }
    expect(reason('Get-OrganizationConfig', { Identity: 'x' })).toBe('invalid_arguments');
  });

  it('a required parameter that is missing is refused (Add and Remove need both Identity and Member)', () => {
    expect(reason('Add-DistributionGroupMember', { Identity: GUID })).toBe('invalid_arguments');
    expect(reason('Remove-DistributionGroupMember', { Member: GUID })).toBe('invalid_arguments');
    expect(reason('New-MailContact', { Name: 'x' })).toBe('invalid_arguments');
    expect(reason('Remove-MailContact', {})).toBe('invalid_arguments');
    expect(reason('Get-DistributionGroupMember', {})).toBe('invalid_arguments');
  });

  it('Set-MailContact needs something to change besides Identity', () => {
    expect(reason('Set-MailContact', { Identity: GUID })).toBe('invalid_arguments');
    expect(reason('Set-MailContact', { Identity: GUID, Alias: 'x' })).toBe('accepted');
  });

  it('an empty, blank, null or non-string identity is refused: a Get- cmdlet would return everything (R-D-09)', () => {
    for (const identity of ['', '   ', '\t', null, undefined, 0, {}, [], false]) {
      expect(reason('Get-MailContact', { Identity: identity }), label(identity)).toBe(
        'invalid_arguments',
      );
      expect(reason('Get-DistributionGroup', { Identity: identity }), label(identity)).toBe(
        'invalid_arguments',
      );
      expect(reason('Remove-MailContact', { Identity: identity }), label(identity)).toBe(
        'invalid_arguments',
      );
    }
  });

  it('text values: no control characters, bounded, patterns for alias and address', () => {
    expect(reason('Get-Recipient', { Identity: 'a\nb' })).toBe('invalid_arguments');
    expect(reason('Get-Recipient', { Identity: 'a\u0000b' })).toBe('invalid_arguments');
    expect(reason('Get-Recipient', { Identity: 'x'.repeat(257) })).toBe('invalid_arguments');
    expect(reason('Get-Recipient', { Filter: 'x'.repeat(1025) })).toBe('invalid_arguments');
    expect(
      reason('New-MailContact', { Name: 'x'.repeat(65), ExternalEmailAddress: 'a@b.co' }),
    ).toBe('invalid_arguments');
    expect(
      reason('New-MailContact', {
        Name: 'x',
        ExternalEmailAddress: 'a@b.co',
        DisplayName: 'x'.repeat(257),
      }),
    ).toBe('invalid_arguments');
    expect(
      reason('New-MailContact', { Name: 'x', ExternalEmailAddress: 'a@b.co', Alias: 'a b' }),
    ).toBe('invalid_arguments');
    expect(
      reason('New-MailContact', {
        Name: 'x',
        ExternalEmailAddress: 'a@b.co',
        Alias: 'a'.repeat(65),
      }),
    ).toBe('invalid_arguments');
    expect(reason('New-MailContact', { Name: 'x', ExternalEmailAddress: 'Jan <a@b.co>' })).toBe(
      'invalid_arguments',
    );
    expect(
      reason('New-MailContact', { Name: 'x', ExternalEmailAddress: 'a@b.co; Remove-Mailbox' }),
    ).toBe('invalid_arguments');
  });

  it('switches take true only; booleans take booleans; ResultSize is Unlimited or a positive whole number', () => {
    expect(
      reason('Add-DistributionGroupMember', {
        Identity: GUID,
        Member: GUID,
        BypassSecurityGroupManagerCheck: false,
      }),
    ).toBe('invalid_arguments');
    expect(
      reason('Add-DistributionGroupMember', {
        Identity: GUID,
        Member: GUID,
        BypassSecurityGroupManagerCheck: 'true',
      }),
    ).toBe('invalid_arguments');
    expect(
      reason('Set-MailContact', { Identity: GUID, HiddenFromAddressListsEnabled: 'false' }),
    ).toBe('invalid_arguments');
    for (const size of [0, -1, 1.5, '10', 'unlimited', 'Unlimited ', null, 10_000_001]) {
      expect(reason('Get-Recipient', { ResultSize: size }), String(size)).toBe('invalid_arguments');
    }
  });

  it('enums are closed: SortBy and RecipientTypeDetails of Get-MailContact (R-D-09)', () => {
    expect(reason('Get-MailContact', { SortBy: 'Name' })).toBe('accepted');
    expect(reason('Get-MailContact', { SortBy: 'Whatever' })).toBe('invalid_arguments');
    expect(reason('Get-MailContact', { RecipientTypeDetails: ['MailUser'] })).toBe(
      'invalid_arguments',
    );
    expect(reason('Get-MailContact', { RecipientTypeDetails: [] })).toBe('invalid_arguments');
    expect(
      reason('Get-MailContact', { RecipientTypeDetails: ['MailContact', 'MailContact'] }),
    ).toBe('invalid_arguments');
    expect(reason('Get-MailContact', { RecipientTypeDetails: 'MailContact' })).toBe(
      'invalid_arguments',
    );
  });

  it('arguments must be a plain object: arrays, null, strings and numbers are refused', () => {
    for (const args of [null, undefined, [], 'Identity', 7, true]) {
      expect(reason('Get-OrganizationConfig', args), String(args)).toBe('invalid_arguments');
    }
  });

  it('the allow-list bypass attempts all fail, and a permissive validator fails the guard (negative fixture)', () => {
    const attempts: readonly (readonly [unknown, unknown])[] = [
      ['Invoke-Expression', { Command: 'Get-Date' }],
      ['Get-DistributionGroup;Remove-Mailbox', {}],
      ['Remove-MailContact', { Identity: GUID, Confirm: false }],
      ['Get-MailContact', { Identity: '' }],
      ['__proto__', {}],
    ];
    const guard = (validate: (cmdlet: unknown, args: unknown) => boolean): void => {
      for (const [cmdlet, args] of attempts) {
        if (validate(cmdlet, args)) throw new Error('allow-list bypass accepted');
      }
    };
    expect(() => {
      guard((cmdlet, args) => validateCall(cmdlet, args).ok);
    }).not.toThrow();
    // A validator that only looks at the verb lets every attempt through.
    expectGuardFails(
      guard,
      (cmdlet: unknown) => typeof cmdlet === 'string' && /^(Get|Remove|Invoke)-/.test(cmdlet),
      { reason: 'allow-list bypass accepted' },
    );
  });
});

describe('cmdletArgsSchema', () => {
  it('is a strict schema per cmdlet and is cached', () => {
    expect(cmdletArgsSchema('Get-Recipient')).toBe(cmdletArgsSchema('Get-Recipient'));
    expect(cmdletArgsSchema('Get-Recipient').safeParse({ Nope: 1 }).success).toBe(false);
  });
});

describe('the manifest (single source for the script generator, PD-02)', () => {
  it('is deterministic canonical JSON of the whole table, with the text patterns', () => {
    const text = allowListManifest();
    expect(allowListManifest()).toBe(text);
    const parsed = JSON.parse(text) as {
      version: number;
      patterns: Record<string, string>;
      cmdlets: Record<string, unknown>;
    };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.cmdlets)).toEqual([...EXCHANGE_CMDLETS]);
    expect(parsed.patterns).toEqual({ ...TEXT_PATTERNS });
    expect(text).not.toContain('\n');
  });

  it('changes when the table changes, so a script generated from another table is detected', () => {
    const changed = structuredClone(ALLOW_LIST) as unknown as Record<
      string,
      { params: Record<string, { maxChars?: number }> }
    >;
    const params = changed['New-MailContact']?.params;
    if (params?.Name === undefined) throw new Error('fixture');
    params.Name.maxChars = 65;
    expect(allowListManifest(changed as never)).not.toBe(allowListManifest());
  });

  it('keeps every pattern source portable to .NET (no flags, no named groups, no \\p classes)', () => {
    for (const [name, source] of Object.entries(TEXT_PATTERNS)) {
      expect(() => new RegExp(source), name).not.toThrow();
      expect(source, name).not.toMatch(/\\p\{|\(\?<|\\k</);
    }
  });
});
