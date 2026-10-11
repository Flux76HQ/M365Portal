// Wire schemas of the connection routes and of the wizard's step model (tasks T-B-122, CB14;
// contract sections 6.1 to 6.2 and P19 to P26, FR-B-209 to FR-B-212, FR-B-309, FR-B-318).
//
// Rules of this folder: Zod only, no transform, every schema has `.meta({ id })` (the id is the
// constant name without `Schema`), request schemas are strict. The response schemas are strict too:
// a field nobody declared (a device code, a secret) is an error, not a silent drop.
//
// Dependency direction: this file holds the primitives (`SetupStateSchema`, `StepKeySchema`,
// `StepStatusSchema`, `ResultCodeSchema`) and the step, run and proof types; `setup.ts` imports them
// and re-exports the three the contract lists under `schemas/setup`. Nothing here imports `setup.ts`.
//
// A query string is text and a route schema has no coercion (T-B-024), so a number in a query is the
// text of a whole number; `logQueryOf` turns it into numbers.
import { z } from 'zod';
import { LIMITS } from '../limits.js';
import {
  isAllowedVerificationUri,
  isSecretLookingKey,
  SETUP_MODES,
  SETUP_STATES,
  STEP_KEYS,
  STEP_STATUSES,
  stepOfSubAction,
} from '../setup/steps.js';
import { LOG_KEYS, LOG_KEY_LIST, LOG_PARAM_NAMES, isLogKey } from '../setup/log-keys.js';
import { RESULT_CODES } from '../setup/result-codes.js';
import { EXCHANGE_ROLES, type ExchangeRoleKey } from '../setup/graph-roles.js';
import { tryNormalizeOrgName } from '../branding/org-name.js';
import { GuidSchema, IsoTimestampSchema, ParamsSchema } from './common.js';

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

export const SetupStateSchema = z.enum(SETUP_STATES).meta({ id: 'SetupState' });
export const SetupModeSchema = z.enum(SETUP_MODES).meta({ id: 'SetupMode' });
export const StepKeySchema = z.enum(STEP_KEYS).meta({ id: 'StepKey' });
export const StepStatusSchema = z.enum(STEP_STATUSES).meta({ id: 'StepStatus' });

/** The wizard result codes (spec 6.9.5). Never a problem code (CD-05). */
export const ResultCodeSchema = z.enum(RESULT_CODES).meta({ id: 'ResultCode' });

/** A catalogue key of a hint or remedy: lower-case dotted words, at most 128 characters. */
const CatalogueKeySchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);

/** A short text that is a name or a code, not free text: printable, at most 256 bytes. */
const ShortTextSchema = z
  .string()
  .min(1)
  .refine((value) => utf8Bytes(value) <= LIMITS.setup.detailStringMaxBytes, {
    error: 'at most 256 bytes',
  });

/** The sub-action of a step row: a key of the registry. */
const SubActionKeySchema = z.string().refine((key) => stepOfSubAction(key) !== undefined, {
  error: 'not a sub-action key',
});

// ---------------------------------------------------------------------------------------------
// Step model (FR-B-210)
// ---------------------------------------------------------------------------------------------

const WaitingSchema = z.strictObject({
  attempt: z.number().int().min(0),
  max: z.number().int().min(0),
  nextAttemptAt: IsoTimestampSchema,
});

export const SubActionStateSchema = z
  .strictObject({
    key: SubActionKeySchema,
    status: StepStatusSchema,
    attempt: z.number().int().min(0),
    startedAt: IsoTimestampSchema.nullable(),
    finishedAt: IsoTimestampSchema.nullable(),
    errorCode: ResultCodeSchema.nullable(),
    hint: z.strictObject({ key: CatalogueKeySchema, params: ParamsSchema }).nullable(),
    waiting: WaitingSchema.nullable(),
    manual: z.boolean(),
  })
  .refine((state) => state.waiting === null || state.status === 'waiting', {
    error: 'a countdown belongs to a waiting sub-action',
  })
  .meta({ id: 'SubActionState' });

/** `status` is `aggregate(subActions)` (plan 9.4); the sub-actions must belong to the step. */
export const StepStateSchema = z
  .strictObject({
    step: StepKeySchema,
    status: StepStatusSchema,
    subActions: z.array(SubActionStateSchema),
  })
  .refine((state) => state.subActions.every((sub) => stepOfSubAction(sub.key) === state.step), {
    error: 'a sub-action belongs to another step',
  })
  .meta({ id: 'StepState' });

// ---------------------------------------------------------------------------------------------
// Live log (FR-B-211)
// ---------------------------------------------------------------------------------------------

/**
 * The params of a log line: scalars only, at most 8, names from the closed list `LOG_PARAM_NAMES`,
 * strings at most 256 bytes. A name that looks like a secret is refused by name, whatever the list
 * says, and nothing nested is accepted.
 */
export const LogParamsSchema = z
  .record(
    z.string(),
    z.union([
      z.string().refine((value) => utf8Bytes(value) <= LIMITS.setup.detailStringMaxBytes, {
        error: 'at most 256 bytes',
      }),
      z.number(),
      z.boolean(),
    ]),
  )
  .superRefine((params, context) => {
    const names = Object.keys(params);
    if (names.length > 8) context.addIssue({ code: 'custom', message: 'at most 8 parameters' });
    for (const name of names) {
      if (isSecretLookingKey(name)) {
        context.addIssue({
          code: 'custom',
          message: 'a parameter name looks like a secret',
          path: [name],
        });
      } else if (!LOG_PARAM_NAMES.includes(name)) {
        context.addIssue({
          code: 'custom',
          message: 'a parameter name is not on the list',
          path: [name],
        });
      }
    }
  })
  .meta({ id: 'LogParams' });

export const LogLineSchema = z
  .strictObject({
    seq: z.number().int().min(1),
    ts: IsoTimestampSchema,
    step: StepKeySchema,
    level: z.enum(['info', 'warn', 'error']),
    messageKey: z.enum(LOG_KEY_LIST),
    params: LogParamsSchema,
  })
  .superRefine((line, context) => {
    if (!isLogKey(line.messageKey)) return;
    const declared: readonly string[] = LOG_KEYS[line.messageKey];
    for (const name of Object.keys(line.params)) {
      if (!declared.includes(name)) {
        context.addIssue({
          code: 'custom',
          message: 'a parameter the message key does not declare',
          path: ['params', name],
        });
      }
    }
  })
  .meta({ id: 'LogLine' });

const DIGITS = /^(?:0|[1-9][0-9]{0,15})$/;

const AfterTextSchema = z
  .string()
  .regex(DIGITS)
  .refine((text) => Number.isSafeInteger(Number(text)), { error: 'not a safe integer' });

/** `GET /api/v1/connection/log?after=&limit=` (P20). Text in, numbers through `logQueryOf`. */
export const LogQuerySchema = z
  .strictObject({
    after: AfterTextSchema.optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .refine((text) => Number(text) <= LIMITS.setup.logPageMax, {
        error: 'limit is at most 200',
      })
      .optional(),
  })
  .meta({ id: 'LogQuery' });

/** `GET /api/v1/connection/runs/current?after=` (P22). */
export const RunSnapshotQuerySchema = z
  .strictObject({ after: AfterTextSchema.optional() })
  .meta({ id: 'RunSnapshotQuery' });

/** The default `limit` of the log route (CD-10). */
export const LOG_PAGE_DEFAULT = 100;

/** `after` and `limit` of a parsed log query, with the defaults 0 and 100. */
export function logQueryOf(query: {
  readonly after?: string | undefined;
  readonly limit?: string | undefined;
}): { readonly after: number; readonly limit: number } {
  return {
    after: query.after === undefined ? 0 : Number(query.after),
    limit: query.limit === undefined ? LOG_PAGE_DEFAULT : Number(query.limit),
  };
}

const LogWindowSchema = z.strictObject({
  lines: z.array(LogLineSchema).max(LIMITS.setup.logPageMax),
  lastSeq: z.number().int().min(0),
  hasMore: z.boolean(),
  truncated: z.boolean(),
});

export const LogPageSchema = LogWindowSchema.meta({ id: 'LogPage' });

// ---------------------------------------------------------------------------------------------
// Runs (FR-B-209, FR-B-211, contract 6.1)
// ---------------------------------------------------------------------------------------------

/** The three steps a run may name (`environment` and `finish` have their own routes). */
export const RUN_STEP_KEYS = Object.freeze(['connect', 'configure', 'verify'] as const);
export const RUN_MODES = Object.freeze(['continue', 'reconcile'] as const);
export const RUN_KINDS = Object.freeze(['setup', 'repair'] as const);
export const RUN_STATUSES = Object.freeze([
  'running',
  'waiting',
  'succeeded',
  'warning',
  'failed',
  'cancelled',
] as const);

export const RunStatusSchema = z
  .strictObject({
    id: GuidSchema,
    kind: z.enum(RUN_KINDS),
    mode: z.enum(RUN_MODES),
    steps: z.array(z.enum(RUN_STEP_KEYS)).min(1).max(3),
    status: z.enum(RUN_STATUSES),
    startedAt: IsoTimestampSchema,
    finishedAt: IsoTimestampSchema.nullable(),
    cancelRequested: z.boolean(),
  })
  .meta({ id: 'RunStatus' });

export const DEVICE_CODE_STATES = Object.freeze([
  'waiting_for_user',
  'signed_in',
  'expired',
  'declined',
  'cancelled',
  'blocked',
] as const);

/**
 * The device-code panel: the user code is shown, the device code never leaves the server. The
 * `verificationUri` is present only for a link on the allow-list (FR-B-214, U43); the `message` text
 * of the Entra response has no field here.
 */
export const DeviceCodePanelSchema = z
  .strictObject({
    userCode: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    verificationUri: z
      .string()
      .refine(isAllowedVerificationUri, { error: 'a verification link outside the allow-list' })
      .nullable(),
    expiresAt: IsoTimestampSchema,
    intervalSeconds: z.number().int().min(1),
    state: z.enum(DEVICE_CODE_STATES),
  })
  .meta({ id: 'DeviceCodePanel' });

const ForeignCountSchema = z.number().int().min(0);

/**
 * The prompt to adopt an application that has the wizard's name but not its install tag (EB-06,
 * FR-B-318). `requiresAcknowledgement` is true exactly when any foreign count is above zero; a
 * password credential never reaches the prompt (the step ends `application_untrusted`).
 */
export const AdoptionPromptSchema = z
  .strictObject({
    kind: z.literal('application'),
    candidate: z.strictObject({
      objectId: GuidSchema,
      appId: GuidSchema,
      displayName: ShortTextSchema,
      foreign: z.strictObject({
        keyCredentials: ForeignCountSchema,
        owners: ForeignCountSchema,
        servicePrincipalKeyCredentials: ForeignCountSchema,
        servicePrincipalOwners: ForeignCountSchema,
      }),
    }),
    requiresAcknowledgement: z.boolean(),
  })
  .refine(
    (prompt) =>
      prompt.requiresAcknowledgement ===
      Object.values(prompt.candidate.foreign).some((count) => count > 0),
    { error: 'requiresAcknowledgement is true exactly when a foreign count is above 0' },
  )
  .meta({ id: 'AdoptionPrompt' });

/**
 * What `GET /api/v1/connection/runs/current` returns: the one polled channel (SB-19). The five
 * steps are always present, in registry order. No secret and no device code.
 */
export const RunSnapshotSchema = z
  .strictObject({
    serverTime: IsoTimestampSchema,
    run: RunStatusSchema.nullable(),
    steps: z.array(StepStateSchema),
    deviceCode: DeviceCodePanelSchema.nullable(),
    adoption: AdoptionPromptSchema.nullable(),
    log: LogWindowSchema,
  })
  .refine((snapshot) => snapshot.steps.map((step) => step.step).join() === STEP_KEYS.join(), {
    error: 'the five steps, in registry order',
  })
  .meta({ id: 'RunSnapshot' });

// ---------------------------------------------------------------------------------------------
// Requests (P21, P25)
// ---------------------------------------------------------------------------------------------

const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const AUTHORITY_ALIASES = new Set(['common', 'consumers', 'organizations']);

/**
 * A tenant hint (FR-B-214, FR-B-317): a lower-case tenant GUID or a DNS name (dot-separated labels
 * of letters, digits and hyphens, 1 to 63 characters each, at most 253 in total), and never
 * `common`, `consumers` or `organizations`. Nothing else is ever used as a host or path text.
 */
export function isTenantHint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (GuidSchema.safeParse(value).success) return true;
  // A GUID is lower case only: the same text in upper case is refused rather than read as a name.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  if (value.length === 0 || value.length > 253) return false;
  if (AUTHORITY_ALIASES.has(value.toLowerCase())) return false;
  return value.split('.').every((label) => DNS_LABEL.test(label));
}

export const TenantHintSchema = z
  .string()
  .refine(isTenantHint, { error: 'a lower-case tenant id or a DNS name' })
  .meta({ id: 'TenantHint' });

/** The application name of a run request: what the organisation-name normaliser would store, 3 to 64 characters. */
export const ApplicationNameSchema = z
  .string()
  .refine((name) => tryNormalizeOrgName(name) === name && Array.from(name).length >= 3, {
    error: 'an application name of 3 to 64 characters in NFC',
  })
  .meta({ id: 'ApplicationName' });

const STEP_ORDER: readonly string[] = RUN_STEP_KEYS;
const EXCHANGE_ROLE_KEYS = Object.keys(EXCHANGE_ROLES) as [ExchangeRoleKey, ...ExchangeRoleKey[]];

/**
 * `POST /api/v1/connection/runs`: `steps` is a non-empty ordered subset of `connect`, `configure`,
 * `verify` without repeats, or the word `repair` (which needs `mode: reconcile`). `exchangeRole` is
 * a key of `EXCHANGE_ROLES`, never a GUID (FR-B-308, CD-14).
 */
export const StartRunRequestSchema = z
  .strictObject({
    steps: z.union([z.array(z.enum(RUN_STEP_KEYS)).min(1).max(3), z.literal('repair')]),
    mode: z.enum(RUN_MODES),
    tenantHint: TenantHintSchema.optional(),
    applicationName: ApplicationNameSchema.optional(),
    exchangeRole: z.enum(EXCHANGE_ROLE_KEYS).optional(),
  })
  .superRefine((request, context) => {
    if (request.steps === 'repair') {
      if (request.mode !== 'reconcile') {
        context.addIssue({
          code: 'custom',
          message: 'repair needs mode reconcile',
          path: ['mode'],
        });
      }
      return;
    }
    const positions = request.steps.map((step) => STEP_ORDER.indexOf(step));
    const ordered = positions.every(
      (position, index) => index === 0 || position > (positions[index - 1] ?? -1),
    );
    if (!ordered) {
      context.addIssue({
        code: 'custom',
        message: 'steps are ordered and unique',
        path: ['steps'],
      });
    }
  })
  .meta({ id: 'StartRunRequest' });

/** `POST /api/v1/connection/adopt` (P25). `confirm` must be the literal `true`. */
export const AdoptRequestSchema = z
  .strictObject({
    kind: z.literal('application'),
    objectId: GuidSchema,
    confirm: z.literal(true),
    acknowledgeForeign: z.boolean().optional(),
  })
  .meta({ id: 'AdoptRequest' });

// ---------------------------------------------------------------------------------------------
// Proof list (FR-B-309, FR-B-319)
// ---------------------------------------------------------------------------------------------

export const PROOF_KEYS = Object.freeze([
  'application',
  'service_principal',
  'certificate',
  'graph_roles',
  'exchange_roles',
  'entra_role',
  'check_v1',
  'check_v2',
  'check_v3',
  'check_v4',
  'check_v5',
  'check_v6',
] as const);

export const PROOF_STATUSES = Object.freeze(['ok', 'warning', 'failed', 'not_checked'] as const);

export const ProofItemSchema = z
  .strictObject({
    key: z.enum(PROOF_KEYS),
    status: z.enum(PROOF_STATUSES),
    at: IsoTimestampSchema.nullable(),
    params: ParamsSchema,
  })
  .meta({ id: 'ProofItem' });

/**
 * The proof list, also the validator of the stored `tenant_connection.proof`: each key at most once
 * and at most 51,200 bytes serialised. Params are names, thumbprints and counts, never free text.
 */
export const ProofSchema = z
  .strictObject({
    generatedAt: IsoTimestampSchema,
    mode: SetupModeSchema,
    items: z.array(ProofItemSchema).max(PROOF_KEYS.length),
  })
  .refine((proof) => new Set(proof.items.map((item) => item.key)).size === proof.items.length, {
    error: 'each proof item at most once',
  })
  .refine((proof) => utf8Bytes(JSON.stringify(proof)) <= LIMITS.setup.verifyResultMaxBytes, {
    error: 'the proof list is at most 51,200 bytes',
  })
  .meta({ id: 'Proof' });

// ---------------------------------------------------------------------------------------------
// GET /api/v1/connection (P19)
// ---------------------------------------------------------------------------------------------

export const CERTIFICATE_LEVELS = Object.freeze(['ok', 'warning', 'critical', 'expired'] as const);
export const SECRETS_STATUSES = Object.freeze([
  'ok',
  'app_key_missing',
  'app_key_invalid',
  'certificate_unreadable',
  'no_certificate',
] as const);

const ThumbprintSha1Schema = z.string().regex(/^[0-9a-fA-F]{40}$/);

export const ConnectionResponseSchema = z
  .strictObject({
    state: SetupStateSchema,
    mode: SetupModeSchema,
    tenant: z
      .strictObject({
        tenantId: GuidSchema,
        name: ShortTextSchema.nullable(),
        initialDomain: ShortTextSchema.nullable(),
      })
      .nullable(),
    application: z
      .strictObject({
        appId: GuidSchema,
        objectId: GuidSchema.nullable(),
        displayName: ShortTextSchema,
      })
      .nullable(),
    certificate: z
      .strictObject({
        thumbprintSha1: ThumbprintSha1Schema,
        notAfter: IsoTimestampSchema,
        daysLeft: z.number().int(),
        level: z.enum(CERTIFICATE_LEVELS),
      })
      .nullable(),
    pendingCertificate: z
      .strictObject({ thumbprintSha1: ThumbprintSha1Schema, notAfter: IsoTimestampSchema })
      .nullable(),
    exchange: z.strictObject({ enabled: z.boolean() }),
    permissionSetVersion: z.number().int().min(1),
    redirectUris: z.array(z.string().max(256)).max(8),
    secrets: z.strictObject({ status: z.enum(SECRETS_STATUSES) }),
    proof: ProofSchema.nullable(),
    verifiedAt: IsoTimestampSchema.nullable(),
    runActive: z.boolean(),
  })
  .meta({ id: 'ConnectionResponse' });
