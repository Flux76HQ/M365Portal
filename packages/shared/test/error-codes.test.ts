// T-A-022, contract C2, FR-A-022, FR-A-112 (TA-03): the problem registry and its messages.
//
// Three things are held together here:
//   - the registry (`PROBLEM_CODES`) equals the codes and statuses of the Phase A contract section 6
//     and spec section 6.4 (34 codes) plus the 19 codes of Phase B spec section 6.9.5 (T-B-005);
//     the documents are read, so a document that changes without the registry fails;
//   - every code has a user-facing message in both languages in the `problem` fragments, and the
//     fragments hold nothing else, so no code ships without a Dutch and an English text;
//   - the English `title` and `detail` strings are generic and never sensitive.
// Each guard has a negative fixture (tasks.md section 0.3).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PROBLEM_CODES,
  ProblemCodeSchema,
  ProblemFieldErrorSchema,
  ProblemSchema,
  isProblemCode,
  problemMessageKey,
  problemType,
  type ProblemCode,
} from '../src/problem.js';
import { expectGuardFails } from '../src/testing/index.js';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

const readFragment = (language: 'en' | 'nl'): Record<string, string> =>
  JSON.parse(read(`../src/i18n/fragments/problem.${language}.json`)) as Record<string, string>;

/** Contract section 6, in its order: the 34 codes with their status. */
const CONTRACT_6: readonly (readonly [string, number])[] = [
  ['permission_denied', 403],
  ['origin_not_allowed', 403],
  ['csrf_invalid', 403],
  ['not_found', 404],
  ['method_not_allowed', 405],
  ['branding_conflict', 412],
  ['payload_too_large', 413],
  ['unsupported_media_type', 415],
  ['image_type_unsupported', 415],
  ['validation_failed', 422],
  ['accent_invalid', 422],
  ['org_name_invalid', 422],
  ['asset_unknown', 422],
  ['image_corrupt', 422],
  ['image_pixels_exceeded', 422],
  ['image_empty', 422],
  ['image_processing_timeout', 422],
  ['svg_not_wellformed', 422],
  ['svg_doctype_forbidden', 422],
  ['svg_text_unsupported', 422],
  ['svg_too_complex', 422],
  ['import_invalid', 422],
  ['import_unsupported_version', 422],
  ['precondition_required', 428],
  ['rate_limited', 429],
  ['image_processing_busy', 429],
  ['staging_quota_exceeded', 409],
  ['internal_error', 500],
  ['storage_unavailable', 503],
  ['storage_busy', 503],
  ['shutting_down', 503],
  ['bad_request', 400],
  ['request_timeout', 408],
  ['request_header_fields_too_large', 431],
];

/**
 * Phase B spec 6.9.5, in its order: the 19 codes added by Phase B (T-B-005). `permission_denied`
 * (Phase A) now covers a missing permission, a scope mismatch and a wrong actor kind alike.
 */
const SPEC_B_6_9_5: readonly (readonly [string, number])[] = [
  ['unauthenticated', 401],
  ['session_expired', 401],
  ['step_up_required', 403],
  ['escalation_denied', 403],
  ['last_owner_protected', 409],
  ['setup_token_invalid', 401],
  ['setup_token_locked', 429],
  ['setup_step_busy', 409],
  ['setup_step_not_ready', 409],
  ['setup_required', 409],
  ['secrets_unavailable', 503],
  ['policy_not_applied', 500],
  ['principal_unknown', 422],
  ['assignment_exists', 409],
  ['assignment_invalid', 422],
  ['break_glass_locked', 429],
  ['graph_unavailable', 503],
  ['graph_throttled', 503],
  ['tenant_mismatch', 409],
];

/** Phase C spec 6.7.3 (T-C-002), in its order: the one code Phase C adds. */
const SPEC_C_6_7_3: readonly (readonly [string, number])[] = [['cursor_invalid', 400]];

/** Phase A, Phase B and Phase C together: the complete registry. */
const ALL_CODES: readonly (readonly [string, number])[] = [
  ...CONTRACT_6,
  ...SPEC_B_6_9_5,
  ...SPEC_C_6_7_3,
];

const CODES = Object.keys(PROBLEM_CODES) as ProblemCode[];

/** A copy of `value` without the member `key`. */
const without = (value: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

describe('PROBLEM_CODES: the registry', () => {
  it('holds the 34 codes of the Phase A contract section 6, with their status, and the 19 of Phase B', () => {
    expect(CONTRACT_6).toHaveLength(34);
    expect(SPEC_B_6_9_5).toHaveLength(19);
    const actual = Object.entries(PROBLEM_CODES).map(([code, entry]) => [code, entry.status]);
    for (const row of CONTRACT_6) expect(actual, row[0]).toContainEqual([...row]);
    expect(actual.sort()).toEqual([...ALL_CODES].sort());
    expect(CODES).toHaveLength(54);
  });

  it('equals the table of Phase C spec 6.7.3 as the document states it, and answers cursor_invalid with 400', () => {
    const spec = read('../../../specs/003-phase-c/spec.md');
    const section = /^#### 6\.7\.3 Problem codes added([\s\S]*?)^---/m.exec(spec)?.[1] ?? '';
    const rows = [...section.matchAll(/^\| `([a-z_]+)` \| (\d{3}) \|/gm)].map((match) => [
      match[1],
      Number(match[2]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows.sort()).toEqual([...SPEC_C_6_7_3].sort());
    expect(PROBLEM_CODES.cursor_invalid.status).toBe(400);
  });

  it('keeps the Phase C code out of the earlier tables, and every code of the registry in exactly one table', () => {
    const named = [...CONTRACT_6, ...SPEC_B_6_9_5, ...SPEC_C_6_7_3].map(([code]) => code);
    expect(new Set(named).size).toBe(named.length);
    expect(CONTRACT_6.some(([code]) => code === 'cursor_invalid')).toBe(false);
    expect(SPEC_B_6_9_5.some(([code]) => code === 'cursor_invalid')).toBe(false);
  });

  it("says in plain English that the cursor is unknown, expired or not the caller's (generic, no cursor value)", () => {
    const { title, detail } = PROBLEM_CODES.cursor_invalid;
    expect(title).toBe('Invalid list cursor');
    expect(detail).toMatch(/cursor/i);
    expect(detail).toMatch(/expired|unknown/i);
  });

  it('equals the table of Phase B spec 6.9.5 as the document states it', () => {
    const spec = read('../../../specs/002-phase-b/spec.md');
    const section =
      /^\*\*Problem codes added by Phase B\*\*([\s\S]*?)^\*\*Wizard result codes\*\*/m.exec(
        spec,
      )?.[1] ?? '';
    const rows = [...section.matchAll(/^\| `([a-z_]+)` \| (\d{3}) \|/gm)].map((match) => [
      match[1],
      Number(match[2]),
    ]);
    expect(rows).toHaveLength(19);
    expect(rows.sort()).toEqual([...SPEC_B_6_9_5].sort());
  });

  it('answers the Phase B codes with the statuses and Retry-After rules of spec 6.9.5', () => {
    for (const [code, status] of SPEC_B_6_9_5) {
      expect(PROBLEM_CODES[code as ProblemCode].status, code).toBe(status);
    }
    // 401 carries WWW-Authenticate (FR-B-414) and 429 / graph_* carry Retry-After: the server adds
    // the headers; the registry only has to hold the right status for each.
    expect(PROBLEM_CODES.unauthenticated.status).toBe(401);
    expect(PROBLEM_CODES.setup_token_locked.status).toBe(429);
    expect(PROBLEM_CODES.break_glass_locked.status).toBe(429);
  });

  it('says that permission_denied covers a missing permission, a scope mismatch and a wrong actor kind', () => {
    const { title, detail } = PROBLEM_CODES.permission_denied;
    expect(`${title} ${detail}`).toMatch(/permission/i);
    expect(detail).toMatch(/scope/i);
    expect(detail).toMatch(/actor/i);
  });

  it('fails the registry guard when a Phase B code is missing or has the wrong status (negative fixture)', () => {
    const guard = (actual: readonly (readonly [string, number])[]): void => {
      const wanted = JSON.stringify([...ALL_CODES].sort());
      if (JSON.stringify([...actual].sort()) !== wanted) {
        throw new Error('registry differs from the Phase A and Phase B documents');
      }
    };
    const actual = Object.entries(PROBLEM_CODES).map(
      ([code, entry]) => [code, entry.status] as const,
    );
    expect(() => {
      guard(actual);
    }).not.toThrow();
    expectGuardFails(
      guard,
      actual.filter(([code]) => code !== 'tenant_mismatch'),
      {
        reason: 'registry differs',
      },
    );
    expectGuardFails(
      guard,
      actual.map(([code, status]) => [code, code === 'session_expired' ? 403 : status] as const),
      { reason: 'registry differs' },
    );
  });

  it('includes the three codes of the Node parser errors (amendment): bad_request 400, request_timeout 408, request_header_fields_too_large 431', () => {
    expect(PROBLEM_CODES.bad_request.status).toBe(400);
    expect(PROBLEM_CODES.request_timeout.status).toBe(408);
    expect(PROBLEM_CODES.request_header_fields_too_large.status).toBe(431);
  });

  it('includes the two codes the plan added: staging_quota_exceeded 409 and shutting_down 503', () => {
    expect(PROBLEM_CODES.staging_quota_exceeded.status).toBe(409);
    expect(PROBLEM_CODES.shutting_down.status).toBe(503);
  });

  it('equals the table of contract section 6 as the document states it', () => {
    const contract = read('../../../specs/001-m365portal/contracts/phase-a-api.md');
    const section = /^## 6\. Problem codes$([\s\S]*?)^## 7\./m.exec(contract)?.[1] ?? '';
    const rows = [...section.matchAll(/^\| `([a-z_]+)`(?: \(\*\*new\*\*\))? \| (\d{3}) \|/gm)].map(
      (match) => [match[1], Number(match[2])],
    );
    expect(rows).toHaveLength(34);
    expect(rows.sort()).toEqual([...CONTRACT_6].sort());
  });

  it('equals the list of spec section 6.4 as the document states it', () => {
    const spec = read('../../../specs/001-m365portal/spec.md');
    const section =
      /^### 6\.4 Problem code registry[^\n]*\n([\s\S]*?)^### 6\.5/m.exec(spec)?.[1] ?? '';
    const registryParagraph = /Stable machine codes[^\n]*\n\n([^\n]+)/.exec(section)?.[1] ?? '';
    const rows = [...registryParagraph.matchAll(/`([a-z_]+)` \((\d{3})\)/g)].map((match) => [
      match[1],
      Number(match[2]),
    ]);
    expect(rows).toHaveLength(34);
    expect(rows.sort()).toEqual([...CONTRACT_6].sort());
  });

  it('uses status codes of the 4xx and 5xx classes only', () => {
    for (const [code, entry] of Object.entries(PROBLEM_CODES)) {
      expect(entry.status, code).toBeGreaterThanOrEqual(400);
      expect(entry.status, code).toBeLessThan(600);
    }
  });

  it('spells every code in snake case', () => {
    for (const code of CODES) expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(PROBLEM_CODES)).toBe(true);
    expect(Object.isFrozen(PROBLEM_CODES.rate_limited)).toBe(true);
    expect(() => {
      (PROBLEM_CODES.rate_limited as { status: number }).status = 200;
    }).toThrow(TypeError);
  });

  it('has a different English title for every code', () => {
    const titles = CODES.map((code) => PROBLEM_CODES[code].title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

/** The guard behind the `title` and `detail` rule: generic, English, never sensitive. */
function assertGenericEnglish(text: string): void {
  const problems: string[] = [];
  if (text.trim() !== text || text === '') problems.push('empty or padded with whitespace');
  if (!/^[\x20-\x7e]+$/.test(text)) problems.push('not plain ASCII English');
  if (text.length > 160) problems.push('longer than 160 characters');
  const sensitive: readonly [string, RegExp][] = [
    ['a SQLite error', /sqlite/i],
    ['a stack frame', /\bat\s+\S+\s*\(|\bstack\b|\btrace\b/i],
    ['a file path', /(?:^|[\s(])(?:\/|[a-z]:\\)(?:data|tmp|app|home|etc|usr|var|users)\b/i],
    ['a source file', /\.(?:ts|js|mjs|cjs|sql|db|sqlite)\b|node_modules/i],
    ['a secret word', /secret|password|credential|api[ _-]?key/i],
    ['an IP address', /\b\d{1,3}(?:\.\d{1,3}){3}\b/],
    ['an e-mail address', /\S+@\S+\.\S+/],
    ['an error class name', /\b[A-Z][A-Za-z]*(?:Error|Exception)\b/],
  ];
  for (const [what, pattern] of sensitive)
    if (pattern.test(text)) problems.push(`contains ${what}`);
  if (problems.length > 0) throw new Error(`not generic: ${problems.join('; ')}: "${text}"`);
}

describe('title and detail: generic English, never sensitive (FR-A-022, FR-A-023)', () => {
  it.each(CODES)('%s: title and detail are generic', (code) => {
    const { title, detail } = PROBLEM_CODES[code];
    expect(() => {
      assertGenericEnglish(title);
    }).not.toThrow();
    expect(() => {
      assertGenericEnglish(detail);
    }).not.toThrow();
    expect(detail, code).toMatch(/\.$/);
    expect(title, code).not.toMatch(/\.$/);
  });

  it('the origin_not_allowed detail names the variable PUBLIC_BASE_URL (FR-A-016)', () => {
    expect(PROBLEM_CODES.origin_not_allowed.detail).toContain('PUBLIC_BASE_URL');
  });

  it('the guard fails on sensitive or non-English text (negative fixtures)', () => {
    const sensitiveSamples = [
      'SQLITE_BUSY: database is locked.',
      'Error at Object.<anonymous> (/app/dist/index.js:12:5).',
      'Cannot open /data/m365portal.db.',
      'Failed to read /tmp/upload-1.png.',
      'The secret was rejected.',
      'Connection from 192.168.1.10 refused.',
      'Cannot find module node_modules/hono.',
      'TypeError: x is not a function.',
      'Het verzoek is niet gelukt én dat is jammer.',
      ' padded ',
      '',
      'x'.repeat(161),
    ];
    for (const sample of sensitiveSamples) {
      expectGuardFails(assertGenericEnglish, sample, { reason: 'not generic' });
    }
  });
});

describe('problemType, problemMessageKey, isProblemCode', () => {
  it.each(CODES)('%s: the type is a URN and the message key is problem.<code>', (code) => {
    expect(problemType(code)).toBe(`urn:m365portal:problem:${code}`);
    expect(problemMessageKey(code)).toBe(`problem.${code}`);
    expect(isProblemCode(code)).toBe(true);
  });

  it.each([
    ['a code the registry does not know', 'brand_new_code'],
    ['the empty string', ''],
    ['a prototype property', 'constructor'],
    ['another prototype property', 'toString'],
    ['a proto key', '__proto__'],
    ['the wrong case', 'PERMISSION_DENIED'],
    ['a trailing space', 'not_found '],
    ['the unknown key itself', 'unknown'],
  ])('an unknown code resolves to problem.unknown: %s', (_label, code) => {
    expect(problemMessageKey(code)).toBe('problem.unknown');
    expect(isProblemCode(code)).toBe(false);
  });

  it('ProblemCodeSchema accepts the registry and nothing else', () => {
    for (const code of CODES) expect(ProblemCodeSchema.safeParse(code).success, code).toBe(true);
    for (const code of ['', 'unknown', 'constructor', 'Not_Found'])
      expect(ProblemCodeSchema.safeParse(code).success, code).toBe(false);
    expect(ProblemCodeSchema.meta()?.id).toBe('ProblemCode');
  });
});

describe('ProblemSchema (RFC 9457 plus code, requestId, errors[], expectedOrigin)', () => {
  const requestId = '0b8d3f9c-5f0e-4c7e-9a7e-6d2d3f8a1b2c';
  const problemFor = (code: ProblemCode): Record<string, unknown> => ({
    type: problemType(code),
    title: PROBLEM_CODES[code].title,
    status: PROBLEM_CODES[code].status,
    detail: PROBLEM_CODES[code].detail,
    code,
    requestId,
  });
  const valid = (value: unknown): boolean => ProblemSchema.safeParse(value).success;

  it.each(CODES)('accepts the body for %s, built from the registry', (code) => {
    const body =
      code === 'origin_not_allowed'
        ? { ...problemFor(code), expectedOrigin: 'http://localhost:9300' }
        : problemFor(code);
    expect(valid(body)).toBe(true);
  });

  it('accepts the example of contract section 7 (branding_conflict)', () => {
    expect(
      valid({
        type: 'urn:m365portal:problem:branding_conflict',
        title: 'Branding was changed by someone else',
        status: 412,
        detail: 'The branding revision does not match If-Match.',
        code: 'branding_conflict',
        requestId: '0b8d3f9c-5f0e-4c7e-9a7e-6d2d3f8a1b2c',
      }),
    ).toBe(true);
  });

  it('accepts errors[] with pointers into the body, the query and the headers', () => {
    const body = {
      ...problemFor('validation_failed'),
      errors: [
        { pointer: '/accent', code: 'accent_invalid' },
        { pointer: '/logos/light', code: 'asset_unknown' },
        { pointer: 'query/slot', code: 'invalid_value' },
        { pointer: 'header/If-Match', code: 'invalid_format' },
        { pointer: '', code: 'invalid_type' },
      ],
    };
    expect(valid(body)).toBe(true);
  });

  it('accepts the RFC 9457 member instance', () => {
    expect(valid({ ...problemFor('not_found'), instance: '/api/v1/nothing' })).toBe(true);
  });

  it('accepts a code this version does not know (a newer server): the UI shows problem.unknown', () => {
    const body = {
      type: 'urn:m365portal:problem:brand_new_code',
      title: 'Something new',
      status: 418,
      detail: 'A newer server sent this.',
      code: 'brand_new_code',
      requestId,
    };
    expect(valid(body)).toBe(true);
    expect(problemMessageKey(body.code)).toBe('problem.unknown');
  });

  it('keeps expectedOrigin for origin_not_allowed only', () => {
    expect(
      valid({ ...problemFor('origin_not_allowed'), expectedOrigin: 'https://panel.example.org' }),
    ).toBe(true);
    expect(valid({ ...problemFor('csrf_invalid'), expectedOrigin: 'http://localhost:9300' })).toBe(
      false,
    );
    expect(
      valid({ ...problemFor('internal_error'), expectedOrigin: 'http://localhost:9300' }),
    ).toBe(false);
  });

  it.each([
    ['an expectedOrigin with a path', { expectedOrigin: 'http://localhost:9300/x' }],
    ['an expectedOrigin that is not an origin', { expectedOrigin: 'localhost' }],
  ])('rejects %s', (_label, change) => {
    expect(valid({ ...problemFor('origin_not_allowed'), ...change })).toBe(false);
  });

  it.each([
    ['a status that differs from the registry', { status: 500 }],
    ['a status outside 400 to 599', { status: 200 }],
    ['a status that is not an integer', { status: 403.5 }],
    ['a type for another code', { type: problemType('not_found') }],
    ['a type that is not a URN of this product', { type: 'https://example.org/problem' }],
    ['an empty title', { title: '' }],
    ['an empty detail', { detail: '' }],
    ['an empty code', { code: '' }],
    ['a code in upper case', { code: 'PERMISSION_DENIED' }],
    ['a request id that is too short', { requestId: 'abc' }],
    ['a request id with a line break', { requestId: 'abcd1234\r\nX: y' }],
    ['a stack member', { stack: 'Error: x\n    at f (/app/dist/index.js:1:1)' }],
    ['an sql member', { sql: 'SELECT 1' }],
    ['a path member', { path: '/data/m365portal.db' }],
    ['an error entry without a pointer', { errors: [{ code: 'invalid_type' }] }],
    ['an error entry without a code', { errors: [{ pointer: '/accent' }] }],
    [
      'an error entry with another member',
      { errors: [{ pointer: '/a', code: 'x', message: 'm' }] },
    ],
    ['a pointer that is none of the three forms', { errors: [{ pointer: 'accent', code: 'x' }] }],
    ['errors that are not a list', { errors: { pointer: '/a', code: 'x' } }],
  ])('rejects %s', (_label, change) => {
    expect(valid({ ...problemFor('permission_denied'), ...change })).toBe(false);
  });

  it.each(['type', 'title', 'status', 'detail', 'code', 'requestId'])(
    'rejects a body without %s',
    (member) => {
      expect(valid(without(problemFor('permission_denied'), member))).toBe(false);
    },
  );

  it('describes a field error on its own, and carries OpenAPI component ids', () => {
    expect(
      ProblemFieldErrorSchema.safeParse({ pointer: '/accent', code: 'accent_invalid' }).success,
    ).toBe(true);
    expect(ProblemSchema.meta()?.id).toBe('Problem');
    expect(ProblemFieldErrorSchema.meta()?.id).toBe('ProblemFieldError');
  });
});

// ---------------------------------------------------------------------------------------------
// The messages (FR-A-112, TA-03): the fragments are read directly so this test does not wait for
// the merge of the catalogues; `i18n-fragments.test.ts` (S4) guarantees the merge contains them.
// ---------------------------------------------------------------------------------------------

/** The placeholders each message may and must carry, per code (tasks.md T-A-022). */
const PLACEHOLDERS: Readonly<Record<string, readonly string[]>> = {
  origin_not_allowed: ['origin'],
  rate_limited: ['seconds'],
  image_processing_busy: ['seconds'],
  // Phase B: the codes whose answer carries a Retry-After the UI shows (spec 6.9.5).
  setup_token_locked: ['seconds'],
  break_glass_locked: ['seconds'],
  graph_throttled: ['seconds'],
  unknown: ['code', 'requestId'],
};

const placeholdersOf = (message: string): string[] =>
  [...message.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? '').sort();

/** The guard behind the fragment rules; throws a message listing every problem. */
function assertFragmentMatchesRegistry(fragment: Readonly<Record<string, unknown>>): void {
  const problems: string[] = [];
  const expectedKeys = [...CODES.map((code) => `problem.${code}`), 'problem.unknown'];
  for (const key of expectedKeys) if (!(key in fragment)) problems.push(`missing ${key}`);
  for (const key of Object.keys(fragment)) {
    if (!expectedKeys.includes(key)) problems.push(`${key} is not a code of the registry`);
  }
  for (const [key, value] of Object.entries(fragment)) {
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${key} is empty or not text`);
      continue;
    }
    if (value !== value.trim()) problems.push(`${key} has leading or trailing whitespace`);
    if (/[<>]/.test(value)) problems.push(`${key} contains markup`);
    const code = key.replace(/^problem\./, '');
    const wanted = [...(PLACEHOLDERS[code] ?? [])].sort();
    const found = placeholdersOf(value);
    if (found.join(',') !== wanted.join(',')) {
      problems.push(
        `${key} has placeholders [${found.join(', ')}], expected [${wanted.join(', ')}]`,
      );
    }
  }
  const keys = Object.keys(fragment);
  if (keys.join('\n') !== [...keys].sort().join('\n')) problems.push('keys are not sorted');
  if (problems.length > 0)
    throw new Error(`fragment differs from the registry: ${problems.join('; ')}`);
}

describe('the problem fragments (en and nl)', () => {
  const en = readFragment('en');
  const nl = readFragment('nl');

  it.each([
    ['en', en],
    ['nl', nl],
  ])('%s: a message for every code, problem.unknown, and no other key', (_language, fragment) => {
    expect(() => {
      assertFragmentMatchesRegistry(fragment);
    }).not.toThrow();
    expect(Object.keys(fragment)).toHaveLength(55);
  });

  it('every key starts with the namespace problem and a dot (C11)', () => {
    for (const key of [...Object.keys(en), ...Object.keys(nl)]) expect(key).toMatch(/^problem\./);
  });

  it('both languages have the same keys', () => {
    expect(Object.keys(nl)).toEqual(Object.keys(en));
  });

  it('Dutch and English differ for every key (nothing was left untranslated)', () => {
    for (const key of Object.keys(en)) expect(nl[key], key).not.toBe(en[key]);
  });

  it('carries the placeholders: {origin}, {seconds} and, for unknown codes, {code} and {requestId}', () => {
    for (const fragment of [en, nl]) {
      expect(fragment['problem.origin_not_allowed']).toContain('{origin}');
      expect(fragment['problem.rate_limited']).toContain('{seconds}');
      expect(fragment['problem.image_processing_busy']).toContain('{seconds}');
      expect(fragment['problem.unknown']).toContain('{code}');
      expect(fragment['problem.unknown']).toContain('{requestId}');
    }
  });

  it('shows the wait in the three Phase B messages that carry a Retry-After', () => {
    for (const fragment of [en, nl]) {
      for (const code of ['setup_token_locked', 'break_glass_locked', 'graph_throttled']) {
        expect(fragment[`problem.${code}`], code).toContain('{seconds}');
      }
    }
  });

  it('names a remedy in the Phase B messages the user can act on (FR-B-603)', () => {
    // The user can do something about each of these; the message says what, in both languages.
    const actionable = [
      'secrets_unavailable',
      'setup_token_invalid',
      'setup_step_not_ready',
      'tenant_mismatch',
      'step_up_required',
      'principal_unknown',
      'assignment_invalid',
      'assignment_exists',
      'graph_unavailable',
      'session_expired',
    ];
    for (const fragment of [en, nl]) {
      for (const code of actionable) {
        expect(fragment[`problem.${code}`]?.length ?? 0, code).toBeGreaterThan(40);
      }
    }
  });

  it('never carries a placeholder for text that came from Microsoft (FR-B-603)', () => {
    for (const fragment of [en, nl]) {
      for (const [key, message] of Object.entries(fragment)) {
        expect(message, key).not.toMatch(/\{(?:message|error|description|detail|aadsts\w*)\}/i);
      }
    }
  });

  it('names the remedy where one exists: PUBLIC_BASE_URL for a refused origin (FR-A-016)', () => {
    expect(en['problem.origin_not_allowed']).toContain('PUBLIC_BASE_URL');
    expect(nl['problem.origin_not_allowed']).toContain('PUBLIC_BASE_URL');
  });

  it('names the remedy for unusable storage: the data volume and the container user (E-25)', () => {
    expect(en['problem.storage_unavailable']).toContain('65532');
    expect(nl['problem.storage_unavailable']).toContain('65532');
  });

  it('gives Dutch values that are Dutch: no English stop words in the messages', () => {
    for (const [key, message] of Object.entries(nl)) {
      expect(message, key).not.toMatch(/\b(?:the|your|please|try again|you)\b/i);
    }
  });

  it('gives English values that are English: no Dutch stop words in the messages', () => {
    for (const [key, message] of Object.entries(en)) {
      expect(message, key).not.toMatch(/\b(?:het|een|niet|probeer|deze|jouw|je)\b/i);
    }
  });

  it('the fragment guard fails on a code without a message (negative fixture)', () => {
    expectGuardFails(assertFragmentMatchesRegistry, without(en, 'problem.csrf_invalid'), {
      reason: 'missing problem.csrf_invalid',
    });
  });

  it('the fragment guard fails on every other deviation (negative fixtures)', () => {
    const cases: readonly [string, Record<string, unknown>, string][] = [
      ['an extra key', { ...en, 'problem.invented': 'x' }, 'problem.invented is not a code'],
      ['an empty value', { ...en, 'problem.not_found': '' }, 'problem.not_found is empty'],
      [
        'a non-text value',
        { ...en, 'problem.not_found': 7 },
        'problem.not_found is empty or not text',
      ],
      [
        'padding',
        { ...en, 'problem.not_found': ' Not found. ' },
        'problem.not_found has leading or trailing whitespace',
      ],
      ['markup', { ...en, 'problem.not_found': '<b>Not found</b>' }, 'contains markup'],
      [
        'a missing placeholder',
        { ...en, 'problem.rate_limited': 'Too many requests.' },
        'problem.rate_limited has placeholders []',
      ],
      [
        'a stray placeholder',
        { ...en, 'problem.not_found': 'Not found: {id}.' },
        'problem.not_found has placeholders [id]',
      ],
      [
        'keys out of order',
        Object.fromEntries(Object.entries(en).reverse()),
        'keys are not sorted',
      ],
    ];
    for (const [, fragment, reason] of cases) {
      expectGuardFails(assertFragmentMatchesRegistry, fragment, { reason });
    }
  });
});
