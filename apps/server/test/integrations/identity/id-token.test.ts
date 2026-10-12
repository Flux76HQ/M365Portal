// T-B-078, FR-B-404, EB-22, F-02 to F-27 (+ mutation-style negatives): the ID-token validator.
//
// The order of plan 8.6.5, with the `check` names of spec Appendix C: size, format, header, alg,
// tenant, issuer, kid, signature, expired, not_before, audience, issued_at, version, oid, nonce.
// Every fixture is minted by the fake Entra (valid tokens with its current key, attackers with
// another key or algorithm) and judged by the validator over a real key set fetched through the fake.
//
// The three things `jose` accepts on its own (V-B07) are fixtures here: an `iat` 120 s in the future
// (F-16), an `aud` array that holds the client id and another (F-09), and a `jku`/`jwk`/`x5u`/`crit`
// header (F-20 to F-22). Learn: https://learn.microsoft.com/entra/identity-platform/id-tokens and
// https://learn.microsoft.com/entra/identity-platform/id-token-claims-reference.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { createIdentityFetch } from '../../../src/integrations/identity/http.js';
import {
  ID_TOKEN_STEPS,
  createIdTokenValidator,
  type IdTokenStep,
} from '../../../src/integrations/identity/id-token.js';
import { createKeySet } from '../../../src/integrations/identity/jwks.js';
import { createTenantMetadata } from '../../../src/integrations/identity/tenant-metadata.js';
import { IdTokenError, type IdTokenCheck } from '../../../src/ports/errors.js';
import type { ValidatedIdToken } from '../../../src/ports/identity.js';
import { HOSTILE_DESCRIPTION, type SignInSpec } from '../../fakes/fake-tenant/entra/index.js';
import { fake, testClock } from '../../support/msw.js';
import { createTime, rejectionOf } from '../support.js';
import { identityWorld, signInThroughEntra, type IdentityWorld } from './support.js';

const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));
const LOGIN = 'https://login.microsoftonline.com';
const OTHER_TENANT = '55555555-6666-4777-8888-999999999999';
const OTHER_CLIENT = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function validatorFor(world: IdentityWorld, steps?: readonly IdTokenStep[]) {
  const time = createTime();
  const jsonFetch = createIdentityFetch({ clock: time.clock, scheduler: time.scheduler });
  const metadata = createTenantMetadata({
    tenantId: world.tenantId,
    jsonFetch,
    clock: time.clock,
  });
  const keys = createKeySet({ metadata, jsonFetch, clock: time.clock, scheduler: time.scheduler });
  return createIdTokenValidator(
    { tenantId: world.tenantId, clientId: world.app.appId, keys, clock: time.clock },
    steps,
  );
}

type Outcome =
  | { readonly ok: true; readonly token: ValidatedIdToken }
  | { readonly ok: false; readonly check: IdTokenCheck };

async function judge(
  world: IdentityWorld,
  spec: SignInSpec | undefined,
  options: { nonce?: string; steps?: readonly IdTokenStep[]; raw?: string } = {},
): Promise<Outcome> {
  const signed = options.raw === undefined ? await signInThroughEntra(world, spec) : undefined;
  const validate = validatorFor(world, options.steps);
  try {
    const token = await validate(options.raw ?? signed?.idToken ?? '', {
      nonce: options.nonce ?? signed?.nonce ?? 'nonce-1',
    });
    return { ok: true, token };
  } catch (failure) {
    if (failure instanceof IdTokenError) return { ok: false, check: failure.check };
    throw failure;
  }
}

// ---- the fixtures ------------------------------------------------------------------------------------

interface Fixture {
  readonly id: string;
  readonly spec: SignInSpec;
  readonly expect: IdTokenCheck | 'ok';
  /** Prepares the world before the sign-in. */
  readonly prepare?: (world: IdentityWorld) => void;
}

const ATTACKER_JWK = { kty: 'RSA', n: 'AQAB', e: 'AQAB' };

const FIXTURES: readonly Fixture[] = [
  { id: 'F-01 member, valid token, amr mfa', spec: {}, expect: 'ok' },
  {
    id: 'F-02 attacker key that reuses a real kid',
    spec: { signer: 'attacker-real-kid' },
    expect: 'signature',
  },
  {
    id: 'F-02 attacker key with its own kid (not in the set)',
    spec: { signer: 'attacker' },
    expect: 'kid',
  },
  {
    id: 'F-03 kid absent from the key set',
    spec: { header: { kid: 'unknown-kid' } },
    expect: 'kid',
  },
  { id: 'F-04 guest of the pinned tenant', spec: {}, expect: 'ok' },
  {
    id: 'F-05 foreign tid and issuer, validly signed by that tenant',
    spec: { issuerTenant: OTHER_TENANT },
    expect: 'tenant',
    prepare: (world) => {
      world.entra.control.addTenant(OTHER_TENANT);
    },
  },
  {
    id: 'F-06 iss in the v1 form',
    spec: { claims: { iss: `https://sts.windows.net/{tid}/` } },
    expect: 'issuer',
  },
  {
    id: 'F-07 iss with a trailing slash',
    spec: { claims: { iss: `${LOGIN}/{tid}/v2.0/` } },
    expect: 'issuer',
  },
  {
    id: 'F-07 iss with an upper-case host',
    spec: { claims: { iss: 'https://LOGIN.microsoftonline.com/{tid}/v2.0' } },
    expect: 'issuer',
  },
  {
    id: 'F-07 iss on another host',
    spec: { claims: { iss: 'https://login.windows.net/{tid}/v2.0' } },
    expect: 'issuer',
  },
  { id: 'F-07 iss without /v2.0', spec: { claims: { iss: `${LOGIN}/{tid}` } }, expect: 'issuer' },
  {
    id: 'F-08 aud is another client id',
    spec: { claims: { aud: OTHER_CLIENT } },
    expect: 'audience',
  },
  {
    id: 'F-09 aud is an array with our id and another',
    spec: { claims: { aud: ['{client}', OTHER_CLIENT] } },
    expect: 'audience',
  },
  { id: 'F-10 nonce differs', spec: { nonce: 'other' }, expect: 'nonce' },
  { id: 'F-11 nonce missing', spec: { nonce: null }, expect: 'nonce' },
  { id: 'F-12 exp 61 s in the past', spec: { timing: { exp: -61 } }, expect: 'expired' },
  { id: 'F-13 exp 59 s in the past', spec: { timing: { exp: -59 } }, expect: 'ok' },
  { id: 'F-14 nbf 61 s in the future', spec: { timing: { nbf: 61 } }, expect: 'not_before' },
  { id: 'F-15 nbf 59 s in the future', spec: { timing: { nbf: 59 } }, expect: 'ok' },
  { id: 'F-16 iat 120 s in the future', spec: { timing: { iat: 120 } }, expect: 'issued_at' },
  { id: 'F-17 alg none, unsigned', spec: { signer: 'none' }, expect: 'alg' },
  {
    id: 'F-18 alg HS256 with the public key as the secret',
    spec: { signer: 'hs256-public-key' },
    expect: 'alg',
  },
  { id: 'F-19 alg PS256 with a valid signature', spec: { signer: 'ps256' }, expect: 'alg' },
  { id: 'F-19 alg RS384 with a valid signature', spec: { signer: 'rs384' }, expect: 'alg' },
  { id: 'F-19 alg ES256 with a valid signature', spec: { signer: 'es256' }, expect: 'alg' },
  {
    id: 'F-20 header jku',
    spec: { header: { jku: 'https://attacker.example/keys' } },
    expect: 'header',
  },
  { id: 'F-21 header jwk', spec: { header: { jwk: ATTACKER_JWK } }, expect: 'header' },
  {
    id: 'F-22 header x5u',
    spec: { header: { x5u: 'https://attacker.example/cert' } },
    expect: 'header',
  },
  { id: 'F-22 header crit', spec: { header: { crit: ['exp'] } }, expect: 'header' },
  { id: 'F-23 ver 1.0', spec: { claims: { ver: '1.0' } }, expect: 'version' },
  { id: 'F-23 ver missing', spec: { omitClaims: ['ver'] }, expect: 'version' },
  { id: 'F-24 oid missing', spec: { omitClaims: ['oid'] }, expect: 'oid' },
  { id: 'F-24 oid not a GUID', spec: { claims: { oid: 'not-a-guid' } }, expect: 'oid' },
  { id: 'F-24 oid not a string', spec: { claims: { oid: 5 } }, expect: 'oid' },
  { id: 'F-25 token over 8,192 bytes', spec: { padBytes: 9_000 }, expect: 'size' },
  { id: 'F-26 two segments', spec: { rawIdToken: 'a.b' }, expect: 'format' },
  { id: 'F-26 non-base64url', spec: { rawIdToken: 'ÿ.ÿ.ÿ' }, expect: 'format' },
  {
    id: 'F-26 payload that is a JSON array',
    spec: {
      rawIdToken: `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from('[]').toString('base64url')}.c2ln`,
    },
    expect: 'format',
  },
  {
    id: 'F-26 header that is not an object',
    spec: {
      rawIdToken: `${Buffer.from('"x"').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.c2ln`,
    },
    expect: 'format',
  },
  { id: 'F-26 four segments', spec: { rawIdToken: 'a.b.c.d' }, expect: 'format' },
  {
    id: 'F-27 key endpoint unreachable on a cold start',
    spec: {},
    expect: 'keys_unavailable',
    prepare: (world) => {
      world.entra.control.failKeys('unavailable');
    },
  },
  // Further rows the plan names or the code adds.
  { id: 'a token without sub', spec: { omitClaims: ['sub'] }, expect: 'format' },
  { id: 'a token without exp', spec: { omitClaims: ['exp'] }, expect: 'expired' },
  { id: 'a token without nbf', spec: { omitClaims: ['nbf'] }, expect: 'not_before' },
  { id: 'a token without iat', spec: { omitClaims: ['iat'] }, expect: 'issued_at' },
  { id: 'a token without aud', spec: { omitClaims: ['aud'] }, expect: 'audience' },
  { id: 'a token without kid', spec: { omitHeader: ['kid'] }, expect: 'header' },
  { id: 'a token whose kid is not a string', spec: { header: { kid: 5 } }, expect: 'header' },
  { id: 'tid missing', spec: { omitClaims: ['tid'] }, expect: 'tenant' },
  {
    id: 'tid of another tenant but our issuer',
    spec: { claims: { tid: OTHER_TENANT } },
    expect: 'tenant',
  },
  {
    id: 'iat 60 s in the future is inside the tolerance',
    spec: { timing: { iat: 60 } },
    expect: 'ok',
  },
  { id: 'iat 61 s in the future', spec: { timing: { iat: 61 } }, expect: 'issued_at' },
];

/** `{tid}` and `{client}` in a fixture stand for the pinned tenant and the client id. */
function resolve(spec: SignInSpec, world: IdentityWorld): SignInSpec {
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replaceAll('{tid}', world.tenantId).replaceAll('{client}', world.app.appId);
    }
    if (Array.isArray(value)) return value.map(fill);
    return value;
  };
  if (spec.claims === undefined) return spec;
  return {
    ...spec,
    claims: Object.fromEntries(Object.entries(spec.claims).map(([k, v]) => [k, fill(v)])),
  };
}

describe('F-02 to F-27: the validator against the fake provider and attacker keys', () => {
  it.each(FIXTURES)('$id -> $expect', async (fixture) => {
    const world = identityWorld();
    fixture.prepare?.(world);
    // F-27 needs a token to exist: mint it before the key endpoint goes down.
    let spec = resolve(fixture.spec, world);
    let raw: string | undefined;
    if (fixture.expect === 'keys_unavailable') {
      world.entra.control.failKeys(null);
      raw = (await signInThroughEntra(world, spec)).idToken;
      world.entra.control.failKeys('unavailable');
      spec = {};
    }
    const outcome =
      raw === undefined ? await judge(world, spec) : await judge(world, undefined, { raw });
    if (fixture.expect === 'ok') {
      expect(outcome, fixture.id).toMatchObject({ ok: true });
    } else {
      expect(outcome, fixture.id).toEqual({ ok: false, check: fixture.expect });
    }
  });

  it('every fixture F-02 to F-27 of Appendix C is in the table', () => {
    const ids = new Set(FIXTURES.map((fixture) => /^F-(\d+)/.exec(fixture.id)?.[1]));
    for (let number = 2; number <= 27; number += 1) {
      expect(ids.has(String(number).padStart(2, '0')), `F-${String(number)}`).toBe(true);
    }
  });
});

describe('what the validator returns', () => {
  it('keeps tid, oid, the labels, amr and auth_time and nothing else (sub is pairwise)', async () => {
    const world = identityWorld();
    const outcome = await judge(world, undefined);
    expect(outcome).toEqual({
      ok: true,
      token: {
        tid: world.tenantId,
        oid: world.user.id,
        upn: 'alice@contoso-fake.example',
        name: 'alice',
        amr: ['pwd', 'mfa'],
        authTime: testClock.nowMs() / 1000,
      },
    });
  });

  it('is a guest by oid: a guest of the pinned tenant is an ordinary principal (EB-22)', async () => {
    const world = identityWorld();
    const guest = world.graph.directory.addUser({
      userPrincipalName: 'guest_ext#EXT#@contoso-fake.onmicrosoft.com',
    });
    const outcome = await judge(world, { user: guest.id });
    expect(outcome).toMatchObject({ ok: true, token: { oid: guest.id, tid: world.tenantId } });
  });

  it('lower-cases the oid', async () => {
    const world = identityWorld();
    const outcome = await judge(world, { claims: { oid: world.user.id.toUpperCase() } });
    expect(outcome).toMatchObject({ ok: true, token: { oid: world.user.id } });
  });

  it('keeps amr as at most 16 strings of at most 32 characters, else null', async () => {
    const world = identityWorld();
    const cases: readonly [unknown, readonly string[] | null][] = [
      [
        ['pwd', 'mfa'],
        ['pwd', 'mfa'],
      ],
      [
        Array.from({ length: 16 }, (_, i) => `m${String(i)}`),
        Array.from({ length: 16 }, (_, i) => `m${String(i)}`),
      ],
      [Array.from({ length: 17 }, (_, i) => `m${String(i)}`), null],
      [['x'.repeat(32)], ['x'.repeat(32)]],
      [['x'.repeat(33)], null],
      [['pwd', 5], null],
      ['mfa', null],
      [{ 0: 'mfa' }, null],
      [[], []],
    ];
    for (const [amr, expected] of cases) {
      const outcome = await judge(world, { claims: { amr } });
      expect(outcome, JSON.stringify(amr).slice(0, 40)).toMatchObject({
        ok: true,
        token: { amr: expected },
      });
    }
    const absent = await judge(world, { omitClaims: ['amr'] });
    expect(absent).toMatchObject({ ok: true, token: { amr: null } });
  });

  it('keeps auth_time when it is a safe integer', async () => {
    const world = identityWorld();
    for (const [authTime, expected] of [
      [1_700_000_000, 1_700_000_000],
      [1.5, null],
      ['1700000000', null],
      [Number.MAX_SAFE_INTEGER + 2, null],
    ] as const) {
      const outcome = await judge(world, { claims: { auth_time: authTime } });
      expect(outcome).toMatchObject({ ok: true, token: { authTime: expected } });
    }
    expect(await judge(world, { omitClaims: ['auth_time'] })).toMatchObject({
      ok: true,
      token: { authTime: null },
    });
  });

  it('cuts the labels at 256 bytes, at a character boundary, and drops what is not a string', async () => {
    const world = identityWorld();
    const long = 'é'.repeat(200);
    const outcome = await judge(world, { claims: { preferred_username: long, name: 5 } });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(Buffer.byteLength(outcome.token.upn ?? '')).toBeLessThanOrEqual(256);
      expect(outcome.token.upn).toBe('é'.repeat(128));
      expect(outcome.token.name).toBeNull();
    }
  });

  it('ignores wids, groups and the group-overage claims (F-45, F-44a)', async () => {
    const world = identityWorld();
    const outcome = await judge(world, {
      claims: {
        wids: ['62e90394-69f5-4237-9190-012177145e10'],
        groups: Array.from({ length: 250 }, (_, i) => `g${String(i)}`),
        _claim_names: { groups: 'src1' },
        hasgroups: true,
      },
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(Object.keys((outcome as { token: object }).token).sort()).toEqual([
      'amr',
      'authTime',
      'name',
      'oid',
      'tid',
      'upn',
    ]);
  });

  it('judges time by the injected clock, 60 s of tolerance either way', async () => {
    const world = identityWorld();
    const signed = await signInThroughEntra(world, { timing: { exp: 300 } });
    const validate = validatorFor(world);
    testClock.advance(300_000 + 59_000);
    await expect(validate(signed.idToken, { nonce: signed.nonce })).resolves.toBeDefined();
    testClock.advance(2_000);
    const failure = await rejectionOf(validate(signed.idToken, { nonce: signed.nonce }));
    expect((failure as IdTokenError).check).toBe('expired');
  });
});

describe('nonce', () => {
  it('is compared exactly, also when the lengths differ, and an empty expectation never matches', async () => {
    const world = identityWorld();
    const signed = await signInThroughEntra(world, undefined);
    const validate = validatorFor(world);
    for (const expected of ['nonce-2', 'nonce-', 'nonce-11', '', 'NONCE-1']) {
      const failure = await rejectionOf(validate(signed.idToken, { nonce: expected }));
      expect((failure as IdTokenError).check, expected).toBe('nonce');
    }
    await expect(validate(signed.idToken, { nonce: 'nonce-1' })).resolves.toBeDefined();
  });

  it('refuses a nonce claim that is not a string', async () => {
    const world = identityWorld();
    const outcome = await judge(world, { claims: { nonce: 5 } });
    expect(outcome).toEqual({ ok: false, check: 'nonce' });
  });
});

describe('what it never does', () => {
  it('never fetches a jku, an x5u or a jwk (F-20: the URL is never fetched)', async () => {
    const world = identityWorld();
    await judge(world, { header: { jku: 'https://attacker.example/keys' } });
    const hosts = new Set(fake.calls.all().map((call) => call.host));
    expect([...hosts]).toEqual(['login.microsoftonline.com']);
  });

  it('puts no part of the token in the error', async () => {
    const world = identityWorld();
    const signed = await signInThroughEntra(world, { nonce: 'other' });
    const validate = validatorFor(world);
    const failure = await rejectionOf(validate(signed.idToken, { nonce: signed.nonce }));
    const text = `${String(failure)} ${JSON.stringify(failure)} ${(failure as Error).stack ?? ''}`;
    expect(text).not.toContain(signed.idToken.split('.')[1]);
    expect(text).not.toContain(signed.idToken);
    expect(text).not.toContain('alice');
    expect(text).not.toContain(HOSTILE_DESCRIPTION.slice(0, 10));
  });

  it('refuses input that is not a string', async () => {
    const world = identityWorld();
    const validate = validatorFor(world);
    for (const raw of [undefined, null, 5, {}, ['a.b.c'], new Uint8Array(3)]) {
      const failure = await rejectionOf(validate(raw as string, { nonce: 'n' }));
      expect((failure as IdTokenError).check).toBe('format');
    }
  });
});

// ---- mutation-style negatives -----------------------------------------------------------------------

describe('negatives: a validator without one check fails the fixtures of that check', () => {
  const without = (...names: string[]): IdTokenStep[] =>
    ID_TOKEN_STEPS.filter((step) => !names.includes(step.name));

  const MUTANTS: readonly [string, string, string[]][] = [
    ['skips the nonce', 'nonce', ['F-10 nonce differs', 'F-11 nonce missing']],
    [
      'skips the tenant peek',
      'tenant',
      ['F-05 foreign tid and issuer, validly signed by that tenant'],
    ],
    [
      'skips the aud string rule',
      'audience_string',
      ['F-09 aud is an array with our id and another'],
    ],
    ['skips the iat rule', 'issued_at', ['F-16 iat 120 s in the future']],
    [
      'skips the alg check',
      'alg',
      [
        'F-17 alg none, unsigned',
        'F-18 alg HS256 with the public key as the secret',
        'F-19 alg PS256 with a valid signature',
      ],
    ],
    [
      'skips the header check',
      'header',
      ['F-20 header jku', 'F-21 header jwk', 'F-22 header x5u', 'F-22 header crit'],
    ],
    ['skips the version check', 'version', ['F-23 ver 1.0']],
    ['skips the oid check', 'oid', ['F-24 oid not a GUID']],
    ['skips the size check', 'size', ['F-25 token over 8,192 bytes']],
  ];

  it('the real validator has these steps, in this order', () => {
    expect(ID_TOKEN_STEPS.map((step) => step.name)).toEqual([
      'size',
      'format',
      'header',
      'alg',
      'tenant',
      'signature_and_claims',
      'audience_string',
      'issued_at',
      'version',
      'oid',
      'nonce',
    ]);
  });

  it.each(MUTANTS)('a copy that %s', async (_name, step, ids) => {
    for (const id of ids) {
      const fixture = FIXTURES.find((candidate) => candidate.id === id);
      expect(fixture, id).toBeDefined();
      if (fixture === undefined) continue;
      fake.reset();
      const world = identityWorld();
      fixture.prepare?.(world);
      const outcome = await judge(world, resolve(fixture.spec, world), { steps: without(step) });
      // The mutant must not give the answer the real validator gives for this fixture.
      expect(outcome, id).not.toEqual({ ok: false, check: fixture.expect });
    }
  });
});

// ---- decodeJwt lives here only ---------------------------------------------------------------------------

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function decoders(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => file.path !== 'integrations/identity/id-token.ts')
    .filter((file) => /\b(decodeJwt|decodeProtectedHeader)\b/.test(code(file.text)))
    .map((file) => file.path);
}

describe('decodeJwt and decodeProtectedHeader are used here and nowhere else (FR-B-316)', () => {
  it('finds them only in id-token.ts', () => {
    const files = walk(SRC).map((path) => ({
      path: relative(SRC, path).split(sep).join('/'),
      text: readFileSync(path, 'utf8'),
    }));
    expect(files.some((file) => file.path === 'integrations/identity/id-token.ts')).toBe(true);
    expect(decoders(files)).toEqual([]);
  });

  it('negative: another file that decodes a token is reported', () => {
    expectGuardFails(
      (files: SourceFile[]) => {
        const found = decoders(files);
        if (found.length > 0) throw new Error(`token decoded in ${found.join(', ')}`);
      },
      [
        {
          path: 'integrations/graph/rogue.ts',
          text: "import { decodeJwt } from 'jose'; decodeJwt(t);",
        },
      ],
      { name: 'decode scan', reason: 'integrations/graph/rogue.ts' },
    );
  });
});
