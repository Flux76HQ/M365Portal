// Metadata schemas (contract R4 and R5, FR-A-027): who the client is and what it may do, and the CSRF
// token. These two routes are the whole metadata endpoint set; `/api/v1/meta` and `/api/v1/session`
// are not created (`/session` is reserved for Phase B).
import { z } from 'zod';
import { PermissionSchema } from '../permissions.js';
import { IsoTimestampSchema, OriginSchema } from './common.js';

/**
 * Who the request resolved to. Phase A knows two actors, resolved on the server from configuration
 * and never chosen by the request: `anonymous` (no permission) and `preview` (all of them, only
 * with `PREVIEW_MODE=true`).
 */
export const ActorSummarySchema = z
  .strictObject({
    kind: z.enum(['anonymous', 'preview']),
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(128),
  })
  .meta({ id: 'ActorSummary' });

/**
 * Feature flags for the UI. `preview` is true only when this request resolved to the preview
 * actor (FR-A-036); `showcase` follows the `SHOWCASE` variable.
 */
export const FeaturesSchema = z
  .strictObject({
    showcase: z.boolean(),
    preview: z.boolean(),
  })
  .meta({ id: 'Features' });

/** `GET /api/v1/me`, also embedded in the HTML shell as the boot data. */
export const MeResponseSchema = z
  .strictObject({
    actor: ActorSummarySchema,
    permissions: z.array(PermissionSchema).refine((list) => new Set(list).size === list.length, {
      error: 'permissions are listed once each',
    }),
    features: FeaturesSchema,
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
