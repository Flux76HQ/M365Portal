// The access tokens of the fake tenant (T-B-064, T-B-065, T-B-066). The product treats an access
// token for Graph or Exchange as opaque (FR-B-316), so the fake issues opaque strings: no dots, no
// JWT shape, nothing a decoder could read. Behind each string sits a record in the ledger that says
// what the token may do, and the Graph and Exchange modules look the string up on every request.
//
// A token SNAPSHOTS the grants of its application at the moment it is issued (research section 4:
// an Entra role assigned after the token was requested is not in it). That is the property the
// propagation probe of the wizard exists for, and the reason `issueAppToken` copies from the
// directory instead of pointing at it.
import type { FakeTenantClock } from '../types.js';
import type { FakeDirectory } from './directory.js';

export type TokenAudience = 'graph' | 'exchange';

export interface IssuedToken {
  /** The opaque string the client sends as `Bearer`. */
  readonly value: string;
  readonly audience: TokenAudience;
  readonly kind: 'app' | 'delegated';
  /** The client id of the application the token was issued to. */
  readonly appId: string;
  readonly tenantId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Application roles by value (an app token): the roles of the token's audience. */
  readonly roles: readonly string[];
  /** Delegated scopes by name, without the resource prefix (a delegated token). */
  readonly scopes: readonly string[];
  /** Entra role template ids the principal held when the token was issued. */
  readonly entraRoleTemplateIds: readonly string[];
  /** The object id of the signed-in user (a delegated token). */
  readonly userId: string | null;
}

export interface IssueSpec {
  readonly audience: TokenAudience;
  readonly kind: 'app' | 'delegated';
  readonly appId: string;
  readonly roles?: readonly string[];
  readonly scopes?: readonly string[];
  readonly entraRoleTemplateIds?: readonly string[];
  readonly userId?: string;
  /** Default 3,600 s (Learn: access tokens last about an hour). */
  readonly lifetimeSeconds?: number;
}

/** Ledgers made so far in this process: a token string is never valid in a ledger that did not issue it. */
let ledgers = 0;

export class TokenLedger {
  readonly #clock: FakeTenantClock;
  readonly #tenantId: string;
  readonly #salt: number;
  readonly #tokens = new Map<string, IssuedToken>();
  #counter = 0;

  constructor(clock: FakeTenantClock, tenantId: string) {
    this.#clock = clock;
    this.#tenantId = tenantId;
    ledgers += 1;
    this.#salt = ledgers;
  }

  issue(spec: IssueSpec): IssuedToken {
    this.#counter += 1;
    const now = this.#clock.now();
    const token: IssuedToken = {
      value: `fk-${spec.audience}-${spec.kind}-${String(this.#counter).padStart(5, '0')}-${scramble(this.#counter * 7_919 + this.#salt * 104_729)}`,
      audience: spec.audience,
      kind: spec.kind,
      appId: spec.appId.toLowerCase(),
      tenantId: this.#tenantId,
      issuedAt: now,
      expiresAt: now + (spec.lifetimeSeconds ?? 3_600) * 1000,
      roles: [...(spec.roles ?? [])],
      scopes: [...(spec.scopes ?? [])],
      entraRoleTemplateIds: [...(spec.entraRoleTemplateIds ?? [])],
      userId: spec.userId?.toLowerCase() ?? null,
    };
    this.#tokens.set(token.value, token);
    return token;
  }

  /** The record behind a token string, whether or not it has expired. */
  lookup(value: string): IssuedToken | undefined {
    return this.#tokens.get(value);
  }

  /** How many tokens were issued since the last reset: tests of "a fresh token each attempt". */
  get issued(): number {
    return this.#counter;
  }

  forget(value: string): void {
    this.#tokens.delete(value);
  }

  reset(): void {
    this.#tokens.clear();
    this.#counter = 0;
  }
}

/** Fixed-width hex scrambling of the counter: the string is not guessable from its neighbour by eye. */
function scramble(n: number): string {
  let state = (n * 2_654_435_761) >>> 0;
  let out = '';
  for (let step = 0; step < 4; step += 1) {
    state = (Math.imul(state ^ (state >>> 15), 2_246_822_519) >>> 0) ^ 0x9e3779b9;
    out += (state >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

/** The directory and the ledger the three Microsoft modules share (Entra issues, Graph and Exchange check). */
export interface FakeWorld {
  readonly directory: FakeDirectory;
  readonly tokens: TokenLedger;
  /** A token for an application with the grants it holds right now (what `client_credentials` returns). */
  issueAppToken(
    appId: string,
    audience: TokenAudience,
    options?: { lifetimeSeconds?: number },
  ): IssuedToken;
  /** A delegated token (what the device code grant returns), for tests that skip the Entra fake. */
  issueDelegatedToken(spec: {
    appId?: string;
    userId: string;
    scopes: readonly string[];
    entraRoleTemplateIds?: readonly string[];
    audience?: TokenAudience;
    lifetimeSeconds?: number;
  }): IssuedToken;
  /** Back to the initial directory and an empty ledger. */
  reset(): void;
}
