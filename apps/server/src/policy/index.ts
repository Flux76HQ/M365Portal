// The policy layer (plan 8.8). Import from here.
export {
  ACTOR_KINDS,
  ANONYMOUS_ACTOR,
  PREVIEW_ACTOR,
  frozenSetOf,
  type Actor,
  type ActorKind,
  type ResourceRef,
} from './actor.js';
export { authorize, type Decision } from './authorize.js';
export {
  PREVIEW_WARNING,
  announcePreviewMode,
  carriesForwardingHeader,
  createActorResolver,
  resolveActor,
  type ActorConfig,
  type PreviewAnnouncement,
} from './resolvers.js';
