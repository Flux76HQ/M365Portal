// T-B-232, FR-B-513, B-11, BCB-09, SB-07: scope items. One module normalises, keys and matches them,
// and one table (`SCOPE_MATRIX`) says which combinations exist; the SQL CHECK of `rbac_assignment_scope`
// says the same, which the property test at the end proves in both directions against a real SQLite.
//
// The matrix, the character rules and the Greek final-sigma cases are written out again here as the
// independent second statement. The property test is seeded (RBAC_PROPERTY_SEED), prints the seed on
// failure and runs at least 20,000 cases (SC-B-006; RBAC_PROPERTY_CASES may only raise the count).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { RESOURCE_TYPES, type ResourceAttrs, type ResourceType } from '../src/rbac/resources.js';
import {
  SCOPE_ITEMS_MAX,
  SCOPE_MATRIX,
  SCOPE_VALUE_MAX_CODE_POINTS,
  canonicalScopeKey,
  fold,
  matchScope,
  normalizeScopeItem,
  normalizeScopeItems,
  scopeItemKey,
  type ScopeItem,
  type ScopeItemResult,
} from '../src/rbac/scope.js';
import { expectGuardFails } from '../src/testing/index.js';

const GUID_A = '8e0c2b8e-0000-4000-8000-0000000000aa';
const GUID_B = '8e0c2b8e-0000-4000-8000-0000000000bb';

const prefix = (
  target: ResourceType,
  attr: 'displayName' | 'alias' | 'mail',
  value: string,
): ScopeItem => ({ target, match: { by: 'prefix', attr, value } });
const department = (target: ResourceType, value: string): ScopeItem => ({
  target,
  match: { by: 'department', value },
});
const byId = (target: ResourceType, id: string): ScopeItem => ({ target, match: { by: 'id', id } });

// ---------------------------------------------------------------------------------------------
describe('SCOPE_MATRIX (plan 11.3, SB-07)', () => {
  const EXPECTED = {
    user: { id: false, prefix: ['displayName', 'mail'], department: true },
    group: { id: true, prefix: ['displayName', 'alias', 'mail'], department: false },
    distributionList: { id: true, prefix: ['displayName', 'alias', 'mail'], department: false },
    contact: { id: true, prefix: ['displayName', 'alias', 'mail'], department: true },
  } as const;

  it.each(RESOURCE_TYPES)('says for %s what the spec says', (target) => {
    expect(SCOPE_MATRIX[target]).toEqual(EXPECTED[target]);
  });

  it('covers exactly the four resource types and is frozen all the way down', () => {
    expect(Object.keys(SCOPE_MATRIX)).toEqual([...RESOURCE_TYPES]);
    expect(Object.isFrozen(SCOPE_MATRIX)).toBe(true);
    for (const target of RESOURCE_TYPES) {
      expect(Object.isFrozen(SCOPE_MATRIX[target])).toBe(true);
      expect(Object.isFrozen(SCOPE_MATRIX[target].prefix)).toBe(true);
    }
  });

  it('has the limits of FR-B-513: 50 items, 64 code points', () => {
    expect(SCOPE_ITEMS_MAX).toBe(50);
    expect(SCOPE_VALUE_MAX_CODE_POINTS).toBe(64);
  });
});

// ---------------------------------------------------------------------------------------------
describe('normalizeScopeItem accepts every combination of the matrix', () => {
  const combos: ScopeItem[] = [];
  for (const target of RESOURCE_TYPES) {
    const row = SCOPE_MATRIX[target];
    if (row.id) combos.push(byId(target, GUID_A));
    for (const attr of row.prefix) combos.push(prefix(target, attr, 'Sales'));
    if (row.department) combos.push(department(target, 'Finance'));
  }

  it('has 16 combinations in all (3 + 4 + 4 + 5)', () => {
    expect(combos).toHaveLength(3 + 4 + 4 + 5);
  });

  it.each(combos)('returns the canonical item for %j unchanged', (item) => {
    expect(normalizeScopeItem(item)).toEqual({ ok: true, item });
  });
});

describe('normalizeScopeItem normalises', () => {
  it('lower-cases a GUID', () => {
    expect(normalizeScopeItem(byId('group', GUID_A.toUpperCase()))).toEqual({
      ok: true,
      item: byId('group', GUID_A),
    });
  });

  it('NFC-normalises a value', () => {
    const result = normalizeScopeItem(prefix('user', 'displayName', 'Rene\u{301}'));
    expect(result).toEqual({ ok: true, item: prefix('user', 'displayName', 'Ren\u{e9}') });
  });

  it('trims spaces and no-break spaces at both ends, and keeps inner spaces as typed', () => {
    expect(normalizeScopeItem(department('user', '  \u{a0}Sales  Europe\u{3000} '))).toEqual({
      ok: true,
      item: department('user', 'Sales  Europe'),
    });
  });

  it('keeps the case of a value (the comparison folds it; the stored text is what was typed)', () => {
    expect(normalizeScopeItem(prefix('group', 'mail', 'HR-'))).toEqual({
      ok: true,
      item: prefix('group', 'mail', 'HR-'),
    });
  });

  it('accepts 1 to 64 code points, counting an astral character once', () => {
    expect(normalizeScopeItem(department('user', 'a')).ok).toBe(true);
    expect(normalizeScopeItem(department('user', 'a'.repeat(64))).ok).toBe(true);
    expect(normalizeScopeItem(department('user', '\u{1F600}'.repeat(64))).ok).toBe(true);
    expect(normalizeScopeItem(department('user', 'a'.repeat(65)))).toEqual({
      ok: false,
      reason: 'value_length',
    });
    expect(normalizeScopeItem(department('user', '\u{1F600}'.repeat(65)))).toEqual({
      ok: false,
      reason: 'value_length',
    });
  });

  it('counts the length after trimming, not before', () => {
    expect(normalizeScopeItem(department('user', `${' '.repeat(10)}${'a'.repeat(64)}`)).ok).toBe(
      true,
    );
  });

  it('allows the joiners and the variation selectors the organisation name allows', () => {
    expect(normalizeScopeItem(department('user', 'a\u{200d}b\u{200c}c')).ok).toBe(true);
    expect(normalizeScopeItem(department('user', '\u{2764}\u{fe0f} HR')).ok).toBe(true);
  });
});

describe('normalizeScopeItem refuses', () => {
  const reasonOf = (raw: unknown): string => {
    const result = normalizeScopeItem(raw);
    return result.ok ? 'accepted' : result.reason;
  };

  it.each([
    ['an empty value', department('user', ''), 'value_length'],
    ['a value of only spaces', department('user', ' \u{a0} '), 'value_length'],
    ['a NUL', department('user', 'a\u0000b'), 'forbidden_character'],
    ['a tab', department('user', 'a\tb'), 'forbidden_character'],
    ['a line break', department('user', 'a\nb'), 'forbidden_character'],
    ['DEL', department('user', 'a\u007fb'), 'forbidden_character'],
    ['a C1 control', department('user', 'a\u0085b'), 'forbidden_character'],
    ['the line separator', department('user', 'a\u{2028}b'), 'forbidden_character'],
    ['the paragraph separator', department('user', 'a\u{2029}b'), 'forbidden_character'],
    ['a right-to-left override', department('user', 'a\u{202e}b'), 'forbidden_character'],
    ['a bidi isolate', prefix('group', 'displayName', '\u{2066}a'), 'forbidden_character'],
    ['a left-to-right mark', department('user', 'a\u{200e}b'), 'forbidden_character'],
    ['a zero-width space', department('user', 'a\u{200b}b'), 'forbidden_character'],
    ['a soft hyphen', department('user', 'a\u{ad}b'), 'forbidden_character'],
    ['a byte order mark inside', department('user', 'a\u{feff}b'), 'forbidden_character'],
    [
      'a byte order mark at the start (refused, not trimmed)',
      department('user', '\u{feff}a'),
      'forbidden_character',
    ],
    ['a Hangul filler', department('user', 'a\u{3164}b'), 'forbidden_character'],
    ['a tag character', department('user', 'a\u{e0041}b'), 'forbidden_character'],
    ['the blank Braille pattern', department('user', 'a\u{2800}b'), 'forbidden_character'],
    ['an unpaired high surrogate', department('user', 'a\ud800b'), 'forbidden_character'],
    ['an unpaired low surrogate', department('user', 'a\udc00b'), 'forbidden_character'],
    [
      'a value that is not a string',
      { target: 'user', match: { by: 'department', value: 7 } },
      'value_type',
    ],
    ['a missing value', { target: 'user', match: { by: 'department' } }, 'value_type'],
    [
      'an unknown target',
      { target: 'tenant', match: { by: 'department', value: 'a' } },
      'unknown_target',
    ],
    ['a missing target', { match: { by: 'department', value: 'a' } }, 'unknown_target'],
    [
      'a prototype key as target',
      { target: '__proto__', match: { by: 'department', value: 'a' } },
      'unknown_target',
    ],
    [
      'an unknown match kind',
      { target: 'user', match: { by: 'suffix', value: 'a' } },
      'unknown_match',
    ],
    ['a missing match', { target: 'user' }, 'unknown_match'],
    ['a match that is not an object', { target: 'user', match: 'department' }, 'unknown_match'],
    ['an id for a user (users have no id scope)', byId('user', GUID_A), 'match_not_allowed'],
    ['a department for a group', department('group', 'a'), 'match_not_allowed'],
    [
      'a department for a distribution list',
      department('distributionList', 'a'),
      'match_not_allowed',
    ],
    ['an alias prefix for a user', prefix('user', 'alias', 'a'), 'attribute_not_allowed'],
    [
      'an attribute outside the three',
      { target: 'group', match: { by: 'prefix', attr: 'department', value: 'a' } },
      'attribute_not_allowed',
    ],
    [
      'a missing attribute',
      { target: 'group', match: { by: 'prefix', value: 'a' } },
      'attribute_not_allowed',
    ],
    [
      'a prototype key as attribute',
      { target: 'group', match: { by: 'prefix', attr: 'constructor', value: 'a' } },
      'attribute_not_allowed',
    ],
    ['an id that is not a GUID', byId('group', 'not-a-guid'), 'invalid_id'],
    ['an id with braces', byId('group', `{${GUID_A}}`), 'invalid_id'],
    ['an id of 35 characters', byId('group', GUID_A.slice(1)), 'invalid_id'],
    ['an id with a non-hex digit', byId('group', GUID_A.replace('8e0c', '8g0c')), 'invalid_id'],
    ['an id with a trailing space', byId('group', `${GUID_A} `), 'invalid_id'],
    ['an id that is not a string', { target: 'group', match: { by: 'id', id: 7 } }, 'invalid_id'],
    ['an extra key on the item', { ...department('user', 'a'), extra: 1 }, 'unexpected_key'],
    [
      'an extra key on the match',
      { target: 'user', match: { by: 'department', value: 'a', attr: 'mail' } },
      'unexpected_key',
    ],
    ['null', null, 'not_an_object'],
    ['undefined', undefined, 'not_an_object'],
    ['a string', 'user', 'not_an_object'],
    ['an array', [], 'not_an_object'],
  ])('%s', (_label, raw, reason) => {
    expect(reasonOf(raw)).toBe(reason);
  });

  it('never throws, whatever it is given', () => {
    const odd: unknown[] = [
      Symbol('x'),
      () => 1,
      1n,
      NaN,
      new Date(),
      Object.create(null),
      new Proxy({}, { get: () => 'user' }),
    ];
    for (const raw of odd) expect(() => normalizeScopeItem(raw)).not.toThrow();
  });

  it('does not read inherited properties', () => {
    const inherited = Object.create({
      target: 'user',
      match: { by: 'department', value: 'a' },
    }) as unknown;
    expect(reasonOf(inherited)).toBe('unknown_target');
  });
});

// ---------------------------------------------------------------------------------------------
describe('normalizeScopeItems (at most 50 items per assignment)', () => {
  const many = (n: number): ScopeItem[] =>
    Array.from({ length: n }, (_, i) => department('user', `dept-${String(i)}`));

  it('accepts 0 to 50 items, de-duplicated and in canonical order', () => {
    expect(normalizeScopeItems([])).toEqual({ ok: true, items: [] });
    const fifty = normalizeScopeItems(many(50));
    expect(fifty.ok && fifty.items).toHaveLength(50);
  });

  it('refuses 51 items, duplicates included', () => {
    expect(normalizeScopeItems(many(51))).toEqual({
      ok: false,
      reason: 'too_many_items',
      index: null,
    });
    expect(normalizeScopeItems([...many(50), many(1)[0]])).toEqual({
      ok: false,
      reason: 'too_many_items',
      index: null,
    });
  });

  it('refuses a list that is not an array', () => {
    expect(normalizeScopeItems('x')).toEqual({ ok: false, reason: 'not_an_array', index: null });
    expect(normalizeScopeItems(null)).toEqual({ ok: false, reason: 'not_an_array', index: null });
  });

  it('names the index of the first bad item', () => {
    expect(normalizeScopeItems([department('user', 'ok'), byId('user', GUID_A)])).toEqual({
      ok: false,
      reason: 'match_not_allowed',
      index: 1,
    });
  });

  it('drops a duplicate whatever its spelling (order, case of a GUID, Unicode form, case of text)', () => {
    const result = normalizeScopeItems([
      byId('group', GUID_B.toUpperCase()),
      prefix('group', 'displayName', 'HR'),
      byId('group', GUID_B),
      prefix('group', 'displayName', 'hr '),
      prefix('user', 'displayName', 'Rene\u{301}'),
      prefix('user', 'displayName', 'Ren\u{e9}'),
    ]);
    expect(result.ok && result.items).toHaveLength(3);
  });

  it('keeps the same spelling of a duplicate whatever the order it came in', () => {
    const forward = normalizeScopeItems([
      prefix('group', 'mail', 'HR'),
      prefix('group', 'mail', 'hr'),
    ]);
    const backward = normalizeScopeItems([
      prefix('group', 'mail', 'hr'),
      prefix('group', 'mail', 'HR'),
    ]);
    expect(forward).toEqual(backward);
    expect(forward.ok && forward.items).toHaveLength(1);
  });

  it('returns the same list for any order of the same items', () => {
    const items = [byId('group', GUID_B), department('user', 'x'), prefix('contact', 'mail', 'a')];
    const forward = normalizeScopeItems(items);
    const backward = normalizeScopeItems([...items].reverse());
    expect(forward).toEqual(backward);
  });
});

// ---------------------------------------------------------------------------------------------
describe('canonicalScopeKey', () => {
  const a = byId('group', GUID_A);
  const b = prefix('group', 'displayName', 'Sales');
  const c = department('contact', 'Finance');

  it('is the same for any order and any duplication of the same items', () => {
    const key = canonicalScopeKey([a, b, c]);
    expect(canonicalScopeKey([c, b, a])).toBe(key);
    expect(canonicalScopeKey([b, a, c, a, b, b])).toBe(key);
    expect(canonicalScopeKey([a, b, c, a])).toBe(key);
  });

  it('differs for different sets', () => {
    const keys = new Set(
      [[a], [b], [c], [a, b], [a, c], [b, c], [a, b, c], []].map(canonicalScopeKey),
    );
    expect(keys.size).toBe(8);
  });

  it('is the key of the empty list for no scope (an unscoped assignment)', () => {
    expect(canonicalScopeKey([])).toBe('[]');
  });

  it('is the same for the same item in another spelling of its text (case, Unicode form)', () => {
    expect(canonicalScopeKey([prefix('user', 'displayName', 'Ren\u{e9}')])).toBe(
      canonicalScopeKey([prefix('user', 'displayName', 'RENE\u{301}')]),
    );
    expect(canonicalScopeKey([byId('group', GUID_A)])).toBe(
      canonicalScopeKey([byId('group', GUID_A.toUpperCase())]),
    );
  });

  it('keeps the target, the match kind and the attribute apart', () => {
    const base = prefix('group', 'displayName', 'x');
    expect(canonicalScopeKey([base])).not.toBe(
      canonicalScopeKey([prefix('contact', 'displayName', 'x')]),
    );
    expect(canonicalScopeKey([base])).not.toBe(canonicalScopeKey([prefix('group', 'mail', 'x')]));
    expect(canonicalScopeKey([department('user', 'x')])).not.toBe(
      canonicalScopeKey([prefix('user', 'displayName', 'x')]),
    );
  });

  it('cannot be forged by a value that looks like the serialisation', () => {
    const one = canonicalScopeKey([prefix('group', 'displayName', 'a","b')]);
    const two = canonicalScopeKey([
      prefix('group', 'displayName', 'a'),
      prefix('group', 'displayName', 'b'),
    ]);
    expect(one).not.toBe(two);
    expect(scopeItemKey(a)).toBe(canonicalScopeKey([a]).slice(1, -1));
  });

  it('is deterministic text (a JSON array), identical in every run', () => {
    expect(canonicalScopeKey([a])).toBe(`[["group","id","",${JSON.stringify(GUID_A)}]]`);
  });
});

// ---------------------------------------------------------------------------------------------
describe('fold', () => {
  it('is NFC + toLowerCase + final sigma to sigma', () => {
    expect(fold('Rene\u{301}')).toBe('ren\u{e9}');
    expect(fold('HR')).toBe('hr');
    expect(fold('\u{39f}\u{394}\u{39f}\u{3a3}')).toBe('\u{3bf}\u{3b4}\u{3bf}\u{3c3}');
    expect(fold('\u{3bf}\u{3b4}\u{3bf}\u{3c2}')).toBe('\u{3bf}\u{3b4}\u{3bf}\u{3c3}');
  });

  it('removes the one context-dependent case mapping of toLowerCase', () => {
    // '\u{39f}\u{394}\u{39f}\u{3a3}'.toLowerCase() ends in the final sigma, but the same letters followed by more text do not.
    expect('\u{39f}\u{394}\u{39f}\u{3a3}'.toLowerCase()).not.toBe(
      '\u{39f}\u{394}\u{39f}\u{3a3}\u{39f}\u{3a3}'.toLowerCase().slice(0, 4),
    );
    expect(fold('\u{39f}\u{394}\u{39f}\u{3a3}')).toBe(
      fold('\u{39f}\u{394}\u{39f}\u{3a3}\u{39f}\u{3a3}').slice(0, 4),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('matchScope', () => {
  const group = (extra: Partial<ResourceAttrs> = {}): ResourceAttrs => ({
    type: 'group',
    ...extra,
  });
  const user = (extra: Partial<ResourceAttrs> = {}): ResourceAttrs => ({ type: 'user', ...extra });

  describe('the target', () => {
    it('must equal the resource type', () => {
      expect(matchScope(prefix('group', 'displayName', 'a'), group({ displayName: 'abc' }))).toBe(
        true,
      );
      expect(
        matchScope(prefix('group', 'displayName', 'a'), { type: 'contact', displayName: 'abc' }),
      ).toBe(false);
      expect(
        matchScope(prefix('contact', 'displayName', 'a'), {
          type: 'distributionList',
          displayName: 'abc',
        }),
      ).toBe(false);
      expect(
        matchScope(department('user', 'Sales'), { type: 'contact', department: 'Sales' }),
      ).toBe(false);
    });
  });

  describe('by id', () => {
    it('compares lower-case GUIDs', () => {
      expect(matchScope(byId('group', GUID_A), group({ id: GUID_A }))).toBe(true);
      expect(matchScope(byId('group', GUID_A), group({ id: GUID_A.toUpperCase() }))).toBe(true);
      expect(matchScope(byId('group', GUID_A), group({ id: GUID_B }))).toBe(false);
    });

    it('never matches a resource without an id (so it cannot match an object that is about to be created)', () => {
      expect(matchScope(byId('group', GUID_A), group())).toBe(false);
      expect(matchScope(byId('contact', GUID_A), { type: 'contact', displayName: 'x' })).toBe(
        false,
      );
      expect(matchScope(byId('group', GUID_A), group({ id: undefined }))).toBe(false);
      expect(matchScope(byId('group', GUID_A), group({ id: '' }))).toBe(false);
    });

    it('does not match a resource whose id merely contains or starts with the item id', () => {
      expect(matchScope(byId('group', GUID_A), group({ id: `${GUID_A}0` }))).toBe(false);
      expect(matchScope(byId('group', GUID_A), group({ id: GUID_A.slice(0, 35) }))).toBe(false);
    });
  });

  describe('by prefix', () => {
    it('is fold(attribute).startsWith(fold(value)) on the named attribute only', () => {
      const item = prefix('group', 'displayName', 'Sales');
      expect(matchScope(item, group({ displayName: 'Sales Europe' }))).toBe(true);
      expect(matchScope(item, group({ displayName: 'sales' }))).toBe(true);
      expect(matchScope(item, group({ displayName: 'SALES-EU' }))).toBe(true);
      expect(matchScope(item, group({ displayName: 'Europe Sales' }))).toBe(false);
      expect(matchScope(item, group({ displayName: 'Sale' }))).toBe(false);
      expect(
        matchScope(item, group({ displayName: 'x', alias: 'sales', mail: 'sales@example.org' })),
      ).toBe(false);
    });

    it('reads alias and mail when the item names them', () => {
      expect(matchScope(prefix('group', 'alias', 'hr-'), group({ alias: 'HR-Europe' }))).toBe(true);
      expect(
        matchScope(prefix('contact', 'mail', 'info@'), {
          type: 'contact',
          mail: 'Info@Example.org',
        }),
      ).toBe(true);
    });

    it('compares case-insensitively with the final-sigma rule and Unicode normalisation', () => {
      // item typed at the end of a word (final sigma), resource has the word followed by more text
      expect(
        matchScope(
          prefix('group', 'displayName', '\u{39f}\u{394}\u{39f}\u{3a3}'),
          group({ displayName: '\u{39f}\u{394}\u{39f}\u{3a3}\u{39f}\u{3a3}' }),
        ),
      ).toBe(true);
      expect(
        matchScope(
          prefix('group', 'displayName', '\u{3bf}\u{3b4}\u{3bf}\u{3c2}'),
          group({ displayName: '\u{39f}\u{394}\u{39f}\u{3a3}\u{39f}\u{3a3}' }),
        ),
      ).toBe(true);
      expect(
        matchScope(
          prefix('group', 'displayName', '\u{39f}\u{394}\u{39f}\u{3a3}\u{39f}\u{3a3}'),
          group({ displayName: '\u{3bf}\u{3b4}\u{3bf}\u{3c2}' }),
        ),
      ).toBe(false);
      // composed item against a decomposed attribute, and the reverse
      expect(
        matchScope(
          prefix('user', 'displayName', 'Ren\u{e9}'),
          user({ displayName: 'Rene\u{301} Smit' }),
        ),
      ).toBe(true);
      expect(
        matchScope(
          prefix('user', 'displayName', 'Rene\u{301}'),
          user({ displayName: 'Ren\u{e9} Smit' }),
        ),
      ).toBe(true);
      // an unaccented prefix does not match the accented letter
      expect(
        matchScope(prefix('user', 'displayName', 'Rene'), user({ displayName: 'Ren\u{e9} Smit' })),
      ).toBe(false);
    });

    it('fails closed when the attribute is missing, null or empty', () => {
      const item = prefix('group', 'displayName', 'a');
      expect(matchScope(item, group())).toBe(false);
      expect(matchScope(item, group({ displayName: null }))).toBe(false);
      expect(matchScope(item, group({ displayName: undefined }))).toBe(false);
      expect(matchScope(item, group({ displayName: '' }))).toBe(false);
    });

    it('never lets an empty value match everything', () => {
      expect(
        matchScope(prefix('group', 'displayName', ''), group({ displayName: 'anything' })),
      ).toBe(false);
    });
  });

  describe('by department', () => {
    it('is fold equality, not a prefix', () => {
      const item = department('user', 'Sales');
      expect(matchScope(item, user({ department: 'Sales' }))).toBe(true);
      expect(matchScope(item, user({ department: 'SALES' }))).toBe(true);
      expect(matchScope(item, user({ department: 'Sales EU' }))).toBe(false);
      expect(matchScope(item, user({ department: 'Sale' }))).toBe(false);
      expect(matchScope(item, user({ department: 'ale' }))).toBe(false);
    });

    it('fails closed when the department is missing, null or empty', () => {
      const item = department('contact', 'Sales');
      expect(matchScope(item, { type: 'contact' })).toBe(false);
      expect(matchScope(item, { type: 'contact', department: null })).toBe(false);
      expect(matchScope(item, { type: 'contact', department: '' })).toBe(false);
      expect(matchScope(department('contact', ''), { type: 'contact', department: '' })).toBe(
        false,
      );
    });
  });

  describe('an item the matrix does not allow', () => {
    it('never matches, even when the resource has the attribute (the database refuses such a row too)', () => {
      expect(matchScope(byId('user', GUID_A), user({ id: GUID_A }))).toBe(false);
      expect(matchScope(prefix('user', 'alias', 'a'), user({ alias: 'abc' }))).toBe(false);
      expect(matchScope(department('group', 'x'), group({ department: 'x' }))).toBe(false);
      expect(
        matchScope(department('distributionList', 'x'), {
          type: 'distributionList',
          department: 'x',
        }),
      ).toBe(false);
    });

    it('never matches a malformed item and never throws', () => {
      const bad = [
        null,
        {},
        { target: 'group' },
        { target: 'group', match: null },
        { target: 'group', match: { by: 'regex', value: '.*' } },
        { target: 'group', match: { by: 'prefix', attr: 'displayName' } },
        { target: 'group', match: { by: 'prefix', attr: '__proto__', value: 'a' } },
      ];
      for (const item of bad)
        expect(matchScope(item as unknown as ScopeItem, group({ displayName: 'abc' }))).toBe(false);
    });
  });

  it('is pure: it changes neither argument', () => {
    const item = prefix('group', 'displayName', 'Sales');
    const resource = group({ displayName: 'Sales' });
    const before = JSON.stringify([item, resource]);
    matchScope(item, resource);
    expect(JSON.stringify([item, resource])).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------
describe('types', () => {
  it('ScopeItem is the union of the three match kinds', () => {
    expectTypeOf<ScopeItem['target']>().toEqualTypeOf<ResourceType>();
    expectTypeOf<ScopeItem['match']['by']>().toEqualTypeOf<'id' | 'prefix' | 'department'>();
  });
});

// ---------------------------------------------------------------------------------------------
// The agreement of the normaliser and the SQL CHECK of `rbac_assignment_scope` (T-B-232, plan 11.3).
// Source of the table definition: the committed migration when it exists (T-B-011), otherwise the
// design block of data-model.md section 5, with the GUID macro expanded, so the test is not blocked
// before the migration lands.
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, '../../../apps/server/drizzle/0001_phase_b.sql');
const DATA_MODEL = resolve(HERE, '../../../specs/002-phase-b/data-model.md');

const GUID_SQL = (column: string): string =>
  `(length(${column}) = 36 AND ${column} GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')`;

function scopeTableDdl(): { readonly sql: string; readonly source: string } {
  const source = existsSync(MIGRATION) ? MIGRATION : DATA_MODEL;
  const text = readFileSync(source, 'utf8');
  const match = /CREATE TABLE `rbac_assignment_scope` \([\s\S]*?\n\);/.exec(text);
  if (match === null) throw new Error(`no rbac_assignment_scope table in ${source}`);
  const sql = match[0].replace(/GUID\((`[a-z_]+`)\)/g, (_all, column: string) => GUID_SQL(column));
  return { sql, source };
}

// A small seeded generator (mulberry32): the seed is printed with every failure of the property test.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env.RBAC_PROPERTY_SEED ?? 20261011);
const CASES = Math.max(20_000, Number(process.env.RBAC_PROPERTY_CASES ?? 20_000));

const ALPHABET = [
  ...Array.from('abcxyzABCXYZ019 -_.@'),
  '\u{e9}',
  'e\u{301}',
  '\u{130}',
  '\u{df}',
  '\u{3a3}',
  '\u{3c3}',
  '\u{3c2}',
  '\u{39f}',
  '\u{394}',
  '\u{1F600}',
  '\u{a0}',
  '\u{3000}',
  '\u{200d}',
  '\u{fe0f}',
  // refused characters, so the generator reaches the rejection paths too
  '\u0000',
  '\t',
  '\n',
  '\u007f',
  '\u{2028}',
  '\u{202e}',
  '\u{200b}',
  '\u{ad}',
  '\u{feff}',
  '\u{2800}',
  '\u{e0041}',
  '\ud800',
];

/** Independent restatement of the value rules (not a copy of the module's code). */
function valueAccepted(value: string): { ok: true; value: string } | { ok: false } {
  if (/\p{Cs}/u.test(value)) return { ok: false };
  const composed = value.normalize('NFC');
  if (/\p{Cc}/u.test(composed)) return { ok: false };
  if (/[\u{2028}\u{2029}]/u.test(composed)) return { ok: false };
  const invisible = Array.from(composed).some((ch) => {
    if (ch === '\u{200c}' || ch === '\u{200d}') return false;
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return false;
    return /\p{Default_Ignorable_Code_Point}/u.test(ch) || cp === 0x2800;
  });
  if (invisible) return { ok: false };
  const trimmed = composed.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > 64) return { ok: false };
  return { ok: true, value: trimmed };
}

type Normalizer = (raw: unknown) => ScopeItemResult;

/**
 * The property: runs `cases` seeded random inputs through `normalize` and a real SQLite table built
 * from the CHECK of `rbac_assignment_scope`. Returns every disagreement found (empty when all agree).
 */
async function agreementFailures(
  normalize: Normalizer,
  cases: number,
  seed: number,
): Promise<{ failures: string[]; accepted: number; source: string }> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  const { sql, source } = scopeTableDdl();
  db.exec(sql);
  const insert = db.prepare(
    'INSERT INTO rbac_assignment_scope (assignment_id, position, target, match_by, attr, value) VALUES (?, 0, ?, ?, ?, ?)',
  );
  const wipe = db.prepare('DELETE FROM rbac_assignment_scope');
  const sqlAccepts = (item: ScopeItem): boolean => {
    const attr = item.match.by === 'prefix' ? item.match.attr : '';
    const value = item.match.by === 'id' ? item.match.id : item.match.value;
    try {
      insert.run(GUID_A, item.target, item.match.by, attr, value);
      wipe.run();
      return true;
    } catch {
      return false;
    }
  };

  const random = mulberry32(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const text = (): string => {
    const length =
      Math.floor(random() * 4) === 0 ? Math.floor(random() * 80) : Math.floor(random() * 12);
    let out = '';
    for (let i = 0; i < length; i += 1) out += pick(ALPHABET);
    return out;
  };
  const guid = (): string => {
    const hex = (n: number): string =>
      Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('');
    const value = `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
    return random() < 0.5 ? value : value.toUpperCase();
  };

  const failures: string[] = [];
  let accepted = 0;
  for (let n = 0; n < cases && failures.length <= 5; n += 1) {
    const target = random() < 0.03 ? 'tenant' : pick(RESOURCE_TYPES);
    const by = random() < 0.03 ? 'suffix' : pick(['id', 'prefix', 'department'] as const);
    const attr = random() < 0.05 ? 'department' : pick(['displayName', 'alias', 'mail'] as const);
    const raw =
      by === 'id'
        ? { target, match: { by, id: random() < 0.1 ? text() : guid() } }
        : by === 'prefix'
          ? { target, match: { by, attr, value: text() } }
          : { target, match: { by, value: text() } };

    const result = normalize(raw);
    const row = (SCOPE_MATRIX as Record<string, (typeof SCOPE_MATRIX)[ResourceType] | undefined>)[
      target
    ];
    const matrixAllows =
      row !== undefined &&
      (by === 'id'
        ? row.id
        : by === 'department'
          ? row.department
          : by === 'prefix' && (row.prefix as readonly string[]).includes(attr));

    // The expected verdict, from the independent restatement.
    let expectOk = false;
    let expectedValue: string | undefined;
    if (matrixAllows) {
      if (by === 'id') {
        const id = (raw.match as { id: string }).id;
        expectOk =
          /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
        expectedValue = id.toLowerCase();
      } else {
        const v = valueAccepted((raw.match as { value: string }).value);
        expectOk = v.ok;
        if (v.ok) expectedValue = v.value;
      }
    }
    if (result.ok !== expectOk) {
      failures.push(
        `#${String(n)} ${JSON.stringify(raw)}: normaliser said ${String(result.ok)}, expected ${String(expectOk)}`,
      );
    } else if (result.ok) {
      accepted += 1;
      const out = result.item;
      const outValue = out.match.by === 'id' ? out.match.id : out.match.value;
      if (outValue !== expectedValue)
        failures.push(
          `#${String(n)} value ${JSON.stringify(outValue)} != ${JSON.stringify(expectedValue)}`,
        );
      if (!sqlAccepts(out))
        failures.push(
          `#${String(n)} the CHECK refused an item the normaliser accepted: ${JSON.stringify(out)}`,
        );
      const again = normalize(out);
      if (!again.ok || JSON.stringify(again.item) !== JSON.stringify(out))
        failures.push(`#${String(n)} not idempotent: ${JSON.stringify(out)}`);
    }
  }

  // The other direction: every combination of target x match kind x attribute, with a valid value.
  for (const target of RESOURCE_TYPES) {
    const row = SCOPE_MATRIX[target];
    const combos: { item: ScopeItem; allowed: boolean }[] = [
      { item: byId(target, GUID_A), allowed: row.id },
      { item: department(target, 'Sales'), allowed: row.department },
      ...(['displayName', 'alias', 'mail'] as const).map((attr) => ({
        item: prefix(target, attr, 'Sales'),
        allowed: (row.prefix as readonly string[]).includes(attr),
      })),
    ];
    for (const { item, allowed } of combos) {
      if (sqlAccepts(item) !== allowed)
        failures.push(`the CHECK ${allowed ? 'refuses' : 'accepts'} ${JSON.stringify(item)}`);
      if (normalize(item).ok !== allowed)
        failures.push(`the normaliser ${allowed ? 'refuses' : 'accepts'} ${JSON.stringify(item)}`);
    }
  }
  db.close();
  return { failures, accepted, source };
}

describe('property: the normaliser and the SQL CHECK of rbac_assignment_scope agree', () => {
  it(`${String(CASES)} seeded cases (seed ${String(SEED)}): every accepted item inserts, every disallowed combination is refused by both`, async () => {
    const { failures, accepted, source } = await agreementFailures(normalizeScopeItem, CASES, SEED);
    expect(failures, `seed ${String(SEED)}, table from ${source}`).toEqual([]);
    expect(
      accepted,
      `seed ${String(SEED)}: the generator must reach the accept path`,
    ).toBeGreaterThan(CASES / 20);
  });

  it('fails for a normaliser that accepts a combination the matrix refuses (negative)', async () => {
    const lax: Normalizer = (raw) => {
      const strict = normalizeScopeItem(raw);
      // user + alias slips through: the SQL CHECK refuses the row the normaliser let in
      const r = raw as {
        target?: unknown;
        match?: { by?: unknown; attr?: unknown; value?: unknown };
      };
      if (
        r.target === 'user' &&
        r.match?.by === 'prefix' &&
        r.match.attr === 'alias' &&
        typeof r.match.value === 'string' &&
        r.match.value.length > 0 &&
        r.match.value.length < 10
      )
        return { ok: true, item: raw as ScopeItem };
      return strict;
    };
    const { failures } = await agreementFailures(lax, 2_000, SEED);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join('\n')).toMatch(/user.*alias|normaliser said true, expected false/s);
  });

  it('fails for a normaliser that forgets to trim (negative: the value differs from the independent rule)', async () => {
    const sloppy: Normalizer = (raw) => {
      const result = normalizeScopeItem(raw);
      const r = raw as { match?: { value?: unknown } };
      if (result.ok && result.item.match.by !== 'id' && typeof r.match?.value === 'string') {
        const m = result.item.match;
        return {
          ok: true,
          item: {
            ...result.item,
            match: { ...m, value: r.match.value.normalize('NFC') },
          },
        };
      }
      return result;
    };
    const { failures } = await agreementFailures(sloppy, 5_000, SEED);
    expect(failures.length).toBeGreaterThan(0);
  });

  it('is a guard: a disagreement makes the check throw (expectGuardFails)', async () => {
    const lax: Normalizer = () => ({ ok: true, item: byId('user', GUID_A) });
    const { failures } = await agreementFailures(lax, 500, SEED);
    expectGuardFails(
      () => {
        if (failures.length > 0) throw new Error(`disagreement: ${failures[0] ?? ''}`);
      },
      undefined,
      { reason: 'disagreement' },
    );
  });
});
