// THE SEARCH PARAMETERS OF /users AND /groups (T-C-042, T-C-044; FR-C-501). The router validates them with
// small functions that import no schema (the route file belongs to the entry bundle); this test ties their
// vocabularies to the wire enums, so the two cannot drift, and proves that a bad link is dropped.
import { LIMITS } from '@m365portal/shared/limits';
import {
  DirectorySearchSchema,
  EnabledFilterSchema,
  GroupKindFilterSchema,
  UserTypeFilterSchema,
} from '@m365portal/shared/schemas/directory';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  ENABLED_VALUES,
  KIND_VALUES,
  SEARCH_MAX_CHARS,
  TYPE_VALUES,
  searchText,
  validateGroupsSearch,
  validateUsersSearch,
} from '../src/features/directory/search';

const without = <T extends string>(options: readonly T[], drop: string): T[] =>
  options.filter((option) => option !== drop);

describe('the vocabularies are the wire enums', () => {
  it('has the non-default values of the three filters', () => {
    expect([...ENABLED_VALUES]).toEqual(without(EnabledFilterSchema.options, 'all'));
    expect([...TYPE_VALUES]).toEqual(without(UserTypeFilterSchema.options, 'all'));
    expect([...KIND_VALUES]).toEqual(without(GroupKindFilterSchema.options, 'all'));
  });

  it('has the search length of the server', () => {
    expect(SEARCH_MAX_CHARS).toBe(LIMITS.directory.searchMaxChars);
    const longest = 'x'.repeat(SEARCH_MAX_CHARS);
    expect(DirectorySearchSchema.safeParse(longest).success).toBe(true);
    expect(searchText(longest)).toBe(longest);
    expect(DirectorySearchSchema.safeParse(`${longest}x`).success).toBe(false);
    expect(searchText(`${longest}x`)).toBeUndefined();
  });

  it('negative: a vocabulary that drifted from the wire fails the tie', () => {
    expectGuardFails(
      () => {
        expect([...ENABLED_VALUES, 'maybe']).toEqual(without(EnabledFilterSchema.options, 'all'));
      },
      { name: 'filter vocabulary against the wire enum' },
    );
  });
});

describe('searchText', () => {
  it('trims, and refuses what the server would refuse (EC-C1)', () => {
    expect(searchText('  Ada  ')).toBe('Ada');
    expect(searchText('')).toBeUndefined();
    expect(searchText('   ')).toBeUndefined();
    expect(searchText('a\nb')).toBeUndefined();
    expect(searchText('a\u0000b')).toBeUndefined();
    expect(searchText('a b')).toBeUndefined();
    expect(searchText(undefined)).toBeUndefined();
    expect(searchText({})).toBeUndefined();
  });

  it('keeps a quote and a diacritic, and reads a number the router parsed', () => {
    expect(searchText("O'Neil")).toBe("O'Neil");
    expect(searchText('Zoë')).toBe('Zoë');
    expect(searchText(2024)).toBe('2024');
  });

  it('counts characters, not UTF-16 units, as the server does', () => {
    const emoji = '😀'.repeat(SEARCH_MAX_CHARS);
    expect(searchText(emoji)).toBe(emoji);
    expect(searchText(`${emoji}😀`)).toBeUndefined();
  });
});

describe('validateUsersSearch and validateGroupsSearch', () => {
  it('keeps a good link', () => {
    expect(
      validateUsersSearch({ q: 'ada', enabled: 'false', type: 'guest', order: 'desc' }),
    ).toEqual({ q: 'ada', enabled: 'false', type: 'guest', order: 'desc' });
    expect(validateGroupsSearch({ q: 'ada', kind: 'distribution', order: 'desc' })).toEqual({
      q: 'ada',
      kind: 'distribution',
      order: 'desc',
    });
  });

  it('reads the booleans the router parses out of the address', () => {
    expect(validateUsersSearch({ enabled: true }).enabled).toBe('true');
    expect(validateUsersSearch({ enabled: false }).enabled).toBe('false');
  });

  it('drops every bad value, and names the key anyway so the router cannot keep the raw one', () => {
    const bad = validateUsersSearch({
      q: 5000,
      enabled: 'maybe',
      type: 'robot',
      order: 'sideways',
    });
    expect(bad).toEqual({ q: '5000', enabled: undefined, type: undefined, order: undefined });
    expect(Object.keys(bad).sort()).toEqual(['enabled', 'order', 'q', 'type']);
    const worse = validateGroupsSearch({ q: 'a\nb', kind: 'licence', order: 'up' });
    expect(worse).toEqual({ q: undefined, kind: undefined, order: undefined });
    expect(Object.keys(worse).sort()).toEqual(['kind', 'order', 'q']);
  });

  it('treats the defaults as no value (the URL of the plain list stays /users)', () => {
    expect(validateUsersSearch({ enabled: 'all', type: 'all', order: 'asc' })).toEqual({
      q: undefined,
      enabled: undefined,
      type: undefined,
      order: undefined,
    });
    expect(validateGroupsSearch({ kind: 'all' }).kind).toBeUndefined();
  });

  it('ignores a key it does not know (no licence filter exists, FR-C-207)', () => {
    expect(validateUsersSearch({ licence: 'e5', assignedLicenses: 'x' })).toEqual({
      q: undefined,
      enabled: undefined,
      type: undefined,
      order: undefined,
    });
  });
});
