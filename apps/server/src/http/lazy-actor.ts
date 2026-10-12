// The actor of a request, resolved on first use (SB-32, plan 6.3 stage 11).
//
// The pipeline puts an object in `c.get('actor')` at the start of every request. Nothing is read from
// the database until something looks at it: a request that the availability gate, the rate limiter, the
// body rules, Origin or CSRF refuses never asks who the caller is, unless the denial audit does (it
// records the actor of a refused write). The object forwards every read to the actor the resolver
// returns for the first one, and to the same actor ever after; a resolver that throws (storage gone)
// throws on the read that asked, and asks again on the next.
import type { Actor } from '../policy/actor.js';

export function createLazyActor(resolve: () => Actor): Actor {
  let resolved: Actor | undefined;
  const actor = (): Actor => {
    resolved ??= resolve();
    return resolved;
  };
  return new Proxy({} as Actor, {
    get: (_target, property) => Reflect.get(actor(), property) as unknown,
    has: (_target, property) => Reflect.has(actor(), property),
    ownKeys: () => Reflect.ownKeys(actor()),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(actor(), property);
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}
