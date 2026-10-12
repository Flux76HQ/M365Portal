// `GET /api/v1/me` and the boot data of the HTML shell (T-B-194, FR-B-413, AM-08, PB-16, SB-18, SB-38,
// XB7, XB19): the one builder of `MeResponse`. The route and the shell both call it with the actor the
// pipeline resolved from the cookies, so the page and the route cannot disagree.
//
//   actor        as resolved: `anonymous`, `user` (the id is the `oid`), `setup`, `break_glass`
//   permissions  held anywhere, sorted, once each
//   roles        the distinct roles of the active assignments of a user, direct or through a group of
//                the cached membership; empty for every other kind
//   session      expiry, idle expiry as stored when the request began (the deadline after this
//                request is in the `X-Session-Idle-Expires` header, `http/idle-header.ts`), mfa, the
//                end of the step-up window or null, groupsStale; null for anonymous and setup
//   setup        `setup_state.state`, or `unconfigured` when storage is unusable or the row is absent
//   features     `showcase` and `breakGlass` (both break-glass variables are set)
//   adminConsentUrl  null until the identity client says otherwise (a tenant is pinned, TB-14)
//
// Nothing here chooses an actor: it formats the one it is given. A storage failure while reading the
// roles or the setup state is not an answer to hide; it throws and the error handler answers 503,
// except in degraded mode, where there is no database and the answer is the anonymous one.
import { LIMITS } from '@m365portal/shared/limits';
import { PERMISSIONS } from '@m365portal/shared/permissions';
import { SETUP_STATES, type SetupState } from '@m365portal/shared/setup/steps';
import type { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import type { z } from 'zod';
import type { DatabaseHandle } from '../db/index.js';
import { idleExpiryOf } from '../http/idle-header.js';
import type { ModuleDeps } from '../module.js';
import type { Actor } from '../policy/actor.js';
import { listAssignmentsOf, listCachedGroupIds } from '../rbac/repository.js';
import { APP_VERSION } from '../version.js';

export type MeResponse = z.infer<typeof MeResponseSchema>;

const STEP_UP_WINDOW_MS = LIMITS.session.stepUpWindowMinutes * 60_000;

/** What the builder reads of the server. */
export interface MeSources {
  readonly version: string;
  /** The serialised origin of `PUBLIC_BASE_URL`. */
  readonly publicOrigin: string;
  readonly showcase: boolean;
  /** Are both break-glass variables configured (SB-18)? */
  readonly breakGlass: boolean;
  /** False in degraded mode. Read on every request: storage can come and go. */
  readonly storageAvailable: () => boolean;
  /** `undefined` in degraded mode. */
  readonly database: () => DatabaseHandle | undefined;
  /** The wall clock in milliseconds. */
  readonly now: () => number;
  /** `SESSION_IDLE_TIMEOUT_MINUTES` in milliseconds. */
  readonly idleTimeoutMs: number;
  /** The admin-consent link of a pinned tenant (T-B-188, TB-14); absent until the connection exists. */
  readonly adminConsentUrl?: () => string | null;
}

export type MeBuilder = (actor: Actor) => MeResponse;

/** The sources a module gets from the server's dependencies. */
export function meSourcesOf(deps: ModuleDeps): MeSources {
  return {
    version: APP_VERSION,
    publicOrigin: deps.config.publicOrigin,
    showcase: deps.config.showcase,
    breakGlass: deps.config.breakGlass !== undefined,
    storageAvailable: deps.storageAvailable,
    database: deps.database,
    now: deps.now,
    idleTimeoutMs: deps.config.session.idleTimeoutMs,
  };
}

function setupStateOf(db: DatabaseHandle | undefined): SetupState {
  if (db === undefined) return 'unconfigured';
  const row = db.sqlite.prepare('SELECT state FROM setup_state WHERE id = 1').get() as
    { state: string } | undefined;
  return SETUP_STATES.find((state) => state === row?.state) ?? 'unconfigured';
}

/** The distinct keys of the roles that count for a user right now, sorted. */
function activeRoleKeys(db: DatabaseHandle, oid: string, now: number): string[] {
  const keys = new Set<string>();
  const assignments = listAssignmentsOf(db, {
    userOid: oid,
    groupIds: listCachedGroupIds(db, oid),
  });
  for (const assignment of assignments) {
    if (assignment.expiresAt === null || now < Date.parse(assignment.expiresAt)) {
      keys.add(assignment.roleKey);
    }
  }
  return [...keys].sort();
}

export function createMeBuilder(sources: MeSources): MeBuilder {
  return (actor) => {
    const now = sources.now();
    const db = sources.database();
    const permissions = PERMISSIONS.filter((candidate) => actor.permissions.has(candidate)).sort();
    const roles =
      actor.kind === 'user' && db !== undefined
        ? activeRoleKeys(db, actor.id, now).map((key) => ({ key }))
        : [];

    let session: MeResponse['session'] = null;
    if ((actor.kind === 'user' || actor.kind === 'break_glass') && actor.session !== null) {
      const stepUpAt =
        actor.session.stepUpAt === null ? Number.NaN : Date.parse(actor.session.stepUpAt);
      const stepUpEnd = stepUpAt + STEP_UP_WINDOW_MS;
      session = {
        expiresAt: actor.session.absoluteExpiresAt,
        idleExpiresAt: idleExpiryOf(actor.session, {
          slid: false,
          now,
          idleTimeoutMs: sources.idleTimeoutMs,
        }),
        mfa: actor.session.mfa,
        stepUpValidUntil:
          actor.kind === 'user' && stepUpAt <= now && now < stepUpEnd
            ? new Date(stepUpEnd).toISOString()
            : null,
        groupsStale: actor.session.groupsStale,
      };
    }

    return {
      actor: { kind: actor.kind, id: actor.id, label: actor.label },
      permissions,
      roles,
      session,
      setup: { state: setupStateOf(db) },
      features: { showcase: sources.showcase, breakGlass: sources.breakGlass },
      adminConsentUrl: sources.adminConsentUrl?.() ?? null,
      version: sources.version,
      publicOrigin: sources.publicOrigin,
      storageAvailable: sources.storageAvailable(),
    };
  };
}
