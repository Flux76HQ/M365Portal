// Test support for the identity clients (T-B-074 to T-B-081). Not a test file.
//
// `identityWorld()` builds the standard scene: the shared fake world with the fake Graph and the
// fake Entra mounted, an application registered with a throwaway certificate (and a service
// principal), a user who can sign in, and the product's own `CertificateHolder` over the private key
// of that certificate. The key pair exists for the test process only and protects nothing.
import { createHash } from 'node:crypto';
import {
  createCertificateHolder,
  type CertificateHolder,
} from '../../../src/secrets/certificate-holder.js';
import { installFakeGraph } from '../../fakes/fake-tenant/graph/index.js';
import {
  buildClientAssertion,
  installFakeEntra,
  seedApplication,
  type SeededApplication,
  type SignInSpec,
} from '../../fakes/fake-tenant/entra/index.js';
import { fake, testClock } from '../../support/msw.js';

export const PANEL_CALLBACK = 'https://panel.example/auth/callback';
export const PANEL_LOGGED_OUT = 'https://panel.example/auth/logged-out';

/** A holder over the private key and the certificate of a seeded application. */
export function holderFor(app: SeededApplication): CertificateHolder {
  const pkcs8Der = Buffer.from(app.certificate.privateKey.export({ type: 'pkcs8', format: 'der' }));
  return createCertificateHolder({
    pkcs8Der,
    publicDer: Buffer.from(app.certificate.der),
    notAfter: app.certificate.notAfter.toISOString(),
  });
}

export function identityWorld(options: { redirectUris?: readonly string[] } = {}) {
  const graph = installFakeGraph(fake);
  const entra = installFakeEntra(fake, graph.world);
  const app = seedApplication(graph.world, {
    redirectUris: options.redirectUris ?? [PANEL_CALLBACK, PANEL_LOGGED_OUT],
  });
  const user = graph.directory.addUser({ userPrincipalName: 'alice@contoso-fake.example' });
  entra.control.defaultSignIn({ user: user.id });
  return {
    graph,
    entra,
    app,
    user,
    tenantId: graph.directory.tenantId,
    holder: holderFor(app),
  };
}

export type IdentityWorld = ReturnType<typeof identityWorld>;

// ---- a sign-in through the fake Entra, to get an ID token ------------------------------------------

export const SIGNIN_VERIFIER = 'v'.repeat(43);
export const SIGNIN_NONCE = 'nonce-1';
export const SIGNIN_STATE = 'state-1';

export interface SignInResult {
  readonly idToken: string;
  readonly nonce: string;
  readonly body: Record<string, unknown>;
}

/**
 * Runs /authorize and /token against the fake Entra (the way the callback will) with a signing
 * assertion built by the test, and returns the ID token. `spec` is queued for this sign-in only.
 * A refused redemption throws with the error string so a test that expected a token sees why not.
 */
export async function signInThroughEntra(
  world: IdentityWorld,
  spec?: SignInSpec,
): Promise<SignInResult> {
  if (spec !== undefined) world.entra.control.nextSignIn(spec);
  const challenge = createHash('sha256').update(SIGNIN_VERIFIER).digest('base64url');
  const authorize = await fetch(
    `https://login.microsoftonline.com/${world.tenantId}/oauth2/v2.0/authorize?${new URLSearchParams(
      {
        client_id: world.app.appId,
        response_type: 'code',
        redirect_uri: PANEL_CALLBACK,
        response_mode: 'query',
        scope: 'openid profile',
        state: SIGNIN_STATE,
        nonce: SIGNIN_NONCE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
    ).toString()}`,
    { redirect: 'manual' },
  );
  const location = new URL(authorize.headers.get('location') ?? 'https://invalid.example/');
  const code = location.searchParams.get('code');
  if (code === null) {
    throw new Error(`authorize ended with ${location.searchParams.get('error') ?? 'no redirect'}`);
  }
  uniqueJti += 1;
  const answer = await fetch(
    `https://login.microsoftonline.com/${world.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: world.app.appId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: PANEL_CALLBACK,
        code_verifier: SIGNIN_VERIFIER,
        scope: 'openid profile',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: buildClientAssertion({
          certificate: world.app.certificate,
          clientId: world.app.appId,
          tenant: world.tenantId,
          nowMs: testClock.nowMs(),
          jti: `signin-${String(uniqueJti)}`,
        }),
      }).toString(),
    },
  );
  const body = (await answer.json()) as Record<string, unknown>;
  if (typeof body.id_token !== 'string') {
    throw new Error(`token endpoint answered ${String(body.error)}`);
  }
  return { idToken: body.id_token, nonce: SIGNIN_NONCE, body };
}

let uniqueJti = 0;
