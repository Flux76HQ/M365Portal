// T-B-074, FR-B-112, SB-12 (+ negative): the one client-assertion signer.
//
// Learn, https://learn.microsoft.com/entra/identity-platform/certificate-credentials: header `alg`
// PS256, `typ` JWT, `x5t#S256`; claims `aud` (the tenant token endpoint), `iss` = `sub` = the client
// id, a unique `jti`, `nbf` now, `iat`, `exp` "5-10 minutes after nbf at most"; signed with PSS
// padding. The product's builder is checked against the fake Entra, which validates those rules
// strictly (T-B-064), and against the certificate's own public key.
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_ASSERTION_LIFETIME_SECONDS,
  CLIENT_ASSERTION_TYPE,
  signClientAssertion,
  tokenEndpointOf,
} from '../../../src/integrations/identity/client-assertion.js';
import type { CertificateHolderPort } from '../../../src/ports/secrets.js';
import { checkClientAssertion } from '../../fakes/fake-tenant/entra/index.js';
import { fromB64url, parseCompact, verifyPs256 } from '../../fakes/fake-tenant/entra/jwt.js';
import { testClock } from '../../support/msw.js';
import { sequenceRandom } from '../support.js';
import { identityWorld } from './support.js';

const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));

function context(world: ReturnType<typeof identityWorld>, extra: { includeX5t?: boolean } = {}) {
  return {
    signer: world.holder,
    clock: { now: () => testClock.nowMs() },
    random: sequenceRandom(),
    ...extra,
  };
}

function check(
  world: ReturnType<typeof identityWorld>,
  assertion: string,
  seen = new Set<string>(),
) {
  return checkClientAssertion({
    assertion,
    clientId: world.app.appId,
    tenantPath: world.tenantId,
    credentials: world.graph.directory.registeredCertificates(world.app.appId),
    nowMs: testClock.nowMs(),
    seenJti: seen,
  });
}

/** A signer that edits the header or the payload before the holder signs: a broken builder. */
function tampering(
  holder: CertificateHolderPort,
  edit: (header: Record<string, unknown>, payload: Record<string, unknown>) => void,
): CertificateHolderPort {
  return {
    publicCertificateDer: () => holder.publicCertificateDer(),
    signCompact(header, payload) {
      const claims = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
      const head = { ...header };
      edit(head, claims);
      return holder.signCompact(head, new TextEncoder().encode(JSON.stringify(claims)));
    },
  };
}

describe('the assertion Learn describes', () => {
  it('has the documented header and claims', async () => {
    const world = identityWorld();
    const endpoint = tokenEndpointOf(world.tenantId);
    const assertion = await signClientAssertion(context(world), {
      clientId: world.app.appId,
      audience: endpoint,
    });
    const parsed = parseCompact(assertion);
    expect(parsed).toBeDefined();
    expect(parsed?.header).toEqual({
      alg: 'PS256',
      typ: 'JWT',
      'x5t#S256': world.app.certificate.thumbprintSha256,
    });
    const now = testClock.nowMs() / 1000;
    expect(parsed?.payload).toEqual({
      aud: `https://login.microsoftonline.com/${world.tenantId}/oauth2/v2.0/token`,
      iss: world.app.appId,
      sub: world.app.appId,
      jti: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      iat: now,
      nbf: now,
      exp: now + 300,
    });
    expect(CLIENT_ASSERTION_LIFETIME_SECONDS).toBe(300);
    expect(CLIENT_ASSERTION_TYPE).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  });

  it('puts the SHA-256 thumbprint of the DER in x5t#S256, and no x5t unless asked', async () => {
    const world = identityWorld();
    const der = Buffer.from(world.holder.publicCertificateDer());
    expect(new X509Certificate(der).raw.equals(der)).toBe(true);
    const sha256 = createHash('sha256').update(der).digest('base64url');
    const plain = parseCompact(
      await signClientAssertion(context(world), {
        clientId: world.app.appId,
        audience: tokenEndpointOf(world.tenantId),
      }),
    );
    expect(plain?.header['x5t#S256']).toBe(sha256);
    expect('x5t' in (plain?.header ?? {})).toBe(false);

    const both = parseCompact(
      await signClientAssertion(context(world, { includeX5t: true }), {
        clientId: world.app.appId,
        audience: tokenEndpointOf(world.tenantId),
      }),
    );
    expect(both?.header.x5t).toBe(createHash('sha1').update(der).digest('base64url'));
    expect(both?.header['x5t#S256']).toBe(sha256);
  });

  it('is verified by the public key of the certificate (PSS, SHA-256)', async () => {
    const world = identityWorld();
    const assertion = await signClientAssertion(context(world), {
      clientId: world.app.appId,
      audience: tokenEndpointOf(world.tenantId),
    });
    const parsed = parseCompact(assertion);
    const publicKey = new X509Certificate(Buffer.from(world.holder.publicCertificateDer()))
      .publicKey;
    expect(verifyPs256(parsed?.input ?? '', parsed?.signature ?? '', publicKey)).toBe(true);
    expect(fromB64url(parsed?.signature ?? '').length).toBe(256);
  });

  it('is accepted by the fake Entra, which applies the rules strictly', async () => {
    const world = identityWorld();
    const assertion = await signClientAssertion(context(world), {
      clientId: world.app.appId,
      audience: tokenEndpointOf(world.tenantId),
    });
    expect(check(world, assertion)).toBeUndefined();
  });

  it('is accepted with the optional x5t header as well', async () => {
    const world = identityWorld();
    const assertion = await signClientAssertion(context(world, { includeX5t: true }), {
      clientId: world.app.appId,
      audience: tokenEndpointOf(world.tenantId),
    });
    expect(check(world, assertion)).toBeUndefined();
  });

  it('takes iat, nbf and exp from the injected clock', async () => {
    const world = identityWorld();
    testClock.advance(3_600_000);
    const parsed = parseCompact(
      await signClientAssertion(context(world), {
        clientId: world.app.appId,
        audience: tokenEndpointOf(world.tenantId),
      }),
    );
    const now = testClock.nowMs() / 1000;
    expect(parsed?.payload).toMatchObject({ iat: now, nbf: now, exp: now + 300 });
  });

  it('gives every assertion a new jti', async () => {
    const world = identityWorld();
    // Sixteen bytes that differ on every call, whatever the call count (the shared helper wraps at 256).
    let calls = 0;
    const counting = {
      float: () => 0.5,
      bytes: (length: number) => {
        calls += 1;
        const out = new Uint8Array(length);
        new DataView(out.buffer).setUint32(0, calls);
        return out;
      },
    };
    const ctx = { ...context(world), random: counting };
    const seen = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const parsed = parseCompact(
        await signClientAssertion(ctx, {
          clientId: world.app.appId,
          audience: tokenEndpointOf(world.tenantId),
        }),
      );
      seen.add(String(parsed?.payload.jti));
    }
    expect(seen.size).toBe(50);
  });

  it('accepts the token endpoint MSAL hands over for the tenant (a tenant id or a domain)', async () => {
    const world = identityWorld();
    for (const audience of [
      `https://login.microsoftonline.com/${world.tenantId}/oauth2/v2.0/token`,
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
    ]) {
      const parsed = parseCompact(
        await signClientAssertion(context(world), { clientId: world.app.appId, audience }),
      );
      expect(parsed?.payload.aud).toBe(audience);
    }
  });
});

describe('what it refuses to build', () => {
  it.each([
    ['another host', 'https://evil.example/tenant/oauth2/v2.0/token'],
    ['plain http', 'http://login.microsoftonline.com/t/oauth2/v2.0/token'],
    ['another path', 'https://login.microsoftonline.com/t/oauth2/v2.0/authorize'],
    ['the v1 endpoint', 'https://login.microsoftonline.com/t/oauth2/token'],
    ['a query', 'https://login.microsoftonline.com/t/oauth2/v2.0/token?x=1'],
    ['a port', 'https://login.microsoftonline.com:444/t/oauth2/v2.0/token'],
    ['user information', 'https://a@login.microsoftonline.com/t/oauth2/v2.0/token'],
    ['a common authority', 'https://login.microsoftonline.com/common/oauth2/v2.0/token'],
    ['an empty audience', ''],
  ])('an audience on %s', async (_name, audience) => {
    const world = identityWorld();
    await expect(
      signClientAssertion(context(world), { clientId: world.app.appId, audience }),
    ).rejects.toThrow();
  });

  it('a client id that is not a GUID', async () => {
    const world = identityWorld();
    await expect(
      signClientAssertion(context(world), {
        clientId: 'not-a-guid',
        audience: tokenEndpointOf(world.tenantId),
      }),
    ).rejects.toThrow();
  });
});

describe('negatives: a builder that breaks one rule is refused by the fake Entra', () => {
  const CASES: readonly [
    string,
    (header: Record<string, unknown>, payload: Record<string, unknown>) => void,
    string,
  ][] = [
    [
      'exp more than 10 minutes after nbf',
      (_h, p) => {
        p.exp = Number(p.nbf) + 601;
      },
      'lifetime_too_long',
    ],
    [
      'no x5t#S256',
      (h) => {
        Reflect.deleteProperty(h, 'x5t#S256');
      },
      'missing_x5t_s256',
    ],
    [
      'the wrong audience',
      (_h, p) => {
        p.aud = 'https://login.microsoftonline.com/other/oauth2/v2.0/token';
      },
      'bad_aud',
    ],
    [
      'an iss that is not the client id',
      (_h, p) => {
        p.iss = 'someone';
      },
      'bad_iss',
    ],
    [
      'no jti',
      (_h, p) => {
        Reflect.deleteProperty(p, 'jti');
      },
      'missing_jti',
    ],
    [
      'no typ',
      (h) => {
        Reflect.deleteProperty(h, 'typ');
      },
      'bad_typ',
    ],
  ];

  it.each(CASES)('%s', async (_name, edit, reason) => {
    const world = identityWorld();
    const broken = tampering(world.holder, edit);
    const assertion = await signClientAssertion(
      { ...context(world), signer: broken },
      { clientId: world.app.appId, audience: tokenEndpointOf(world.tenantId) },
    );
    expect(check(world, assertion)).toBe(reason);
  });

  it('a wrong algorithm: the holder will not sign it, and a hand-made one is refused', async () => {
    const world = identityWorld();
    const broken = tampering(world.holder, (h) => {
      h.alg = 'RS256';
    });
    await expect(
      signClientAssertion(
        { ...context(world), signer: broken },
        { clientId: world.app.appId, audience: tokenEndpointOf(world.tenantId) },
      ),
    ).rejects.toThrow();
  });

  it('a reused jti', async () => {
    const world = identityWorld();
    // A random source that repeats itself: every assertion gets the same jti.
    const stuck = { bytes: (length: number) => new Uint8Array(length).fill(7), float: () => 0.5 };
    const ctx = { ...context(world), random: stuck };
    const input = { clientId: world.app.appId, audience: tokenEndpointOf(world.tenantId) };
    const seen = new Set<string>();
    expect(check(world, await signClientAssertion(ctx, input), seen)).toBeUndefined();
    expect(check(world, await signClientAssertion(ctx, input), seen)).toBe('jti_reused');
  });

  it('a signature of another key', async () => {
    const other = identityWorld();
    const world = identityWorld();
    const assertion = await signClientAssertion(
      { ...context(world), signer: other.holder },
      { clientId: world.app.appId, audience: tokenEndpointOf(world.tenantId) },
    );
    expect(['unknown_certificate', 'bad_signature']).toContain(check(world, assertion));
  });
});

describe('the key never crosses the boundary (SB-12)', () => {
  it('asks the signer for a compact JWS and nothing else', async () => {
    const world = identityWorld();
    const calls: { header: Record<string, unknown>; payload: string }[] = [];
    const spy: CertificateHolderPort = {
      publicCertificateDer: () => world.holder.publicCertificateDer(),
      signCompact(header, payload) {
        calls.push({ header, payload: new TextDecoder().decode(payload) });
        return world.holder.signCompact(header, payload);
      },
    };
    await signClientAssertion(
      { ...context(world), signer: spy },
      { clientId: world.app.appId, audience: tokenEndpointOf(world.tenantId) },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.header).toMatchObject({ alg: 'PS256', typ: 'JWT' });
    expect(Object.keys(JSON.parse(calls[0]?.payload ?? '{}') as object).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'jti',
      'nbf',
      'sub',
    ]);
  });
});

// ---- single implementation ----------------------------------------------------------------------

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

/** Source without comments: a sentence that names the header is not a builder. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Files that name the assertion header or the assertion type other than the one builder. */
function assertionBuilders(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => file.path !== 'integrations/identity/client-assertion.ts')
    .filter((file) => {
      const text = code(file.text);
      return text.includes('x5t#S256') || /PS256['"]/.test(text);
    })
    .map((file) => file.path);
}

describe('there is one assertion builder (FR-B-112; T-B-393 repeats the scan)', () => {
  it('finds x5t#S256 and the PS256 header only in client-assertion.ts', () => {
    const files = walk(SRC).map((path) => ({
      path: relative(SRC, path).split(sep).join('/'),
      text: readFileSync(path, 'utf8'),
    }));
    expect(files.some((file) => file.path === 'integrations/identity/client-assertion.ts')).toBe(
      true,
    );
    // The certificate holder names PS256 as the only algorithm it signs; that is the signer, not a builder.
    expect(
      assertionBuilders(files).filter((path) => path !== 'secrets/certificate-holder.ts'),
    ).toEqual([]);
  });

  it('negative: a second place that builds the header is reported', () => {
    expectGuardFails(
      (files: SourceFile[]) => {
        const found = assertionBuilders(files);
        if (found.length > 0) throw new Error(`second assertion builder in ${found.join(', ')}`);
      },
      [{ path: 'auth/rogue.ts', text: "const header = { alg: 'PS256', 'x5t#S256': t };" }],
      { name: 'assertion scan', reason: 'auth/rogue.ts' },
    );
  });
});
