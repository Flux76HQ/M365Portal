// The policy layer (plan 8.8, 11.7). Import from here.
export {
  ACTOR_KINDS,
  ANONYMOUS_ACTOR,
  anonymousActorFor,
  frozenSetOf,
  type Actor,
  type ActorKind,
  type ActorResolver,
  type ActorSession,
  type Credential,
  type ResolveOptions,
  type ResourceRef,
  type SessionActorKind,
  type SessionSlider,
} from './actor.js';
export { PolicyUsageError, authorize, type Decision } from './authorize.js';
export { canGrant } from './can-grant.js';
export {
  ResourceDenied,
  createPolicyContext,
  type AuthorizedResource,
  type PolicyContext,
  type ResourceOf,
  type VisibleScope,
} from './context.js';
export { BREAK_GLASS_GRANTS, SETUP_GRANTS } from './fixed-grants.js';
export {
  createHolder,
  createPolicyPorts,
  type GrantsSource,
  type Holder,
  type PolicyPorts,
  type SessionReader,
  type SessionRecord,
  type SetupSessionReader,
  type SetupSessionRecord,
} from './ports.js';
export {
  createActorResolver,
  createSqlSessionReader,
  type ActorResolverDeps,
} from './resolvers/index.js';
export { csrfBindingFor, csrfBindingOfHeaders, hashSessionId } from './session-hash.js';
export { visibleScopes, type VisibleScopes, type VisibleSet } from './scoped.js';
