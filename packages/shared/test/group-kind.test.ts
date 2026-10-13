// T-C-003, FR-C-303, R-C-04: ONE function derives the kind of a group, from exactly three properties
// (`groupTypes`, `mailEnabled`, `securityEnabled`). The server mapper and the web both use it; the
// test is exhaustive over the combinations that Graph can return plus `null` for every property, and
// it compares the function with a reference written out as a table (not as code), so the function
// and the table cannot drift together unseen.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROUP_KINDS,
  READ_ONLY_GROUP_KINDS,
  groupKindOf,
  isReadOnlyGroupKind,
  membershipTypeOf,
  type GroupKind,
  type GroupKindInput,
} from '../src/directory/group-kind.js';
import { expectGuardFails } from '../src/testing/index.js';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

type Tri = boolean | null;

/** R-C-04, row by row: [groupTypes, mailEnabled, securityEnabled, kind]. `Unified` is Microsoft 365. */
const R_C_04: readonly (readonly [readonly string[], boolean, boolean, GroupKind])[] = [
  [['Unified'], true, true, 'm365'],
  [['Unified'], true, false, 'm365'],
  [[], false, true, 'security'],
  [[], true, true, 'mailsecurity'],
  [[], true, false, 'distribution'],
  // A dynamic security group lists `DynamicMembership` in groupTypes; it is a security group all the same.
  [['DynamicMembership'], false, true, 'security'],
  // A dynamic Microsoft 365 group lists both values.
  [['Unified', 'DynamicMembership'], true, false, 'm365'],
];

describe('groupKindOf: the table of R-C-04', () => {
  it.each(R_C_04)(
    'groupTypes %j, mailEnabled %s, securityEnabled %s is %s',
    (types, mail, sec, kind) => {
      expect(groupKindOf({ groupTypes: types, mailEnabled: mail, securityEnabled: sec })).toBe(
        kind,
      );
    },
  );

  it('equals the table of the research file, row by row', () => {
    const research = read('../../../specs/003-phase-c/research-microsoft-c.md');
    const section = /^## R-C-04 Group types([\s\S]*?)^## R-C-05/m.exec(research)?.[1] ?? '';
    const rows = [...section.matchAll(/^\| ([^|]+) \| `(\[[^`]*\])` \| (\w+) \| ([\w ]+) \|/gm)];
    expect(rows).toHaveLength(4);
    const kindOfLabel: Record<string, GroupKind> = {
      Microsoft: 'm365',
      Security: 'security',
      'Mail-enabled': 'mailsecurity',
      Distribution: 'distribution',
    };
    for (const row of rows) {
      const label = (row[1] ?? '').trim();
      const kind = kindOfLabel[label.split(' ')[0] ?? ''];
      expect(kind, label).toBeDefined();
      const types = JSON.parse(row[2] ?? '[]') as string[];
      const mail = row[3] === 'true';
      const securities =
        (row[4] ?? '').trim() === 'true or false' ? [true, false] : [row[4]?.trim() === 'true'];
      for (const sec of securities) {
        expect(
          groupKindOf({ groupTypes: types, mailEnabled: mail, securityEnabled: sec }),
          label,
        ).toBe(kind);
      }
    }
  });
});

describe('groupKindOf: exhaustive over groupTypes x mailEnabled x securityEnabled x null', () => {
  const TYPES: readonly (readonly string[] | null)[] = [
    null,
    [],
    ['Unified'],
    ['DynamicMembership'],
    ['Unified', 'DynamicMembership'],
    ['SomethingNew'],
    ['unified'],
  ];
  const TRI: readonly Tri[] = [true, false, null];

  /** The expectation, written as a decision table and not as the function's own logic. */
  function reference(types: readonly string[] | null, mail: Tri, sec: Tri): GroupKind {
    if (types === null || mail === null || sec === null) return 'unknown';
    const unified = types.includes('Unified');
    if (unified) return 'm365';
    if (!mail && sec) return 'security';
    if (mail && sec) return 'mailsecurity';
    if (mail && !sec) return 'distribution';
    return 'unknown'; // neither mail nor security: not a group kind of R-C-04
  }

  it('covers 63 combinations', () => {
    expect(TYPES.length * TRI.length * TRI.length).toBe(63);
  });

  it.each(
    TYPES.flatMap((types) => TRI.flatMap((mail) => TRI.map((sec) => [types, mail, sec] as const))),
  )('groupTypes %j, mailEnabled %s, securityEnabled %s', (types, mail, sec) => {
    const input: GroupKindInput = { groupTypes: types, mailEnabled: mail, securityEnabled: sec };
    expect(groupKindOf(input)).toBe(reference(types, mail, sec));
  });

  it('gives unknown when ANY of the three properties is null (U36), also for a Microsoft 365 group', () => {
    expect(groupKindOf({ groupTypes: null, mailEnabled: true, securityEnabled: false })).toBe(
      'unknown',
    );
    expect(groupKindOf({ groupTypes: ['Unified'], mailEnabled: null, securityEnabled: true })).toBe(
      'unknown',
    );
    expect(groupKindOf({ groupTypes: ['Unified'], mailEnabled: true, securityEnabled: null })).toBe(
      'unknown',
    );
    expect(groupKindOf({ groupTypes: [], mailEnabled: null, securityEnabled: null })).toBe(
      'unknown',
    );
  });

  it('compares Unified exactly: another case or a prefix is not Microsoft 365', () => {
    expect(
      groupKindOf({ groupTypes: ['unified'], mailEnabled: true, securityEnabled: false }),
    ).toBe('distribution');
    expect(
      groupKindOf({ groupTypes: ['UnifiedX'], mailEnabled: true, securityEnabled: false }),
    ).toBe('distribution');
  });

  it('treats a value that is not what Graph sends as unknown, never as an exception or a guess', () => {
    const bad = [
      { groupTypes: 'Unified', mailEnabled: true, securityEnabled: true },
      { groupTypes: [1], mailEnabled: true, securityEnabled: true },
      { groupTypes: [], mailEnabled: 'true', securityEnabled: false },
      { groupTypes: [], mailEnabled: true, securityEnabled: 1 },
      { groupTypes: undefined, mailEnabled: true, securityEnabled: true },
      {},
    ];
    for (const input of bad) {
      expect(groupKindOf(input as unknown as GroupKindInput), JSON.stringify(input)).toBe(
        'unknown',
      );
    }
  });

  it('is pure: it does not change its input', () => {
    const input = Object.freeze({
      groupTypes: Object.freeze(['Unified']),
      mailEnabled: true,
      securityEnabled: false,
    });
    expect(groupKindOf(input)).toBe('m365');
  });
});

describe('GROUP_KINDS, READ_ONLY_GROUP_KINDS, membershipTypeOf', () => {
  it('lists the four kinds and unknown, once, in the order the filter and the badges use', () => {
    expect([...GROUP_KINDS]).toEqual([
      'm365',
      'security',
      'mailsecurity',
      'distribution',
      'unknown',
    ]);
    expect(Object.isFrozen(GROUP_KINDS)).toBe(true);
  });

  it('marks exactly mail-enabled security and distribution as read-only in Microsoft Graph (R-C-04)', () => {
    expect([...READ_ONLY_GROUP_KINDS]).toEqual(['mailsecurity', 'distribution']);
    for (const kind of GROUP_KINDS) {
      expect(isReadOnlyGroupKind(kind), kind).toBe(
        kind === 'mailsecurity' || kind === 'distribution',
      );
    }
  });

  it('derives assigned or dynamic from groupTypes (FR-C-304); null stays null', () => {
    expect(membershipTypeOf([])).toBe('assigned');
    expect(membershipTypeOf(['Unified'])).toBe('assigned');
    expect(membershipTypeOf(['DynamicMembership'])).toBe('dynamic');
    expect(membershipTypeOf(['Unified', 'DynamicMembership'])).toBe('dynamic');
    expect(membershipTypeOf(null)).toBeNull();
    expect(membershipTypeOf('DynamicMembership' as unknown as readonly string[])).toBeNull();
  });
});

describe('the kind guard (negative fixtures)', () => {
  /** A guard that throws unless a candidate derivation gives the table's answer for every row. */
  function assertTable(candidate: (input: GroupKindInput) => GroupKind): void {
    const problems: string[] = [];
    for (const [types, mail, sec, kind] of R_C_04) {
      const actual = candidate({ groupTypes: types, mailEnabled: mail, securityEnabled: sec });
      if (actual !== kind)
        problems.push(
          `${JSON.stringify(types)} ${String(mail)} ${String(sec)} gave ${actual}, R-C-04 says ${kind}`,
        );
    }
    for (const nullInput of [
      { groupTypes: null, mailEnabled: true, securityEnabled: true },
      { groupTypes: [], mailEnabled: null, securityEnabled: true },
      { groupTypes: [], mailEnabled: true, securityEnabled: null },
    ] satisfies GroupKindInput[]) {
      if (candidate(nullInput) !== 'unknown')
        problems.push(`a null property did not give unknown: ${JSON.stringify(nullInput)}`);
    }
    if (problems.length > 0)
      throw new Error(`kind derivation differs from R-C-04: ${problems.join('; ')}`);
  }

  it('passes for the real function', () => {
    expect(() => {
      assertTable(groupKindOf);
    }).not.toThrow();
  });

  it('fails for a derivation that swaps mail-enabled security and distribution', () => {
    expectGuardFails(
      assertTable,
      (input: GroupKindInput): GroupKind => {
        const kind = groupKindOf(input);
        if (kind === 'mailsecurity') return 'distribution';
        if (kind === 'distribution') return 'mailsecurity';
        return kind;
      },
      { reason: 'R-C-04 says' },
    );
  });

  it('fails for a derivation that treats a null property as false (the U36 trap)', () => {
    expectGuardFails(
      assertTable,
      (input: GroupKindInput): GroupKind =>
        groupKindOf({
          groupTypes: input.groupTypes ?? [],
          mailEnabled: input.mailEnabled ?? false,
          securityEnabled: input.securityEnabled ?? false,
        }),
      { reason: 'a null property did not give unknown' },
    );
  });

  it('fails for a derivation that ignores groupTypes', () => {
    expectGuardFails(
      assertTable,
      (input: GroupKindInput): GroupKind =>
        groupKindOf({ ...input, groupTypes: input.groupTypes === null ? null : [] }),
      { reason: 'gave' },
    );
  });
});
