// T-B-071 ("Done when": one `odataString` helper, every id a GUID or escaped) and T-B-084 (the
// building blocks of FR-B-317): the helpers every client builds its URLs from.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  MICROSOFT_ORIGINS,
  UrlRefusedError,
  assertBase,
  buildQuery,
  guidSegment,
  isGuid,
  odataString,
  pathSegment,
  resolveUnder,
  tenantHint,
} from '../../src/integrations/http/url-guard.js';

const GUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('odataString', () => {
  it('doubles single quotes and wraps the value', () => {
    expect(odataString('abc')).toBe("'abc'");
    expect(odataString("O'Brien")).toBe("'O''Brien'");
    expect(odataString("'); or 1 eq 1 or ('")).toBe("'''); or 1 eq 1 or ('''");
    expect(odataString("''")).toBe("''''''");
  });

  it('refuses control characters, a lone surrogate and a value over 256 characters', () => {
    for (const bad of ['a\nb', 'a\u0000b', 'a\u007fb', '\ud800', 'x'.repeat(257)]) {
      expect(() => odataString(bad)).toThrow(UrlRefusedError);
    }
    expect(odataString('x'.repeat(256))).toHaveLength(258);
  });
});

describe('guidSegment', () => {
  it('lower-cases a GUID and refuses everything else', () => {
    expect(guidSegment(GUID.toUpperCase())).toBe(GUID);
    for (const bad of [
      '',
      'abc',
      `${GUID}/..`,
      `${GUID} `,
      '../x',
      `{${GUID}}`,
      GUID.replace('-', ''),
      'g'.repeat(36),
    ]) {
      expect(() => guidSegment(bad), bad).toThrow(UrlRefusedError);
    }
    expect(isGuid(GUID)).toBe(true);
    expect(isGuid(GUID.toUpperCase())).toBe(false);
    expect(isGuid(7)).toBe(false);
  });
});

describe('pathSegment', () => {
  it('escapes what encodeURIComponent escapes and the characters OData keys use', () => {
    expect(pathSegment('a.b@contoso.com')).toBe('a.b%40contoso.com');
    expect(pathSegment("o'brien@x.nl")).toBe('o%27brien%40x.nl');
    expect(pathSegment('a b')).toBe('a%20b');
    expect(pathSegment('(x)')).toBe('%28x%29');
    expect(pathSegment('%2f')).toBe('%252f');
    expect(pathSegment('é')).toBe('%C3%A9');
  });

  it.each([
    ['dot', '.'],
    ['double dot', '..'],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['empty', ''],
    ['too long', 'x'.repeat(257)],
    ['a lone surrogate', '\ud800'],
  ])('refuses %s', (_name, value) => {
    expect(() => pathSegment(value)).toThrow(UrlRefusedError);
  });

  it('leaves no character that a URL parser reads as structure', () => {
    for (const hostile of [
      'a?b',
      'a#b',
      'a@b',
      'a:b',
      'a;b',
      'a=b',
      'a&b',
      'a+b',
      'a,b',
      'a%00b',
      'a\r\nb',
      'a b\tc',
    ]) {
      expect(pathSegment(hostile)).toMatch(/^[A-Za-z0-9._~%-]+$/);
    }
  });
});

describe('buildQuery', () => {
  it('sorts the names and percent-encodes the values (a space is %20, never +)', () => {
    expect(buildQuery({ $top: '1', $select: 'id,displayName' })).toBe(
      '?$select=id%2CdisplayName&$top=1',
    );
    expect(buildQuery({ $filter: `startswith(displayName,${odataString("O'Brien")})` })).toBe(
      "?$filter=startswith(displayName%2C'O''Brien')",
    );
    expect(buildQuery({ $filter: "appId eq 'x'" })).toBe("?$filter=appId%20eq%20'x'");
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({})).toBe('');
  });

  it('keeps a hostile value inside its parameter', () => {
    const query = buildQuery({ $filter: "a' &$top=999 # x\r\n" });
    expect(query.split('&')).toHaveLength(1);
    expect(query).not.toMatch(/[#\r\n ]/);
  });

  it('refuses a name that is not a plain parameter name', () => {
    for (const name of ['', 'a b', 'a=b', '$a&b', '../x', 'x'.repeat(40), '$']) {
      expect(() => buildQuery({ [name]: 'v' }), name).toThrow(UrlRefusedError);
    }
  });
});

describe('tenantHint (FR-B-214, FR-B-317)', () => {
  it.each([
    [GUID, GUID],
    [GUID.toUpperCase(), GUID],
    ['contoso.onmicrosoft.com', 'contoso.onmicrosoft.com'],
    ['Contoso.Example.NL', 'contoso.example.nl'],
    ['a-b.c-d.e', 'a-b.c-d.e'],
    ['x'.repeat(63) + '.nl', 'x'.repeat(63) + '.nl'],
  ])('accepts %s', (value, expected) => {
    expect(tenantHint(value)).toBe(expected);
  });

  it.each([
    'localhost',
    'contoso',
    'common',
    'Consumers',
    'ORGANIZATIONS',
    '',
    'contoso..nl',
    '-contoso.nl',
    'contoso-.nl',
    'contoso.nl/..',
    'contoso.nl?x=1',
    'contoso.nl#x',
    'a@b.nl',
    'conto so.nl',
    'contoso.nl\r\n',
    'x'.repeat(64) + '.nl',
    `${'a'.repeat(60)}.`.repeat(5) + 'nl',
    'cöntoso.nl',
    'http://evil.example',
    '..',
  ])('refuses %j', (value) => {
    expect(() => tenantHint(value)).toThrow(UrlRefusedError);
  });
});

describe('assertBase and resolveUnder', () => {
  const GRAPH = MICROSOFT_ORIGINS.graph;

  it('knows exactly the three origins', () => {
    expect(Object.values(MICROSOFT_ORIGINS).sort()).toEqual([
      'https://graph.microsoft.com',
      'https://login.microsoftonline.com',
      'https://outlook.office365.com',
    ]);
  });

  it('refuses a base that is not an origin and a prefix', () => {
    for (const [origin, prefix] of [
      ['http://graph.microsoft.com', '/v1.0/'],
      ['https://graph.microsoft.com/', '/v1.0/'],
      ['https://graph.microsoft.com/v1.0', '/v1.0/'],
      ['https://graph.microsoft.com', '/v1.0'],
      ['https://graph.microsoft.com', 'v1.0/'],
      ['https://graph.microsoft.com', '//v1.0/'],
      ['https://graph.microsoft.com', '/v1.0/ /'],
      ['https://graph.microsoft.com:444', '/v1.0/'],
    ] as const) {
      expect(() => {
        assertBase(origin, prefix);
      }).toThrow(UrlRefusedError);
    }
    expect(() => {
      assertBase(GRAPH, '/v1.0/');
    }).not.toThrow();
  });

  it('returns the URL when it is under the origin and prefix', () => {
    expect(resolveUnder(GRAPH, '/v1.0/', `${GRAPH}/v1.0/users?$top=1`).href).toBe(
      `${GRAPH}/v1.0/users?$top=1`,
    );
    expect(resolveUnder(GRAPH, '/v1.0/', `${GRAPH}/v1.0/users/a%40b.nl`).pathname).toBe(
      '/v1.0/users/a%40b.nl',
    );
  });

  it.each([
    `${GRAPH}/v1.0`,
    `${GRAPH}/v1.0/..%2fbeta`,
    `${GRAPH}/v1.0/a%2Fb`,
    `${GRAPH}/v1.0/a%5Cb`,
    `${GRAPH}/v1.0/%2E%2E/beta`,
    `${GRAPH}/v1.0/./x`,
    `${GRAPH}/v1.0/x#y`,
    `${GRAPH}/v1.0/x y`,
    `${GRAPH}/v1.0/xé`,
    `${GRAPH}.evil.example/v1.0/x`,
    `https://graph.microsoft.com.evil.example/v1.0/x`,
    `https://GRAPH.microsoft.com:443@evil.example/v1.0/x`,
    `HTTP://graph.microsoft.com/v1.0/x`,
    `${GRAPH}/v1.0/` + 'a'.repeat(5_000),
  ])('refuses %j', (url) => {
    expect(() => resolveUnder(GRAPH, '/v1.0/', url)).toThrow(UrlRefusedError);
  });

  it('negative: the guard fails for a path that escapes the prefix, which a host-only check lets through', () => {
    const hostOnly = (url: string): URL => {
      const parsed = new URL(url);
      if (parsed.origin !== GRAPH) throw new Error('foreign host');
      return parsed;
    };
    const escaping = `${GRAPH}/v1.0/../beta/organization`;
    expect(hostOnly(escaping).pathname).toBe('/beta/organization');
    expectGuardFails((url: string) => resolveUnder(GRAPH, '/v1.0/', url), escaping, {
      name: 'resolveUnder',
      reason: 'url_refused:bad_url',
    });
  });
});
