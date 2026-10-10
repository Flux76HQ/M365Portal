// The actor (plan 8.8, FR-A-030, FR-A-032): who a request acts as. Phase A has exactly two:
//
//   anonymous  no permission at all. Everyone, unless preview mode says otherwise.
//   preview    every permission of the catalogue, under the id `preview`. Only with PREVIEW_MODE=true.
//
// Both are values built once, here, frozen, and handed out by identity. Nothing in a request builds
// an actor, and nothing can change the permission set of the two that exist: the sets refuse `add`,
// `delete` and `clear`, so a handler with a bug cannot widen the anonymous actor for every request
// that comes after it. Phase B replaces the preview actor with a signed-in user; `Actor` and
// `authorize` keep their shape.
import { PERMISSIONS, type Permission } from '@m365portal/shared/permissions';

/** The kinds of actor there are. A third needs a decision, not a line of code. */
export const ACTOR_KINDS = ['anonymous', 'preview'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface Actor {
  readonly kind: ActorKind;
  /** Stable, recorded in the audit entries (FR-A-032: the preview actor is `preview`). */
  readonly id: string;
  /** A name for people, for the audit view and the banner. */
  readonly label: string;
  readonly permissions: ReadonlySet<Permission>;
}

/**
 * What a permission applies to. Unused in Phase A; it exists so that scopes in Phases B and D (one
 * distribution list, one group) change no signature (FR-A-030).
 */
export interface ResourceRef {
  readonly type: string;
  readonly id?: string;
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

export const ANONYMOUS_ACTOR: Actor = Object.freeze({
  kind: 'anonymous',
  id: 'anonymous',
  label: 'Anonymous',
  permissions: frozenSetOf([]),
});

export const PREVIEW_ACTOR: Actor = Object.freeze({
  kind: 'preview',
  id: 'preview',
  label: 'Preview mode',
  permissions: frozenSetOf(PERMISSIONS),
});
