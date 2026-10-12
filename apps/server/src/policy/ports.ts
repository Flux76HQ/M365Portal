// The ports of the policy layer (CB10, SB-32): what the resolvers read, declared here and implemented
// where the data lives. The session store (S-B4, T-B-184) implements `SessionReader`, the setup session
// (S-B3, T-B-125) implements `SetupSessionReader`, and the rbac module (T-B-239) implements
// `GrantsSource`. A module hands its implementation over through a holder on `ModuleDeps.policy`
// (plan 6.2): the holder exists before any module does, the module sets it once, and a holder that is
// still empty when a request arrives fails closed (the request is anonymous).
import type { Grant } from '@m365portal/shared/rbac/effective';

/** A session as the resolver needs it. `oid` is empty for a break-glass session (data-model 5). */
export interface SessionRecord {
  readonly kind: 'user' | 'break_glass';
  readonly tid: string;
  readonly oid: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly absoluteExpiresAt: string;
  readonly authenticatedAt: string;
  readonly stepUpAt: string | null;
  readonly mfa: boolean;
  readonly groupsStale: boolean;
  /** `app_user.groups_resolved_at`: changes whenever the membership was resolved again. */
  readonly groupsResolvedAt: string | null;
  /** The last-known display label of the user, or `null` (never a secret). */
  readonly label: string | null;
}

export interface SessionReader {
  /**
   * The session with this id hash, or `undefined`. Expiry is the resolver's question, not the
   * reader's: a row past its deadline is returned and judged. Throws when the database does.
   */
  find(idHash: string): SessionRecord | undefined;
  /** Extend the idle deadline (the store throttles its writes, FR-B-407). Optional. */
  touch?(idHash: string): void;
}

/** A setup session as the resolver needs it. */
export interface SetupSessionRecord {
  readonly createdAt: string;
}

export interface SetupSessionReader {
  /**
   * The live setup session with this id hash, or `undefined`: unknown, expired, or the setup is
   * `completed` (the actor exists only while setup is open, FR-B-202).
   */
  find(idHash: string): SetupSessionRecord | undefined;
  /** Keep the setup session alive; the wizard's own polling does it (FR-B-205). Optional. */
  touch?(idHash: string): void;
}

/** The effective grants of a user at the moment of the request (`rbac/grants.ts`). */
export interface GrantsSource {
  grantsFor(subject: {
    readonly oid: string;
    readonly groupsResolvedAt: string | null;
  }): readonly Grant[];
}

/** Set once by the module that owns the implementation; read on every request. */
export interface Holder<T> {
  get(): T | undefined;
  set(value: T): void;
}

export function createHolder<T>(): Holder<T> {
  let held: T | undefined;
  return {
    get: () => held,
    set: (value) => {
      held = value;
    },
  };
}

/** What `ModuleDeps.policy` carries. */
export interface PolicyPorts {
  readonly sessions: Holder<SessionReader>;
  readonly setupSessions: Holder<SetupSessionReader>;
  readonly grants: Holder<GrantsSource>;
}

export function createPolicyPorts(): PolicyPorts {
  return {
    sessions: createHolder(),
    setupSessions: createHolder(),
    grants: createHolder(),
  };
}
