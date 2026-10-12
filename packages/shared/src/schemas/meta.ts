// Metadata schemas (contract R4/P07 and R5/P08, FR-A-027, FR-B-413): who the client is and what it may
// do, and the CSRF token. These two routes are the whole metadata endpoint set; `/api/v1/meta` and
// `/api/v1/session` are not created.
import { z } from 'zod';
import { PermissionSchema } from '../permissions.js';
import { SETUP_STATES } from '../setup/steps.js';
import { IsoTimestampSchema, OriginSchema } from './common.js';
import { RoleKeySchema } from './rbac.js';

/**
 * Who the request resolved to. Four kinds, resolved on the server from the cookies and never chosen
 * by the request: `anonymous` (no permission), `user` (a signed-in Entra user), `setup` (the wizard's
 * session) and `break_glass`. There is no preview actor any more (FR-B-102).
 */
export const ActorSummarySchema = z
  .strictObject({
    kind: z.enum(['anonymous', 'user', 'setup', 'break_glass']),
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(128),
  })
  .meta({ id: 'ActorSummary' });

/**
 * Feature flags for the UI. `showcase` follows the `SHOWCASE` variable; `breakGlass` is true when both
 * break-glass variables are configured (SB-18), so the UI may offer `/break-glass`.
 */
export const FeaturesSchema = z
  .strictObject({
    showcase: z.boolean(),
    breakGlass: z.boolean(),
  })
  .meta({ id: 'Features' });

/**
 * The session of a `user` or `break_glass` actor. For break-glass `idleExpiresAt` equals `expiresAt`
 * (it never slides). `stepUpValidUntil` is null when the user has not stepped up or the window ended.
 */
export const SessionSummarySchema = z
  .strictObject({
    expiresAt: IsoTimestampSchema,
    idleExpiresAt: IsoTimestampSchema,
    mfa: z.boolean(),
    stepUpValidUntil: IsoTimestampSchema.nullable(),
    groupsStale: z.boolean(),
  })
  .meta({ id: 'SessionSummary' });

/** The persisted setup state, as far as the UI needs it before it signs in. */
export const SetupSummarySchema = z
  .strictObject({ state: z.enum(SETUP_STATES) })
  .meta({ id: 'SetupSummary' });

const unique = <T>(list: readonly T[], key: (item: T) => string): boolean =>
  new Set(list.map(key)).size === list.length;

/** `GET /api/v1/me`, also embedded in the HTML shell as the boot data. */
export const MeResponseSchema = z
  .strictObject({
    actor: ActorSummarySchema,
    /** Held anywhere, at any scope; sorted, once each. */
    permissions: z
      .array(PermissionSchema)
      .refine((list) => unique(list, (item) => item), { error: 'permissions are listed once each' })
      .refine(
        (list) => list.every((item, index) => index === 0 || (list[index - 1] ?? '') < item),
        {
          error: 'permissions are sorted',
        },
      ),
    /** The distinct roles of the active assignments, direct or through a group; empty for setup and break-glass. */
    roles: z
      .array(z.strictObject({ key: RoleKeySchema }))
      .refine((list) => unique(list, (item) => item.key), { error: 'roles are listed once each' }),
    session: SessionSummarySchema.nullable(),
    setup: SetupSummarySchema,
    features: FeaturesSchema,
    /**
     * The tenant-wide admin-consent link (FR-B-419, TB-14): non-null only when a tenant is pinned. It
     * holds the tenant id, the application id and the callback address, all of which every authorize
     * redirect already reveals.
     */
    adminConsentUrl: z
      .string()
      .max(2048)
      .regex(/^https:\/\/\S+$/)
      .nullable(),
    version: z.string().min(1).max(64),
    /**
     * The origin of `PUBLIC_BASE_URL`, serialised without a path or a trailing slash. The UI shows
     * it when a write is refused with `origin_not_allowed`.
     */
    publicOrigin: OriginSchema,
    /** False in degraded mode (the data directory or the database is unusable). */
    storageAvailable: z.boolean(),
  })
  .meta({ id: 'MeResponse' });

/**
 * `GET /api/v1/csrf`. The token is opaque to the client (its format is the business of the server's
 * CSRF module); only a header-safe character set and a length bound are checked here.
 */
export const CsrfResponseSchema = z
  .strictObject({
    token: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9._-]+$/),
    expiresAt: IsoTimestampSchema,
  })
  .meta({ id: 'CsrfResponse' });
