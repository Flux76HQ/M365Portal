// local/no-decode-microsoft-tokens (FR-B-316): an access token for Graph or Exchange is never
// decoded ("Don't attempt to validate or read tokens for any API you don't own"); the one place that
// reads a token is the ID-token validator, integrations/identity/id-token.ts.
import type { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createRuleTester, ruleOf, scopeOf, STRICT_ASSERTIONS } from './support.js';

const FILE = 'apps/server/src/integrations/identity/app-token.ts';
const rule = ruleOf('no-decode-microsoft-tokens');

function ok(code: string, name?: string): RuleTester.ValidTestCase {
  return { name: name ?? code, code, filename: FILE };
}

function decode(code: string, name: string, label?: string): RuleTester.InvalidTestCase {
  return {
    name: label ?? code,
    code,
    filename: FILE,
    errors: [{ messageId: 'decodeFunction', data: { name } }],
  };
}

function split(code: string, label?: string): RuleTester.InvalidTestCase {
  return { name: label ?? code, code, filename: FILE, errors: [{ messageId: 'manualSplit' }] };
}

createRuleTester().run('local/no-decode-microsoft-tokens', rule, {
  assertionOptions: STRICT_ASSERTIONS,
  valid: [
    ok("import { jwtVerify, createRemoteJWKSet } from 'jose';", 'verifying is not decoding'),
    ok("import { SignJWT, CompactSign } from 'jose';"),
    ok('const keys = createRemoteJWKSet(new URL(uri));'),
    ok("const [major, minor] = '22.22.0'.split('.');", 'a version string is split on dots'),
    ok("const labels = hostname.split('.'); return labels.length;", 'a host name'),
    ok("const parts = host.split('.'); const first = parts[0];", 'a piece used without decoding'),
    ok(
      "const text = Buffer.from(value, 'base64url').toString();",
      'decoding something that is not a split',
    ),
    ok("const bytes = Buffer.from(key, 'utf8');", 'Buffer.from with another encoding'),
    ok("const [a, b] = x.split('.'); Buffer.from(c, 'base64');", 'decoding another variable'),
    ok(
      "const parts = token.split(','); Buffer.from(parts[1], 'base64');",
      'split on another separator',
    ),
  ],

  invalid: [
    decode("import { decodeJwt } from 'jose';", 'decodeJwt'),
    decode("import { decodeProtectedHeader } from 'jose';", 'decodeProtectedHeader'),
    decode("import { decodeJwt as read } from 'jose';", 'decodeJwt', 'under an alias'),
    decode("import { decodeJwt } from './my-jose.js';", 'decodeJwt', 'from any module'),
    decode("import * as jose from 'jose'; jose.decodeJwt(token);", 'decodeJwt', 'on a namespace'),
    decode("const claims = jose['decodeJwt'](token);", 'decodeJwt', 'computed key'),
    decode(
      'const header = lib.decodeProtectedHeader(token);',
      'decodeProtectedHeader',
      'on any object',
    ),
    decode('const claims = decodeJwt(token);', 'decodeJwt', 'a call of a name nobody imported'),
    split("const parts = token.split('.'); const claims = Buffer.from(parts[1], 'base64url');"),
    split("const claims = Buffer.from(token.split('.')[1], 'base64');", 'directly on the split'),
    split("const [header, payload] = token.split('.'); JSON.parse(atob(payload));"),
    split("const [, payload] = token.split('.'); Buffer.from(payload, 'base64url').toString();"),
    split("const payload = token.split('.').at(1); atob(payload);", 'through at()'),
    split("const parts = token.split('.'); const p = parts[1]; atob(p);", 'through a second const'),
    split("const parts = token.split('.'); atob(parts[1].replace(/-/g, '+'));", 'after a replace'),
    split("const parts = token.split('.'); base64url.decode(parts[1]);", 'jose base64url.decode'),
    split(
      "const parts = token.split('.'); jose.base64url.decode(parts[1]);",
      'on the jose namespace',
    ),
    split("const [, payload] = token.split('.'); atob(payload ?? '');", 'with a fallback value'),
    split("const [, payload] = token.split('.'); atob(payload || '');", 'with a || fallback'),
    split("const [, payload] = token.split('.'); atob(ok ? payload : '');", 'in a conditional'),
    split("atob((token as string).split('.')[1]!);", 'through type assertions'),
  ],
});

describe('local/no-decode-microsoft-tokens: scope', () => {
  it('runs on the server sources and leaves the ID-token validator out', () => {
    const scope = scopeOf('no-decode-microsoft-tokens');

    expect(scope.files).toEqual(['apps/server/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}']);
    expect(scope.ignores).toEqual(['apps/server/src/integrations/identity/id-token.ts']);
  });
});
