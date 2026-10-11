// Wire schemas of the setup gate and the wizard (tasks T-B-122, CB14; contract section 5, P10 to
// P18, FR-B-201 to FR-B-205, FR-B-210, FR-B-213, FR-B-218, FR-B-219).
//
// Rules of this folder: Zod only, no transform, every schema has `.meta({ id })` (the id is the
// constant name without `Schema`), request schemas are strict. The response schemas are strict
// too: a field nobody declared (a secret, a device code) is an error, not a silent drop.
//
// The primitives (`SetupStateSchema`, `StepKeySchema`, `StepStatusSchema`) and the step, run and
// proof types are defined in `connection.ts`, which this file imports, so the two files do not
// import each other; the three primitives are re-exported here because the contract lists them
// under `schemas/setup`.
import { z } from 'zod';
import { LIMITS } from '../limits.js';
import {
  ENVIRONMENT_CHECK_CODES,
  ENVIRONMENT_CHECK_KEYS,
  ENVIRONMENT_CHECK_STATUSES,
  SETUP_RESULT_CODES,
} from '../setup/result-codes.js';
import { SETUP_OBJECT_KINDS, SETUP_STEP_DETAIL_MAX_BYTES, STEP_KEYS } from '../setup/steps.js';
import { GuidSchema, IsoTimestampSchema, OriginSchema, ParamsSchema } from './common.js';
import {
  ProofSchema,
  ResultCodeSchema,
  SetupModeSchema,
  SetupStateSchema,
  StepKeySchema,
  StepStateSchema,
  StepStatusSchema,
} from './connection.js';

export { SetupStateSchema, StepKeySchema, StepStatusSchema };

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/** A label or a name shown next to an id: a non-empty string of at most 256 bytes. */
const LabelSchema = z
  .string()
  .min(1)
  .refine((value) => utf8Bytes(value) <= LIMITS.setup.detailStringMaxBytes, {
    error: 'at most 256 bytes',
  });

/** Text that holds no control character. */
const NO_CONTROL = /^[^\p{Cc}\u2028\u2029]*$/u;

// ---------------------------------------------------------------------------------------------
// The step `detail` (FR-B-210)
// ---------------------------------------------------------------------------------------------

const DetailString = z
  .string()
  .refine((value) => utf8Bytes(value) <= LIMITS.setup.detailStringMaxBytes, {
    error: 'at most 256 bytes',
  });

/**
 * The `detail` object of a `setup_step` row: the closed key list `SETUP_STEP_DETAIL`, values that
 * are strings of at most 256 bytes, numbers or booleans (ids as GUIDs), nothing nested, at most
 * 4,096 bytes serialised. A key that looks like a secret (`secret`, `token`, `key`, `password`,
 * `assertion`, `pem`, `credential`, any case) is not on the list and so is refused, as is any
 * other key. The writer of the server parses with this schema (`T-B-127`).
 */
export const StepDetailSchema = z
  .strictObject({
    manual: z.boolean().optional(),
    exchangeEnabled: z.boolean().optional(),
    attempt: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
    nextAttemptAt: IsoTimestampSchema.optional(),
    elapsedSeconds: z.number().int().min(0).optional(),
    code: ResultCodeSchema.optional(),
    aadsts: z.number().int().min(1).max(9_999_999).optional(),
    graphErrorCode: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
      .optional(),
    host: z
      .string()
      .regex(/^[A-Za-z0-9.-]{1,253}$/)
      .optional(),
    kind: z.enum(SETUP_OBJECT_KINDS).optional(),
    name: DetailString.optional(),
    objectId: GuidSchema.optional(),
    appId: GuidSchema.optional(),
    tenantId: GuidSchema.optional(),
    thumbprint8: z
      .string()
      .regex(/^[0-9a-f]{8}$/)
      .optional(),
    skewSeconds: z.number().int().optional(),
    count: z.number().int().min(0).optional(),
  })
  .refine((detail) => utf8Bytes(JSON.stringify(detail)) <= SETUP_STEP_DETAIL_MAX_BYTES, {
    error: 'the detail is at most 4,096 bytes',
  })
  .meta({ id: 'StepDetail' });

// ---------------------------------------------------------------------------------------------
// Status and unlock (P10, P11)
// ---------------------------------------------------------------------------------------------

/** `GET /api/v1/setup/status`: the state and whether a token is needed, and nothing else (FR-B-202). */
export const SetupStatusResponseSchema = z
  .strictObject({ state: SetupStateSchema, tokenRequired: z.boolean() })
  .meta({ id: 'SetupStatusResponse' });

/** `POST /api/v1/setup/unlock`: the token, 1 to 256 characters, accepted nowhere else (FR-B-203). */
export const UnlockRequestSchema = z
  .strictObject({ token: z.string().min(1).max(256) })
  .meta({ id: 'UnlockRequest' });

export const UnlockResponseSchema = z
  .strictObject({ state: z.literal('in_progress') })
  .meta({ id: 'UnlockResponse' });

// ---------------------------------------------------------------------------------------------
// The wizard's state (P13)
// ---------------------------------------------------------------------------------------------

export const DesignatedOwnerSchema = z
  .strictObject({
    oid: GuidSchema,
    upnLabel: LabelSchema.nullable(),
    nameLabel: LabelSchema.nullable(),
  })
  .meta({ id: 'DesignatedOwner' });

const LANGUAGES = Object.freeze(['nl', 'en'] as const);

const FiveStepsSchema = z
  .array(StepStateSchema)
  .refine((steps) => steps.map((step) => step.step).join() === STEP_KEYS.join(), {
    error: 'the five steps, in registry order',
  });

export const SetupStateResponseSchema = z
  .strictObject({
    state: SetupStateSchema,
    mode: SetupModeSchema,
    defaultLanguage: z.enum(LANGUAGES).nullable(),
    steps: FiveStepsSchema,
    tenant: z.strictObject({
      proposedTenantId: GuidSchema.nullable(),
      tenantId: GuidSchema.nullable(),
      name: LabelSchema.nullable(),
      initialDomain: LabelSchema.nullable(),
    }),
    application: z
      .strictObject({
        appId: GuidSchema,
        objectId: GuidSchema.nullable(),
        displayName: LabelSchema,
      })
      .nullable(),
    certificate: z
      .strictObject({
        thumbprintSha1: z.string().regex(/^[0-9a-fA-F]{40}$/),
        notAfter: IsoTimestampSchema,
        state: z.enum(['pending', 'active']),
      })
      .nullable(),
    designatedOwner: DesignatedOwnerSchema.nullable(),
    exchangeEnabled: z.boolean(),
    proof: ProofSchema.nullable(),
    publicBaseUrl: OriginSchema,
    session: z.strictObject({
      idleExpiresAt: IsoTimestampSchema,
      absoluteExpiresAt: IsoTimestampSchema,
    }),
  })
  .meta({ id: 'SetupStateResponse' });

// ---------------------------------------------------------------------------------------------
// Environment checks (P14, FR-B-213)
// ---------------------------------------------------------------------------------------------

/**
 * One environment check. `ok` has no code and no remedy; any other status has a code that is
 * registered for this check (`ENVIRONMENT_CHECK_CODES`) with the same status (`warn` or `fail`).
 */
export const EnvironmentCheckSchema = z
  .strictObject({
    key: z.enum(ENVIRONMENT_CHECK_KEYS),
    status: z.enum(ENVIRONMENT_CHECK_STATUSES),
    code: ResultCodeSchema.nullable(),
    remedyKey: z
      .string()
      .max(128)
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/)
      .nullable(),
    params: ParamsSchema,
  })
  .superRefine((check, context) => {
    if (check.status === 'ok') {
      if (check.code !== null)
        context.addIssue({ code: 'custom', message: 'ok has no code', path: ['code'] });
      if (check.remedyKey !== null) {
        context.addIssue({ code: 'custom', message: 'ok has no remedy', path: ['remedyKey'] });
      }
      return;
    }
    if (check.code === null) {
      context.addIssue({
        code: 'custom',
        message: 'a check that is not ok has a code',
        path: ['code'],
      });
      return;
    }
    const allowed: readonly string[] = ENVIRONMENT_CHECK_CODES[check.key];
    if (!allowed.includes(check.code) || SETUP_RESULT_CODES[check.code].status !== check.status) {
      context.addIssue({
        code: 'custom',
        message: 'the code does not belong to this check and status',
        path: ['code'],
      });
    }
  })
  .meta({ id: 'EnvironmentCheck' });

/**
 * The result of `POST /api/v1/setup/environment`: all six checks in order, `blocking` true exactly
 * when one failed, and a status that follows from the checks.
 */
export const EnvironmentResultSchema = z
  .strictObject({
    ranAt: IsoTimestampSchema,
    status: z.enum(['ok', 'warning', 'failed']),
    blocking: z.boolean(),
    checks: z.array(EnvironmentCheckSchema),
  })
  .superRefine((result, context) => {
    if (result.checks.map((check) => check.key).join() !== ENVIRONMENT_CHECK_KEYS.join()) {
      context.addIssue({ code: 'custom', message: 'the six checks, in order', path: ['checks'] });
    }
    const failed = result.checks.some((check) => check.status === 'fail');
    const warned = result.checks.some((check) => check.status === 'warn');
    if (result.blocking !== failed) {
      context.addIssue({
        code: 'custom',
        message: 'blocking is true exactly when a check failed',
        path: ['blocking'],
      });
    }
    const expected = failed ? 'failed' : warned ? 'warning' : 'ok';
    if (result.status !== expected) {
      context.addIssue({
        code: 'custom',
        message: 'the status follows from the checks',
        path: ['status'],
      });
    }
  })
  .meta({ id: 'EnvironmentResult' });

// ---------------------------------------------------------------------------------------------
// Manual mode (P15, FR-B-218, SB-20)
// ---------------------------------------------------------------------------------------------

const FirstOwnerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('oid'), value: GuidSchema }),
  z.strictObject({
    kind: z.literal('upn'),
    value: z.string().min(3).max(256).regex(NO_CONTROL),
  }),
]);

export const ManualRequestSchema = z
  .strictObject({
    applicationClientId: GuidSchema,
    tenantId: GuidSchema,
    firstOwner: FirstOwnerSchema,
  })
  .meta({ id: 'ManualRequest' });

export const ManualResponseSchema = z
  .strictObject({
    mode: z.literal('manual'),
    applicationClientId: GuidSchema,
    tenantId: GuidSchema,
    designatedOwner: DesignatedOwnerSchema,
  })
  .meta({ id: 'ManualResponse' });

// ---------------------------------------------------------------------------------------------
// Group search (P17, CD-09)
// ---------------------------------------------------------------------------------------------

export const GROUP_SEARCH_MAX_RESULTS = 25;
export const GROUP_SEARCH_QUERY_MAX_CODE_POINTS = 64;

/** `GET /api/v1/setup/groups?q=`: already trimmed, 1 to 64 code points, no control character. */
export const GroupSearchQuerySchema = z
  .strictObject({
    q: z
      .string()
      .regex(NO_CONTROL)
      .refine((text) => text === text.trim(), { error: 'trimmed' })
      .refine(
        (text) => {
          const length = Array.from(text).length;
          return length >= 1 && length <= GROUP_SEARCH_QUERY_MAX_CODE_POINTS;
        },
        { error: '1 to 64 code points' },
      ),
  })
  .meta({ id: 'GroupSearchQuery' });

export const GroupSearchResponseSchema = z
  .strictObject({
    groups: z
      .array(z.strictObject({ id: GuidSchema, displayName: LabelSchema }))
      .max(GROUP_SEARCH_MAX_RESULTS),
  })
  .meta({ id: 'GroupSearchResponse' });

// ---------------------------------------------------------------------------------------------
// Finish (P18, FR-B-219)
// ---------------------------------------------------------------------------------------------

/**
 * `POST /api/v1/setup/finish`: the request names the person who becomes Owner (`confirmOwnerOid`,
 * FR-B-219 h), the default language and, optionally, the Entra group for the role Beheerder.
 */
export const FinishRequestSchema = z
  .strictObject({
    confirmOwnerOid: GuidSchema,
    language: z.enum(LANGUAGES).optional(),
    beheerderGroupId: GuidSchema.nullable().optional(),
  })
  .meta({ id: 'FinishRequest' });

export const FinishResponseSchema = z
  .strictObject({
    state: z.literal('awaiting_first_signin'),
    designatedOwner: DesignatedOwnerSchema,
    signinUrl: z.literal('/auth/login?returnTo=%2F'),
  })
  .meta({ id: 'FinishResponse' });
