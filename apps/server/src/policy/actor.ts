// The actor (plan 8.8, 11.7, FR-A-030, FR-B-413, CB10): who a request acts as. Four kinds:
//
//   anonymous    no permission at all. Every request without a valid cookie.
//   user         a signed-in Entra user; the grants come from the assignments of the user and of the
//                groups the user is a member of (`rbac/grants.ts`).
//   setup        the setup wizard's session; exactly `settings:branding` and `settings:connection`,
//                only while setup is not completed (`fixed-grants.ts`).
//   break_glass  the break-glass session; exactly `rbac:manage` (`fixed-grants.ts`).
//
// An `Actor` is a value, built by the resolvers in `policy/resolvers/` and nowhere else (a source scan
// finds no `kind: 'user'`, `'setup'` or `'break_glass'` literal outside that folder), frozen, and its
// permission set refuses `add`, `delete` and `clear`, so a handler with a bug cannot widen the actor
// for the requests that come after it. Nothing in a request selects the kind: only the cookies do, and
// only through a session that exists.
import type { Permission } from '@m365portal/shared/permissions';
import type { Grant } from '@m365portal/shared/rbac/effective';

/** The kinds of actor there are. A fifth needs a decision, not a line of code. */
export const ACTOR_KINDS = ['anonymous', 'user', 'setup', 'break_glass'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** The kinds a route can require with `actorKinds`: everything that holds a session of some kind. */
export type SessionActorKind = Exclude<ActorKind, 'anonymous'>;

/** What the browser presented: nothing, a session that exists, or a session cookie that matched none. */
export type Credential = 'none' | 'valid' | 'expired';

/** The session of a `user` or `break_glass` actor, as the pipeline and `GET /api/v1/me` need it. */
export interface ActorSession {
  /** SHA-256 hex of the cookie value: the primary key of the row (`hashSessionId`). */
  readonly idHash: string;
  readonly tid: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  /** The sliding deadline of a user session; `null` for break-glass, which never slides. */
  readonly idleExpiresAt: string | null;
  readonly absoluteExpiresAt: string;
  readonly authenticatedAt: string;
  readonly stepUpAt: string | null;
  readonly mfa: boolean;
  /** Set when the last membership refresh failed: the grants may be out of date (FR-B-507). */
  readonly groupsStale: boolean;
  readonly groupsResolvedAt: string | null;
}

export interface Actor {
  readonly kind: ActorKind;
  /** Stable, recorded in the audit entries: the `oid` for a user, `setup`, `break-glass`, `anonymous`. */
  readonly id: string;
  /** A name for people, for the persona menu. Never the UPN beyond the label the sign-in stored. */
  readonly label: string;
  /** The permissions with at least one grant: what the UI may show; `authorize` reads `grants`. */
  readonly permissions: ReadonlySet<Permission>;
  /** The effective grants (`computeGrants`, or the fixed sets); empty for anonymous. */
  readonly grants: readonly Grant[];
  /** The CSRF binding of the cookies this request carried (`csrfBindingFor`). */
  readonly csrfBinding: string;
  readonly credential: Credential;
  readonly session: ActorSession | null;
  /** The hash of the setup session behind a `setup` actor (to keep it alive), else `null`. */
  readonly setupSession: { readonly idHash: string } | null;
  /** Is the step-up of a `user` actor inside its window (FR-B-411)? False for every other kind. */
  readonly stepUpFresh: boolean;
}

const sealed = new WeakSet<object>();

/** A set that is complete when its constructor returns and cannot change afterwards. */
class FrozenSet extends Set<Permission> {
  constructor(permissions: readonly Permission[]) {
    super(permissions);
    sealed.add(this);
  }

  override add(permission: Permission): this {
    // The `Set` constructor fills the set through `add`, before the instance is sealed.
    if (sealed.has(this)) throw new TypeError('a permission set cannot be changed');
    return super.add(permission);
  }

  override delete(): never {
    throw new TypeError('a permission set cannot be changed');
  }

  override clear(): never {
    throw new TypeError('a permission set cannot be changed');
  }
}

export function frozenSetOf(permissions: readonly Permission[]): ReadonlySet<Permission> {
  return new FrozenSet(permissions);
}

/** The anonymous actor of a browser that presented nothing. */
export const ANONYMOUS_ACTOR: Actor = Object.freeze({
  kind: 'anonymous',
  id: 'anonymous',
  label: 'Anonymous',
  permissions: frozenSetOf([]),
  grants: Object.freeze([]),
  csrfBinding: '',
  credential: 'none',
  session: null,
  setupSession: null,
  stepUpFresh: false,
});

/**
 * An anonymous actor that remembers what the browser presented: its binding (a stale cookie still
 * has one) and whether a session cookie matched no session (the wrapper then answers
 * `session_expired` and clears it, FR-B-414). Without either it is the shared `ANONYMOUS_ACTOR`.
 */
export function anonymousActorFor(binding: string, credential: Credential): Actor {
  if (binding === '' && credential === 'none') return ANONYMOUS_ACTOR;
  return Object.freeze({ ...ANONYMOUS_ACTOR, csrfBinding: binding, credential });
}

/**
 * What a permission applies to: a resource of the type the permission names, with the attributes a
 * scope item can look at (`ResourceAttrs` of the shared package).
 */
export type { ResourceAttrs as ResourceRef } from '@m365portal/shared/rbac/resources';

/**
 * Turns a request into an actor. Synchronous and cheap when the request carries no credential; a
 * database failure is a thrown 503, never an actor (plan 11.7). The pipeline calls it lazily, on the
 * first read of the actor of a request. `prefer` says which of two valid cookies wins: the setup
 * routes want the setup session, every other route the user session (an Owner who reopened setup
 * holds both).
 */
export type ActorResolver = (request: Request, options?: ResolveOptions) => Actor;

export interface ResolveOptions {
  readonly prefer?: 'session' | 'setup';
}

/**
 * Extends the idle deadline of the session behind an actor (FR-B-407). Called by the pipeline for a
 * request that passed every guard of a route that slides (`slidesSession` not false), never for a
 * refused request and never for the polled reads of FR-B-420.
 */
export type SessionSlider = (actor: Actor) => void;
