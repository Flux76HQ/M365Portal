// The wizard result codes (tasks T-B-120, CB13, TB-13; spec 6.9.5 "Wizard result codes", contract
// 6.2, CD-05).
//
// These are the values of `setup_step.error_code`, of `SubActionState.errorCode`, of a proof item's
// `params.code` and of `errors[].code`. They are never the `code` of a problem body (CD-05): a
// problem code belongs to `problem.ts`, a result code travels in the step state. Microsoft free
// text is neither stored nor shown; the only Microsoft detail a result code may carry is an `AADSTS`
// number, as a parameter.
//
// Every code has a catalogue message `setup.result.<code>` and a remedy `setup.remedy.<code>` in
// `nl` and `en` (the fragments are S-B6's; `message-keys.test.ts` checks them against this
// registry).
//
// FROZEN at gate GB1 (TB-13).
import type { StepKey } from './steps.js';

/**
 * The status column of the spec table. For the `environment` step it is the check status of
 * FR-B-213 (`fail`, `warn`); the step status derived from it is `failed` or `warning`. For the other
 * steps it is the sub-action status the code ends in.
 */
export const RESULT_CODE_STATUSES = Object.freeze([
  'fail',
  'warn',
  'failed',
  'waiting',
  'warning',
  'skipped',
] as const);
export type ResultCodeStatus = (typeof RESULT_CODE_STATUSES)[number];

/** The status of one environment check (FR-B-213). */
export const ENVIRONMENT_CHECK_STATUSES = Object.freeze(['ok', 'warn', 'fail'] as const);
export type EnvironmentCheckStatus = (typeof ENVIRONMENT_CHECK_STATUSES)[number];

/** The six environment checks (the sub-actions of step 1). */
export const ENVIRONMENT_CHECK_KEYS = Object.freeze([
  'public_base_url',
  'data_dir',
  'app_key',
  'node_version',
  'network',
  'time_skew',
] as const);
export type EnvironmentCheckKey = (typeof ENVIRONMENT_CHECK_KEYS)[number];

/**
 * The result codes an environment check may end in (FR-B-213, spec 6.9.5). A check that is `ok`
 * has none; a `warn` check has a code whose registered status is `warn`, a `fail` check one whose
 * status is `fail`.
 */
export const ENVIRONMENT_CHECK_CODES = Object.freeze({
  public_base_url: Object.freeze(['public_base_url_invalid'] as const),
  data_dir: Object.freeze(['data_dir_not_writable'] as const),
  app_key: Object.freeze(['app_key_missing', 'app_key_invalid'] as const),
  node_version: Object.freeze(['node_version_unsupported'] as const),
  network: Object.freeze(['network_unreachable', 'network_exchange_unreachable'] as const),
  time_skew: Object.freeze(['time_skew_warning', 'time_skew_excessive'] as const),
} as const satisfies Record<EnvironmentCheckKey, readonly string[]>);

export interface ResultCodeEntry {
  readonly step: StepKey;
  readonly status: ResultCodeStatus;
}

function entry(step: StepKey, status: ResultCodeStatus): ResultCodeEntry {
  return Object.freeze({ step, status });
}

/** Spec 6.9.5, one entry per code: the step it belongs to and its status. 41 codes. */
export const SETUP_RESULT_CODES = Object.freeze({
  // environment (FR-B-213)
  public_base_url_invalid: entry('environment', 'fail'),
  data_dir_not_writable: entry('environment', 'fail'),
  app_key_missing: entry('environment', 'fail'),
  app_key_invalid: entry('environment', 'fail'),
  network_unreachable: entry('environment', 'fail'),
  network_exchange_unreachable: entry('environment', 'warn'),
  node_version_unsupported: entry('environment', 'warn'),
  time_skew_warning: entry('environment', 'warn'),
  time_skew_excessive: entry('environment', 'fail'),
  // connect (EB-03 to EB-05, FR-B-216, FR-B-217)
  device_code_expired: entry('connect', 'failed'),
  device_code_declined: entry('connect', 'failed'),
  device_code_cancelled: entry('connect', 'failed'),
  device_code_blocked: entry('connect', 'failed'),
  consent_required: entry('connect', 'failed'),
  admin_approval_required: entry('connect', 'failed'),
  assignment_required: entry('connect', 'failed'),
  bootstrap_role_insufficient: entry('connect', 'failed'),
  tenant_mismatch: entry('connect', 'failed'),
  bootstrap_failed: entry('connect', 'failed'),
  // configure (FR-B-302 to FR-B-308, FR-B-318, EB-08, EB-10)
  app_role_missing: entry('configure', 'failed'),
  application_ambiguous: entry('configure', 'failed'),
  application_adoption_required: entry('configure', 'waiting'),
  application_untrusted: entry('configure', 'failed'),
  policy_refused: entry('configure', 'failed'),
  thumbprint_mismatch: entry('configure', 'failed'),
  forbidden_permission_present: entry('configure', 'failed'),
  replication_timeout: entry('configure', 'failed'),
  graph_error: entry('configure', 'failed'),
  exchange_service_principal_missing: entry('configure', 'skipped'),
  // verify (FR-B-309, FR-B-319, EB-09)
  token_unavailable: entry('verify', 'failed'),
  organization_mismatch: entry('verify', 'failed'),
  users_unreadable: entry('verify', 'failed'),
  drift_detected: entry('verify', 'failed'),
  exchange_not_ready: entry('verify', 'warning'),
  exchange_unavailable: entry('verify', 'warning'),
  optional_claim_missing: entry('verify', 'warning'),
  foreign_credential_present: entry('verify', 'warning'),
  not_checked: entry('verify', 'skipped'),
  // finish (FR-B-219)
  owner_missing: entry('finish', 'failed'),
  group_unknown: entry('finish', 'failed'),
  owner_changed: entry('finish', 'failed'),
} as const);

export type ResultCode = keyof typeof SETUP_RESULT_CODES;

/** Every result code, in registry order, as a tuple for `z.enum`. */
export const RESULT_CODES = Object.freeze(Object.keys(SETUP_RESULT_CODES)) as unknown as readonly [
  ResultCode,
  ...ResultCode[],
];

export function isResultCode(value: unknown): value is ResultCode {
  return typeof value === 'string' && Object.hasOwn(SETUP_RESULT_CODES, value);
}

/** The result codes of one step, in registry order. */
export function resultCodesOf(step: StepKey): readonly ResultCode[] {
  return RESULT_CODES.filter((code) => SETUP_RESULT_CODES[code].step === step);
}

/** Catalogue key of the message of a result code. */
export function resultMessageKey(code: ResultCode): string {
  return `setup.result.${code}`;
}

/** Catalogue key of the remedy of a result code. */
export function resultRemedyKey(code: ResultCode): string {
  return `setup.remedy.${code}`;
}
