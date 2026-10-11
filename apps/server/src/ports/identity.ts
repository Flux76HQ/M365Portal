// The identity ports (plan 8.1, 8.6): application tokens for Graph and Exchange, the sign-in client
// (authorize URL, code exchange, ID-token validation, end-session URL), the device-code bootstrap
// and the signer the client assertion needs. Implementations live in `integrations/identity` and
// `secrets`; services depend on these types only.
import type { BearerTokenProvider } from './provisioner.js';

/**
 * An access token that is not a string: `reveal()` is called only by the HTTP layer that attaches
 * the header, and the object never serialises to its value. Nothing decodes it (FR-B-316).
 */
export interface AccessToken {
  /** Epoch milliseconds at which the token expires. */
  readonly expiresAt: number;
  reveal(): string;
}

export interface AppTokenProvider {
  get(resource: 'graph' | 'exchange', o?: { skipCache?: boolean }): Promise<AccessToken>;
}

/** What the validator keeps of a verified ID token. `sub` is pairwise per application: not kept. */
export interface ValidatedIdToken {
  /** Tenant id, lower case. */
  readonly tid: string;
  /** Object id of the user, lower case: the key of the principal. */
  readonly oid: string;
  /** `preferred_username`, a label only. */
  readonly upn: string | null;
  readonly name: string | null;
  /** At most 16 strings of at most 32 characters, or `null` when the claim is absent or malformed. */
  readonly amr: readonly string[] | null;
  /** `auth_time` as epoch seconds when it is a safe integer. */
  readonly authTime: number | null;
}

export interface OidcClient {
  buildAuthorizeUrl(p: {
    state: string;
    nonce: string;
    codeChallenge: string;
    prompt?: 'login' | 'select_account';
  }): URL;
  exchangeCode(p: { code: string; codeVerifier: string }): Promise<{ idToken: string }>;
  /** Throws `IdTokenError` with the name of the failed check. */
  validateIdToken(raw: string, p: { nonce: string }): Promise<ValidatedIdToken>;
  endSessionUrl(): Promise<URL>;
}

export interface DeviceCodeInfo {
  readonly userCode: string;
  /** Only passes through when it is `https` on an allow-listed Microsoft host (FR-B-214). */
  readonly verificationUri: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly intervalSeconds: number;
}

export interface BootstrapIdentity {
  readonly tid: string;
  readonly oid: string;
  readonly upnLabel: string | null;
  readonly nameLabel: string | null;
}

export interface BootstrapAuthenticator {
  start(o: { tenantHint?: string }): Promise<DeviceCodeInfo>;
  /** Resolves when the administrator has signed in; rejects with `DeviceCodeError`. */
  completion(): Promise<BootstrapIdentity>;
  bearer(): BearerTokenProvider;
  cancel(): void;
  /** Drops every token, the account and the callbacks. Idempotent. */
  discard(): void;
}

/** Signs a compact JWS without exposing the key. Implemented by the certificate holder. */
export interface CompactSigner {
  signCompact(protectedHeader: Record<string, unknown>, payload: Uint8Array): Promise<string>;
}
