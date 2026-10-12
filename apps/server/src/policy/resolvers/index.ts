// The actor resolver (plan 11.7, SB-32): which actor a request acts as. Exactly three resolvers exist
// and nothing else can produce an actor:
//
//   session   a session cookie that names a live session (`user`, or `break_glass`)
//   setup     a setup cookie that names a live setup session (`setup`)
//   anonymous everything else
//
// Only the cookies select the actor. Nothing in the request line, the headers, the query or the body
// can name one, and a resolver that fails degrades to anonymous (a storage error is thrown, and the
// error handler turns it into a 503: never "treat as allowed"). A browser that holds both cookies (an
// Owner who reopened setup) gets the session actor, except on the setup routes, which ask for the
// setup actor (`prefer`); the CSRF binding covers both either way (FR-B-408).
import { cookieNames } from '@m365portal/shared/auth/cookies';
import type { Logger } from '../../logging/logger.js';
import type { DatabaseHandle } from '../../db/index.js';
import { anonymousActorFor, type Actor, type ActorResolver } from '../actor.js';
import { readPanelCookies } from '../cookies.js';
import type { PolicyPorts } from '../ports.js';
import { csrfBindingFor } from '../session-hash.js';
import { resolveSessionActor } from './session.js';
import { createSqlSessionReader } from './sql-session-reader.js';
import { resolveSetupActor } from './setup.js';

export { createSqlSessionReader } from './sql-session-reader.js';

export interface ActorResolverDeps {
  /** The origin of `PUBLIC_BASE_URL`: it decides the cookie names (`__Host-` on https). */
  readonly publicOrigin: string;
  readonly now: () => number;
  /** The database of the moment, for the default session reader. */
  readonly database: () => DatabaseHandle | undefined;
  readonly ports: PolicyPorts;
  /** `SESSION_IDLE_TIMEOUT_MINUTES` in milliseconds (`config.session.idleTimeoutMs`). */
  readonly idleTimeoutMs: number;
  readonly log?: Pick<Logger, 'warn'>;
}

export function createActorResolver(deps: ActorResolverDeps): ActorResolver {
  const names = cookieNames(deps.publicOrigin);
  const defaultSessions = createSqlSessionReader(deps.database);

  return (request, options): Actor => {
    const cookies = readPanelCookies(request.headers.get('cookie'), names);
    for (const duplicate of cookies.duplicates) {
      // The browser sent two cookies of one name: both count as absent (fail closed).
      deps.log?.warn({ event: 'cookie_duplicate', cookie: duplicate }, 'cookie_duplicate');
    }
    const binding = csrfBindingFor(cookies);
    if (cookies.session === undefined && cookies.setup === undefined) {
      return anonymousActorFor(binding, 'none');
    }

    const bySession = (): Actor | 'expired' | undefined => {
      // There is no database (degraded mode, FR-A-013): this process cannot judge a session cookie,
      // so it neither accepts nor clears it, whichever reader would have been asked.
      if (deps.database() === undefined) return undefined;
      const result = resolveSessionActor(
        {
          sessions: deps.ports.sessions.get() ?? defaultSessions,
          grants: deps.ports.grants.get(),
          now: deps.now,
          idleTimeoutMs: deps.idleTimeoutMs,
        },
        cookies.session,
        binding,
      );
      if (result === undefined || result.outcome === 'unavailable') return undefined;
      return result.outcome === 'actor' ? result.actor : 'expired';
    };
    const bySetup = (): Actor | undefined =>
      resolveSetupActor(deps.ports.setupSessions.get(), cookies.setup, binding);

    let sessionExpired = false;
    const order =
      options?.prefer === 'setup'
        ? (['setup', 'session'] as const)
        : (['session', 'setup'] as const);
    for (const which of order) {
      if (which === 'setup') {
        const actor = bySetup();
        if (actor !== undefined) return actor;
      } else {
        const result = bySession();
        if (result === 'expired') sessionExpired = true;
        else if (result !== undefined) return result;
      }
    }
    // An unknown, malformed or duplicate setup cookie is just "unauthenticated": nothing is cleared.
    return anonymousActorFor(binding, sessionExpired ? 'expired' : 'none');
  };
}
