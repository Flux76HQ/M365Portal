// T-B-121, FR-B-303 (body), FR-B-218 (checklist source), FR-B-306 to FR-B-308 (bodies), CB13: the
// desired state of the tenant, described once. The golden document is the one of plan 9.5; the
// invariant guard (`assertDesiredStateInvariants`) lists what must never be in it and has negative
// fixtures, because a guard nobody has seen fail is an assumption (tasks.md section 0.3).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RedirectUriError } from '../src/auth/redirect-uri.js';
import {
  APPLICATION_NAME_MIN_CHARS,
  DesiredStateError,
  buildDesiredState,
  buildGrantBody,
  buildKeyCredentialEntry,
  buildRoleAssignmentBody,
  desiredStateChecklist,
  type DesiredState,
  type DesiredStateInput,
} from '../src/setup/desired-state.js';
import {
  EXCHANGE_RESOURCE_APP_ID,
  EXCHANGE_ROLES,
  FORBIDDEN_APP_ROLES,
  GRAPH_APP_ROLES,
  GRAPH_RESOURCE_APP_ID,
} from '../src/setup/graph-roles.js';
import { expectGuardFails } from '../src/testing/index.js';

const PLAN = readFileSync(new URL('../../../specs/002-phase-b/plan.md', import.meta.url), 'utf8');

const INSTALL_ID = '0123456789abcdef0123456789abcdef';
const ID = {
  'User.Read.All': 'a0000000-0000-4000-8000-000000000001',
  'GroupMember.Read.All': 'a0000000-0000-4000-8000-000000000002',
  'GroupMember.ReadWrite.All': 'a0000000-0000-4000-8000-000000000003',
  'Organization.Read.All': 'a0000000-0000-4000-8000-000000000004',
  'Exchange.ManageAsApp': 'b0000000-0000-4000-8000-000000000001',
  'Exchange.ManageAsAppV2': 'b0000000-0000-4000-8000-000000000002',
} as const;
const FORBIDDEN_IDS = {
  'RoleManagement.ReadWrite.Directory': 'c0000000-0000-4000-8000-000000000001',
  'AppRoleAssignment.ReadWrite.All': 'c0000000-0000-4000-8000-000000000002',
  'Application.ReadWrite.All': 'c0000000-0000-4000-8000-000000000003',
} as const;

function input(overrides: Partial<DesiredStateInput> = {}): DesiredStateInput {
  return {
    baseUrl: 'https://panel.example.test',
    installId: INSTALL_ID,
    applicationName: 'M365Portal',
    roleIds: { ...ID },
    exchange: true,
    ...overrides,
  };
}

const GOLDEN: DesiredState = {
  displayName: 'M365Portal',
  description: 'Created by the M365Portal setup wizard (install 01234567)',
  signInAudience: 'AzureADMyOrg',
  tags: ['m365portal', `m365portal-install-${INSTALL_ID}`],
  web: {
    redirectUris: [
      'https://panel.example.test/auth/callback',
      'https://panel.example.test/auth/logged-out',
    ],
    implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
  },
  isFallbackPublicClient: false,
  requiredResourceAccess: [
    {
      resourceAppId: '00000003-0000-0000-c000-000000000000',
      resourceAccess: [
        { id: ID['User.Read.All'], type: 'Role' },
        { id: ID['GroupMember.Read.All'], type: 'Role' },
        { id: ID['GroupMember.ReadWrite.All'], type: 'Role' },
        { id: ID['Organization.Read.All'], type: 'Role' },
      ],
    },
    {
      resourceAppId: '00000002-0000-0ff1-ce00-000000000000',
      resourceAccess: [
        { id: ID['Exchange.ManageAsApp'], type: 'Role' },
        { id: ID['Exchange.ManageAsAppV2'], type: 'Role' },
      ],
    },
  ],
  optionalClaims: {
    idToken: [
      { name: 'amr', essential: false },
      { name: 'auth_time', essential: false },
    ],
  },
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A member of an unknown JSON value, or `undefined` when it is not there. */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** Set a member of a JSON document in place (the mutations of the negative fixtures). */
function setAt(doc: Json, path: (string | number)[], value: Json): void {
  let current: Json = doc;
  for (const key of path.slice(0, -1)) {
    if (typeof current !== 'object' || current === null) throw new Error('bad path');
    current = (current as Record<string | number, Json>)[key] as Json;
  }
  (current as Record<string | number, Json>)[path[path.length - 1]!] = value;
}

/**
 * The invariants of FR-B-303 and FR-B-301, as a guard that throws: nothing that must never be in
 * the application document. Run on the real document and on mutated copies.
 */
function assertDesiredStateInvariants(doc: unknown): void {
  const text = JSON.stringify(doc);
  const fail = (what: string): never => {
    throw new Error(`desired state invariant: ${what}`);
  };
  if (at(doc, 'signInAudience') !== 'AzureADMyOrg') fail('audience must be AzureADMyOrg');
  if (at(doc, 'web', 'implicitGrantSettings', 'enableIdTokenIssuance') !== false) {
    fail('implicit id token flow on');
  }
  if (at(doc, 'web', 'implicitGrantSettings', 'enableAccessTokenIssuance') !== false) {
    fail('implicit access token flow on');
  }
  if (at(doc, 'isFallbackPublicClient') !== false) fail('public client flow on');
  for (const member of [
    'groupMembershipClaims',
    'identifierUris',
    'passwordCredentials',
    'keyCredentials',
  ]) {
    if (at(doc, member) !== undefined) fail(`${member} present`);
  }
  if (at(doc, 'web', 'logoutUrl') !== undefined) fail('web.logoutUrl present');
  if (/secret/i.test(text)) fail('a client secret');
  const uris = at(doc, 'web', 'redirectUris');
  for (const uri of Array.isArray(uris) ? (uris as unknown[]) : []) {
    if (typeof uri !== 'string' || uri.includes('*')) fail('wildcard redirect URI');
    else if (!/\/auth\/(?:callback|logged-out)$/.test(uri)) fail('unexpected redirect URI');
  }
  const forbiddenIds: readonly string[] = Object.values(FORBIDDEN_IDS);
  const resources = at(doc, 'requiredResourceAccess');
  for (const resource of Array.isArray(resources) ? (resources as unknown[]) : []) {
    const access = at(resource, 'resourceAccess');
    for (const entry of Array.isArray(access) ? (access as unknown[]) : []) {
      if (at(entry, 'type') !== 'Role') fail('a permission that is not an application role');
      const id = at(entry, 'id');
      if (typeof id === 'string' && forbiddenIds.includes(id)) fail('a forbidden role');
    }
  }
  for (const name of FORBIDDEN_APP_ROLES) {
    if (text.includes(name)) fail(`a forbidden role name ${name}`);
  }
}

function throwsDesired(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DesiredStateError);
    return (error as DesiredStateError).reason;
  }
  throw new Error('did not throw');
}

describe('buildDesiredState', () => {
  it('equals the golden document of plan 9.5', () => {
    expect(buildDesiredState(input())).toEqual(GOLDEN);
  });

  it('agrees with the plan text on the resource ids, the audience and the tags', () => {
    expect(PLAN).toContain(GRAPH_RESOURCE_APP_ID);
    expect(PLAN).toContain(EXCHANGE_RESOURCE_APP_ID);
    expect(PLAN).toContain('"signInAudience": "AzureADMyOrg"');
    expect(PLAN).toContain('"tags": ["m365portal", "m365portal-install-<installId>"]');
    expect(PLAN).toContain(
      '{ "name": "amr", "essential": false }, { "name": "auth_time", "essential": false }',
    );
    expect(GOLDEN.requiredResourceAccess.map((r) => r.resourceAppId)).toEqual([
      GRAPH_RESOURCE_APP_ID,
      EXCHANGE_RESOURCE_APP_ID,
    ]);
  });

  it('lists the four Graph roles in the order of GRAPH_APP_ROLES, all as type Role', () => {
    const doc = buildDesiredState(input());
    const graph = doc.requiredResourceAccess[0]!;
    expect(graph.resourceAccess.map((a) => a.id)).toEqual(GRAPH_APP_ROLES.map((name) => ID[name]));
    for (const resource of doc.requiredResourceAccess) {
      for (const access of resource.resourceAccess) expect(access.type).toBe('Role');
    }
  });

  it('omits ManageAsAppV2 when the tenant does not expose it', () => {
    const without: Record<string, string> = { ...ID };
    delete without['Exchange.ManageAsAppV2'];
    const doc = buildDesiredState(input({ roleIds: without }));
    expect(doc.requiredResourceAccess[1]!.resourceAccess).toEqual([
      { id: ID['Exchange.ManageAsApp'], type: 'Role' },
    ]);
  });

  it('omits the whole Exchange block without an Exchange service principal', () => {
    const doc = buildDesiredState(input({ exchange: false }));
    expect(doc.requiredResourceAccess).toHaveLength(1);
    expect(doc.requiredResourceAccess[0]!.resourceAppId).toBe(GRAPH_RESOURCE_APP_ID);
    const bare = buildDesiredState(
      input({
        exchange: false,
        roleIds: Object.fromEntries(GRAPH_APP_ROLES.map((name) => [name, ID[name]])),
      }),
    );
    expect(bare).toEqual(doc);
  });

  it('never carries a forbidden role, even when the id map offers one', () => {
    const doc = buildDesiredState(input({ roleIds: { ...ID, ...FORBIDDEN_IDS } }));
    assertDesiredStateInvariants(doc);
    expect(JSON.stringify(doc)).not.toContain(FORBIDDEN_IDS['Application.ReadWrite.All']);
  });

  it('passes the invariant guard for https, localhost and every exchange variant', () => {
    for (const baseUrl of [
      'https://panel.example.test',
      'http://localhost:9300',
      'https://a.example.test:8443',
    ]) {
      for (const exchange of [true, false]) {
        assertDesiredStateInvariants(buildDesiredState(input({ baseUrl, exchange })));
      }
    }
  });

  it('registers the localhost URIs without a port (research 2.2) and keeps an https port', () => {
    expect(buildDesiredState(input({ baseUrl: 'http://localhost:9300' })).web.redirectUris).toEqual(
      ['http://localhost/auth/callback', 'http://localhost/auth/logged-out'],
    );
    expect(
      buildDesiredState(input({ baseUrl: 'https://a.example.test:8443' })).web.redirectUris,
    ).toEqual([
      'https://a.example.test:8443/auth/callback',
      'https://a.example.test:8443/auth/logged-out',
    ]);
  });

  it('refuses a base URL that cannot be registered', () => {
    for (const baseUrl of ['http://127.0.0.1:9300', 'https://*.example.test', 'ftp://x', '']) {
      expect(() => buildDesiredState(input({ baseUrl })), baseUrl).toThrow(RedirectUriError);
    }
  });

  it('takes a name of 3 to 64 characters in NFC through the organisation-name normaliser', () => {
    expect(APPLICATION_NAME_MIN_CHARS).toBe(3);
    expect(buildDesiredState(input({ applicationName: 'abc' })).displayName).toBe('abc');
    expect(buildDesiredState(input({ applicationName: 'a'.repeat(64) })).displayName).toHaveLength(
      64,
    );
    expect(buildDesiredState(input({ applicationName: 'Café Panel' })).displayName).toBe(
      'Café Panel',
    );
    for (const applicationName of [
      'ab',
      '',
      'a'.repeat(65),
      'Café Panel',
      ' padded',
      'trailing ',
      'tab\tname',
      'new\nline',
      'bidi‮name',
      'zero​width',
      'two  spaces',
    ]) {
      expect(
        throwsDesired(() => buildDesiredState(input({ applicationName }))),
        JSON.stringify(applicationName),
      ).toBe('application_name_invalid');
    }
    expect(
      throwsDesired(() => buildDesiredState(input({ applicationName: 42 as unknown as string }))),
    ).toBe('application_name_invalid');
  });

  it('requires a 128-bit install id in lower-case hexadecimal', () => {
    for (const installId of [
      '',
      INSTALL_ID.toUpperCase(),
      INSTALL_ID.slice(1),
      `${INSTALL_ID}0`,
      'g'.repeat(32),
    ]) {
      expect(throwsDesired(() => buildDesiredState(input({ installId })))).toBe(
        'install_id_invalid',
      );
    }
  });

  it('refuses a missing or malformed role id and says which kind of fault it is', () => {
    const missing: Record<string, string> = { ...ID };
    delete missing['GroupMember.Read.All'];
    expect(throwsDesired(() => buildDesiredState(input({ roleIds: missing })))).toBe(
      'role_id_missing',
    );
    expect(
      throwsDesired(() =>
        buildDesiredState(input({ roleIds: { ...ID, 'User.Read.All': 'not-a-guid' } })),
      ),
    ).toBe('role_id_invalid');
    expect(
      throwsDesired(() =>
        buildDesiredState(
          input({ roleIds: { ...ID, 'User.Read.All': ID['User.Read.All'].toUpperCase() } }),
        ),
      ),
    ).toBe('role_id_invalid');
    const noExchange: Record<string, string> = { ...ID };
    delete noExchange['Exchange.ManageAsApp'];
    expect(throwsDesired(() => buildDesiredState(input({ roleIds: noExchange })))).toBe(
      'role_id_missing',
    );
    expect(
      throwsDesired(() =>
        buildDesiredState(input({ roleIds: { ...ID, 'Exchange.ManageAsAppV2': 'nope' } })),
      ),
    ).toBe('role_id_invalid');
  });

  it('does not read inherited names from the id map', () => {
    const polluted = Object.create({ 'User.Read.All': ID['User.Read.All'] }) as Record<
      string,
      string
    >;
    Object.assign(polluted, { ...ID });
    delete polluted['User.Read.All'];
    expect(throwsDesired(() => buildDesiredState(input({ roleIds: polluted })))).toBe(
      'role_id_missing',
    );
  });

  it('is deterministic and deeply frozen', () => {
    const a = buildDesiredState(input());
    const b = buildDesiredState(input());
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.web.redirectUris)).toBe(true);
    expect(Object.isFrozen(a.requiredResourceAccess[0]!.resourceAccess[0])).toBe(true);
    expect(() => {
      (a as { displayName: string }).displayName = 'x';
    }).toThrow(TypeError);
  });

  it('error messages never echo the value', () => {
    try {
      buildDesiredState(input({ applicationName: 'x'.repeat(200) }));
    } catch (error) {
      expect((error as Error).message).not.toContain('xxxx');
    }
  });
});

describe('the invariant guard has negative fixtures', () => {
  const good = (): Json => JSON.parse(JSON.stringify(buildDesiredState(input()))) as Json;
  const first = ['requiredResourceAccess', 0, 'resourceAccess', 0];
  const mutations: [string, (string | number)[], Json, string][] = [
    [
      'a personal-account audience',
      ['signInAudience'],
      'AzureADandPersonalMicrosoftAccount',
      'audience',
    ],
    [
      'an implicit id token flow',
      ['web', 'implicitGrantSettings', 'enableIdTokenIssuance'],
      true,
      'implicit id token',
    ],
    [
      'an implicit access token flow',
      ['web', 'implicitGrantSettings', 'enableAccessTokenIssuance'],
      true,
      'implicit access',
    ],
    ['public client flows', ['isFallbackPublicClient'], true, 'public client'],
    [
      'a wildcard URI',
      ['web', 'redirectUris', 0],
      'https://*.example.test/auth/callback',
      'wildcard',
    ],
    ['a logout URL', ['web', 'logoutUrl'], 'https://panel.example.test/auth/logout', 'logoutUrl'],
    ['group membership claims', ['groupMembershipClaims'], 'All', 'groupMembershipClaims'],
    ['identifier URIs', ['identifierUris'], ['api://x'], 'identifierUris'],
    ['a client secret', ['passwordCredentials'], [{ displayName: 'x' }], 'passwordCredentials'],
    ['a secret word anywhere', ['description'], 'client secret inside', 'secret'],
    ['a delegated scope instead of a role', [...first, 'type'], 'Scope', 'not an application role'],
    [
      'a forbidden role id',
      [...first, 'id'],
      FORBIDDEN_IDS['Application.ReadWrite.All'],
      'forbidden role',
    ],
    [
      'a forbidden role name',
      ['description'],
      'RoleManagement.ReadWrite.Directory',
      'forbidden role name',
    ],
  ];

  it('passes on the real document', () => {
    assertDesiredStateInvariants(good());
  });

  it.each(mutations)('fails on %s', (_name, path, value, reason) => {
    const doc = good();
    setAt(doc, path, value);
    expectGuardFails(assertDesiredStateInvariants, doc, { reason });
  });
});

describe('desiredStateChecklist (FR-B-218)', () => {
  const doc = buildDesiredState(input());
  const checklist = desiredStateChecklist(doc, ID);

  it('lists a field for every member of the desired document, with the same values', () => {
    const byPath = Object.fromEntries(checklist.map((item) => [item.path, item.value]));
    expect(byPath.displayName).toBe(doc.displayName);
    expect(byPath.description).toBe(doc.description);
    expect(byPath.signInAudience).toBe('AzureADMyOrg');
    expect(byPath.tags).toEqual(doc.tags);
    expect(byPath['web.redirectUris']).toEqual(doc.web.redirectUris);
    expect(byPath['web.implicitGrantSettings.enableIdTokenIssuance']).toBe(false);
    expect(byPath['web.implicitGrantSettings.enableAccessTokenIssuance']).toBe(false);
    expect(byPath.isFallbackPublicClient).toBe(false);
    expect(byPath['optionalClaims.idToken']).toEqual(['amr', 'auth_time']);
    expect(byPath[`requiredResourceAccess[${GRAPH_RESOURCE_APP_ID}]`]).toEqual([
      ...GRAPH_APP_ROLES,
    ]);
    expect(byPath[`requiredResourceAccess[${EXCHANGE_RESOURCE_APP_ID}]`]).toEqual([
      'Exchange.ManageAsApp',
      'Exchange.ManageAsAppV2',
    ]);
    expect(checklist).toHaveLength(11);
  });

  it('covers every top-level member of the document (a new member fails until it is listed)', () => {
    const covered = new Set(checklist.map((item) => item.path.split(/[.[]/)[0]));
    expect([...covered].sort()).toEqual(Object.keys(doc).sort());
  });

  it('has unique keys, drops the Exchange line without Exchange, and names roles, not ids', () => {
    expect(new Set(checklist.map((item) => item.key)).size).toBe(checklist.length);
    const bare = desiredStateChecklist(buildDesiredState(input({ exchange: false })), ID);
    expect(bare.some((item) => item.key === 'exchange_roles')).toBe(false);
    expect(JSON.stringify(checklist)).not.toContain(ID['User.Read.All']);
  });

  it('fails loudly for a role id the map does not know', () => {
    expect(throwsDesired(() => desiredStateChecklist(doc, {}))).toBe('role_id_missing');
  });

  it('negative: a checklist missing a field fails the coverage rule', () => {
    const shortList = checklist.filter((item) => item.key !== 'optional_claims');
    expectGuardFails(
      () => {
        const covered = new Set(shortList.map((item) => item.path.split(/[.[]/)[0]));
        expect([...covered].sort()).toEqual(Object.keys(doc).sort());
      },
      undefined,
      { name: 'checklist without optional claims' },
    );
  });
});

describe('request bodies of the call sheet', () => {
  const SP = 'd0000000-0000-4000-8000-000000000001';
  const GRAPH_SP = 'd0000000-0000-4000-8000-000000000002';

  it('builds the grant body of FR-B-307', () => {
    expect(
      buildGrantBody({ principalId: SP, resourceId: GRAPH_SP, appRoleId: ID['User.Read.All'] }),
    ).toEqual({
      principalId: SP,
      resourceId: GRAPH_SP,
      appRoleId: ID['User.Read.All'],
    });
    for (const bad of ['', 'x', SP.toUpperCase(), `{${SP}}`, `${SP}0`]) {
      expect(
        throwsDesired(() =>
          buildGrantBody({ principalId: bad, resourceId: GRAPH_SP, appRoleId: SP }),
        ),
      ).toBe('guid_invalid');
    }
  });

  it('builds the role-assignment body of plan 9.5 from a key of EXCHANGE_ROLES only', () => {
    expect(
      buildRoleAssignmentBody({ exchangeRole: 'exchange_administrator', principalId: SP }),
    ).toEqual({
      '@odata.type': '#microsoft.graph.unifiedRoleAssignment',
      roleDefinitionId: '29232cdf-9323-42fd-ade2-1d097af3e4de',
      principalId: SP,
      directoryScopeId: '/',
    });
    expect(
      buildRoleAssignmentBody({ exchangeRole: 'exchange_recipient_administrator', principalId: SP })
        .roleDefinitionId,
    ).toBe(EXCHANGE_ROLES.exchange_recipient_administrator.templateId);
  });

  it('refuses a GUID, a privileged template id or an inherited name as the role (FR-B-308)', () => {
    const globalAdministrator = '62e90394-69f5-4237-9190-012177145e10';
    for (const exchangeRole of [
      globalAdministrator,
      EXCHANGE_ROLES.exchange_administrator.templateId,
      'toString',
      '',
      undefined,
    ]) {
      expectGuardFails(
        () => buildRoleAssignmentBody({ exchangeRole: exchangeRole as never, principalId: SP }),
        undefined,
        { name: `role ${String(exchangeRole)}`, reason: 'exchange_role' },
      );
    }
  });

  describe('buildKeyCredentialEntry', () => {
    const notBefore = new Date('2026-10-11T10:00:00.000Z');
    const notAfter = new Date(notBefore.getTime() + 360 * 86_400_000);
    const entry = (over: Partial<Parameters<typeof buildKeyCredentialEntry>[0]> = {}) =>
      buildKeyCredentialEntry({
        certificateBase64: 'AQIDBA==',
        thumbprintSha1: 'AABBCCDDEEFF00112233445566778899AABBCCDD',
        notBefore,
        notAfter,
        ...over,
      });

    it('has the shape of plan 9.5 and no customKeyIdentifier', () => {
      expect(entry()).toEqual({
        type: 'AsymmetricX509Cert',
        usage: 'Verify',
        key: 'AQIDBA==',
        displayName: 'M365Portal aabbccdd',
        startDateTime: '2026-10-11T10:00:00.000Z',
        endDateTime: '2027-10-06T10:00:00.000Z',
      });
      expect('customKeyIdentifier' in entry()).toBe(false);
      expect(Object.keys(entry()).sort()).toEqual([
        'displayName',
        'endDateTime',
        'key',
        'startDateTime',
        'type',
        'usage',
      ]);
    });

    it('refuses more than 360 days, an inverted range and malformed input', () => {
      expect(
        throwsDesired(() => entry({ notAfter: new Date(notBefore.getTime() + 361 * 86_400_000) })),
      ).toBe('validity_invalid');
      expect(
        throwsDesired(() =>
          entry({ notAfter: new Date(notBefore.getTime() + 360 * 86_400_000 + 1) }),
        ),
      ).toBe('validity_invalid');
      expect(throwsDesired(() => entry({ notAfter: notBefore }))).toBe('validity_invalid');
      expect(throwsDesired(() => entry({ notAfter: new Date(Number.NaN) }))).toBe(
        'validity_invalid',
      );
      expect(throwsDesired(() => entry({ certificateBase64: '' }))).toBe('certificate_invalid');
      expect(throwsDesired(() => entry({ certificateBase64: 'not base64!' }))).toBe(
        'certificate_invalid',
      );
      expect(throwsDesired(() => entry({ thumbprintSha1: 'abc' }))).toBe('certificate_invalid');
    });

    it('negative: a builder that adds customKeyIdentifier fails the shape rule', () => {
      const shape = (value: object): void => {
        if ('customKeyIdentifier' in value) throw new Error('customKeyIdentifier must not be sent');
      };
      shape(entry());
      expectGuardFails(
        shape,
        { ...entry(), customKeyIdentifier: 'AABB' },
        { reason: 'customKeyIdentifier' },
      );
    });
  });
});
