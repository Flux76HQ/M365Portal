// T-C-004, FR-C-201, FR-C-204 to FR-C-207, FR-C-301, FR-C-304 to FR-C-307: the wire schemas of the
// read-only users and groups routes P33 to P39 (the contract frozen at gate GC0). Each schema is
// checked with the values it must accept and, as important, the values it must refuse. Rules of the
// folder: Zod only, no transform, `.meta({ id })` with the constant name minus `Schema`, request
// schemas strict, responses strict too.
//
// Guards with a negative fixture (expectGuardFails): the restricted row (no id, name or address), the
// absence of licence data (decision D-C3) and the absence of a total (a count would leak the size of
// a scope, FR-C-201).
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GROUP_KINDS } from '../src/directory/group-kind.js';
import { LIMITS } from '../src/limits.js';
import * as assets from '../src/schemas/assets.js';
import * as auth from '../src/schemas/auth.js';
import * as branding from '../src/schemas/branding.js';
import * as common from '../src/schemas/common.js';
import * as connection from '../src/schemas/connection.js';
import * as directory from '../src/schemas/directory.js';
import * as exportImport from '../src/schemas/export-import.js';
import * as health from '../src/schemas/health.js';
import * as manifest from '../src/schemas/manifest.js';
import * as meta from '../src/schemas/meta.js';
import * as rbac from '../src/schemas/rbac.js';
import * as setup from '../src/schemas/setup.js';
import { expectGuardFails } from '../src/testing/index.js';

/** Every module of `src/schemas`, by file stem: the ids of all of them share one OpenAPI document. */
const SCHEMA_MODULES: Readonly<Record<string, Record<string, unknown>>> = {
  assets,
  auth,
  branding,
  common,
  connection,
  directory,
  'export-import': exportImport,
  health,
  manifest,
  meta,
  rbac,
  setup,
};

const {
  BasicUserSchema,
  DirectoryOrderSchema,
  DirectoryPageQuerySchema,
  DirectoryRefSchema,
  DirectoryRowSchema,
  DirectorySearchSchema,
  EnabledFilterSchema,
  GroupDetailSchema,
  GroupIdParamsSchema,
  GroupKindFilterSchema,
  GroupKindSchema,
  GroupListItemSchema,
  GroupListQuerySchema,
  GroupListResponseSchema,
  ManagerStateSchema,
  MembersResponseSchema,
  OwnersResponseSchema,
  RestrictedRowSchema,
  UserDetailSchema,
  UserGroupsResponseSchema,
  UserIdParamsSchema,
  UserListItemSchema,
  UserListQuerySchema,
  UserListResponseSchema,
  UserTypeFilterSchema,
} = directory;

const GUID = '8e0c2b8e-0000-4000-8000-0000000000aa';
const GUID_2 = '8e0c2b8e-0000-4000-8000-0000000000bb';
const TS = '2026-10-11T12:00:00.000Z';

const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

/** A copy of `value` without the given members. */
const without = (value: Record<string, unknown>, ...keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => !keys.includes(name)));

const fullUser = {
  id: GUID,
  displayName: 'Generated Person',
  userPrincipalName: 'generated.person@example.test',
  mail: 'generated.person@example.test',
  department: 'Finance',
  jobTitle: 'Analyst',
  accountEnabled: true,
  userType: 'member',
};
const basicUser = {
  id: GUID,
  displayName: 'Generated Person',
  mail: 'generated.person@example.test',
};
const userDetail = {
  ...fullUser,
  givenName: 'Generated',
  surname: 'Person',
  officeLocation: 'Room 1',
  onPremisesSyncEnabled: false,
  createdDateTime: TS,
  manager: { state: 'none' },
};
const group = {
  id: GUID,
  displayName: 'Generated Group',
  mail: 'generated.group@example.test',
  kind: 'm365',
  visibility: 'Private',
};
const groupDetail = {
  ...group,
  description: 'A generated group',
  mailNickname: 'generated-group',
  membershipType: 'assigned',
  onPremisesSyncEnabled: false,
  createdDateTime: TS,
};
const ref = {
  kind: 'user',
  id: GUID_2,
  displayName: 'Generated Member',
  mail: 'generated.member@example.test',
  userPrincipalName: 'generated.member@example.test',
};
const restricted = { kind: 'user', restricted: true };

describe('component ids', () => {
  const exported = Object.entries({ ...directory }).filter(([name]) => name.endsWith('Schema'));

  it('exports every schema of the contract', () => {
    for (const name of [
      'UserListQuerySchema',
      'UserListItemSchema',
      'UserListResponseSchema',
      'UserIdParamsSchema',
      'UserDetailSchema',
      'ManagerStateSchema',
      'UserGroupsResponseSchema',
      'GroupListQuerySchema',
      'GroupListItemSchema',
      'GroupListResponseSchema',
      'GroupIdParamsSchema',
      'GroupDetailSchema',
      'OwnersResponseSchema',
      'MembersResponseSchema',
      'DirectoryRowSchema',
      'RestrictedRowSchema',
    ]) {
      expect(Object.keys(directory), name).toContain(name);
    }
  });

  it('gives every schema an id that is its constant name without the suffix', () => {
    expect(exported.length).toBeGreaterThan(25);
    for (const [name, schema] of exported) {
      expect((schema as z.ZodType).meta()?.id, name).toBe(name.replace(/Schema$/, ''));
    }
  });

  it('keeps the ids unique across the whole schema folder (one OpenAPI document)', () => {
    const folder = fileURLToPath(new URL('../src/schemas/', import.meta.url));
    const files = readdirSync(folder)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.slice(0, -'.ts'.length))
      .sort();
    // A schema file added later must be added to this list, or the check would not see it.
    expect(files).toEqual(Object.keys(SCHEMA_MODULES).sort());
    const owners = new Map<string, string>();
    const instances = new Map<string, unknown>();
    const clashes: string[] = [];
    for (const [file, module] of Object.entries(SCHEMA_MODULES)) {
      for (const [name, value] of Object.entries(module)) {
        if (!name.endsWith('Schema') || !(value instanceof z.ZodType)) continue;
        const id = value.meta()?.id;
        if (typeof id !== 'string') continue;
        const earlier = owners.get(id);
        // The same schema re-exported by a second file is one component, not a clash.
        if (earlier !== undefined && instances.get(id) !== value) {
          clashes.push(`${id}: ${earlier} and ${file}.ts:${name}`);
        }
        if (earlier === undefined) {
          owners.set(id, `${file}.ts:${name}`);
          instances.set(id, value);
        }
      }
    }
    expect(clashes).toEqual([]);
    expect(owners.get('UserListQuery')).toBe('directory.ts:UserListQuerySchema');
  });

  it('is representable in JSON Schema (OpenAPI), for requests and for responses', () => {
    for (const [name, schema] of exported) {
      expect(() => z.toJSONSchema(schema as z.ZodType, { io: 'input' }), name).not.toThrow();
      expect(() => z.toJSONSchema(schema as z.ZodType, { io: 'output' }), name).not.toThrow();
    }
  });
});

describe('the closed vocabularies', () => {
  it('has the filters of FR-C-201 and FR-C-301, in the order the UI shows them', () => {
    expect(EnabledFilterSchema.options).toEqual(['all', 'true', 'false']);
    expect(UserTypeFilterSchema.options).toEqual(['all', 'member', 'guest']);
    expect(DirectoryOrderSchema.options).toEqual(['asc', 'desc']);
    expect(GroupKindFilterSchema.options).toEqual([
      'all',
      'm365',
      'security',
      'mailsecurity',
      'distribution',
    ]);
  });

  it('takes the group kinds from the one derivation (groupKindOf), so no second list exists', () => {
    expect(GroupKindSchema.options).toEqual([...GROUP_KINDS]);
    // `unknown` is a state of a row, never a value of the filter.
    expect(accepts(GroupKindSchema, 'unknown')).toBe(true);
    expect(accepts(GroupKindFilterSchema, 'unknown')).toBe(false);
    expect([...GroupKindFilterSchema.options].slice(1)).toEqual(
      GROUP_KINDS.filter((kind) => kind !== 'unknown'),
    );
  });
});

describe('DirectorySearchSchema: the prefix text (FR-C-201, EC-C1)', () => {
  it.each([
    ['one character', 'a'],
    ['a name with a quote', "O'Neil"],
    ['diacritics', 'Zoë Müller'],
    ['64 characters', 'x'.repeat(64)],
    ['64 characters outside the basic plane', '😀'.repeat(64)],
    ['an at sign and a dot', 'jan.jansen@'],
    ['an odata injection attempt, as plain text', "') or startsWith(mail,'"],
  ])('accepts %s', (_label, text) => {
    expect(accepts(DirectorySearchSchema, text)).toBe(true);
  });

  it.each([
    ['the empty string', ''],
    ['65 characters', 'x'.repeat(65)],
    ['65 characters outside the basic plane', '😀'.repeat(65)],
    ['a new line', 'a\nb'],
    ['a tab', 'a\tb'],
    ['a null character', 'a\u0000b'],
    ['a delete character', 'a\u007fb'],
    ['a line separator', 'a b'],
    ['a paragraph separator', 'a b'],
    ['a number', 7],
    ['null', null],
  ])('refuses %s', (_label, text) => {
    expect(accepts(DirectorySearchSchema, text)).toBe(false);
  });

  it('is limited by LIMITS.directory.searchMaxChars, not by a number typed here', () => {
    expect(LIMITS.directory.searchMaxChars).toBe(64);
    expect(accepts(DirectorySearchSchema, 'x'.repeat(LIMITS.directory.searchMaxChars))).toBe(true);
    expect(accepts(DirectorySearchSchema, 'x'.repeat(LIMITS.directory.searchMaxChars + 1))).toBe(
      false,
    );
  });
});

describe('UserListQuerySchema (P33)', () => {
  it('takes no parameter at all and gives the defaults: all, all, ascending', () => {
    expect(UserListQuerySchema.parse({})).toEqual({ enabled: 'all', type: 'all', order: 'asc' });
  });

  it('takes the search, the filters, the order, the limit and the cursor', () => {
    const query = {
      q: 'ja',
      enabled: 'false',
      type: 'guest',
      order: 'desc',
      limit: '50',
      cursor: 'AbC_-123',
    };
    expect(UserListQuerySchema.parse(query)).toEqual(query);
  });

  it.each([
    ['an unknown parameter', { sort: 'mail' }],
    ['a licence filter (decision D-C3)', { licensed: 'true' }],
    ['a skip (Graph has no $skip, R-C-01)', { skip: '10' }],
    ['a total', { count: 'true' }],
    ['enabled as yes', { enabled: 'yes' }],
    ['enabled in upper case', { enabled: 'True' }],
    ['type as admin', { type: 'admin' }],
    ['an order by another column', { order: 'mail' }],
    ['an empty search', { q: '' }],
    ['a search of 65 characters', { q: 'x'.repeat(65) }],
    ['a limit of 0', { limit: '0' }],
    ['a limit of 201', { limit: '201' }],
    ['a limit with a sign', { limit: '+5' }],
    ['a limit as a number', { limit: 50 }],
    ['a cursor with a space', { cursor: 'a b' }],
    ['a cursor of 513 characters', { cursor: 'a'.repeat(513) }],
    ['an empty cursor', { cursor: '' }],
  ])('refuses %s', (_label, query) => {
    expect(accepts(UserListQuerySchema, query)).toBe(false);
  });

  it('accepts a cursor of exactly 512 characters', () => {
    expect(accepts(UserListQuerySchema, { cursor: 'a'.repeat(512) })).toBe(true);
  });
});

describe('GroupListQuerySchema (P36)', () => {
  it('gives the defaults: all kinds, ascending', () => {
    expect(GroupListQuerySchema.parse({})).toEqual({ kind: 'all', order: 'asc' });
  });

  it.each(['m365', 'security', 'mailsecurity', 'distribution'])('takes the kind %s', (kind) => {
    expect(GroupListQuerySchema.parse({ kind, q: 'sales' })).toMatchObject({ kind, q: 'sales' });
  });

  it.each([
    ['unknown as a filter', { kind: 'unknown' }],
    ['dynamic distribution (Graph does not return it, R-C-03)', { kind: 'dynamic' }],
    ['an unknown parameter', { visibility: 'Public' }],
    ['a user filter', { enabled: 'true' }],
    ['an empty search', { q: '' }],
    ['a control character in the search', { q: 'a\u0007' }],
  ])('refuses %s', (_label, query) => {
    expect(accepts(GroupListQuerySchema, query)).toBe(false);
  });
});

describe('DirectoryPageQuerySchema: the sub-lists P35, P38 and P39', () => {
  it('takes a limit and a cursor and nothing else', () => {
    expect(DirectoryPageQuerySchema.parse({ limit: '100', cursor: 'abc' })).toEqual({
      limit: '100',
      cursor: 'abc',
    });
    expect(DirectoryPageQuerySchema.parse({})).toEqual({});
    expect(accepts(DirectoryPageQuerySchema, { q: 'a' })).toBe(false);
    expect(accepts(DirectoryPageQuerySchema, { limit: '201' })).toBe(false);
  });
});

describe('path parameters (EC-C15: ids are GUIDs only, PC-06)', () => {
  it('takes a lower-case GUID', () => {
    expect(UserIdParamsSchema.parse({ id: GUID })).toEqual({ id: GUID });
    expect(GroupIdParamsSchema.parse({ id: GUID })).toEqual({ id: GUID });
  });

  it.each([
    ['a user principal name', 'jan@example.test'],
    ['an upper-case GUID', GUID.toUpperCase()],
    ['a GUID in braces', `{${GUID}}`],
    ['bare hex', GUID.replaceAll('-', '')],
    ['a path trick', '../groups'],
    ['the empty string', ''],
    ['me', 'me'],
  ])('refuses %s', (_label, id) => {
    expect(accepts(UserIdParamsSchema, { id })).toBe(false);
    expect(accepts(GroupIdParamsSchema, { id })).toBe(false);
  });

  it('refuses an extra parameter', () => {
    expect(accepts(UserIdParamsSchema, { id: GUID, extra: 'x' })).toBe(false);
  });
});

describe('user rows (FR-C-204, FR-C-205)', () => {
  it('accepts the full list item and the basic one (id, name, mail)', () => {
    expect(accepts(UserListItemSchema, fullUser)).toBe(true);
    expect(accepts(UserListItemSchema, basicUser)).toBe(true);
    expect(accepts(BasicUserSchema, basicUser)).toBe(true);
  });

  it('takes null for every property Graph did not return (EC-C10), never an absent key', () => {
    expect(
      accepts(UserListItemSchema, {
        id: GUID,
        displayName: null,
        userPrincipalName: null,
        mail: null,
        department: null,
        jobTitle: null,
        accountEnabled: null,
        userType: null,
      }),
    ).toBe(true);
    expect(accepts(BasicUserSchema, { id: GUID, displayName: null, mail: null })).toBe(true);
    expect(accepts(UserListItemSchema, without(fullUser, 'department'))).toBe(false);
  });

  it.each([
    ['a basic row with an extra field (widening a basic grant)', { ...basicUser, department: 'x' }],
    ['a full row with an unknown field', { ...fullUser, manager: 'x' }],
    ['a licence field (D-C3)', { ...fullUser, assignedLicenses: [] }],
    ['a phone number', { ...fullUser, mobilePhone: '+31000000000' }],
    ['an id that is not a GUID', { ...fullUser, id: 'jan@example.test' }],
    ['a user type outside member and guest', { ...fullUser, userType: 'Member' }],
    ['an enabled flag as text', { ...fullUser, accountEnabled: 'true' }],
    ['a name above 256 bytes', { ...fullUser, displayName: 'x'.repeat(257) }],
    [
      'a name above 256 bytes in two-byte characters',
      { ...fullUser, displayName: 'é'.repeat(129) },
    ],
    ['no id', { displayName: 'x', mail: null }],
  ])('refuses %s', (_label, row) => {
    expect(accepts(UserListItemSchema, row)).toBe(false);
  });

  it('accepts a name of exactly 256 bytes', () => {
    expect(accepts(UserListItemSchema, { ...fullUser, displayName: 'x'.repeat(256) })).toBe(true);
    expect(accepts(UserListItemSchema, { ...fullUser, displayName: 'é'.repeat(128) })).toBe(true);
  });

  it('keeps markup as text: a name is a string, whatever it contains (FR-C-404)', () => {
    const name = '<img src=x onerror=alert(1)>';
    expect(UserListItemSchema.parse({ ...fullUser, displayName: name })).toMatchObject({
      displayName: name,
    });
  });
});

describe('UserDetailSchema (P34)', () => {
  it('accepts the full detail with each manager state, and the basic detail without manager', () => {
    expect(accepts(UserDetailSchema, userDetail)).toBe(true);
    expect(accepts(UserDetailSchema, { ...userDetail, manager: { state: 'unavailable' } })).toBe(
      true,
    );
    expect(
      accepts(UserDetailSchema, {
        ...userDetail,
        manager: { state: 'present', user: { ...ref } },
      }),
    ).toBe(true);
    expect(accepts(UserDetailSchema, basicUser)).toBe(true);
  });

  it('has no memberships in it (P35 is a route of its own, FR-C-205)', () => {
    expect(accepts(UserDetailSchema, { ...userDetail, groups: [] })).toBe(false);
    expect(accepts(UserDetailSchema, { ...userDetail, memberOf: [] })).toBe(false);
  });

  it('wants a UTC timestamp with milliseconds, or null', () => {
    expect(accepts(UserDetailSchema, { ...userDetail, createdDateTime: null })).toBe(true);
    expect(
      accepts(UserDetailSchema, { ...userDetail, createdDateTime: '2026-10-11T12:00:00Z' }),
    ).toBe(false);
    expect(
      accepts(UserDetailSchema, {
        ...userDetail,
        createdDateTime: '2026-10-11T12:00:00.000+02:00',
      }),
    ).toBe(false);
  });

  it('refuses a detail that mixes the basic and the full shapes (a half-projected user)', () => {
    expect(accepts(UserDetailSchema, without(userDetail, 'department', 'jobTitle'))).toBe(false);
    expect(accepts(UserDetailSchema, { ...basicUser, manager: { state: 'none' } })).toBe(false);
  });
});

describe('ManagerStateSchema (FR-C-107, EC-C5, EC-C6)', () => {
  it('has three states, discriminated by `state`', () => {
    expect(accepts(ManagerStateSchema, { state: 'none' })).toBe(true);
    expect(accepts(ManagerStateSchema, { state: 'unavailable' })).toBe(true);
    expect(accepts(ManagerStateSchema, { state: 'present', user: ref })).toBe(true);
  });

  it('shows a manager the actor may not see as a restricted row, without id, name or address', () => {
    expect(accepts(ManagerStateSchema, { state: 'present', user: restricted })).toBe(true);
    expect(
      accepts(ManagerStateSchema, { state: 'present', user: { ...restricted, id: GUID } }),
    ).toBe(false);
  });

  it.each([
    ['present without a user', { state: 'present' }],
    ['none with a user', { state: 'none', user: ref }],
    ['unavailable with a reason from Graph', { state: 'unavailable', reason: 'Forbidden' }],
    ['another state', { state: 'error' }],
    ['no state', {}],
  ])('refuses %s', (_label, manager) => {
    expect(accepts(ManagerStateSchema, manager)).toBe(false);
  });
});

describe('group rows (FR-C-301, FR-C-303, FR-C-304)', () => {
  it('accepts the list item and the detail', () => {
    expect(accepts(GroupListItemSchema, group)).toBe(true);
    expect(accepts(GroupDetailSchema, groupDetail)).toBe(true);
  });

  it.each(GROUP_KINDS)('accepts the kind %s', (kind) => {
    expect(accepts(GroupListItemSchema, { ...group, kind })).toBe(true);
  });

  it('accepts null for what Graph did not return, including the visibility of a group of kind unknown (U36)', () => {
    expect(
      accepts(GroupListItemSchema, {
        id: GUID,
        displayName: null,
        mail: null,
        kind: 'unknown',
        visibility: null,
      }),
    ).toBe(true);
    expect(
      accepts(GroupDetailSchema, {
        ...groupDetail,
        kind: 'unknown',
        visibility: null,
        description: null,
        mailNickname: null,
        membershipType: null,
        onPremisesSyncEnabled: null,
        createdDateTime: null,
      }),
    ).toBe(true);
  });

  it.each(['Private', 'Public', 'HiddenMembership'])(
    'accepts the visibility %s (R-C-05)',
    (visibility) => {
      expect(accepts(GroupListItemSchema, { ...group, visibility })).toBe(true);
    },
  );

  it.each([
    ['a kind outside the five', { kind: 'dynamic' }],
    ['a visibility outside the three', { visibility: 'Secret' }],
    ['a visibility in lower case', { visibility: 'private' }],
    [
      'the three source properties instead of the kind (one derivation only)',
      { groupTypes: ['Unified'] },
    ],
    ['mailEnabled on the wire', { mailEnabled: true }],
    ['a member count (a count would leak the size of a scope)', { memberCount: 3 }],
    ['an id that is not a GUID', { id: 'x' }],
  ])('refuses %s', (_label, change) => {
    expect(accepts(GroupListItemSchema, { ...group, ...change })).toBe(false);
  });

  it('refuses a membership type outside assigned and dynamic, and an extra field in the detail', () => {
    expect(accepts(GroupDetailSchema, { ...groupDetail, membershipType: 'rule' })).toBe(false);
    expect(accepts(GroupDetailSchema, { ...groupDetail, owners: [] })).toBe(false);
    expect(accepts(GroupDetailSchema, { ...groupDetail, members: [] })).toBe(false);
  });

  it('accepts dynamic', () => {
    expect(accepts(GroupDetailSchema, { ...groupDetail, membershipType: 'dynamic' })).toBe(true);
  });
});

describe('members and owners: references and restricted rows (FR-C-306, FR-C-307, EC-C9)', () => {
  it('accepts a reference of each kind, with null for what Graph did not return', () => {
    expect(accepts(DirectoryRefSchema, ref)).toBe(true);
    expect(
      accepts(DirectoryRefSchema, {
        kind: 'group',
        id: GUID,
        displayName: 'Generated Group',
        mail: null,
        userPrincipalName: null,
      }),
    ).toBe(true);
    // A device, service principal or contact: counted, not shown by name (EC-C9).
    expect(
      accepts(DirectoryRefSchema, {
        kind: 'other',
        id: GUID,
        displayName: null,
        mail: null,
        userPrincipalName: null,
      }),
    ).toBe(true);
  });

  it('accepts a restricted row of each kind', () => {
    for (const kind of ['user', 'group', 'other']) {
      expect(accepts(RestrictedRowSchema, { kind, restricted: true }), kind).toBe(true);
    }
  });

  it.each([
    ['an id', { id: GUID }],
    ['a display name', { displayName: 'Hidden Person' }],
    ['a mail address', { mail: 'hidden@example.test' }],
    ['a user principal name', { userPrincipalName: 'hidden@example.test' }],
    ['a null id (the key itself is a hint)', { id: null }],
    ['a null display name', { displayName: null }],
  ])('refuses a restricted row with %s', (_label, extra) => {
    expect(accepts(RestrictedRowSchema, { ...restricted, ...extra })).toBe(false);
    expect(accepts(DirectoryRowSchema, { ...restricted, ...extra })).toBe(false);
  });

  it('refuses a restricted row that says restricted: false, or a kind outside the three', () => {
    expect(accepts(RestrictedRowSchema, { kind: 'user', restricted: false })).toBe(false);
    expect(accepts(RestrictedRowSchema, { kind: 'device', restricted: true })).toBe(false);
    expect(accepts(RestrictedRowSchema, { restricted: true })).toBe(false);
  });

  it('is a row that is either a reference or a restricted row, never a mixture', () => {
    expect(accepts(DirectoryRowSchema, ref)).toBe(true);
    expect(accepts(DirectoryRowSchema, restricted)).toBe(true);
    expect(accepts(DirectoryRowSchema, { ...ref, restricted: true })).toBe(false);
    expect(accepts(DirectoryRowSchema, { ...ref, restricted: false })).toBe(false);
  });

  /** The guard of the restricted row: a candidate shape must carry nothing that identifies the object. */
  function assertNoIdentity(row: unknown): void {
    const parsed = RestrictedRowSchema.safeParse(row);
    if (!parsed.success) throw new Error('a restricted row carries more than kind and restricted');
  }

  it('fails the guard on a raw row handed out where a restricted row belongs (negative fixture)', () => {
    expect(() => {
      assertNoIdentity(restricted);
    }).not.toThrow();
    expectGuardFails(assertNoIdentity, ref, { reason: 'a restricted row carries more than' });
    expectGuardFails(assertNoIdentity, { ...restricted, id: GUID }, { reason: 'more than kind' });
  });
});

describe('isRestrictedRow', () => {
  it('tells a restricted row from a reference, for the server and the web alike', () => {
    expect(directory.isRestrictedRow(restricted as directory.DirectoryRow)).toBe(true);
    expect(directory.isRestrictedRow(ref as directory.DirectoryRow)).toBe(false);
  });
});

describe('the list and sub-list responses (FR-C-201, FR-C-206, FR-C-305, FR-C-306)', () => {
  const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, ...extra });

  it('accepts a page of users, with or without a cursor', () => {
    expect(accepts(UserListResponseSchema, page([fullUser]))).toBe(true);
    expect(
      accepts(UserListResponseSchema, page([fullUser, basicUser], { nextCursor: 'abc' })),
    ).toBe(true);
    expect(accepts(UserListResponseSchema, page([]))).toBe(true);
    expect(accepts(GroupListResponseSchema, page([group], { nextCursor: 'abc' }))).toBe(true);
    expect(accepts(UserGroupsResponseSchema, page([group]))).toBe(true);
  });

  it('holds at most 200 rows (the ceiling of `limit`)', () => {
    const rows = (count: number) => Array.from({ length: count }, () => fullUser);
    expect(accepts(UserListResponseSchema, page(rows(LIMITS.directory.pageLimitMax)))).toBe(true);
    expect(accepts(UserListResponseSchema, page(rows(LIMITS.directory.pageLimitMax + 1)))).toBe(
      false,
    );
  });

  /** The guard behind "no total": a total would leak the size of a scope. */
  function assertNoTotal(input: { schema: z.ZodType; response: unknown }): void {
    const jsonSchema = z.toJSONSchema(input.schema, { io: 'output' });
    const members = Object.keys(jsonSchema.properties ?? {});
    if (members.some((name) => /^(?:total|count|size|length)/i.test(name))) {
      throw new Error('the list response has a total or a count');
    }
    if (!input.schema.safeParse(input.response).success) {
      throw new Error('the list response carries a member nobody declared');
    }
  }

  it('has no total, count or size member, in the schema or on the wire (negative fixture)', () => {
    expect(() => {
      assertNoTotal({ schema: UserListResponseSchema, response: page([fullUser]) });
    }).not.toThrow();
    expectGuardFails(
      assertNoTotal,
      { schema: UserListResponseSchema, response: page([fullUser], { total: 1_200 }) },
      { reason: 'carries a member nobody declared' },
    );
    expectGuardFails(
      assertNoTotal,
      {
        schema: z.strictObject({ items: z.array(z.string()), total: z.int() }),
        response: { items: [], total: 0 },
      },
      { reason: 'has a total or a count' },
    );
    expect(accepts(GroupListResponseSchema, page([group], { total: 3 }))).toBe(false);
    expect(accepts(UserGroupsResponseSchema, page([group], { count: 3 }))).toBe(false);
    expect(accepts(MembersResponseSchema, page([ref], { membersState: 'listed', total: 3 }))).toBe(
      false,
    );
  });

  it('refuses a null cursor (an absent cursor means the end; the member is left out)', () => {
    expect(accepts(UserListResponseSchema, page([], { nextCursor: null }))).toBe(false);
    expect(accepts(UserListResponseSchema, page([], { nextCursor: '' }))).toBe(false);
  });

  it('puts no restricted row in a list of users or groups: restricted rows exist for members and owners only', () => {
    expect(accepts(UserListResponseSchema, page([restricted]))).toBe(false);
    expect(accepts(GroupListResponseSchema, page([restricted]))).toBe(false);
    expect(accepts(UserGroupsResponseSchema, page([restricted]))).toBe(false);
  });

  it('members: listed rows (references and restricted rows), or hidden with nothing in the list (FR-C-108)', () => {
    expect(
      accepts(MembersResponseSchema, page([ref, restricted], { membersState: 'listed' })),
    ).toBe(true);
    expect(accepts(MembersResponseSchema, page([], { membersState: 'hidden' }))).toBe(true);
    expect(accepts(MembersResponseSchema, page([ref], { membersState: 'hidden' }))).toBe(false);
    expect(
      accepts(MembersResponseSchema, page([], { membersState: 'hidden', nextCursor: 'abc' })),
    ).toBe(false);
    expect(accepts(MembersResponseSchema, page([ref]))).toBe(false);
    expect(accepts(MembersResponseSchema, page([ref], { membersState: 'visible' }))).toBe(false);
  });

  it('owners: listed, or not available for this kind of group with nothing in the list (R-C-06)', () => {
    expect(accepts(OwnersResponseSchema, page([ref], { ownersState: 'listed' }))).toBe(true);
    expect(accepts(OwnersResponseSchema, page([], { ownersState: 'listed' }))).toBe(true);
    expect(accepts(OwnersResponseSchema, page([], { ownersState: 'not_available' }))).toBe(true);
    expect(accepts(OwnersResponseSchema, page([ref], { ownersState: 'not_available' }))).toBe(
      false,
    );
    expect(accepts(OwnersResponseSchema, page([], { ownersState: 'hidden' }))).toBe(false);
    expect(accepts(OwnersResponseSchema, page([]))).toBe(false);
  });
});

describe('no licence data in any schema (FR-C-207, decision D-C3)', () => {
  const exported = Object.entries({ ...directory }).filter(([name]) => name.endsWith('Schema'));
  const LICENCE = /licen[cs]e|assignedLicenses|assignedPlans|skuId|servicePlan/i;

  /** The guard: throws when the JSON Schema of the given schemas mentions a licence anywhere. */
  function assertNoLicences(schemas: Record<string, z.ZodType>): void {
    const mentions: string[] = [];
    for (const [name, schema] of Object.entries(schemas)) {
      for (const io of ['input', 'output'] as const) {
        if (LICENCE.test(JSON.stringify(z.toJSONSchema(schema, { io }))))
          mentions.push(`${name} (${io})`);
      }
    }
    if (mentions.length > 0) throw new Error(`licence data in ${mentions.join(', ')}`);
  }

  it('finds no licence field, filter or value in any schema of the folder', () => {
    expect(() => {
      assertNoLicences(Object.fromEntries(exported) as Record<string, z.ZodType>);
    }).not.toThrow();
  });

  it('fails when a schema has a licence field (negative fixture)', () => {
    const bad = z.strictObject({ id: z.string(), assignedLicenses: z.array(z.string()) });
    expectGuardFails(
      assertNoLicences,
      { UserWithLicences: bad },
      { reason: 'licence data in UserWithLicences' },
    );
  });

  it('fails when a query has a licence filter (negative fixture)', () => {
    const bad = UserListQuerySchema.extend({ licensed: z.enum(['true', 'false']).optional() });
    expectGuardFails(
      assertNoLicences,
      { UserListQueryWithLicences: bad },
      { reason: 'licence data in' },
    );
  });
});
