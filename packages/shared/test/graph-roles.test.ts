// T-B-067, FR-B-301, FR-B-302, FR-B-308, FR-B-214: the runtime application's permission set, the
// roles it must never hold, the three delegated bootstrap scopes and the two Exchange roles are
// constants in one module. The values below are written out a second time on purpose: the test is
// the independent statement of the spec, `single-implementation.test.ts` finds a second copy in code.
//
// Microsoft sources of the values (research-microsoft-b.md sections 3 to 5):
//   https://learn.microsoft.com/en-us/graph/permissions-reference
//   https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference
//   https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BOOTSTRAP_SCOPES,
  EXCHANGE_APP_ROLES,
  EXCHANGE_RESOURCE_APP_ID,
  EXCHANGE_ROLES,
  FORBIDDEN_APP_ROLES,
  GRAPH_APP_ROLES,
  GRAPH_RESOURCE_APP_ID,
  PERMISSION_SET_VERSION,
  assertDisjointFromForbidden,
  exchangeRoleTemplateId,
  isExchangeRoleKey,
} from '../src/setup/graph-roles.js';
import { expectGuardFails } from '../src/testing/index.js';

describe('GRAPH_APP_ROLES (FR-B-301)', () => {
  it('is exactly the four application permissions of version 1', () => {
    expect([...GRAPH_APP_ROLES]).toEqual([
      'User.Read.All',
      'GroupMember.Read.All',
      'GroupMember.ReadWrite.All',
      'Organization.Read.All',
    ]);
    expect(PERMISSION_SET_VERSION).toBe(1);
  });

  it('is immutable at run time and in the type', () => {
    expect(Object.isFrozen(GRAPH_APP_ROLES)).toBe(true);
    expectTypeOf(GRAPH_APP_ROLES).toEqualTypeOf<
      readonly [
        'User.Read.All',
        'GroupMember.Read.All',
        'GroupMember.ReadWrite.All',
        'Organization.Read.All',
      ]
    >();
    expect(() => {
      (GRAPH_APP_ROLES as unknown as string[]).push('Directory.Read.All');
    }).toThrow(TypeError);
  });

  it('names the Exchange roles: ManageAsApp required, ManageAsAppV2 only when exposed', () => {
    expect(EXCHANGE_APP_ROLES).toEqual({
      required: 'Exchange.ManageAsApp',
      whenExposed: 'Exchange.ManageAsAppV2',
    });
    expect(Object.isFrozen(EXCHANGE_APP_ROLES)).toBe(true);
  });

  it('names the resource applications by their well-known ids', () => {
    expect(GRAPH_RESOURCE_APP_ID).toBe('00000003-0000-0000-c000-000000000000');
    expect(EXCHANGE_RESOURCE_APP_ID).toBe('00000002-0000-0ff1-ce00-000000000000');
  });
});

describe('FORBIDDEN_APP_ROLES (FR-B-301)', () => {
  it('is exactly the three roles the runtime application never holds', () => {
    expect([...FORBIDDEN_APP_ROLES]).toEqual([
      'RoleManagement.ReadWrite.Directory',
      'AppRoleAssignment.ReadWrite.All',
      'Application.ReadWrite.All',
    ]);
    expect(Object.isFrozen(FORBIDDEN_APP_ROLES)).toBe(true);
  });

  it('shares no member with the allowed set, Exchange roles included', () => {
    const allowed = new Set<string>([
      ...GRAPH_APP_ROLES,
      EXCHANGE_APP_ROLES.required,
      EXCHANGE_APP_ROLES.whenExposed,
    ]);
    for (const forbidden of FORBIDDEN_APP_ROLES) expect(allowed.has(forbidden)).toBe(false);
    expect(() => {
      assertDisjointFromForbidden([...allowed]);
    }).not.toThrow();
  });

  it('fails the guard for a set that holds a forbidden role (negative)', () => {
    expectGuardFails(
      assertDisjointFromForbidden,
      [...GRAPH_APP_ROLES, 'Application.ReadWrite.All'],
      {
        reason: 'Application.ReadWrite.All',
      },
    );
    expectGuardFails(assertDisjointFromForbidden, ['RoleManagement.ReadWrite.Directory'], {
      reason: 'RoleManagement.ReadWrite.Directory',
    });
  });
});

describe('BOOTSTRAP_SCOPES (FR-B-214)', () => {
  it('is exactly the three delegated Graph scopes, spelled out in full', () => {
    expect([...BOOTSTRAP_SCOPES]).toEqual([
      'https://graph.microsoft.com/Application.ReadWrite.All',
      'https://graph.microsoft.com/AppRoleAssignment.ReadWrite.All',
      'https://graph.microsoft.com/RoleManagement.ReadWrite.Directory',
    ]);
    expect(Object.isFrozen(BOOTSTRAP_SCOPES)).toBe(true);
  });

  it('holds no OpenID Connect scope: MSAL adds them and explicit ones fail (research 5.3)', () => {
    for (const scope of BOOTSTRAP_SCOPES) {
      expect(['openid', 'profile', 'email', 'offline_access']).not.toContain(scope);
      expect(scope.startsWith(`https://graph.microsoft.com/`)).toBe(true);
    }
  });

  it('is the delegated form of the forbidden runtime roles, and nothing the runtime holds', () => {
    const names = BOOTSTRAP_SCOPES.map((scope) =>
      scope.slice('https://graph.microsoft.com/'.length),
    );
    expect(names.sort()).toEqual([...FORBIDDEN_APP_ROLES].sort());
  });
});

describe('EXCHANGE_ROLES (FR-B-308)', () => {
  it('has exactly the two keys and the template ids of Learn', () => {
    expect(Object.keys(EXCHANGE_ROLES)).toEqual([
      'exchange_administrator',
      'exchange_recipient_administrator',
    ]);
    expect(EXCHANGE_ROLES.exchange_administrator.templateId).toBe(
      '29232cdf-9323-42fd-ade2-1d097af3e4de',
    );
    expect(EXCHANGE_ROLES.exchange_recipient_administrator.templateId).toBe(
      '31392ffb-586c-42d1-9346-e59415a2cc4e',
    );
    expect(Object.isFrozen(EXCHANGE_ROLES)).toBe(true);
    expect(Object.isFrozen(EXCHANGE_ROLES.exchange_administrator)).toBe(true);
  });

  it('resolves a key to its template id', () => {
    expect(exchangeRoleTemplateId('exchange_administrator')).toBe(
      '29232cdf-9323-42fd-ade2-1d097af3e4de',
    );
    expect(exchangeRoleTemplateId('exchange_recipient_administrator')).toBe(
      '31392ffb-586c-42d1-9346-e59415a2cc4e',
    );
    expect(isExchangeRoleKey('exchange_administrator')).toBe(true);
  });

  it.each([
    ['a Global Administrator template id', '62e90394-69f5-4237-9190-012177145e10'],
    ['an Exchange template id used as a key', '29232cdf-9323-42fd-ade2-1d097af3e4de'],
    ['an unknown key', 'global_administrator'],
    ['an inherited property name', 'constructor'],
    ['the prototype key', '__proto__'],
    ['an empty string', ''],
    ['a key in another case', 'Exchange_Administrator'],
    ['a key with padding', ' exchange_administrator'],
    ['a number', 7],
    ['null', null],
    ['an array holding a key', ['exchange_administrator']],
  ])('refuses %s', (_name, value) => {
    expect(isExchangeRoleKey(value)).toBe(false);
    expectGuardFails(exchangeRoleTemplateId, value, { reason: 'exchange_role' });
  });

  it('is closed: a third entry fails the guard (negative)', () => {
    const guard = (roles: Readonly<Record<string, unknown>>): void => {
      const keys = Object.keys(roles);
      if (keys.length !== 2) throw new Error(`EXCHANGE_ROLES has ${String(keys.length)} entries`);
    };
    expect(() => {
      guard(EXCHANGE_ROLES);
    }).not.toThrow();
    expectGuardFails(
      guard,
      {
        ...EXCHANGE_ROLES,
        global_administrator: { templateId: '62e90394-69f5-4237-9190-012177145e10' },
      },
      { reason: '3 entries' },
    );
  });
});
