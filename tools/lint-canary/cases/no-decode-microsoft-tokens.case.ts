// Canary cases for local/no-decode-microsoft-tokens (FR-B-316): scope apps/server/src/** except
// apps/server/src/integrations/identity/id-token.ts, the one file that reads the ID token.
import type { CanaryCase } from '../canary-case.js';

const RULE = 'local/no-decode-microsoft-tokens';

export const cases = [
  {
    name: 'a Graph client decodes an access token with decodeJwt',
    path: 'apps/server/src/integrations/graph/__lint_canary__/decode-access-token.ts',
    code: `
import { decodeJwt } from 'jose';

export function rolesOf(accessToken: string): unknown {
  return decodeJwt(accessToken).roles;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a service reads the protected header of a token',
    path: 'apps/server/src/setup/__lint_canary__/decode-header.ts',
    code: `
import * as jose from 'jose';

export function algorithmOf(token: string): unknown {
  return jose.decodeProtectedHeader(token).alg;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a token is split and its payload decoded by hand',
    path: 'apps/server/src/integrations/exchange/__lint_canary__/manual-decode.ts',
    code: `
export function payloadOf(token: string): unknown {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
}
`,
    mustReport: [RULE],
  },
  {
    name: 'control: the ID-token validator may decode the ID token',
    path: 'apps/server/src/integrations/identity/id-token.ts',
    code: `
import { decodeJwt, decodeProtectedHeader } from 'jose';

export function peek(idToken: string): unknown {
  return [decodeProtectedHeader(idToken), decodeJwt(idToken)];
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: verifying a signature and splitting a host name are not decoding a token',
    path: 'apps/server/src/integrations/identity/__lint_canary__/verify.ts',
    code: `
import { jwtVerify } from 'jose';

export function labels(host: string): number {
  return host.split('.').length + Number(typeof jwtVerify);
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the rule is scoped to the server (shared)',
    path: 'packages/shared/src/__lint_canary__/decode-token.ts',
    code: `
import { decodeJwt } from 'jose';

export const read = decodeJwt;
`,
    mustNotReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];
