// The control surface of the fake Entra (T-B-064): what a test turns to make sign-in, the token
// endpoint, the key set and the device code flow behave as one of the fixtures needs. Test support.
import type { JsonObject } from './jwt.js';

/** Who signs the ID token, and how (the attacker fixtures F-02, F-17 to F-19). */
export type SignerKind =
  /** The newest key of the issuing tenant (the default). */
  | 'current'
  /** The key before the newest, still in the key set after `rotateKeys` (F-... rotation). */
  | 'old'
  /** An RSA key that is in nobody's key set, with a `kid` of its own. */
  | 'attacker'
  /** The same attacker key, labelled with the `kid` of the current real key (F-02). */
  | 'attacker-real-kid'
  /** `alg` none and an empty signature (F-17). */
  | 'none'
  /** `alg` HS256, the public key of the current key as the secret (F-18). */
  | 'hs256-public-key'
  /** A valid signature by the real key with another algorithm (F-19). */
  | 'ps256'
  | 'rs384'
  /** A valid ES256 signature by an elliptic-curve key (F-19). */
  | 'es256';

export interface SignInSpec {
  /** Object id or user principal name of a user of the shared directory. */
  readonly user?: string;
  /** The tenant that issues the token (F-05: a foreign tenant with its own key set). */
  readonly issuerTenant?: string;
  /** Claims to set or replace in the ID token. */
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly omitClaims?: readonly string[];
  /** Header parameters to set or replace (F-20 to F-22: `jku`, `jwk`, `x5u`, `crit`). */
  readonly header?: Readonly<Record<string, unknown>>;
  readonly omitHeader?: readonly string[];
  /** Offsets in seconds from the fake clock for `exp`, `nbf` and `iat`. */
  readonly timing?: { readonly exp?: number; readonly nbf?: number; readonly iat?: number };
  /** `echo` (default) puts the nonce of the authorize request in the token; a string replaces it; `null` leaves it out. */
  readonly nonce?: string | null;
  readonly signer?: SignerKind;
  /** Adds a padding claim so that the compact token is at least this long (F-25). */
  readonly padBytes?: number;
  /** Replaces the whole `id_token` of the token response (F-26). */
  readonly rawIdToken?: string;
  /** Ends the authorize request with this error instead of a code (F-34 to F-37). */
  readonly authorizeError?: {
    readonly error: string;
    readonly description?: string;
    /** Prefixes the description with `AADSTS<n>: `. */
    readonly aadsts?: number;
  };
}

export interface TokenFaultAnswer {
  readonly status: number;
  readonly error?: string;
  readonly description?: string;
  readonly aadsts?: number;
  readonly retryAfterSeconds?: number;
}

export interface TokenFault {
  /** Which grant it applies to; default any. */
  readonly grant?: 'authorization_code' | 'client_credentials' | 'device_code' | 'refresh_token';
  /** How many matching requests it fails. */
  readonly times: number;
  /** An answer, or `hang` (no answer at all). */
  readonly answer: TokenFaultAnswer | 'hang';
}

export type KeysFault = 'unavailable' | 'redirect' | 'not_json' | null;
export type DiscoveryFault = 'unavailable' | 'issuer_mismatch' | 'foreign_hosts' | null;

export interface AuthorizeRecord {
  readonly tenant: string;
  readonly clientId: string | null;
  readonly redirectUri: string | null;
  readonly scope: string | null;
  readonly responseType: string | null;
  readonly responseMode: string | null;
  readonly prompt: string | null;
  readonly state: string | null;
  readonly nonce: string | null;
  readonly codeChallengeMethod: string | null;
  /** Names of parameters the fake does not know (`max_age`, `claims`, `login_hint`, ...). */
  readonly extraParameters: string[];
}

export interface TokenRecord {
  readonly tenant: string;
  readonly grantType: string | null;
  readonly contentType: string | null;
  readonly hasOrigin: boolean;
  /** Form fields; credentials and codes are the marker `[present]`. */
  readonly fields: Readonly<Record<string, string>>;
  /** The answer status. */
  readonly status: number;
}

export interface LogoutRecord {
  readonly tenantId: string;
  readonly postLogoutRedirectUri: string | null;
  readonly redirected: boolean;
}

export interface DeviceApproval {
  readonly user: string;
  /** Entra role templates the user holds; default Global Administrator. */
  readonly entraRoleTemplateIds?: readonly string[];
}

export interface FakeDeviceControl {
  /** The user finishes the sign-in of every flow that is waiting. Throws when none is. */
  approve(approval: DeviceApproval): void;
  decline(): void;
  expire(): void;
  /** Conditional Access blocks the sign-in (`AADSTS53003`). */
  block(): void;
  /** The `interval` that `/devicecode` returns, in seconds (default 5). */
  interval(seconds: number): void;
  /** The `verification_uri` that `/devicecode` returns (default `https://login.microsoft.com/device`). */
  verificationUri(uri: string): void;
  /** Answer `slow_down` to the next `times` polls (RFC 8628; undocumented on the Entra page, U22). */
  slowDown(times: number): void;
  temporarilyUnavailable(times: number): void;
  /** Answer `slow_down` to a poll that comes sooner than the interval (off by default). */
  enforceInterval(on: boolean): void;
  /** The scopes each `/devicecode` request asked for. */
  requestedScopes(): readonly (readonly string[])[];
  /** Flows that have not ended yet. */
  pending(): number;
}

export interface FakeEntraControl {
  /** The sign-in the next /authorize takes (one-shot, first in first out). */
  nextSignIn(spec: SignInSpec): void;
  /** The sign-in used when none is queued; `null` removes it. */
  defaultSignIn(spec: SignInSpec | null): void;
  /** Adds a key to the key set of a tenant (default: the pinned tenant) and returns its `kid`. */
  rotateKeys(tenantId?: string): string;
  /** Removes every key but the newest. */
  dropOldKeys(tenantId?: string): void;
  keyIds(tenantId?: string): string[];
  /** Makes another tenant known, with a key set of its own. */
  addTenant(tenantId: string): void;
  failKeys(mode: KeysFault): void;
  failDiscovery(mode: DiscoveryFault): void;
  failToken(fault: TokenFault): void;
  readonly device: FakeDeviceControl;
  /** Why the fake refused client authentication, oldest first (a machine word per refusal). */
  assertionRejections(): readonly string[];
  authorizeRequests(): readonly AuthorizeRecord[];
  tokenRequests(): readonly TokenRecord[];
  logouts(): readonly LogoutRecord[];
  /** The claims of every ID token the fake minted (for tests that look for a token in a store). */
  mintedIdTokens(): readonly string[];
}

export type { JsonObject };
