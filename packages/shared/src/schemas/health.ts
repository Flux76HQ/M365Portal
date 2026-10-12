// Health schemas (contract R1 and R2, FR-A-026): liveness and readiness. Both are unauthenticated and
// answer in every mode, so they say as little as possible: a status, the version, and for readiness a
// named check with a stable failure code, never raw error text.
import { z } from 'zod';

/** `GET /healthz`: the process is running. `version` is the build-time constant from `VERSION`. */
export const HealthzResponseSchema = z
  .strictObject({
    status: z.literal('ok'),
    version: z.string().min(1).max(64),
  })
  .meta({ id: 'HealthzResponse' });

/**
 * The four things readiness looks at, in the order the document lists them. `secrets` is Phase B
 * (FR-B-108): it can fail readiness only once setup is completed or a certificate exists.
 */
export const READINESS_CHECK_NAMES = ['data_dir', 'database', 'schema', 'secrets'] as const;

/** Why a check fails (spec 6.4). Stable codes; the text behind them is never exposed. */
export const READINESS_FAILURE_CODES = [
  'data_dir_not_writable',
  'database_unavailable',
  'database_corrupt',
  'schema_newer_than_app',
  'app_key_missing',
  'app_key_invalid',
  'certificate_unreadable',
] as const;

export type ReadinessCheckName = (typeof READINESS_CHECK_NAMES)[number];
export type ReadinessFailureCode = (typeof READINESS_FAILURE_CODES)[number];

/** One readiness check: it passed, or it failed with exactly one failure code. */
export const ReadinessCheckSchema = z
  .strictObject({
    name: z.enum(READINESS_CHECK_NAMES),
    ok: z.boolean(),
    code: z.enum(READINESS_FAILURE_CODES).optional(),
  })
  .refine((check) => check.ok === (check.code === undefined), {
    error: 'a failing check has a code and a passing check has none',
    path: ['code'],
  })
  .meta({ id: 'ReadinessCheck' });

/**
 * `GET /readyz`: 200 `ready` when every check passes, 503 `unavailable` otherwise. The document
 * lists each of the four checks exactly once, so a missing check cannot read as a passing one.
 */
export const ReadyzResponseSchema = z
  .strictObject({
    status: z.enum(['ready', 'unavailable']),
    checks: z.array(ReadinessCheckSchema),
  })
  .superRefine((response, context) => {
    const names = response.checks.map((check) => check.name);
    const complete =
      names.length === READINESS_CHECK_NAMES.length &&
      READINESS_CHECK_NAMES.every((name) => names.includes(name));
    if (!complete) {
      context.addIssue({
        code: 'custom',
        message: 'the checks are data_dir, database, schema and secrets, each exactly once',
        path: ['checks'],
      });
    }
    const allPass = response.checks.every((check) => check.ok);
    if (allPass !== (response.status === 'ready')) {
      context.addIssue({
        code: 'custom',
        message: 'the status is ready exactly when every check passes',
        path: ['status'],
      });
    }
  })
  .meta({ id: 'ReadyzResponse' });
