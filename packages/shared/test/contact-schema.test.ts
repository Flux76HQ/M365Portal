// T-D-103, FR-D-302, FR-D-303, FR-D-304, EC-D9, EC-D10: the wire schemas of the mail contact routes
// P47 to P52 (frozen at gate GD1-0): display name 1 to 256, alias in the documented set (R-D-09),
// external address valid and normalised, strict bodies, no free text in audit-bound fields.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { LIMITS } from '../src/limits.js';
import * as contacts from '../src/schemas/contacts.js';
import { expectGuardFails } from '../src/testing/index.js';

const {
  CONTACT_AUDIT_FIELDS,
  CONTACT_VALIDATION_CODES,
  ContactAliasSchema,
  ContactCreateRequestSchema,
  ContactDeleteRequestSchema,
  ContactDeleteResponseSchema,
  ContactDetailSchema,
  ContactDisplayNameSchema,
  ContactIdParamsSchema,
  ContactListItemSchema,
  ContactListQuerySchema,
  ContactListResponseSchema,
  ContactListsResponseSchema,
  ContactUpdateRequestSchema,
  ExternalEmailAddressSchema,
  normalizeExternalAddress,
} = contacts;

const GUID = '8e0c2b8e-0000-4000-8000-0000000000aa';
const TS = '2026-10-11T12:00:00.000Z';
const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;
const messages = (schema: z.ZodType, value: unknown): string[] => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('display name (FR-D-302: 1 to 256 characters)', () => {
  it('accepts 1 to 256 characters counted as code points', () => {
    expect(accepts(ContactDisplayNameSchema, 'A')).toBe(true);
    expect(accepts(ContactDisplayNameSchema, 'x'.repeat(256))).toBe(true);
    expect(accepts(ContactDisplayNameSchema, '😀'.repeat(256))).toBe(true);
  });

  it('refuses empty, too long, padded and control characters, each with its own message code', () => {
    expect(messages(ContactDisplayNameSchema, '')).toEqual(['display_name_empty']);
    expect(messages(ContactDisplayNameSchema, 'x'.repeat(257))).toEqual(['display_name_too_long']);
    expect(messages(ContactDisplayNameSchema, ' padded')).toEqual(['display_name_characters']);
    expect(messages(ContactDisplayNameSchema, 'padded ')).toEqual(['display_name_characters']);
    expect(messages(ContactDisplayNameSchema, 'line\nbreak')).toEqual(['display_name_characters']);
    expect(accepts(ContactDisplayNameSchema, 42)).toBe(false);
  });
});

describe('alias (R-D-09: letters, digits, ! # % * + - / = ? ^ _ ~, periods between characters, U+00A1 to U+00FF, at most 64)', () => {
  it.each(['jan', 'jan.de.vries', 'a-b_c~d', '!#%*+-/=?^_~', 'café'.normalize('NFC'), 'Jan1'])(
    'accepts %s',
    (alias) => {
      expect(accepts(ContactAliasSchema, alias)).toBe(true);
    },
  );

  it.each([
    '.jan',
    'jan.',
    'jan..vries',
    'jan vries',
    'jan$',
    'jan&co',
    "o'neil",
    'jan`',
    'a{b}',
    'a|b',
    'a\\b',
    'jan@example',
    '日本',
    'jan\t',
  ])('refuses %j (EC-D10: rejected before the call)', (alias) => {
    expect(messages(ContactAliasSchema, alias)).toEqual(['alias_characters']);
  });

  it('refuses empty and over 64 characters with their own codes', () => {
    expect(messages(ContactAliasSchema, '')).toEqual(['alias_empty']);
    expect(accepts(ContactAliasSchema, 'a'.repeat(LIMITS.contacts.aliasMaxChars))).toBe(true);
    expect(messages(ContactAliasSchema, 'a'.repeat(LIMITS.contacts.aliasMaxChars + 1))).toEqual([
      'alias_too_long',
    ]);
  });
});

describe('external address (valid and normalised)', () => {
  it('normalises by trimming and lower-casing, and returns null for anything that is not an address', () => {
    expect(normalizeExternalAddress('  Jan.DeVries@Example.TEST ')).toBe(
      'jan.devries@example.test',
    );
    expect(normalizeExternalAddress('jan@example.test')).toBe('jan@example.test');
    for (const bad of [
      '',
      'jan',
      'jan@',
      '@example.test',
      'jan@example',
      'jan@@example.test',
      'jan vries@example.test',
      'Jan <jan@example.test>',
      '"jan"@example.test',
      'mailto:jan@example.test',
      'SMTP:jan@example.test',
      'jan@exa_mple.test',
      'jan@-example.test',
      'jan@example..test',
      'jan@example.t',
      'jan@123',
      'ja$n@example.test',
      'jän@example.test',
      `${'a'.repeat(65)}@example.test`,
      `a@${'b'.repeat(250)}.test`,
    ]) {
      expect(normalizeExternalAddress(bad), bad).toBeNull();
    }
  });

  it('the schema takes the normalised form only', () => {
    expect(accepts(ExternalEmailAddressSchema, 'jan@example.test')).toBe(true);
    expect(messages(ExternalEmailAddressSchema, 'Jan@Example.test')).toEqual([
      'address_not_normalised',
    ]);
    expect(messages(ExternalEmailAddressSchema, ' jan@example.test')).toEqual([
      'address_not_normalised',
    ]);
    expect(messages(ExternalEmailAddressSchema, 'not an address')).toEqual(['address_invalid']);
    expect(
      messages(ExternalEmailAddressSchema, `${'a'.repeat(LIMITS.contacts.addressMaxChars)}@x.test`),
    ).toEqual(['address_too_long']);
    expect(accepts(ExternalEmailAddressSchema, 'a@b.co')).toBe(true);
  });

  it('is idempotent: a normalised address normalises to itself', () => {
    for (const value of ['jan@example.test', 'a.b+c@sub.example.co']) {
      expect(normalizeExternalAddress(value)).toBe(value);
    }
  });
});

describe('create, update and delete requests', () => {
  const create = {
    displayName: 'Jan de Vries',
    alias: 'jan.devries',
    externalEmailAddress: 'jan@example.test',
  };

  it('create takes the three fields and optional first and last name (supported on New-MailContact only, U15)', () => {
    expect(accepts(ContactCreateRequestSchema, create)).toBe(true);
    expect(
      accepts(ContactCreateRequestSchema, { ...create, firstName: 'Jan', lastName: 'de Vries' }),
    ).toBe(true);
    expect(accepts(ContactCreateRequestSchema, { ...create, firstName: 'x'.repeat(65) })).toBe(
      false,
    );
    for (const field of Object.keys(create)) {
      const rest = Object.fromEntries(Object.entries(create).filter(([key]) => key !== field));
      expect(accepts(ContactCreateRequestSchema, rest), field).toBe(false);
    }
    expect(accepts(ContactCreateRequestSchema, { ...create, id: GUID })).toBe(false);
    expect(accepts(ContactCreateRequestSchema, { ...create, hidden: true })).toBe(false);
  });

  it('update takes any of the three, at least one, and never a first or last name (Set-MailContact has none)', () => {
    expect(accepts(ContactUpdateRequestSchema, { displayName: 'New' })).toBe(true);
    expect(
      accepts(ContactUpdateRequestSchema, {
        alias: 'new',
        externalEmailAddress: 'new@example.test',
      }),
    ).toBe(true);
    expect(messages(ContactUpdateRequestSchema, {})).toEqual(['nothing_to_change']);
    expect(accepts(ContactUpdateRequestSchema, { firstName: 'x' })).toBe(false);
  });

  it('delete carries the confirmed name as a body field (FR-D-303) and nothing else', () => {
    expect(accepts(ContactDeleteRequestSchema, { confirmName: 'Jan de Vries' })).toBe(true);
    expect(accepts(ContactDeleteRequestSchema, {})).toBe(false);
    expect(accepts(ContactDeleteRequestSchema, { confirmName: '' })).toBe(false);
    expect(accepts(ContactDeleteRequestSchema, { confirmName: 'x', force: true })).toBe(false);
  });

  it('the delete response lists the lists the contact was in', () => {
    expect(
      accepts(ContactDeleteResponseSchema, {
        removedFromLists: [{ id: GUID, displayName: 'Sales' }],
      }),
    ).toBe(true);
    expect(accepts(ContactDeleteResponseSchema, { removedFromLists: [] })).toBe(true);
    expect(
      accepts(ContactDeleteResponseSchema, {
        removedFromLists: [{ id: GUID, displayName: 'Sales', members: 3 }],
      }),
    ).toBe(false);
  });
});

describe('queries, rows and responses', () => {
  const row = {
    id: GUID,
    displayName: 'Jan',
    alias: 'jan',
    externalEmailAddress: 'jan@example.test',
    synced: false,
  };

  it('list query: q, kind-less, page and order; strict', () => {
    expect(ContactListQuerySchema.parse({}).order).toBe('asc');
    expect(accepts(ContactListQuerySchema, { q: 'jan', limit: '50', order: 'desc' })).toBe(true);
    expect(accepts(ContactListQuerySchema, { kind: 'x' })).toBe(false);
    expect(accepts(ContactIdParamsSchema, { id: GUID })).toBe(true);
    expect(accepts(ContactIdParamsSchema, { id: 'jan@example.test' })).toBe(false);
  });

  it('rows write unknowns as null (synced is null when Exchange does not say, U80)', () => {
    expect(accepts(ContactListItemSchema, row)).toBe(true);
    expect(
      accepts(ContactListItemSchema, {
        ...row,
        displayName: null,
        alias: null,
        externalEmailAddress: null,
        synced: null,
      }),
    ).toBe(true);
    const absent = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'synced'));
    expect(accepts(ContactListItemSchema, absent)).toBe(false);
    expect(accepts(ContactListItemSchema, { ...row, phone: '1' })).toBe(false);
  });

  it('detail adds the names, the hidden flag and the creation time', () => {
    const detail = {
      ...row,
      firstName: null,
      lastName: null,
      hiddenFromAddressLists: false,
      createdDateTime: TS,
    };
    expect(accepts(ContactDetailSchema, detail)).toBe(true);
    expect(accepts(ContactDetailSchema, { ...detail, createdDateTime: 'yesterday' })).toBe(false);
  });

  it('responses have no total; the memberships of a contact are list rows', () => {
    expect(accepts(ContactListResponseSchema, { items: [row] })).toBe(true);
    expect(accepts(ContactListResponseSchema, { items: [row], total: 1 })).toBe(false);
    const list = {
      id: GUID,
      displayName: 'Sales',
      primarySmtpAddress: null,
      kind: 'standard',
      securityEnabled: null,
      memberCount: null,
      managers: null,
    };
    expect(accepts(ContactListsResponseSchema, { items: [list] })).toBe(true);
  });
});

describe('audit-bound fields carry names, never values (FR-D-304)', () => {
  it('lists exactly the three changeable fields', () => {
    expect([...CONTACT_AUDIT_FIELDS]).toEqual(['displayName', 'alias', 'externalEmailAddress']);
  });

  it('has a message key for every validation code in the contacts shell, in both languages', async () => {
    const { default: en } = await import('../src/i18n/locales/lazy/contacts.en.json', {
      with: { type: 'json' },
    });
    const { default: nl } = await import('../src/i18n/locales/lazy/contacts.nl.json', {
      with: { type: 'json' },
    });
    for (const code of CONTACT_VALIDATION_CODES) {
      expect((en as Record<string, string>)[`contacts.validation.${code}`], code).toBeTruthy();
      expect((nl as Record<string, string>)[`contacts.validation.${code}`], code).toBeTruthy();
    }
  });

  it('every message the schemas can produce is a declared validation code (negative fixture)', () => {
    const declared = new Set<string>(CONTACT_VALIDATION_CODES);
    const guard = (message: string): void => {
      if (!declared.has(message)) throw new Error('undeclared validation code');
    };
    const produced = [
      ...messages(ContactDisplayNameSchema, ''),
      ...messages(ContactDisplayNameSchema, 'x'.repeat(300)),
      ...messages(ContactAliasSchema, 'a b'),
      ...messages(ExternalEmailAddressSchema, 'nope'),
      ...messages(ContactUpdateRequestSchema, {}),
    ];
    expect(produced.length).toBeGreaterThan(3);
    for (const message of produced) guard(message);
    expectGuardFails(guard, 'Invalid input', { reason: 'undeclared validation code' });
  });
});
